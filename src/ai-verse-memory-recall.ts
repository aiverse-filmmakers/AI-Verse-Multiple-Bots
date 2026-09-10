import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import process from "node:process";
import { detectAiVerseOsCompatibility } from "./ai-verse-os-registration.js";
import {
  RuntimeRegistry,
  type HistoricalRecallProjection,
  type RuntimeAdapter,
  type RuntimeExecutionContext,
  type RuntimeExecutionResult
} from "./runtime.js";
import type { JsonObject } from "./types.js";

export const AI_VERSE_MEMORY_RECALL_PROVIDER = "ai-verse-memory-recall-v1";
export const AI_VERSE_MEMORY_RECALL_SCHEMA = "1.0";
export const AI_VERSE_MEMORY_MIN_NATIVE_VERSION = "0.2.0";

const MEMORY_ENTRYPOINT = "scripts/ai-verse-memory/memory.py";
const MEMORY_ENGINE = "scripts/ai-verse-memory/memory_engine.py";
const MEMORY_OS_COMPAT = "scripts/ai-verse-memory/os_compat.py";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;
const MAX_QUERY_CHARS = 4096;
const MAX_ITEM_TEXT_CHARS = 8192;
const MAX_ITEM_WHY_CHARS = 2048;
const MAX_METADATA_CHARS = 2048;
const MAX_TOTAL_TEXT_BYTES = 48 * 1024;
const DEFAULT_BRIDGE_TIMEOUT_MS = 10_000;
const DEFAULT_BRIDGE_MAX_BUFFER = 256 * 1024;
const ALLOWED_KINDS = new Set(["memory", "context", "workspace_manifest", "decision", "profile", "memory_summary"]);

export interface MemoryRecallRequest extends JsonObject {
  query: string;
  limit: number;
  include_history: boolean;
}

export interface MemoryRecallSource {
  recall(workspaceId: string, request: MemoryRecallRequest): HistoricalRecallProjection;
}

export type AiVerseMemoryInstallationStatus = "absent" | "compatible" | "incompatible";

export interface AiVerseMemoryInstallation {
  status: AiVerseMemoryInstallationStatus;
  root: string;
  reason: string;
  engine_version: string | null;
  entrypoint: string;
}

export interface AiVerseMemoryRecallSourceOptions {
  pythonExecutable?: string;
  bridgeTimeoutMs?: number;
  bridgeMaxBufferBytes?: number;
  invokeBridge?: (input: {
    entrypoint: string;
    root: string;
    workspaceId: string;
    query: string;
    limit: number;
    includeHistory: boolean;
  }) => unknown;
}

export class AiVerseMemoryRecallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AiVerseMemoryRecallError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalString(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function requireString(value: unknown, label: string, maxLength = MAX_METADATA_CHARS): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", `${label} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > maxLength) {
    throw new AiVerseMemoryRecallError("MEMORY_RESULT_TOO_LARGE", `${label} exceeds ${maxLength} characters`);
  }
  return result;
}

function optionalString(value: unknown, label: string, maxLength = MAX_METADATA_CHARS): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, label, maxLength);
}

function boundedText(value: unknown, maxLength: number): { text: string; truncated: boolean } {
  if (value === undefined || value === null) return { text: "", truncated: false };
  if (typeof value !== "string") throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", "Memory recall text fields must be strings");
  if (value.length <= maxLength) return { text: value, truncated: false };
  return { text: value.slice(0, maxLength), truncated: true };
}

function assertWorkspaceId(value: string): string {
  const workspaceId = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(workspaceId)) {
    throw new AiVerseMemoryRecallError("INVALID_WORKSPACE", `Invalid AI-Verse workspace ID '${workspaceId}'`);
  }
  return workspaceId;
}

function inside(path: string, root: string): boolean {
  const candidate = resolve(path);
  const base = resolve(root);
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

function relativeSourcePath(root: string, rawPath: string): string {
  if (!rawPath || rawPath.includes("\0") || rawPath.startsWith("/") || rawPath.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(rawPath)) {
    throw new AiVerseMemoryRecallError("MEMORY_SOURCE_INVALID", `Memory source path must be repository-relative: ${rawPath}`);
  }
  const normalized = rawPath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new AiVerseMemoryRecallError("MEMORY_SOURCE_INVALID", `Memory source path contains unsafe traversal: ${rawPath}`);
  }
  const absolute = resolve(root, ...segments);
  if (!inside(absolute, root)) throw new AiVerseMemoryRecallError("MEMORY_SOURCE_ESCAPE", `Memory source escapes AI-Verse OS root: ${rawPath}`);
  return normalized;
}

