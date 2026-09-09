import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { BotRunner } from "../src/runner.js";
import { RuntimeRegistry, type RuntimeAdapter, type RuntimeExecutionContext } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, adapter = "blocking"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: `Mission for ${id}` },
    runtime: { adapter },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_cancel" },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

class BlockingRuntime implements RuntimeAdapter {
  readonly id = "blocking";
  cancelCalls = 0;

  async execute(context: RuntimeExecutionContext) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      const onAbort = () => {
        clearTimeout(timer);
        reject(context.signal.reason ?? new Error("aborted"));
      };
      if (context.signal.aborted) onAbort();
      else context.signal.addEventListener("abort", onAbort, { once: true });
    });
    return {
      summary: "blocking runtime finished",
      artifactKind: "blocking_result",
      output: { ok: true }
    };
  }

  async cancel(_taskId: string): Promise<void> {
    this.cancelCalls += 1;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

test("explicit cancellation aborts a running Task and publishes no Artifact", async () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = new CoordinationGateway(store, queue);
  const adapter = new BlockingRuntime();
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(adapter));
  try {
    gateway.createBot(bot("bot_owner"));
    gateway.createBot(bot("bot_worker"));
    const delegated = gateway.delegate({
      createdBy: "bot_owner",
      assigneeId: "bot_worker",
      workspaceId: "ws_cancel",
      rootObjectiveId: "obj_cancel",
      objective: "Long running work",
      reason: "Cancellation test"
    });

    const execution = runner.runNext("bot_worker");
    await waitFor(() => store.getObject(delegated.task.id)?.payload.status === "running");
    const canceled = await runner.cancelTask(delegated.task.id, "operator_local", "Stop now");
    const result = await execution;

    assert.equal(canceled.tasks.length, 1);
    assert.equal(result?.status, "canceled");
    assert.equal(store.getObject(delegated.task.id)?.payload.status, "canceled");
    assert.equal(queue.getByItem(delegated.task.id)?.state, "canceled");
    assert.equal(store.listObjects("artifact").length, 0);
    assert.ok(adapter.cancelCalls >= 1);
  } finally {
    queue.close();
    store.close();
  }
});

test("execution deadline cancels the runtime and records deadline evidence", async () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = new CoordinationGateway(store, queue);
  const adapter = new BlockingRuntime();
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry().register(adapter));
  try {
    gateway.createBot(bot("bot_owner"));
    gateway.createBot(bot("bot_worker"));
    const delegated = gateway.delegate({
      createdBy: "bot_owner",
      assigneeId: "bot_worker",
      workspaceId: "ws_cancel",
      rootObjectiveId: "obj_deadline",
      objective: "Work before deadline",
      reason: "Deadline test",
      deadlineAt: new Date(Date.now() + 40).toISOString()
    });

    const result = await runner.runNext("bot_worker");
    assert.equal(result?.status, "canceled");
    assert.equal(store.getObject(delegated.task.id)?.payload.cancellation_code, "DEADLINE_EXCEEDED");
    assert.equal(queue.getByItem(delegated.task.id)?.state, "canceled");
    assert.equal(store.listObjects("artifact").length, 0);
    assert.ok(adapter.cancelCalls >= 1);
    const eventTypes = store.listEventsAfter(0, 100).map((entry) => entry.event.type);
    assert.ok(eventTypes.includes("task.deadline_exceeded"));
    assert.ok(eventTypes.includes("task.canceled"));
  } finally {
    queue.close();
    store.close();
  }
});

test("canceling a parent Task propagates to active child Tasks", async () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = new CoordinationGateway(store, queue);
  const runner = new BotRunner(store, gateway, queue, new RuntimeRegistry());
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b"));
    const parent = gateway.delegate({
      createdBy: "operator_local",
      assigneeId: "bot_a",
      workspaceId: "ws_cancel",
      rootObjectiveId: "obj_tree",
      objective: "Own root work",
      reason: "Parent"
    });
    const child = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_cancel",
      rootObjectiveId: "obj_tree",
      objective: "Do child work",
      reason: "Child",
      parentTaskId: parent.task.id
    });

    const canceled = await runner.cancelTask(parent.task.id, "operator_local", "Cancel root objective");
    assert.equal(canceled.tasks.length, 2);
    assert.equal(store.getObject(parent.task.id)?.payload.status, "canceled");
    assert.equal(store.getObject(child.task.id)?.payload.status, "canceled");
    assert.equal(queue.getByItem(parent.task.id)?.state, "canceled");
    assert.equal(queue.getByItem(child.task.id)?.state, "canceled");
  } finally {
    queue.close();
    store.close();
  }
});
