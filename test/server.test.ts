import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { createGatewayServer } from "../src/server.js";

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


test("HTTP gateway exposes explicit task-to-user escalation without making approval-gated work executable", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  const address = await service.listen();
  try {
    assert.equal((await httpJson(address.port, "POST", "/v1/bots", manifest("bot_escalator", "Escalator"))).status, 201);
    assert.equal((await httpJson(address.port, "POST", "/v1/bots", manifest("bot_owner", "Owner"))).status, 201);

    const delegated = await httpJson(address.port, "POST", "/v1/delegations", {
      createdBy: "bot_owner",
      assigneeId: "bot_escalator",
      workspaceId: "ws_http",
      rootObjectiveId: "obj_http_escalation",
      objective: "Wait for a user decision",
      reason: "Explicit escalation acceptance",
      approval: { required: true, reason: "Do not execute before approval" }
    });
    assert.equal(delegated.status, 201);
    assert.equal(delegated.body.task.payload.status, "waiting_approval");
    assert.equal(service.executionQueue.getByItem(delegated.body.task.id), null);

    const escalated = await httpJson(address.port, "POST", `/v1/tasks/${delegated.body.task.id}/escalate`, {
      actorId: "bot_escalator",
      reason: "Please choose which approved direction to pursue."
    });
    assert.equal(escalated.status, 202);
    assert.equal(escalated.body.event.type, "user.escalation_requested");
    assert.equal(escalated.body.event.attention_state, "needs_input");
    assert.equal(service.executionQueue.getByItem(delegated.body.task.id), null);
  } finally {
    await service.close();
  }
});
