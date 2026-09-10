import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import test from "node:test";
import { brainRootObjectiveId, type BrainObjectiveProjection, type BrainObjectiveSource } from "../src/brain-objective-ingress.js";
import { BrainObjectiveRuntimeRegistry } from "../src/brain-objective-runtime.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import { TeamRunManager } from "../src/team-run-manager.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest } from "../src/types.js";

const WORKSPACE_ID = "ws-brain-worker";
const INTENT_DIGEST = "a".repeat(64);
const ROOT_OBJECTIVE_ID = brainRootObjectiveId("objective-worker-proof", INTENT_DIGEST);

function leader(): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_brain-worker-leader",
    name: "Brain Worker Leader",
    kind: "durable",
    status: "active",
    role: { title: "Lead", mission: "Coordinate bounded work." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: WORKSPACE_ID },
    permissions: { policy_ref: "default", allowed_peers: ["*"], can_create_workers: true },
    coordination: { default_mode: "direct", can_create_workers: true }
  };
}

function projection(): BrainObjectiveProjection {
  return {
    schema_version: "1.0",
    provider: "ai-verse-brain-objective-v1",
    workspace_id: WORKSPACE_ID,
    objective_id: "objective-worker-proof",
    objective_status: "RUNNING",
    root_objective_id: ROOT_OBJECTIVE_ID,
    intent_digest: INTENT_DIGEST,
    projected_at: "2026-09-10T12:00:00Z",
    source: {
      ref: "brain:objective:objective-worker-proof",
      kind: "objective",
      object_id: "objective-worker-proof",
      revision: 2,
      source_digest: "b".repeat(64),
      status: "RUNNING"
    },
    parent_source: {
      ref: "brain:initiative:initiative-worker-proof",
      kind: "initiative",
      object_id: "initiative-worker-proof",
      revision: 1,
      source_digest: "c".repeat(64),
      status: "ACTIVE"
    },
    data: {
      objective: "Use a temporary specialist while preserving Brain strategic intent",
      criteria: [{ id: "criterion-1", statement: "Specialist output is traceable", status: "unverified" }],
      constraints: [],
      boundaries: [],
      stop_conditions: [],
      parent: { kind: "initiative", outcome: "Finish the strategic objective" }
    }
  };
}

test("temporary Team Run Worker inherits the Brain root and revalidates canonical strategic intent before execution", async () => {
  const dbPath = `/tmp/ai-verse-brain-worker-${randomUUID()}.db`;
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  gateway.createBot(leader());
  const calls: Array<{ workspaceId: string; objectiveId: string }> = [];
  const source: BrainObjectiveSource = {
    project(workspaceId, objectiveId) {
      calls.push({ workspaceId, objectiveId });
      return projection();
    }
  };
  const runner = new BotRunner(
    store,
    gateway,
    queue,
    new BrainObjectiveRuntimeRegistry(new RuntimeRegistry().register(new DeterministicRuntimeAdapter()), source),
    "runner_brain-worker-proof"
  );
  const teams = new TeamRunCoordinator(store);
  const created = teams.createRun({
    leaderId: "bot_brain-worker-leader",
    workspaceId: WORKSPACE_ID,
    rootObjectiveId: ROOT_OBJECTIVE_ID,
    objective: "Coordinate one temporary specialist",
    topology: "manager",
    budget: { max_workers: 1, max_tasks: 2, max_actions: 4 }
  });
  const manager = new TeamRunManager(teams, gateway, queue, runner);

  try {
    const managed = manager.createWorkerTask({
      runId: created.run.id,
      createdBy: "bot_brain-worker-leader",
      roleTitle: "Temporary Specialist",
      objective: "Produce the bounded specialist result",
      reason: "Brain objective needs one specialist"
    });
    assert.equal(managed.task.payload.root_objective_id, ROOT_OBJECTIVE_ID);
    assert.equal(managed.worker.kind, "worker");
    assert.equal(gateway.getBot(managed.worker.id), null, "temporary Worker must never enter the Bot registry");

    const result = await runner.runNext(managed.worker.id);
    assert.equal(result?.status, "completed");
    assert.equal(result?.artifact?.payload.run_id, created.run.id);
    assert.equal((result?.artifact?.payload.inline_content as any)?.strategic_intent_digest, INTENT_DIGEST);
    assert.deepEqual(calls, [{ workspaceId: WORKSPACE_ID, objectiveId: "objective-worker-proof" }]);
    const receipts = result?.artifact?.payload.runtime_receipts as any[];
    assert.ok(receipts.some((receipt) => receipt.kind === "brain_strategic_intent" && receipt.intent_digest === INTENT_DIGEST));
  } finally {
    queue.close();
    store.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  }
});
