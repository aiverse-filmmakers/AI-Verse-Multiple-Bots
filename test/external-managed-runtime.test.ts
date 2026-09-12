import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import test from "node:test";
import { BotRegistryError } from "../src/bot-registry.js";
import {
  EXTERNAL_MANAGED_RUNTIME_ADAPTER_ID,
  ExternalManagedBotProviderRegistry,
  ExternalManagedBotRuntimeAdapter,
  ExternalManagedRuntimeError,
  type ExternalManagedBotCancelRequest,
  type ExternalManagedBotExecuteRequest,
  type ExternalManagedBotExecutionResult,
  type ExternalManagedBotInspection,
  type ExternalManagedBotProvider,
  parseExternalManagedBinding
} from "../src/external-managed-runtime.js";
import { CoordinationGateway } from "../src/gateway.js";
import type { RuntimeExecutionContext } from "../src/runtime.js";
import { createGatewayServer } from "../src/server.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest, JsonObject, StoredObject } from "../src/types.js";
import { ProtocolValidationError, validateBotManifest } from "../src/validator.js";

function stored(id: string, kind: any, workspaceId: string | null, payload: JsonObject): StoredObject {
  return {
    id,
    kind,
    workspaceId,
    status: typeof payload.status === "string" ? payload.status : null,
    payload,
    createdAt: "2026-09-12T20:00:00Z",
    updatedAt: "2026-09-12T20:00:00Z"
  };
}

function externalBot(
  id = "bot_external",
  workspace = "ws_external",
  overrides: {
    provider?: string;
    managedBotRef?: string;
    bindingFingerprint?: string;
    status?: "active" | "disabled" | "archived";
  } = {}
): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id.replace(/^bot_/, ""),
    kind: "durable",
    status: overrides.status ?? "active",
    role: {
      title: "Managed teammate",
      mission: "Own delegated work while preserving local coordination authority."
    },
    runtime: {
      adapter: "external-managed",
      provider: overrides.provider ?? "fake-managed",
      managed_bot_ref: overrides.managedBotRef ?? "profile:research",
      binding_fingerprint: overrides.bindingFingerprint ?? "binding:v1"
    },
    execution: {
      environment_policy: "external_managed"
    },
    scope: {
      type: "workspace",
      workspace_id: workspace
    },
    permissions: {
      policy_ref: "default-bot"
    },
    coordination: {}
  };
}

