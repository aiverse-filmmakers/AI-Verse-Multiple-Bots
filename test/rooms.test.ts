import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { RoomCoordinator } from "../src/rooms.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import { ExecutionSupervisor } from "../src/supervisor.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, name: string): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name,
    kind: "durable",
    status: "active",
    role: { title: name, mission: `Own ${name} work.` },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_room" },
    permissions: { policy_ref: "default-bot" },
    coordination: { default_mode: "direct" }
  };
}

test("Room mention schedules bounded Bot work and publishes the result back into the Room and Thread", async () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = new CoordinationGateway(store, queue);
  const rooms = new RoomCoordinator(store, gateway);
  gateway.createBot(bot("bot_research-lead", "Research Lead"));
  gateway.createBot(bot("bot_finance", "Finance Analyst"));

  const runner = new BotRunner(
    store,
    gateway,
    queue,
    new RuntimeRegistry().register(new DeterministicRuntimeAdapter())
  );
  const supervisor = new ExecutionSupervisor(gateway, queue, runner);
  supervisor.start();

  try {
    const room = rooms.createRoom({
      id: "room_product",
      name: "Product Council",
      workspaceId: "ws_room",
      memberIds: ["bot_research-lead", "bot_finance"],
      leaderId: "bot_research-lead",
      speakerPolicy: "selective",
      maxBotMessagesPerUserTurn: 3
    });

    const first = rooms.sendMessage({
      roomId: room.id,
      senderId: "operator_local",
      text: "@research-lead verify competitor pricing."
    });
    assert.deepEqual(first.mentions, ["bot_research-lead"]);
    assert.equal(first.scheduledTaskIds.length, 1);

    await supervisor.waitForIdle();
    const roomMessages = store.listObjects("message", "ws_room")
      .filter((message) => message.payload.room_id === room.id && !message.payload.thread_id);
    assert.equal(roomMessages.length, 2);
    const botReply = roomMessages.find((message) => message.payload.sender_id === "bot_research-lead");
    assert.ok(botReply);
    assert.equal(Array.isArray(botReply?.payload.artifact_refs), true);
    assert.equal((botReply?.payload.artifact_refs as string[]).length, 1);

    const thread = rooms.createThread(room.id, first.message.id, "operator_local");
    const threadMessage = rooms.sendMessage({
      roomId: room.id,
      threadId: thread.id,
      senderId: "operator_local",
      text: "@finance review the pricing implication."
    });
    assert.deepEqual(threadMessage.mentions, ["bot_finance"]);
    await supervisor.waitForIdle();

    const threadMessages = store.listObjects("message", "ws_room")
      .filter((message) => message.payload.thread_id === thread.id);
    assert.equal(threadMessages.length, 2);
    assert.ok(threadMessages.some((message) => message.payload.sender_id === "bot_finance"));

    const pass = rooms.pass(room.id, "bot_finance", "NO_ADDITIONAL_VALUE", thread.id);
    assert.equal(pass.event.type, "room.pass");

    const owned = rooms.setWorkOwner({
      roomId: room.id,
      actorId: "operator_local",
      workItemId: first.scheduledTaskIds[0] as string,
      ownerId: "bot_research-lead",
      collaboratorIds: ["bot_finance"]
    });
    assert.equal((owned.payload.active_work as any).owner_id, "bot_research-lead");
  } finally {
    await supervisor.stop();
    queue.close();
    store.close();
  }
});

test("Room membership and mention failures are visible and do not silently route work", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  const rooms = new RoomCoordinator(store, gateway);
  try {
    gateway.createBot(bot("bot_research-lead", "Research Lead"));
    const room = rooms.createRoom({
      id: "room_guarded",
      name: "Guarded Room",
      workspaceId: "ws_room",
      memberIds: ["bot_research-lead"]
    });

    assert.throws(() => rooms.sendMessage({
      roomId: room.id,
      senderId: "operator_local",
      text: "@missing-bot do this."
    }), /Unresolved Room mention/);

    assert.throws(() => gateway.publishRoomMessage({
      senderId: "bot_outsider",
      roomId: room.id,
      workspaceId: "ws_room",
      text: "I should not be here."
    }), /not a member/);

    const types = store.listEventsAfter(0, 100).map((entry) => entry.event.type);
    assert.ok(types.includes("room.unresolved_mention"));
  } finally {
    store.close();
  }
});
