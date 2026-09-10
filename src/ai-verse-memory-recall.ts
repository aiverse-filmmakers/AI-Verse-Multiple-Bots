import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import process from "node:process";
import { detectAiVerseOsCompatibility } from "./ai-verse-os-registration.js";
import type {
  MemoryRecallProjection,
  MemoryRecallProvider,
  MemoryRecallProviderInput,
  MemoryRecallSource
} from "./memory-recall-contract.js";
import type { JsonObject } from "./types.js";

export const AI_VERSE_MEMORY_RECALL_PROVIDER = "ai-verse-memory-recall-v1";
export const AI_VERSE_MEMORY_RECALL_SCHEMA = "1.0";

const MEMORY_ENGINE_DIRECTORY = "scripts/ai-verse-memory";
const MEMORY_ENGINE_ENTRYPOINT = `${MEMORY_ENGINE_DIRECTORY}/memory.py`;
const MEMORY_ENGINE_FILES = ["memory.py", "memory_engine.py", "os_compat.py"];
const PROCESS_TIMEOUT_MS = 15_000;
const PROCESS_MAX_BUFFER = 1024 * 1024;
const MAX_RESULT_TEXT = 8192;
const MAX_RESULT_WHY = 2048;
const MAX_METADATA_TEXT = 2048;

const PYTHON_RECALL_SCRIPT = String.raw`
import importlib.util
import json
import sys
from pathlib import Path

entrypoint = Path(sys.argv[1]).resolve()
root = Path(sys.argv[2]).resolve()
query = sys.argv[3]
scope_mode = sys.argv[4]
workspace_id = sys.argv[5] or None
limit = int(sys.argv[6])
include_history = sys.argv[7] == "1"
max_text = int(sys.argv[8])
max_why = int(sys.argv[9])
max_meta = int(sys.argv[10])

spec = importlib.util.spec_from_file_location("_aiverse_multiple_bots_memory_runtime", entrypoint)
if spec is None or spec.loader is None:
    raise RuntimeError("Could not load AI-Verse Memory entrypoint")
module = importlib.util.module_from_spec(spec)
sys.modules["_aiverse_multiple_bots_memory_runtime"] = module
spec.loader.exec_module(module)
mode = module.detect_mode(root)
if mode != module.MODE_NATIVE:
    raise RuntimeError(f"AI-Verse Memory is not in native mode: {mode}")

rows = module.recall(
    query,
    scope="operator" if scope_mode == "operator" else None,
    workspace=workspace_id if scope_mode == "workspace" else None,
    limit=limit,
    include_history=include_history,
    root=root,
    mode=mode,
    all_workspaces=False,
)

def bounded(value, limit):
    text = "" if value is None else str(value)
    return text[:limit], len(text) > limit

def value(row, key, default=None):
    return row[key] if key in row.keys() else default

items = []
for row in rows:
    text, text_truncated = bounded(value(row, "text", ""), max_text)
    why, why_truncated = bounded(value(row, "why", ""), max_why)
    source, source_truncated = bounded(value(row, "source", ""), max_meta)
    path, path_truncated = bounded(value(row, "path", ""), max_meta)
    items.append({
        "id": str(value(row, "id", "")),
        "kind": str(value(row, "kind", "")),
        "type": str(value(row, "type", "")),
        "scope": str(value(row, "scope", "")),
        "status": str(value(row, "status", "")),
        "importance": float(value(row, "importance", 0) or 0),
        "confidence": float(value(row, "confidence", 0) or 0),
        "updated_at": str(value(row, "updated_at", "") or ""),
        "source": source,
        "path": path,
        "source_identity": str(value(row, "source_identity", "") or ""),
        "source_version": str(value(row, "source_version", "") or ""),
        "freshness": str(value(row, "freshness", "") or ""),
        "indexed_at": str(value(row, "indexed_at", "") or ""),
        "text": text,
        "why": why,
        "text_truncated": text_truncated,
        "why_truncated": why_truncated,
        "source_truncated": source_truncated,
        "path_truncated": path_truncated,
    })

print(json.dumps({"mode": mode, "version": getattr(module, "VERSION", ""), "items": items}, ensure_ascii=False, separators=(",", ":")))
`;

