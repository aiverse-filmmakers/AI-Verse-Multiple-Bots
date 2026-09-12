import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { FourCsHealthProjector } from "../src/four-cs-health.js";
import type { WorkspaceStateProjection, WorkspaceStateProjector } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import type { JsonObject } from "../src/types.js";

const WORKSPACE = "ws-alpha";

function harness(integrations: ConstructorParameters<typeof FourCsHealthProjector>[2] = {}) {
  const dbPath = `/tmp/multiple-bots-four-cs-${randomUUID()}.db`;
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const health = new FourCsHealthProjector(store, queue, integrations);
  return { dbPath, store, queue, health };
}

function close(env: ReturnType<typeof harness>): void {
  env.queue.close();
  env.store.close();
  rmSync(env.dbPath, { force: true });
  rmSync(`${env.dbPath}-shm`, { force: true });
  rmSync(`${env.dbPath}-wal`, { force: true });
}

function recordArtifact(env: ReturnType<typeof harness>, id: string, runtimeReceipts: JsonObject[]): void {
  env.store.putObject("artifact", {
    schema_version: "1.0",
    id,
    type: "artifact",
    workspace_id: WORKSPACE,
    created_by: "bot_writer",
    kind: "test_result",
    version: 1,
    inline_content: { secret: "ARTIFACT_CONTENT_MUST_NOT_ENTER_HEALTH" },
    runtime_receipts: runtimeReceipts,
    provenance: { origin: "bot_generated", trusted_instruction: false }
  });
}

function recordTask(env: ReturnType<typeof harness>, id: string, extra: JsonObject = {}): void {
  env.store.putObject("task", {
    schema_version: "1.0",
    id,
    type: "task.delegate",
    created_by: "bot_writer",
    assignee_id: "bot_writer",
    owner_id: "bot_writer",
    workspace_id: WORKSPACE,
    root_objective_id: `root:${id}`,
    reason: "health test",
    objective: "health test objective",
    required_constraints: [],
    constraints_digest: "0".repeat(64),
    expected_output: { contract: "test" },
    input_artifact_refs: [],
    lease_id: `lease_${id}`,
    environment_lease_id: null,
    response_target: null,
    deadline_at: null,
    budget: {},
    hop: 0,
    max_hops: 6,
    status: "completed",
    ...extra
  });
}

class RecordingProjector implements WorkspaceStateProjector {
  calls: string[] = [];
  project(workspaceId: string): WorkspaceStateProjection {
    this.calls.push(workspaceId);
    return {
      schema_version: "1.0",
      provider: "test-workspace",
      workspace_id: workspaceId,
      projection_digest: "a".repeat(64),
      projected_at: "2026-09-12T18:00:00Z",
      sources: [{ ref: `workspaces/${workspaceId}/WORKSPACE.yaml`, digest: "b".repeat(64) }],
      data: { current_context: "PRIVATE_CONTEXT_MUST_NOT_ENTER_HEALTH" }
    };
  }
}

test("standalone health projection does not pretend AI-Verse 4Cs evidence exists", () => {
  const env = harness();
  try {
    const result = env.health.project();
    assert.equal(result.mode, "standalone");
    assert.equal(result.projection_only, true);
    assert.equal(result.coordination_core.status, "verified");
    assert.equal(result.four_cs.context.status, "not_applicable");
    assert.equal(result.four_cs.connections.status, "not_applicable");
    assert.equal(result.four_cs.cadence.status, "not_applicable");
    assert.equal(result.ownership.assigns_four_cs_score, false);
    assert.equal(result.ownership.writes_os_health_state, false);
  } finally {
    close(env);
  }
});

test("native workspace context is live-probed but projected content is never copied into health output", () => {
  const projector = new RecordingProjector();
  const env = harness({
    nativeMode: true,
    workspaceProjector: projector,
    brainIngressAvailable: true,
    memoryRecallAvailable: true,
    skillsResolutionAvailable: true,
    automationIngressAvailable: true
  });
  try {
    const result = env.health.project(WORKSPACE);
    assert.deepEqual(projector.calls, [WORKSPACE]);
    assert.equal(result.four_cs.context.status, "verified");
    assert.equal(JSON.stringify(result).includes("PRIVATE_CONTEXT_MUST_NOT_ENTER_HEALTH"), false);
    const contextItem = result.four_cs.context.evidence.find((item) => item.id === "workspace-context-projection");
    assert.equal(contextItem?.status, "verified");
    assert.equal((contextItem?.metrics as JsonObject).source_count, 1);
  } finally {
    close(env);
  }
});

test("failed live workspace context probe becomes degraded evidence instead of a false healthy claim", () => {
  const projector: WorkspaceStateProjector = {
    project() {
      throw new Error("canonical workspace source unavailable");
    }
  };
  const env = harness({ nativeMode: true, workspaceProjector: projector });
  try {
    const result = env.health.project(WORKSPACE);
    assert.equal(result.four_cs.context.status, "degraded");
    assert.match(String(result.four_cs.context.evidence[0]?.summary), /canonical workspace source unavailable/);
  } finally {
    close(env);
  }
});

