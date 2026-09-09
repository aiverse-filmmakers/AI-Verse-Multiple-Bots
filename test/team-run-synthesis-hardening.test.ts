import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { BotRunner } from "../src/runner.js";
import { RuntimeRegistry, type RuntimeAdapter, type RuntimeExecutionContext, type RuntimeExecutionResult } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import { ExecutionSupervisor } from "../src/supervisor.js";
import { TeamRunManager } from "../src/team-run-manager.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest, StoredObject } from "../src/types.js";

const LEADER = "bot_synthesis_hardening";
const WORKSPACE = "ws_synthesis_hardening";

class HardeningRuntime implements RuntimeAdapter {
  readonly id = "synthesis-hardening-runtime";
  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    const contract = (context.task.payload.expected_output as any)?.contract;
    if (contract === "synthesis-final-v1") {
      const refs = context.inputArtifacts.map((artifact) => artifact.id);
      return {
        summary: "final",
        artifactKind: "raw_synthesis_result",
        output: { contract: "synthesis-final-v1", result: { ok: true }, used_source_artifact_refs: refs, unresolved_items: [], confidence: 1 },
        usage: { actions: 1, input_tokens: 1, output_tokens: 1, cost: 0 }
      };
    }
    return {
      summary: "candidate",
      artifactKind: "candidate",
      output: { claims: [{ subject: "hardening", kind: "fact", value: true }] },
      usage: { actions: 1, input_tokens: 1, output_tokens: 1, cost: 0 }
    };
  }
}

function manifest(): BotManifest {
  return {
    schema_version: "1.0",
    id: LEADER,
    name: "Synthesis Hardening Lead",
    kind: "durable",
    status: "active",
    role: { title: "Lead", mission: "Finalize safely." },
    runtime: { adapter: "synthesis-hardening-runtime" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: WORKSPACE },
    permissions: { policy_ref: "strict", can_create_workers: true, allowed_tools: [], allowed_connections: [] },
    coordination: { default_mode: "manager", max_parallel_workers: 4, max_hops: 6 }
  };
}

function fixture() {
  const store = new CoordinationStore(`/tmp/aiverse-synthesis-hardening-${randomUUID()}.db`);
  const queue = new ExecutionQueue(store.dbPath);
  const gateway = new CoordinationGateway(store, queue);
  gateway.createBot(manifest());
  const teams = new TeamRunCoordinator(store);
  const runtime = new HardeningRuntime();
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(runtime), `runner_${randomUUID()}`, 2, 50);
  const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0);
  const manager = new TeamRunManager(teams, gateway, queue, runner);
  return { store, queue, gateway, teams, runner, supervisor, manager, synthesis: supervisor.synthesis };
}

function runningRun(env: ReturnType<typeof fixture>): StoredObject {
  let run = env.teams.createRun({
    leaderId: LEADER,
    workspaceId: WORKSPACE,
    rootObjectiveId: `obj_${randomUUID()}`,
    objective: "Finalize scoped evidence safely.",
    topology: "dynamic_squad",
    budget: { max_workers: 4, max_tasks: 12, max_actions: 30, token_limit: 2000 }
  }).run;
  run = env.teams.transitionRun(run.id, "planning", LEADER).run;
  return env.teams.transitionRun(run.id, "running", LEADER).run;
}

function candidate(env: ReturnType<typeof fixture>, run: StoredObject): StoredObject {
  return env.gateway.record("artifact", {
    schema_version: "1.0",
    id: `art_${randomUUID()}`,
    type: "artifact",
    workspace_id: WORKSPACE,
    created_by: `worker_${randomUUID()}`,
    run_id: run.id,
    task_id: null,
    kind: "candidate",
    version: 1,
    content_ref: null,
    inline_content: { claims: [{ subject: "hardening", kind: "fact", value: true }] },
    provenance: { origin: "worker_generated", trusted_instruction: false, source_refs: [] }
  });
}

async function close(env: ReturnType<typeof fixture>) {
  await env.supervisor.stop();
  env.queue.close();
  env.store.close();
}

test("default synthesis source collection includes completed Team Run Task output", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    const managed = env.manager.createWorkerTask({ runId: run.id, createdBy: LEADER, roleTitle: "Researcher", objective: "Produce source", reason: "Need evidence", recoveryPolicy: "retry_safe" });
    const result = await env.runner.runNext(managed.worker.id);
    assert.equal(result?.status, "completed");
    const sourceRef = (env.store.getObject(managed.task.id)?.payload.output_artifact_refs as string[])[0]!;
    const scheduled = env.synthesis.schedule({ runId: run.id, createdBy: LEADER });
    assert.equal(scheduled.status, "scheduled");
    if (scheduled.status !== "scheduled") return;
    assert.ok(scheduled.sourceArtifactRefs.includes(sourceRef));
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    assert.equal(env.teams.getRun(run.id)?.payload.status, "completed");
    assert.ok(env.synthesis.finalArtifact(run.id));
  } finally {
    await close(env);
  }
});

test("source-count limit fails before synthesis lifecycle mutation", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    const first = candidate(env, run);
    const second = candidate(env, run);
    assert.throws(
      () => env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [first.id, second.id], maxSourceArtifacts: 1 }),
      /maximum is 1/
    );
    const latest = env.teams.getRun(run.id)!;
    assert.equal(latest.payload.status, "running");
    assert.equal(latest.payload.active_synthesis_task_id ?? null, null);
  } finally {
    await close(env);
  }
});

test("poisoned final Artifact pointer fails closed instead of silently re-synthesizing", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    const source = candidate(env, run);
    env.store.putObject("team_run", { ...run.payload, final_artifact_ref: source.id, updated_at: new Date().toISOString() });
    assert.throws(() => env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [source.id] }), /invalid final Artifact pointer/);
    assert.equal(env.store.listObjects("task", WORKSPACE).filter((task) => task.payload.synthesis_contract === "synthesis-final-v1" && task.payload.run_id === run.id).length, 0);
  } finally {
    await close(env);
  }
});

test("late Worker creation blocks canonical finalization until that work is closed", async () => {
  const env = fixture();
  try {
    const run = runningRun(env);
    const source = candidate(env, run);
    const scheduled = env.synthesis.schedule({ runId: run.id, createdBy: LEADER, sourceArtifactRefs: [source.id] });
    if (scheduled.status !== "scheduled") throw new Error("expected synthesis Task");

    const late = env.teams.createWorker({ runId: run.id, createdBy: LEADER, roleTitle: "Late participant", objective: "Represent a concurrent coordinator race" }).worker;
    const rawResult = await env.runner.runNext(LEADER);
    assert.equal(rawResult?.status, "completed");
    assert.throws(() => env.synthesis.reconcileTask(scheduled.task.id), /Worker\(s\) remain active/);
    assert.equal(env.synthesis.finalArtifact(run.id), null);

    env.teams.transitionWorker(late.id, "canceled", LEADER, "Late work closed before finalization");
    const settled = env.synthesis.reconcileTask(scheduled.task.id)!;
    assert.equal(settled.outcome, "completed");
    assert.ok(settled.artifact);
    assert.equal(env.teams.getRun(run.id)?.payload.status, "completed");
    assert.equal(env.synthesis.list(run.id).length, 1);
  } finally {
    await close(env);
  }
});