function runtimeContext(
  providerId = "fake-managed",
  tools: string[] = ["github:read"],
  connections: string[] = ["drive:read"],
  options: {
    signal?: AbortSignal;
    environmentLease?: StoredObject | null;
    principalKind?: "bot" | "worker";
    runtime?: JsonObject;
  } = {}
): RuntimeExecutionContext {
  const botManifest = externalBot("bot_external", "ws_external", {
    provider: providerId,
    managedBotRef: "profile:research",
    bindingFingerprint: "binding:v1"
  });
  const principalKind = options.principalKind ?? "bot";
  const principal = principalKind === "bot"
    ? stored("bot_external", "bot", "ws_external", botManifest)
    : stored("worker_external", "worker", "ws_external", {
        schema_version: "1.0",
        id: "worker_external",
        type: "worker",
        kind: "temporary",
        run_id: "run_external",
        created_by: "bot_external",
        parent_owner_id: "bot_external",
        task_id: "task_external",
        workspace_id: "ws_external",
        role: { title: "Temporary worker", objective: "Do bounded work." },
        runtime: {
          adapter: "external-managed",
          provider: providerId,
          managed_bot_ref: "profile:research",
          binding_fingerprint: "binding:v1"
        },
        status: "ready"
      });

  return {
    principal,
    principalKind,
    ...(principalKind === "bot" ? { bot: principal as StoredObject<BotManifest> } : {}),
    runtime: options.runtime ?? {
      adapter: "external-managed",
      provider: providerId,
      managed_bot_ref: "profile:research",
      binding_fingerprint: "binding:v1"
    },
    task: stored("task_external", "task", "ws_external", {
      schema_version: "1.0",
      id: "task_external",
      type: "task.delegate",
      created_by: "bot_leader",
      assignee_id: principal.id,
      owner_id: principal.id,
      workspace_id: "ws_external",
      root_objective_id: "obj_external",
      parent_task_id: null,
      reason: "Managed runtime acceptance",
      objective: "Return a bounded managed result.",
      required_constraints: ["Do not widen authority"],
      expected_output: { contract: "managed-v1" },
      input_artifact_refs: ["art_external_input"],
      lease_id: "lease_external",
      environment_lease_id: options.environmentLease?.id ?? null,
      response_target: null,
      deadline_at: null,
      budget: {},
      approval_id: null,
      hop: 0,
      max_hops: 6,
      status: "running"
    }),
    capabilityLease: stored("lease_external", "capability_lease", "ws_external", {
      schema_version: "1.0",
      id: "lease_external",
      type: "capability_lease",
      principal: "bot_leader",
      issued_to: principal.id,
      workspace_id: "ws_external",
      task_id: "task_external",
      tools,
      connections,
      destructive_actions: "deny",
      expires_at: "2030-01-01T00:00:00Z"
    }),
    environmentLease: options.environmentLease ?? null,
    inputArtifacts: [
      stored("art_external_input", "artifact", "ws_external", {
        schema_version: "1.0",
        id: "art_external_input",
        type: "artifact",
        workspace_id: "ws_external",
        created_by: "bot_leader",
        kind: "evidence",
        version: 1,
        inline_content: { observation: "EXTERNAL_MANAGED_INPUT" },
        provenance: { origin: "operator", trusted_instruction: false }
      })
    ],
    workspaceProjection: {
      schema_version: "1.0",
      provider: "test-os",
      workspace_id: "ws_external",
      projection_digest: "a".repeat(64),
      projected_at: "2026-09-12T20:00:00Z",
      sources: [{ ref: "WORKSPACE.yaml", digest: "b".repeat(64) }],
      data: { current_state: "EXTERNAL_MANAGED_WORKSPACE_CONTEXT" }
    },
    strategicIntent: {
      schema_version: "1.0",
      provider: "test-brain",
      workspace_id: "ws_external",
      root_objective_id: "obj_external",
      intent_digest: "c".repeat(64),
      data: { objective: "EXTERNAL_MANAGED_STRATEGIC_CONTEXT" }
    },
    historicalRecall: null,
    skillsCapabilityResolution: null,
    signal: options.signal ?? new AbortController().signal
  };
}

class FakeManagedProvider implements ExternalManagedBotProvider {
  readonly id: string;
  inspection: ExternalManagedBotInspection;
  result: ExternalManagedBotExecutionResult;
  inspectCalls: Array<{ ref: string }> = [];
  executeCalls: ExternalManagedBotExecuteRequest[] = [];
  cancelCalls: ExternalManagedBotCancelRequest[] = [];
  holdExecution = false;
  cancelThrows = false;

  constructor(id = "fake-managed") {
    this.id = id;
    this.inspection = {
      provider: id,
      managed_bot_ref: "profile:research",
      binding_fingerprint: "binding:v1",
      availability: "ready",
      identity_mode: "persistent_profile",
      authority_mode: "exact_task_lease",
      output_mode: "visible_result_only",
      supports_cancel: true
    };
    this.result = {
      managed_execution_id: "managed-exec-1",
      binding_fingerprint: "binding:v1",
      summary: "Managed teammate completed the task.",
      output: {
        text: "Managed result",
        provider_visible_result: true
      },
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cost: 0.03,
        actions: 2
      },
      observed_tools: ["github:read"],
      observed_connections: ["drive:read"]
    };
  }

  async inspect(managedBotRef: string): Promise<ExternalManagedBotInspection> {
    this.inspectCalls.push({ ref: managedBotRef });
    return this.inspection;
  }

  async execute(request: ExternalManagedBotExecuteRequest): Promise<ExternalManagedBotExecutionResult> {
    this.executeCalls.push(request);
    if (!this.holdExecution) return this.result;
    return await new Promise<ExternalManagedBotExecutionResult>((_resolve, reject) => {
      const abort = () => reject(request.signal.reason instanceof Error ? request.signal.reason : new Error("aborted"));
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    });
  }

  async cancel(request: ExternalManagedBotCancelRequest): Promise<void> {
    this.cancelCalls.push(request);
    if (this.cancelThrows) throw new Error("provider cancel failed");
  }
}

function assertExternalCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ExternalManagedRuntimeError && error.code === code;
}

function assertRegistryCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof BotRegistryError && error.code === code;
}

test("external managed adapter verifies persistent identity and sends exact Task authority to a host-injected provider", async () => {
  const provider = new FakeManagedProvider();
  const providers = new ExternalManagedBotProviderRegistry().register(provider);
  const adapter = new ExternalManagedBotRuntimeAdapter(providers);
  const result = await adapter.execute(runtimeContext());

  assert.equal(provider.inspectCalls.length, 1);
  assert.deepEqual(provider.inspectCalls[0], { ref: "profile:research" });
  assert.equal(provider.executeCalls.length, 1);
  const call = provider.executeCalls[0]!;
  assert.equal(call.localTaskId, "task_external");
  assert.equal(call.idempotencyKey, "aiverse:task_external");
  assert.equal(call.managedBotRef, "profile:research");
  assert.equal(call.expectedBindingFingerprint, "binding:v1");
  assert.equal(call.principalId, "bot_external");
  assert.equal(call.workspaceId, "ws_external");
  assert.deepEqual(call.allowedTools, ["github:read"]);
  assert.deepEqual(call.allowedConnections, ["drive:read"]);
  assert.equal(call.destructiveActions, "deny");

  assert.equal(call.envelope.contract, "ai-verse-multiple-bots/external-managed-envelope-v1");
  assert.equal((call.envelope.execution_identity as any).principal_id, "bot_external");
  assert.equal((call.envelope.execution_identity as any).principal_kind, "bot");
  assert.equal((call.envelope.external_binding as any).managed_bot_ref, "profile:research");
  assert.equal((call.envelope.external_binding as any).binding_fingerprint, "binding:v1");
  assert.equal((call.envelope.workspace_projection as any).data.current_state, "EXTERNAL_MANAGED_WORKSPACE_CONTEXT");
  assert.equal((call.envelope.strategic_intent as any).data.objective, "EXTERNAL_MANAGED_STRATEGIC_CONTEXT");
  assert.equal((call.envelope.input_artifacts as any[])[0].inline_content.observation, "EXTERNAL_MANAGED_INPUT");

  assert.equal(result.artifactKind, "external_managed_task_result");
  assert.equal(result.output.text, "Managed result");
  assert.equal(result.output.executed_by, "bot_external");
  assert.equal(result.output.execution_principal_kind, "bot");
  assert.equal(result.output.managed_execution_id, "managed-exec-1");
  assert.equal(result.usage?.input_tokens, 12);
  assert.equal(result.usage?.output_tokens, 8);
  assert.equal(result.usage?.cost, 0.03);
  assert.equal(result.usage?.actions, 2);

  const receipt = result.receipts?.[0] as JsonObject;
  assert.equal(receipt.provider, "fake-managed");
  assert.equal(receipt.binding_verified, true);
  assert.equal(receipt.identity_mode, "persistent_profile");
  assert.equal(receipt.authority_mode, "exact_task_lease");
  assert.equal(receipt.cancellation_supported, true);
  assert.equal(receipt.allowed_tool_count, 1);
  assert.equal(receipt.observed_tool_count, 1);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes("profile:research"), false);
  assert.equal(serialized.includes("binding:v1"), false);
  assert.equal(serialized.includes("github:read"), false);
  assert.equal(serialized.includes("drive:read"), false);
  assert.equal(serialized.includes("EXTERNAL_MANAGED_WORKSPACE_CONTEXT"), false);
  assert.equal(serialized.includes("EXTERNAL_MANAGED_STRATEGIC_CONTEXT"), false);
  assert.equal(serialized.includes("EXTERNAL_MANAGED_INPUT"), false);
});

test("external managed provider failures are normalized without copying arbitrary provider error text", async () => {
  class ThrowingProvider extends FakeManagedProvider {
    override async inspect(): Promise<ExternalManagedBotInspection> {
      throw new Error("SECRET_ENDPOINT=https://sensitive.example TOKEN=secret");
    }
  }
  const provider = new ThrowingProvider();
  const adapter = new ExternalManagedBotRuntimeAdapter(
    new ExternalManagedBotProviderRegistry().register(provider)
  );
  await assert.rejects(
    () => adapter.execute(runtimeContext()),
    (error: unknown) => error instanceof ExternalManagedRuntimeError
      && error.code === "EXTERNAL_MANAGED_PROVIDER_INSPECT_FAILED"
      && !error.message.includes("TOKEN")
      && !error.message.includes("sensitive.example")
  );
});