export interface AiVerseMemoryRecallProviderOptions {
  pythonCommand?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export class AiVerseMemoryRecallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AiVerseMemoryRecallError";
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) result[key] = stableValue(source[key]);
    return result;
  }
  return value;
}

function digestValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredBoundedString(value: unknown, label: string, max = MAX_METADATA_TEXT): string {
  if (typeof value !== "string" || !value.trim()) throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", `${label} must be a non-empty string`);
  if (value.length > max) throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", `${label} exceeds ${max} characters`);
  return value;
}

function optionalBoundedString(value: unknown, label: string, max = MAX_METADATA_TEXT): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", `${label} must be a string`);
  if (value.length > max) throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", `${label} exceeds ${max} characters`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", `${label} must be finite`);
  return value;
}

function safeRelativePath(value: string, workspaceId: string, scope: string, kind: string): boolean {
  if (!value || isAbsolute(value) || value.includes("\0")) return false;
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;

  if (scope === "operator") {
    if (kind === "profile") return normalized.startsWith("operator/profile/");
    if (kind === "context") return normalized.startsWith("operator/context/");
    if (kind === "decision") return normalized.startsWith("operator/decisions/");
    if (kind === "memory" || kind === "memory_summary") return normalized.startsWith("operator/memory/");
    return false;
  }

  if (scope !== `workspace:${workspaceId}`) return false;
  const prefix = `workspaces/${workspaceId}/`;
  if (!normalized.startsWith(prefix)) return false;
  const rest = normalized.slice(prefix.length);
  if (kind === "workspace_manifest") return rest === "WORKSPACE.yaml";
  if (kind === "context") return rest.startsWith("context/");
  if (kind === "decision") return rest.startsWith("decisions/");
  if (kind === "memory" || kind === "memory_summary") return rest.startsWith("memory/");
  return false;
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function commandErrorCode(error: unknown): string | number | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: string | number }).code
    : undefined;
}

function execFileText(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf8",
      maxBuffer: PROCESS_MAX_BUFFER,
      timeout: timeoutMs,
      windowsHide: true,
      signal
    }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = error as Error & { stderr?: string };
        wrapped.stderr = String(stderr ?? "");
        rejectPromise(wrapped);
        return;
      }
      resolvePromise(String(stdout));
    });
  });
}

export class AiVerseMemoryRecallProvider implements MemoryRecallProvider {
  readonly root: string;
  private readonly env: Record<string, string | undefined>;
  private readonly pythonCommands: string[];
  private readonly timeoutMs: number;

