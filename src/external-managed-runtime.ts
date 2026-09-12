import type { RuntimeUsage } from "./budget.js";
import type { RuntimeAdapter, RuntimeExecutionContext, RuntimeExecutionResult } from "./runtime.js";
import type { JsonObject } from "./types.js";

export const EXTERNAL_MANAGED_RUNTIME_ADAPTER_ID = "external-managed";
export const EXTERNAL_MANAGED_RUNTIME_ENVELOPE = "ai-verse-multiple-bots/external-managed-envelope-v1";
export const EXTERNAL_MANAGED_MAX_ENVELOPE_BYTES = 512 * 1024;
export const EXTERNAL_MANAGED_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export class ExternalManagedRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ExternalManagedRuntimeError";
  }
}

export interface ExternalManagedBotBinding {
  provider: string;
  managedBotRef: string;
  bindingFingerprint: string;
}

export interface ExternalManagedBotInspection {
  provider: string;
  managed_bot_ref: string;
  binding_fingerprint: string;
  availability: "ready" | "offline" | "blocked";
  identity_mode: "persistent_profile";
  authority_mode: "exact_task_lease";
  output_mode: "visible_result_only";
  supports_cancel: boolean;
}

export interface ExternalManagedBotExecuteRequest {
  localTaskId: string;
  idempotencyKey: string;
  managedBotRef: string;
  expectedBindingFingerprint: string;
  principalId: string;
  workspaceId: string;
  envelope: JsonObject;
  allowedTools: string[];
  allowedConnections: string[];
  destructiveActions: string;
  signal: AbortSignal;
}

export interface ExternalManagedBotExecutionResult {
  managed_execution_id: string;
  binding_fingerprint: string;
  summary?: string;
  output: JsonObject;
  usage?: RuntimeUsage;
  observed_tools: string[];
  observed_connections: string[];
}

export interface ExternalManagedBotCancelRequest {
  localTaskId: string;
  managedBotRef: string;
  expectedBindingFingerprint: string;
}

export interface ExternalManagedBotProvider {
  readonly id: string;
  inspect(managedBotRef: string, signal: AbortSignal): Promise<ExternalManagedBotInspection>;
  execute(request: ExternalManagedBotExecuteRequest): Promise<ExternalManagedBotExecutionResult>;
  cancel(request: ExternalManagedBotCancelRequest): Promise<void>;
}

interface ActiveManagedExecution {
  provider: ExternalManagedBotProvider;
  binding: ExternalManagedBotBinding;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function safeOpaqueString(value: unknown, label: string, max = 1024): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_INVALID_BINDING", `${label} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > max || /[\0\r\n]/.test(result)) {
    throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_INVALID_BINDING", `${label} is invalid or too long`);
  }
  return result;
}

export function parseExternalManagedBinding(runtimeValue: unknown): ExternalManagedBotBinding {
  const runtime = asObject(runtimeValue);
  if (!runtime) {
    throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_INVALID_BINDING", "External managed runtime config must be an object");
  }
  if (runtime.adapter !== EXTERNAL_MANAGED_RUNTIME_ADAPTER_ID) {
    throw new ExternalManagedRuntimeError(
      "EXTERNAL_MANAGED_INVALID_BINDING",
      `runtime.adapter must equal ${EXTERNAL_MANAGED_RUNTIME_ADAPTER_ID}`
    );
  }

  for (const key of [
    "endpoint",
    "url",
    "host",
    "port",
    "api_key",
    "api_key_env",
    "token",
    "bearer_token",
    "bearer_token_env",
    "authorization",
    "headers",
    "ssh",
    "websocket_url",
    "remote_machine",
    "credential_ref",
    "secret_ref"
  ]) {
    if (runtime[key] !== undefined && runtime[key] !== null) {
      throw new ExternalManagedRuntimeError(
        "EXTERNAL_MANAGED_REMOTE_AUTH_OUT_OF_SCOPE",
        `runtime.${key} is not supported in Phase 4.5; remote-machine identity/authentication belongs to Phase 4.6`
      );
    }
  }

  return {
    provider: safeOpaqueString(runtime.provider, "runtime.provider", 256),
    managedBotRef: safeOpaqueString(runtime.managed_bot_ref, "runtime.managed_bot_ref", 1024),
    bindingFingerprint: safeOpaqueString(runtime.binding_fingerprint, "runtime.binding_fingerprint", 512)
  };
}

export function externalManagedBindingKey(binding: ExternalManagedBotBinding): string {
  return `${binding.provider}\u0000${binding.managedBotRef}`;
}

export function externalManagedFingerprintKey(binding: ExternalManagedBotBinding): string {
  return `${binding.provider}\u0000${binding.bindingFingerprint}`;
}

