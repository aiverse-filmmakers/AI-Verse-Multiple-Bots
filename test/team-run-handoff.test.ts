import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry, type RuntimeAdapter, type RuntimeExecutionContext, type RuntimeExecutionResult } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import { ExecutionSupervisor } from "../src/supervisor.js";
import { TeamRunHandoff } from "../src/team-run-handoff.js";
import { TeamRunManager } from "../src/team-run-manager.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, adapter: string): BotManifest {
  return {
    schema_version: "1.0", id, name: id, kind: "durable", status: "active",
    role: { title: id, mission: `Bounded role for ${id}` }, runtime: { adapter },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_direct_handoff" },
    permissions: { policy_ref: "strict", allowed_peers: ["*"], allowed_tools: ["safe.tool"], allowed_connections: [], can_create_workers: true, can_handoff: true },
    coordination: { default_mode: "direct", max_parallel_workers: 4, max_hops: 6 }
  };
}

function fixture(runtime: RuntimeAdapter = new DeterministicRuntimeAdapter(), dbPath = `/tmp/aiverse-direct-${randomUUID()}.db`, createBots = true) {
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const gateway = new CoordinationGateway(store, queue, new CoordinationPolicy(store, { requireRegisteredBots: true }));
  if (createBots) {
    gateway.createBot(bot("bot_leader", runtime.id));
    gateway.createBot(bot("bot_specialist", runtime.id));
  }
  const teams = new TeamRunCoordinator(store);
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(runtime), `runner_${randomUUID()}`, 2, 100);
  const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0);
  const manager = new TeamRunManager(teams, gateway, queue, runner);
  const handoffs = new TeamRunHandoff(teams, gateway, queue, runner);
  return { store, queue, gateway, teams, runner, supervisor, manager, handoffs };
}

function run(env: ReturnType<typeof fixture>, budget: Record<string, number> = { max_workers: 4, max_hops: 6, max_actions: 10 }) {
  return env.teams.createRun({ leaderId: "bot_leader", workspaceId: "ws_direct_handoff", rootObjectiveId: `obj_${randomUUID()}`, objective: "Bounded direct handoff", topology: "handoff", budget }).run;
}

function source(env: ReturnType<typeof fixture>, runId: string, id: string) {
  return env.manager.createWorkerTask({ runId, createdBy: "bot_leader", workerId: id, roleTitle: "Source", objective: "Prepare and transfer bounded work.", reason: "Source stage", tools: ["safe.tool"], recoveryPolicy: "retry_safe", maxAttempts: 2 });
}

function target(env: ReturnType<typeof fixture>, runId: string, id: string) {
  return env.teams.createWorker({ runId, createdBy: "bot_leader", workerId: id, roleTitle: "Target", objective: "Finish transferred work." }).worker;
}

async function close(env: ReturnType<typeof fixture>): Promise<void> {
  await env.supervisor.stop();
  env.queue.close();
  env.store.close();
}

test("Worker -> Worker moves queued ownership, preserves temporary identity, executes and settles", async () => {
  const env = fixture();
  try {
    const r = run(env); const a = source(env, r.id, "worker_handoff_a"); const b = target(env, r.id, "worker_handoff_b");
    const h = env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: b.id, taskId: a.task.id, reason: "Specialist transfer", requiredConstraints: ["Preserve evidence"] });
    const accepted = env.handoffs.accept(h.handoff.id, b.id);
    assert.equal(accepted.task.payload.owner_id, b.id);
    assert.equal(env.queue.getByItem(a.task.id)?.targetId, b.id);
    assert.equal(accepted.sourcePrincipal.payload.status, "canceled");
    assert.equal(accepted.targetPrincipal.payload.status, "ready");
    assert.equal(env.gateway.getBot(b.id), null);
    assert.notEqual(accepted.task.payload.lease_id, a.task.payload.lease_id);
    env.supervisor.start(); await env.supervisor.waitForIdle();
    const task = env.store.getObject(a.task.id); const artifact = env.store.listObjects("artifact", "ws_direct_handoff")[0];
    const settledHandoff = env.store.getObject(h.handoff.id);
    assert.equal(task?.payload.status, "completed");
    assert.equal(task?.payload.assignee_id, b.id);
    assert.equal(task?.payload.owner_id, "bot_leader");
    assert.equal(settledHandoff?.payload.status, "completed");
    assert.equal(settledHandoff?.payload.team_run_return_policy, "return_to_leader");
    assert.equal(settledHandoff?.payload.return_owner_id, "bot_leader");
    assert.equal(settledHandoff?.payload.ownership_returned, true);
    assert.equal(env.store.getObject(a.worker.id)?.payload.status, "canceled");
    assert.equal(env.store.getObject(b.id)?.payload.status, "completed");
    assert.equal(artifact?.payload.created_by, b.id);
    assert.equal((artifact?.payload.provenance as any)?.origin, "worker_generated");
  } finally { await close(env); }
});

