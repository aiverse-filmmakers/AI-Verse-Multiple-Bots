import assert from "node:assert/strict";
import test from "node:test";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationPolicy, PolicyError } from "../src/policy.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

function bot(id: string, workspaceId = "ws_safe", peers: string[] = ["*"]): BotManifest {
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
    permissions: {
      policy_ref: "default-bot",
      allowed_peers: peers,
      allowed_tools: ["web.search"],
      allowed_connections: ["github"]
    },
    coordination: { default_mode: "direct" }
  };
}

test("policy preserves parent constraints and objective lineage while deriving hop depth", () => {
  const store = new CoordinationStore(":memory:");
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true });
  const gateway = new CoordinationGateway(store, undefined, policy);
  try {
    gateway.createBot(bot("bot_a"));
    gateway.createBot(bot("bot_b"));

    const parent = gateway.delegate({
      createdBy: "operator_local",
      assigneeId: "bot_a",
      workspaceId: "ws_safe",
      rootObjectiveId: "obj_safe",
      objective: "Own the root analysis",
      reason: "Root assignment",
      requiredConstraints: ["Never publish externally"],
      maxHops: 3
    }).task;

    const child = gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_safe",
      rootObjectiveId: "obj_safe",
      parentTaskId: parent.id,
      objective: "Verify source claims",
      reason: "Independent verification",
      requiredConstraints: ["Use primary sources"],
      tools: ["web.search"],
      connections: ["github"]
    }).task;

    assert.equal(child.payload.parent_task_id, parent.id);
    assert.equal(child.payload.hop, 1);
    assert.equal(child.payload.max_hops, 3);
    assert.deepEqual(child.payload.required_constraints, ["Never publish externally", "Use primary sources"]);
  } finally {
    store.close();
  }
});

test("policy blocks workspace crossing, peer escalation, excessive hops, unavailable capabilities and duplicate active Tasks", () => {
  const store = new CoordinationStore(":memory:");
  const policy = new CoordinationPolicy(store, { requireRegisteredBots: true, absoluteMaxHops: 4 });
  const gateway = new CoordinationGateway(store, undefined, policy);
  try {
    gateway.createBot(bot("bot_a", "ws_safe", ["bot_b"]));
    gateway.createBot(bot("bot_b"));
    gateway.createBot(bot("bot_c"));
    gateway.createBot(bot("bot_other", "ws_other"));

    assert.throws(() => gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_other",
      workspaceId: "ws_safe",
      rootObjectiveId: "obj_cross",
      objective: "Cross workspace",
      reason: "Should fail"
    }), (error: unknown) => error instanceof PolicyError && error.code === "WORKSPACE_DENIED");

    assert.throws(() => gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_c",
      workspaceId: "ws_safe",
      rootObjectiveId: "obj_peer",
      objective: "Unauthorized peer",
      reason: "Should fail"
    }), (error: unknown) => error instanceof PolicyError && error.code === "PEER_DENIED");

    assert.throws(() => gateway.delegate({
      createdBy: "operator_local",
      assigneeId: "bot_b",
      workspaceId: "ws_safe",
      rootObjectiveId: "obj_tool",
      objective: "Use forbidden tool",
      reason: "Should fail",
      tools: ["shell.root"]
    }), (error: unknown) => error instanceof PolicyError && error.code === "CAPABILITY_UNAVAILABLE");

    const zeroHop = gateway.delegate({
      createdBy: "operator_local",
      assigneeId: "bot_a",
      workspaceId: "ws_safe",
      rootObjectiveId: "obj_hop",
      objective: "No onward delegation",
      reason: "Root assignment",
      maxHops: 0
    }).task;

    assert.throws(() => gateway.delegate({
      createdBy: "bot_a",
      assigneeId: "bot_b",
      workspaceId: "ws_safe",
      rootObjectiveId: "obj_hop",
      parentTaskId: zeroHop.id,
      objective: "Illegal child",
      reason: "Should exceed hop limit"
    }), (error: unknown) => error instanceof PolicyError && error.code === "HOP_LIMIT_EXCEEDED");

    gateway.delegate({
      createdBy: "operator_local",
      assigneeId: "bot_b",
      workspaceId: "ws_safe",
      rootObjectiveId: "obj_duplicate",
      objective: "Check the exact same thing",
      reason: "First copy"
    });
    assert.throws(() => gateway.delegate({
      createdBy: "operator_local",
      assigneeId: "bot_b",
      workspaceId: "ws_safe",
      rootObjectiveId: "obj_duplicate",
      objective: "  Check   the exact same thing  ",
      reason: "Duplicate copy"
    }), (error: unknown) => error instanceof PolicyError && error.code === "DUPLICATE_TASK");
  } finally {
    store.close();
  }
});
