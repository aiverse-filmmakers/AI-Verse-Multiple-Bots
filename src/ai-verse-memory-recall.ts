import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { detectAiVerseOsCompatibility } from "./ai-verse-os-registration.js";

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;
const MAX_QUERY_CHARS = 2_048;
const MAX_ITEM_TEXT_CHARS = 8_000;
const MAX_ITEM_WHY_CHARS = 2_000;
const MAX_TOTAL_TEXT_CHARS = 32_000;
const MAX_PROCESS_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ALLOWED_KINDS = new Set(["context", "workspace_manifest", "decision", "profile", "memory_summary", "memory"]);

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
rows = module.recall(query, limit=limit, include_history=include_history, root=root, mode=mode, workspace=workspace, all_workspaces=False)

def get(row, key):
    try:
        return row[key] if key in row.keys() else None
    except Exception:
        return None

items = [{
    "id": get(row, "id"), "kind": get(row, "kind"), "type": get(row, "type"),
    "scope": get(row, "scope"), "status": get(row, "status"),
    "importance": get(row, "importance"), "confidence": get(row, "confidence"),
    "updated_at": get(row, "updated_at"), "source": get(row, "source"),
    "text": get(row, "text"), "why": get(row, "why"), "path": get(row, "path"),
    "source_identity": get(row, "source_identity"), "source_version": get(row, "source_version"),
    "freshness": get(row, "freshness"), "indexed_at": get(row, "indexed_at")
} for row in rows]
print(json.dumps({"provider":"ai-verse-memory","provider_version":str(getattr(module,"VERSION","unknown")),"mode":mode,"workspace_id":workspace,"items":items}, ensure_ascii=False))
`;

export type MemoryRecallCompatibilityStatus = "available" | "absent" | "invalid";
export interface AiVerseMemoryCompatibility { status: MemoryRecallCompatibilityStatus; root: string; entrypoint: string; providerVersion: string | null; reason: string; }
export interface MemoryRecallDirective { query: string; limit: number; include_history: boolean; }
export interface MemoryRecallRequest { workspaceId: string; query: string; limit?: number; includeHistory?: boolean; }
export interface MemoryRecallItem {
  id: string; kind: string; type: string; scope: string; status: string;
  importance: number | null; confidence: number | null; updated_at: string | null; source: string | null;
  text: string; why: string; path: string; source_identity: string; source_version: string;
  freshness: "fresh" | "historical"; indexed_at: string | null; item_digest: string;
}
export interface MemoryRecallProjection {
  schema_version: "1.0"; provider: "ai-verse-memory"; provider_version: string; workspace_id: string;
  query: string; query_digest: string; requested_limit: number; include_history: boolean; retrieved_at: string;
  recall_digest: string; items: MemoryRecallItem[];
}
export interface MemoryRecallProvider { recall(request: MemoryRecallRequest): Promise<MemoryRecallProjection>; }
export interface MemoryCommandResult { stdout: string; stderr: string; }
export type MemoryCommandRunner = (executable: string, args: string[], options: { cwd: string; timeoutMs: number; maxBuffer: number }) => Promise<MemoryCommandResult>;
export interface AiVerseMemoryRecallProviderOptions { pythonExecutable?: string; timeoutMs?: number; commandRunner?: MemoryCommandRunner; }

export class AiVerseMemoryRecallError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "AiVerseMemoryRecallError"; }
}

function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function asRecord(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function requiredString(value: unknown, label: string, maxLength = 2_048): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new AiVerseMemoryRecallError("MEMORY_RESPONSE_INVALID", `${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new AiVerseMemoryRecallError("MEMORY_RESPONSE_TOO_LARGE", `${label} exceeds ${maxLength} characters`);
  return normalized;
}
function optionalString(value: unknown, maxLength = 2_048): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new AiVerseMemoryRecallError("MEMORY_RESPONSE_INVALID", "Memory response field must be a string or null");
  if (value.length > maxLength) throw new AiVerseMemoryRecallError("MEMORY_RESPONSE_TOO_LARGE", "Memory response string exceeds bounded size");
  return value;
}
function optionalFinite(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new AiVerseMemoryRecallError("MEMORY_RESPONSE_INVALID", "Memory response numeric field is invalid");
  return parsed;
}
function assertWorkspaceId(workspaceId: string): string {
  const value = workspaceId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new AiVerseMemoryRecallError("MEMORY_WORKSPACE_INVALID", `Invalid AI-Verse workspace id ${workspaceId}`);
  return value;
}
function safeRelativePath(value: unknown, workspaceId: string, scope: string): string {
  const path = requiredString(value, "Memory source path", 1_024).replaceAll("\\", "/");
  const parts = path.split("/");
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.includes("\0") || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new AiVerseMemoryRecallError("MEMORY_SOURCE_PATH_INVALID", `Unsafe Memory source path ${path}`);
  }
  const expectedPrefix = scope === "operator" ? "operator/" : `workspaces/${workspaceId}/`;
  if (!path.startsWith(expectedPrefix)) throw new AiVerseMemoryRecallError("MEMORY_SCOPE_VIOLATION", `Memory source ${path} is outside authorized scope ${scope}`);
  return path;
}
function regularNonSymlink(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
}
function parseEngineVersion(enginePath: string): string | null {
  try { return readFileSync(enginePath, "utf8").match(/^VERSION\s*=\s*["']([^"']+)["']/m)?.[1] ?? null; } catch { return null; }
}

