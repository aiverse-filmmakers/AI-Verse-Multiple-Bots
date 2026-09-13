import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANNEL_BRIDGE_PROVIDER,
  ChannelBridgeBoundary,
  ChannelBridgeError,
  channelActorId,
  normalizeDiscordMessage,
  parseChannelActorId
} from "../src/channel-bridge.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { RoomCoordinator } from "../src/rooms.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, workspaceId = "ws_channel"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: "Exercise channel bridge contracts." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

function telegramUpdate(messageId = 501) {
  return {
    update_id: 9001,
    message: {
      message_id: messageId,
      date: 1_800_000_000,
      chat: { id: 7001, type: "private" },
      from: { id: 3001, is_bot: false, first_name: "User" },
      text: "Please check this.",
      document: {
        file_id: "telegram-file-1",
        file_name: "brief.pdf",
        mime_type: "application/pdf",
        file_size: 1234
      }
    }
  };
}

test("Telegram ingress is verified, workspace-bound, attachment-aware and idempotent", () => {
  const store = new CoordinationStore(":memory:");
  try {
    const gateway = new CoordinationGateway(store, undefined, new CoordinationPolicy(store, { requireRegisteredBots: true }));
    const rooms = new RoomCoordinator(store, gateway);
    gateway.createBot(bot("bot_channel"));
    const bridge = new ChannelBridgeBoundary(gateway, rooms, store, [{
      id: "telegram_primary",
      provider: "telegram",
      accountId: "bot_account",
      conversationId: "7001",
      workspaceId: "ws_channel",
      targetKind: "bot",
      targetId: "bot_channel",
      allowedSenderExternalIds: ["3001"]
    }]);

    const first = bridge.ingestTelegram("bot_account", telegramUpdate(), true);
    const second = bridge.ingestTelegram("bot_account", telegramUpdate(), true);

    assert.equal(first.provider, CHANNEL_BRIDGE_PROVIDER);
    assert.equal(first.binding_id, "telegram_primary");
    assert.equal(first.target.kind, "bot");
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.canonical_message_id, first.canonical_message_id);
    assert.equal(second.event_sequence, first.event_sequence);
    assert.equal(store.listMailbox("bot_channel").length, 1);

    const stored = store.getObject(first.canonical_message_id);
    assert.equal(stored?.kind, "message");
    assert.equal(stored?.payload.provenance && (stored.payload.provenance as any).origin, "external_message");
    assert.equal(stored?.payload.provenance && (stored.payload.provenance as any).trusted_instruction, false);
    assert.equal((stored?.payload.content as any[]).some((part) => part.kind === "file_ref"), true);
    const event = store.listEventsAfter(0).find((candidate) => candidate.sequence === first.event_sequence);
    assert.equal(event?.event.message_id, first.canonical_message_id);
  } finally {
    store.close();
  }
});

test("unverified channel adapters and denied external senders fail closed", () => {
  const store = new CoordinationStore(":memory:");
  try {
    const gateway = new CoordinationGateway(store);
    const rooms = new RoomCoordinator(store, gateway);
    gateway.createBot(bot("bot_channel"));
    const bridge = new ChannelBridgeBoundary(gateway, rooms, store, [{
      id: "telegram_primary",
      provider: "telegram",
      accountId: "bot_account",
      conversationId: "7001",
      workspaceId: "ws_channel",
      targetKind: "bot",
      targetId: "bot_channel",
      allowedSenderExternalIds: ["9999"]
    }]);

    assert.throws(
      () => bridge.ingestTelegram("bot_account", telegramUpdate(), false),
      (error: unknown) => error instanceof ChannelBridgeError && error.code === "CHANNEL_ADAPTER_UNVERIFIED"
    );
    assert.throws(
      () => bridge.ingestTelegram("bot_account", telegramUpdate(), true),
      (error: unknown) => error instanceof ChannelBridgeError && error.code === "CHANNEL_SENDER_DENIED"
    );
    assert.equal(store.listMailbox("bot_channel").length, 0);
  } finally {
    store.close();
  }
});