function exactRefs(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_INVALID_LEASE", `${label} must be an array`);
  }
  const refs = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_INVALID_LEASE", `${label} contains an invalid reference`);
    }
    const ref = item.trim();
    if (ref.length > 512 || /[\0\r\n]/.test(ref)) {
      throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_INVALID_LEASE", `${label} contains an invalid or oversized reference`);
    }
    if (ref.startsWith("group:") || /[*?\[\]]/.test(ref)) {
      throw new ExternalManagedRuntimeError(
        "EXTERNAL_MANAGED_BROAD_AUTHORITY_FORBIDDEN",
        `${label} must contain exact references; ${JSON.stringify(ref)} is too broad`
      );
    }
    refs.add(ref);
  }
  return [...refs].sort();
}

function assertSubset(observed: string[], allowed: string[], label: string): void {
  const allow = new Set(allowed);
  for (const ref of observed) {
    if (!allow.has(ref)) {
      throw new ExternalManagedRuntimeError(
        "EXTERNAL_MANAGED_AUTHORITY_VIOLATION",
        `External managed provider reported ${label} ${JSON.stringify(ref)} outside the local Task lease`
      );
    }
  }
}

function boundedJsonObject(value: unknown, maxBytes: number, label: string): JsonObject {
  const object = asObject(value);
  if (!object) {
    throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_INVALID_RESULT", `${label} must be an object`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(object);
  } catch {
    throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_INVALID_RESULT", `${label} is not JSON serializable`);
  }
  if (byteLength(serialized) > maxBytes) {
    throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_RESULT_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
  }
  return object;
}

function boundedEnvelope(value: JsonObject): JsonObject {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_INVALID_ENVELOPE", "External managed execution envelope is not JSON serializable");
  }
  if (byteLength(serialized) > EXTERNAL_MANAGED_MAX_ENVELOPE_BYTES) {
    throw new ExternalManagedRuntimeError(
      "EXTERNAL_MANAGED_ENVELOPE_TOO_LARGE",
      `External managed execution envelope exceeds ${EXTERNAL_MANAGED_MAX_ENVELOPE_BYTES} bytes`
    );
  }
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function runtimeEnvelope(
  context: RuntimeExecutionContext,
  binding: ExternalManagedBotBinding,
  tools: string[],
  connections: string[]
): JsonObject {
  return boundedEnvelope({
    contract: EXTERNAL_MANAGED_RUNTIME_ENVELOPE,
    execution_identity: {
      principal_id: context.principal.id,
      principal_kind: context.principalKind,
      workspace_id: context.task.workspaceId
    },
    external_binding: {
      provider: binding.provider,
      managed_bot_ref: binding.managedBotRef,
      binding_fingerprint: binding.bindingFingerprint
    },
    task: {
      id: context.task.id,
      run_id: context.task.payload.run_id ?? null,
      root_objective_id: context.task.payload.root_objective_id ?? null,
      objective: context.task.payload.objective ?? null,
      required_constraints: stringArray(context.task.payload.required_constraints),
      expected_output: asObject(context.task.payload.expected_output) ?? {}
    },
    authority: {
      lease_id: context.capabilityLease.id,
      tools,
      connections,
      destructive_actions: context.capabilityLease.payload.destructive_actions ?? "deny",
      environment_lease_id: null,
      rule: "The external provider must enforce exactly this Task lease. External profile state cannot widen local authority."
    },
    workspace_projection: context.workspaceProjection ? {
      provider: context.workspaceProjection.provider,
      workspace_id: context.workspaceProjection.workspace_id,
      projection_digest: context.workspaceProjection.projection_digest,
      data: context.workspaceProjection.data
    } : null,
    strategic_intent: context.strategicIntent ? {
      provider: context.strategicIntent.provider,
      workspace_id: context.strategicIntent.workspace_id,
      root_objective_id: context.strategicIntent.root_objective_id,
      intent_digest: context.strategicIntent.intent_digest,
      data: context.strategicIntent.data
    } : null,
    historical_recall: context.historicalRecall ? {
      provider: context.historicalRecall.provider,
      workspace_id: context.historicalRecall.workspace_id,
      recall_digest: context.historicalRecall.recall_digest,
      items: context.historicalRecall.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        type: item.type,
        scope: item.scope,
        content: item.content,
        why: item.why ?? null,
        path: item.path,
        digest: item.digest
      }))
    } : null,
    resolved_skills: context.skillsCapabilityResolution ? {
      provider: context.skillsCapabilityResolution.provider,
      workspace_id: context.skillsCapabilityResolution.workspace_id,
      resolution_digest: context.skillsCapabilityResolution.resolution_digest,
      capabilities: context.skillsCapabilityResolution.capabilities.map((capability) => ({
        requested_ref: capability.requested_ref,
        id: capability.id,
        name: capability.name,
        description: capability.description,
        provider: capability.provider,
        version: capability.version,
        generation_id: capability.generation_id,
        digest: capability.digest,
        instructions: capability.instructions,
        instruction_digest: capability.instruction_digest
      }))
    } : null,
    input_artifacts: context.inputArtifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.payload.kind ?? null,
      version: artifact.payload.version ?? null,
      inline_content: artifact.payload.inline_content ?? null,
      content_ref: artifact.payload.content_ref ?? null,
      provenance: artifact.payload.provenance ?? null
    }))
  });
}