test("Worker -> durable Bot keeps Bot durable, enforces TeamRun scope and persists usage", async () => {
  const env = fixture();
  try {
    const r = run(env); const a = source(env, r.id, "worker_to_bot");
    const h = env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: "bot_specialist", taskId: a.task.id, reason: "Durable specialist final stage", returnPolicy: "stay_with_target" });
    env.handoffs.accept(h.handoff.id, "bot_specialist");
    assert.ok((env.teams.getRun(r.id)?.payload.participant_ids as string[]).includes("bot_specialist"));
    assert.equal(env.gateway.getBot("bot_specialist")?.payload.kind, "durable");
    env.supervisor.start(); await env.supervisor.waitForIdle();
    const task = env.store.getObject(a.task.id); const artifact = env.store.listObjects("artifact", "ws_direct_handoff")[0];
    assert.equal(task?.payload.status, "completed");
    assert.equal(task?.payload.owner_id, "bot_specialist");
    assert.equal((env.teams.getRun(r.id)?.payload.usage as any)?.actions, 1);
    assert.equal(artifact?.payload.created_by, "bot_specialist");
    assert.equal((artifact?.payload.provenance as any)?.origin, "bot_generated");
    assert.equal(env.store.getObject(h.handoff.id)?.payload.status, "completed");
  } finally { await close(env); }
});

class OneActionRuntime implements RuntimeAdapter {
  readonly id = "handoff-one-action";
  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    return { summary: `Executed ${context.task.id}`, artifactKind: "budget_probe", output: { by: context.principal.id }, usage: { actions: 1 } };
  }
}

test("run-scoped durable Bot cannot bypass aggregate TeamRun budget", async () => {
  const env = fixture(new OneActionRuntime());
  try {
    const r = run(env, { max_workers: 2, max_hops: 6, max_actions: 0 }); const a = source(env, r.id, "worker_budget_handoff");
    const h = env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: "bot_specialist", taskId: a.task.id, reason: "Budget probe", returnPolicy: "stay_with_target" });
    env.handoffs.accept(h.handoff.id, "bot_specialist");
    env.supervisor.start(); await env.supervisor.waitForIdle();
    const task = env.store.getObject(a.task.id);
    assert.equal(task?.payload.status, "failed");
    assert.match(String(task?.payload.failure_code), /^TEAM_RUN_/);
    assert.equal(env.teams.getRun(r.id)?.payload.status, "budget_exhausted");
    assert.equal(env.store.listObjects("artifact", "ws_direct_handoff").length, 0);
  } finally { await close(env); }
});

test("claimed execution fails closed without changing Worker, queue or lease ownership", async () => {
  const env = fixture();
  try {
    const r = run(env); const a = source(env, r.id, "worker_claim_a"); const b = target(env, r.id, "worker_claim_b");
    const h = env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: b.id, taskId: a.task.id, reason: "Claim race" });
    const oldLease = String(a.task.payload.lease_id); env.queue.claimNext(a.worker.id, "runner_claimed");
    assert.throws(() => env.handoffs.accept(h.handoff.id, b.id), /execution is claimed/);
    assert.equal(env.store.getObject(h.handoff.id)?.payload.status, "requested");
    assert.equal(env.store.getObject(a.worker.id)?.payload.status, "ready");
    assert.equal(env.store.getObject(b.id)?.payload.status, "created");
    assert.equal(env.store.getObject(a.task.id)?.payload.lease_id, oldLease);
    assert.equal(env.queue.getByItem(a.task.id)?.targetId, a.worker.id);
  } finally { await close(env); }
});

