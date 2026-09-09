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
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest } from "../src/types.js";

const WORKSPACE = "ws_phase2_fanout";

function leader(runtimeAdapter: string, maxParallelWorkers = 4): BotManifest {
  return {
    schema_version: "1.0",
    id: "bot_fanout_leader",
    name: "Fan-out Lead",
    kind: "durable",
    status: "active",
    role: { title: "Fan-out Lead", mission: "Coordinate bounded parallel specialists without expanding authority." },
    runtime: { adapter: runtimeAdapter },
    execution: { environment_policy: "shared_workspace", environment_ref: "host-default" },
    scope: { type: "workspace", workspace_id: WORKSPACE },
    permissions: {
      policy_ref: "default-bot",
      allowed_peers: ["*"],
      allowed_tools: ["safe.tool"],
      allowed_connections: [],
      can_create_workers: true
    },
    coordination: { default_mode: "direct", max_parallel_workers: maxParallelWorkers, max_hops: 6 }
  };
}

function setup(runtime: RuntimeAdapter, options: { dbPath?: string; maxParallelWorkers?: number; createLeader?: boolean } = {}) {
  const store = new CoordinationStore(options.dbPath ?? ":memory:");
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  if (options.createLeader !== false) gateway.createBot(leader(runtime.id, options.maxParallelWorkers ?? 4));
  const teams = new TeamRunCoordinator(store);
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(runtime), `runner_${randomUUID()}`, 2, 100);
  const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0);
  return { store, queue, gateway, teams, runner, supervisor, fanout: supervisor.fanout };
}

function createRun(teams: TeamRunCoordinator, budget: Record<string, number> = { max_workers: 4, max_actions: 8, token_limit: 4000 }) {
  return teams.createRun({
    leaderId: "bot_fanout_leader",
    workspaceId: WORKSPACE,
    rootObjectiveId: `obj_${randomUUID()}`,
    objective: "Collect bounded independent specialist results in parallel.",
    topology: "parallel_panel",
    budget
  }).run;
}

function worker(index: number, objective = `Parallel objective ${index}`, budget: Record<string, number> = { max_actions: 1 }) {
  return {
    workerId: `worker_fanout_${index}_${randomUUID()}`,
    key: `panel-${index}`,
    roleTitle: `Parallel Specialist ${index}`,
    objective,
    reason: `Independent parallel lane ${index}`,
    budget
  };
}

class BarrierRuntime implements RuntimeAdapter {
  readonly id = "fanout-barrier";
  active = 0;
  maxActive = 0;
  arrivals = 0;
  readonly objectives: string[] = [];
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });

  constructor(readonly expected: number) {}

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.arrivals += 1;
    this.objectives.push(String(context.task.payload.objective));
    if (this.arrivals === this.expected) this.release();
    await Promise.race([
      this.gate,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("parallel barrier timed out")), 1000))
    ]);
    this.active -= 1;
    return {
      summary: `Completed ${String(context.task.payload.objective)}`,
      artifactKind: "parallel_result",
      output: { objective: context.task.payload.objective, worker_id: context.principal.id },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 1 }
    };
  }
}