test("external managed provider registry is explicit and rejects duplicate provider identity", () => {
  const registry = new ExternalManagedBotProviderRegistry();
  registry.register(new FakeManagedProvider("provider-one"));
  assert.deepEqual(registry.ids(), ["provider-one"]);
  assert.equal(registry.has("provider-one"), true);
  assert.equal(registry.get("provider-one").id, "provider-one");
  assert.throws(
    () => registry.register(new FakeManagedProvider("provider-one")),
    assertExternalCode("EXTERNAL_MANAGED_PROVIDER_COLLISION")
  );
  assert.throws(
    () => registry.get("missing"),
    assertExternalCode("EXTERNAL_MANAGED_PROVIDER_NOT_REGISTERED")
  );
});

test("external managed binding rejects inline remote authentication and transport fields", () => {
  for (const extra of [
    { endpoint: "https://remote.example" },
    { token: "secret" },
    { authorization: "Bearer secret" },
    { ssh: "host" },
    { credential_ref: "secret:managed" }
  ]) {
    assert.throws(
      () => parseExternalManagedBinding({
        adapter: "external-managed",
        provider: "fake-managed",
        managed_bot_ref: "profile:research",
        binding_fingerprint: "binding:v1",
        ...extra
      }),
      assertExternalCode("EXTERNAL_MANAGED_REMOTE_AUTH_OUT_OF_SCOPE")
    );
  }
});

test("external managed adapter fails closed on live identity drift and provider contract drift", async () => {
  const cases: Array<{
    patch: Partial<ExternalManagedBotInspection>;
    code: string;
  }> = [
    { patch: { provider: "other" }, code: "EXTERNAL_MANAGED_IDENTITY_MISMATCH" },
    { patch: { managed_bot_ref: "profile:other" }, code: "EXTERNAL_MANAGED_IDENTITY_MISMATCH" },
    { patch: { binding_fingerprint: "binding:v2" }, code: "EXTERNAL_MANAGED_BINDING_DRIFT" },
    { patch: { availability: "offline" }, code: "EXTERNAL_MANAGED_NOT_READY" },
    { patch: { identity_mode: "temporary" as any }, code: "EXTERNAL_MANAGED_IDENTITY_CONTRACT_UNSUPPORTED" },
    { patch: { authority_mode: "provider_default" as any }, code: "EXTERNAL_MANAGED_AUTHORITY_CONTRACT_UNSUPPORTED" },
    { patch: { output_mode: "full_trace" as any }, code: "EXTERNAL_MANAGED_OUTPUT_CONTRACT_UNSUPPORTED" },
    { patch: { supports_cancel: false }, code: "EXTERNAL_MANAGED_CANCEL_UNSUPPORTED" }
  ];

  for (const item of cases) {
    const provider = new FakeManagedProvider();
    provider.inspection = { ...provider.inspection, ...item.patch };
    const adapter = new ExternalManagedBotRuntimeAdapter(
      new ExternalManagedBotProviderRegistry().register(provider)
    );
    await assert.rejects(() => adapter.execute(runtimeContext()), assertExternalCode(item.code));
    assert.equal(provider.executeCalls.length, 0);
  }
});

test("external managed adapter rechecks binding fingerprint after provider execution", async () => {
  const provider = new FakeManagedProvider();
  provider.result = { ...provider.result, binding_fingerprint: "binding:v2" };
  const adapter = new ExternalManagedBotRuntimeAdapter(
    new ExternalManagedBotProviderRegistry().register(provider)
  );
  await assert.rejects(
    () => adapter.execute(runtimeContext()),
    assertExternalCode("EXTERNAL_MANAGED_BINDING_DRIFT")
  );
});

test("external managed provider must explicitly report observed authority, even when empty", async () => {
  const provider = new FakeManagedProvider();
  provider.result = {
    ...provider.result,
    observed_tools: undefined as any
  };
  const adapter = new ExternalManagedBotRuntimeAdapter(
    new ExternalManagedBotProviderRegistry().register(provider)
  );
  await assert.rejects(
    () => adapter.execute(runtimeContext()),
    assertExternalCode("EXTERNAL_MANAGED_AUDIT_REQUIRED")
  );
});