test("runtime receipts provide evidence counts without leaking Artifact or recalled content", () => {
  const projector = new RecordingProjector();
  const env = harness({
    nativeMode: true,
    workspaceProjector: projector,
    brainIngressAvailable: true,
    memoryRecallAvailable: true,
    skillsResolutionAvailable: true
  });
  try {
    recordArtifact(env, "artifact_receipts", [
      { kind: "workspace_state_projection", provider: "os", source_text: "SHOULD_NOT_APPEAR" },
      { kind: "brain_strategic_intent", provider: "brain", objective: "SHOULD_NOT_APPEAR" },
      { kind: "historical_memory_recall", provider: "memory", recalled_text: "SHOULD_NOT_APPEAR" },
      { kind: "skills_capability_resolution", provider: "skills", instructions: "SHOULD_NOT_APPEAR" }
    ]);
    const result = env.health.project(WORKSPACE);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes("ARTIFACT_CONTENT_MUST_NOT_ENTER_HEALTH"), false);
    assert.equal(serialized.includes("SHOULD_NOT_APPEAR"), false);
    const brain = result.four_cs.context.evidence.find((item) => item.id === "brain-context-ingress");
    const memory = result.four_cs.context.evidence.find((item) => item.id === "memory-context-recall");
    const skills = result.four_cs.capabilities.evidence.find((item) => item.id === "skills-capability-resolution");
    assert.equal((brain?.metrics as JsonObject).runtime_receipt_count, 1);
    assert.equal((memory?.metrics as JsonObject).runtime_receipt_count, 1);
    assert.equal((skills?.metrics as JsonObject).runtime_receipt_count, 1);
  } finally {
    close(env);
  }
});

test("declared connection grants are explicitly not treated as live connection proof", () => {
  const env = harness({ nativeMode: true });
  try {
    env.store.putObject("capability_lease", {
      schema_version: "1.0",
      id: "lease_connections",
      type: "capability_lease",
      principal: "bot_writer",
      issued_to: "bot_writer",
      workspace_id: WORKSPACE,
      task_id: "task_connections",
      tools: [],
      connections: ["gmail", "drive"],
      destructive_actions: "deny",
      expires_at: "2030-01-01T00:00:00Z"
    });
    const result = env.health.project(WORKSPACE);
    assert.equal(result.four_cs.connections.status, "unknown");
    assert.equal(result.ownership.declared_connection_is_live_proof, false);
    const item = result.four_cs.connections.evidence[0]!;
    assert.equal(item.status, "unknown");
    assert.equal((item.metrics as JsonObject).grant_count, 2);
    assert.equal(JSON.stringify(result).includes('"gmail"'), false);
    assert.equal(JSON.stringify(result).includes('"drive"'), false);
  } finally {
    close(env);
  }
});

test("skill-dependent work without a resolver is degraded and successful resolution receipts verify capability evidence", () => {
  const env = harness({ nativeMode: true });
  try {
    recordTask(env, "task_skill", { skill_refs: ["shared-skill"] });
    let result = env.health.project(WORKSPACE);
    let item = result.four_cs.capabilities.evidence.find((entry) => entry.id === "skills-capability-resolution");
    assert.equal(item?.status, "degraded");

    recordArtifact(env, "artifact_skill", [{ kind: "skills_capability_resolution", provider: "skills" }]);
    result = env.health.project(WORKSPACE);
    item = result.four_cs.capabilities.evidence.find((entry) => entry.id === "skills-capability-resolution");
    assert.equal(item?.status, "verified");
    assert.equal(result.four_cs.capabilities.status, "verified");
  } finally {
    close(env);
  }
});

test("cadence requires real invocation evidence and does not equate configured ingress with execution", () => {
  const env = harness({ nativeMode: true, automationIngressAvailable: true });
  try {
    let result = env.health.project(WORKSPACE);
    assert.equal(result.four_cs.cadence.status, "unknown");

    recordTask(env, "task_automation", {
      automation_ingress: {
        provider: "ai-verse-os-automation-v1",
        automation_id: "daily",
        invocation_id: "inv-1"
      }
    });
    result = env.health.project(WORKSPACE);
    assert.equal(result.four_cs.cadence.status, "verified");
    const item = result.four_cs.cadence.evidence[0]!;
    assert.equal((item.metrics as JsonObject).invocation_work_count, 1);
    assert.equal((item.metrics as JsonObject).completed_invocation_work_count, 1);
  } finally {
    close(env);
  }
});

test("workspace-scoped projection excludes evidence from other workspaces", () => {
  const env = harness({ nativeMode: true, automationIngressAvailable: true });
  try {
    env.store.putObject("task", {
      schema_version: "1.0",
      id: "task_other",
      type: "task.delegate",
      created_by: "bot_other",
      assignee_id: "bot_other",
      owner_id: "bot_other",
      workspace_id: "other",
      root_objective_id: "root:other",
      reason: "other",
      objective: "other",
      required_constraints: [],
      constraints_digest: "0".repeat(64),
      expected_output: { contract: "test" },
      input_artifact_refs: [],
      lease_id: "lease_other",
      environment_lease_id: null,
      response_target: null,
      deadline_at: null,
      budget: {},
      hop: 0,
      max_hops: 6,
      status: "completed",
      automation_ingress: { provider: "os", invocation_id: "foreign" }
    });
    const result = env.health.project(WORKSPACE);
    const cadence = result.four_cs.cadence.evidence[0]!;
    assert.equal((cadence.metrics as JsonObject).invocation_work_count, 0);
  } finally {
    close(env);
  }
});
