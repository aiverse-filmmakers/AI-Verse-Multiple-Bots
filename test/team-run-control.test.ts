import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import { RuntimeRegistry, type RuntimeAdapter, type RuntimeExecutionContext, type RuntimeExecutionResult } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import { ExecutionSupervisor } from "../src/supervisor.js";
import { TeamRunManager } from "../src/team-run-manager.js";
import { TeamRunCoordinator, type TeamRunTopology } from "../src/team-runs.js";
import type { BotManifest, StoredObject } from "../src/types.js";
import { validateProtocolObject } from "../src/validator.js";

const WORKSPACE = "ws_phase2_control";

function bot(id: string, adapter: string): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: "Team participant", mission: "Execute bounded Team Run work." },
    runtime: { adapter },
    execution: { environment_policy: "shared_workspace", environment_ref: "host-default" },
    scope: { type: "workspace", workspace_id: WORKSPACE },
    permissions: {
      policy_ref: "default-bot",
      allowed_peers: ["*"],
      allowed_tools: ["safe.tool"],
      allowed_connections: [],
      can_create_workers: true,
      can_handoff: true
    },
    coordination: { default_mode: "direct", max_parallel_workers: 4, max_hops: 6 }
  };
}

function setup(runtime: RuntimeAdapter, dbPath = ":memory:") {
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const gateway = new CoordinationGateway(store, queue, new CoordinationPolicy(store, { requireRegisteredBots: true }));
  if (!gateway.getBot("bot_leader")) gateway.createBot(bot("bot_leader", runtime.id));
  if (!gateway.getBot("bot_peer")) gateway.createBot(bot("bot_peer", runtime.id));
  const teams = new TeamRunCoordinator(store);
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(runtime), `runner_${randomUUID()}`, 2, 50);
  const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0);
  const manager = new TeamRunManager(teams, gateway, queue, runner);
  return { store, queue, gateway, teams, runner, supervisor, manager };
}

function createRunningRun(teams: TeamRunCoordinator, budget: Record<string, number>, topology: TeamRunTopology = "hybrid") {
  let run = teams.createRun({
    leaderId: "bot_leader",
    workspaceId: WORKSPACE,
    rootObjectiveId: `obj_${randomUUID()}`,
    objective: "Exercise the final Phase 2 Team Run control boundary.",
    topology,
    budget
  }).run;
  run = teams.transitionRun(run.id, "planning", "bot_leader", "Control test planning").run;
  run = teams.transitionRun(run.id, "running", "bot_leader", "Control test running").run;
  return run;
}

function addPeerParticipant(env: ReturnType<typeof setup>, runId: string): StoredObject {
  const run = env.teams.getRun(runId)!;
  const participants = [...new Set([...(Array.isArray(run.payload.participant_ids) ? run.payload.participant_ids.map(String) : []), "bot_peer"])];
  return env.store.putObject("team_run", validateProtocolObject({ ...run.payload, participant_ids: participants, updated_at: new Date().toISOString() }, "team_run"));
}

function addDurableTask(
  env: ReturnType<typeof setup>,
  runId: string,
  options: { taskId?: string; createdBy?: string; environmentLeaseId?: string | null; enqueue?: boolean } = {}
) {
  const run = env.teams.getRun(runId)!;
  const taskId = options.taskId ?? `task_peer_${randomUUID()}`;
  const leaseId = `lease_${randomUUID()}`;
  env.store.putObject("capability_lease", validateProtocolObject({
    schema_version: "1.0",
    id: leaseId,
    type: "capability_lease",
    principal: "bot_leader",
    issued_to: "bot_peer",
    workspace_id: WORKSPACE,
    task_id: taskId,
    tools: [],
    connections: [],
    destructive_actions: "deny",
    expires_at: new Date(Date.now() + 60_000).toISOString()
  }, "capability_lease"));
  const task = env.store.putObject("task", validateProtocolObject({
    schema_version: "1.0",
    id: taskId,
    type: "task.delegate",
    created_by: options.createdBy ?? "bot_leader",
    assignee_id: "bot_peer",
    owner_id: "bot_peer",
    workspace_id: WORKSPACE,
    run_id: run.id,
    root_objective_id: String(run.payload.root_objective_id),
    parent_task_id: null,
    reason: "Durable Bot work inside one Team Run",
    objective: "Remain bounded by the Team Run lifecycle.",
    required_constraints: [],
    expected_output: { contract: "structured_result" },
    input_artifact_refs: [],
    lease_id: leaseId,
    environment_lease_id: options.environmentLeaseId ?? null,
    response_target: { kind: "bot", id: "bot_leader" },
    deadline_at: null,
    budget: run.payload.budget,
    hop: 0,
    max_hops: 6,
    recovery_policy: "retry_safe",
    max_attempts: 2,
    status: "assigned",
    created_at: new Date().toISOString()
  }, "task"));
  if (options.enqueue !== false) env.queue.enqueueTask(taskId, "bot_peer", WORKSPACE, { recoveryPolicy: "retry_safe", maxAttempts: 2 });
  return { task, leaseId };
}

