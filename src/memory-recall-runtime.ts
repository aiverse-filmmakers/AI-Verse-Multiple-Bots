import {
  AiVerseMemoryRecallError,
  normalizeMemoryRecallDirective,
  type MemoryRecallProjection,
  type MemoryRecallProvider
} from "./ai-verse-memory-recall.js";
import {
  RuntimeRegistry,
  type RuntimeAdapter,
  type RuntimeExecutionContext,
  type RuntimeExecutionResult
} from "./runtime.js";
import { CoordinationStore } from "./store.js";
import type { JsonObject, StoredObject } from "./types.js";

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function requireMemoryAuthority(context: RuntimeExecutionContext, store: CoordinationStore): StoredObject {
  if (context.principalKind === "bot") return context.principal;

  const runId = String(context.principal.payload.run_id ?? context.task.payload.run_id ?? "");
  if (!runId) throw new AiVerseMemoryRecallError("MEMORY_WORKER_SCOPE_INVALID", `Worker ${context.principal.id} has no Team Run for Memory recall`);
  const run = store.getObject(runId);
  if (!run || run.kind !== "team_run") throw new AiVerseMemoryRecallError("MEMORY_WORKER_SCOPE_INVALID", `Team Run ${runId} not found for Worker ${context.principal.id}`);
  if (run.workspaceId !== context.task.workspaceId || run.workspaceId !== context.principal.workspaceId) {
    throw new AiVerseMemoryRecallError("MEMORY_SCOPE_VIOLATION", `Worker ${context.principal.id} cannot recall outside Team Run workspace ${String(run.workspaceId)}`);
  }
  const leaderId = String(run.payload.leader_id ?? "");
  const leader = store.getObject(leaderId);
  if (!leader || leader.kind !== "bot" || leader.payload.status !== "active" || leader.workspaceId !== run.workspaceId) {
    throw new AiVerseMemoryRecallError("MEMORY_WORKER_AUTHORITY_INVALID", `Worker ${context.principal.id} has no active same-workspace durable leader for Memory recall`);
  }
  return leader;
}

function assertReadPolicy(authority: StoredObject, includeHistory: boolean): void {
  const policy = asObject(authority.payload.memory);
  const adapter = String(policy.adapter ?? "");
  if (adapter !== "host" && adapter !== "ai-verse-memory") {
    throw new AiVerseMemoryRecallError("MEMORY_READ_NOT_AUTHORIZED", `Bot ${authority.id} does not authorize host Memory recall`);
  }
  const viewPolicy = String(policy.view_policy ?? "");
  if (viewPolicy !== "role_scoped" && viewPolicy !== "workspace_scoped") {
    throw new AiVerseMemoryRecallError("MEMORY_READ_NOT_AUTHORIZED", `Bot ${authority.id} has unsupported Memory view policy ${viewPolicy || "unset"}`);
  }
  if (includeHistory && policy.allow_history !== true) {
    throw new AiVerseMemoryRecallError("MEMORY_HISTORY_NOT_AUTHORIZED", `Bot ${authority.id} has not authorized superseded Memory history recall`);
  }
}

function validateProjection(projection: MemoryRecallProjection, workspaceId: string, query: string, limit: number, includeHistory: boolean): void {
  if (projection.workspace_id !== workspaceId) throw new AiVerseMemoryRecallError("MEMORY_SCOPE_VIOLATION", `Memory provider returned ${projection.workspace_id} for ${workspaceId}`);
  if (projection.query !== query || projection.requested_limit !== limit || projection.include_history !== includeHistory) {
    throw new AiVerseMemoryRecallError("MEMORY_RESPONSE_CONTRACT_MISMATCH", "Memory provider response does not match the requested recall contract");
  }
}

function receiptFor(projection: MemoryRecallProjection): JsonObject {
  return {
    kind: "memory_recall",
    provider: projection.provider,
    provider_version: projection.provider_version,
    schema_version: projection.schema_version,
    workspace_id: projection.workspace_id,
    query_digest: projection.query_digest,
    recall_digest: projection.recall_digest,
    requested_limit: projection.requested_limit,
    include_history: projection.include_history,
    source_count: projection.items.length,
    sources: projection.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      scope: item.scope,
      freshness: item.freshness,
      source_identity: item.source_identity,
      source_version: item.source_version,
      item_digest: item.item_digest
    }))
  };
}

/**
 * Runtime-only Memory recall adapter.
 *
 * A Task must explicitly request `memory_recall`. Durable Bots use their own
 * read policy. Temporary Workers inherit the durable Team Run leader's read
 * policy and never gain independent long-term-memory authority. Full recalled
 * text exists only in RuntimeExecutionContext; persisted receipts carry only
 * bounded provenance and digests.
 */
export class MemoryRecallRuntimeRegistry extends RuntimeRegistry {
  private readonly wrapped = new Map<string, RuntimeAdapter>();

  constructor(
    readonly base: RuntimeRegistry,
    readonly provider: MemoryRecallProvider | undefined,
    readonly store: CoordinationStore
  ) {
    super();
  }

  override register(adapter: RuntimeAdapter): this {
    this.base.register(adapter);
    return this;
  }

  override has(id: string): boolean {
    return this.base.has(id);
  }

  override get(id: string): RuntimeAdapter {
    const existing = this.wrapped.get(id);
    if (existing) return existing;
    const inner = this.base.get(id);
    const provider = this.provider;
    const store = this.store;
    const wrapped: RuntimeAdapter = {
      id: inner.id,
      async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
        const directive = normalizeMemoryRecallDirective(context.task.payload.memory_recall);
        if (!directive) return inner.execute(context);
        if (!provider) {
          throw new AiVerseMemoryRecallError("MEMORY_PROVIDER_UNAVAILABLE", `Task ${context.task.id} explicitly requested Memory recall but no Memory provider is configured`);
        }

        const workspaceId = context.task.workspaceId;
        if (!workspaceId || !context.principal.workspaceId || context.principal.workspaceId !== workspaceId) {
          throw new AiVerseMemoryRecallError("MEMORY_SCOPE_VIOLATION", `Task ${context.task.id} and ${context.principal.id} must share one explicit workspace for Memory recall`);
        }
        const authority = requireMemoryAuthority(context, store);
        if (authority.workspaceId !== workspaceId) {
          throw new AiVerseMemoryRecallError("MEMORY_SCOPE_VIOLATION", `Memory authority ${authority.id} is outside Task workspace ${workspaceId}`);
        }
        assertReadPolicy(authority, directive.include_history);

        const projection = await provider.recall({
          workspaceId,
          query: directive.query,
          limit: directive.limit,
          includeHistory: directive.include_history
        });
        validateProjection(projection, workspaceId, directive.query, directive.limit, directive.include_history);
        const result = await inner.execute({ ...context, memoryRecall: projection });
        return { ...result, receipts: [...(result.receipts ?? []), receiptFor(projection)] };
      },
      ...(inner.cancel ? { cancel: (taskId: string) => inner.cancel!(taskId) } : {})
    };
    this.wrapped.set(id, wrapped);
    return wrapped;
  }
}