function nonNegative(value: unknown, label: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_INVALID_USAGE", `${label} must be a non-negative finite number`);
  }
  return value;
}

function normalizeUsage(value: RuntimeUsage | undefined): RuntimeUsage {
  const usage = value ?? {};
  return {
    input_tokens: Math.floor(nonNegative(usage.input_tokens, "usage.input_tokens")),
    output_tokens: Math.floor(nonNegative(usage.output_tokens, "usage.output_tokens")),
    cost: nonNegative(usage.cost, "usage.cost"),
    actions: Math.max(1, Math.floor(nonNegative(usage.actions, "usage.actions")))
  };
}

function assertInspection(
  inspection: ExternalManagedBotInspection,
  binding: ExternalManagedBotBinding
): void {
  if (inspection.provider !== binding.provider) {
    throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_IDENTITY_MISMATCH", "External provider identity does not match the pinned provider");
  }
  if (inspection.managed_bot_ref !== binding.managedBotRef) {
    throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_IDENTITY_MISMATCH", "External provider resolved a different managed Bot reference");
  }
  if (inspection.binding_fingerprint !== binding.bindingFingerprint) {
    throw new ExternalManagedRuntimeError(
      "EXTERNAL_MANAGED_BINDING_DRIFT",
      "External managed Bot binding fingerprint changed; operator re-binding is required before execution"
    );
  }
  if (inspection.availability !== "ready") {
    throw new ExternalManagedRuntimeError(
      "EXTERNAL_MANAGED_NOT_READY",
      `External managed Bot is ${inspection.availability}, not ready`
    );
  }
  if (inspection.identity_mode !== "persistent_profile") {
    throw new ExternalManagedRuntimeError(
      "EXTERNAL_MANAGED_IDENTITY_CONTRACT_UNSUPPORTED",
      "Provider must expose a persistent-profile identity contract"
    );
  }
  if (inspection.authority_mode !== "exact_task_lease") {
    throw new ExternalManagedRuntimeError(
      "EXTERNAL_MANAGED_AUTHORITY_CONTRACT_UNSUPPORTED",
      "Provider must enforce exact Task-scoped lease authority"
    );
  }
  if (inspection.output_mode !== "visible_result_only") {
    throw new ExternalManagedRuntimeError(
      "EXTERNAL_MANAGED_OUTPUT_CONTRACT_UNSUPPORTED",
      "Provider must return visible publishable result data only"
    );
  }
  if (inspection.supports_cancel !== true) {
    throw new ExternalManagedRuntimeError(
      "EXTERNAL_MANAGED_CANCEL_UNSUPPORTED",
      "External managed Bot provider must support cancellation"
    );
  }
}

export class ExternalManagedBotProviderRegistry {
  private readonly providers = new Map<string, ExternalManagedBotProvider>();

  register(provider: ExternalManagedBotProvider): this {
    const id = safeOpaqueString(provider.id, "provider.id", 256);
    if (this.providers.has(id)) {
      throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_PROVIDER_COLLISION", `External managed provider ${id} is already registered`);
    }
    this.providers.set(id, provider);
    return this;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): ExternalManagedBotProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_PROVIDER_NOT_REGISTERED", `External managed provider ${id} is not registered`);
    }
    return provider;
  }

  ids(): string[] {
    return [...this.providers.keys()].sort();
  }
}

export class ExternalManagedBotRuntimeAdapter implements RuntimeAdapter {
  readonly id = EXTERNAL_MANAGED_RUNTIME_ADAPTER_ID;
  private readonly active = new Map<string, ActiveManagedExecution>();

  constructor(readonly providers: ExternalManagedBotProviderRegistry = new ExternalManagedBotProviderRegistry()) {}

