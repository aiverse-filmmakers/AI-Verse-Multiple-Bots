import type { RuntimeUsage } from "./budget.js";
import type { RuntimeAdapter, RuntimeExecutionContext, RuntimeExecutionResult } from "./runtime.js";
import {
  RemoteLeaseBroker,
  RemoteLeaseError,
  type RemoteLeaseAudit,
  type RemoteLeaseGrant
} from "./remote-leases.js";
import {
  RemoteRecoveryStore,
  remoteOperationKey
} from "./remote-recovery.js";
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
  idempotency_mode?: "best_effort" | "exact_task_key";
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
  remoteLease?: JsonObject | null;
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
  remote_lease_receipt?: JsonObject | null;
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
  cancelStarted: boolean;
  remoteLeaseGrant: RemoteLeaseGrant | null;
  remoteLeaseTarget: { kind: "managed_profile"; ref: string } | null;
  leaseRevokeStarted: boolean;
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
        `runtime.${key} must not embed remote authentication; use a host-injected provider and the Phase 4.6 trust/auth boundary`
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

function exactReportedRefs(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new ExternalManagedRuntimeError(
      "EXTERNAL_MANAGED_AUDIT_REQUIRED",
      `${label} must be an explicit array, including when no authority was used`
    );
  }
  return exactRefs(value, label);
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

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("External managed Task canceled");
  }
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error("External managed Task canceled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        resolvePromise(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        rejectPromise(error);
      }
    );
  });
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

function managedRetryAttempts(runtime: JsonObject): number {
  const raw = runtime.remote_retry_max_attempts;
  if (raw === undefined || raw === null) return 3;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 5) {
    throw new ExternalManagedRuntimeError(
      "EXTERNAL_MANAGED_INVALID_CONFIG",
      "runtime.remote_retry_max_attempts must be an integer between 1 and 5"
    );
  }
  return raw;
}

