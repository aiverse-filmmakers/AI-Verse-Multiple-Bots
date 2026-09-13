import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import test from "node:test";
import { request } from "node:http";
import { createGatewayServer } from "../src/server.js";
import { initializeStandalone } from "../src/standalone-install.js";

function httpJson(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } }, (res: any) => {
      const chunks: string[] = [];
      res.on("data", (chunk: unknown) => chunks.push(String(chunk)));
      res.on("end", () => resolve({ status: Number(res.statusCode), body: JSON.parse(chunks.join("") || "{}") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function manifest(id: string, name: string) {
  return {
    schema_version: "1.0",
    id,
    name,
    kind: "durable",
    status: "active",
    role: { title: name, mission: "Exercise the HTTP contract." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_http" },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

test("HTTP gateway exposes strict Bot messaging, Room replay and global event replay", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  const address = await service.listen();
  try {
    const health = await httpJson(address.port, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    assert.equal((await httpJson(address.port, "POST", "/v1/bots", manifest("bot_http", "HTTP Bot"))).status, 201);
    assert.equal((await httpJson(address.port, "POST", "/v1/bots", manifest("bot_target", "Target Bot"))).status, 201);
    const bots = await httpJson(address.port, "GET", "/v1/bots?workspace=ws_http");
    assert.equal(bots.body.bots.length, 2);

    const sent = await httpJson(address.port, "POST", "/v1/messages", {
      senderId: "bot_http",
      targetKind: "bot",
      targetId: "bot_target",
      workspaceId: "ws_http",
      text: "hello"
    });
    assert.equal(sent.status, 202);
    const mailbox = await httpJson(address.port, "GET", "/v1/mailbox/bot_target");
    assert.equal(mailbox.body.deliveries.length, 1);

    const denied = await httpJson(address.port, "POST", "/v1/messages", {
      senderId: "bot_http",
      targetKind: "bot",
      targetId: "bot_unregistered",
      workspaceId: "ws_http",
      text: "this must be rejected"
    });
    assert.equal(denied.status, 400);

    const room = await httpJson(address.port, "POST", "/v1/rooms", {
      id: "room_http",
      name: "HTTP Room",
      workspaceId: "ws_http",
      memberIds: ["bot_http", "bot_target"],
      leaderId: "bot_http"
    });
    assert.equal(room.status, 201);

    const roomMessage = await httpJson(address.port, "POST", "/v1/rooms/room_http/messages", {
      senderId: "operator_local",
      text: "record this without activating speakers",
      activateSpeakers: false
    });
    assert.equal(roomMessage.status, 202);

    const roomEvents = await httpJson(address.port, "GET", "/v1/rooms/room_http/events?after=0");
    assert.equal(roomEvents.status, 200);
    assert.ok(roomEvents.body.events.length >= 2);
    assert.ok(roomEvents.body.events.every((event: any) => event.event.room_id === "room_http"));

    const events = await httpJson(address.port, "GET", "/v1/events?after=0");
    assert.ok(events.body.events.length >= 5);
  } finally {
    await service.close();
  }
});


test("Phase 5.6 live Gateway exposes production readiness without replacing legacy health", async () => {
  const root = `/tmp/multiple-bots-readiness-server-${randomUUID()}`;
  mkdirSync(root, { recursive: true });
  const installation = initializeStandalone(root, { port: 0 });
  const service = createGatewayServer({
    dbPath: installation.dbPath,
    port: 0,
    standaloneRoot: root
  });
  const address = await service.listen();
  try {
    const legacy = await httpJson(address.port, "GET", "/health");
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.ok, true);

    const readiness = await httpJson(address.port, "GET", "/v1/health/readiness");
    assert.equal(readiness.status, 200);
    assert.equal(readiness.body.provider, "ai-verse-multiple-bots/production-health-v1");
    assert.equal(readiness.body.mode, "standalone");
    assert.equal(readiness.body.state, "ready");
    assert.equal(readiness.body.ready, true);
    assert.equal(readiness.body.read_only, true);
    assert.deepEqual(readiness.body.checked_depths, [
      "structural",
      "attachment",
      "runtime",
      "dependency",
      "operational"
    ]);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("Phase 5.10 Gateway exposes bounded channel ingress, egress formatting and receipts", async () => {
  const service = createGatewayServer({
    dbPath: ":memory:",
    port: 0,
    channelBindings: [{
      id: "telegram_http",
      provider: "telegram",
      accountId: "http_bot",
      conversationId: "8801",
      workspaceId: "ws_http",
      targetKind: "bot",
      targetId: "bot_http_channel",
      allowedSenderExternalIds: ["4401"]
    }]
  });
  service.gateway.createBot(manifest("bot_http_channel", "HTTP Channel Bot"));
  const address = await service.listen();
  try {
    const capabilities = await httpJson(address.port, "GET", "/v1/channels/capabilities");
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.body.provider, "ai-verse-multiple-bots/channel-bridge-v1");
    assert.equal(capabilities.body.channel_owns_truth, false);
    assert.equal(capabilities.body.bindings[0].id, "telegram_http");

    const rawUpdate = {
      update_id: 991,
      message: {
        message_id: 551,
        date: 1_800_000_000,
        chat: { id: 8801 },
        from: { id: 4401 },
        text: "Hello over Telegram"
      }
    };

    const unverified = await httpJson(address.port, "POST", "/v1/channels/telegram/ingress", {
      accountId: "http_bot",
      adapterVerified: false,
      update: rawUpdate
    });
    assert.equal(unverified.status, 403);
    assert.equal(unverified.body.error, "CHANNEL_ADAPTER_UNVERIFIED");

    const ingress = await httpJson(address.port, "POST", "/v1/channels/telegram/ingress", {
      accountId: "http_bot",
      adapterVerified: true,
      update: rawUpdate
    });
    assert.equal(ingress.status, 202);
    assert.equal(ingress.body.binding_id, "telegram_http");
    assert.equal(ingress.body.target.id, "bot_http_channel");

    const reply = service.gateway.sendMessage({
      senderId: "bot_http_channel",
      targetKind: "operator",
      targetId: ingress.body.actor_id,
      workspaceId: "ws_http",
      text: "Reply from the canonical Bot",
      replyToMessageId: ingress.body.canonical_message_id
    });

    const egress = await httpJson(address.port, "POST", "/v1/channels/egress", {
      bindingId: "telegram_http",
      messageId: reply.message.id
    });
    assert.equal(egress.status, 200);
    assert.equal(egress.body.external_recipient_id, "4401");
    assert.equal(egress.body.reply_to_external_message_id, "551");
    assert.equal(egress.body.transport_command.method, "sendMessage");

    const receipt = await httpJson(address.port, "POST", "/v1/channels/egress/receipt", {
      bindingId: "telegram_http",
      messageId: reply.message.id,
      status: "delivered",
      externalDeliveryId: "tg-http-delivery"
    });
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.status, "delivered");
  } finally {
    await service.close();
  }
});
