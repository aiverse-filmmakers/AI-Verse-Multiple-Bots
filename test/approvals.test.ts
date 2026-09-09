import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "../src/runtime.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, workspaceId = "ws_approval"): BotManifest {
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

test("approval-required Task cannot execute before operator approval and runs after approval", async () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  const runner = new BotRunner(
    store,
    gateway,
    queue,
    new RuntimeRegistry().register(new DeterministicRuntimeAdapter())
  );

  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b"));
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_approval",
      rootObjectiveId: "obj_approval",
      objective: "Prepare and publish the approved action",
      reason: "External action requires operator approval",
      approval: {
        required: true,
        action: { kind: "publish.external", summary: "Publish approved result externally" },
        reason: "Publishing crosses an external-action boundary"
      }
    });

    assert.ok(delegated.approval);
    assert.equal(delegated.approval?.payload.status, "pending");
    assert.equal(delegated.task.payload.status, "waiting_approval");
    assert.equal(queue.getByItem(delegated.task.id), null);
    assert.equal(await runner.runNext("bot_b"), null);
    assert.equal(store.listObjects("artifact").length, 0);

    assert.throws(
      () => gateway.approve(delegated.approval?.id as string, "bot_a"),
      /Only an operator/
    );

    const decision = gateway.approve(delegated.approval?.id as string, "operator_local");
    assert.equal(decision.approval.payload.status, "approved");
    assert.equal(decision.task.payload.status, "assigned");
    assert.equal(queue.getByItem(delegated.task.id)?.state, "queued");

    const result = await runner.runNext("bot_b");
    assert.equal(result?.status, "completed");
    assert.equal(store.listObjects("artifact").length, 1);
  } finally {
    queue.close();
    store.close();
  }
});

test("denied approval cancels Task and can never produce an Artifact", async () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = new CoordinationGateway(store, queue, new CoordinationPolicy(store, { requireRegisteredBots: true }));
  const runner = new BotRunner(
    store,
    gateway,
    queue,
    new RuntimeRegistry().register(new DeterministicRuntimeAdapter())
  );

  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b"));
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_approval",
      rootObjectiveId: "obj_denied",
      objective: "Delete external content",
      reason: "Destructive action",
      approval: { required: true, action: { kind: "delete.external", summary: "Delete external content" } }
    });
    if (!delegated.approval) throw new Error("expected approval");

    const denied = gateway.rejectApproval(delegated.approval.id, "operator_local", "Do not delete this content");
    assert.equal(denied.approval.payload.status, "denied");
    assert.equal(denied.task.payload.status, "canceled");
    assert.equal(queue.getByItem(delegated.task.id), null);
    assert.equal(await runner.runNext("bot_b"), null);
    assert.equal(store.listObjects("artifact").length, 0);
  } finally {
    queue.close();
    store.close();
  }
});

test("HTTP approval queue exposes pending work and deny decision", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  const address = await service.listen();
  try {
    assert.equal((await httpJson(address.port, "POST", "/v1/bots", bot("bot_http_a", "ws_http_approval"))).status, 201);
    assert.equal((await httpJson(address.port, "POST", "/v1/bots", bot("bot_http_b", "ws_http_approval"))).status, 201);

    const delegated = await httpJson(address.port, "POST", "/v1/delegations", {
      createdBy: "bot_http_a",
      assigneeId: "bot_http_b",
      workspaceId: "ws_http_approval",
      rootObjectiveId: "obj_http_approval",
      objective: "Send an external message",
      reason: "External communication",
      approval: {
        required: true,
        action: { kind: "message.external", summary: "Send a customer-facing message" }
      }
    });
    assert.equal(delegated.status, 201);
    assert.equal(delegated.body.task.payload.status, "waiting_approval");
    assert.equal(delegated.body.approval.payload.status, "pending");

    const pending = await httpJson(address.port, "GET", "/v1/approvals?workspace=ws_http_approval&status=pending");
    assert.equal(pending.status, 200);
    assert.equal(pending.body.approvals.length, 1);

    const approvalId = delegated.body.approval.id as string;
    const denied = await httpJson(address.port, "POST", `/v1/approvals/${approvalId}/deny`, {
      actorId: "operator_local",
      reason: "Message needs revision"
    });
    assert.equal(denied.status, 200);
    assert.equal(denied.body.approval.payload.status, "denied");
    assert.equal(denied.body.task.payload.status, "canceled");
  } finally {
    await service.close();
  }
});
