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

function bot(id: string, runtimeAdapter: string, tools: string[] = ["safe.tool"]): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: `Bounded Team Run role for ${id}` },
    runtime: { adapter: runtimeAdapter },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_direct_handoff" },
    permissions: {
      policy_ref: "strict",
      allowed_peers: ["*"],
      allowed_tools: tools,
      allowed_connections: [],
      can_create_workers: true,
      can_handoff: true
    },
    coordination: { default_mode: "direct", max_parallel_workers: 4, max_hops: 6 }
  };
}

function fixture(runtime: RuntimeAdapter = new DeterministicRuntimeAdapter(), dbPath = ":memory:", createBots = true) {
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
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

function createRun(teams: TeamRunCoordinator, budget: Record<string, number> = { max_workers: 4, max_hops: 6, max_actions: 10 }) {
  return teams.createRun({
    leaderId: "bot_leader",
    workspaceId: "ws_direct_handoff",
    rootObjectiveId: `obj_${randomUUID()}`,
    objective: "Complete a bounded specialist chain through direct ownership transfer.",
    topology: "handoff",
    budget
  }).run;
}

function createSource(env: ReturnType<typeof fixture>, runId: string, workerId = "worker_source") {
  return env.manager.createWorkerTask({
    runId,
    createdBy: "bot_leader",
    workerId,
    roleTitle: "Source Specialist",
    objective: "Prepare the work item for the best next owner.",
    reason: "Direct-handoff source stage.",
    tools: ["safe.tool"],
    recoveryPolicy: "retry_safe",
    maxAttempts: 2
  });
}

test("Worker-to-Worker direct handoff transfers queued ownership without promoting either Worker to a Bot", async () => {
  const env = fixture();
  try {
    const run = createRun(env.teams);
    const source = createSource(env, run.id, "worker_source_a");
    const target = env.teams.createWorker({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_target_b",
      roleTitle: "Target Specialist",
      objective: "Finish the handed-off work item."
    }).worker;

    const requested = env.handoffs.request({
      runId: run.id,
      sourceOwnerId: source.worker.id,
      targetOwnerId: target.id,
      taskId: source.task.id,
      reason: "The target Worker has the right specialist role.",
      requiredConstraints: ["Preserve source evidence"]
    });
    const accepted = env.handoffs.accept(requested.handoff.id, target.id);

    assert.equal(accepted.task.payload.owner_id, target.id);
    assert.equal(accepted.task.payload.assignee_id, target.id);
    assert.equal(env.queue.getByItem(source.task.id)?.targetId, target.id);
    assert.equal(accepted.sourcePrincipal.payload.status, "canceled");
    assert.equal(accepted.targetPrincipal.payload.status, "ready");
    assert.equal(accepted.targetPrincipal.payload.task_id, source.task.id);
    assert.equal(env.gateway.getBot(source.worker.id), null);
    assert.equal(env.gateway.getBot(target.id), null);
    assert.notEqual(accepted.task.payload.lease_id, source.task.payload.lease_id);

    env.supervisor.start();
    await env.supervisor.waitForIdle();

    const task = env.store.getObject(source.task.id);
    const handoff = env.store.getObject(requested.handoff.id);
    const artifacts = env.store.listObjects("artifact", "ws_direct_handoff");
    assert.equal(task?.payload.status, "completed");
    assert.equal(task?.payload.assignee_id, target.id);
    assert.equal(task?.payload.owner_id, source.worker.id);
    assert.equal(handoff?.payload.status, "completed");
    assert.equal(env.store.getObject(target.id)?.payload.status, "completed");
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.payload.created_by, target.id);
    assert.equal((artifacts[0]?.payload.provenance as any)?.origin, "worker_generated");
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

test("Worker-to-durable-Bot handoff keeps the Bot durable while enforcing TeamRun scope and persisting aggregate usage", async () => {
  const env = fixture();
  try {
    const run = createRun(env.teams);
    const source = createSource(env, run.id, "worker_to_bot_source");
    const requested = env.handoffs.request({
      runId: run.id,
      sourceOwnerId: source.worker.id,
      targetOwnerId: "bot_specialist",
      taskId: source.task.id,
      reason: "A durable specialist should own the final stage.",
      returnPolicy: "stay_with_target"
    });
    env.handoffs.accept(requested.handoff.id, "bot_specialist");

    assert.ok((env.teams.getRun(run.id)?.payload.participant_ids as string[]).includes("bot_specialist"));
    assert.equal(env.queue.getByItem(source.task.id)?.targetId, "bot_specialist");
    assert.equal(env.gateway.getBot("bot_specialist")?.payload.kind, "durable");

    env.supervisor.start();
    await env.supervisor.waitForIdle();

    const task = env.store.getObject(source.task.id);
    const runAfter = env.teams.getRun(run.id);
    const artifact = env.store.listObjects("artifact", "ws_direct_handoff")[0];
    assert.equal(task?.payload.status, "completed");
    assert.equal(task?.payload.owner_id, "bot_specialist");
    assert.equal(env.store.getObject(requested.handoff.id)?.payload.status, "completed");
    assert.equal((runAfter?.payload.usage as any)?.actions, 1);
    assert.equal(artifact?.payload.created_by, "bot_specialist");
    assert.equal((artifact?.payload.provenance as any)?.origin, "bot_generated");
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

class OneActionRuntime implements RuntimeAdapter {
  readonly id = "handoff-one-action";
  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    return {
      summary: `Executed ${context.task.id}`,
      artifactKind: "handoff_budget_probe",
      output: { executed_by: context.principal.id },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 1 }
    };
  }
}

test("run-scoped durable Bot execution cannot bypass aggregate TeamRun budget", async () => {
  const env = fixture(new OneActionRuntime());
  try {
    const run = createRun(env.teams, { max_workers: 2, max_hops: 6, max_actions: 0 });
    const source = createSource(env, run.id, "worker_budget_source");
    const requested = env.handoffs.request({
      runId: run.id,
      sourceOwnerId: source.worker.id,
      targetOwnerId: "bot_specialist",
      taskId: source.task.id,
      reason: "Budget-bound Bot target test.",
      returnPolicy: "stay_with_target"
    });
    env.handoffs.accept(requested.handoff.id, "bot_specialist");

    env.supervisor.start();
    await env.supervisor.waitForIdle();

    const task = env.store.getObject(source.task.id);
    assert.equal(task?.payload.status, "failed");
    assert.match(String(task?.payload.failure_code), /^TEAM_RUN_/);
    assert.equal(env.teams.getRun(run.id)?.payload.status, "budget_exhausted");
    assert.equal(env.store.listObjects("artifact", "ws_direct_handoff").length, 0);
  } finally {
    await env.supervisor.stop();
    env.queue.close();
    env.store.close();
  }
});

test("direct handoff refuses claimed execution and preserves source Worker, target Worker, queue and lease state", () => {
  const env = fixture();
  try {
    const run = createRun(env.teams);
    const source = createSource(env, run.id, "worker_claim_source");
    const target = env.teams.createWorker({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_claim_target",
      roleTitle: "Target",
      objective: "Receive only movable work."
    }).worker;
    const requested = env.handoffs.request({
      runId: run.id,
      sourceOwnerId: source.worker.id,
      targetOwnerId: target.id,
      taskId: source.task.id,
      reason: "Claim-race test."
    });
    const oldLeaseId = String(source.task.payload.lease_id);
    const claimed = env.queue.claimNext(source.worker.id, "runner_claimed");
    assert.equal(claimed?.state, "claimed");

    assert.throws(() => env.handoffs.accept(requested.handoff.id, target.id), /execution is claimed/);
    assert.equal(env.store.getObject(requested.handoff.id)?.payload.status, "requested");
    assert.equal(env.store.getObject(source.worker.id)?.payload.status, "ready");
    assert.equal(env.store.getObject(target.id)?.payload.status, "created");
    assert.equal(env.store.getObject(source.task.id)?.payload.lease_id, oldLeaseId);
    assert.equal(env.queue.getByItem(source.task.id)?.targetId, source.worker.id);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("target Worker must belong to the same TeamRun and remain unbound", () => {
  const env = fixture();
  try {
    const runA = createRun(env.teams);
    const source = createSource(env, runA.id, "worker_cross_source");
    const runB = createRun(env.teams);
    const other = env.teams.createWorker({
      runId: runB.id,
      createdBy: "bot_leader",
      workerId: "worker_other_run",
      roleTitle: "Other Run Worker",
      objective: "Stay isolated from run A."
    }).worker;

    assert.throws(() => env.handoffs.request({
      runId: runA.id,
      sourceOwnerId: source.worker.id,
      targetOwnerId: other.id,
      taskId: source.task.id,
      reason: "Attempt cross-run transfer."
    }), /belongs to another Team Run/);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("direct handoff enforces combined delegation/handoff hop ceilings and recorded owner-loop history", () => {
  const env = fixture();
  try {
    const run = createRun(env.teams, { max_workers: 3, max_hops: 2, max_actions: 10 });
    const source = createSource(env, run.id, "worker_hop_source");
    const target = env.teams.createWorker({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_hop_target",
      roleTitle: "Hop Target",
      objective: "Receive only bounded ownership transfer."
    }).worker;
    const task = env.store.getObject(source.task.id);
    if (!task) throw new Error("Task missing");
    env.store.putObject("task", { ...task.payload, hop: 2, max_hops: 2 });

    assert.throws(() => env.handoffs.request({
      runId: run.id,
      sourceOwnerId: source.worker.id,
      targetOwnerId: target.id,
      taskId: source.task.id,
      reason: "Exceed handoff hop ceiling."
    }), /exceeds Task\/Run max_hops/);

    const latest = env.store.getObject(source.task.id);
    if (!latest) throw new Error("Task missing after hop test");
    env.store.putObject("task", {
      ...latest.payload,
      hop: 0,
      max_hops: 2,
      handoff_owner_history: [source.worker.id, target.id]
    });
    assert.throws(() => env.handoffs.request({
      runId: run.id,
      sourceOwnerId: source.worker.id,
      targetOwnerId: target.id,
      taskId: source.task.id,
      reason: "Attempt ownership loop."
    }), /loop detected/);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("canceling a direct-handoff TeamRun cancels a queued durable-Bot-owned Task and settles the Handoff", async () => {
  const env = fixture();
  try {
    const run = createRun(env.teams);
    const source = createSource(env, run.id, "worker_cancel_source");
    const requested = env.handoffs.request({
      runId: run.id,
      sourceOwnerId: source.worker.id,
      targetOwnerId: "bot_specialist",
      taskId: source.task.id,
      reason: "Transfer before whole-run cancellation.",
      returnPolicy: "stay_with_target"
    });
    env.handoffs.accept(requested.handoff.id, "bot_specialist");

    await env.handoffs.cancelRun(run.id, "bot_leader", "Stop direct handoff run");

    assert.equal(env.teams.getRun(run.id)?.payload.status, "canceled");
    assert.equal(env.store.getObject(source.task.id)?.payload.status, "canceled");
    assert.equal(env.queue.getByItem(source.task.id)?.state, "canceled");
    assert.equal(env.store.getObject(requested.handoff.id)?.payload.status, "canceled");
    assert.equal(env.store.listObjects("artifact", "ws_direct_handoff").length, 0);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("accepted Worker-to-Worker handoff survives database reopen, executes under the target Worker, and settles", async () => {
  const dbPath = `/tmp/aiverse-direct-handoff-${randomUUID()}.db`;
  let taskId = "";
  let handoffId = "";
  let targetId = "";

  {
    const env = fixture(new DeterministicRuntimeAdapter(), dbPath, true);
    const run = createRun(env.teams);
    const source = createSource(env, run.id, "worker_restart_source");
    const target = env.teams.createWorker({
      runId: run.id,
      createdBy: "bot_leader",
      workerId: "worker_restart_target",
      roleTitle: "Restart Target",
      objective: "Finish the transferred task after restart."
    }).worker;
    const requested = env.handoffs.request({
      runId: run.id,
      sourceOwnerId: source.worker.id,
      targetOwnerId: target.id,
      taskId: source.task.id,
      reason: "Persist ownership transfer before restart."
    });
    env.handoffs.accept(requested.handoff.id, target.id);
    taskId = source.task.id;
    handoffId = requested.handoff.id;
    targetId = target.id;
    env.queue.close();
    env.store.close();
  }

  {
    const env = fixture(new DeterministicRuntimeAdapter(), dbPath, false);
    env.supervisor.start();
    try {
      await env.supervisor.waitForIdle();
      const task = env.store.getObject(taskId);
      const artifact = env.store.listObjects("artifact", "ws_direct_handoff")[0];
      assert.equal(task?.payload.status, "completed");
      assert.equal(task?.payload.assignee_id, targetId);
      assert.equal(env.store.getObject(handoffId)?.payload.status, "completed");
      assert.equal(env.store.getObject(targetId)?.payload.status, "completed");
      assert.equal(artifact?.payload.created_by, targetId);
      assert.equal(env.queue.getByItem(taskId)?.state, "completed");
    } finally {
      await env.supervisor.stop();
      env.queue.close();
      env.store.close();
    }
  }
});
