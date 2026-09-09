import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, tools: string[] = ["web.search"]): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: `Mission for ${id}` },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_handoff" },
    permissions: {
      policy_ref: "strict",
      allowed_peers: ["*"],
      allowed_tools: tools,
      allowed_connections: [],
      can_handoff: true
    },
    coordination: { default_mode: "direct" }
  };
}

function fixture() {
  const dbPath = `/tmp/ai-verse-handoff-${randomUUID()}.db`;
  const store = new CoordinationStore(dbPath);
  const queue = new ExecutionQueue(store.dbPath);
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, queue, policy);
  for (const id of ["bot_a", "bot_b", "bot_c"]) gateway.createBot(bot(id));
  return { store, queue, gateway };
}

test("accepted Handoff atomically retargets queued Task and reissues capability authority", () => {
  const { store, queue, gateway } = fixture();
  try {
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_handoff",
      rootObjectiveId: "obj_atomic",
      objective: "Research the launch",
      reason: "Initial owner",
      requiredConstraints: ["Do not publish"],
      tools: ["web.search"]
    });
    const oldLeaseId = String(delegated.task.payload.lease_id);
    assert.equal(queue.getByItem(delegated.task.id)?.targetId, "bot_b");

    const requested = gateway.requestHandoff({
      sourceOwnerId: "bot_b",
      targetOwnerId: "bot_c",
      workspaceId: "ws_handoff",
      workItemId: delegated.task.id,
      rootObjectiveId: "obj_atomic",
      reason: "Bot C owns the specialist stage",
      requiredConstraints: ["Cite every factual claim"]
    });
    const accepted = gateway.acceptHandoff(requested.handoff.id, "bot_c");

    assert.equal(accepted.handoff.payload.status, "accepted");
    assert.equal(accepted.handoff.payload.target_bot_id, "bot_c");
    assert.equal(accepted.workItem.payload.owner_id, "bot_c");
    assert.equal(accepted.workItem.payload.assignee_id, "bot_c");
    assert.deepEqual(accepted.workItem.payload.required_constraints, ["Cite every factual claim", "Do not publish"]);
    assert.equal(queue.getByItem(delegated.task.id)?.targetId, "bot_c");

    const newLeaseId = String(accepted.workItem.payload.lease_id);
    assert.notEqual(newLeaseId, oldLeaseId);
    assert.equal(store.getObject(oldLeaseId)?.payload.superseded_by, newLeaseId);
    assert.equal(store.getObject(newLeaseId)?.payload.issued_to, "bot_c");
    assert.deepEqual(store.getObject(newLeaseId)?.payload.tools, ["web.search"]);

    const eventTypes = accepted.events.map((entry) => entry.event.type);
    assert.ok(eventTypes.includes("handoff.accepted"));
    assert.ok(eventTypes.includes("ownership.changed"));
    assert.ok(eventTypes.includes("capability_lease.reissued"));
    assert.ok(eventTypes.includes("task.assigned"));
  } finally {
    queue.close();
    store.close();
  }
});

test("approval-gated Handoff retargets the approval actor without creating executable work", () => {
  const { store, queue, gateway } = fixture();
  try {
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_handoff",
      rootObjectiveId: "obj_approval_handoff",
      objective: "Prepare an external publication",
      reason: "Needs operator approval",
      tools: ["web.search"],
      approval: {
        required: true,
        action: { kind: "external_publish", summary: "Publish the prepared material" }
      }
    });
    const approvalId = String(delegated.task.payload.approval_id);
    assert.equal(queue.getByItem(delegated.task.id), null);

    const requested = gateway.requestHandoff({
      sourceOwnerId: "bot_b",
      targetOwnerId: "bot_c",
      workspaceId: "ws_handoff",
      workItemId: delegated.task.id,
      rootObjectiveId: "obj_approval_handoff",
      reason: "Bot C should own the publish stage"
    });
    const accepted = gateway.acceptHandoff(requested.handoff.id, "bot_c");

    assert.equal(accepted.workItem.payload.status, "waiting_approval");
    assert.equal(accepted.workItem.payload.owner_id, "bot_c");
    assert.equal(store.getObject(approvalId)?.payload.actor_id, "bot_c");
    assert.equal(queue.getByItem(delegated.task.id), null);

    gateway.approve(approvalId, "operator_local");
    assert.equal(queue.getByItem(delegated.task.id)?.targetId, "bot_c");
  } finally {
    queue.close();
    store.close();
  }
});

