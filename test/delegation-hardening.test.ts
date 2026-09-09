import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionQueue } from "../src/execution-queue.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy } from "../src/policy.js";
import { BotRunner } from "../src/runner.js";
import { DeterministicRuntimeAdapter, RuntimeRegistry } from "../src/runtime.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

function bot(
  id: string,
  workspaceId = "ws_test",
  environmentPolicy: "shared_workspace" | "isolated_bot" | "isolated_run" | "external_managed" = "shared_workspace"
): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: { title: id, mission: `Mission for ${id}` },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: environmentPolicy },
    scope: { type: "workspace", workspace_id: workspaceId },
    permissions: {
      policy_ref: "default-bot",
      allowed_peers: ["*"],
      allowed_tools: ["*"],
      allowed_connections: ["*"]
    },
    coordination: { default_mode: "direct" }
  };
}

function strictGateway(store: CoordinationStore, queue: ExecutionQueue): CoordinationGateway {
  return new CoordinationGateway(store, queue, new CoordinationPolicy(store, { requireRegisteredBots: true }));
}

function artifact(store: CoordinationStore, id: string, workspaceId = "ws_test") {
  return store.putObject("artifact", {
    schema_version: "1.0",
    id,
    type: "artifact",
    workspace_id: workspaceId,
    created_by: "bot_a",
    task_id: "task_source",
    kind: "source_result",
    version: 1,
    inline_content: { value: "scoped evidence" },
    provenance: { origin: "bot_generated", trusted_instruction: false }
  });
}

test("delegation preserves root ownership while issuing task-scoped capability and environment leases", () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = strictGateway(store, queue);
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b"));
    const input = artifact(store, "art_scoped");
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_test",
      rootObjectiveId: "obj_root",
      objective: "Verify the scoped evidence",
      reason: "Bot B is the verifier",
      requiredConstraints: ["Do not publish"],
      inputArtifactRefs: [input.id],
      tools: ["web.search"],
      connections: ["drive.read"]
    });

    assert.equal(delegated.task.payload.created_by, "bot_a");
    assert.equal(delegated.task.payload.owner_id, "bot_b");
    assert.equal(delegated.task.payload.root_owner_id, "bot_a");
    assert.deepEqual(delegated.task.payload.input_artifact_refs, [input.id]);
    assert.equal(queue.getByItem(delegated.task.id)?.state, "queued");

    assert.equal(delegated.lease.payload.issued_to, "bot_b");
    assert.equal(delegated.lease.payload.task_id, delegated.task.id);
    assert.equal(delegated.lease.workspaceId, "ws_test");
    assert.deepEqual(delegated.lease.payload.tools, ["web.search"]);
    assert.deepEqual(delegated.lease.payload.connections, ["drive.read"]);

    assert.ok(delegated.environmentLease);
    assert.equal(delegated.environmentLease?.payload.issued_to, "bot_b");
    assert.equal(delegated.environmentLease?.payload.task_id, delegated.task.id);
    assert.equal(delegated.environmentLease?.workspaceId, "ws_test");
    assert.equal(delegated.environmentLease?.payload.environment_policy, "shared_workspace");
    assert.equal(delegated.environmentLease?.payload.environment_ref, "workspace:ws_test");
    assert.equal(delegated.task.payload.environment_lease_id, delegated.environmentLease?.id);
  } finally {
    queue.close();
    store.close();
  }
});

test("nested delegation preserves the original root owner without transferring child ownership", () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = strictGateway(store, queue);
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b"));
    gateway.createBot(bot("bot_c"));

    const first = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_test",
      rootObjectiveId: "obj_nested",
      objective: "Prepare the first pass",
      reason: "Delegate specialist work"
    });
    const second = gateway.delegate({
      createdBy: "bot_b",
      assigneeId: "bot_c",
      workspaceId: "ws_test",
      rootObjectiveId: "obj_nested",
      parentTaskId: first.task.id,
      objective: "Verify the first pass independently",
      reason: "Second specialist check"
    });

    assert.equal(first.task.payload.owner_id, "bot_b");
    assert.equal(first.task.payload.root_owner_id, "bot_a");
    assert.equal(second.task.payload.owner_id, "bot_c");
    assert.equal(second.task.payload.root_owner_id, "bot_a");
    assert.equal(store.getObject(first.task.id)?.payload.owner_id, "bot_b");
  } finally {
    queue.close();
    store.close();
  }
});