function managedRetryDelayMs(runtime: JsonObject): number {
  const raw = runtime.remote_retry_base_delay_ms;
  if (raw === undefined || raw === null) return 100;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 25 || raw > 5_000) {
    throw new ExternalManagedRuntimeError(
      "EXTERNAL_MANAGED_INVALID_CONFIG",
      "runtime.remote_retry_base_delay_ms must be an integer between 25 and 5000"
    );
  }
  return raw;
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  await raceWithAbort(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

function runtimeEnvelope(
  context: RuntimeExecutionContext,
  binding: ExternalManagedBotBinding,
  tools: string[],
  connections: string[],
  destructiveActions: string,
  remoteLeaseApplied: boolean
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
      destructive_actions: destructiveActions,
      environment_lease_id: context.environmentLease?.id ?? null,
      remote_lease_applied: remoteLeaseApplied,
      rule: "The external provider must enforce exactly this effective Task lease. External profile state cannot widen local authority."
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

  constructor(
    readonly providers: ExternalManagedBotProviderRegistry = new ExternalManagedBotProviderRegistry(),
    readonly remoteLeases: RemoteLeaseBroker | null = null,
    readonly recovery: RemoteRecoveryStore | null = null
  ) {}

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
    const binding = parseExternalManagedBinding(context.runtime);
    const remoteLeaseProvider = typeof context.runtime.remote_lease_provider === "string"
      && context.runtime.remote_lease_provider.trim()
      ? context.runtime.remote_lease_provider.trim()
      : null;
    if (context.environmentLease && !remoteLeaseProvider) {
      throw new ExternalManagedRuntimeError(
        "EXTERNAL_MANAGED_REMOTE_LEASE_PROVIDER_REQUIRED",
        "External managed environment authority requires runtime.remote_lease_provider"
      );
    }
    if (remoteLeaseProvider && !this.remoteLeases) {
      throw new ExternalManagedRuntimeError(
        "EXTERNAL_MANAGED_REMOTE_LEASE_BROKER_REQUIRED",
        "runtime.remote_lease_provider requires a configured RemoteLeaseBroker"
      );
    }
    const provider = this.providers.get(binding.provider);
    const tools = exactRefs(context.capabilityLease.payload.tools, "capabilityLease.tools");
    const connections = exactRefs(context.capabilityLease.payload.connections, "capabilityLease.connections");
    const destructiveActions = typeof context.capabilityLease.payload.destructive_actions === "string"
      ? context.capabilityLease.payload.destructive_actions
      : "deny";

    const active: ActiveManagedExecution = {
      provider,
      binding,
      cancelStarted: false,
      remoteLeaseGrant: null,
      remoteLeaseTarget: null,
      leaseRevokeStarted: false
    };
    this.active.set(context.task.id, active);
    const abortFromParent = () => { void this.cancel(context.task.id); };
    if (context.signal.aborted) abortFromParent();
    else context.signal.addEventListener("abort", abortFromParent, { once: true });

    try {
      let inspection: ExternalManagedBotInspection;
      try {
        inspection = await raceWithAbort(
          provider.inspect(binding.managedBotRef, context.signal),
          context.signal
        );
      } catch {
        if (context.signal.aborted) {
          throw context.signal.reason instanceof Error ? context.signal.reason : new Error("External managed Task canceled");
        }
        throw new ExternalManagedRuntimeError(
          "EXTERNAL_MANAGED_PROVIDER_INSPECT_FAILED",
          `External managed provider ${binding.provider} could not verify the pinned Bot identity`
        );
      }
      assertInspection(inspection, binding);

      let remoteLeaseAudit: RemoteLeaseAudit | null = null;
      if (remoteLeaseProvider) {
        try {
          active.remoteLeaseTarget = {
            kind: "managed_profile",
            ref: `${binding.provider}::${binding.managedBotRef}`
          };
          active.remoteLeaseGrant = await this.remoteLeases!.grant(
            remoteLeaseProvider,
            context,
            active.remoteLeaseTarget
          );
        } catch (error) {
          if (error instanceof RemoteLeaseError) {
            throw new ExternalManagedRuntimeError(error.code, error.message);
          }
          throw error;
        }
      }

      let result: ExternalManagedBotExecutionResult;
      try {
        result = await raceWithAbort(provider.execute({
        localTaskId: context.task.id,
        idempotencyKey: `aiverse:${context.task.id}`,
        managedBotRef: binding.managedBotRef,
        expectedBindingFingerprint: binding.bindingFingerprint,
        principalId: context.principal.id,
        workspaceId: String(context.task.workspaceId ?? ""),
        envelope: runtimeEnvelope(
          context,
          binding,
          active.remoteLeaseGrant?.granted_tools ?? tools,
          active.remoteLeaseGrant?.granted_connections ?? connections,
          active.remoteLeaseGrant?.destructive_actions ?? destructiveActions,
          Boolean(active.remoteLeaseGrant)
        ),
        allowedTools: active.remoteLeaseGrant?.granted_tools ?? tools,
        allowedConnections: active.remoteLeaseGrant?.granted_connections ?? connections,
          destructiveActions: active.remoteLeaseGrant?.destructive_actions ?? destructiveActions,
          ...(active.remoteLeaseGrant ? {
            remoteLease: this.remoteLeases!.transportProjection(active.remoteLeaseGrant)
          } : {}),
          signal: context.signal
        }), context.signal);
      } catch {
        if (context.signal.aborted) {
          throw context.signal.reason instanceof Error ? context.signal.reason : new Error("External managed Task canceled");
        }
        throw new ExternalManagedRuntimeError(
          "EXTERNAL_MANAGED_PROVIDER_EXECUTE_FAILED",
          `External managed provider ${binding.provider} failed delegated execution`
        );
      }

      const executionId = safeOpaqueString(result.managed_execution_id, "result.managed_execution_id", 1024);
      if (result.binding_fingerprint !== binding.bindingFingerprint) {
        throw new ExternalManagedRuntimeError(
          "EXTERNAL_MANAGED_BINDING_DRIFT",
          "External managed Bot binding changed between inspection and execution"
        );
      }
      const observedTools = exactReportedRefs(result.observed_tools, "result.observed_tools");
      const observedConnections = exactReportedRefs(result.observed_connections, "result.observed_connections");
      const effectiveTools = active.remoteLeaseGrant?.granted_tools ?? tools;
      const effectiveConnections = active.remoteLeaseGrant?.granted_connections ?? connections;
      assertSubset(observedTools, effectiveTools, "tool");
      assertSubset(observedConnections, effectiveConnections, "connection");
      if (active.remoteLeaseGrant) {
        const remoteReceipt = asObject(result.remote_lease_receipt);
        if (remoteReceipt) {
          const leaseObservedTools = exactReportedRefs(
            remoteReceipt.observed_tools,
            "result.remote_lease_receipt.observed_tools"
          );
          const leaseObservedConnections = exactReportedRefs(
            remoteReceipt.observed_connections,
            "result.remote_lease_receipt.observed_connections"
          );
          if (
            JSON.stringify(leaseObservedTools) !== JSON.stringify(observedTools)
            || JSON.stringify(leaseObservedConnections) !== JSON.stringify(observedConnections)
          ) {
            throw new ExternalManagedRuntimeError(
              "EXTERNAL_MANAGED_REMOTE_LEASE_AUDIT_MISMATCH",
              "External managed provider authority audit disagrees with its remote lease receipt"
            );
          }
        }
        try {
          remoteLeaseAudit = this.remoteLeases!.verifyReceipt(
            active.remoteLeaseGrant,
            result.remote_lease_receipt
          );
        } catch (error) {
          if (error instanceof RemoteLeaseError) {
            throw new ExternalManagedRuntimeError(error.code, error.message);
          }
          throw error;
        }
      }
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
          remote_authentication: "host_injected_provider",
          ...(active.remoteLeaseGrant && remoteLeaseAudit
            ? this.remoteLeases!.receiptProjection(active.remoteLeaseGrant, remoteLeaseAudit)
            : {
                remote_lease_verified: false,
                environment_verified: false
              })
        }]
      };
    } finally {
      if (active.remoteLeaseGrant && active.remoteLeaseTarget && !active.leaseRevokeStarted) {
        active.leaseRevokeStarted = true;
        void this.remoteLeases!.revoke(
          active.remoteLeaseGrant,
          context.task.id,
          active.remoteLeaseTarget
        ).catch(() => undefined);
      }
      this.active.delete(context.task.id);
      context.signal.removeEventListener("abort", abortFromParent);
    }
  }

  async cancel(taskId: string): Promise<void> {
    const active = this.active.get(taskId);
    if (!active || active.cancelStarted) return;
    active.cancelStarted = true;
    if (active.remoteLeaseGrant && active.remoteLeaseTarget && !active.leaseRevokeStarted) {
      active.leaseRevokeStarted = true;
      void this.remoteLeases!.revoke(
        active.remoteLeaseGrant,
        taskId,
        active.remoteLeaseTarget
      ).catch(() => undefined);
    }
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
