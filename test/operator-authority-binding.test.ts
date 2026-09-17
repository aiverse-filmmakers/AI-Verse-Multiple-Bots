import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";

import {
  bindGatewayOperatorSession,
  resolveGatewayBearerAuth
} from "../src/gateway-security.js";
import { createGatewayServer } from "../src/server.js";
import type { BotManifest } from "../src/types.js";

const TOKEN = "wsa-2026-022-transport-token-abcdefghijklmnopqrstuvwxyz";
const ENV_NAME = "AI_VERSE_WSA_022_TEST_TOKEN";

function bot(id: string, workspaceId = "ws_authority"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: `Authority regression fixture for ${id}` },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: { policy_ref: "strict", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

function httpJson(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token = TOKEN
): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    };
    const req = request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers
    }, (res: any) => {
      const chunks: string[] = [];
      res.on("data", (chunk: unknown) => chunks.push(String(chunk)));
      res.on("end", () => resolvePromise({
        status: Number(res.statusCode ?? 0),
        body: JSON.parse(chunks.join("") || "{}")
      }));
    });
    req.on("error", rejectPromise);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function transportAuth() {
  return resolveGatewayBearerAuth(ENV_NAME, { [ENV_NAME]: TOKEN });
}

test("WSA-2026-022 bearer transport reaches the Gateway but cannot perform Bot lifecycle mutation", async () => {
  const service = createGatewayServer({
    dbPath: ":memory:",
    port: 0,
    inboundAuth: transportAuth()
  });
  service.gateway.createBot(bot("bot_transport_only"));
  const address = await service.listen();
  try {
    const health = await httpJson(address.port, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);

    const denied = await httpJson(
      address.port,
      "POST",
      "/v1/bots/bot_transport_only/disable",
      { actorId: "operator_claimed" }
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error, "OPERATOR_AUTHORITY_REQUIRED");
    assert.equal(service.store.getObject("bot_transport_only")?.payload.status, "active");
  } finally {
    await service.close();
  }
});

test("WSA-2026-022 host-bound authenticated operator session can perform operator mutation", async () => {
  const service = createGatewayServer({
    dbPath: ":memory:",
    port: 0,
    inboundAuth: bindGatewayOperatorSession(transportAuth(), "operator_authenticated")
  });
  service.gateway.createBot(bot("bot_bound_operator"));
  const address = await service.listen();
  try {
    const changed = await httpJson(
      address.port,
      "POST",
      "/v1/bots/bot_bound_operator/disable",
      { actorId: "operator_authenticated" }
    );
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.payload.status, "disabled");
    assert.equal(service.store.getObject("bot_bound_operator")?.payload.status, "disabled");
  } finally {
    await service.close();
  }
});

test("WSA-2026-022 bearer transport cannot approve pending work by claiming operator provenance", async () => {
  const service = createGatewayServer({
    dbPath: ":memory:",
    port: 0,
    inboundAuth: transportAuth()
  });
  service.gateway.createBot(bot("bot_approval_source"));
  service.gateway.createBot(bot("bot_approval_target"));
  const delegated = service.gateway.delegate({
    createdBy: "bot_approval_source",
    assigneeId: "bot_approval_target",
    workspaceId: "ws_authority",
    rootObjectiveId: "objective_authority_approval",
    objective: "Prepare an externally gated action",
    reason: "Approval authority regression",
    approval: {
      required: true,
      action: { kind: "publish.external", summary: "Publish externally" }
    }
  });
  if (!delegated.approval) throw new Error("Expected pending approval");

  const address = await service.listen();
  try {
    const denied = await httpJson(
      address.port,
      "POST",
      `/v1/approvals/${delegated.approval.id}/approve`,
      { actorId: "operator_claimed" }
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error, "OPERATOR_AUTHORITY_REQUIRED");
    assert.equal(service.store.getObject(delegated.approval.id)?.payload.status, "pending");
    assert.equal(service.store.getObject(delegated.task.id)?.payload.status, "waiting_approval");
  } finally {
    await service.close();
  }
});

test("WSA-2026-022 bearer transport cannot cancel a Task by impersonating its canonical owner", async () => {
  const service = createGatewayServer({
    dbPath: ":memory:",
    port: 0,
    inboundAuth: transportAuth()
  });
  service.gateway.createBot(bot("bot_cancel_source"));
  service.gateway.createBot(bot("bot_cancel_target"));
  const delegated = service.gateway.delegate({
    createdBy: "bot_cancel_source",
    assigneeId: "bot_cancel_target",
    workspaceId: "ws_authority",
    rootObjectiveId: "objective_authority_cancel",
    objective: "Remain approval-gated until trusted control arrives",
    reason: "Cancellation authority regression",
    approval: {
      required: true,
      action: { kind: "publish.external", summary: "Hold Task for cancellation authority test" }
    }
  });
  if (!delegated.approval) throw new Error("Expected pending approval");

  const address = await service.listen();
  try {
    assert.equal(service.executionQueue.getByItem(delegated.task.id), null);
    assert.equal(service.store.getObject(delegated.task.id)?.payload.status, "waiting_approval");

    const denied = await httpJson(
      address.port,
      "POST",
      `/v1/tasks/${delegated.task.id}/cancel`,
      { actorId: "bot_cancel_source", reason: "Spoofed owner cancellation" }
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error, "OPERATOR_AUTHORITY_REQUIRED");
    assert.equal(service.store.getObject(delegated.task.id)?.payload.status, "waiting_approval");
    assert.equal(service.store.getObject(delegated.approval.id)?.payload.status, "pending");
    assert.equal(service.executionQueue.getByItem(delegated.task.id), null);
  } finally {
    await service.close();
  }
});

test("WSA-2026-022 bearer transport cannot authorize dead-letter retry", async () => {
  const service = createGatewayServer({
    dbPath: ":memory:",
    port: 0,
    inboundAuth: transportAuth()
  });
  service.gateway.createBot(bot("bot_retry_source"));
  service.gateway.createBot(bot("bot_retry_target"));
  const delegated = service.gateway.delegate({
    createdBy: "bot_retry_source",
    assigneeId: "bot_retry_target",
    workspaceId: "ws_authority",
    rootObjectiveId: "objective_authority_retry",
    objective: "Exercise dead-letter retry authority",
    reason: "Retry authority regression"
  });
  const execution = service.executionQueue.getByItem(delegated.task.id);
  if (!execution) throw new Error("Expected queued execution");
  service.store.putObject("task", {
    ...delegated.task.payload,
    status: "blocked",
    recovery_required: true,
    recovery_reason: "Synthetic dead-letter fixture"
  });
  service.executionQueue.updateState(execution.id, "dead_letter", "Synthetic dead-letter fixture");

  const address = await service.listen();
  try {
    const denied = await httpJson(
      address.port,
      "POST",
      `/v1/tasks/${delegated.task.id}/retry`,
      { actorId: "operator_claimed", reason: "Spoofed retry" }
    );
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error, "OPERATOR_AUTHORITY_REQUIRED");
    assert.equal(service.store.getObject(delegated.task.id)?.payload.status, "blocked");
    assert.equal(service.executionQueue.getByItem(delegated.task.id)?.state, "dead_letter");
  } finally {
    await service.close();
  }
});
