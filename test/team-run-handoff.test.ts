import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CoordinationPolicy } from "../src/policy.js";
import { CoordinationStore } from "../src/store.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "../src/runtime.js";
import { ExecutionSupervisor } from "../src/supervisor.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import { TeamRunHandoff } from "../src/team-run-handoff.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string): BotManifest {
  return {
    schema_version: "1.0", id, name: id, kind: "durable", status: "active",
    role: { title: id, mission: `Mission for ${id}` },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_direct" },
    permissions: { policy_ref: "strict", allowed_peers: ["*"], allowed_tools: ["safe.tool"], allowed_connections: [], can_create_workers: true, can_handoff: true },
    coordination: { default_mode: "direct", max_parallel_workers: 4, max_hops: 6 }
  };
}

function fixture(dbPath = `/tmp/aiverse-task14-${randomUUID()}.db`, createBots = true) {
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  if (createBots) { gateway.createBot(bot("bot_leader")); gateway.createBot(bot("bot_specialist")); }
  const teams = new TeamRunCoordinator(store, gateway, policy);
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(new DeterministicRuntimeAdapter()), `runner_${randomUUID()}`, 2, 100);
  const handoffs = new TeamRunHandoff(teams, gateway, queue, runner);
  const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0, undefined, undefined, handoffs);
  return { store, queue, policy, gateway, teams, runner, handoffs, supervisor, dbPath };
}

function run(env: ReturnType<typeof fixture>, maxHops = 6) {
  const created = env.teams.createRun({ createdBy: "bot_leader", leaderId: "bot_leader", workspaceId: "ws_direct", rootObjectiveId: `obj_${randomUUID()}`, topology: "handoff", budget: { max_workers: 4, max_hops: maxHops, max_actions: 10 } }).run;
  env.teams.transitionRun(created.id, "planning", "bot_leader");
  return env.teams.transitionRun(created.id, "running", "bot_leader").object;
}

function spawn(env: ReturnType<typeof fixture>, runId: string, title: string) {
  return env.teams.spawnWorker({ runId, createdBy: "bot_leader", role: { title, objective: `${title} bounded objective` }, tools: ["safe.tool"], environmentPolicy: "shared_workspace" });
}

function source(env: ReturnType<typeof fixture>, runId: string) {
  const created = spawn(env, runId, "Source");
  const scheduled = env.handoffs.scheduleInitialWorker({ runId, workerId: created.worker.id, actorId: "bot_leader", recoveryPolicy: "retry_safe", maxAttempts: 2 });
  return { ...created, worker: scheduled.worker, task: scheduled.task };
}

async function close(env: ReturnType<typeof fixture>) {
  await env.supervisor.stop(); env.queue.close(); env.store.close();
}

test("Worker -> Worker handoff retires placeholder authority, retargets one canonical Task, executes and returns final ownership to leader", async () => {
  const env = fixture();
  try {
    const r = run(env); const a = source(env, r.id); const b = spawn(env, r.id, "Target");
    const placeholderTaskId = b.task.id; const placeholderLeaseId = b.capabilityLease.id; const oldSourceLease = String(a.task.payload.lease_id);
    const requested = env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: b.worker.id, taskId: a.task.id, reason: "Move specialist ownership", requiredConstraints: ["Preserve evidence"] });
    const accepted = env.handoffs.accept(requested.handoff.id, b.worker.id);
    assert.equal(accepted.task.payload.owner_id, b.worker.id);
    assert.equal(accepted.task.payload.root_owner_id, "bot_leader");
    assert.equal(env.queue.getByItem(a.task.id)?.targetId, b.worker.id);
    assert.equal(env.store.getObject(a.worker.id)?.payload.status, "canceled");
    assert.equal(env.store.getObject(b.worker.id)?.payload.task_id, a.task.id);
    assert.equal(env.store.getObject(placeholderTaskId)?.payload.status, "canceled");
    assert.equal(env.store.getObject(placeholderLeaseId)?.payload.superseded_by, accepted.task.payload.lease_id);
    assert.notEqual(accepted.task.payload.lease_id, oldSourceLease);
    assert.equal(env.gateway.getBot(b.worker.id), null);

    env.supervisor.start(); await env.supervisor.waitForIdle();
    const task = env.store.getObject(a.task.id); const handoff = env.store.getObject(requested.handoff.id);
    assert.equal(task?.payload.status, "completed");
    assert.equal(task?.payload.assignee_id, b.worker.id);
    assert.equal(task?.payload.owner_id, "bot_leader");
    assert.equal(handoff?.payload.status, "completed");
    assert.equal(handoff?.payload.team_run_return_policy, "return_to_leader");
    assert.equal(handoff?.payload.ownership_returned, true);
    assert.equal(env.store.getObject(b.worker.id)?.payload.status, "completed");
    const artifact = env.store.listObjects("artifact", "ws_direct").find((item) => item.payload.task_id === a.task.id);
    assert.equal(artifact?.payload.created_by, b.worker.id);
    assert.equal((artifact?.payload.provenance as any)?.origin, "worker_generated");
  } finally { await close(env); }
});

