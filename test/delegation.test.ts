import assert from "node:assert/strict";
import test from "node:test";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationStore } from "../src/store.js";

test("delegation creates a capability lease and child-owned Task", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  try {
    const result = gateway.delegate({
      createdBy: "bot_lead",
      assigneeId: "bot_research",
      workspaceId: "ws_test",
      rootObjectiveId: "obj_root",
      objective: "Verify pricing",
      reason: "Independent verification is needed",
      requiredConstraints: ["Do not publish"],
      tools: ["web.search"]
    });
    assert.equal(result.task.payload.owner_id, "bot_research");
    assert.equal(result.task.payload.created_by, "bot_lead");
    assert.equal(result.lease.payload.issued_to, "bot_research");
    assert.equal(result.lease.payload.task_id, result.task.id);
  } finally {
    store.close();
  }
});

test("handoff changes ownership only after target acceptance", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  try {
    const delegated = gateway.delegate({
      createdBy: "bot_lead",
      assigneeId: "bot_a",
      workspaceId: "ws_test",
      rootObjectiveId: "obj_root",
      objective: "Own this work",
      reason: "Initial assignment"
    });
    const requested = gateway.requestHandoff({
      sourceOwnerId: "bot_a",
      targetOwnerId: "bot_b",
      workspaceId: "ws_test",
      workItemId: delegated.task.id,
      rootObjectiveId: "obj_root",
      reason: "Bot B is the specialist",
      requiredConstraints: ["Do not publish"]
    });
    assert.equal((store.getObject(delegated.task.id)?.payload.owner_id), "bot_a");
    assert.throws(() => gateway.acceptHandoff(requested.handoff.id, "bot_c"));
    const accepted = gateway.acceptHandoff(requested.handoff.id, "bot_b");
    assert.equal(accepted.handoff.payload.status, "accepted");
    assert.equal(accepted.workItem?.payload.owner_id, "bot_b");
    const eventTypes = accepted.events.map((entry) => entry.event.type);
    assert.ok(eventTypes.includes("handoff.accepted"));
    assert.ok(eventTypes.includes("ownership.changed"));
    assert.ok(eventTypes.includes("capability_lease.reissued"));
  } finally {
    store.close();
  }
});
