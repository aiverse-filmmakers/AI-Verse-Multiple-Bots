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
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest, JsonObject } from "../src/types.js";
import { validateProtocolObject } from "../src/validator.js";

const WORKSPACE = "ws_phase2_control";

function bot(id: string, runtimeAdapter: string): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: "Team participant", mission: "Execute bounded Team Run work." },
    runtime: { adapter: runtimeAdapter },
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
  gateway.createBot(bot("bot_leader", runtime.id));
  gateway.createBot(bot("bot_peer", runtime.id));
  const teams = new TeamRunCoordinator(store);
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(runtime), `runner_${randomUUID()}`, 2, 50);
  const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0);
  const manager = new TeamRunManager(teams, gateway, queue, runner);
  return { store, queue, gateway, teams, runner, supervisor, manager };
}

function createRunningRun(teams: TeamRunCoordinator, budget: Record<string, number>) {
  let run = teams.createRun({
    leaderId: "bot_leader",
    workspaceId: WORKSPACE,
    rootObjectiveId: `obj_${randomUUID()}`,
    objective: "Exercise the final Phase 2 Team Run control boundary.",
    topology: "hybrid",
    budget
  }).run;
  run = teams.transitionRun(run.id, "planning", "bot_leader", "Control test planning").run;
  run = teams.transitionRun(run.id, "running", "bot_leader", "Control test running").run;
  return run;
}

function addDurableBotTask(env: ReturnType<typeof setup>, runId: string, taskId: string) {
  const run = env.teams.getRun(runId)!;
  const leaseId = `lease_${randomUUID()}`;
  const lease = validateProtocolObject({
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
  }, "capability_lease");
  const task = validateProtocolObject({
    schema_version: "1.0",
    id: taskId,
    type: "task.delegate",
    created_by: "bot_leader",
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
    environment_lease_id: null,
    response_target: { kind: "bot", id: "bot_leader" },
    deadline_at: null,
    budget: run.payload.budget,
    hop: 0,
    max_hops: 6,
    recovery_policy: "retry_safe",
    max_attempts: 2,
    status: "assigned",
    created_at: new Date().toISOString()
  }, "task");
  env.store.atomicMutation({
    objects: [
      { kind: "capability_lease", payload: lease },
      { kind: "task", payload: task }
    ],
    events: []
  });
  env.queue.enqueueTask(taskId, "bot_peer", WORKSPACE, { recoveryPolicy: "retry_safe", maxAttempts: 2 });
  return { taskId, leaseId };
}

class NoopRuntime implements RuntimeAdapter {
  readonly id = "phase2-control-noop";
  calls = 0;
  async execute(): Promise<RuntimeExecutionResult> {
    this.calls += 1;
    return {
      summary: "done",
      artifactKind: "control_result",
      output: { ok: true },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 1 }
    };
  }
}