export function detectAiVerseMemoryCompatibility(osRoot: string): AiVerseMemoryCompatibility {
  const root = resolve(osRoot);
  const entrypoint = resolve(root, "scripts", "ai-verse-memory", "memory.py");
  const engine = resolve(root, "scripts", "ai-verse-memory", "memory_engine.py");
  const osCompat = resolve(root, "scripts", "ai-verse-memory", "os_compat.py");
  const components = [entrypoint, engine, osCompat];
  const present = components.filter((path) => existsSync(path));
  if (present.length === 0) return { status: "absent", root, entrypoint, providerVersion: null, reason: "AI-Verse Memory is not installed under scripts/ai-verse-memory" };
  const os = detectAiVerseOsCompatibility(root);
  if (os.status !== "compatible") return { status: "invalid", root, entrypoint, providerVersion: null, reason: `AI-Verse Memory native recall requires a compatible AI-Verse OS v2 host: ${os.reason}` };
  const missing = components.filter((path) => !existsSync(path));
  if (missing.length > 0) return { status: "invalid", root, entrypoint, providerVersion: null, reason: `AI-Verse Memory installation is incomplete: missing ${missing.map((path) => path.slice(root.length + 1)).join(", ")}` };
  const unsafe = components.find((path) => !regularNonSymlink(path));
  if (unsafe) return { status: "invalid", root, entrypoint, providerVersion: null, reason: `AI-Verse Memory component must be a regular non-symlink file: ${unsafe.slice(root.length + 1)}` };
  const providerVersion = parseEngineVersion(engine);
  if (!providerVersion) return { status: "invalid", root, entrypoint, providerVersion: null, reason: "AI-Verse Memory engine does not expose a readable VERSION contract" };
  return { status: "available", root, entrypoint, providerVersion, reason: `AI-Verse Memory ${providerVersion} native recall is available` };
}

export function normalizeMemoryRecallDirective(value: unknown): MemoryRecallDirective | null {
  if (value === undefined || value === null) return null;
  const source = asRecord(value);
  const allowed = new Set(["query", "limit", "include_history"]);
  const unknown = Object.keys(source).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new AiVerseMemoryRecallError("MEMORY_RECALL_DIRECTIVE_INVALID", `Unsupported memory_recall field(s): ${unknown.join(", ")}`);
  if (typeof source.query !== "string" || source.query.trim().length === 0) throw new AiVerseMemoryRecallError("MEMORY_RECALL_QUERY_REQUIRED", "memory_recall.query must be a non-empty string");
  const query = source.query.trim();
  if (query.length > MAX_QUERY_CHARS || query.includes("\0")) throw new AiVerseMemoryRecallError("MEMORY_RECALL_QUERY_INVALID", `memory_recall.query must be at most ${MAX_QUERY_CHARS} characters and contain no NUL bytes`);
  const rawLimit = source.limit ?? DEFAULT_LIMIT;
  if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_LIMIT) throw new AiVerseMemoryRecallError("MEMORY_RECALL_LIMIT_INVALID", `memory_recall.limit must be an integer from 1 to ${MAX_LIMIT}`);
  if (source.include_history !== undefined && typeof source.include_history !== "boolean") throw new AiVerseMemoryRecallError("MEMORY_RECALL_HISTORY_INVALID", "memory_recall.include_history must be boolean when provided");
  return { query, limit: rawLimit, include_history: source.include_history === true };
}