  async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
    if (context.principalKind !== "bot" || !context.bot) {
      throw new ExternalManagedRuntimeError(
        "EXTERNAL_MANAGED_DURABLE_BOT_ONLY",
        "Phase 4.5 external-managed execution is only valid for durable Bots"
      );
    }
    const execution = asObject(context.bot.payload.execution) ?? {};
    if (execution.environment_policy !== "external_managed") {
      throw new ExternalManagedRuntimeError(
        "EXTERNAL_MANAGED_ENVIRONMENT_POLICY_REQUIRED",
        "External managed Bots must use execution.environment_policy=external_managed"
      );
    }
    if (context.environmentLease) {
      throw new ExternalManagedRuntimeError(
        "EXTERNAL_MANAGED_REMOTE_LEASE_OUT_OF_SCOPE",
        "Phase 4.5 does not accept external environment leases; remote capability/environment leases belong to Phase 4.7"
      );
    }

    const binding = parseExternalManagedBinding(context.runtime);
    const provider = this.providers.get(binding.provider);
    const tools = exactRefs(context.capabilityLease.payload.tools, "capabilityLease.tools");
    const connections = exactRefs(context.capabilityLease.payload.connections, "capabilityLease.connections");
    const destructiveActions = typeof context.capabilityLease.payload.destructive_actions === "string"
      ? context.capabilityLease.payload.destructive_actions
      : "deny";

    const active: ActiveManagedExecution = { provider, binding };
    this.active.set(context.task.id, active);
    const abortFromParent = () => { void this.cancel(context.task.id); };
    if (context.signal.aborted) abortFromParent();
    else context.signal.addEventListener("abort", abortFromParent, { once: true });

    try {
      const inspection = await provider.inspect(binding.managedBotRef, context.signal);
      assertInspection(inspection, binding);

      const result = await provider.execute({
        localTaskId: context.task.id,
        idempotencyKey: `aiverse:${context.task.id}`,
        managedBotRef: binding.managedBotRef,
        expectedBindingFingerprint: binding.bindingFingerprint,
        principalId: context.principal.id,
        workspaceId: String(context.task.workspaceId ?? ""),
        envelope: runtimeEnvelope(context, binding, tools, connections),
        allowedTools: tools,
        allowedConnections: connections,
        destructiveActions,
        signal: context.signal
      });

      const executionId = safeOpaqueString(result.managed_execution_id, "result.managed_execution_id", 1024);
      if (result.binding_fingerprint !== binding.bindingFingerprint) {
        throw new ExternalManagedRuntimeError(
          "EXTERNAL_MANAGED_BINDING_DRIFT",
          "External managed Bot binding changed between inspection and execution"
        );
      }
      const observedTools = exactRefs(result.observed_tools, "result.observed_tools");
      const observedConnections = exactRefs(result.observed_connections, "result.observed_connections");
      assertSubset(observedTools, tools, "tool");
      assertSubset(observedConnections, connections, "connection");
      const output = boundedJsonObject(result.output, EXTERNAL_MANAGED_MAX_OUTPUT_BYTES, "result.output");
      const usage = normalizeUsage(result.usage);
      const rawSummary = typeof result.summary === "string" ? result.summary.trim() : "";
      if (rawSummary.length > 4096 || /\0/.test(rawSummary)) {
        throw new ExternalManagedRuntimeError("EXTERNAL_MANAGED_INVALID_RESULT", "result.summary is invalid or too long");
      }
      const summary = rawSummary || "External managed Bot completed the delegated Task.";

      return {
        summary,
        artifactKind: "external_managed_task_result",
        output: {
          ...output,
          executed_by: context.principal.id,
          execution_principal_kind: context.principalKind,
          managed_execution_id: executionId
        },
        usage,
        receipts: [{
          kind: "external_managed_execution",
          adapter: this.id,
          provider: binding.provider,
          local_task_id: context.task.id,
          principal_kind: context.principalKind,
          managed_execution_id: executionId,
          binding_verified: true,
          identity_mode: "persistent_profile",
          authority_mode: "exact_task_lease",
          output_mode: "visible_result_only",
          cancellation_supported: true,
          allowed_tool_count: tools.length,
          allowed_connection_count: connections.length,
          observed_tool_count: observedTools.length,
          observed_connection_count: observedConnections.length,
          idempotency_contract: "local_task_id",
          remote_authentication: "host_injected_provider_only_phase_4_5",
          remote_environment_leases: "not_supported_phase_4_5"
        }]
      };
    } finally {
      this.active.delete(context.task.id);
      context.signal.removeEventListener("abort", abortFromParent);
    }
  }

  async cancel(taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) return;
    try {
      await active.provider.cancel({
        localTaskId: taskId,
        managedBotRef: active.binding.managedBotRef,
        expectedBindingFingerprint: active.binding.bindingFingerprint
      });
    } catch {
      // Local cancellation remains authoritative. Provider cancellation is required
      // by the binding contract but its failure cannot reverse local cancellation.
    }
  }
}
