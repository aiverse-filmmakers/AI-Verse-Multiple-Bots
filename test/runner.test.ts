import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: `Mission for ${id}` },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_test" },
    permissions: { policy_ref: "default-bot" },
    coordination: { default_mode: "direct" }
  };
}

test("delegated Task survives restart, executes, publishes an Artifact and notifies the creator", async () => {
  const dbPath = `/tmp/ai-verse-bots-${randomUUID()}.db`;
  let store = new CoordinationStore(dbPath);
  let queue = new ExecutionQueue(store.dbPath);
  let gateway = new CoordinationGateway(store, queue);

  gateway.createBot(bot("bot_a"));
  gateway.createBot(bot("bot_b"));
  const delegated = gateway.delegate({
    createdBy: "bot_a",
    assigneeId: "bot_b",
    workspaceId: "ws_test",
    rootObjectiveId: "obj_1",
    objective: "Verify competitor pricing",
    reason: "Specialist verification",
    requiredConstraints: ["Do not publish"]
  });
  assert.equal(queue.getByItem(delegated.task.id)?.state, "queued");
  queue.close();
  store.close();

  store = new CoordinationStore(dbPath);
  queue = new ExecutionQueue(store.dbPath);
  gateway = new CoordinationGateway(store, queue);
  const runner = new BotRunner(
    store,
    gateway,
    queue,
    new RuntimeRegistry().register(new DeterministicRuntimeAdapter()),
    "runner_test"
  );
  try {
    const result = await runner.runNext("bot_b");
    if (!result) throw new Error("expected execution result");
    assert.equal(result.status, "completed");
    assert.equal(result.task.payload.status, "completed");
    assert.equal(result.execution.state, "completed");
    assert.equal(result.execution.attempts, 1);
    assert.ok(result.artifact);
    assert.equal(result.artifact?.payload.task_id, result.task.id);

    const refs = result.task.payload.output_artifact_refs as string[];
    assert.equal(refs[0], result.artifact?.id);

    const mailbox = store.listMailbox("bot_a");
    assert.equal(mailbox.length, 1);
    const firstDelivery = mailbox[0];
    if (!firstDelivery) throw new Error("expected notification delivery");
    const notification = store.getObject(firstDelivery.messageId);
    assert.ok(notification);
    assert.match(String((notification?.payload.content as any[])[0]?.text), /completed/i);

    const eventTypes = store.listEventsAfter(0, 100).map((entry) => entry.event.type);
    assert.ok(eventTypes.includes("task.started"));
    assert.ok(eventTypes.includes("artifact.published"));
    assert.ok(eventTypes.includes("task.completed"));
  } finally {
    queue.close();
    store.close();
  }
});

test("expired capability lease fails before runtime execution and produces no Artifact", async () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = new CoordinationGateway(store, queue);
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b"));
    gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_test",
      rootObjectiveId: "obj_2",
      objective: "Stale task",
      reason: "Test lease enforcement",
      leaseExpiresAt: "2000-01-01T00:00:00.000Z"
    });
    const runner = new BotRunner(
      store,
      gateway,
      queue,
      new RuntimeRegistry().register(new DeterministicRuntimeAdapter())
    );
    const result = await runner.runNext("bot_b");
    if (!result) throw new Error("expected failed execution result");
    assert.equal(result.status, "failed");
    assert.equal(result.task.payload.status, "failed");
    assert.equal(store.listObjects("artifact").length, 0);
  } finally {
    queue.close();
    store.close();
  }
});