function environmentLease(env: ReturnType<typeof setup>, id: string, taskId: string): StoredObject {
  return env.store.putObject("environment_lease", validateProtocolObject({
    schema_version: "1.0",
    id,
    type: "environment_lease",
    issued_to: "bot_peer",
    workspace_id: WORKSPACE,
    task_id: taskId,
    environment_policy: "isolated_run",
    environment_ref: `env_${id}`,
    expires_at: new Date(Date.now() + 60_000).toISOString()
  }, "environment_lease"));
}

class NoopRuntime implements RuntimeAdapter {
  readonly id = "phase2-control-noop";
  calls = 0;
  async execute(): Promise<RuntimeExecutionResult> {
    this.calls += 1;
    return { summary: "done", artifactKind: "control_result", output: { ok: true }, usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 1 } };
  }
}

class BlockingRuntime implements RuntimeAdapter {
  readonly id = "phase2-control-blocking";
  calls = 0;
  aborts = 0;
  private startedResolve!: () => void;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });
  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    this.calls += 1;
    this.startedResolve();
    return await new Promise<RuntimeExecutionResult>((_resolve, reject) => {
      const abort = () => {
        this.aborts += 1;
        reject(context.signal.reason instanceof Error ? context.signal.reason : new Error("aborted"));
      };
      if (context.signal.aborted) abort();
      else context.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

class OneActionRuntime implements RuntimeAdapter {
  readonly id = "phase2-control-one-action";
  calls = 0;
  async execute(): Promise<RuntimeExecutionResult> {
    this.calls += 1;
    return { summary: "one action", artifactKind: "control_result", output: { call: this.calls }, usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 1 } };
  }
}

test("canonical Team Run cancellation fences and drains mixed-principal work while preserving a stable audit summary", async () => {
  const runtime = new NoopRuntime();
  const env = setup(runtime);
  try {
    const run = createRunningRun(env.teams, { max_workers: 3, max_tasks: 6, max_actions: 10, wall_clock_seconds: 60 });
    const managed = env.manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_control",
      roleTitle: "Temporary worker",
      objective: "Remain cancelable with the entire run.",
      reason: "Phase 2.12 cancellation proof."
    });
    const durable = addDurableTask(env, run.id);

    const approvalId = `approval_${randomUUID()}`;
    env.store.putObject("approval", validateProtocolObject({
      schema_version: "1.0", id: approvalId, type: "approval", workspace_id: WORKSPACE,
      task_id: durable.task.id, actor_id: "bot_peer",
      action: { kind: "external_action", summary: "Should become non-actionable when the run stops" },
      status: "pending", created_at: new Date().toISOString()
    }, "approval"));
    const handoffId = `handoff_${randomUUID()}`;
    env.store.putObject("handoff", validateProtocolObject({
      schema_version: "1.0", id: handoffId, type: "handoff", source_owner_id: "bot_leader",
      target_bot_id: "bot_peer", target_owner_id: "bot_peer", workspace_id: WORKSPACE,
      task_id: durable.task.id, work_item_id: durable.task.id, run_id: run.id,
      root_objective_id: String(run.payload.root_objective_id), reason: "Pending ownership transfer must stop with the run",
      required_constraints: [], artifact_refs: [], return_policy: "stay_with_target", status: "requested",
      created_at: new Date().toISOString()
    }, "handoff"));
    const roomId = `room_${randomUUID()}`;
    env.store.putObject("room", validateProtocolObject({
      schema_version: "1.0", id: roomId, name: "Temporary control room", status: "active",
      scope: { type: "workspace", workspace_id: WORKSPACE }, members: ["bot_leader"],
      orchestration: { mode: "hybrid", leader: "bot_leader" }, temporary: true, run_id: run.id,
      discussion: { run_id: run.id, status: "open", current_task_id: managed.task.id }
    }, "room"));
    const threadId = `thread_${randomUUID()}`;
    env.store.putObject("thread", validateProtocolObject({
      schema_version: "1.0", id: threadId, type: "thread", workspace_id: WORKSPACE, room_id: roomId,
      parent_message_id: "msg_control_parent", created_by: "bot_leader", status: "active"
    }, "thread"));

    const result = await env.runner.teamRunControl.cancelRun(run.id, "bot_leader", "Stop every branch of this Team Run");
    assert.equal(result.run.payload.status, "canceled");
    assert.equal((result.run.payload.termination as any)?.state, "completed");
    assert.deepEqual(result.task_ids_canceled.sort(), [managed.task.id, durable.task.id].sort());
    assert.deepEqual(result.worker_ids_canceled, ["worker_control"]);
    assert.deepEqual(result.approval_ids_canceled, [approvalId]);
    assert.deepEqual(result.handoff_ids_canceled, [handoffId]);
    assert.ok(result.capability_lease_ids_revoked.includes(managed.lease.id));
    assert.ok(result.capability_lease_ids_revoked.includes(durable.leaseId));
    assert.deepEqual(result.room_ids_closed, [roomId]);
    assert.deepEqual(result.thread_ids_closed, [threadId]);
    assert.equal(env.store.getObject(managed.task.id)?.payload.status, "canceled");
    assert.equal(env.store.getObject(durable.task.id)?.payload.status, "canceled");
    assert.equal(env.queue.getByItem(managed.task.id)?.state, "canceled");
    assert.equal(env.queue.getByItem(durable.task.id)?.state, "canceled");
    assert.equal(env.store.getObject(approvalId)?.payload.status, "canceled");
    assert.equal(env.store.getObject(handoffId)?.payload.status, "canceled");
    assert.equal(env.store.getObject(roomId)?.payload.status, "closed");
    assert.equal(env.store.getObject(threadId)?.payload.status, "closed");
    assert.equal(runtime.calls, 0);

    const summaryBefore = JSON.stringify((env.teams.getRun(run.id)?.payload.termination as any)?.summary);
    const repeated = await env.runner.teamRunControl.cancelRun(run.id, "bot_leader", "Repeated cancel must be a no-op");
    assert.equal(repeated.already_terminal, true);
    assert.equal(JSON.stringify((env.teams.getRun(run.id)?.payload.termination as any)?.summary), summaryBefore);
    const events = env.store.listEventsAfter(0, 500).filter((entry) => entry.event.type === "team_run.canceled" && entry.event.run_id === run.id);
    assert.equal(events.length, 1);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("Team Run termination revokes exclusive environment authority but preserves an environment shared outside the run", async () => {
  const env = setup(new NoopRuntime());
  try {
    const run = createRunningRun(env.teams, { max_workers: 2, max_tasks: 6, max_actions: 10, wall_clock_seconds: 60 });
    const exclusiveTaskId = `task_exclusive_${randomUUID()}`;
    const exclusiveEnvId = `envlease_exclusive_${randomUUID()}`;
    environmentLease(env, exclusiveEnvId, exclusiveTaskId);
    addDurableTask(env, run.id, { taskId: exclusiveTaskId, environmentLeaseId: exclusiveEnvId });

    const sharedTaskId = `task_shared_${randomUUID()}`;
    const sharedEnvId = `envlease_shared_${randomUUID()}`;
    environmentLease(env, sharedEnvId, sharedTaskId);
    addDurableTask(env, run.id, { taskId: sharedTaskId, environmentLeaseId: sharedEnvId });

    const externalRun = createRunningRun(env.teams, { max_workers: 1, max_tasks: 3, max_actions: 10, wall_clock_seconds: 60 }, "single");
    addDurableTask(env, externalRun.id, { taskId: `task_external_${randomUUID()}`, environmentLeaseId: sharedEnvId, enqueue: false });

    const result = await env.runner.teamRunControl.cancelRun(run.id, "bot_leader", "Revoke run-exclusive authority");
    assert.ok(result.environment_lease_ids_revoked.includes(exclusiveEnvId));
    assert.ok(result.shared_environment_lease_ids_preserved.includes(sharedEnvId));
    assert.equal(typeof env.store.getObject(exclusiveEnvId)?.payload.termination_revoked_at, "string");
    assert.ok(Date.parse(String(env.store.getObject(exclusiveEnvId)?.payload.expires_at)) <= Date.now());
    assert.equal(env.store.getObject(sharedEnvId)?.payload.termination_revoked_at, undefined);
    assert.ok(Date.parse(String(env.store.getObject(sharedEnvId)?.payload.expires_at)) > Date.now());
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("durable Team Run leader can abort a running participant-owned Task hierarchically", async () => {
  const runtime = new BlockingRuntime();
  const env = setup(runtime);
  try {
    const run = createRunningRun(env.teams, { max_workers: 1, max_tasks: 3, max_actions: 10, wall_clock_seconds: 60 });
    addPeerParticipant(env, run.id);
    const peerTask = addDurableTask(env, run.id, { createdBy: "bot_peer" });
    const execution = env.runner.runNext("bot_peer");
    await runtime.started;
    await env.runner.teamRunControl.cancelRun(run.id, "bot_leader", "Leader canceled participant-owned execution");
    await execution;
    assert.equal(runtime.calls, 1);
    assert.equal(runtime.aborts, 1);
    assert.equal(env.store.getObject(peerTask.task.id)?.payload.status, "canceled");
    assert.equal(env.queue.getByItem(peerTask.task.id)?.state, "canceled");
    assert.equal(env.teams.getRun(run.id)?.payload.status, "canceled");
    assert.equal(env.store.listObjects("artifact", WORKSPACE).length, 0);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("absolute Team Run wall-clock budget stops queued work before runtime execution", async () => {
  const runtime = new NoopRuntime();
  const env = setup(runtime);
  try {
    const run = createRunningRun(env.teams, { max_workers: 2, max_tasks: 3, max_actions: 10, wall_clock_seconds: 1 });
    const managed = env.manager.createWorkerTask({
      runId: run.id, createdBy: "bot_leader", workerId: "worker_expired_clock", roleTitle: "Late worker",
      objective: "Must never start after the run-level clock expires.", reason: "Absolute wall-clock proof."
    });
    const latest = env.teams.getRun(run.id)!;
    env.store.putObject("team_run", validateProtocolObject({ ...latest.payload, created_at: new Date(Date.now() - 5_000).toISOString(), updated_at: new Date().toISOString() }, "team_run"));
    env.supervisor.start();
    await env.supervisor.waitForIdle();
    assert.equal(runtime.calls, 0);
    assert.equal(env.teams.getRun(run.id)?.payload.status, "budget_exhausted");
    assert.equal((env.teams.getRun(run.id)?.payload.termination as any)?.state, "completed");
    assert.equal(env.store.getObject(managed.task.id)?.payload.status, "canceled");
    assert.equal(env.queue.getByItem(managed.task.id)?.state, "canceled");
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

test("absolute Team Run deadline aborts already-running work and settles the run as budget_exhausted", async () => {
  const runtime = new BlockingRuntime();
  const env = setup(runtime);
  try {
    const run = createRunningRun(env.teams, { max_workers: 2, max_tasks: 3, max_actions: 10, wall_clock_seconds: 1 });
    const managed = env.manager.createWorkerTask({
      runId: run.id, createdBy: "bot_leader", workerId: "worker_clock_abort", roleTitle: "Clock-bound worker",
      objective: "Abort at the absolute Team Run deadline.", reason: "Run wall-clock enforcement."
    });
    const latest = env.teams.getRun(run.id)!;
    env.store.putObject("team_run", validateProtocolObject({ ...latest.payload, created_at: new Date(Date.now() - 750).toISOString(), updated_at: new Date().toISOString() }, "team_run"));
    env.supervisor.start();
    await runtime.started;
    await env.supervisor.waitForIdle();
    assert.equal(runtime.calls, 1);
    assert.equal(runtime.aborts, 1);
    assert.equal(env.store.getObject(managed.task.id)?.payload.status, "canceled");
    assert.equal(env.teams.getRun(run.id)?.payload.status, "budget_exhausted");
    assert.equal((env.teams.getRun(run.id)?.payload.termination as any)?.outcome, "budget_exhausted");
    assert.equal(env.store.listObjects("artifact", WORKSPACE).length, 0);
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

test("aggregate runtime budget exhaustion uses the same canonical terminal cascade", async () => {
  const runtime = new OneActionRuntime();
  const env = setup(runtime);
  env.supervisor.start();
  try {
    const run = createRunningRun(env.teams, { max_workers: 3, max_tasks: 4, max_actions: 1, wall_clock_seconds: 60 });
    const first = env.manager.createWorkerTask({ runId: run.id, createdBy: "bot_leader", workerId: "worker_budget_first", roleTitle: "First worker", objective: "Consume the one allowed action.", reason: "Budget setup." });
    await env.supervisor.waitForIdle();
    assert.equal(env.store.getObject(first.task.id)?.payload.status, "completed");
    const second = env.manager.createWorkerTask({ runId: run.id, createdBy: "bot_leader", workerId: "worker_budget_second", roleTitle: "Second worker", objective: "Attempt to exceed aggregate action budget.", reason: "Budget exhaustion proof." });
    await env.supervisor.waitForIdle();
    const latestRun = env.teams.getRun(run.id)!;
    assert.equal(latestRun.payload.status, "budget_exhausted");
    assert.equal((latestRun.payload.termination as any)?.state, "completed");
    assert.equal(env.store.getObject(first.task.id)?.payload.status, "completed");
    assert.equal(env.store.getObject(second.task.id)?.payload.status, "failed");
    assert.ok(String(env.store.getObject(second.task.id)?.payload.failure_code).startsWith("TEAM_RUN_"));
    assert.ok(Date.parse(String(env.store.getObject(second.lease.id)?.payload.expires_at)) <= Date.now());
    assert.equal(env.queue.listQueuedTargets().length, 0);
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

test("terminal Team Run residue recovers after reopen, closes orphan Thread, and cleanup preserves prior canceled Worker state", async () => {
  const dbPath = `/tmp/ai-verse-teamrun-control-${randomUUID()}.db`;
  const runtime = new NoopRuntime();
  let taskId = "";
  let runId = "";
  let threadId = "";
  {
    const env = setup(runtime, dbPath);
    const run = createRunningRun(env.teams, { max_workers: 2, max_tasks: 3, max_actions: 10, wall_clock_seconds: 60 });
    runId = run.id;
    const managed = env.manager.createWorkerTask({ runId: run.id, createdBy: "bot_leader", workerId: "worker_restart_fence", roleTitle: "Restart worker", objective: "Must not execute after terminal fence.", reason: "Restart recovery proof." });
    taskId = managed.task.id;
    const roomId = `room_closed_${randomUUID()}`;
    env.store.putObject("room", validateProtocolObject({
      schema_version: "1.0", id: roomId, name: "Already closed temporary room", status: "closed",
      scope: { type: "workspace", workspace_id: WORKSPACE }, members: ["bot_leader"],
      orchestration: { mode: "hybrid", leader: "bot_leader" }, temporary: true, run_id: run.id
    }, "room"));
    threadId = `thread_orphan_${randomUUID()}`;
    env.store.putObject("thread", validateProtocolObject({
      schema_version: "1.0", id: threadId, type: "thread", workspace_id: WORKSPACE, room_id: roomId,
      parent_message_id: "msg_orphan_parent", created_by: "bot_leader", status: "active"
    }, "thread"));
    const latest = env.teams.getRun(run.id)!;
    env.store.putObject("team_run", validateProtocolObject({
      ...latest.payload,
      status: "canceled",
      status_reason: "Simulated crash after terminal fence",
      terminal_at: new Date().toISOString(),
      termination: { state: "stopping", outcome: "canceled", requested_by: "bot_leader", requested_at: new Date().toISOString(), reason: "Simulated interrupted cancellation", trigger_task_id: null },
      updated_at: new Date().toISOString()
    }, "team_run"));
    env.queue.close();
    env.store.close();
  }

  const reopened = setup(runtime, dbPath);
  reopened.supervisor.start();
  try {
    await reopened.supervisor.waitForIdle();
    assert.equal(runtime.calls, 0);
    assert.equal(reopened.teams.getRun(runId)?.payload.status, "canceled");
    assert.equal((reopened.teams.getRun(runId)?.payload.termination as any)?.state, "completed");
    assert.equal(reopened.store.getObject(taskId)?.payload.status, "canceled");
    assert.equal(reopened.queue.getByItem(taskId)?.state, "canceled");
    assert.equal(reopened.store.getObject(threadId)?.payload.status, "closed");
    const worker = reopened.teams.getWorker("worker_restart_fence");
    assert.equal(worker?.payload.status, "expired");
    assert.equal(worker?.payload.cleanup_previous_status, "canceled");
  } finally {
    await reopened.supervisor.stop();
    reopened.queue.close();
    reopened.store.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
});