async function defaultCommandRunner(executable: string, args: string[], options: { cwd: string; timeoutMs: number; maxBuffer: number }): Promise<MemoryCommandResult> {
  const childProcess = process.getBuiltinModule?.("node:child_process") as any;
  if (!childProcess?.execFile) throw new AiVerseMemoryRecallError("MEMORY_PROCESS_UNAVAILABLE", "Node child_process.execFile is unavailable");
  return new Promise((resolvePromise, rejectPromise) => {
    childProcess.execFile(executable, args, { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: options.maxBuffer, encoding: "utf8", windowsHide: true, shell: false }, (error: any, stdout: unknown, stderr: unknown) => {
      if (error) {
        const wrapped = new Error(String(error.message ?? error));
        (wrapped as any).code = error.code; (wrapped as any).killed = error.killed; (wrapped as any).signal = error.signal; (wrapped as any).stderr = String(stderr ?? "");
        rejectPromise(wrapped); return;
      }
      resolvePromise({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
function pythonCandidates(explicit?: string): string[] {
  const requested = explicit?.trim() || String(process.env.AI_VERSE_MEMORY_PYTHON ?? "").trim();
  if (requested) return [requested];
  return process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
}

export class AiVerseMemoryRecallProvider implements MemoryRecallProvider {
  readonly compatibility: AiVerseMemoryCompatibility;
  private readonly timeoutMs: number;
  private readonly commandRunner: MemoryCommandRunner;
  private readonly python: string[];

  constructor(readonly osRoot: string, options: AiVerseMemoryRecallProviderOptions = {}) {
    this.compatibility = detectAiVerseMemoryCompatibility(osRoot);
    if (this.compatibility.status !== "available") throw new AiVerseMemoryRecallError(this.compatibility.status === "absent" ? "MEMORY_NOT_INSTALLED" : "MEMORY_INSTALL_INVALID", this.compatibility.reason);
    this.timeoutMs = Math.max(1_000, Math.min(60_000, Math.floor(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
    this.python = pythonCandidates(options.pythonExecutable);
  }

  async recall(request: MemoryRecallRequest): Promise<MemoryRecallProjection> {
    const workspaceId = assertWorkspaceId(request.workspaceId);
    const directive = normalizeMemoryRecallDirective({ query: request.query, limit: request.limit ?? DEFAULT_LIMIT, include_history: request.includeHistory === true });
    if (!directive) throw new AiVerseMemoryRecallError("MEMORY_RECALL_QUERY_REQUIRED", "Memory recall request is required");
    const response = asRecord(await this.invokeBridge(workspaceId, directive));
    if (response.provider !== "ai-verse-memory") throw new AiVerseMemoryRecallError("MEMORY_RESPONSE_INVALID", "Memory bridge returned an unexpected provider");
    if (response.mode !== "ai-verse-os-v2") throw new AiVerseMemoryRecallError("MEMORY_MODE_INVALID", `Memory bridge returned unsupported mode ${String(response.mode)}`);
    if (response.workspace_id !== workspaceId) throw new AiVerseMemoryRecallError("MEMORY_SCOPE_VIOLATION", `Memory bridge returned workspace ${String(response.workspace_id)} for ${workspaceId}`);
    const providerVersion = requiredString(response.provider_version, "Memory provider version", 128);
    const rawItems = Array.isArray(response.items) ? response.items : null;
    if (!rawItems) throw new AiVerseMemoryRecallError("MEMORY_RESPONSE_INVALID", "Memory bridge response.items must be an array");
    if (rawItems.length > directive.limit || rawItems.length > MAX_LIMIT) throw new AiVerseMemoryRecallError("MEMORY_RESPONSE_TOO_LARGE", `Memory bridge returned ${rawItems.length} items for limit ${directive.limit}`);

    const items: MemoryRecallItem[] = [];
    let totalText = 0;
    for (const rawItem of rawItems) {
      const source = asRecord(rawItem);
      const id = requiredString(source.id, "Memory item id", 256);
      const kind = requiredString(source.kind, `Memory item ${id} kind`, 64);
      if (!ALLOWED_KINDS.has(kind)) throw new AiVerseMemoryRecallError("MEMORY_RESPONSE_INVALID", `Memory item ${id} has unsupported kind ${kind}`);
      const type = requiredString(source.type, `Memory item ${id} type`, 128);
      const scope = requiredString(source.scope, `Memory item ${id} scope`, 256);
      if (scope !== "operator" && scope !== `workspace:${workspaceId}`) throw new AiVerseMemoryRecallError("MEMORY_SCOPE_VIOLATION", `Memory item ${id} escaped workspace ${workspaceId}: ${scope}`);
      const status = requiredString(source.status ?? "active", `Memory item ${id} status`, 64);
      if (!directive.include_history && status !== "active") throw new AiVerseMemoryRecallError("MEMORY_HISTORY_VIOLATION", `Memory item ${id} returned non-active status without include_history`);
      const text = typeof source.text === "string" ? source.text.trim() : "";
      const why = typeof source.why === "string" ? source.why.trim() : "";
      if (!text) throw new AiVerseMemoryRecallError("MEMORY_RESPONSE_INVALID", `Memory item ${id} has no text`);
      if (text.length > MAX_ITEM_TEXT_CHARS || why.length > MAX_ITEM_WHY_CHARS) throw new AiVerseMemoryRecallError("MEMORY_RESPONSE_TOO_LARGE", `Memory item ${id} exceeds bounded text limits`);
      totalText += text.length + why.length;
      if (totalText > MAX_TOTAL_TEXT_CHARS) throw new AiVerseMemoryRecallError("MEMORY_RESPONSE_TOO_LARGE", `Memory recall exceeds ${MAX_TOTAL_TEXT_CHARS} total text characters`);
      const path = safeRelativePath(source.path, workspaceId, scope);
      const sourceIdentity = requiredString(source.source_identity, `Memory item ${id} source identity`, 128);
      const sourceVersion = requiredString(source.source_version, `Memory item ${id} source version`, 128);
      if (!SHA256_PATTERN.test(sourceIdentity) || !SHA256_PATTERN.test(sourceVersion)) throw new AiVerseMemoryRecallError("MEMORY_PROVENANCE_INVALID", `Memory item ${id} lacks canonical SHA-256 source provenance`);
      const rawFreshness = source.freshness;
      if (rawFreshness !== "fresh" && rawFreshness !== "historical") throw new AiVerseMemoryRecallError("MEMORY_PROVENANCE_INVALID", `Memory item ${id} has invalid freshness ${String(rawFreshness)}`);
      const freshness: "fresh" | "historical" = rawFreshness;
      const itemBase = {
        id, kind, type, scope, status,
        importance: optionalFinite(source.importance), confidence: optionalFinite(source.confidence),
        updated_at: optionalString(source.updated_at, 128), source: optionalString(source.source, 2_048),
        text, why, path, source_identity: sourceIdentity, source_version: sourceVersion, freshness,
        indexed_at: optionalString(source.indexed_at, 128)
      };
      items.push({ ...itemBase, item_digest: sha256(JSON.stringify(itemBase)) });
    }

    const queryDigest = sha256(directive.query);
    const recallDigest = sha256(JSON.stringify({ workspace_id: workspaceId, query_digest: queryDigest, include_history: directive.include_history, items: items.map((item) => ({ source_identity: item.source_identity, source_version: item.source_version, item_digest: item.item_digest })) }));
    return { schema_version: "1.0", provider: "ai-verse-memory", provider_version: providerVersion, workspace_id: workspaceId, query: directive.query, query_digest: queryDigest, requested_limit: directive.limit, include_history: directive.include_history, retrieved_at: new Date().toISOString(), recall_digest: recallDigest, items };
  }

  private async invokeBridge(workspaceId: string, directive: MemoryRecallDirective): Promise<unknown> {
    const args = ["-c", MEMORY_BRIDGE, this.compatibility.entrypoint, this.compatibility.root, workspaceId, directive.query, String(directive.limit), directive.include_history ? "1" : "0"];
    let lastError: unknown = null;
    for (const executable of this.python) {
      try {
        const result = await this.commandRunner(executable, args, { cwd: this.compatibility.root, timeoutMs: this.timeoutMs, maxBuffer: MAX_PROCESS_OUTPUT_BYTES });
        if (result.stderr.trim() && !result.stdout.trim()) throw new AiVerseMemoryRecallError("MEMORY_PROCESS_FAILED", `AI-Verse Memory recall failed: ${result.stderr.replace(/\s+/g, " ").slice(0, 500)}`);
        try { return JSON.parse(result.stdout); } catch { throw new AiVerseMemoryRecallError("MEMORY_RESPONSE_INVALID", "AI-Verse Memory bridge returned invalid JSON"); }
      } catch (error) {
        lastError = error;
        if ((error as any)?.code === "ENOENT" && this.python.length > 1) continue;
        if (error instanceof AiVerseMemoryRecallError) throw error;
        const stderr = String((error as any)?.stderr ?? "").replace(/\s+/g, " ").slice(0, 500);
        throw new AiVerseMemoryRecallError((error as any)?.killed ? "MEMORY_PROCESS_TIMEOUT" : "MEMORY_PROCESS_FAILED", `AI-Verse Memory recall process failed${stderr ? `: ${stderr}` : `: ${error instanceof Error ? error.message : String(error)}`}`);
      }
    }
    throw new AiVerseMemoryRecallError("MEMORY_PYTHON_UNAVAILABLE", `No Python executable is available for AI-Verse Memory recall: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}

export function createOptionalAiVerseMemoryRecallProvider(osRoot: string, options: AiVerseMemoryRecallProviderOptions = {}): AiVerseMemoryRecallProvider | undefined {
  const compatibility = detectAiVerseMemoryCompatibility(osRoot);
  if (compatibility.status === "absent") return undefined;
  if (compatibility.status === "invalid") throw new AiVerseMemoryRecallError("MEMORY_INSTALL_INVALID", compatibility.reason);
  return new AiVerseMemoryRecallProvider(osRoot, options);
}
