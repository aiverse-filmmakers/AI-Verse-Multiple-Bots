import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import process from "node:process";
import { detectAiVerseOsCompatibility } from "./ai-verse-os-registration.js";
import type {
  HistoricalRecallItem,
  HistoricalRecallProjection,
  HistoricalRecallRequest,
  HistoricalRecallSource
} from "./runtime.js";

export const AI_VERSE_MEMORY_PROVIDER_ID = "ai-verse-memory";
export const AI_VERSE_MEMORY_RECALL_SCHEMA_VERSION = "1.0";
export const AI_VERSE_MEMORY_ENGINE_PATH = "scripts/ai-verse-memory/memory.py";
export const AI_VERSE_MEMORY_MIN_NATIVE_VERSION = "0.2.0";
export const AI_VERSE_MEMORY_MAX_QUERY_CHARS = 2_000;
export const AI_VERSE_MEMORY_MAX_RESULTS = 12;
export const AI_VERSE_MEMORY_MAX_ITEM_CHARS = 8_000;
export const AI_VERSE_MEMORY_MAX_WHY_CHARS = 2_000;
export const AI_VERSE_MEMORY_MAX_TOTAL_CHARS = 24_000;
export const AI_VERSE_MEMORY_DEFAULT_TIMEOUT_MS = 10_000;
export const AI_VERSE_MEMORY_MAX_BUFFER_BYTES = 512 * 1024;

const MEMORY_IMPLEMENTATION_PATH = "scripts/ai-verse-memory/memory_engine.py";
const MEMORY_COMPATIBILITY_PATH = "scripts/ai-verse-memory/os_compat.py";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ALLOWED_KINDS = new Set(["memory", "context", "workspace_manifest", "decision", "profile", "memory_summary"]);

const MEMORY_BRIDGE = String.raw`
import importlib.util
import json
import pathlib
import sys

entry = pathlib.Path(sys.argv[1]).resolve()
root = pathlib.Path(sys.argv[2]).resolve()
workspace = sys.argv[3]
query = sys.argv[4]
limit = int(sys.argv[5])
include_history = sys.argv[6] == "1"

spec = importlib.util.spec_from_file_location("_aiverse_multiple_bots_memory_bridge", entry)
if spec is None or spec.loader is None:
    raise RuntimeError("Could not load AI-Verse Memory entrypoint")
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
mode = module.detect_mode(root)
expected_mode = getattr(module, "MODE_NATIVE", "ai-verse-os-v2")
if mode != expected_mode:
    raise RuntimeError(f"AI-Verse Memory is not in native OS mode: {mode}")
if not callable(getattr(module, "recall", None)):
    raise RuntimeError("AI-Verse Memory does not expose the recall engine contract")
rows = module.recall(
    query,
    limit=limit,
    include_history=include_history,
    root=root,
    mode=mode,
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
    "provider": "ai-verse-memory",
    "provider_version": str(getattr(module, "VERSION", "unknown")),
    "mode": mode,
    "workspace_id": workspace,
    "items": items,
}, ensure_ascii=False))
`;

export type AiVerseMemoryInstallationStatus = "absent" | "compatible" | "incompatible";

export interface AiVerseMemoryInstallation {
  status: AiVerseMemoryInstallationStatus;
  root: string;
  reason: string;
  providerVersion: string | null;
  entrypoint: string;
}

export interface AiVerseMemoryRecallOptions {
  pythonExecutable?: string;
  timeoutMs?: number;
  maxResults?: number;
  maxItemChars?: number;
  maxWhyChars?: number;
  maxTotalChars?: number;
  execFileImpl?: typeof execFile;
  now?: () => Date;
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

function prefixedSha256(value: string): string {
  return `sha256:${sha256(value)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, label: string, maxChars = 2_048): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", `${label} must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > maxChars) {
    throw new AiVerseMemoryRecallError("MEMORY_OUTPUT_TOO_LARGE", `${label} exceeds ${maxChars} characters`);
  }
  return text;
}

function optionalString(value: unknown, label: string, maxChars = 2_048): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, label, maxChars);
}

function optionalNumber(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", `${label} must be a finite number`);
  }
  return parsed;
}

