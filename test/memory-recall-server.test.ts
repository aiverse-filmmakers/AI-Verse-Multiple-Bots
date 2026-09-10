import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { createGatewayServer } from "../src/server.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, workspaceId: string): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: `Mission for ${id}` },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: { policy_ref: "strict", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

function httpJson(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: { "content-type": "application/json" }
    }, (res: any) => {
      const chunks: string[] = [];
      res.on("data", (chunk: unknown) => chunks.push(String(chunk)));
      res.on("end", () => resolve({ status: Number(res.statusCode), body: JSON.parse(chunks.join("") || "{}") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test("HTTP delegation normalizes Memory recall before Task creation, rejects scope widening atomically, and ordinary execution survives no-Memory mode", async () => {
  const workspaceId = "ws_http_memory";
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  const address = await service.listen();
  await service.supervisor.stop();
  try {
    assert.equal((await httpJson(address.port, "POST", "/v1/bots", bot("bot_http_memory_a", workspaceId))).status, 201);
    assert.equal((await httpJson(address.port, "POST", "/v1/bots", bot("bot_http_memory_b", workspaceId))).status, 201);

    const delegated = await httpJson(address.port, "POST", "/v1/delegations", {
      createdBy: "bot_http_memory_a",
      assigneeId: "bot_http_memory_b",
      workspaceId,
      rootObjectiveId: "obj_http_memory",
      objective: "Use a relevant historical lesson",
      reason: "Explicit historical recall",
      memoryRecall: { query: "prior lesson", limit: 3 }
    });
    assert.equal(delegated.status, 201);
    assert.deepEqual(delegated.body.task.payload.memory_recall, {
      query: "prior lesson",
      limit: 3,
      include_history: false
    });
    assert.equal(service.store.listObjects("task", workspaceId).length, 1);

    const invalid = await httpJson(address.port, "POST", "/v1/delegations", {
      createdBy: "bot_http_memory_a",
      assigneeId: "bot_http_memory_b",
      workspaceId,
      rootObjectiveId: "obj_http_memory_invalid",
      objective: "Try to widen recall",
      reason: "Invalid boundary request",
      memoryRecall: { query: "everything", all_workspaces: true }
    });
    assert.equal(invalid.status, 400);
    assert.match(String(invalid.body.message), /cannot widen/i);
    assert.equal(service.store.listObjects("task", workspaceId).length, 1);

    const recallRun = await httpJson(address.port, "POST", "/v1/bots/bot_http_memory_b/run-next");
    assert.equal(recallRun.status, 200);
    assert.equal(recallRun.body.status, "failed");
    assert.match(String(recallRun.body.task.payload.failure_reason), /no Memory recall source is configured/i);
    assert.equal(service.store.listObjects("artifact", workspaceId).length, 0);

    const ordinary = await httpJson(address.port, "POST", "/v1/delegations", {
      createdBy: "bot_http_memory_a",
      assigneeId: "bot_http_memory_b",
      workspaceId,
      rootObjectiveId: "obj_http_memory_ordinary",
      objective: "Run without historical recall",
      reason: "No Memory dependency"
    });
    assert.equal(ordinary.status, 201);
    const ordinaryRun = await httpJson(address.port, "POST", "/v1/bots/bot_http_memory_b/run-next");
    assert.equal(ordinaryRun.status, 200);
    assert.equal(ordinaryRun.body.status, "completed");
    assert.equal(service.store.listObjects("artifact", workspaceId).length, 1);
  } finally {
    await service.close();
  }
});