test("target Worker must stay inside the same TeamRun", async () => {
  const env = fixture();
  try {
    const r1 = run(env); const a = source(env, r1.id, "worker_cross_a"); const r2 = run(env); const b = target(env, r2.id, "worker_cross_b");
    assert.throws(() => env.handoffs.request({ runId: r1.id, sourceOwnerId: a.worker.id, targetOwnerId: b.id, taskId: a.task.id, reason: "Cross-run attempt" }), /belongs to another Team Run/);
  } finally { await close(env); }
});

test("handoff enforces combined hop ceiling and recorded ownership-loop history", async () => {
  const env = fixture();
  try {
    const r = run(env, { max_workers: 3, max_hops: 2, max_actions: 10 }); const a = source(env, r.id, "worker_hop_a"); const b = target(env, r.id, "worker_hop_b");
    const first = env.store.getObject(a.task.id); if (!first) throw new Error("Task missing");
    env.store.putObject("task", { ...first.payload, hop: 2, max_hops: 2 });
    assert.throws(() => env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: b.id, taskId: a.task.id, reason: "Hop overflow" }), /exceeds Task\/Run max_hops/);
    const second = env.store.getObject(a.task.id); if (!second) throw new Error("Task missing");
    env.store.putObject("task", { ...second.payload, hop: 0, max_hops: 2, handoff_owner_history: [a.worker.id, b.id] });
    assert.throws(() => env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: b.id, taskId: a.task.id, reason: "Loop attempt" }), /loop detected/);
  } finally { await close(env); }
});

test("canceling a handoff TeamRun cancels durable-Bot-owned queued work and settles Handoff", async () => {
  const env = fixture();
  try {
    const r = run(env); const a = source(env, r.id, "worker_cancel_handoff");
    const h = env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: "bot_specialist", taskId: a.task.id, reason: "Transfer before cancel", returnPolicy: "stay_with_target" });
    env.handoffs.accept(h.handoff.id, "bot_specialist");
    await env.handoffs.cancelRun(r.id, "bot_leader", "Stop run");
    assert.equal(env.teams.getRun(r.id)?.payload.status, "canceled");
    assert.equal(env.store.getObject(a.task.id)?.payload.status, "canceled");
    assert.equal(env.queue.getByItem(a.task.id)?.state, "canceled");
    assert.equal(env.store.getObject(h.handoff.id)?.payload.status, "canceled");
    assert.equal(env.store.listObjects("artifact", "ws_direct_handoff").length, 0);
  } finally { await close(env); }
});

test("accepted Worker handoff survives reopen, executes under target Worker and settles", async () => {
  const dbPath = `/tmp/aiverse-direct-restart-${randomUUID()}.db`; let taskId = ""; let handoffId = ""; let targetId = "";
  {
    const env = fixture(new DeterministicRuntimeAdapter(), dbPath, true); const r = run(env); const a = source(env, r.id, "worker_restart_a"); const b = target(env, r.id, "worker_restart_b");
    const h = env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: b.id, taskId: a.task.id, reason: "Persist transfer" });
    env.handoffs.accept(h.handoff.id, b.id); taskId = a.task.id; handoffId = h.handoff.id; targetId = b.id;
    env.queue.close(); env.store.close();
  }
  {
    const env = fixture(new DeterministicRuntimeAdapter(), dbPath, false); env.supervisor.start();
    try {
      await env.supervisor.waitForIdle(); const artifact = env.store.listObjects("artifact", "ws_direct_handoff")[0];
      const settledHandoff = env.store.getObject(handoffId);
      assert.equal(env.store.getObject(taskId)?.payload.status, "completed");
      assert.equal(env.store.getObject(taskId)?.payload.assignee_id, targetId);
      assert.equal(env.store.getObject(taskId)?.payload.owner_id, "bot_leader");
      assert.equal(settledHandoff?.payload.status, "completed");
      assert.equal(settledHandoff?.payload.team_run_return_policy, "return_to_leader");
      assert.equal(settledHandoff?.payload.ownership_returned, true);
      assert.equal(env.store.getObject(targetId)?.payload.status, "completed");
      assert.equal(artifact?.payload.created_by, targetId);
      assert.equal(env.queue.getByItem(taskId)?.state, "completed");
    } finally { await close(env); }
  }
});