import { createHash } from "node:crypto";
import type { ExecutionPrincipalKind, RuntimeExecutionContext } from "./runtime.js";
import type { JsonObject, StoredObject } from "./types.js";

export const REMOTE_LEASE_A2A_EXTENSION_URI =
  "https://github.com/aiverse-filmmakers/AI-Verse-Multiple-Bots/extensions/remote-task-lease/v1";

export type RemoteLeaseTargetKind = "machine" | "managed_profile";

export interface RemoteLeaseTarget {
  kind: RemoteLeaseTargetKind;
  ref: string;
}

export interface RemoteEnvironmentProjection {
  local_lease_id: string;
  environment_policy: string;
  local_environment_ref: string;
  expires_at: string;
}

export interface RemoteLeaseGrantRequest {
  localTaskId: string;
  principalId: string;
  principalKind: ExecutionPrincipalKind;
  workspaceId: string;
  target: RemoteLeaseTarget;
  localCapabilityLeaseId: string;
  requestDigest: string;
  allowedTools: string[];
  allowedConnections: string[];
  destructiveActions: string;
  expiresAt: string;
  environment: RemoteEnvironmentProjection | null;
  signal: AbortSignal;
}

export interface RemoteLeaseGrant {
  provider: string;
  remote_lease_id: string;
  request_digest: string;
  grant_fingerprint: string;
  expires_at: string;
  granted_tools: string[];
  granted_connections: string[];
  destructive_actions: string;
  environment?: {
    environment_policy: string;
    remote_environment_ref: string;
  } | null;
}

export interface RemoteLeaseReceipt {
  remote_lease_id: string;
  request_digest: string;
  grant_fingerprint: string;
  observed_tools: string[];
  observed_connections: string[];
  environment_ref?: string | null;
  state: "honored";
}

export interface RemoteLeaseRevokeRequest {
  localTaskId: string;
  target: RemoteLeaseTarget;
  remoteLeaseId: string;
  grantFingerprint: string;
}

export interface RemoteLeaseProvider {
  readonly id: string;
  grant(request: RemoteLeaseGrantRequest): Promise<RemoteLeaseGrant>;
  revoke(request: RemoteLeaseRevokeRequest): Promise<void>;
}

export interface RemoteLeaseAudit {
  observedToolCount: number;
  observedConnectionCount: number;
  environmentVerified: boolean;
}