function assertRegularFile(path: string, label: string): void {
  if (!existsSync(path)) throw new AiVerseMemoryRecallError("MEMORY_INSTALLATION_INCOMPLETE", `${label} is missing`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new AiVerseMemoryRecallError("MEMORY_SYMLINK_REJECTED", `${label} must not be a symlink`);
  if (!stat.isFile()) throw new AiVerseMemoryRecallError("MEMORY_INSTALLATION_INVALID", `${label} must be a regular file`);
}

function versionAtLeastNativeMinimum(version: string): boolean {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major === 0 && minor >= 2;
}

export function detectAiVerseMemoryInstallation(rootInput: string): AiVerseMemoryInstallation {
  const root = resolve(rootInput);
  const compatibility = detectAiVerseOsCompatibility(root);
  const entrypoint = resolve(root, ...MEMORY_ENTRYPOINT.split("/"));
  if (compatibility.status !== "compatible") {
    return {
      status: "incompatible",
      root,
      reason: `AI-Verse Memory native recall requires a compatible AI-Verse OS v2 host: ${compatibility.reason}`,
      engine_version: null,
      entrypoint
    };
  }

  const required = [MEMORY_ENTRYPOINT, MEMORY_ENGINE, MEMORY_OS_COMPAT];
  const existing = required.filter((relative) => existsSync(resolve(root, ...relative.split("/"))));
  if (existing.length === 0) {
    return {
      status: "absent",
      root,
      reason: "AI-Verse Memory is not installed in this AI-Verse OS host",
      engine_version: null,
      entrypoint
    };
  }
  if (existing.length !== required.length) {
    return {
      status: "incompatible",
      root,
      reason: `AI-Verse Memory installation is incomplete; expected ${required.join(", ")}`,
      engine_version: null,
      entrypoint
    };
  }

  try {
    for (const relative of required) assertRegularFile(resolve(root, ...relative.split("/")), relative);
    const engineText = readFileSync(resolve(root, ...MEMORY_ENGINE.split("/")), "utf8");
    const version = /(?m)^VERSION\s*=\s*["']([^"']+)["']\s*$/.exec(engineText)?.[1] ?? null;
    if (!version || !versionAtLeastNativeMinimum(version)) {
      return {
        status: "incompatible",
        root,
        reason: `AI-Verse Memory ${version ?? "unknown"} does not expose the supported native v0.2+ recall contract`,
        engine_version: version,
        entrypoint
      };
    }
    return {
      status: "compatible",
      root,
      reason: "compatible AI-Verse Memory native recall engine",
      engine_version: version,
      entrypoint
    };
  } catch (error) {
    return {
      status: "incompatible",
      root,
      reason: error instanceof Error ? error.message : String(error),
      engine_version: null,
      entrypoint
    };
  }
}

export function normalizeMemoryRecallRequest(value: unknown, fallbackObjective: unknown): MemoryRecallRequest | null {
  if (value === undefined || value === null || value === false) return null;
  let source: JsonObject;
  if (value === true) source = {};
  else {
    const object = asObject(value);
    if (!object) throw new AiVerseMemoryRecallError("MEMORY_RECALL_REQUEST_INVALID", "memory_recall must be true, false, or an object");
    if (object.enabled === false) return null;
    source = object;
  }

  if (source.all_workspaces === true || source.allWorkspaces === true) {
    throw new AiVerseMemoryRecallError("CROSS_WORKSPACE_RECALL_DENIED", "Coordination Tasks cannot request cross-workspace Memory recall");
  }
  for (const key of ["workspace", "workspace_id", "workspaceId", "scope"]) {
    if (source[key] !== undefined && source[key] !== null) {
      throw new AiVerseMemoryRecallError("MEMORY_SCOPE_OVERRIDE_DENIED", `memory_recall.${key} cannot override the Task workspace`);
    }
  }

  const rawQuery = source.query ?? fallbackObjective;
  if (typeof rawQuery !== "string" || !rawQuery.trim()) {
    throw new AiVerseMemoryRecallError("MEMORY_RECALL_REQUEST_INVALID", "Memory recall requires a non-empty query or Task objective");
  }
  const query = rawQuery.trim();
  if (query.length > MAX_QUERY_CHARS) {
    throw new AiVerseMemoryRecallError("MEMORY_RECALL_QUERY_TOO_LARGE", `Memory recall query exceeds ${MAX_QUERY_CHARS} characters`);
  }

  const rawLimit = source.limit ?? DEFAULT_LIMIT;
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_LIMIT) {
    throw new AiVerseMemoryRecallError("MEMORY_RECALL_LIMIT_INVALID", `Memory recall limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  const rawHistory = source.include_history ?? source.includeHistory ?? false;
  if (typeof rawHistory !== "boolean") {
    throw new AiVerseMemoryRecallError("MEMORY_RECALL_REQUEST_INVALID", "memory_recall.include_history must be boolean");
  }
  return { query, limit: rawLimit, include_history: rawHistory };
}

const PYTHON_BRIDGE = String.raw`
import importlib.util
import json
import pathlib
import sys

entry = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2])
workspace = sys.argv[3]
query = sys.argv[4]
limit = int(sys.argv[5])
include_history = sys.argv[6] == "1"

spec = importlib.util.spec_from_file_location("_ai_verse_memory_runtime_bridge", entry)
if spec is None or spec.loader is None:
    raise RuntimeError("Could not load AI-Verse Memory entrypoint")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
mode = module.detect_mode(root)
rows = module.recall(
    query,
    limit=limit,
    include_history=include_history,
    root=root,
    mode=module.MODE_NATIVE,
    workspace=workspace,
    all_workspaces=False,
)
keys = [
    "id", "kind", "path", "type", "scope", "status", "importance", "confidence",
    "created_at", "updated_at", "source", "tags", "text", "why", "authority",
    "source_identity", "source_version", "freshness", "indexed_at"
]
items = []
for row in rows:
    available = set(row.keys())
    items.append({key: row[key] for key in keys if key in available})
print(json.dumps({
    "mode": mode,
    "version": getattr(module, "VERSION", None),
    "items": items,
}, ensure_ascii=False))
`;

export class AiVerseMemoryRecallSource implements MemoryRecallSource {
  readonly root: string;
  readonly installation: AiVerseMemoryInstallation;
  private readonly options: AiVerseMemoryRecallSourceOptions;

  constructor(rootInput: string, options: AiVerseMemoryRecallSourceOptions = {}) {
    this.root = resolve(rootInput);
    this.options = options;
    this.installation = detectAiVerseMemoryInstallation(this.root);
    if (this.installation.status !== "compatible") {
      throw new AiVerseMemoryRecallError("MEMORY_NOT_AVAILABLE", this.installation.reason);
    }
  }

  static fromInstalledOs(rootInput: string, options: AiVerseMemoryRecallSourceOptions = {}): AiVerseMemoryRecallSource | null {
    const detection = detectAiVerseMemoryInstallation(rootInput);
    if (detection.status === "absent") return null;
    if (detection.status !== "compatible") throw new AiVerseMemoryRecallError("MEMORY_INSTALLATION_INCOMPATIBLE", detection.reason);
    return new AiVerseMemoryRecallSource(rootInput, options);
  }

  recall(workspaceIdInput: string, request: MemoryRecallRequest): HistoricalRecallProjection {
    const workspaceId = assertWorkspaceId(workspaceIdInput);
    const current = detectAiVerseMemoryInstallation(this.root);
    if (current.status !== "compatible") {
      throw new AiVerseMemoryRecallError("MEMORY_NOT_AVAILABLE", `AI-Verse Memory changed after startup: ${current.reason}`);
    }
    const normalizedRequest = normalizeMemoryRecallRequest(request, request.query);
    if (!normalizedRequest) throw new AiVerseMemoryRecallError("MEMORY_RECALL_REQUEST_INVALID", "Memory recall request was disabled");

    const raw = this.options.invokeBridge
      ? this.options.invokeBridge({
          entrypoint: current.entrypoint,
          root: this.root,
          workspaceId,
          query: normalizedRequest.query,
          limit: normalizedRequest.limit,
          includeHistory: normalizedRequest.include_history
        })
      : this.invokePythonBridge(current.entrypoint, workspaceId, normalizedRequest);
    const payload = asObject(raw);
    if (!payload || payload.mode !== "ai-verse-os-v2" || !Array.isArray(payload.items)) {
      throw new AiVerseMemoryRecallError("MEMORY_BRIDGE_INVALID", "AI-Verse Memory recall bridge returned an invalid native response");
    }

    const items: JsonObject[] = [];
    const sources: JsonObject[] = [];
    let totalTextBytes = 0;
    for (const [index, rawItem] of payload.items.slice(0, normalizedRequest.limit).entries()) {
      const item = asObject(rawItem);
      if (!item) throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", `Memory result ${index} must be an object`);
      const id = requireString(item.id, `Memory result ${index}.id`, 256);
      const kind = requireString(item.kind, `Memory result ${id}.kind`, 64);
      if (!ALLOWED_KINDS.has(kind)) throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", `Memory result ${id} has unsupported kind ${kind}`);
      const type = requireString(item.type ?? kind, `Memory result ${id}.type`, 128);
      const scope = requireString(item.scope, `Memory result ${id}.scope`, 256);
      if (scope !== "operator" && scope !== `workspace:${workspaceId}`) {
        throw new AiVerseMemoryRecallError("CROSS_WORKSPACE_RECALL_DENIED", `Memory result ${id} crossed Task workspace boundary with scope ${scope}`);
      }
      const path = relativeSourcePath(this.root, requireString(item.path, `Memory result ${id}.path`, 2048));
      if (scope === "operator" && !path.startsWith("operator/")) {
        throw new AiVerseMemoryRecallError("MEMORY_SOURCE_SCOPE_MISMATCH", `Operator Memory result ${id} points outside operator/`);
      }
      if (scope === `workspace:${workspaceId}` && !path.startsWith(`workspaces/${workspaceId}/`)) {
        throw new AiVerseMemoryRecallError("MEMORY_SOURCE_SCOPE_MISMATCH", `Workspace Memory result ${id} points outside workspaces/${workspaceId}/`);
      }
      const absolute = resolve(this.root, ...path.split("/"));
      if (!existsSync(absolute)) throw new AiVerseMemoryRecallError("MEMORY_SOURCE_MISSING", `Memory source ${path} no longer exists`);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new AiVerseMemoryRecallError("MEMORY_SOURCE_INVALID", `Memory source ${path} must be a non-symlink regular file`);
      const realRoot = realpathSync(this.root);
      const realSource = realpathSync(absolute);
      if (!inside(realSource, realRoot)) throw new AiVerseMemoryRecallError("MEMORY_SOURCE_ESCAPE", `Memory source ${path} resolves outside AI-Verse OS root`);

      const text = boundedText(item.text, MAX_ITEM_TEXT_CHARS);
      const why = boundedText(item.why, MAX_ITEM_WHY_CHARS);
      const itemBytes = byteLength(text.text) + byteLength(why.text);
      if (totalTextBytes + itemBytes > MAX_TOTAL_TEXT_BYTES) break;
      totalTextBytes += itemBytes;
      const sourceVersion = optionalString(item.source_version, `Memory result ${id}.source_version`, 256);
      const freshness = optionalString(item.freshness, `Memory result ${id}.freshness`, 64);
      const normalized: JsonObject = {
        id,
        kind,
        type,
        scope,
        path,
        text: text.text,
        why: why.text || null,
        status: optionalString(item.status, `Memory result ${id}.status`, 64),
        importance: typeof item.importance === "number" && Number.isFinite(item.importance) ? item.importance : null,
        confidence: typeof item.confidence === "number" && Number.isFinite(item.confidence) ? item.confidence : null,
        source: optionalString(item.source, `Memory result ${id}.source`),
        updated_at: optionalString(item.updated_at, `Memory result ${id}.updated_at`, 128),
        source_version: sourceVersion,
        freshness,
        truncated: text.truncated || why.truncated
      };
      items.push(normalized);
      sources.push({
        id,
        ref: path,
        kind,
        scope,
        source_version: sourceVersion,
        freshness,
        retrieval_item_digest: sha256(canonicalString(normalized))
      });
    }

    const requestDigest = sha256(canonicalString({
      provider: AI_VERSE_MEMORY_RECALL_PROVIDER,
      workspace_id: workspaceId,
      request: normalizedRequest
    }));
    const data: JsonObject = {
      query: normalizedRequest.query,
      include_history: normalizedRequest.include_history,
      items
    };
    const projectionDigest = sha256(canonicalString({
      provider: AI_VERSE_MEMORY_RECALL_PROVIDER,
      workspace_id: workspaceId,
      request_digest: requestDigest,
      data
    }));
    return {
      schema_version: AI_VERSE_MEMORY_RECALL_SCHEMA,
      provider: AI_VERSE_MEMORY_RECALL_PROVIDER,
      workspace_id: workspaceId,
      request_digest: requestDigest,
      projection_digest: projectionDigest,
      recalled_at: new Date().toISOString(),
      sources,
      data
    };
  }

  private invokePythonBridge(entrypoint: string, workspaceId: string, request: MemoryRecallRequest): unknown {
    const python = this.options.pythonExecutable
      ?? process.env.AI_VERSE_MEMORY_PYTHON
      ?? (process.platform === "win32" ? "python" : "python3");
    const result = spawnSync(python, [
      "-c",
      PYTHON_BRIDGE,
      entrypoint,
      this.root,
      workspaceId,
      request.query,
      String(request.limit),
      request.include_history ? "1" : "0"
    ], {
      encoding: "utf8",
      timeout: this.options.bridgeTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS,
      maxBuffer: this.options.bridgeMaxBufferBytes ?? DEFAULT_BRIDGE_MAX_BUFFER
    });
    if (result.error) {
      throw new AiVerseMemoryRecallError("MEMORY_BRIDGE_FAILED", `Could not execute AI-Verse Memory recall: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = String(result.stderr ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
      throw new AiVerseMemoryRecallError("MEMORY_BRIDGE_FAILED", `AI-Verse Memory recall exited with status ${String(result.status)}${detail ? `: ${detail}` : ""}`);
    }
    try {
      return JSON.parse(String(result.stdout ?? "{}"));
    } catch {
      throw new AiVerseMemoryRecallError("MEMORY_BRIDGE_INVALID", "AI-Verse Memory recall bridge returned invalid JSON");
    }
  }
}

