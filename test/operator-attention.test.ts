import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { request } from "node:http";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import {
  OPERATOR_ATTENTION_PROVIDER,
  OperatorAttentionProjector
} from "../src/operator-attention.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, workspaceId = "ws_operator"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: "Exercise operator attention UX." },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

function task(id: string, status: string, workspaceId = "ws_operator", ownerId = "bot_worker") {
  return {
    schema_version: "1.0",
    id,
    type: "task.delegate",
    created_by: "operator_test",
    assignee_id: ownerId,
    owner_id: ownerId,
    workspace_id: workspaceId,
    root_objective_id: "objective_" + id,
    parent_task_id: null,
    reason: "Operator UX test",
    objective: "Objective for " + id,
    required_constraints: [],
    expected_output: { contract: "artifact" },
    lease_id: "lease_" + id,
    environment_lease_id: null,
    deadline_at: null,
    budget: {},
    approval_id: status === "waiting_approval" ? "approval_test" : null,
    hop: 0,
    max_hops: 6,
    status
  };
}

function approval(id: string, taskId: string, workspaceId = "ws_operator") {
  return {
    schema_version: "1.0",
    id,
    type: "approval",
    workspace_id: workspaceId,
    actor_id: "bot_worker",
    task_id: taskId,
    requested_by: "bot_requester",
    requested_at: "2026-09-13T20:00:00.000Z",
    status: "pending",
    reason: "External action needs confirmation",
    action: {
      kind: "publish.external",
      summary: "Publish the prepared result"
    }
  };
}

function handoff(id: string, taskId: string, workspaceId = "ws_operator") {
  return {
    schema_version: "1.0",
    id,
    type: "handoff",
    source_owner_id: "bot_worker",
    target_bot_id: "bot_peer",
    workspace_id: workspaceId,
    task_id: taskId,
    root_objective_id: "objective_" + taskId,
    reason: "Waiting for peer ownership acceptance",
    required_constraints: [],
    return_policy: "return_on_completion",
    status: "requested"
  };
}