function inside(path: string, root: string): boolean {
  const candidate = resolve(path);
  const base = resolve(root);
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

function regularNonSymlink(path: string, label: string): void {
  if (!existsSync(path)) throw new AiVerseMemoryRecallError("MEMORY_UNAVAILABLE", `${label} is missing: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new AiVerseMemoryRecallError("MEMORY_UNSAFE_INSTALL", `${label} must not be a symlink: ${path}`);
  if (!stat.isFile()) throw new AiVerseMemoryRecallError("MEMORY_UNSAFE_INSTALL", `${label} must be a regular file: ${path}`);
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function versionAtLeast(value: string, minimum: string): boolean {
  const actual = parseVersion(value);
  const floor = parseVersion(minimum);
  if (!actual || !floor) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index]! > floor[index]!) return true;
    if (actual[index]! < floor[index]!) return false;
  }
  return true;
}

function parseEngineVersion(path: string): string | null {
  try {
    return readFileSync(path, "utf8").match(/^VERSION\s*=\s*["']([^"']+)["']\s*$/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function detectAiVerseMemoryInstallation(rootInput: string): AiVerseMemoryInstallation {
  const root = resolve(rootInput);
  const entrypoint = resolve(root, ...AI_VERSE_MEMORY_ENGINE_PATH.split("/"));
  const implementation = resolve(root, ...MEMORY_IMPLEMENTATION_PATH.split("/"));
  const compatibilityGate = resolve(root, ...MEMORY_COMPATIBILITY_PATH.split("/"));
  const host = detectAiVerseOsCompatibility(root);
  if (host.status !== "compatible") {
    return {
      status: "incompatible",
      root,
      reason: `AI-Verse Memory native recall requires a compatible AI-Verse OS v2 host: ${host.reason}`,
      providerVersion: null,
      entrypoint
    };
  }

  const required = [entrypoint, implementation, compatibilityGate];
  const present = required.filter((path) => existsSync(path));
  if (present.length === 0) {
    return {
      status: "absent",
      root,
      reason: "AI-Verse Memory is not installed under scripts/ai-verse-memory",
      providerVersion: null,
      entrypoint
    };
  }
  if (present.length !== required.length) {
    return {
      status: "incompatible",
      root,
      reason: "AI-Verse Memory installation is incomplete",
      providerVersion: null,
      entrypoint
    };
  }

  try {
    regularNonSymlink(entrypoint, "AI-Verse Memory entrypoint");
    regularNonSymlink(implementation, "AI-Verse Memory implementation");
    regularNonSymlink(compatibilityGate, "AI-Verse Memory compatibility gate");
    const providerVersion = parseEngineVersion(implementation);
    if (!providerVersion || !versionAtLeast(providerVersion, AI_VERSE_MEMORY_MIN_NATIVE_VERSION)) {
      return {
        status: "incompatible",
        root,
        reason: `AI-Verse Memory ${providerVersion ?? "unknown"} does not expose the supported native ${AI_VERSE_MEMORY_MIN_NATIVE_VERSION}+ recall contract`,
        providerVersion,
        entrypoint
      };
    }
    return {
      status: "compatible",
      root,
      reason: `AI-Verse Memory ${providerVersion} native recall is available`,
      providerVersion,
      entrypoint
    };
  } catch (error) {
    return {
      status: "incompatible",
      root,
      reason: error instanceof Error ? error.message : String(error),
      providerVersion: null,
      entrypoint
    };
  }
}

function safeWorkspaceId(value: string): string {
  const workspace = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspace)) {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_REQUEST", `Unsafe workspace id for Memory recall: ${value}`);
  }
  return workspace;
}

function safeRelativeSourcePath(value: unknown, workspaceId: string, scope: string): string {
  const normalized = requiredString(value, "Memory source path", 2_048).replace(/\\/g, "/");
  if (normalized.includes("\0") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", `Memory recall returned an unsafe source path: ${normalized}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", `Memory recall returned an unsafe source path: ${normalized}`);
  }
  const prefix = scope === "operator" ? "operator/" : `workspaces/${workspaceId}/`;
  if (!normalized.startsWith(prefix)) {
    throw new AiVerseMemoryRecallError("MEMORY_SCOPE_VIOLATION", `Memory source ${normalized} is outside ${scope}`);
  }
  return normalized;
}

function validateSourceFile(
  root: string,
  path: string,
  kind: string,
  scope: string,
  sourceIdentity: string,
  sourceVersion: string
): void {
  const parts = path.split("/");
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    if (!existsSync(current)) {
      throw new AiVerseMemoryRecallError("MEMORY_SOURCE_MISSING", `Memory source no longer exists: ${path}`);
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw new AiVerseMemoryRecallError("MEMORY_SOURCE_UNSAFE", `Memory source path must not contain symlinks: ${path}`);
    }
  }
  const stat = lstatSync(current);
  if (!stat.isFile()) {
    throw new AiVerseMemoryRecallError("MEMORY_SOURCE_UNSAFE", `Memory source must be a regular file: ${path}`);
  }
  const realRoot = realpathSync(root);
  const realSource = realpathSync(current);
  if (!inside(realSource, realRoot)) {
    throw new AiVerseMemoryRecallError("MEMORY_SOURCE_UNSAFE", `Memory source resolves outside the AI-Verse OS root: ${path}`);
  }

  const expectedIdentity = prefixedSha256(`${kind}\n${scope}\n${path}`);
  if (sourceIdentity !== expectedIdentity) {
    throw new AiVerseMemoryRecallError("MEMORY_PROVENANCE_INVALID", `Memory source identity does not match canonical source ${path}`);
  }
  const expectedVersion = prefixedSha256(readFileSync(current, "utf8"));
  if (sourceVersion !== expectedVersion) {
    throw new AiVerseMemoryRecallError("MEMORY_SOURCE_CHANGED", `Memory source ${path} changed during or after recall; retry with fresh Memory state`);
  }
}