test("external managed provider cannot report tools or connections outside the local lease", async () => {
  {
    const provider = new FakeManagedProvider();
    provider.result = { ...provider.result, observed_tools: ["github:write"] };
    const adapter = new ExternalManagedBotRuntimeAdapter(
      new ExternalManagedBotProviderRegistry().register(provider)
    );
    await assert.rejects(
      () => adapter.execute(runtimeContext()),
      assertExternalCode("EXTERNAL_MANAGED_AUTHORITY_VIOLATION")
    );
  }

  {
    const provider = new FakeManagedProvider();
    provider.result = { ...provider.result, observed_connections: ["drive:write"] };
    const adapter = new ExternalManagedBotRuntimeAdapter(
      new ExternalManagedBotProviderRegistry().register(provider)
    );
    await assert.rejects(
      () => adapter.execute(runtimeContext()),
      assertExternalCode("EXTERNAL_MANAGED_AUTHORITY_VIOLATION")
    );
  }
});

test("external managed Task leases must use exact references, never groups or wildcards", async () => {
  for (const tools of [
    ["*"],
    ["group:research"],
    ["github:*"],
    ["github:re?d"]
  ]) {
    const provider = new FakeManagedProvider();
    const adapter = new ExternalManagedBotRuntimeAdapter(
      new ExternalManagedBotProviderRegistry().register(provider)
    );
    await assert.rejects(
      () => adapter.execute(runtimeContext("fake-managed", tools, [])),
      assertExternalCode("EXTERNAL_MANAGED_BROAD_AUTHORITY_FORBIDDEN")
    );
    assert.equal(provider.inspectCalls.length, 0);
  }
});

test("Phase 4.5 external managed runtime is durable-Bot only and defers remote environment leases to Phase 4.7", async () => {
  {
    const provider = new FakeManagedProvider();
    const adapter = new ExternalManagedBotRuntimeAdapter(
      new ExternalManagedBotProviderRegistry().register(provider)
    );
    await assert.rejects(
      () => adapter.execute(runtimeContext("fake-managed", [], [], { principalKind: "worker" })),
      assertExternalCode("EXTERNAL_MANAGED_DURABLE_BOT_ONLY")
    );
  }

  {
    const provider = new FakeManagedProvider();
    const adapter = new ExternalManagedBotRuntimeAdapter(
      new ExternalManagedBotProviderRegistry().register(provider)
    );
    const environmentLease = stored("envlease_external", "environment_lease", "ws_external", {
      schema_version: "1.0",
      id: "envlease_external",
      type: "environment_lease",
      issued_to: "bot_external",
      workspace_id: "ws_external",
      task_id: "task_external",
      environment_policy: "external_managed",
      environment_ref: "env_remote",
      expires_at: "2030-01-01T00:00:00Z"
    });
    await assert.rejects(
      () => adapter.execute(runtimeContext("fake-managed", [], [], { environmentLease })),
      assertExternalCode("EXTERNAL_MANAGED_REMOTE_LEASE_OUT_OF_SCOPE")
    );
  }
});

test("external managed cancellation targets the pinned profile once and local cancellation survives provider cancel failure", async () => {
  const provider = new FakeManagedProvider();
  provider.holdExecution = true;
  provider.cancelThrows = true;
  const adapter = new ExternalManagedBotRuntimeAdapter(
    new ExternalManagedBotProviderRegistry().register(provider)
  );
  const controller = new AbortController();
  const running = adapter.execute(runtimeContext("fake-managed", [], [], { signal: controller.signal }));
  while (provider.executeCalls.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("operator canceled"));
  await adapter.cancel("task_external");
  await adapter.cancel("task_external");
  await assert.rejects(() => running, /operator canceled/);
  assert.equal(provider.cancelCalls.length, 1);
  assert.deepEqual(provider.cancelCalls[0], {
    localTaskId: "task_external",
    managedBotRef: "profile:research",
    expectedBindingFingerprint: "binding:v1"
  });
});

