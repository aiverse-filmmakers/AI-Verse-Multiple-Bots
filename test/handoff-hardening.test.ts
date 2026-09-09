import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "../src/runtime.js";
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

test("return_on_completion returns ownership to the source after target execution", async () => {
  const { store, queue, gateway } = fixture();
  try {
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_handoff",
      rootObjectiveId: "obj_return",
      objective: "Complete specialist work",
      reason: "Initial owner",
      tools: ["web.search"]
    });
    const requested = gateway.requestHandoff({
      sourceOwnerId: "bot_b",
      targetOwnerId: "bot_c",
      workspaceId: "ws_handoff",
      workItemId: delegated.task.id,
      rootObjectiveId: "obj_return",
      reason: "Temporary specialist ownership",
      returnPolicy: "return_on_completion"
    });
    gateway.acceptHandoff(requested.handoff.id, "bot_c");

    const runner = new BotRunner(
      store,
      gateway,
      queue,
      new RuntimeRegistry().register(new DeterministicRuntimeAdapter()),
      "runner_return"
    );
    const result = await runner.runNext("bot_c");
    assert.equal(result?.status, "completed");
    assert.equal(result?.task.payload.owner_id, "bot_b");
    assert.equal(result?.task.payload.assignee_id, "bot_c");
    assert.equal(store.getObject(requested.handoff.id)?.payload.status, "completed");
    assert.equal(store.getObject(requested.handoff.id)?.payload.ownership_returned, true);

    const eventTypes = store.listEventsAfter(0, 200).map((entry) => entry.event.type);
    assert.ok(eventTypes.includes("handoff.completed"));
    assert.ok(eventTypes.filter((type) => type === "ownership.changed").length >= 2);
  } finally {
    queue.close();
    store.close();
  }
});

test("stay_with_target keeps target ownership after completed Handoff", async () => {
  const { store, queue, gateway } = fixture();
  try {
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_handoff",
      rootObjectiveId: "obj_stay",
      objective: "Complete and retain specialist ownership",
      reason: "Initial owner",
      tools: ["web.search"]
    });
    const requested = gateway.requestHandoff({
      sourceOwnerId: "bot_b",
      targetOwnerId: "bot_c",
      workspaceId: "ws_handoff",
      workItemId: delegated.task.id,
      rootObjectiveId: "obj_stay",
      reason: "Permanent specialist ownership",
      returnPolicy: "stay_with_target"
    });
    gateway.acceptHandoff(requested.handoff.id, "bot_c");

    const runner = new BotRunner(
      store,
      gateway,
      queue,
      new RuntimeRegistry().register(new DeterministicRuntimeAdapter()),
      "runner_stay"
    );
    const result = await runner.runNext("bot_c");
    assert.equal(result?.status, "completed");
    assert.equal(result?.task.payload.owner_id, "bot_c");
    assert.equal(store.getObject(requested.handoff.id)?.payload.status, "completed");
    assert.equal(store.getObject(requested.handoff.id)?.payload.ownership_returned, false);
  } finally {
    queue.close();
    store.close();
  }
});


function handoffArtifact(store: CoordinationStore, id: string, workspaceId = "ws_handoff") {
  return store.putObject("artifact", {
    schema_version: "1.0",
    id,
    type: "artifact",
    workspace_id: workspaceId,
    created_by: "bot_b",
    task_id: "task_source",
    kind: "handoff_context",
    version: 1,
    inline_content: { value: `context:${id}` },
    provenance: { origin: "bot_generated", trusted_instruction: false }
  });
}

