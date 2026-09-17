import assert from "node:assert/strict";
import test from "node:test";

import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy, PolicyError } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import {
  RuntimeRegistry,
  type RuntimeAdapter,
  type RuntimeExecutionContext,
  type RuntimeExecutionResult
} from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import { TeamRunManager } from "../src/team-run-manager.js";
import { TeamRunCoordinator } from "../src/team-runs.js";
import type { BotManifest, JsonObject } from "../src/types.js";

class WorkspaceIsolationRuntime implements RuntimeAdapter {
  readonly id = "wsa-2026-023-runtime";
  readonly cancelCalls: string[] = [];

  async execute(_context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    return {
      summary: "workspace isolation fixture",
      artifactKind: "fixture",
      output: { ok: true },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, actions: 1 }
    };
  }

  async cancel(taskId: string): Promise<void> {
    this.cancelCalls.push(taskId);
  }
}

function bot(id: string, workspaceId: string, runtimeAdapter: string): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: `Workspace isolation fixture for ${id}` },
    runtime: { adapter: runtimeAdapter },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: {
      policy_ref: "strict",
      allowed_peers: ["*"],
      allowed_tools: [],
      allowed_connections: [],
      can_create_workers: true
    },
    coordination: { default_mode: "direct" }
  };
}

function setup() {
  const runtime = new WorkspaceIsolationRuntime();
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  gateway.createBot(bot("bot_leader", "ws_worker_home", runtime.id));
  gateway.createBot(bot("bot_foreign", "ws_foreign", runtime.id));

  const teams = new TeamRunCoordinator(store);
  const runner = new BotRunner(
    store,
    gateway,
    queue,
    new RuntimeRegistry().register(runtime),
    "runner_wsa_2026_023",
    2,
    100
  );
  const manager = new TeamRunManager(teams, gateway, queue, runner);
  const run = teams.createRun({
    leaderId: "bot_leader",
    workspaceId: "ws_worker_home",
    rootObjectiveId: "objective_worker_scope",
    objective: "Keep the temporary Worker inside its canonical workspace.",
    topology: "manager",
    budget: { max_workers: 2, token_limit: 1000, max_actions: 10 }
  }).run;
  const managed = manager.createWorkerTask({
    runId: run.id,
    createdBy: "bot_leader",
    workerId: "worker_scoped",
    roleTitle: "Scoped Worker",
    objective: "Perform only the bound workspace task.",
    reason: "WSA-2026-023 regression fixture."
  });
  return { runtime, store, queue, gateway, teams, runner, run, managed };
}

function foreignTask(base: JsonObject, id: string): JsonObject {
  return {
    ...base,
    id,
    workspace_id: "ws_foreign",
    root_objective_id: "objective_foreign",
    status: "assigned"
  };
}

test("WSA-2026-023 rejects foreign-workspace generic delegation to an existing Worker before persistence", () => {
  const env = setup();
  try {
    assert.equal(env.teams.getWorker(env.managed.worker.id)?.payload.status, "ready");
    const taskCount = env.store.listObjects("task").length;
    const leaseCount = env.store.listObjects("capability_lease").length;

    assert.throws(() => env.gateway.delegate({
      createdBy: "bot_foreign",
      assigneeId: env.managed.worker.id,
      workspaceId: "ws_foreign",
      rootObjectiveId: "objective_foreign_delegate",
      objective: "Illegally target the foreign Worker.",
      reason: "Must fail before canonical state is created."
    }), (error: unknown) => error instanceof PolicyError && error.code === "WORKSPACE_DENIED");

    assert.equal(env.store.listObjects("task").length, taskCount);
    assert.equal(env.store.listObjects("capability_lease").length, leaseCount);
    assert.equal(env.teams.getWorker(env.managed.worker.id)?.payload.status, "ready");
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("WSA-2026-023 rejects direct Worker message delivery across workspace in both directions", () => {
  const env = setup();
  try {
    const messageCount = env.store.listObjects("message").length;
    const workerMailboxCount = env.store.listMailbox(env.managed.worker.id).length;
    const foreignMailboxCount = env.store.listMailbox("bot_foreign").length;

    assert.throws(() => env.gateway.sendMessage({
      senderId: "bot_foreign",
      targetKind: "worker",
      targetId: env.managed.worker.id,
      workspaceId: "ws_foreign",
      text: "Foreign workspace message to Worker"
    }), (error: unknown) => error instanceof PolicyError && error.code === "WORKSPACE_DENIED");

    assert.throws(() => env.gateway.sendMessage({
      senderId: env.managed.worker.id,
      targetKind: "bot",
      targetId: "bot_foreign",
      workspaceId: "ws_foreign",
      text: "Worker must not claim the foreign workspace"
    }), (error: unknown) => error instanceof PolicyError && error.code === "WORKSPACE_DENIED");

    assert.equal(env.store.listObjects("message").length, messageCount);
    assert.equal(env.store.listMailbox(env.managed.worker.id).length, workerMailboxCount);
    assert.equal(env.store.listMailbox("bot_foreign").length, foreignMailboxCount);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("WSA-2026-023 runner failure cannot mutate a Worker for a foreign-workspace Task", async () => {
  const env = setup();
  try {
    env.queue.cancelByItem(env.managed.task.id, "isolate adversarial foreign Task");
    const task = foreignTask(env.managed.task.payload, "task_foreign_failure");
    env.store.putObject("task", task);
    env.queue.enqueueTask("task_foreign_failure", env.managed.worker.id, "ws_foreign");

    const result = await env.runner.runNext(env.managed.worker.id);
    assert.equal(result?.status, "failed");
    assert.equal(env.store.getObject("task_foreign_failure")?.payload.status, "failed");
    assert.equal(env.teams.getWorker(env.managed.worker.id)?.payload.status, "ready");

    const workerEvents = env.store.listEventsAfter(0, 500)
      .filter((entry) => entry.event.type === "worker.status_changed" && entry.event.task_id === "task_foreign_failure");
    assert.equal(workerEvents.length, 0);
  } finally {
    env.queue.close();
    env.store.close();
  }
});

test("WSA-2026-023 cancellation cannot mutate or invoke a Worker runtime for an unbound foreign Task", async () => {
  const env = setup();
  try {
    const task = foreignTask(env.managed.task.payload, "task_foreign_cancel");
    env.store.putObject("task", task);

    const result = await env.runner.cancelTask(
      "task_foreign_cancel",
      "bot_leader",
      "Foreign Task must not control the Worker"
    );

    assert.equal(result.tasks.length, 1);
    assert.equal(env.store.getObject("task_foreign_cancel")?.payload.status, "canceled");
    assert.equal(env.teams.getWorker(env.managed.worker.id)?.payload.status, "ready");
    assert.deepEqual(env.runtime.cancelCalls, []);

    const workerEvents = env.store.listEventsAfter(0, 500)
      .filter((entry) => entry.event.type === "worker.status_changed" && entry.event.task_id === "task_foreign_cancel");
    assert.equal(workerEvents.length, 0);
  } finally {
    env.queue.close();
    env.store.close();
  }
});