test("Room channel ingress reuses Room coordination instead of creating channel orchestration", () => {
  const store = new CoordinationStore(":memory:");
  try {
    const gateway = new CoordinationGateway(store, undefined, new CoordinationPolicy(store, { requireRegisteredBots: true }));
    const rooms = new RoomCoordinator(store, gateway);
    gateway.createBot(bot("bot_room_lead"));
    gateway.createBot(bot("bot_room_peer"));
    rooms.createRoom({
      id: "room_channel",
      name: "Channel Room",
      workspaceId: "ws_channel",
      memberIds: ["bot_room_lead", "bot_room_peer"],
      leaderId: "bot_room_lead"
    });
    const bridge = new ChannelBridgeBoundary(gateway, rooms, store, [{
      id: "discord_room",
      provider: "discord",
      accountId: "discord_app",
      conversationId: "discord-channel-1",
      workspaceId: "ws_channel",
      targetKind: "room",
      targetId: "room_channel"
    }]);

    const result = bridge.ingestDiscord("discord_app", {
      id: "discord-message-1",
      channel_id: "discord-channel-1",
      timestamp: "2026-09-13T21:00:00.000Z",
      author: { id: "discord-user-1" },
      content: "Room request from Discord",
      attachments: []
    }, true);

    const stored = store.getObject(result.canonical_message_id);
    assert.equal(result.target.kind, "room");
    assert.equal(stored?.payload.room_id, "room_channel");
    assert.equal((stored?.payload.provenance as any).origin, "external_message");
    assert.ok(store.listRoomEvents("room_channel").some((entry) => entry.event.message_id === result.canonical_message_id));
  } finally {
    store.close();
  }
});

test("canonical Bot replies format to Telegram and receipts are idempotent", () => {
  const store = new CoordinationStore(":memory:");
  try {
    const gateway = new CoordinationGateway(store);
    const rooms = new RoomCoordinator(store, gateway);
    gateway.createBot(bot("bot_channel"));
    const bridge = new ChannelBridgeBoundary(gateway, rooms, store, [{
      id: "telegram_primary",
      provider: "telegram",
      accountId: "bot_account",
      conversationId: "7001",
      workspaceId: "ws_channel",
      targetKind: "bot",
      targetId: "bot_channel"
    }]);

    const inbound = bridge.ingestTelegram("bot_account", telegramUpdate(), true);
    const reply = gateway.sendMessage({
      senderId: "bot_channel",
      targetKind: "operator",
      targetId: inbound.actor_id,
      workspaceId: "ws_channel",
      text: "I checked it.",
      replyToMessageId: inbound.canonical_message_id
    });

    const egress = bridge.formatEgress("telegram_primary", reply.message.id);
    assert.equal(egress.channel_provider, "telegram");
    assert.equal(egress.external_recipient_id, "3001");
    assert.equal(egress.reply_to_external_message_id, "501");
    assert.equal(egress.text, "I checked it.");
    assert.equal(egress.transport_command.kind, "telegram.bot-api");
    assert.equal(egress.transport_command.method, "sendMessage");
    assert.equal(egress.transport_command.chat_id, "7001");
    assert.equal(egress.delivery_receipt_required, true);

    const receipt1 = bridge.acknowledgeEgress({
      bindingId: "telegram_primary",
      messageId: reply.message.id,
      status: "delivered",
      externalDeliveryId: "telegram-delivery-1"
    });
    const receipt2 = bridge.acknowledgeEgress({
      bindingId: "telegram_primary",
      messageId: reply.message.id,
      status: "delivered",
      externalDeliveryId: "telegram-delivery-1"
    });
    assert.equal(receipt2.event_sequence, receipt1.event_sequence);
    const event = store.listEventsAfter(0).find((candidate) => candidate.sequence === receipt1.event_sequence);
    assert.equal(event?.event.type, "channel.egress.delivered");
    assert.equal(event?.event.message_id, reply.message.id);
    assert.equal(event?.event.channel_binding_id, "telegram_primary");
  } finally {
    store.close();
  }
});

test("Discord normalization and channel actor identity round-trip without a second identity store", () => {
  const normalized = normalizeDiscordMessage("discord_app", {
    id: "m-1",
    channel_id: "c-1",
    timestamp: "2026-09-13T21:00:00.000Z",
    author: { id: "u:1" },
    content: "hello",
    attachments: [{
      id: "a-1",
      filename: "frame.png",
      content_type: "image/png",
      size: 44
    }]
  }, true);
  assert.equal(normalized.provider, "discord");
  assert.equal(normalized.attachments?.[0]?.kind, "image");

  const actorId = channelActorId("discord", "discord_app", "u:1");
  assert.deepEqual(parseChannelActorId(actorId), {
    provider: "discord",
    accountId: "discord_app",
    senderExternalId: "u:1"
  });
});