/**
 * Runtime-only Memory adapter. Recall happens only when the Task explicitly
 * carries `memory_recall`; absent requests leave standalone/native execution
 * unchanged. The source is always bound to the Task workspace and can never
 * opt into Memory's cross-workspace mode.
 */
export class MemoryRecallRuntimeRegistry extends RuntimeRegistry {
  private readonly wrapped = new Map<string, RuntimeAdapter>();

  constructor(readonly base: RuntimeRegistry, readonly source?: MemoryRecallSource | null) {
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
        const request = normalizeMemoryRecallRequest(context.task.payload.memory_recall, context.task.payload.objective);
        if (!request) return inner.execute(context);
        if (!source) {
          throw new AiVerseMemoryRecallError("MEMORY_NOT_AVAILABLE", `Task ${context.task.id} requested Memory recall but no AI-Verse Memory adapter is available`);
        }
        if (context.signal.aborted) throw context.signal.reason ?? new Error("Task canceled");
        const workspaceId = context.task.workspaceId;
        if (!workspaceId || !context.principal.workspaceId || context.principal.workspaceId !== workspaceId) {
          throw new AiVerseMemoryRecallError("MEMORY_WORKSPACE_MISMATCH", `Memory recall requires Task ${context.task.id} and ${context.principal.id} to share one explicit workspace`);
        }
        const projection = source.recall(workspaceId, request);
        if (projection.workspace_id !== workspaceId) {
          throw new AiVerseMemoryRecallError("MEMORY_WORKSPACE_MISMATCH", `Memory source returned workspace ${projection.workspace_id} for Task workspace ${workspaceId}`);
        }
        const result = await inner.execute({ ...context, memoryRecall: projection });
        const receipt: JsonObject = {
          kind: "ai_verse_memory_recall",
          provider: projection.provider,
          schema_version: projection.schema_version,
          workspace_id: projection.workspace_id,
          request_digest: projection.request_digest,
          projection_digest: projection.projection_digest,
          sources: Array.isArray(projection.sources) ? projection.sources : [],
          result_count: Array.isArray(projection.data.items) ? projection.data.items.length : 0
        };
        return { ...result, receipts: [...(result.receipts ?? []), receipt] };
      },
      ...(inner.cancel ? { cancel: (taskId: string) => inner.cancel!(taskId) } : {})
    };
    this.wrapped.set(id, wrapped);
    return wrapped;
  }
}
