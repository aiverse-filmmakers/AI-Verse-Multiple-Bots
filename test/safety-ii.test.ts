import assert from "node:assert/strict";
import test from "node:test";
import { BudgetError } from "../src/budget.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationLoopError } from "../src/loop-guard.js";
import { CoordinationPolicy } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import { RuntimeRegistry, type RuntimeAdapter } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, adapter = "deterministic"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: `Mission for ${id}` },
    runtime: { adapter },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_safety" },
    permissions: { policy_ref: "strict", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

function strictGateway(store: CoordinationStore, queue?: ExecutionQueue): CoordinationGateway {
  return new CoordinationGateway(store, queue, new CoordinationPolicy(store, { requireRegisteredBots: true }));
}

test("child Tasks inherit tighter parent budgets and root task-count limits", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = strictGateway(store);
  try {
    for (const id of ["bot_a", "bot_b", "bot_c"]) gateway.createBot(bot(id));
    const root = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_budget",
      objective: "Own the initial research",
      reason: "budget root",
      budget: { token_limit: 1000, cost_limit: 1, max_hops: 4, max_tasks: 2, max_actions: 5 }
    });
    const child = gateway.delegate({
      createdBy: "bot_b",
      assigneeId: "bot_c",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_budget",
      parentTaskId: root.task.id,
      objective: "Check one specialist angle",
      reason: "bounded child",
      budget: { token_limit: 9000, cost_limit: 9, max_hops: 9, max_tasks: 9, max_actions: 9 }
    });

    const inherited = child.task.payload.budget as Record<string, number>;
    assert.equal(inherited.token_limit, 1000);
    assert.equal(inherited.cost_limit, 1);
    assert.equal(inherited.max_hops, 4);
    assert.equal(inherited.max_tasks, 2);
    assert.equal(inherited.max_actions, 5);
    assert.equal(child.task.payload.max_hops, 4);

    assert.throws(() => gateway.delegate({
      createdBy: "bot_c",
      assigneeId: "bot_a",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_budget",
      parentTaskId: child.task.id,
      objective: "Create a third task",
      reason: "must exceed root task budget"
    }), (error: unknown) => error instanceof BudgetError && error.code === "TASK_BUDGET_EXCEEDED");
  } finally {
    store.close();
  }
});

test("delegation lineage blocks Bot ping-pong before the third transition", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = strictGateway(store);
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b"));
    const first = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_loop",
      objective: "Research the issue",
      reason: "first pass"
    });
    const second = gateway.delegate({
      createdBy: "bot_b",
      assigneeId: "bot_a",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_loop",
      parentTaskId: first.task.id,
      objective: "Review the findings",
      reason: "review pass"
    });

    assert.throws(() => gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_loop",
      parentTaskId: second.task.id,
      objective: "Revise the findings again",
      reason: "would ping-pong"
    }), (error: unknown) => error instanceof CoordinationLoopError && error.code === "PING_PONG_DETECTED");
  } finally {
    store.close();
  }
});

test("runtime usage over budget fails before a successful Artifact is accepted", async () => {
  const highUsage: RuntimeAdapter = {
    id: "high-usage",
    async execute() {
      return {
        summary: "expensive result",
        artifactKind: "test",
        output: { result: "expensive" },
        usage: { input_tokens: 20, output_tokens: 20, cost: 2, actions: 4 }
      };
    }
  };
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = strictGateway(store, queue);
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b", "high-usage"));
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_usage",
      objective: "Do bounded work",
      reason: "budget test",
      budget: { token_limit: 10, cost_limit: 0.5, max_actions: 2 }
    });
    const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(highUsage));
    const result = await runner.runNext("bot_b");
    if (!result) throw new Error("expected execution result");
    assert.equal(result.status, "failed");
    assert.equal(result.task.payload.failure_code, "TOKEN_BUDGET_EXCEEDED");
    assert.equal(store.listObjects("artifact").length, 0);
    assert.equal(queue.getByItem(delegated.task.id)?.state, "failed");
    assert.ok(store.listEventsAfter(0, 100).some((entry) => entry.event.type === "task.budget_exceeded"));
  } finally {
    queue.close();
    store.close();
  }
});

test("repeated identical completed output eventually fails as no progress", async () => {
  const constant: RuntimeAdapter = {
    id: "constant",
    async execute() {
      return {
        summary: "same result",
        artifactKind: "test",
        output: { answer: "unchanged" },
        usage: { input_tokens: 1, output_tokens: 1, cost: 0, actions: 1 }
      };
    }
  };
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = strictGateway(store, queue);
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b", "constant"));
    const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(constant));

    for (let i = 0; i < 2; i += 1) {
      gateway.delegate({
        createdBy: "bot_a",
        assigneeId: "bot_b",
        workspaceId: "ws_safety",
        rootObjectiveId: "obj_stuck",
        objective: "Try to improve the same answer",
        reason: `attempt ${i + 1}`
      });
      const result = await runner.runNext("bot_b");
      assert.equal(result?.status, "completed");
    }

    gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_safety",
      rootObjectiveId: "obj_stuck",
      objective: "Try to improve the same answer",
      reason: "attempt 3"
    });
    const third = await runner.runNext("bot_b");
    assert.equal(third?.status, "failed");
    assert.equal(third?.task.payload.failure_code, "NO_PROGRESS_DETECTED");
    assert.equal(store.listObjects("artifact").length, 2);
    assert.ok(store.listEventsAfter(0, 200).some((entry) => entry.event.type === "task.no_progress"));
  } finally {
    queue.close();
    store.close();
  }
});