function normalizeRequest(request: HistoricalRecallRequest, maxResults: number): Required<HistoricalRecallRequest> {
  if (!request || typeof request !== "object") {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_REQUEST", "Memory recall request must be an object");
  }
  const query = typeof request.query === "string" ? request.query.trim() : "";
  if (!query || query.includes("\0")) {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_REQUEST", "Memory recall query is required and must not contain NUL bytes");
  }
  if (query.length > AI_VERSE_MEMORY_MAX_QUERY_CHARS) {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_REQUEST", `Memory recall query exceeds ${AI_VERSE_MEMORY_MAX_QUERY_CHARS} characters`);
  }
  const limit = request.limit ?? Math.min(8, maxResults);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxResults) {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_REQUEST", `Memory recall limit must be an integer from 1 to ${maxResults}`);
  }
  if (request.include_history !== undefined && typeof request.include_history !== "boolean") {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_REQUEST", "memory_recall.include_history must be boolean");
  }
  return { query, limit, include_history: request.include_history === true };
}

function pythonCandidates(explicit?: string): string[] {
  const requested = explicit?.trim() || String(process.env.AI_VERSE_MEMORY_PYTHON ?? "").trim();
  if (requested) return [requested];
  return process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
}

function runExecFile(
  execFileImpl: typeof execFile,
  executable: string,
  args: string[],
  root: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFileImpl(
      executable,
      args,
      {
        cwd: root,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: AI_VERSE_MEMORY_MAX_BUFFER_BYTES,
        windowsHide: true,
        shell: false
      },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          (error as any).stderr = String(stderr ?? "");
          rejectPromise(error);
          return;
        }
        resolvePromise({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    );
  });
}

export class AiVerseMemoryRecallSource implements HistoricalRecallSource {
  readonly provider = AI_VERSE_MEMORY_PROVIDER_ID;
  readonly root: string;
  readonly enginePath: string;
  private readonly pythonExecutable?: string;
  private readonly timeoutMs: number;
  private readonly maxResults: number;
  private readonly maxItemChars: number;
  private readonly maxWhyChars: number;
  private readonly maxTotalChars: number;
  private readonly execFileImpl: typeof execFile;
  private readonly now: () => Date;