test("Bot registry reserves one external persistent profile for one canonical Bot identity globally", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  try {
    gateway.createBot(externalBot("bot_one", "ws_one"));
    assert.throws(
      () => gateway.createBot(externalBot("bot_two", "ws_two")),
      assertRegistryCode("EXTERNAL_MANAGED_BINDING_COLLISION")
    );
    assert.throws(
      () => gateway.createBot(externalBot("bot_alias", "ws_two", {
        managedBotRef: "profile:alias",
        bindingFingerprint: "binding:v1"
      })),
      assertRegistryCode("EXTERNAL_MANAGED_BINDING_COLLISION")
    );

    const differentProvider = gateway.createBot(externalBot("bot_other-provider", "ws_two", {
      provider: "other-provider",
      managedBotRef: "profile:research",
      bindingFingerprint: "binding:v1"
    }));
    assert.equal(differentProvider.id, "bot_other-provider");

    gateway.transitionBot("bot_one", "archived", "operator_local");
    assert.throws(
      () => gateway.createBot(externalBot("bot_reuse-archived", "ws_three")),
      assertRegistryCode("EXTERNAL_MANAGED_BINDING_COLLISION")
    );
  } finally {
    store.close();
  }
});

test("external managed Bot rebind preserves canonical Bot identity and requires explicit disabled operator flow", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  try {
    const original: BotManifest = {
      ...externalBot("bot_rebind", "ws_rebind", { status: "active" }),
      runtime: { adapter: "deterministic" },
      execution: { environment_policy: "shared_workspace" }
    };
    gateway.createBot(original);

    assert.throws(
      () => gateway.rebindExternalManagedBot("bot_rebind", {
        provider: "fake-managed",
        managedBotRef: "profile:new",
        bindingFingerprint: "binding:new"
      }, "operator_local"),
      assertRegistryCode("EXTERNAL_MANAGED_REBIND_REQUIRES_DISABLED")
    );

    gateway.transitionBot("bot_rebind", "disabled", "operator_local");
    assert.throws(
      () => gateway.rebindExternalManagedBot("bot_rebind", {
        provider: "fake-managed",
        managedBotRef: "profile:new",
        bindingFingerprint: "binding:new"
      }, "bot_intruder"),
      /Only an operator/
    );

    const rebound = gateway.rebindExternalManagedBot("bot_rebind", {
      provider: "fake-managed",
      managedBotRef: "profile:new",
      bindingFingerprint: "binding:new"
    }, "operator_local");
    assert.equal(rebound.id, "bot_rebind");
    assert.equal(rebound.payload.runtime.adapter, "external-managed");
    assert.equal(rebound.payload.runtime.provider, "fake-managed");
    assert.equal(rebound.payload.runtime.managed_bot_ref, "profile:new");
    assert.equal(rebound.payload.runtime.binding_fingerprint, "binding:new");
    assert.equal(rebound.payload.execution.environment_policy, "external_managed");
    assert.equal(rebound.payload.status, "disabled");

    const activated = gateway.transitionBot("bot_rebind", "active", "operator_local");
    assert.equal(activated.id, "bot_rebind");
    assert.equal(activated.payload.status, "active");
    assert.ok(store.listEventsAfter(0, 100).some((entry) => entry.event.type === "bot.runtime_rebound"));
  } finally {
    store.close();
  }
});

test("external managed rebind rechecks that a disabled Bot owns no live work", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  try {
    const original: BotManifest = {
      ...externalBot("bot_live-rebind", "ws_live-rebind", { status: "active" }),
      runtime: { adapter: "deterministic" },
      execution: { environment_policy: "shared_workspace" }
    };
    gateway.createBot(original);
    gateway.transitionBot("bot_live-rebind", "disabled", "operator_local");

    store.putObject("task", {
      schema_version: "1.0",
      id: "task_live-rebind",
      type: "task.delegate",
      created_by: "operator_local",
      assignee_id: "bot_live-rebind",
      owner_id: "bot_live-rebind",
      workspace_id: "ws_live-rebind",
      root_objective_id: "obj_live-rebind",
      reason: "Safety fixture",
      objective: "Remain live",
      required_constraints: [],
      expected_output: {},
      input_artifact_refs: [],
      lease_id: "lease_live-rebind",
      environment_lease_id: null,
      response_target: null,
      deadline_at: null,
      budget: {},
      approval_id: null,
      hop: 0,
      max_hops: 6,
      status: "assigned"
    });

    assert.throws(
      () => gateway.rebindExternalManagedBot("bot_live-rebind", {
        provider: "fake-managed",
        managedBotRef: "profile:new",
        bindingFingerprint: "binding:new"
      }, "operator_local"),
      assertRegistryCode("BOT_HAS_LIVE_WORK")
    );
  } finally {
    store.close();
  }
});

