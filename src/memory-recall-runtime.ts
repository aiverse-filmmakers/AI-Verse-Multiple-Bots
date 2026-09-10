import {
  RuntimeRegistry,
  type HistoricalRecallProjection,
  type HistoricalRecallRequest,
  type HistoricalRecallSource,
  type RuntimeAdapter,
  type RuntimeExecutionContext,
  type RuntimeExecutionResult
} from "./runtime.js";
import type { JsonObject } from "./types.js";

export const TASK_MEMORY_RECALL_FIELD = "memory_recall";
export const MEMORY_RECALL_MAX_REQUEST_LIMIT = 12;
export const MEMORY_RECALL_MAX_QUERY_CHARS = 2_000;

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

export function parseTaskMemoryRecallRequest(value: unknown): HistoricalRecallRequest | null {
  if (value === undefined || value === null || value === false) return null;
  const request = asObject(value);
  if (!request) throw new Error("Task memory_recall must be an object when present");
  if (request.all_workspaces !== undefined || request.workspace_id !== undefined || request.scope !== undefined) {
    throw new Error("Task memory_recall cannot widen or override the Task workspace scope");
  }
  const query = typeof request.query === "string" ? request.query.trim() : "";
  if (!query) throw new Error("Task memory_recall.query is required");
  if (query.length > MEMORY_RECALL_MAX_QUERY_CHARS) {
    throw new Error(`Task memory_recall.query exceeds ${MEMORY_RECALL_MAX_QUERY_CHARS} characters`);
  }
  const limit = request.limit === undefined ? 8 : Number(request.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_RECALL_MAX_REQUEST_LIMIT) {
    throw new Error(`Task memory_recall.limit must be an integer from 1 to ${MEMORY_RECALL_MAX_REQUEST_LIMIT}`);
  }
  if (request.include_history !== undefined && typeof request.include_history !== "boolean") {
    throw new Error("Task memory_recall.include_history must be boolean");
  }
  return {
    query,
    limit,
    include_history: request.include_history === true
  };
}

function validateProjection(projection: HistoricalRecallProjection, workspaceId: string, request: HistoricalRecallRequest): void {
  if (projection.workspace_id !== workspaceId) {
    throw new Error(`Historical recall source returned workspace ${projection.workspace_id} for Task workspace ${workspaceId}`);
  }
  if (projection.schema_version !== "1.0") throw new Error(`Unsupported historical recall schema ${projection.schema_version}`);
  if (!projection.provider || !projection.query_digest || !projection.recall_digest) {
    throw new Error("Historical recall projection is missing provider or digest provenance");
  }
  if (!Array.isArray(projection.items)) throw new Error("Historical recall projection items must be an array");
  if (projection.items.length > Number(request.limit ?? 8) || projection.items.length > MEMORY_RECALL_MAX_REQUEST_LIMIT) {
    throw new Error("Historical recall projection exceeds the requested result limit");
  }
  const workspaceScope = `workspace:${workspaceId}`;
  for (const item of projection.items) {
    if (item.scope !== workspaceScope && item.scope !== "operator") {
      throw new Error(`Historical recall item ${item.id} escaped Task workspace scope through ${item.scope}`);
    }
    if (!item.id || !item.kind || !item.type || !item.path || !item.digest) {
      throw new Error("Historical recall item is missing required provenance");
    }
    if (typeof item.content !== "string" || item.content.trim().length === 0) {
      throw new Error(`Historical recall item ${item.id} has no runtime content`);
    }
  }
}

/**
 * Adds explicit historical recall to the common runtime path.
 *
 * No request means zero recall work. If a Task explicitly requests recall but no
 * source is configured, execution fails closed instead of silently ignoring the
 * request. Recalled text remains only in RuntimeExecutionContext; receipts keep
 * bounded provenance/digests only.
 */
export class MemoryRecallRuntimeRegistry extends RuntimeRegistry {
  private readonly wrapped = new Map<string, RuntimeAdapter>();

  constructor(readonly base: RuntimeRegistry, readonly source?: HistoricalRecallSource) {
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
    const source = this.source;
    const wrapped: RuntimeAdapter = {
      id: inner.id,
      async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
        const request = parseTaskMemoryRecallRequest(context.task.payload[TASK_MEMORY_RECALL_FIELD]);
        if (!request) return inner.execute(context);
        if (!source) {
          throw new Error(`Task ${context.task.id} explicitly requested historical recall but no Memory recall source is configured`);
        }

        const taskWorkspaceId = context.task.workspaceId;
        const principalWorkspaceId = context.principal.workspaceId;
        if (!taskWorkspaceId || !principalWorkspaceId || taskWorkspaceId !== principalWorkspaceId) {
          throw new Error(`Historical recall requires Task ${context.task.id} and ${context.principal.id} to share one explicit workspace`);
        }

        const projection = await source.recall(taskWorkspaceId, request);
        validateProjection(projection, taskWorkspaceId, request);
        const result = await inner.execute({ ...context, historicalRecall: projection });
        const receipt: JsonObject = {
          kind: "historical_memory_recall",
          provider: projection.provider,
          schema_version: projection.schema_version,
          workspace_id: projection.workspace_id,
          query_digest: projection.query_digest,
          recall_digest: projection.recall_digest,
          include_history: projection.include_history,
          requested_limit: projection.requested_limit,
          result_count: projection.items.length,
          sources: projection.items.map((item) => ({
            ref: `${projection.provider}:${item.id}`,
            id: item.id,
            kind: item.kind,
            type: item.type,
            scope: item.scope,
            path: item.path,
            digest: item.digest,
            source_version: item.source_version ?? null,
            freshness: item.freshness ?? null
          }))
        };
        return { ...result, receipts: [...(result.receipts ?? []), receipt] };
      },
      ...(inner.cancel ? { cancel: (taskId: string) => inner.cancel!(taskId) } : {})
    };
    this.wrapped.set(id, wrapped);
    return wrapped;
  }
}