test("Worker -> durable Bot adds explicit Team Run participant and stay_with_target preserves durable target ownership", async () => {
  const env = fixture();
  try {
    const r = run(env); const a = source(env, r.id);
    const h = env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: "bot_specialist", taskId: a.task.id, reason: "Durable specialist", returnPolicy: "stay_with_target" });
    env.handoffs.accept(h.handoff.id, "bot_specialist");
    assert.ok((env.teams.getRun(r.id)?.payload.participant_ids as string[]).includes("bot_specialist"));
    env.supervisor.start(); await env.supervisor.waitForIdle();
    const task = env.store.getObject(a.task.id); const artifact = env.store.listObjects("artifact", "ws_direct").find((item) => item.payload.task_id === a.task.id);
    assert.equal(task?.payload.status, "completed");
    assert.equal(task?.payload.owner_id, "bot_specialist");
    assert.equal(task?.payload.root_owner_id, "bot_leader");
    assert.equal(artifact?.payload.created_by, "bot_specialist");
    assert.equal((artifact?.payload.provenance as any)?.origin, "bot_generated");
    assert.equal((env.teams.getRun(r.id)?.payload.usage as any)?.actions, 1);
  } finally { await close(env); }
});

test("claimed execution fails closed without changing Task, Worker, queue or lease ownership", async () => {
  const env = fixture();
  try {
    const r = run(env); const a = source(env, r.id); const b = spawn(env, r.id, "Target");
    const h = env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: b.worker.id, taskId: a.task.id, reason: "Claim race" });
    const oldLease = String(a.task.payload.lease_id); env.queue.claimNext(a.worker.id, "runner_claimed");
    assert.throws(() => env.handoffs.accept(h.handoff.id, b.worker.id), /execution is claimed/);
    assert.equal(env.store.getObject(h.handoff.id)?.payload.status, "requested");
    assert.equal(env.store.getObject(a.worker.id)?.payload.status, "ready");
    assert.equal(env.store.getObject(b.worker.id)?.payload.status, "created");
    assert.equal(env.store.getObject(a.task.id)?.payload.lease_id, oldLease);
    assert.equal(env.queue.getByItem(a.task.id)?.targetId, a.worker.id);
  } finally { await close(env); }
});

test("target Worker cannot cross Team Run boundary", async () => {
  const env = fixture();
  try {
    const r1 = run(env); const a = source(env, r1.id); const r2 = run(env); const b = spawn(env, r2.id, "Other Run");
    assert.throws(() => env.handoffs.request({ runId: r1.id, sourceOwnerId: a.worker.id, targetOwnerId: b.worker.id, taskId: a.task.id, reason: "Cross-run attempt" }), /belongs to another Team Run/);
  } finally { await close(env); }
});

