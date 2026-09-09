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

test("HTTP gateway exposes health, Bot registry, messaging, mailbox and event replay", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  const address = await service.listen();
  try {
    const health = await httpJson(address.port, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const manifest = {
      schema_version: "1.0",
      id: "bot_http",
      name: "HTTP Bot",
      kind: "durable",
      status: "active",
      role: { title: "HTTP Bot", mission: "Exercise the HTTP contract." },
      runtime: { adapter: "native" },
      execution: { environment_policy: "shared_workspace" },
      scope: { type: "workspace", workspace_id: "ws_http" },
      permissions: { policy_ref: "default-bot" },
      coordination: { default_mode: "direct" }
    };
    assert.equal((await httpJson(address.port, "POST", "/v1/bots", manifest)).status, 201);
    const bots = await httpJson(address.port, "GET", "/v1/bots?workspace=ws_http");
    assert.equal(bots.body.bots.length, 1);

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
    const events = await httpJson(address.port, "GET", "/v1/events?after=0");
    assert.ok(events.body.events.length >= 2);
  } finally {
    await service.close();
  }
});