test("rejected Handoff leaves Task queue and capability lease with the current owner", () => {
  const { store, queue, gateway } = fixture();
  try {
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_handoff",
      rootObjectiveId: "obj_reject",
      objective: "Keep ownership unless accepted",
      reason: "Initial owner",
      tools: ["web.search"]
    });
    const leaseId = String(delegated.task.payload.lease_id);
    const requested = gateway.requestHandoff({
      sourceOwnerId: "bot_b",
      targetOwnerId: "bot_c",
      workspaceId: "ws_handoff",
      workItemId: delegated.task.id,
      rootObjectiveId: "obj_reject",
      reason: "Offer specialist ownership"
    });

    const rejected = gateway.rejectHandoff(requested.handoff.id, "bot_c", "I cannot own this stage");
    assert.equal(rejected.handoff.payload.status, "rejected");
    assert.equal(store.getObject(delegated.task.id)?.payload.owner_id, "bot_b");
    assert.equal(store.getObject(delegated.task.id)?.payload.lease_id, leaseId);
    assert.equal(store.getObject(leaseId)?.payload.superseded_by, undefined);
    assert.equal(queue.getByItem(delegated.task.id)?.targetId, "bot_b");
  } finally {
    queue.close();
    store.close();
  }
});

test("Handoff acceptance refuses claimed execution and preserves all ownership state", () => {
  const { store, queue, gateway } = fixture();
  try {
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_handoff",
      rootObjectiveId: "obj_claimed",
      objective: "Do work before transfer",
      reason: "Initial owner",
      tools: ["web.search"]
    });
    const oldLeaseId = String(delegated.task.payload.lease_id);
    const requested = gateway.requestHandoff({
      sourceOwnerId: "bot_b",
      targetOwnerId: "bot_c",
      workspaceId: "ws_handoff",
      workItemId: delegated.task.id,
      rootObjectiveId: "obj_claimed",
      reason: "Too late after claim"
    });
    const claimed = queue.claimNext("bot_b", "runner_claim");
    assert.equal(claimed?.state, "claimed");

    assert.throws(() => gateway.acceptHandoff(requested.handoff.id, "bot_c"), /execution is claimed/);
    assert.equal(store.getObject(requested.handoff.id)?.payload.status, "requested");
    assert.equal(store.getObject(delegated.task.id)?.payload.owner_id, "bot_b");
    assert.equal(store.getObject(delegated.task.id)?.payload.lease_id, oldLeaseId);
    assert.equal(queue.getByItem(delegated.task.id)?.targetId, "bot_b");
  } finally {
    queue.close();
    store.close();
  }
});

test("immutable constraint tampering blocks Handoff acceptance", () => {
  const { store, queue, gateway } = fixture();
  try {
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_handoff",
      rootObjectiveId: "obj_constraints",
      objective: "Preserve safety constraints",
      reason: "Initial owner",
      requiredConstraints: ["Never publish externally"],
      tools: ["web.search"]
    });
    const requested = gateway.requestHandoff({
      sourceOwnerId: "bot_b",
      targetOwnerId: "bot_c",
      workspaceId: "ws_handoff",
      workItemId: delegated.task.id,
      rootObjectiveId: "obj_constraints",
      reason: "Specialist stage"
    });

    const task = store.getObject(delegated.task.id);
    if (!task) throw new Error("Task missing");
    store.putObject("task", { ...task.payload, required_constraints: [] });

    assert.throws(() => gateway.acceptHandoff(requested.handoff.id, "bot_c"), /constraint digest is invalid/);
    assert.equal(store.getObject(requested.handoff.id)?.payload.status, "requested");
    assert.equal(store.getObject(delegated.task.id)?.payload.owner_id, "bot_b");
  } finally {
    queue.close();
    store.close();
  }
});