  constructor(rootInput: string, options: AiVerseMemoryRecallProviderOptions = {}) {
    this.root = resolve(rootInput);
    this.env = { ...(process.env as Record<string, string | undefined>), ...(options.env ?? {}) };
    this.timeoutMs = Math.max(1000, Math.floor(options.timeoutMs ?? PROCESS_TIMEOUT_MS));
    this.pythonCommands = [...new Set([
      options.pythonCommand,
      this.env.AI_VERSE_MEMORY_PYTHON,
      process.platform === "win32" ? "python" : "python3",
      "python"
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
  }

  async recall(input: MemoryRecallProviderInput): Promise<MemoryRecallProjection> {
    if (input.signal.aborted) throw input.signal.reason ?? new AiVerseMemoryRecallError("MEMORY_RECALL_CANCELED", "Memory recall canceled");
    const entrypoint = this.assertInstallation();
    const scope = input.request.scope;
    const args = [
      "-c",
      PYTHON_RECALL_SCRIPT,
      entrypoint,
      this.root,
      input.request.query,
      scope,
      scope === "workspace" ? input.workspaceId : "",
      String(input.request.limit),
      input.request.include_history ? "1" : "0",
      String(MAX_RESULT_TEXT),
      String(MAX_RESULT_WHY),
      String(MAX_METADATA_TEXT)
    ];

    let stdout: string | null = null;
    let lastMissing: unknown = null;
    for (const command of this.pythonCommands) {
      try {
        stdout = await execFileText(command, args, this.root, this.env, input.signal, this.timeoutMs);
        break;
      } catch (error) {
        if (commandErrorCode(error) === "ENOENT") {
          lastMissing = error;
          continue;
        }
        if (input.signal.aborted) throw input.signal.reason ?? error;
        const stderr = typeof error === "object" && error !== null && "stderr" in error
          ? String((error as { stderr?: string }).stderr ?? "")
          : "";
        const safe = stderr.replace(/\s+/g, " ").trim().slice(0, 500);
        throw new AiVerseMemoryRecallError(
          "MEMORY_ENGINE_FAILED",
          safe ? `AI-Verse Memory recall failed: ${safe}` : `AI-Verse Memory recall failed using ${command}`
        );
      }
    }
    if (stdout === null) {
      throw new AiVerseMemoryRecallError(
        "MEMORY_PYTHON_UNAVAILABLE",
        `AI-Verse Memory requires Python; none of ${this.pythonCommands.join(", ")} could be executed${lastMissing ? "" : ""}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", "AI-Verse Memory returned invalid structured recall output");
    }
    const payload = asObject(parsed);
    if (!payload || payload.mode !== "ai-verse-os-v2" || !Array.isArray(payload.items)) {
      throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", "AI-Verse Memory returned an unsupported recall payload");
    }
    if (payload.items.length > input.request.limit) {
      throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", "AI-Verse Memory returned more items than the requested recall limit");
    }

    const items: JsonObject[] = [];
    const sources: MemoryRecallSource[] = [];
    for (let index = 0; index < payload.items.length; index += 1) {
      const raw = asObject(payload.items[index]);
      if (!raw) throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", `Memory result ${index} is not an object`);
      const id = requiredBoundedString(raw.id, `memory result ${index}.id`, 256);
      const kind = requiredBoundedString(raw.kind, `memory result ${index}.kind`, 64);
      const type = requiredBoundedString(raw.type, `memory result ${index}.type`, 128);
      const resultScope = requiredBoundedString(raw.scope, `memory result ${index}.scope`, 256);
      const path = requiredBoundedString(raw.path, `memory result ${index}.path`);
      const sourceVersion = requiredBoundedString(raw.source_version, `memory result ${index}.source_version`, 80);
      if (!/^sha256:[a-f0-9]{64}$/.test(sourceVersion)) {
        throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", `Memory result ${index} lacks a canonical SHA-256 source version`);
      }
      if (scope === "operator" && resultScope !== "operator") {
        throw new AiVerseMemoryRecallError("MEMORY_SCOPE_VIOLATION", `Operator-only recall returned ${resultScope}`);
      }
      if (scope === "workspace" && resultScope !== "operator" && resultScope !== `workspace:${input.workspaceId}`) {
        throw new AiVerseMemoryRecallError("MEMORY_SCOPE_VIOLATION", `Workspace recall returned unrelated scope ${resultScope}`);
      }
      if (!safeRelativePath(path, input.workspaceId, resultScope, kind)) {
        throw new AiVerseMemoryRecallError("MEMORY_SOURCE_PATH_INVALID", `Memory result ${index} returned unauthorized source path ${path}`);
      }
      if (raw.path_truncated === true) {
        throw new AiVerseMemoryRecallError("MEMORY_SOURCE_PATH_INVALID", `Memory result ${index} source path exceeded the adapter bound`);
      }

      const text = optionalBoundedString(raw.text, `memory result ${index}.text`, MAX_RESULT_TEXT);
      const why = optionalBoundedString(raw.why, `memory result ${index}.why`, MAX_RESULT_WHY);
      const source = optionalBoundedString(raw.source, `memory result ${index}.source`, MAX_METADATA_TEXT);
      const sourceIdentity = optionalBoundedString(raw.source_identity, `memory result ${index}.source_identity`, 80);
      if (sourceIdentity && !/^sha256:[a-f0-9]{64}$/.test(sourceIdentity)) {
        throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", `Memory result ${index} has invalid source identity`);
      }
      const freshness = optionalBoundedString(raw.freshness, `memory result ${index}.freshness`, 32);
      const updatedAt = optionalBoundedString(raw.updated_at, `memory result ${index}.updated_at`, 128);
      const indexedAt = optionalBoundedString(raw.indexed_at, `memory result ${index}.indexed_at`, 128);
      const status = requiredBoundedString(raw.status, `memory result ${index}.status`, 64);
      if (!input.request.include_history && status !== "active") {
        throw new AiVerseMemoryRecallError("MEMORY_RESULT_INVALID", `Normal recall returned non-active result ${id}`);
      }

      const ref = `ai-verse-memory:${encodeURIComponent(resultScope)}:${encodeURIComponent(kind)}:${encodeURIComponent(id)}`;
      sources.push({
        ref,
        digest: sourceVersion,
        item_id: id,
        kind,
        type,
        scope: resultScope,
        path
      });
      items.push({
        id,
        kind,
        type,
        scope: resultScope,
        status,
        importance: finiteNumber(raw.importance, `memory result ${index}.importance`),
        confidence: finiteNumber(raw.confidence, `memory result ${index}.confidence`),
        updated_at: updatedAt,
        source,
        source_ref: ref,
        source_digest: sourceVersion,
        source_identity: sourceIdentity,
        freshness,
        indexed_at: indexedAt,
        text,
        why,
        text_truncated: raw.text_truncated === true,
        why_truncated: raw.why_truncated === true,
        source_truncated: raw.source_truncated === true
      });
    }

    const requestDigest = digestValue(input.request);
    const projectionDigest = digestValue({
      provider: AI_VERSE_MEMORY_RECALL_PROVIDER,
      workspace_id: input.workspaceId,
      request: input.request,
      ranked_sources: sources.map((source) => ({
        ref: source.ref,
        digest: source.digest,
        scope: source.scope,
        kind: source.kind,
        type: source.type
      }))
    });
    return {
      schema_version: AI_VERSE_MEMORY_RECALL_SCHEMA,
      provider: AI_VERSE_MEMORY_RECALL_PROVIDER,
      workspace_id: input.workspaceId,
      query_digest: requestDigest,
      projection_digest: projectionDigest,
      recalled_at: new Date().toISOString(),
      request: input.request,
      sources,
      data: {
        precedence: "current_canonical_context_over_historical_memory",
        engine_version: typeof payload.version === "string" ? payload.version : null,
        items
      }
    };
  }

  private assertInstallation(): string {
    const compatibility = detectAiVerseOsCompatibility(this.root);
    if (compatibility.status !== "compatible") {
      throw new AiVerseMemoryRecallError("INCOMPATIBLE_AI_VERSE_OS", `Memory recall requires compatible AI-Verse OS v2: ${compatibility.reason}`);
    }
    if (!existsSync(this.root)) throw new AiVerseMemoryRecallError("MEMORY_ROOT_MISSING", `AI-Verse OS root ${this.root} is missing`);
    const realRoot = realpathSync(this.root);
    const engineDirectory = resolve(this.root, ...MEMORY_ENGINE_DIRECTORY.split("/"));
    if (!existsSync(engineDirectory)) {
      throw new AiVerseMemoryRecallError("MEMORY_NOT_INSTALLED", `AI-Verse Memory is not installed at ${MEMORY_ENGINE_DIRECTORY}`);
    }
    const directoryStat = lstatSync(engineDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      throw new AiVerseMemoryRecallError("MEMORY_INSTALLATION_UNSAFE", `${MEMORY_ENGINE_DIRECTORY} must be a real directory`);
    }
    const realDirectory = realpathSync(engineDirectory);
    if (!isInside(realDirectory, realRoot)) {
      throw new AiVerseMemoryRecallError("MEMORY_INSTALLATION_UNSAFE", `${MEMORY_ENGINE_DIRECTORY} resolves outside the AI-Verse OS root`);
    }

    for (const file of MEMORY_ENGINE_FILES) {
      const path = resolve(engineDirectory, file);
      if (!existsSync(path)) throw new AiVerseMemoryRecallError("MEMORY_NOT_INSTALLED", `AI-Verse Memory installation is missing ${file}`);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new AiVerseMemoryRecallError("MEMORY_INSTALLATION_UNSAFE", `${MEMORY_ENGINE_DIRECTORY}/${file} must be a regular non-symlink file`);
      const realPath = realpathSync(path);
      if (!isInside(realPath, realRoot)) throw new AiVerseMemoryRecallError("MEMORY_INSTALLATION_UNSAFE", `${MEMORY_ENGINE_DIRECTORY}/${file} resolves outside the AI-Verse OS root`);
    }
    return resolve(this.root, ...MEMORY_ENGINE_ENTRYPOINT.split("/"));
  }
}