test("accepted Handoff preserves root ownership and makes scoped Handoff Artifacts real Task inputs", async () => {
  const { store, queue, gateway } = fixture();
  try {
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_handoff",
      rootObjectiveId: "obj_handoff_inputs",
      objective: "Continue from selected specialist context",
      reason: "Initial delegated owner",
      tools: ["web.search"]
    });
    const contextArtifact = handoffArtifact(store, "art_handoff_context");
    const oldEnvironmentLeaseId = String(delegated.task.payload.environment_lease_id);
    const requested = gateway.requestHandoff({
      sourceOwnerId: "bot_b",
      targetOwnerId: "bot_c",
      workspaceId: "ws_handoff",
      workItemId: delegated.task.id,
      rootObjectiveId: "obj_handoff_inputs",
      reason: "Bot C should own the next specialist stage",
      artifactRefs: [contextArtifact.id]
    });
    const accepted = gateway.acceptHandoff(requested.handoff.id, "bot_c");

    assert.equal(requested.handoff.payload.root_owner_id, "bot_a");
    assert.equal(accepted.workItem.payload.root_owner_id, "bot_a");
    assert.equal(accepted.workItem.payload.owner_id, "bot_c");
    assert.deepEqual(accepted.workItem.payload.input_artifact_refs, [contextArtifact.id]);
    assert.equal(accepted.handoff.payload.environment_lease_id, accepted.workItem.payload.environment_lease_id);
    assert.notEqual(accepted.workItem.payload.environment_lease_id, oldEnvironmentLeaseId);
    assert.equal(store.getObject(oldEnvironmentLeaseId)?.payload.superseded_by, accepted.workItem.payload.environment_lease_id);
    assert.equal(store.getObject(String(accepted.workItem.payload.environment_lease_id))?.payload.issued_to, "bot_c");

    const runner = new BotRunner(
      store,
      gateway,
      queue,
      new RuntimeRegistry().register(new DeterministicRuntimeAdapter()),
      "runner_handoff_inputs"
    );
    const result = await runner.runNext("bot_c");
    assert.equal(result?.status, "completed");
    assert.deepEqual(result?.artifact?.payload.provenance && (result.artifact.payload.provenance as any).source_refs, [contextArtifact.id]);
    assert.equal(result?.task.payload.root_owner_id, "bot_a");
  } finally {
    queue.close();
    store.close();
  }
});

test("cross-workspace Handoff Artifact is rejected before Handoff state or ownership is created", () => {
  const { store, queue, gateway } = fixture();
  try {
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_handoff",
      rootObjectiveId: "obj_cross_scope_handoff",
      objective: "Keep transfer context scoped",
      reason: "Initial owner",
      tools: ["web.search"]
    });
    const externalArtifact = handoffArtifact(store, "art_other_workspace", "ws_other");
    assert.throws(() => gateway.requestHandoff({
      sourceOwnerId: "bot_b",
      targetOwnerId: "bot_c",
      workspaceId: "ws_handoff",
      workItemId: delegated.task.id,
      rootObjectiveId: "obj_cross_scope_handoff",
      reason: "This transfer must fail",
      artifactRefs: [externalArtifact.id]
    }), /outside workspace/);

    assert.equal(store.listObjects("handoff", "ws_handoff").length, 0);
    assert.equal(store.getObject(delegated.task.id)?.payload.owner_id, "bot_b");
    assert.equal(queue.getByItem(delegated.task.id)?.targetId, "bot_b");
  } finally {
    queue.close();
    store.close();
  }
});

test("root-owner tampering blocks Handoff acceptance without changing current ownership", () => {
  const { store, queue, gateway } = fixture();
  try {
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_handoff",
      rootObjectiveId: "obj_root_guard",
      objective: "Preserve original root accountability",
      reason: "Initial owner",
      tools: ["web.search"]
    });
    const requested = gateway.requestHandoff({
      sourceOwnerId: "bot_b",
      targetOwnerId: "bot_c",
      workspaceId: "ws_handoff",
      workItemId: delegated.task.id,
      rootObjectiveId: "obj_root_guard",
      reason: "Specialist transfer"
    });
    const task = store.getObject(delegated.task.id);
    if (!task) throw new Error("Task missing");
    store.putObject("task", { ...task.payload, root_owner_id: "bot_b" });

    assert.throws(() => gateway.acceptHandoff(requested.handoff.id, "bot_c"), /root ownership changed/);
    assert.equal(store.getObject(requested.handoff.id)?.payload.status, "requested");
    assert.equal(store.getObject(delegated.task.id)?.payload.owner_id, "bot_b");
    assert.equal(queue.getByItem(delegated.task.id)?.targetId, "bot_b");
  } finally {
    queue.close();
    store.close();
  }
});