  constructor(rootInput: string, options: AiVerseMemoryRecallOptions = {}) {
    this.root = resolve(rootInput);
    this.enginePath = resolve(this.root, ...AI_VERSE_MEMORY_ENGINE_PATH.split("/"));
    this.pythonExecutable = options.pythonExecutable?.trim() || undefined;
    this.timeoutMs = Math.max(1_000, Math.min(60_000, Math.floor(options.timeoutMs ?? AI_VERSE_MEMORY_DEFAULT_TIMEOUT_MS)));
    this.maxResults = Math.min(AI_VERSE_MEMORY_MAX_RESULTS, Math.max(1, options.maxResults ?? AI_VERSE_MEMORY_MAX_RESULTS));
    this.maxItemChars = Math.min(AI_VERSE_MEMORY_MAX_ITEM_CHARS, Math.max(256, options.maxItemChars ?? AI_VERSE_MEMORY_MAX_ITEM_CHARS));
    this.maxWhyChars = Math.min(AI_VERSE_MEMORY_MAX_WHY_CHARS, Math.max(0, options.maxWhyChars ?? AI_VERSE_MEMORY_MAX_WHY_CHARS));
    this.maxTotalChars = Math.min(AI_VERSE_MEMORY_MAX_TOTAL_CHARS, Math.max(this.maxItemChars, options.maxTotalChars ?? AI_VERSE_MEMORY_MAX_TOTAL_CHARS));
    this.execFileImpl = options.execFileImpl ?? execFile;
    this.now = options.now ?? (() => new Date());
  }

