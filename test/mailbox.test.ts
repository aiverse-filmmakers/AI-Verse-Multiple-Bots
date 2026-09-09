import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import test from "node:test";
import { CoordinationGateway } from "../src/gateway.js";
import { MailboxError } from "../src/mailbox.js";
import { CoordinationPolicy } from "../src/policy.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest, DeliveryState } from "../src/types.js";

function bot(id: string, peers: string[] = ["*"]): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: `Own ${id} work.` },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_mailbox" },
    permissions: { policy_ref: "mailbox-test", allowed_peers: peers },
    coordination: { default_mode: "direct" }
  };
}

function gatewayWithBots(store: CoordinationStore): CoordinationGateway {
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, undefined, policy);
  gateway.createBot(bot("bot_a", ["bot_b"]));
  gateway.createBot(bot("bot_b", ["bot_a"]));
  return gateway;
}

function mailboxCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof MailboxError && error.code === code;
}

test("retry-safe Bot send creates one message, delivery, event and wake", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = gatewayWithBots(store);
  let wakes = 0;
  const unsubscribe = gateway.subscribeMailboxWake("bot_b", (wake) => {
    wakes += 1;
    assert.equal(wake.recovered, false);
    assert.equal(wake.delivery.targetId, "bot_b");
  }, false);
  try {
    const input = {
      senderId: "bot_a",
      targetKind: "bot" as const,
      targetId: "bot_b",
      workspaceId: "ws_mailbox",
      text: "Check the launch assumptions.",
      idempotencyKey: "mailbox:retry-safe"
    };
    const first = gateway.sendMessage(input);
    const retry = gateway.sendMessage(input);
    assert.equal(retry.message.id, first.message.id);
    assert.equal(retry.delivery.id, first.delivery.id);
    assert.equal(retry.event.event.id, first.event.event.id);
    assert.equal(store.listObjects("message", "ws_mailbox").length, 1);
    assert.equal(gateway.mailbox.list("bot_b", ["queued"]).length, 1);
    assert.equal(store.listEventsAfter(0, 100).filter((item) => item.event.type === "message.queued").length, 1);
    assert.equal(wakes, 1);
    assert.throws(() => gateway.sendMessage({ ...input, text: "Different payload." }), mailboxCode("IDEMPOTENCY_CONFLICT"));
  } finally {
    unsubscribe();
    store.close();
  }
});

test("mailbox enforces ordered lifecycle, actors, reply evidence and terminal state", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = gatewayWithBots(store);
  try {
    const sent = gateway.sendMessage({
      senderId: "bot_a",
      targetKind: "bot",
      targetId: "bot_b",
      workspaceId: "ws_mailbox",
      text: "Review this result."
    });
    assert.throws(() => gateway.transitionMessageDelivery(sent.message.id, { state: "accepted", actorId: "bot_a" }), mailboxCode("DELIVERY_ACTOR_DENIED"));
    assert.equal(gateway.transitionMessageDelivery(sent.message.id, { state: "accepted", actorId: "bot_b" }).delivery.state, "accepted");
    assert.throws(() => gateway.transitionMessageDelivery(sent.message.id, { state: "processing", actorId: "bot_b" }), mailboxCode("INVALID_DELIVERY_TRANSITION"));
    assert.equal(gateway.transitionMessageDelivery(sent.message.id, { state: "delivered", actorId: "bot_b" }).delivery.state, "delivered");
    assert.equal(gateway.transitionMessageDelivery(sent.message.id, { state: "processing", actorId: "bot_b" }).delivery.state, "processing");
    assert.throws(() => gateway.transitionMessageDelivery(sent.message.id, { state: "replied", actorId: "bot_b" }), mailboxCode("REPLY_REQUIRED"));

    const reply = gateway.sendMessage({
      senderId: "bot_b",
      targetKind: "bot",
      targetId: "bot_a",
      workspaceId: "ws_mailbox",
      text: "Reviewed and verified."
    });
    const replied = gateway.transitionMessageDelivery(sent.message.id, {
      state: "replied",
      actorId: "bot_b",
      replyMessageId: reply.message.id
    });
    assert.equal(replied.delivery.state, "replied");
    assert.equal(replied.message.payload.reply_message_id, reply.message.id);
    assert.deepEqual(
      (replied.message.payload.delivery_history as Array<{ state: DeliveryState }>).map((item) => item.state),
      ["queued", "accepted", "delivered", "processing", "replied"]
    );
    assert.throws(() => gateway.transitionMessageDelivery(sent.message.id, { state: "canceled", actorId: "bot_a" }), mailboxCode("INVALID_DELIVERY_TRANSITION"));

    const chain = store.listCorrelationEvents(String(sent.message.payload.correlation_id), 0, 100)
      .filter((item) => String(item.event.message_id ?? "") === sent.message.id);
    assert.deepEqual(chain.map((item) => item.event.type), [
      "message.queued",
      "message.accepted",
      "message.delivered",
      "message.processing",
      "message.replied"
    ]);
    for (let i = 1; i < chain.length; i += 1) {
      assert.equal(chain[i]?.event.causation_id, chain[i - 1]?.event.id);
    }
  } finally {
    store.close();
  }
});