export class RemoteLeaseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteLeaseError";
  }
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function safeString(value: unknown, label: string, max = 2048): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RemoteLeaseError("REMOTE_LEASE_INVALID", `${label} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > max || /[\0\r\n]/.test(result)) {
    throw new RemoteLeaseError("REMOTE_LEASE_INVALID", `${label} is invalid or too long`);
  }
  return result;
}

function exactRefs(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RemoteLeaseError("REMOTE_LEASE_INVALID_AUTHORITY", `${label} must be an array`);
  }
  const refs = new Set<string>();
  for (const raw of value) {
    const ref = safeString(raw, label, 512);
    if (ref.startsWith("group:") || /[*?\[\]]/.test(ref)) {
      throw new RemoteLeaseError(
        "REMOTE_LEASE_BROAD_AUTHORITY_FORBIDDEN",
        `${label} must contain exact references; ${JSON.stringify(ref)} is too broad`
      );
    }
    refs.add(ref);
  }
  return [...refs].sort();
}

function exactReportedRefs(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new RemoteLeaseError(
      "REMOTE_LEASE_AUDIT_REQUIRED",
      `${label} must be an explicit array, including when no authority was used`
    );
  }
  return exactRefs(value, label);
}

function assertSubset(actual: string[], allowed: string[], label: string): void {
  const permitted = new Set(allowed);
  for (const ref of actual) {
    if (!permitted.has(ref)) {
      throw new RemoteLeaseError(
        "REMOTE_LEASE_AUTHORITY_EXPANSION",
        `Remote lease ${label} ${JSON.stringify(ref)} exceeds local authority`
      );
    }
  }
}

function actionRank(value: string): number {
  if (value === "deny") return 0;
  if (value === "approval_required") return 1;
  if (value === "allow") return 2;
  throw new RemoteLeaseError(
    "REMOTE_LEASE_INVALID_AUTHORITY",
    `Unsupported destructive_actions value ${JSON.stringify(value)}`
  );
}

function activeExpiry(lease: StoredObject, label: string): number {
  if (
    (lease.payload.revoked_at !== undefined && lease.payload.revoked_at !== null)
    || (lease.payload.termination_revoked_at !== undefined && lease.payload.termination_revoked_at !== null)
    || (lease.payload.cleanup_revoked_at !== undefined && lease.payload.cleanup_revoked_at !== null)
  ) {
    throw new RemoteLeaseError("REMOTE_LEASE_LOCAL_REVOKED", `${label} ${lease.id} has been revoked`);
  }
  const expiry = Date.parse(String(lease.payload.expires_at ?? ""));
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new RemoteLeaseError("REMOTE_LEASE_LOCAL_EXPIRED", `${label} ${lease.id} is expired`);
  }
  return expiry;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  const object = asObject(value);
  if (!object) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) result[key] = stable(object[key]);
  return result;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Remote lease grant canceled");
  }
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error("Remote lease grant canceled"));
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

function normalizedTarget(target: RemoteLeaseTarget): RemoteLeaseTarget {
  const kind = safeString(target?.kind, "remote lease target kind", 64) as RemoteLeaseTargetKind;
  if (kind !== "machine" && kind !== "managed_profile") {
    throw new RemoteLeaseError("REMOTE_LEASE_INVALID_TARGET", `Unsupported remote lease target kind ${kind}`);
  }
  return {
    kind,
    ref: safeString(target?.ref, "remote lease target ref", 1024)
  };
}

function localEnvironment(context: RuntimeExecutionContext): {
  projection: RemoteEnvironmentProjection | null;
  expiry: number | null;
} {
  if (!context.environmentLease) return { projection: null, expiry: null };
  const lease = context.environmentLease;
  if (lease.kind !== "environment_lease") {
    throw new RemoteLeaseError("REMOTE_LEASE_INVALID_ENVIRONMENT", "Runtime environment lease has the wrong kind");
  }
  if (lease.payload.issued_to !== context.principal.id) {
    throw new RemoteLeaseError("REMOTE_LEASE_INVALID_ENVIRONMENT", "Environment lease is issued to a different principal");
  }
  if (lease.workspaceId !== context.task.workspaceId) {
    throw new RemoteLeaseError("REMOTE_LEASE_INVALID_ENVIRONMENT", "Environment lease is outside the Task workspace");
  }
  if (typeof lease.payload.task_id === "string" && lease.payload.task_id !== context.task.id) {
    throw new RemoteLeaseError("REMOTE_LEASE_INVALID_ENVIRONMENT", "Environment lease is scoped to a different Task");
  }
  const expiry = activeExpiry(lease, "Environment lease");
  const environmentPolicy = safeString(
    lease.payload.environment_policy,
    "environmentLease.environment_policy",
    128
  );
  if (!["shared_workspace", "isolated_bot", "isolated_run", "external_managed"].includes(environmentPolicy)) {
    throw new RemoteLeaseError(
      "REMOTE_LEASE_INVALID_ENVIRONMENT",
      `Unsupported environment policy ${environmentPolicy}`
    );
  }
  return {
    projection: {
      local_lease_id: lease.id,
      environment_policy: environmentPolicy,
      local_environment_ref: safeString(
        lease.payload.environment_ref,
        "environmentLease.environment_ref",
        2048
      ),
      expires_at: new Date(expiry).toISOString()
    },
    expiry
  };
}

function localCapability(context: RuntimeExecutionContext): {
  tools: string[];
  connections: string[];
  destructiveActions: string;
  expiry: number;
} {
  const lease = context.capabilityLease;
  if (lease.kind !== "capability_lease") {
    throw new RemoteLeaseError("REMOTE_LEASE_INVALID_CAPABILITY", "Runtime capability lease has the wrong kind");
  }
  if (lease.payload.issued_to !== context.principal.id) {
    throw new RemoteLeaseError("REMOTE_LEASE_INVALID_CAPABILITY", "Capability lease is issued to a different principal");
  }
  if (lease.payload.task_id !== context.task.id) {
    throw new RemoteLeaseError("REMOTE_LEASE_INVALID_CAPABILITY", "Capability lease is scoped to a different Task");
  }
  if (lease.workspaceId !== context.task.workspaceId) {
    throw new RemoteLeaseError("REMOTE_LEASE_INVALID_CAPABILITY", "Capability lease is outside the Task workspace");
  }
  const expiry = activeExpiry(lease, "Capability lease");
  const destructiveActions = typeof lease.payload.destructive_actions === "string"
    ? lease.payload.destructive_actions
    : "deny";
  actionRank(destructiveActions);
  return {
    tools: exactRefs(lease.payload.tools, "capabilityLease.tools"),
    connections: exactRefs(lease.payload.connections, "capabilityLease.connections"),
    destructiveActions,
    expiry
  };
}

function boundedTaskDeadline(context: RuntimeExecutionContext): number | null {
  if (typeof context.task.payload.deadline_at !== "string" || !context.task.payload.deadline_at) return null;
  const deadline = Date.parse(context.task.payload.deadline_at);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) {
    throw new RemoteLeaseError("REMOTE_LEASE_TASK_DEADLINE", "Task deadline is invalid or has elapsed");
  }
  return deadline;
}

export class RemoteLeaseProviderRegistry {
  private readonly providers = new Map<string, RemoteLeaseProvider>();

  constructor(providers: RemoteLeaseProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: RemoteLeaseProvider): this {
    const id = safeString(provider.id, "remote lease provider id", 256);
    if (this.providers.has(id)) {
      throw new RemoteLeaseError("REMOTE_LEASE_PROVIDER_COLLISION", `Remote lease provider ${id} is already registered`);
    }
    this.providers.set(id, provider);
    return this;
  }

  get(id: string): RemoteLeaseProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new RemoteLeaseError("REMOTE_LEASE_PROVIDER_NOT_REGISTERED", `Remote lease provider ${id} is not registered`);
    }
    return provider;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  ids(): string[] {
    return [...this.providers.keys()].sort();
  }
}

export class RemoteLeaseBroker {
  constructor(readonly providers = new RemoteLeaseProviderRegistry()) {}

  async grant(
    providerIdValue: unknown,
    context: RuntimeExecutionContext,
    targetValue: RemoteLeaseTarget
  ): Promise<RemoteLeaseGrant> {
    const providerId = safeString(providerIdValue, "remote lease provider", 256);
    const target = normalizedTarget(targetValue);
    const provider = this.providers.get(providerId);
    const capability = localCapability(context);
    const environment = localEnvironment(context);
    const deadline = boundedTaskDeadline(context);
    const effectiveExpiry = Math.min(
      capability.expiry,
      environment.expiry ?? Number.POSITIVE_INFINITY,
      deadline ?? Number.POSITIVE_INFINITY
    );
    if (!Number.isFinite(effectiveExpiry) || effectiveExpiry <= Date.now()) {
      throw new RemoteLeaseError("REMOTE_LEASE_LOCAL_EXPIRED", "No active local authority remains for remote execution");
    }

    const requestBasis = {
      contract: "ai-verse-multiple-bots/remote-lease-request-v1",
      local_task_id: context.task.id,
      principal_id: context.principal.id,
      principal_kind: context.principalKind,
      workspace_id: String(context.task.workspaceId ?? ""),
      target,
      local_capability_lease_id: context.capabilityLease.id,
      allowed_tools: capability.tools,
      allowed_connections: capability.connections,
      destructive_actions: capability.destructiveActions,
      expires_at: new Date(effectiveExpiry).toISOString(),
      environment: environment.projection
    };
    const requestDigest = digest(requestBasis);
    const request: RemoteLeaseGrantRequest = {
      localTaskId: context.task.id,
      principalId: context.principal.id,
      principalKind: context.principalKind,
      workspaceId: String(context.task.workspaceId ?? ""),
      target,
      localCapabilityLeaseId: context.capabilityLease.id,
      requestDigest,
      allowedTools: capability.tools,
      allowedConnections: capability.connections,
      destructiveActions: capability.destructiveActions,
      expiresAt: new Date(effectiveExpiry).toISOString(),
      environment: environment.projection,
      signal: context.signal
    };

    let raw: RemoteLeaseGrant;
    try {
      raw = await raceWithAbort(provider.grant(request), context.signal);
    } catch (error) {
      if (context.signal.aborted) {
        throw context.signal.reason instanceof Error
          ? context.signal.reason
          : new Error("Remote lease grant canceled");
      }
      if (error instanceof RemoteLeaseError) throw error;
      throw new RemoteLeaseError(
        "REMOTE_LEASE_PROVIDER_FAILED",
        `Remote lease provider ${providerId} failed without exposing provider error details`
      );
    }

    if (raw.provider !== providerId) {
      throw new RemoteLeaseError(
        "REMOTE_LEASE_PROVIDER_MISMATCH",
        `Remote lease grant identifies provider ${String(raw.provider)} instead of ${providerId}`
      );
    }
    const remoteLeaseId = safeString(raw.remote_lease_id, "remote lease id", 1024);
    const grantFingerprint = safeString(raw.grant_fingerprint, "remote lease grant fingerprint", 1024);
    if (raw.request_digest !== requestDigest) {
      throw new RemoteLeaseError("REMOTE_LEASE_BINDING_MISMATCH", "Remote lease grant is bound to a different request");
    }
    const expiry = Date.parse(String(raw.expires_at ?? ""));
    if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > effectiveExpiry) {
      throw new RemoteLeaseError(
        "REMOTE_LEASE_EXPIRY_EXPANSION",
        "Remote lease expiry must be active and no later than the local effective expiry"
      );
    }
    const tools = exactReportedRefs(raw.granted_tools, "remote grant granted_tools");
    const connections = exactReportedRefs(raw.granted_connections, "remote grant granted_connections");
    assertSubset(tools, capability.tools, "tool");
    assertSubset(connections, capability.connections, "connection");
    const destructiveActions = safeString(raw.destructive_actions, "remote grant destructive_actions", 64);
    if (actionRank(destructiveActions) > actionRank(capability.destructiveActions)) {
      throw new RemoteLeaseError(
        "REMOTE_LEASE_AUTHORITY_EXPANSION",
        "Remote lease destructive action policy exceeds the local capability lease"
      );
    }

    let remoteEnvironment: RemoteLeaseGrant["environment"] = null;
    if (environment.projection) {
      const value = asObject(raw.environment);
      if (!value) {
        throw new RemoteLeaseError(
          "REMOTE_LEASE_ENVIRONMENT_REQUIRED",
          "Remote lease provider did not bind the required environment lease"
        );
      }
      const policy = safeString(value.environment_policy, "remote grant environment_policy", 128);
      if (policy !== environment.projection.environment_policy) {
        throw new RemoteLeaseError(
          "REMOTE_LEASE_ENVIRONMENT_MISMATCH",
          "Remote environment policy does not match the local environment lease"
        );
      }
      remoteEnvironment = {
        environment_policy: policy,
        remote_environment_ref: safeString(
          value.remote_environment_ref,
          "remote grant remote_environment_ref",
          2048
        )
      };
    } else if (raw.environment !== undefined && raw.environment !== null) {
      throw new RemoteLeaseError(
        "REMOTE_LEASE_ENVIRONMENT_EXPANSION",
        "Remote provider granted environment authority when no local environment lease exists"
      );
    }

    return {
      provider: providerId,
      remote_lease_id: remoteLeaseId,
      request_digest: requestDigest,
      grant_fingerprint: grantFingerprint,
      expires_at: new Date(expiry).toISOString(),
      granted_tools: tools,
      granted_connections: connections,
      destructive_actions: destructiveActions,
      environment: remoteEnvironment
    };
  }

  verifyReceipt(grant: RemoteLeaseGrant, receiptValue: unknown): RemoteLeaseAudit {
    const grantExpiry = Date.parse(grant.expires_at);
    if (!Number.isFinite(grantExpiry) || grantExpiry <= Date.now()) {
      throw new RemoteLeaseError(
        "REMOTE_LEASE_EXPIRED_DURING_EXECUTION",
        "Remote execution completed after the granted Task authority expired"
      );
    }
    const receipt = asObject(receiptValue);
    if (!receipt) {
      throw new RemoteLeaseError("REMOTE_LEASE_RECEIPT_REQUIRED", "Remote execution did not return a lease receipt");
    }
    if (
      receipt.remote_lease_id !== grant.remote_lease_id
      || receipt.request_digest !== grant.request_digest
      || receipt.grant_fingerprint !== grant.grant_fingerprint
    ) {
      throw new RemoteLeaseError(
        "REMOTE_LEASE_RECEIPT_MISMATCH",
        "Remote lease receipt does not match the granted Task lease"
      );
    }
    if (receipt.state !== "honored") {
      throw new RemoteLeaseError("REMOTE_LEASE_NOT_HONORED", "Remote execution did not honor the granted lease");
    }
    const observedTools = exactReportedRefs(receipt.observed_tools, "remote lease receipt observed_tools");
    const observedConnections = exactReportedRefs(
      receipt.observed_connections,
      "remote lease receipt observed_connections"
    );
    assertSubset(observedTools, grant.granted_tools, "observed tool");
    assertSubset(observedConnections, grant.granted_connections, "observed connection");

    let environmentVerified = false;
    if (grant.environment) {
      if (receipt.environment_ref !== grant.environment.remote_environment_ref) {
        throw new RemoteLeaseError(
          "REMOTE_LEASE_ENVIRONMENT_MISMATCH",
          "Remote lease receipt identifies a different execution environment"
        );
      }
      environmentVerified = true;
    } else if (receipt.environment_ref !== undefined && receipt.environment_ref !== null) {
      throw new RemoteLeaseError(
        "REMOTE_LEASE_ENVIRONMENT_EXPANSION",
        "Remote execution reported environment authority without a granted environment"
      );
    }

    return {
      observedToolCount: observedTools.length,
      observedConnectionCount: observedConnections.length,
      environmentVerified
    };
  }

  transportProjection(grant: RemoteLeaseGrant): JsonObject {
    return {
      contract: "ai-verse-multiple-bots/remote-lease-grant-v1",
      remote_lease_id: grant.remote_lease_id,
      request_digest: grant.request_digest,
      grant_fingerprint: grant.grant_fingerprint,
      expires_at: grant.expires_at,
      granted_tools: grant.granted_tools,
      granted_connections: grant.granted_connections,
      destructive_actions: grant.destructive_actions,
      environment: grant.environment ?? null
    };
  }

  receiptProjection(grant: RemoteLeaseGrant, audit: RemoteLeaseAudit): JsonObject {
    return {
      provider: grant.provider,
      remote_lease_verified: true,
      remote_lease_expires_at: grant.expires_at,
      granted_tool_count: grant.granted_tools.length,
      granted_connection_count: grant.granted_connections.length,
      observed_tool_count: audit.observedToolCount,
      observed_connection_count: audit.observedConnectionCount,
      environment_verified: audit.environmentVerified
    };
  }

  async revoke(grant: RemoteLeaseGrant, localTaskId: string, targetValue: RemoteLeaseTarget): Promise<void> {
    const provider = this.providers.get(grant.provider);
    const target = normalizedTarget(targetValue);
    try {
      await provider.revoke({
        localTaskId,
        target,
        remoteLeaseId: grant.remote_lease_id,
        grantFingerprint: grant.grant_fingerprint
      });
    } catch (error) {
      if (error instanceof RemoteLeaseError) throw error;
      throw new RemoteLeaseError(
        "REMOTE_LEASE_REVOKE_FAILED",
        `Remote lease provider ${grant.provider} failed revocation without exposing provider error details`
      );
    }
  }
}
