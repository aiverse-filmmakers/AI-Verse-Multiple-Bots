import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import test from "node:test";
import { CoordinationGateway } from "../src/gateway.js";
import { RoomCoordinator } from "../src/rooms.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, workspaceId = "ws_idem"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: "Exercise whole-mutation idempotency." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

test("Phase 5.14 direct-message idempotency replays one durable Message, delivery and Event across restart", () => {
  const db = `/tmp/ai-verse-message-idempotency-${randomUUID()}.db`;
  let firstMessageId = "";
  let firstDeliveryId = "";
  let firstSequence = 0;

  try {
    {
      const store = new CoordinationStore(db);
      const gateway = new CoordinationGateway(store);
      gateway.createBot(bot("bot_sender"));
      gateway.createBot(bot("bot_target"));

      const first = gateway.sendMessage({
        senderId: "bot_sender",
        targetKind: "bot",
        targetId: "bot_target",
        workspaceId: "ws_idem",
        text: "One logical message",
        idempotencyKey: "direct-idempotency-key"
      });
      assert.equal(first.replayed, false);
      firstMessageId = first.message.id;
      firstDeliveryId = first.delivery.id;
      firstSequence = first.event.sequence;
      assert.equal(store.listObjects("message", "ws_idem").length, 1);
      assert.equal(store.listMailbox("bot_target").length, 1);
      assert.equal(
        store.listEventsAfter(0, 100).filter((entry) => entry.event.type === "message.queued").length,
        1
      );
      store.close();
    }

    {
      const store = new CoordinationStore(db);
      const gateway = new CoordinationGateway(store);
      const replay = gateway.sendMessage({
        senderId: "bot_sender",
        targetKind: "bot",
        targetId: "bot_target",
        workspaceId: "ws_idem",
        text: "One logical message",
        idempotencyKey: "direct-idempotency-key"
      });

      assert.equal(replay.replayed, true);
      assert.equal(replay.message.id, firstMessageId);
      assert.equal(replay.delivery.id, firstDeliveryId);
      assert.equal(replay.event.sequence, firstSequence);
      assert.equal(store.listObjects("message", "ws_idem").length, 1);
      assert.equal(store.listMailbox("bot_target").length, 1);
      assert.equal(
        store.listEventsAfter(0, 100).filter((entry) => entry.event.type === "message.queued").length,
        1
      );

      assert.throws(
        () => gateway.sendMessage({
          senderId: "bot_sender",
          targetKind: "bot",
          targetId: "bot_target",
          workspaceId: "ws_idem",
          text: "Changed semantic payload",
          idempotencyKey: "direct-idempotency-key"
        }),
        /reused with different message semantics/
      );
      assert.equal(store.listObjects("message", "ws_idem").length, 1);
      assert.equal(store.listMailbox("bot_target").length, 1);
      assert.equal(
        store.listEventsAfter(0, 100).filter((entry) => entry.event.type === "message.queued").length,
        1
      );
      store.close();
    }
  } finally {
    rmSync(db, { force: true });
    rmSync(`${db}-shm`, { force: true });
    rmSync(`${db}-wal`, { force: true });
  }
});

test("Phase 5.14 an idempotency key cannot be rebound to another explicit Message identity", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  try {
    gateway.createBot(bot("bot_sender"));
    gateway.createBot(bot("bot_target"));

    const first = gateway.sendMessage({
      senderId: "bot_sender",
      targetKind: "bot",
      targetId: "bot_target",
      workspaceId: "ws_idem",
      text: "Pinned identity",
      messageId: "msg_pinned_one",
      idempotencyKey: "pinned-key"
    });
    assert.equal(first.message.id, "msg_pinned_one");

    assert.throws(
      () => gateway.sendMessage({
        senderId: "bot_sender",
        targetKind: "bot",
        targetId: "bot_target",
        workspaceId: "ws_idem",
        text: "Pinned identity",
        messageId: "msg_pinned_two",
        idempotencyKey: "pinned-key"
      }),
      /reused with different message semantics/
    );
    assert.equal(store.getObject("msg_pinned_two"), null);
    assert.equal(store.listObjects("message", "ws_idem").length, 1);
  } finally {
    store.close();
  }
});

