import type { JsonObject } from "./types.js";

export const MEMORY_RECALL_SCHEMA_VERSION = "1.0";
export const MAX_MEMORY_RECALL_QUERY_LENGTH = 2048;
export const MAX_MEMORY_RECALL_RESULTS = 12;

export type MemoryRecallScope = "workspace" | "operator";

export interface MemoryRecallRequest {
  query: string;
  scope?: MemoryRecallScope;
  limit?: number;
  includeHistory?: boolean;
}

export interface NormalizedMemoryRecallRequest extends JsonObject {
  query: string;
  scope: MemoryRecallScope;
  limit: number;
  include_history: boolean;
}

export interface MemoryRecallSource extends JsonObject {
  ref: string;
  digest: string;
  item_id: string;
  kind: string;
  type: string;
  scope: string;
  path: string;
}

export interface MemoryRecallProjection extends JsonObject {
  schema_version: "1.0";
  provider: string;
  workspace_id: string;
  query_digest: string;
  projection_digest: string;
  recalled_at: string;
  request: NormalizedMemoryRecallRequest;
  sources: MemoryRecallSource[];
  data: JsonObject;
}

export interface MemoryRecallProviderInput {
  workspaceId: string;
  principalId: string;
  principalKind: "bot" | "worker";
  taskId: string;
  rootObjectiveId: string;
  request: NormalizedMemoryRecallRequest;
  signal: AbortSignal;
}

export interface MemoryRecallProvider {
  recall(input: MemoryRecallProviderInput): Promise<MemoryRecallProjection>;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeMemoryRecallRequest(value: unknown): NormalizedMemoryRecallRequest | null {
  if (value === undefined || value === null) return null;
  const source = asObject(value);
  if (!source) throw new Error("memoryRecall must be an object when provided");

  const allowed = new Set(["query", "scope", "limit", "includeHistory", "include_history"]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      if (key === "allWorkspaces" || key === "all_workspaces") {
        throw new Error("Cross-workspace memory recall is not available through a workspace-scoped coordination Task");
      }
      throw new Error(`Unknown memoryRecall field '${key}'`);
    }
  }

  if (typeof source.query !== "string" || !source.query.trim()) {
    throw new Error("memoryRecall.query must be a non-empty string");
  }
  const query = source.query.trim();
  if (query.length > MAX_MEMORY_RECALL_QUERY_LENGTH) {
    throw new Error(`memoryRecall.query exceeds ${MAX_MEMORY_RECALL_QUERY_LENGTH} characters`);
  }

  const scopeValue = source.scope ?? "workspace";
  if (scopeValue !== "workspace" && scopeValue !== "operator") {
    throw new Error("memoryRecall.scope must be 'workspace' or 'operator'");
  }

  const limitValue = source.limit ?? 8;
  if (typeof limitValue !== "number" || !Number.isInteger(limitValue) || limitValue < 1 || limitValue > MAX_MEMORY_RECALL_RESULTS) {
    throw new Error(`memoryRecall.limit must be an integer from 1 to ${MAX_MEMORY_RECALL_RESULTS}`);
  }

  if (source.includeHistory !== undefined && source.include_history !== undefined && source.includeHistory !== source.include_history) {
    throw new Error("memoryRecall includeHistory/include_history aliases disagree");
  }
  const includeHistoryValue = source.includeHistory ?? source.include_history ?? false;
  if (typeof includeHistoryValue !== "boolean") throw new Error("memoryRecall.includeHistory must be boolean");

  return {
    query,
    scope: scopeValue,
    limit: limitValue,
    include_history: includeHistoryValue
  };
}