test("delegated scoped Artifact context is durable before the Task becomes queue-visible", () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = strictGateway(store, queue);
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b"));
    const input = artifact(store, "art_before_queue");
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_test",
      rootObjectiveId: "obj_inputs",
      objective: "Use only the attached evidence",
      reason: "Bounded context delegation",
      inputArtifactRefs: [input.id]
    });

    const queued = queue.getByItem(delegated.task.id);
    const durableTask = store.getObject(delegated.task.id);
    assert.equal(queued?.state, "queued");
    assert.deepEqual(durableTask?.payload.input_artifact_refs, [input.id]);
  } finally {
    queue.close();
    store.close();
  }
});

test("Bot B claims delegated work, receives both leases, returns an Artifact, completes Task and notifies root owner A", async () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = strictGateway(store, queue);
  const runner = new BotRunner(
    store,
    gateway,
    queue,
    new RuntimeRegistry().register(new DeterministicRuntimeAdapter()),
    "runner_task7"
  );
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b"));
    const delegated = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_test",
      rootObjectiveId: "obj_e2e",
      objective: "Return a bounded verification result",
      reason: "Bot B owns this child Task",
      requiredConstraints: ["Do not publish"]
    });

    const result = await runner.runNext("bot_b");
    if (!result) throw new Error("expected delegated execution result");
    assert.equal(result.status, "completed");
    assert.equal(result.task.payload.status, "completed");
    assert.equal(result.task.payload.owner_id, "bot_b");
    assert.equal(result.task.payload.root_owner_id, "bot_a");
    assert.ok(result.artifact);
    assert.equal(result.artifact?.payload.created_by, "bot_b");
    assert.equal(result.artifact?.payload.task_id, delegated.task.id);
    assert.equal((result.artifact?.payload.inline_content as any)?.lease_id, delegated.lease.id);
    assert.equal((result.artifact?.payload.inline_content as any)?.environment_lease_id, delegated.environmentLease?.id);

    const ownerMailbox = store.listMailbox("bot_a");
    assert.equal(ownerMailbox.length, 1);
    const notification = store.getObject(ownerMailbox[0]?.messageId ?? "");
    assert.match(String((notification?.payload.content as any[])[0]?.text), new RegExp(delegated.task.id));
    assert.match(String((notification?.payload.content as any[])[0]?.text), /Artifact:/);
  } finally {
    queue.close();
    store.close();
  }
});

test("cross-workspace Artifact context fails before delegation authority or work is created", () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = strictGateway(store, queue);
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b"));
    const external = artifact(store, "art_wrong_workspace", "ws_other");
    assert.throws(() => gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_test",
      rootObjectiveId: "obj_reject",
      objective: "Do not create this Task",
      reason: "Invalid scoped context",
      inputArtifactRefs: [external.id]
    }), /outside workspace/);
    assert.equal(store.listObjects("task", "ws_test").length, 0);
    assert.equal(store.listObjects("capability_lease", "ws_test").length, 0);
    assert.equal(store.listObjects("environment_lease", "ws_test").length, 0);
  } finally {
    queue.close();
    store.close();
  }
});

test("tampered environment lease fails before runtime output is accepted", async () => {
  const store = new CoordinationStore(":memory:");
  const queue = new ExecutionQueue(":memory:");
  const gateway = strictGateway(store, queue);
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
      workspaceId: "ws_test",
      rootObjectiveId: "obj_env_guard",
      objective: "This should fail before execution",
      reason: "Test environment authority"
    });
    if (!delegated.environmentLease) throw new Error("expected environment lease");
    store.putObject("environment_lease", {
      ...delegated.environmentLease.payload,
      issued_to: "bot_a"
    });

    const result = await runner.runNext("bot_b");
    if (!result) throw new Error("expected failed result");
    assert.equal(result.status, "failed");
    assert.equal(store.listObjects("artifact", "ws_test").length, 0);
  } finally {
    queue.close();
    store.close();
  }
});