test("external managed rebind cannot steal another Bot's ref or fingerprint", () => {
  const store = new CoordinationStore(":memory:");
  const gateway = new CoordinationGateway(store);
  try {
    gateway.createBot(externalBot("bot_owner", "ws_one"));
    const candidate: BotManifest = {
      ...externalBot("bot_candidate", "ws_two", {
        provider: "candidate-provider",
        managedBotRef: "candidate-ref",
        bindingFingerprint: "candidate-fingerprint",
        status: "disabled"
      })
    };
    gateway.createBot(candidate);

    assert.throws(
      () => gateway.rebindExternalManagedBot("bot_candidate", {
        provider: "fake-managed",
        managedBotRef: "profile:research",
        bindingFingerprint: "new-fingerprint"
      }, "operator_local"),
      assertRegistryCode("EXTERNAL_MANAGED_BINDING_COLLISION")
    );
    assert.throws(
      () => gateway.rebindExternalManagedBot("bot_candidate", {
        provider: "fake-managed",
        managedBotRef: "different-ref",
        bindingFingerprint: "binding:v1"
      }, "operator_local"),
      assertRegistryCode("EXTERNAL_MANAGED_BINDING_COLLISION")
    );
  } finally {
    store.close();
  }
});

test("external managed Bot manifest validation requires pinned provider/ref/fingerprint and external_managed policy", () => {
  for (const manifest of [
    {
      ...externalBot(),
      runtime: { adapter: "external-managed" }
    },
    {
      ...externalBot(),
      execution: { environment_policy: "shared_workspace" }
    }
  ]) {
    assert.throws(
      () => validateBotManifest(manifest),
      (error: unknown) => error instanceof ProtocolValidationError
    );
  }
});

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
      res.on("end", () => resolve({
        status: Number(res.statusCode),
        body: JSON.parse(chunks.join("") || "{}")
      }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test("Gateway registers external-managed runtime, host providers, and the operator rebind endpoint", async () => {
  const dbPath = `/tmp/ai-verse-external-managed-${randomUUID()}.db`;
  const provider = new FakeManagedProvider();
  const service = createGatewayServer({
    dbPath,
    port: 0,
    externalManagedProviders: [provider]
  });
  const address = await service.listen();
  await service.supervisor.waitForIdle();
  try {
    assert.equal(service.runtimes.has(EXTERNAL_MANAGED_RUNTIME_ADAPTER_ID), true);
    assert.equal(service.runtimes.get(EXTERNAL_MANAGED_RUNTIME_ADAPTER_ID).id, EXTERNAL_MANAGED_RUNTIME_ADAPTER_ID);
    assert.deepEqual(service.externalManagedProviders.ids(), ["fake-managed"]);

    const original: BotManifest = {
      ...externalBot("bot_http-managed", "ws_http", { status: "active" }),
      runtime: { adapter: "deterministic" },
      execution: { environment_policy: "shared_workspace" }
    };
    const created = await httpJson(address.port, "POST", "/v1/bots", original);
    assert.equal(created.status, 201);
    const disabled = await httpJson(address.port, "POST", "/v1/bots/bot_http-managed/disable", {
      actorId: "operator_local"
    });
    assert.equal(disabled.status, 200);

    const rebound = await httpJson(
      address.port,
      "POST",
      "/v1/bots/bot_http-managed/external-managed/rebind",
      {
        actorId: "operator_local",
        provider: "fake-managed",
        managedBotRef: "profile:http",
        bindingFingerprint: "binding:http"
      }
    );
    assert.equal(rebound.status, 200);
    assert.equal(rebound.body.id, "bot_http-managed");
    assert.equal(rebound.body.payload.runtime.adapter, "external-managed");
    assert.equal(rebound.body.payload.runtime.managed_bot_ref, "profile:http");
    assert.equal(rebound.body.payload.status, "disabled");
  } finally {
    await service.close();
  }
});
