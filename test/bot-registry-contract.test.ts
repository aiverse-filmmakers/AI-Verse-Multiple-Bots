import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BotRegistryError } from "../src/bot-registry.js";
import { CoordinationGateway } from "../src/gateway.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";
import { ProtocolValidationError, validateBotManifest } from "../src/validator.js";

function fullBot(id = "bot_registry-contract"): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: "Registry Contract",
    kind: "durable",
    status: "active",
    role: {
      title: "Research Lead",
      mission: "Own evidence-heavy research and synthesis.",
      responsibilities: ["verify claims", "synthesize evidence"],
      non_responsibilities: ["publish without approval"]
    },
    runtime: {
      adapter: "deterministic",
      profile_ref: "runtime-profile:research"
    },
    execution: {
      environment_policy: "isolated_bot",
      environment_ref: "environment:research",
      persistence: "durable"
    },
    model_policy: {
      preferred_model: "provider:model",
      fallback_allowed: true
    },
    scope: {
      type: "workspace",
      workspace_id: "ws_registry-contract"
    },
    capabilities: {
      role_refs: ["role:research-lead"],
      skill_refs: ["skill:deep-research"],
      operator_refs: ["operator:web"],
      tool_refs: ["tool:web-search"]
    },
    permissions: {
      policy_ref: "policy:research",
      allowed_peers: ["bot_peer"],
      allowed_tools: ["web.search"],
      allowed_connections: ["connection:web"],
      can_create_workers: true,
      can_create_bots: false,
      can_handoff: true
    },
    coordination: {
      default_mode: "direct",
      aliases: ["research-contract"],
      max_parallel_workers: 4,
      max_hops: 5
    }
  };
}

function assertValidationError(fn: () => unknown, fragment: RegExp): void {
  assert.throws(fn, (error: unknown) => error instanceof ProtocolValidationError && fragment.test(error.message));
}

test("Bot manifest runtime validation covers the canonical registry contract", () => {
  assert.equal(validateBotManifest(fullBot()).id, "bot_registry-contract");

  assertValidationError(() => validateBotManifest({ ...fullBot(), id: "registry-contract" }), /bot\.id must use the bot_ prefix/);
  assertValidationError(() => validateBotManifest({ ...fullBot(), status: "paused" }), /status is not supported/);
  assertValidationError(() => validateBotManifest({ ...fullBot(), scope: { type: "global" } }), /type is not supported/);
  assertValidationError(() => validateBotManifest({ ...fullBot(), execution: { environment_policy: "host_magic" } }), /environment_policy is not supported/);
  assertValidationError(() => validateBotManifest({ ...fullBot(), model_policy: [] }), /model_policy must be an object/);
  assertValidationError(() => validateBotManifest({ ...fullBot(), capabilities: { skill_refs: ["skill:a", "skill:a"] } }), /skill_refs must contain unique values/);
  assertValidationError(() => validateBotManifest({ ...fullBot(), permissions: { policy_ref: "p", allowed_tools: ["ok", 7] } }), /allowed_tools must be an array of non-empty strings/);
  assertValidationError(() => validateBotManifest({ ...fullBot(), coordination: { max_parallel_workers: 0 } }), /max_parallel_workers must be an integer >= 1/);
});

test("Bot Registry preserves runtime, role, scope, model, capability, execution and peer contracts across lifecycle and restart", () => {
  const dbPath = `/tmp/ai-verse-task5-registry-${randomUUID()}.db`;
  const original = fullBot();

  {
    const store = new CoordinationStore(dbPath);
    const gateway = new CoordinationGateway(store);
    try {
      const created = gateway.createBot(original);
      assert.deepEqual(created.payload.role, original.role);
      assert.deepEqual(created.payload.runtime, original.runtime);
      assert.deepEqual(created.payload.execution, original.execution);
      assert.deepEqual(created.payload.model_policy, original.model_policy);
      assert.deepEqual(created.payload.scope, original.scope);
      assert.deepEqual(created.payload.capabilities, original.capabilities);
      assert.deepEqual(created.payload.permissions, original.permissions);
      assert.equal(gateway.getBot(original.id)?.id, original.id);
      assert.deepEqual(gateway.listBots("ws_registry-contract").map((entry) => entry.id), [original.id]);

      const disabled = gateway.transitionBot(original.id, "disabled", "operator_local");
      assert.deepEqual(disabled.payload.runtime, original.runtime);
      assert.deepEqual(disabled.payload.model_policy, original.model_policy);
      assert.deepEqual(disabled.payload.capabilities, original.capabilities);
      assert.deepEqual(disabled.payload.execution, original.execution);
      assert.deepEqual(disabled.payload.permissions, original.permissions);
    } finally {
      store.close();
    }
  }

  {
    const store = new CoordinationStore(dbPath);
    const gateway = new CoordinationGateway(store);
    try {
      const restored = gateway.getBot(original.id);
      if (!restored) throw new Error("Bot did not survive registry restart");
      assert.equal(restored.payload.status, "disabled");
      assert.deepEqual(restored.payload.runtime, original.runtime);
      assert.deepEqual(restored.payload.model_policy, original.model_policy);
      assert.deepEqual(restored.payload.capabilities, original.capabilities);
      assert.deepEqual(restored.payload.execution, original.execution);
      assert.deepEqual(restored.payload.permissions, original.permissions);

      const active = gateway.transitionBot(original.id, "active", "operator_local");
      assert.equal(active.payload.status, "active");
      assert.deepEqual(active.payload.capabilities, original.capabilities);
      assert.equal(gateway.resolveBotAddress("ws_registry-contract", "@research-contract")?.id, original.id);
    } finally {
      store.close();
    }
  }
});

test("generic Gateway record writes cannot bypass durable Bot registry identity and lifecycle rules", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  try {
    const original = fullBot();
    gateway.createBot(original);
    assert.throws(
      () => gateway.record("bot", { ...original, name: "Bypassed Identity" }),
      (error: unknown) => error instanceof BotRegistryError && error.code === "BOT_REGISTRY_WRITE_REQUIRED"
    );
    const stored = gateway.getBot(original.id);
    if (!stored) throw new Error("Registry Bot unexpectedly missing");
    assert.equal(stored.payload.name, original.name);
    assert.equal(stored.payload.status, "active");
  } finally {
    store.close();
  }
});