function httpJson(
  port: number,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: { "content-type": "application/json" }
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

test("Phase 5.11 operator attention follows canonical priority order without creating state", () => {
  const dbPath = "/tmp/operator-attention-" + randomUUID() + ".db";
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(dbPath);
  const gateway = new CoordinationGateway(store, queue);
  try {
    store.putObject("task", task("task_approval", "waiting_approval"));
    store.putObject("approval", approval("approval_test", "task_approval"));
    store.putObject("task", {
      ...task("task_input", "waiting_input"),
      waiting_reason: "Choose which customer version should be used"
    });
    store.putObject("task", task("task_blocked", "blocked"));
    store.putObject("task", {
      ...task("task_failed", "failed"),
      failure_reason: "Provider rejected the request"
    });
    store.putObject("task", task("task_handoff", "assigned"));
    store.putObject("handoff", handoff("handoff_test", "task_handoff"));

    const blockedExecution = queue.enqueueTask(
      "task_blocked",
      "bot_worker",
      "ws_operator",
      { recoveryPolicy: "retry_safe", maxAttempts: 3 }
    );
    queue.updateState(blockedExecution.id, "dead_letter", "Temporary provider outage");

    gateway.emit({
      type: "result.available",
      actorId: "bot_worker",
      workspaceId: "ws_operator",
      taskId: "task_result",
      summary: "A completed result is ready to review",
      attentionState: "unread_result"
    });

    const cursorBefore = store.latestEventSequence();
    const snapshot = new OperatorAttentionProjector(store, queue).project("ws_operator", 0);
    const cursorAfter = store.latestEventSequence();

    assert.equal(snapshot.provider, OPERATOR_ATTENTION_PROVIDER);
    assert.equal(snapshot.projection_only, true);
    assert.equal(snapshot.operator_ux_owns_truth, false);
    assert.equal(snapshot.canonical_owner, "ai-verse-multiple-bots");
    assert.equal(cursorAfter, cursorBefore);
    assert.deepEqual(snapshot.priority_order, [
      "needs_approval",
      "needs_input",
      "blocked",
      "failed",
      "handoff_waiting",
      "unread_result"
    ]);
    assert.deepEqual(snapshot.items.map((item) => item.state), [
      "needs_approval",
      "needs_input",
      "blocked",
      "failed",
      "handoff_waiting",
      "unread_result"
    ]);
    assert.equal(snapshot.counts.total, 6);
    assert.equal(snapshot.counts.needs_approval, 1);
    assert.equal(snapshot.counts.unread_result, 1);
    const blocked = snapshot.items.find((item) => item.source_id === "task_blocked");
    assert.equal(blocked?.controls.includes("task.retry"), true);
    assert.equal(blocked?.controls.includes("task.cancel"), true);
  } finally {
    queue.close();
    store.close();
    rmSync(dbPath, { force: true });
    rmSync(dbPath + "-wal", { force: true });
    rmSync(dbPath + "-shm", { force: true });
  }
});

test("Phase 5.11 event cursor makes transient result/input notices client-trackable without a read-state database", () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = new CoordinationGateway(store, queue);
  try {
    const first = gateway.emit({
      type: "result.available",
      actorId: "bot_worker",
      workspaceId: "ws_operator",
      summary: "First result",
      attentionState: "unread_result"
    });

    const noOldNotice = new OperatorAttentionProjector(store, queue).project("ws_operator", first.sequence);
    assert.equal(noOldNotice.items.some((item) => item.state === "unread_result"), false);

    const second = gateway.emit({
      type: "room.unresolved_mention",
      actorId: "operator_test",
      workspaceId: "ws_operator",
      roomId: "room_operator",
      summary: "A Room mention needs clarification",
      attentionState: "needs_input"
    });
    const newer = new OperatorAttentionProjector(store, queue).project("ws_operator", first.sequence);
    assert.equal(newer.items.length, 1);
    assert.equal(newer.items[0]?.state, "needs_input");
    assert.equal(newer.items[0]?.event_sequence, second.sequence);
    assert.equal(newer.event_cursor, second.sequence);
  } finally {
    queue.close();
    store.close();
  }
});

test("Phase 5.11 operator approval cards provide decision context and route approval through canonical Gateway ownership", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  const address = await service.listen();
  try {
    service.gateway.createBot(bot("bot_requester"));
    service.gateway.createBot(bot("bot_worker"));

    const delegated = service.gateway.delegate({
      createdBy: "bot_requester",
      assigneeId: "bot_worker",
      workspaceId: "ws_operator",
      rootObjectiveId: "objective_operator_approval",
      objective: "Publish a customer-facing result",
      reason: "External publishing needs approval",
      approval: {
        required: true,
        reason: "Confirm external publication",
        action: {
          kind: "publish.external",
          summary: "Publish the result to the customer"
        }
      }
    });
    if (!delegated.approval) throw new Error("Expected pending approval");

    const cards = await httpJson(
      address.port,
      "GET",
      "/v1/operator/approvals?workspace=ws_operator&status=pending"
    );
    assert.equal(cards.status, 200);
    assert.equal(cards.body.provider, OPERATOR_ATTENTION_PROVIDER);
    assert.equal(cards.body.approvals.length, 1);
    assert.equal(cards.body.approvals[0].task_objective, "Publish a customer-facing result");
    assert.equal(cards.body.approvals[0].action_summary, "Publish the result to the customer");
    assert.deepEqual(cards.body.approvals[0].controls, [
      "operator.approval.approve",
      "operator.approval.deny"
    ]);

    const wrongWorkspace = await httpJson(
      address.port,
      "POST",
      `/v1/operator/approvals/${delegated.approval.id}/decision`,
      {
        workspaceId: "ws_other",
        actorId: "operator_test",
        decision: "approve"
      }
    );
    assert.equal(wrongWorkspace.status, 403);
    assert.equal(wrongWorkspace.body.error, "OPERATOR_WORKSPACE_MISMATCH");
    assert.equal(service.store.getObject(delegated.approval.id)?.payload.status, "pending");

    const nonOperator = await httpJson(
      address.port,
      "POST",
      `/v1/operator/approvals/${delegated.approval.id}/decision`,
      {
        workspaceId: "ws_operator",
        actorId: "bot_requester",
        decision: "approve"
      }
    );
    assert.equal(nonOperator.status, 403);
    assert.equal(nonOperator.body.error, "OPERATOR_ID_REQUIRED");

    const approved = await httpJson(
      address.port,
      "POST",
      `/v1/operator/approvals/${delegated.approval.id}/decision`,
      {
        workspaceId: "ws_operator",
        actorId: "operator_test",
        decision: "approve"
      }
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.decision, "approve");
    assert.equal(approved.body.approval_status, "approved");
    assert.equal(approved.body.task_status, "assigned");
    assert.equal(service.store.getObject(delegated.approval.id)?.payload.status, "approved");
    assert.equal(
      ["assigned", "running", "completed"].includes(String(service.store.getObject(delegated.task.id)?.payload.status ?? "")),
      true
    );

    const pendingAfter = await httpJson(
      address.port,
      "GET",
      "/v1/operator/attention?workspace=ws_operator"
    );
    assert.equal(pendingAfter.status, 200);
    assert.equal(
      pendingAfter.body.items.some((item: any) => item.source_id === delegated.approval?.id),
      false
    );
  } finally {
    await service.close();
  }
});