test("parallel fan-out runs three independent Workers concurrently and collects all Artifacts", async () => {
  const runtime = new BarrierRuntime(3);
  const env = setup(runtime, { maxParallelWorkers: 3 });
  env.supervisor.start();
  try {
    const run = createRun(env.teams, { max_workers: 3, max_actions: 3, token_limit: 3000 });
    const created = env.fanout.createFanout({
      runId: run.id,
      createdBy: "bot_fanout_leader",
      workers: [worker(1), worker(2), worker(3)],
      join: { mode: "all" }
    });
    assert.equal(created.status, "running");

    await env.supervisor.waitForIdle();
    const snapshot = env.fanout.snapshot(run.id, created.fanoutId);

    assert.equal(runtime.maxActive, 3);
    assert.equal(snapshot.status, "satisfied");
    assert.equal(snapshot.successfulTaskIds.length, 3);
    assert.equal(snapshot.pendingTaskIds.length, 0);
    assert.equal(snapshot.artifacts.length, 3);
    assert.equal(new Set(runtime.objectives).size, 3);
    assert.equal(env.teams.getRun(run.id)?.payload.active_fanout_id, null);
    assert.equal(Number((env.teams.getRun(run.id)?.payload.usage as any)?.actions), 3);
    assert.equal(env.fanout.collectArtifacts(run.id, created.fanoutId).length, 3);
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

test("fan-out scheduling enforces the central concurrency ceiling and Team Run max_workers before creating work", () => {
  const runtime = new DeterministicRuntimeAdapter();
  const env = setup(runtime, { maxParallelWorkers: 2 });
  try {
    const concurrencyRun = createRun(env.teams, { max_workers: 4, max_actions: 4 });
    assert.throws(() => env.fanout.createFanout({
      runId: concurrencyRun.id,
      createdBy: "bot_fanout_leader",
      workers: [worker(11), worker(12), worker(13)]
    }), /concurrency ceiling of 2/);
    assert.equal(env.teams.listWorkers(concurrencyRun.id).length, 0);

    const workerRun = createRun(env.teams, { max_workers: 2, max_actions: 4 });
    assert.throws(() => env.fanout.createFanout({
      runId: workerRun.id,
      createdBy: "bot_fanout_leader",
      workers: [worker(21), worker(22), worker(23)],
      maxConcurrency: 4
    }), /Workers with a limit of 2/);
    assert.equal(env.teams.listWorkers(workerRun.id).length, 0);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("fan-out reserves aggregate consumptive budget before concurrent Workers become executable", () => {
  const env = setup(new DeterministicRuntimeAdapter(), { maxParallelWorkers: 3 });
  try {
    const run = createRun(env.teams, { max_workers: 3, max_actions: 2 });
    assert.throws(() => env.fanout.createFanout({
      runId: run.id,
      createdBy: "bot_fanout_leader",
      workers: [
        worker(31, "Reserve action A", { max_actions: 1 }),
        worker(32, "Reserve action B", { max_actions: 1 }),
        worker(33, "Reserve action C", { max_actions: 1 })
      ]
    }), /reservations 3 exceed Team Run remaining budget 2/);
    assert.equal(env.teams.listWorkers(run.id).length, 0);
    assert.equal(env.store.listObjects("task", WORKSPACE).length, 0);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

class JoinRuntime implements RuntimeAdapter {
  readonly id: string;
  arrivals = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });

  constructor(readonly expected: number, readonly fastMarkers: string[], id: string) {
    this.id = id;
  }

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    const objective = String(context.task.payload.objective);
    this.arrivals += 1;
    if (this.arrivals === this.expected) this.release();
    await Promise.race([
      this.gate,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("join barrier timed out")), 1000))
    ]);

    if (this.fastMarkers.some((marker) => objective.includes(marker))) {
      return {
        summary: `Success: ${objective}`,
        artifactKind: "join_result",
        output: { objective, worker_id: context.principal.id },
        usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 1 }
      };
    }

    return await new Promise<RuntimeExecutionResult>((_resolve, reject) => {
      const abort = () => reject(context.signal.reason instanceof Error ? context.signal.reason : new Error("aborted"));
      if (context.signal.aborted) abort();
      else context.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

test("first_success join keeps the first Artifact and cancels the remaining running Workers", async () => {
  const runtime = new JoinRuntime(3, ["FAST"], "fanout-first-success");
  const env = setup(runtime, { maxParallelWorkers: 3 });
  env.supervisor.start();
  try {
    const run = createRun(env.teams, { max_workers: 3, max_actions: 3 });
    const created = env.fanout.createFanout({
      runId: run.id,
      createdBy: "bot_fanout_leader",
      workers: [
        worker(41, "FAST answer", { max_actions: 1 }),
        worker(42, "BLOCK answer B", { max_actions: 1 }),
        worker(43, "BLOCK answer C", { max_actions: 1 })
      ],
      join: { mode: "first_success" }
    });

    await env.supervisor.waitForIdle();
    const snapshot = env.fanout.snapshot(run.id, created.fanoutId);
    assert.equal(snapshot.status, "satisfied");
    assert.equal(snapshot.successfulTaskIds.length, 1);
    assert.equal(snapshot.canceledTaskIds.length, 2);
    assert.equal(snapshot.artifacts.length, 1);
    assert.equal(snapshot.pendingTaskIds.length, 0);
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

test("quorum join settles after two successes and cancels the unnecessary remainder", async () => {
  const runtime = new JoinRuntime(3, ["FAST-A", "FAST-B"], "fanout-quorum");
  const env = setup(runtime, { maxParallelWorkers: 3 });
  env.supervisor.start();
  try {
    const run = createRun(env.teams, { max_workers: 3, max_actions: 3 });
    const created = env.fanout.createFanout({
      runId: run.id,
      createdBy: "bot_fanout_leader",
      workers: [
        worker(51, "FAST-A result", { max_actions: 1 }),
        worker(52, "FAST-B result", { max_actions: 1 }),
        worker(53, "BLOCK remainder", { max_actions: 1 })
      ],
      join: { mode: "quorum", quorum: 2 }
    });

    await env.supervisor.waitForIdle();
    const snapshot = env.fanout.snapshot(run.id, created.fanoutId);
    assert.equal(snapshot.status, "satisfied");
    assert.equal(snapshot.successfulTaskIds.length, 2);
    assert.equal(snapshot.canceledTaskIds.length, 1);
    assert.equal(snapshot.artifacts.length, 2);
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

class PartialRuntime implements RuntimeAdapter {
  readonly id = "fanout-partial";
  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    const objective = String(context.task.payload.objective);
    if (objective.includes("FAIL")) throw new Error("intentional specialist failure");
    return {
      summary: `Success: ${objective}`,
      artifactKind: "partial_result",
      output: { objective },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 1 }
    };
  }
}

test("all join records partial failure without corrupting successful sibling Artifacts", async () => {
  const env = setup(new PartialRuntime(), { maxParallelWorkers: 2 });
  env.supervisor.start();
  try {
    const run = createRun(env.teams, { max_workers: 2, max_actions: 2 });
    const created = env.fanout.createFanout({
      runId: run.id,
      createdBy: "bot_fanout_leader",
      workers: [
        worker(61, "GOOD specialist", { max_actions: 1 }),
        worker(62, "FAIL specialist", { max_actions: 1 })
      ],
      join: { mode: "all" }
    });

    await env.supervisor.waitForIdle();
    const snapshot = env.fanout.snapshot(run.id, created.fanoutId);
    assert.equal(snapshot.status, "partial");
    assert.equal(snapshot.successfulTaskIds.length, 1);
    assert.equal(snapshot.failedTaskIds.length, 1);
    assert.equal(snapshot.artifacts.length, 1);
    assert.equal(env.teams.getRun(run.id)?.payload.status, "running");
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

class AllBlockingRuntime implements RuntimeAdapter {
  readonly id = "fanout-all-blocking";
  arrivals = 0;
  private startedResolve!: () => void;
  readonly started: Promise<void>;

  constructor(readonly expected: number) {
    this.started = new Promise<void>((resolve) => { this.startedResolve = resolve; });
  }

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    this.arrivals += 1;
    if (this.arrivals === this.expected) this.startedResolve();
    return await new Promise<RuntimeExecutionResult>((_resolve, reject) => {
      const abort = () => reject(context.signal.reason instanceof Error ? context.signal.reason : new Error("aborted"));
      if (context.signal.aborted) abort();
      else context.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

test("explicit fan-out cancellation propagates across all queued or running Worker Tasks", async () => {
  const runtime = new AllBlockingRuntime(3);
  const env = setup(runtime, { maxParallelWorkers: 3 });
  env.supervisor.start();
  try {
    const run = createRun(env.teams, { max_workers: 3, max_actions: 3 });
    const created = env.fanout.createFanout({
      runId: run.id,
      createdBy: "bot_fanout_leader",
      workers: [worker(71), worker(72), worker(73)],
      join: { mode: "all" }
    });
    await runtime.started;
    const snapshot = await env.fanout.cancelFanout(run.id, "bot_fanout_leader", "Stop the parallel panel");
    await env.supervisor.waitForIdle();

    assert.equal(snapshot.fanoutId, created.fanoutId);
    assert.equal(env.fanout.snapshot(run.id, created.fanoutId).status, "canceled");
    assert.equal(env.fanout.snapshot(run.id, created.fanoutId).canceledTaskIds.length, 3);
    assert.equal(env.store.listObjects("artifact", WORKSPACE).length, 0);
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

test("two stale retry-safe fan-out Workers recover after database reopen and satisfy the persisted join", async () => {
  const dbPath = `/tmp/aiverse-fanout-recovery-${randomUUID()}.db`;
  let runId = "";
  let fanoutId = "";
  let taskIds: string[] = [];
  let workerIds: string[] = [];

  {
    const env = setup(new DeterministicRuntimeAdapter(), { dbPath, maxParallelWorkers: 2 });
    const run = createRun(env.teams, { max_workers: 2, max_actions: 2 });
    runId = run.id;
    const created = env.fanout.createFanout({
      runId,
      createdBy: "bot_fanout_leader",
      workers: [
        { ...worker(81), recoveryPolicy: "retry_safe" as const, maxAttempts: 2 },
        { ...worker(82), recoveryPolicy: "retry_safe" as const, maxAttempts: 2 }
      ],
      join: { mode: "all" }
    });
    fanoutId = created.fanoutId;
    taskIds = created.tasks.map((task) => task.id);
    workerIds = created.workers.map((item) => item.id);

    taskIds.forEach((taskId, index) => {
      const workerId = workerIds[index];
      if (!workerId) throw new Error("missing fan-out Worker");
      const claimed = env.queue.claimNext(workerId, `runner_stale_${index}`, 1);
      if (!claimed) throw new Error(`expected stale claim for ${workerId}`);
      env.queue.markRunning(claimed.id, `runner_stale_${index}`, 1);
      const task = env.store.getObject(taskId);
      const workerObject = env.store.getObject(workerId);
      if (!task || task.kind !== "task" || !workerObject || workerObject.kind !== "worker") throw new Error("missing fan-out records");
      env.store.putObject("task", { ...task.payload, status: "running" });
      env.store.putObject("worker", { ...workerObject.payload, status: "running" });
    });
    env.queue.close();
    env.store.close();
  }

  {
    const store = new CoordinationStore(dbPath);
    const queue = new ExecutionQueue(store.dbPath);
    const gateway = new CoordinationGateway(store, queue, new CoordinationPolicy(store, { requireRegisteredBots: true }));
    const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(new DeterministicRuntimeAdapter()), "runner_fanout_recovered", 2, 100);
    const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0);
    try {
      const decisions = supervisor.sweepRecovery(Date.now() + 5000);
      assert.equal(decisions.length, 2);
      assert.ok(decisions.every((decision) => decision.action === "requeued"));
      await supervisor.waitForIdle();

      for (const taskId of taskIds) {
        assert.equal(store.getObject(taskId)?.payload.status, "completed");
        assert.equal(queue.getByItem(taskId)?.state, "completed");
        assert.equal(queue.getByItem(taskId)?.attempts, 2);
      }
      for (const workerId of workerIds) assert.equal(store.getObject(workerId)?.payload.status, "completed");
      const snapshot = supervisor.fanout.snapshot(runId, fanoutId);
      assert.equal(snapshot.status, "satisfied");
      assert.equal(snapshot.artifacts.length, 2);
      assert.equal(Number((store.getObject(runId)?.payload.usage as any)?.actions), 2);
    } finally {
      await supervisor.stop();
      queue.close();
      store.close();
    }
  }
});