  async recall(workspaceId: string, requestInput: HistoricalRecallRequest): Promise<HistoricalRecallProjection> {
    const workspace = safeWorkspaceId(workspaceId);
    const installation = detectAiVerseMemoryInstallation(this.root);
    if (installation.status === "absent") {
      throw new AiVerseMemoryRecallError("MEMORY_UNAVAILABLE", installation.reason);
    }
    if (installation.status !== "compatible" || !installation.providerVersion) {
      throw new AiVerseMemoryRecallError("MEMORY_UNSAFE_INSTALL", installation.reason);
    }

    const workspaceManifest = resolve(this.root, "workspaces", workspace, "WORKSPACE.yaml");
    regularNonSymlink(workspaceManifest, `AI-Verse workspace ${workspace} manifest`);
    const request = normalizeRequest(requestInput, this.maxResults);
    const args = [
      "-c",
      MEMORY_BRIDGE,
      installation.entrypoint,
      this.root,
      workspace,
      request.query,
      String(request.limit),
      request.include_history ? "1" : "0"
    ];

    let stdout = "";
    let lastError: unknown = null;
    for (const executable of pythonCandidates(this.pythonExecutable)) {
      try {
        ({ stdout } = await runExecFile(this.execFileImpl, executable, args, this.root, this.timeoutMs));
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if ((error as any)?.code === "ENOENT" && !this.pythonExecutable) continue;
        const stderr = String((error as any)?.stderr ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
        const timeout = (error as any)?.killed === true || (error as any)?.signal === "SIGTERM";
        throw new AiVerseMemoryRecallError(
          timeout ? "MEMORY_ENGINE_TIMEOUT" : "MEMORY_ENGINE_FAILED",
          `AI-Verse Memory recall failed${stderr ? `: ${stderr}` : `: ${error instanceof Error ? error.message : String(error)}`}`
        );
      }
    }
    if (lastError) {
      throw new AiVerseMemoryRecallError(
        "MEMORY_PYTHON_UNAVAILABLE",
        `No Python executable is available for AI-Verse Memory recall: ${lastError instanceof Error ? lastError.message : String(lastError)}`
      );
    }

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(stdout);
      const object = asObject(parsed);
      if (!object) throw new Error("response is not an object");
      payload = object;
    } catch (error) {
      throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", `AI-Verse Memory bridge returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (payload.provider !== AI_VERSE_MEMORY_PROVIDER_ID || payload.mode !== "ai-verse-os-v2" || payload.workspace_id !== workspace) {
      throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", "AI-Verse Memory bridge returned an invalid native workspace response");
    }
    if (payload.provider_version !== installation.providerVersion) {
      throw new AiVerseMemoryRecallError("MEMORY_INSTALL_CHANGED", "AI-Verse Memory version changed while recall was executing");
    }
    if (!Array.isArray(payload.items)) {
      throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", "AI-Verse Memory bridge response.items must be an array");
    }
    if (payload.items.length > request.limit || payload.items.length > this.maxResults) {
      throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", "AI-Verse Memory returned more items than the requested recall limit");
    }

    const items: HistoricalRecallItem[] = [];
    let totalChars = 0;
    for (const [index, rawItem] of payload.items.entries()) {
      const item = asObject(rawItem);
      if (!item) throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", `Memory result ${index} must be an object`);
      const id = requiredString(item.id, `Memory result ${index}.id`, 256);
      const kind = requiredString(item.kind, `Memory result ${id}.kind`, 64);
      if (!ALLOWED_KINDS.has(kind)) {
        throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", `Memory result ${id} has unsupported kind ${kind}`);
      }
      const type = requiredString(item.type ?? kind, `Memory result ${id}.type`, 128);
      const scope = requiredString(item.scope, `Memory result ${id}.scope`, 256);
      if (scope !== "operator" && scope !== `workspace:${workspace}`) {
        throw new AiVerseMemoryRecallError("MEMORY_SCOPE_VIOLATION", `Memory result ${id} escaped workspace ${workspace} through ${scope}`);
      }
      const status = requiredString(item.status ?? "active", `Memory result ${id}.status`, 64);
      if (!request.include_history && status !== "active") {
        throw new AiVerseMemoryRecallError("MEMORY_HISTORY_VIOLATION", `Memory result ${id} returned non-active history without include_history`);
      }
      const content = requiredString(item.text, `Memory result ${id}.text`, this.maxItemChars);
      const why = optionalString(item.why, `Memory result ${id}.why`, this.maxWhyChars);
      totalChars += content.length + (why?.length ?? 0);
      if (totalChars > this.maxTotalChars) {
        throw new AiVerseMemoryRecallError("MEMORY_OUTPUT_TOO_LARGE", `Memory recall exceeds ${this.maxTotalChars} total characters`);
      }
      const path = safeRelativeSourcePath(item.path, workspace, scope);
      const sourceIdentity = requiredString(item.source_identity, `Memory result ${id}.source_identity`, 128);
      const sourceVersion = requiredString(item.source_version, `Memory result ${id}.source_version`, 128);
      if (!SHA256_PATTERN.test(sourceIdentity) || !SHA256_PATTERN.test(sourceVersion)) {
        throw new AiVerseMemoryRecallError("MEMORY_PROVENANCE_INVALID", `Memory result ${id} lacks canonical SHA-256 source provenance`);
      }
      const freshness = requiredString(item.freshness, `Memory result ${id}.freshness`, 64);
      if (freshness !== "fresh" && freshness !== "historical") {
        throw new AiVerseMemoryRecallError("MEMORY_PROVENANCE_INVALID", `Memory result ${id} has invalid freshness ${freshness}`);
      }
      if ((kind === "memory" && freshness !== "historical") || (kind !== "memory" && freshness !== "fresh")) {
        throw new AiVerseMemoryRecallError("MEMORY_PROVENANCE_INVALID", `Memory result ${id} has freshness ${freshness} inconsistent with ${kind}`);
      }
      validateSourceFile(this.root, path, kind, scope, sourceIdentity, sourceVersion);

      const itemBase = {
        id,
        kind,
        type,
        scope,
        content,
        why,
        path,
        source_identity: sourceIdentity,
        source: optionalString(item.source, `Memory result ${id}.source`),
        updated_at: optionalString(item.updated_at, `Memory result ${id}.updated_at`, 128),
        source_version: sourceVersion,
        freshness,
        indexed_at: optionalString(item.indexed_at, `Memory result ${id}.indexed_at`, 128),
        importance: optionalNumber(item.importance, `Memory result ${id}.importance`),
        confidence: optionalNumber(item.confidence, `Memory result ${id}.confidence`)
      };
      items.push({
        ...itemBase,
        digest: sha256(canonicalJson(itemBase))
      });
    }

    const queryDigest = sha256(request.query);
    const recallDigest = sha256(canonicalJson({
      provider: this.provider,
      provider_version: installation.providerVersion,
      workspace_id: workspace,
      query_digest: queryDigest,
      include_history: request.include_history,
      items: items.map((item) => ({
        id: item.id,
        scope: item.scope,
        path: item.path,
        digest: item.digest,
        source_identity: item.source_identity,
        source_version: item.source_version
      }))
    }));

    return {
      schema_version: AI_VERSE_MEMORY_RECALL_SCHEMA_VERSION,
      provider: this.provider,
      provider_version: installation.providerVersion,
      workspace_id: workspace,
      query_digest: queryDigest,
      recall_digest: recallDigest,
      recalled_at: this.now().toISOString(),
      include_history: request.include_history,
      requested_limit: request.limit,
      items
    };
  }
}