test("Phase 5.11 denial records the reason through canonical approval lifecycle and cancels the Task", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  const address = await service.listen();
  try {
    service.gateway.createBot(bot("bot_requester"));
    service.gateway.createBot(bot("bot_worker"));
    const delegated = service.gateway.delegate({
      createdBy: "bot_requester",
      assigneeId: "bot_worker",
      workspaceId: "ws_operator",
      rootObjectiveId: "objective_operator_deny",
      objective: "Delete external content",
      reason: "Destructive external action",
      approval: {
        required: true,
        action: { kind: "delete.external", summary: "Delete external content" }
      }
    });
    if (!delegated.approval) throw new Error("Expected pending approval");

    const denied = await httpJson(
      address.port,
      "POST",
      `/v1/operator/approvals/${delegated.approval.id}/decision`,
      {
        workspaceId: "ws_operator",
        actorId: "operator_test",
        decision: "deny",
        reason: "Keep the existing external content"
      }
    );
    assert.equal(denied.status, 200);
    assert.equal(denied.body.approval_status, "denied");
    assert.equal(denied.body.task_status, "canceled");

    const decided = await httpJson(
      address.port,
      "GET",
      "/v1/operator/approvals?workspace=ws_operator&status=denied"
    );
    assert.equal(decided.status, 200);
    assert.equal(decided.body.approvals[0].rejection_reason, "Keep the existing external content");
    assert.deepEqual(decided.body.approvals[0].controls, []);
  } finally {
    await service.close();
  }
});

test("Phase 5.11 operator capabilities expose the attention contract without claiming UI truth", async () => {
  const service = createGatewayServer({ dbPath: ":memory:", port: 0 });
  const address = await service.listen();
  try {
    const response = await httpJson(
      address.port,
      "GET",
      "/v1/operator/capabilities?workspace=ws_operator"
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.provider, OPERATOR_ATTENTION_PROVIDER);
    assert.equal(response.body.projection_only, true);
    assert.equal(response.body.operator_ux_owns_truth, false);
    assert.deepEqual(response.body.priority_order, [
      "needs_approval",
      "needs_input",
      "blocked",
      "failed",
      "handoff_waiting",
      "unread_result"
    ]);
    assert.equal(
      response.body.controls.approval_actions.includes("operator.approval.approve"),
      true
    );
    assert.equal(
      response.body.controls.attention_item_actions.includes("task.retry"),
      true
    );
  } finally {
    await service.close();
  }
});