test("Phase 5.14 Room idempotency never schedules a second Bot Task on replay", () => {
  const db = `/tmp/ai-verse-room-idempotency-${randomUUID()}.db`;
  let firstMessageId = "";
  let firstSequence = 0;
  let firstTaskId = "";
  let firstCorrelation = "";

  try {
    {
      const store = new CoordinationStore(db);
      const gateway = new CoordinationGateway(store);
      const rooms = new RoomCoordinator(store, gateway);
      gateway.createBot(bot("bot_room_lead"));
      const room = rooms.createRoom({
        id: "room_idem",
        name: "Idempotency Room",
        workspaceId: "ws_idem",
        memberIds: ["bot_room_lead"],
        leaderId: "bot_room_lead",
        speakerPolicy: "selective"
      });

      const first = rooms.sendMessage({
        roomId: room.id,
        senderId: "operator_local",
        text: "@bot_room_lead do this once",
        idempotencyKey: "room-idempotency-key"
      });
      assert.equal(first.replayed, false);
      assert.equal(first.scheduledTaskIds.length, 1);
      firstTaskId = first.scheduledTaskIds[0] as string;
      firstMessageId = first.message.id;
      firstSequence = first.event.sequence;
      firstCorrelation = first.correlationId;
      assert.match(firstCorrelation, /^corr_idem_/);
      assert.equal(store.listObjects("task", "ws_idem").length, 1);
      store.close();
    }

    {
      const store = new CoordinationStore(db);
      const gateway = new CoordinationGateway(store);
      const rooms = new RoomCoordinator(store, gateway);

      const replay = rooms.sendMessage({
        roomId: "room_idem",
        senderId: "operator_local",
        text: "@bot_room_lead do this once",
        idempotencyKey: "room-idempotency-key"
      });

      assert.equal(replay.replayed, true);
      assert.equal(replay.message.id, firstMessageId);
      assert.equal(replay.event.sequence, firstSequence);
      assert.equal(replay.correlationId, firstCorrelation);
      assert.deepEqual(replay.scheduledTaskIds, []);
      assert.equal(store.listObjects("task", "ws_idem").length, 1);
      assert.equal(store.getObject(firstTaskId)?.kind, "task");
      assert.equal(
        store.listRoomEvents("room_idem", 0, 100)
          .filter((entry) => entry.event.type === "room.message").length,
        1
      );
      assert.equal(
        store.listRoomEvents("room_idem", 0, 100)
          .filter((entry) => entry.event.type === "room.round_scheduled").length,
        1
      );

      assert.throws(
        () => rooms.sendMessage({
          roomId: "room_idem",
          senderId: "operator_local",
          text: "@bot_room_lead changed work",
          idempotencyKey: "room-idempotency-key"
        }),
        /reused with different message semantics/
      );
      assert.equal(store.listObjects("task", "ws_idem").length, 1);
      assert.equal(store.listObjects("message", "ws_idem").length, 1);
      store.close();
    }
  } finally {
    rmSync(db, { force: true });
    rmSync(`${db}-shm`, { force: true });
    rmSync(`${db}-wal`, { force: true });
  }
});


test("Phase 5.14 legacy alpha event-only idempotency keys fail closed instead of duplicating messages", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  try {
    gateway.createBot(bot("bot_sender"));
    gateway.createBot(bot("bot_target"));

    gateway.emit({
      type: "message.queued",
      actorId: "bot_sender",
      workspaceId: "ws_idem",
      messageId: "msg_legacy_alpha",
      summary: "Legacy event-only idempotency evidence",
      idempotencyKey: "legacy-alpha-key"
    });

    const beforeMessages = store.listObjects("message", "ws_idem").length;
    const beforeEvents = store.listEventsAfter(0, 100).length;

    assert.throws(
      () => gateway.sendMessage({
        senderId: "bot_sender",
        targetKind: "bot",
        targetId: "bot_target",
        workspaceId: "ws_idem",
        text: "Do not duplicate under an unverifiable legacy key",
        idempotencyKey: "legacy-alpha-key"
      }),
      /belongs to appendEvent, not sendMessage/
    );

    assert.equal(store.listObjects("message", "ws_idem").length, beforeMessages);
    assert.equal(store.listEventsAfter(0, 100).length, beforeEvents);
    assert.equal(store.listMailbox("bot_target").length, 0);
  } finally {
    store.close();
  }
});
