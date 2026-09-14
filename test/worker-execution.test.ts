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
import { TeamRunManager } from "../src/team-run-manager.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest } from "../src/types.js";

function leader(id = "bot_leader", runtimeAdapter = "deterministic"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: "Research Lead",
    kind: "durable",
    status: "active",
    role: { title: "Research Lead", mission: "Own synthesis and bounded specialist delegation." },
    runtime: { adapter: runtimeAdapter },
    execution: { environment_policy: "shared_workspace", environment_ref: "host-default" },
    scope: { type: "workspace", workspace_id: "ws_phase2_exec" },
    permissions: {
      policy_ref: "default-bot",
      allowed_peers: ["*"],
      allowed_tools: ["safe.tool"],
      allowed_connections: [],
      can_create_workers: true
    },
    coordination: { default_mode: "direct", max_parallel_workers: 4, max_hops: 6 }
  };
}

function setup(runtime: RuntimeAdapter, dbPath = ":memory:") {
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  gateway.createBot(leader("bot_leader", runtime.id));
  const teams = new TeamRunCoordinator(store);
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(runtime), `runner_${randomUUID()}`, 2, 100);
  const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0);
  const manager = new TeamRunManager(teams, gateway, queue, runner);
  return { store, queue, gateway, teams, runner, supervisor, manager };
}

function createManagerRun(teams: TeamRunCoordinator, budget: Record<string, number> = { max_workers: 2, token_limit: 1000, max_actions: 10 }) {
  return teams.createRun({
    leaderId: "bot_leader",
    workspaceId: "ws_phase2_exec",
    rootObjectiveId: `obj_${randomUUID()}`,
    objective: "Produce a bounded specialist result and return it to the durable leader.",
    topology: "manager",
    budget
  }).run;
}

test("manager topology executes a real temporary Worker Task and returns an Artifact to the durable leader", async () => {
  const env = setup(new DeterministicRuntimeAdapter());
  env.supervisor.start();
  try {
    const run = createManagerRun(env.teams);
    const managed = env.manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_source-auditor",
      roleTitle: "Source Auditor",
      objective: "Verify the bounded claim set independently.",
      reason: "Independent verification is useful.",
      requiredConstraints: ["Do not publish externally"]
    });

    await env.supervisor.waitForIdle();
    const task = env.store.getObject(managed.task.id);
    const worker = env.teams.getWorker(managed.worker.id);
    const artifacts = env.store.listObjects("artifact", "ws_phase2_exec");
    const latestRun = env.teams.getRun(run.id);

    assert.equal(task?.payload.status, "completed");
    assert.equal(worker?.payload.status, "completed");
    assert.equal(env.queue.getByItem(managed.task.id)?.state, "completed");
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.payload.created_by, "worker_source-auditor");
    assert.equal(artifacts[0]?.payload.run_id, run.id);
    assert.equal((artifacts[0]?.payload.provenance as any)?.origin, "worker_generated");
    assert.equal((latestRun?.payload.usage as any)?.actions, 1);
    assert.equal(env.store.listMailbox("bot_leader").length, 1);

    const runEvents = env.store.listEventsAfter(0, 200).filter((entry) => entry.event.run_id === run.id);
    assert.ok(runEvents.some((entry) => entry.event.type === "task.started" && entry.event.actor_id === "worker_source-auditor"));
    assert.ok(runEvents.some((entry) => entry.event.type === "task.completed"));
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

class CaptureRuntime implements RuntimeAdapter {
  readonly id = "capture-worker-principal";
  seen: { id: string; kind: string; legacyBot: string | null; runtimeAdapter: string } | null = null;

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    this.seen = {
      id: context.principal.id,
      kind: context.principalKind,
      legacyBot: context.bot?.id ?? null,
      runtimeAdapter: String(context.runtime.adapter)
    };
    return {
      summary: "Captured Worker principal",
      artifactKind: "capture",
      output: { captured: true },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 1 }
    };
  }
}