test("canonical Team Run cancellation fences and drains Worker plus durable-Bot work, approvals, handoffs, leases and temporary surfaces", async () => {
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
    const durable = addDurableBotTask(env, run.id, `task_peer_${randomUUID()}`);

    const approvalId = `approval_${randomUUID()}`;
    env.store.putObject("approval", validateProtocolObject({
      schema_version: "1.0",
      id: approvalId,
      type: "approval",
      workspace_id: WORKSPACE,
      task_id: durable.taskId,
      actor_id: "bot_peer",
      action: { kind: "external_action", summary: "Should become non-actionable when the run stops" },
      status: "pending",
      created_at: new Date().toISOString()
    }, "approval"));

    const handoffId = `handoff_${randomUUID()}`;
    env.store.putObject("handoff", validateProtocolObject({
      schema_version: "1.0",
      id: handoffId,
      type: "handoff",
      source_owner_id: "bot_leader",
      target_bot_id: "bot_peer",
      target_owner_id: "bot_peer",
      workspace_id: WORKSPACE,
      task_id: durable.taskId,
      work_item_id: durable.taskId,
      run_id: run.id,
      root_objective_id: String(run.payload.root_objective_id),
      reason: "Pending ownership transfer must stop with the run",
      required_constraints: [],
      artifact_refs: [],
      return_policy: "stay_with_target",
      status: "requested",
      created_at: new Date().toISOString()
    }, "handoff"));

    const roomId = `room_${randomUUID()}`;
    env.store.putObject("room", validateProtocolObject({
      schema_version: "1.0",
      id: roomId,
      name: "Temporary control room",
      status: "active",
      scope: { type: "workspace", workspace_id: WORKSPACE },
      members: ["bot_leader"],
      orchestration: { mode: "hybrid", leader: "bot_leader" },
      temporary: true,
      run_id: run.id,
      discussion: { run_id: run.id, status: "open", current_task_id: managed.task.id }
    }, "room"));
    const threadId = `thread_${randomUUID()}`;
    env.store.putObject("thread", validateProtocolObject({
      schema_version: "1.0",
      id: threadId,
      type: "thread",
      workspace_id: WORKSPACE,
      room_id: roomId,
      parent_message_id: "msg_control_parent",
      created_by: "bot_leader",
      status: "active"
    }, "thread"));

    const result = await env.runner.teamRunControl.cancelRun(run.id, "bot_leader", "Stop every branch of this Team Run");

    assert.equal(result.run.payload.status, "canceled");
    assert.equal((result.run.payload.termination as any)?.state, "completed");
    assert.equal(env.store.getObject(managed.task.id)?.payload.status, "canceled");
    assert.equal(env.store.getObject(durable.taskId)?.payload.status, "canceled");
    assert.equal(env.queue.getByItem(managed.task.id)?.state, "canceled");
    assert.equal(env.queue.getByItem(durable.taskId)?.state, "canceled");
    assert.equal(env.teams.getWorker("worker_control")?.payload.status, "canceled");
    assert.equal(env.store.getObject(approvalId)?.payload.status, "canceled");
    assert.equal(env.store.getObject(handoffId)?.payload.status, "canceled");
    assert.ok(Date.parse(String(env.store.getObject(durable.leaseId)?.payload.expires_at)) <= Date.now());
    assert.equal(env.store.getObject(roomId)?.payload.status, "closed");
    assert.equal(env.store.getObject(threadId)?.payload.status, "closed");
    assert.equal(runtime.calls, 0);

    const eventCount = env.store.listEventsAfter(0, 500).filter((entry) => entry.event.type === "team_run.canceled" && entry.event.run_id === run.id).length;
    assert.equal(eventCount, 1);
    await env.runner.teamRunControl.cancelRun(run.id, "bot_leader", "Repeated cancel is idempotent");
    const eventCountAfter = env.store.listEventsAfter(0, 500).filter((entry) => entry.event.type === "team_run.canceled" && entry.event.run_id === run.id).length;
    assert.equal(eventCountAfter, 1);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("absolute Team Run wall-clock budget stops queued work before runtime execution", async () => {
  const runtime = new NoopRuntime();
  const env = setup(runtime);
  env.supervisor.start();
  try {
    const run = createRunningRun(env.teams, { max_workers: 2, max_tasks: 3, max_actions: 10, wall_clock_seconds: 1 });
    const managed = env.manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_expired_clock",
      roleTitle: "Late worker",
      objective: "Must never start after the run-level clock expires.",
      reason: "Absolute wall-clock proof."
    });
    const latest = env.teams.getRun(run.id)!;
    env.store.putObject("team_run", validateProtocolObject({
      ...latest.payload,
      created_at: new Date(Date.now() - 5_000).toISOString(),
      updated_at: new Date().toISOString()
    }, "team_run"));

    env.supervisor.trigger("worker_expired_clock");
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

class BlockingRuntime implements RuntimeAdapter {
  readonly id = "phase2-control-blocking";
  calls = 0;
  private startedResolve!: () => void;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });
  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    this.calls += 1;
    this.startedResolve();
    return await new Promise<RuntimeExecutionResult>((_resolve, reject) => {
      const abort = () => reject(context.signal.reason instanceof Error ? context.signal.reason : new Error("aborted"));
      if (context.signal.aborted) abort();
      else context.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

test("absolute Team Run deadline aborts already-running work and settles the run as budget_exhausted", async () => {
  const runtime = new BlockingRuntime();
  const env = setup(runtime);
  try {
    const run = createRunningRun(env.teams, { max_workers: 2, max_tasks: 3, max_actions: 10, wall_clock_seconds: 1 });
    const managed = env.manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_clock_abort",
      roleTitle: "Clock-bound worker",
      objective: "Abort at the absolute Team Run deadline.",
      reason: "Run wall-clock enforcement."
    });
    const latest = env.teams.getRun(run.id)!;
    env.store.putObject("team_run", validateProtocolObject({
      ...latest.payload,
      created_at: new Date(Date.now() - 850).toISOString(),
      updated_at: new Date().toISOString()
    }, "team_run"));

    env.supervisor.start();
    await runtime.started;
    await env.supervisor.waitForIdle();

    assert.equal(runtime.calls, 1);
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

class OneActionRuntime implements RuntimeAdapter {
  readonly id = "phase2-control-one-action";
  calls = 0;
  async execute(): Promise<RuntimeExecutionResult> {
    this.calls += 1;
    return {
      summary: "one action",
      artifactKind: "control_result",
      output: { call: this.calls },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 1 }
    };
  }
}

test("aggregate runtime budget exhaustion uses the same canonical terminal cascade", async () => {
  const runtime = new OneActionRuntime();
  const env = setup(runtime);
  env.supervisor.start();
  try {
    const run = createRunningRun(env.teams, { max_workers: 3, max_tasks: 4, max_actions: 1, wall_clock_seconds: 60 });
    const first = env.manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_budget_first",
      roleTitle: "First worker",
      objective: "Consume the one allowed action.",
      reason: "Budget setup."
    });
    await env.supervisor.waitForIdle();
    assert.equal(env.store.getObject(first.task.id)?.payload.status, "completed");

    const second = env.manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_budget_second",
      roleTitle: "Second worker",
      objective: "Attempt to exceed the aggregate action budget.",
      reason: "Budget exhaustion proof."
    });
    await env.supervisor.waitForIdle();

    const latestRun = env.teams.getRun(run.id)!;
    assert.equal(latestRun.payload.status, "budget_exhausted");
    assert.equal((latestRun.payload.termination as any)?.state, "completed");
    assert.equal(env.store.getObject(first.task.id)?.payload.status, "completed");
    assert.equal(env.store.getObject(second.task.id)?.payload.status, "failed");
    assert.ok(String(env.store.getObject(second.task.id)?.payload.failure_code).startsWith("TEAM_RUN_"));
    assert.ok(Date.parse(String(env.store.getObject(String(second.lease.id))?.payload.expires_at)) <= Date.now());
    assert.equal(env.queue.listQueuedTargets().length, 0);
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

test("terminal Team Run residue is recovered after database reopen before queued work can execute", async () => {
  const dbPath = `/tmp/ai-verse-teamrun-control-${randomUUID()}.db`;
  const runtime = new NoopRuntime();
  let taskId = "";
  let runId = "";
  {
    const env = setup(runtime, dbPath);
    const run = createRunningRun(env.teams, { max_workers: 2, max_tasks: 3, max_actions: 10, wall_clock_seconds: 60 });
    runId = run.id;
    const managed = env.manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_restart_fence",
      roleTitle: "Restart worker",
      objective: "Must not execute after a crash between run fence and cascade.",
      reason: "Restart recovery proof."
    });
    taskId = managed.task.id;
    const latest = env.teams.getRun(run.id)!;
    env.store.putObject("team_run", validateProtocolObject({
      ...latest.payload,
      status: "canceled",
      status_reason: "Simulated crash after terminal fence",
      terminal_at: new Date().toISOString(),
      termination: {
        state: "stopping",
        outcome: "canceled",
        requested_by: "bot_leader",
        requested_at: new Date().toISOString(),
        reason: "Simulated interrupted cancellation",
        trigger_task_id: null
      },
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
    assert.equal(reopened.teams.getWorker("worker_restart_fence")?.payload.status, "canceled");
  } finally {
    await reopened.supervisor.stop();
    reopened.queue.close();
    reopened.store.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
});