test("pending mailbox survives restart and replays wake hook without polling", () => {
  const dbPath = `/tmp/ai-verse-mailbox-${randomUUID()}.db`;
  let messageId = "";
  {
    const store = new CoordinationStore(dbPath);
    const gateway = gatewayWithBots(store);
    const sent = gateway.sendMessage({
      senderId: "bot_a",
      targetKind: "bot",
      targetId: "bot_b",
      workspaceId: "ws_mailbox",
      text: "Persist this inbox item.",
      idempotencyKey: "mailbox:restart"
    });
    messageId = sent.message.id;
    store.close();
  }

  {
    const store = new CoordinationStore(dbPath);
    const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
    const gateway = new CoordinationGateway(store, undefined, policy);
    let recovered = 0;
    const unsubscribe = gateway.subscribeMailboxWake("bot_b", (wake) => {
      recovered += 1;
      assert.equal(wake.recovered, true);
      assert.equal(wake.message.id, messageId);
    });
    try {
      assert.equal(recovered, 1);
      assert.equal(gateway.mailbox.getDelivery(messageId)?.state, "queued");
      const accepted = gateway.transitionMessageDelivery(messageId, { state: "accepted", actorId: "bot_b" });
      assert.equal(accepted.message.payload.delivery_state, "accepted");
    } finally {
      unsubscribe();
      store.close();
    }
  }

  {
    const store = new CoordinationStore(dbPath);
    try {
      assert.equal(store.getDelivery(messageId)?.state, "accepted");
      assert.equal(store.getObject(messageId)?.payload.delivery_state, "accepted");
    } finally {
      store.close();
    }
  }
});

test("expiry sweep expires due deliveries and leaves future mail queued", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = gatewayWithBots(store);
  try {
    const base = Date.now();
    const due = gateway.sendMessage({
      senderId: "bot_a",
      targetKind: "bot",
      targetId: "bot_b",
      workspaceId: "ws_mailbox",
      text: "Short lived",
      expiresAt: new Date(base + 1_000).toISOString()
    });
    const future = gateway.sendMessage({
      senderId: "bot_a",
      targetKind: "bot",
      targetId: "bot_b",
      workspaceId: "ws_mailbox",
      text: "Long lived",
      expiresAt: new Date(base + 60_000).toISOString()
    });
    assert.equal(gateway.sweepExpiredMessages(base + 2_000).length, 1);
    assert.equal(gateway.mailbox.getDelivery(due.message.id)?.state, "expired");
    assert.equal(gateway.mailbox.getDelivery(future.message.id)?.state, "queued");
    assert.throws(() => gateway.transitionMessageDelivery(due.message.id, { state: "accepted", actorId: "bot_b" }), mailboxCode("INVALID_DELIVERY_TRANSITION"));
  } finally {
    store.close();
  }
});

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

test("HTTP mailbox exposes inbox filtering and guarded delivery transitions", async () => {
  const service = createGatewayServer({ dbPath: `/tmp/ai-verse-mailbox-http-${randomUUID()}.db`, port: 0 });
  const address = await service.listen();
  try {
    service.gateway.createBot(bot("bot_a", ["bot_b"]));
    service.gateway.createBot(bot("bot_b", ["bot_a"]));
    const sent = await httpJson(address.port, "POST", "/v1/messages", {
      senderId: "bot_a",
      targetKind: "bot",
      targetId: "bot_b",
      workspaceId: "ws_mailbox",
      text: "HTTP mailbox",
      idempotencyKey: "mailbox:http"
    });
    assert.equal(sent.status, 202);
    const messageId = sent.body.message.id;

    const mailbox = await httpJson(address.port, "GET", "/v1/mailbox/bot_b?states=queued");
    assert.equal(mailbox.status, 200);
    assert.equal(mailbox.body.deliveries.length, 1);
    assert.equal(mailbox.body.deliveries[0].messageId, messageId);

    const accepted = await httpJson(address.port, "POST", `/v1/messages/${messageId}/delivery`, {
      actorId: "bot_b",
      state: "accepted"
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.delivery.state, "accepted");

    const delivery = await httpJson(address.port, "GET", `/v1/messages/${messageId}/delivery`);
    assert.equal(delivery.status, 200);
    assert.equal(delivery.body.state, "accepted");
  } finally {
    await service.close();
  }
});