test("Worker runtime inheritance uses the Worker as canonical principal and never fabricates a Bot identity", async () => {
  const runtime = new CaptureRuntime();
  const env = setup(runtime);
  env.supervisor.start();
  try {
    const run = createManagerRun(env.teams);
    env.manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_capture",
      roleTitle: "Capture Specialist",
      objective: "Prove execution identity is the Worker.",
      reason: "Identity contract test."
    });
    await env.supervisor.waitForIdle();

    assert.deepEqual(runtime.seen, {
      id: "worker_capture",
      kind: "worker",
      legacyBot: null,
      runtimeAdapter: runtime.id
    });
    assert.equal(env.gateway.getBot("worker_capture"), null);
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

test("managed Workers cannot expand the durable leader's tool authority", () => {
  const env = setup(new DeterministicRuntimeAdapter());
  try {
    const run = createManagerRun(env.teams);
    assert.throws(() => env.manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_leader",
      roleTitle: "Overprivileged Worker",
      objective: "Attempt forbidden capability expansion.",
      reason: "Policy test.",
      tools: ["dangerous.tool"]
    }), /cannot expand leader tool authority/);
    assert.equal(env.teams.listWorkers(run.id).length, 0);
    assert.equal(env.store.listObjects("task", "ws_phase2_exec").length, 0);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

class BlockingRuntime implements RuntimeAdapter {
  readonly id = "blocking-worker";
  private startedResolve!: () => void;
  readonly started = new Promise<void>((resolve) => { this.startedResolve = resolve; });

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    this.startedResolve();
    return await new Promise<RuntimeExecutionResult>((_resolve, reject) => {
      const abort = () => reject(context.signal.reason instanceof Error ? context.signal.reason : new Error("aborted"));
      if (context.signal.aborted) abort();
      else context.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

test("canceling a Team Run aborts a running Worker Task and leaves no successful Artifact", async () => {
  const runtime = new BlockingRuntime();
  const env = setup(runtime);
  env.supervisor.start();
  try {
    const run = createManagerRun(env.teams);
    const managed = env.manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_blocked",
      roleTitle: "Blocking Worker",
      objective: "Run until the Team Run is canceled.",
      reason: "Cancellation test."
    });
    await runtime.started;
    await env.manager.cancelRun(run.id, "bot_leader", "Stop the bounded squad");
    await env.supervisor.waitForIdle();

    assert.equal(env.teams.getRun(run.id)?.payload.status, "canceled");
    assert.equal(env.teams.getWorker("worker_blocked")?.payload.status, "canceled");
    assert.equal(env.store.getObject(managed.task.id)?.payload.status, "canceled");
    assert.equal(env.queue.getByItem(managed.task.id)?.state, "canceled");
    assert.equal(env.store.listObjects("artifact", "ws_phase2_exec").length, 0);
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

class OneActionRuntime implements RuntimeAdapter {
  readonly id = "one-action-worker";
  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    return {
      summary: `Completed ${context.task.id}`,
      artifactKind: "one_action",
      output: { task_id: context.task.id },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 1 }
    };
  }
}

test("aggregate Team Run budget is enforced before accepting a second Worker Artifact", async () => {
  const env = setup(new OneActionRuntime());
  env.supervisor.start();
  try {
    const run = createManagerRun(env.teams, { max_workers: 2, max_actions: 1 });
    env.manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_budget_a",
      roleTitle: "Worker A",
      objective: "Consume the one allowed Team Run action.",
      reason: "Budget test A."
    });
    await env.supervisor.waitForIdle();
    assert.equal(env.teams.getWorker("worker_budget_a")?.payload.status, "completed");

    const second = env.manager.createWorkerTask({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_budget_b",
      roleTitle: "Worker B",
      objective: "Attempt a second Team Run action.",
      reason: "Budget test B."
    });
    await env.supervisor.waitForIdle();

    assert.equal(env.store.getObject(second.task.id)?.payload.status, "failed");
    assert.match(String(env.store.getObject(second.task.id)?.payload.failure_code), /^TEAM_RUN_/);
    assert.equal(env.teams.getWorker("worker_budget_b")?.payload.status, "failed");
    assert.equal(env.teams.getRun(run.id)?.payload.status, "budget_exhausted");
    assert.equal(env.store.listObjects("artifact", "ws_phase2_exec").length, 1);
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

test("stale retry-safe Worker execution recovers after store reopen and completes on the next attempt", async () => {
  const dbPath = `/tmp/aiverse-worker-recovery-${randomUUID()}.db`;
  let runId = "";
  let taskId = "";
  let workerId = "";

  {
    const env = setup(new DeterministicRuntimeAdapter(), dbPath);
    const run = createManagerRun(env.teams);
    runId = run.id;
    const managed = env.manager.createWorkerTask({
      runId,
      createdBy: "bot_leader",
      workerId: "worker_recovery",
      roleTitle: "Recovery Worker",
      objective: "Resume safely after a stale execution lease.",
      reason: "Recovery test.",
      recoveryPolicy: "retry_safe",
      maxAttempts: 2
    });
    taskId = managed.task.id;
    workerId = managed.worker.id;
    const claimed = env.queue.claimNext(workerId, "runner_stale", 1);
    if (!claimed) throw new Error("expected stale Worker claim");
    env.queue.markRunning(claimed.id, "runner_stale", 1);
    env.store.putObject("task", { ...managed.task.payload, status: "running" });
    env.store.putObject("worker", { ...managed.worker.payload, status: "running" });
    env.queue.close();
    env.store.close();
  }

  {
    const store = new CoordinationStore(dbPath);
    const queue = new ExecutionQueue(store.dbPath);
    const gateway = new CoordinationGateway(store, queue, new CoordinationPolicy(store, { requireRegisteredBots: true }));
    const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(new DeterministicRuntimeAdapter()), "runner_recovered", 2, 100);
    const supervisor = new ExecutionSupervisor(gateway, queue, runner, 0);
    try {
      const decisions = supervisor.sweepRecovery(Date.now() + 5000);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]?.action, "requeued");
      await supervisor.waitForIdle();

      assert.equal(store.getObject(taskId)?.payload.status, "completed");
      assert.equal(store.getObject(workerId)?.payload.status, "completed");
      assert.equal(queue.getByItem(taskId)?.state, "completed");
      assert.equal(queue.getByItem(taskId)?.attempts, 2);
      assert.equal(store.getObject(runId)?.payload.status, "running");
    } finally {
      await supervisor.stop();
      queue.close();
      store.close();
    }
  }
});


function setupRunScoped(runtime: RuntimeAdapter) {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  const teams = new TeamRunCoordinator(store);
  const runner = new BotRunner(
    store,
    gateway,
    queue,
    new RuntimeRegistry().register(runtime),
    "runner_runtime_scoped",
    2,
    100
  );
  const manager = new TeamRunManager(teams, gateway, queue, runner);
  return { store, queue, gateway, teams, runner, manager };
}

test("run-scoped automatic Worker completes and cleans up without creating a durable Bot", async () => {
  const runtime = new DeterministicRuntimeAdapter();
  const env = setupRunScoped(runtime);
  try {
    const result = await env.manager.runScopedTemporaryWorker({
      leaderId: "runtime_gateway",
      workspaceId: "ws_auto_worker",
      rootObjectiveId: "obj_auto_worker",
      objective: "Independently inspect the bounded work and return one result.",
      roleTitle: "Temporary Reviewer",
      reason: "A bounded parallel review improves the current user task.",
      runtimeLeader: {
        runtime: { adapter: runtime.id },
        allowedTools: ["safe.tool"],
        allowedConnections: [],
        skillRefs: []
      },
      tools: ["safe.tool"],
      runBudget: {
        max_workers: 1,
        max_tasks: 1,
        max_actions: 2,
        token_limit: 1000,
        wall_clock_seconds: 60
      },
      workerBudget: {
        max_actions: 1,
        token_limit: 500,
        wall_clock_seconds: 30
      }
    });

    assert.equal(result.executionStatus, "completed");
    assert.equal(result.run.payload.status, "completed");
    assert.equal(result.run.payload.leader_kind, "runtime");
    assert.equal(result.run.payload.leader_lifecycle, "run_scoped");
    assert.equal(result.run.payload.leader_id, "runtime_gateway");
    assert.equal(result.worker.payload.kind, "temporary");
    assert.equal(result.worker.payload.status, "expired");
    assert.equal(result.worker.payload.parent_owner_id, "runtime_gateway");
    assert.equal(result.task.payload.status, "completed");
    assert.equal(result.lease.payload.destructive_actions, "deny");
    assert.equal(typeof result.lease.payload.cleanup_revoked_at, "string");
    assert.ok(result.artifact);
    assert.equal(result.artifact?.payload.created_by, result.worker.id);
    assert.ok(result.cleanup.summary.worker_ids_expired.includes(result.worker.id));
    assert.ok(result.cleanup.summary.capability_lease_ids_revoked.includes(result.lease.id));

    assert.equal(env.store.listObjects("bot").length, 0);
    assert.equal(env.gateway.getBot("runtime_gateway"), null);
    assert.equal(env.gateway.getBot(result.worker.id), null);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("run-scoped automatic Worker cannot widen runtime leader authority", async () => {
  const runtime = new DeterministicRuntimeAdapter();
  const env = setupRunScoped(runtime);
  try {
    await assert.rejects(
      () => env.manager.runScopedTemporaryWorker({
        leaderId: "runtime_gateway",
        workspaceId: "ws_auto_worker",
        rootObjectiveId: "obj_auto_worker_denied",
        objective: "Attempt an overprivileged temporary review.",
        roleTitle: "Temporary Reviewer",
        reason: "Authority boundary test.",
        runtimeLeader: {
          runtime: { adapter: runtime.id },
          allowedTools: ["safe.tool"],
          allowedConnections: [],
          skillRefs: []
        },
        tools: ["dangerous.tool"],
        runBudget: { max_workers: 1, max_tasks: 1, max_actions: 1 }
      }),
      /cannot expand leader tool authority/
    );
    assert.equal(env.store.listObjects("bot").length, 0);
    assert.equal(env.store.listObjects("worker", "ws_auto_worker").length, 0);
    assert.equal(env.store.listObjects("task", "ws_auto_worker").length, 0);
    const runs = env.store.listObjects("team_run", "ws_auto_worker");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.payload.status, "failed");
    assert.equal(runs[0]?.payload.leader_kind, "runtime");
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("run-scoped runtime leader cannot unlock broader Team Run topologies or undeclared Skills", () => {
  const runtime = new DeterministicRuntimeAdapter();
  const env = setupRunScoped(runtime);
  try {
    assert.throws(
      () => env.teams.createRun({
        leaderId: "runtime_gateway",
        workspaceId: "ws_auto_worker",
        rootObjectiveId: "obj_bad_topology",
        objective: "Do not allow a durable-style topology.",
        topology: "dynamic_squad",
        runtimeLeader: {
          runtime: { adapter: runtime.id },
          allowedTools: [],
          allowedConnections: [],
          skillRefs: []
        }
      }),
      /limited to manager topology/
    );

    const run = env.teams.createRun({
      leaderId: "runtime_gateway",
      workspaceId: "ws_auto_worker",
      rootObjectiveId: "obj_skill_boundary",
      objective: "Bound Skill authority.",
      topology: "manager",
      runtimeLeader: {
        runtime: { adapter: runtime.id },
        allowedTools: [],
        allowedConnections: [],
        skillRefs: []
      }
    }).run;
    assert.throws(
      () => env.manager.createWorkerTask({
        runId: run.id,
        createdBy: "runtime_gateway",
        roleTitle: "Temporary Specialist",
        objective: "Attempt undeclared Skill use.",
        reason: "Skill boundary test.",
        skillRefs: ["aiverse-skills:undeclared"]
      }),
      /does not declare skill capability|undeclared leader skill capability/
    );
    assert.equal(env.store.listObjects("bot").length, 0);
  } finally {
    env.queue.close();
    env.store.close();
  }
});