test("tampered environment scope blocks Handoff acceptance before authority transfer", () => {
  const { store, queue, gateway } = fixture();
  try {
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_handoff",
      rootObjectiveId: "obj_env_handoff_guard",
      objective: "Preserve trusted execution scope",
      reason: "Initial owner",
      tools: ["web.search"]
    });
    const requested = gateway.requestHandoff({
      sourceOwnerId: "bot_b",
      targetOwnerId: "bot_c",
      workspaceId: "ws_handoff",
      workItemId: delegated.task.id,
      rootObjectiveId: "obj_env_handoff_guard",
      reason: "Specialist transfer"
    });
    const envId = String(delegated.task.payload.environment_lease_id);
    const environmentLease = store.getObject(envId);
    if (!environmentLease) throw new Error("Environment lease missing");
    store.putObject("environment_lease", { ...environmentLease.payload, task_id: "task_wrong" });

    assert.throws(() => gateway.acceptHandoff(requested.handoff.id, "bot_c"), /not scoped to Task/);
    assert.equal(store.getObject(requested.handoff.id)?.payload.status, "requested");
    assert.equal(store.getObject(delegated.task.id)?.payload.owner_id, "bot_b");
    assert.equal(queue.getByItem(delegated.task.id)?.targetId, "bot_b");
  } finally {
    queue.close();
    store.close();
  }
});

test("return_on_block returns ownership, assignee, capability authority, environment authority and queued work together", () => {
  const { store, queue, gateway } = fixture();
  try {
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_handoff",
      rootObjectiveId: "obj_return_block",
      objective: "Return blocked responsibility safely",
      reason: "Initial owner",
      tools: ["web.search"]
    });
    const requested = gateway.requestHandoff({
      sourceOwnerId: "bot_b",
      targetOwnerId: "bot_c",
      workspaceId: "ws_handoff",
      workItemId: delegated.task.id,
      rootObjectiveId: "obj_return_block",
      reason: "Temporary specialist ownership",
      returnPolicy: "return_on_block"
    });
    const accepted = gateway.acceptHandoff(requested.handoff.id, "bot_c");
    const targetLeaseId = String(accepted.workItem.payload.lease_id);
    const targetEnvironmentLeaseId = String(accepted.workItem.payload.environment_lease_id);
    store.putObject("task", { ...accepted.workItem.payload, status: "blocked" });

    const settled = gateway.settleHandoffForTask(delegated.task.id, "blocked", "bot_c");
    if (!settled) throw new Error("expected blocked Handoff settlement");
    assert.equal(settled.handoff.payload.status, "completed");
    assert.equal(settled.handoff.payload.ownership_returned, true);
    assert.equal(settled.task.payload.owner_id, "bot_b");
    assert.equal(settled.task.payload.assignee_id, "bot_b");
    assert.equal(settled.task.payload.root_owner_id, "bot_a");
    assert.equal(queue.getByItem(delegated.task.id)?.targetId, "bot_b");

    const returnedLeaseId = String(settled.task.payload.lease_id);
    const returnedEnvironmentLeaseId = String(settled.task.payload.environment_lease_id);
    assert.notEqual(returnedLeaseId, targetLeaseId);
    assert.notEqual(returnedEnvironmentLeaseId, targetEnvironmentLeaseId);
    assert.equal(store.getObject(targetLeaseId)?.payload.superseded_by, returnedLeaseId);
    assert.equal(store.getObject(returnedLeaseId)?.payload.issued_to, "bot_b");
    assert.equal(store.getObject(targetEnvironmentLeaseId)?.payload.superseded_by, returnedEnvironmentLeaseId);
    assert.equal(store.getObject(returnedEnvironmentLeaseId)?.payload.issued_to, "bot_b");

    const eventTypes = settled.events.map((entry) => entry.event.type);
    assert.ok(eventTypes.includes("handoff.completed"));
    assert.ok(eventTypes.includes("capability_lease.reissued"));
    assert.ok(eventTypes.includes("environment_lease.reissued"));
    assert.ok(eventTypes.includes("ownership.changed"));
  } finally {
    queue.close();
    store.close();
  }
});