test("handoff preserves selected Artifact context and immutable constraints on the transferred Task", async () => {
  const env = fixture();
  try {
    const r = run(env); const a = source(env, r.id); const b = spawn(env, r.id, "Target");
    const artifact = env.store.putObject("artifact", { schema_version: "1.0", id: `art_${randomUUID().replace(/-/g, "")}`, type: "artifact", workspace_id: "ws_direct", created_by: "bot_leader", task_id: a.task.id, kind: "evidence", version: 1, inline_content: { note: "carry me" }, provenance: { origin: "operator_input", trusted_instruction: true } });
    const h = env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: b.worker.id, taskId: a.task.id, reason: "Context transfer", requiredConstraints: ["Do not publish"], artifactRefs: [artifact.id] });
    const accepted = env.handoffs.accept(h.handoff.id, b.worker.id);
    assert.ok((accepted.task.payload.required_constraints as string[]).includes("Do not publish"));
    assert.ok((accepted.task.payload.input_artifact_refs as string[]).includes(artifact.id));
    assert.equal(accepted.task.payload.constraints_digest, env.store.getObject(h.handoff.id)?.payload.constraints_digest);
  } finally { await close(env); }
});

test("handoff enforces combined hop ceiling and ownership-loop history", async () => {
  const env = fixture();
  try {
    const r = run(env, 2); const a = source(env, r.id); const b = spawn(env, r.id, "Target");
    const task = env.store.getObject(a.task.id); if (!task) throw new Error("Task missing");
    env.store.putObject("task", { ...task.payload, hop: 2, max_hops: 2 });
    assert.throws(() => env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: b.worker.id, taskId: a.task.id, reason: "Hop overflow" }), /exceeds Task\/Run max_hops/);
    const current = env.store.getObject(a.task.id); if (!current) throw new Error("Task missing");
    env.store.putObject("task", { ...current.payload, hop: 0, max_hops: 2, handoff_owner_history: [a.worker.id, b.worker.id] });
    assert.throws(() => env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: b.worker.id, taskId: a.task.id, reason: "Loop" }), /loop detected/);
  } finally { await close(env); }
});

test("canceling direct-handoff Team Run cancels durable-Bot-owned queued work and settles Handoff", async () => {
  const env = fixture();
  try {
    const r = run(env); const a = source(env, r.id);
    const h = env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: "bot_specialist", taskId: a.task.id, reason: "Transfer before cancel", returnPolicy: "stay_with_target" });
    env.handoffs.accept(h.handoff.id, "bot_specialist");
    await env.handoffs.cancelRun(r.id, "bot_leader", "Stop run");
    assert.equal(env.teams.getRun(r.id)?.payload.status, "canceled");
    assert.equal(env.store.getObject(a.task.id)?.payload.status, "canceled");
    assert.equal(env.queue.getByItem(a.task.id)?.state, "canceled");
    assert.equal(env.store.getObject(h.handoff.id)?.payload.status, "canceled");
    assert.equal(env.store.listObjects("artifact", "ws_direct").length, 0);
  } finally { await close(env); }
});

test("accepted Worker handoff survives database reopen, executes under target Worker and settles to durable leader", async () => {
  const dbPath = `/tmp/aiverse-task14-restart-${randomUUID()}.db`; let taskId = ""; let handoffId = ""; let targetId = "";
  {
    const env = fixture(dbPath, true); const r = run(env); const a = source(env, r.id); const b = spawn(env, r.id, "Target");
    const h = env.handoffs.request({ runId: r.id, sourceOwnerId: a.worker.id, targetOwnerId: b.worker.id, taskId: a.task.id, reason: "Persist transfer" });
    env.handoffs.accept(h.handoff.id, b.worker.id); taskId = a.task.id; handoffId = h.handoff.id; targetId = b.worker.id;
    env.queue.close(); env.store.close();
  }
  {
    const env = fixture(dbPath, false);
    try {
      env.supervisor.start(); await env.supervisor.waitForIdle();
      const task = env.store.getObject(taskId); const handoff = env.store.getObject(handoffId);
      assert.equal(task?.payload.status, "completed");
      assert.equal(task?.payload.assignee_id, targetId);
      assert.equal(task?.payload.owner_id, "bot_leader");
      assert.equal(handoff?.payload.status, "completed");
      assert.equal(handoff?.payload.ownership_returned, true);
      assert.equal(env.store.getObject(targetId)?.payload.status, "completed");
      assert.equal(env.queue.getByItem(taskId)?.state, "completed");
    } finally { await close(env); }
  }
});
