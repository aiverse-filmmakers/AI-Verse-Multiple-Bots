import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import { ExecutionSupervisor } from "../src/supervisor.js";
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

test("supervisor wakes the assigned Bot from task.assigned without polling", async () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = new CoordinationGateway(store, queue);
  gateway.createBot(bot("bot_a"));
  gateway.createBot(bot("bot_b"));
  const runner = new BotRunner(
    store,
    gateway,
    queue,
    new RuntimeRegistry().register(new DeterministicRuntimeAdapter())
  );
  const supervisor = new ExecutionSupervisor(gateway, queue, runner);
  supervisor.start();
  try {
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_test",
      rootObjectiveId: "obj_auto",
      objective: "Run automatically",
      reason: "Prove event-driven wake-up"
    });
    await supervisor.waitForIdle();
    assert.equal(store.getObject(delegated.task.id)?.payload.status, "completed");
    assert.equal(queue.getByItem(delegated.task.id)?.state, "completed");
  } finally {
    await supervisor.stop();
    queue.close();
    store.close();
  }
});
