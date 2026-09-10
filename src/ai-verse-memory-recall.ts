import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
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
export const AI_VERSE_MEMORY_MAX_QUERY_CHARS = 2_000;
export const AI_VERSE_MEMORY_MAX_RESULTS = 12;
export const AI_VERSE_MEMORY_MAX_ITEM_CHARS = 8_000;
export const AI_VERSE_MEMORY_MAX_TOTAL_CHARS = 24_000;
export const AI_VERSE_MEMORY_DEFAULT_TIMEOUT_MS = 10_000;
export const AI_VERSE_MEMORY_MAX_BUFFER_BYTES = 512 * 1024;

export interface AiVerseMemoryRecallOptions {
  pythonExecutable?: string;
  timeoutMs?: number;
  maxResults?: number;
  maxItemChars?: number;
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function regularNonSymlink(path: string, label: string): void {
  if (!existsSync(path)) throw new AiVerseMemoryRecallError("MEMORY_UNAVAILABLE", `${label} is missing: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new AiVerseMemoryRecallError("MEMORY_UNSAFE_INSTALL", `${label} must not be a symlink: ${path}`);
  if (!stat.isFile()) throw new AiVerseMemoryRecallError("MEMORY_UNSAFE_INSTALL", `${label} must be a regular file: ${path}`);
}

function safeRelativeSourcePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", "Memory recall returned an empty or unsafe source path");
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", `Memory recall returned an absolute source path: ${value}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", `Memory recall returned an unsafe source path: ${value}`);
  }
  return normalized;
}

function boundedString(value: string, maxChars: number, label: string): string {
  const text = value.trim();
  if (text.length > maxChars) {
    throw new AiVerseMemoryRecallError("MEMORY_OUTPUT_TOO_LARGE", `${label} exceeds ${maxChars} characters`);
  }
  return text;
}

function parseMetadata(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of line.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

interface ParsedItem {
  id: string;
  kind: string;
  type: string;
  scope: string;
  content: string;
  path: string;
  source: string | null;
  updated_at: string | null;
  source_version: string | null;
  freshness: string | null;
  indexed_at: string | null;
}

function parseRecallOutput(stdout: string, workspaceId: string, maxItemChars: number, maxTotalChars: number): ParsedItem[] {
  const text = stdout.replace(/\r\n/g, "\n").trim();
  if (!text.startsWith("# Memory recall")) {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", "Memory engine returned an unexpected recall response");
  }
  if (/\nNo relevant memory found\.\s*$/.test(text)) return [];

  const lines = text.split("\n");
  const items: ParsedItem[] = [];
  let index = 0;
  let totalChars = 0;
  while (index < lines.length) {
    const heading = /^##\s+(.+?)\s+\[([^/\]]+)\/([^\]]+)\]\s+\(([^)]+)\)\s*$/.exec(lines[index] ?? "");
    if (!heading) {
      index += 1;
      continue;
    }

    const id = boundedString(String(heading[1] ?? ""), 256, "Memory result id");
    const kind = boundedString(String(heading[2] ?? ""), 64, "Memory result kind");
    const type = boundedString(String(heading[3] ?? ""), 64, "Memory result type");
    const scope = boundedString(String(heading[4] ?? ""), 256, "Memory result scope");
    const allowedWorkspaceScope = `workspace:${workspaceId}`;
    if (scope !== allowedWorkspaceScope && scope !== "operator") {
      throw new AiVerseMemoryRecallError(
        "MEMORY_SCOPE_VIOLATION",
        `Memory recall for workspace ${workspaceId} returned out-of-scope item ${id} from ${scope}`
      );
    }

    index += 1;
    const bodyLines: string[] = [];
    while (index < lines.length && !/^##\s+/.test(lines[index] ?? "")) {
      bodyLines.push(lines[index] ?? "");
      index += 1;
    }
    while (bodyLines.length > 0 && bodyLines[0]?.trim() === "") bodyLines.shift();
    while (bodyLines.length > 0 && bodyLines.at(-1)?.trim() === "") bodyLines.pop();
    if (bodyLines.length === 0) {
      throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", `Memory result ${id} has no content or provenance`);
    }

    const metadataLine = bodyLines.pop() ?? "";
    const metadata = parseMetadata(metadataLine);
    if (!metadata.path) {
      throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", `Memory result ${id} is missing source path provenance`);
    }
    while (bodyLines.length > 0 && bodyLines.at(-1)?.trim() === "") bodyLines.pop();
    const content = boundedString(bodyLines.join("\n"), maxItemChars, `Memory result ${id}`);
    if (!content) throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", `Memory result ${id} has empty content`);
    totalChars += content.length;
    if (totalChars > maxTotalChars) {
      throw new AiVerseMemoryRecallError("MEMORY_OUTPUT_TOO_LARGE", `Memory recall exceeds ${maxTotalChars} total characters`);
    }

    items.push({
      id,
      kind,
      type,
      scope,
      content,
      path: safeRelativeSourcePath(metadata.path),
      source: metadata.source || null,
      updated_at: metadata.updated || null,
      source_version: metadata.version || null,
      freshness: metadata.freshness || null,
      indexed_at: metadata.indexed || null
    });
  }

  if (items.length === 0) {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", "Memory engine returned no parseable recall items");
  }
  return items;
}

function runExecFile(
  execFileImpl: typeof execFile,
  executable: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFileImpl(
      executable,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: AI_VERSE_MEMORY_MAX_BUFFER_BYTES,
        windowsHide: true
      },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          rejectPromise(new AiVerseMemoryRecallError(
            "MEMORY_ENGINE_FAILED",
            `AI-Verse Memory recall failed: ${error.message}${stderr.trim() ? ` (${stderr.trim().slice(0, 500)})` : ""}`
          ));
          return;
        }
        resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

function normalizeRequest(request: HistoricalRecallRequest, maxResults: number): Required<HistoricalRecallRequest> {
  if (!request || typeof request !== "object") {
    throw new AiVerseMemoryRecallError("MEMORY_INVALID_REQUEST", "Memory recall request must be an object");
  }
  const query = typeof request.query === "string" ? request.query.trim() : "";
  if (!query) throw new AiVerseMemoryRecallError("MEMORY_INVALID_REQUEST", "Memory recall query is required");
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

export class AiVerseMemoryRecallSource implements HistoricalRecallSource {
  readonly provider = AI_VERSE_MEMORY_PROVIDER_ID;
  readonly root: string;
  readonly enginePath: string;
  private readonly pythonExecutable: string;
  private readonly timeoutMs: number;
  private readonly maxResults: number;
  private readonly maxItemChars: number;
  private readonly maxTotalChars: number;
  private readonly execFileImpl: typeof execFile;
  private readonly now: () => Date;

  constructor(rootInput: string, options: AiVerseMemoryRecallOptions = {}) {
    this.root = resolve(rootInput);
    this.enginePath = resolve(this.root, ...AI_VERSE_MEMORY_ENGINE_PATH.split("/"));
    this.pythonExecutable = options.pythonExecutable?.trim() || (process.platform === "win32" ? "python" : "python3");
    this.timeoutMs = options.timeoutMs ?? AI_VERSE_MEMORY_DEFAULT_TIMEOUT_MS;
    this.maxResults = Math.min(AI_VERSE_MEMORY_MAX_RESULTS, Math.max(1, options.maxResults ?? AI_VERSE_MEMORY_MAX_RESULTS));
    this.maxItemChars = Math.min(AI_VERSE_MEMORY_MAX_ITEM_CHARS, Math.max(256, options.maxItemChars ?? AI_VERSE_MEMORY_MAX_ITEM_CHARS));
    this.maxTotalChars = Math.min(AI_VERSE_MEMORY_MAX_TOTAL_CHARS, Math.max(this.maxItemChars, options.maxTotalChars ?? AI_VERSE_MEMORY_MAX_TOTAL_CHARS));
    this.execFileImpl = options.execFileImpl ?? execFile;
    this.now = options.now ?? (() => new Date());
  }

  async recall(workspaceId: string, requestInput: HistoricalRecallRequest): Promise<HistoricalRecallProjection> {
    const workspace = workspaceId.trim();
    if (!workspace || workspace.includes("\0") || workspace.includes("/") || workspace.includes("\\") || workspace === "." || workspace === "..") {
      throw new AiVerseMemoryRecallError("MEMORY_INVALID_REQUEST", `Unsafe workspace id for Memory recall: ${workspaceId}`);
    }

    const compatibility = detectAiVerseOsCompatibility(this.root);
    if (compatibility.status !== "compatible") {
      throw new AiVerseMemoryRecallError(
        "MEMORY_HOST_INCOMPATIBLE",
        `AI-Verse Memory recall requires a compatible AI-Verse OS v2 host: ${compatibility.reason}`
      );
    }

    regularNonSymlink(this.enginePath, "AI-Verse Memory engine");
    regularNonSymlink(resolve(this.root, "scripts/ai-verse-memory/memory_engine.py"), "AI-Verse Memory implementation");
    regularNonSymlink(resolve(this.root, "scripts/ai-verse-memory/os_compat.py"), "AI-Verse Memory compatibility gate");

    const request = normalizeRequest(requestInput, this.maxResults);
    const args = [
      this.enginePath,
      "--root",
      this.root,
      "recall",
      request.query,
      "--workspace",
      workspace,
      "--limit",
      String(request.limit)
    ];
    if (request.include_history) args.push("--include-history");

    const { stdout } = await runExecFile(this.execFileImpl, this.pythonExecutable, args, this.timeoutMs);
    const parsed = parseRecallOutput(stdout, workspace, this.maxItemChars, this.maxTotalChars);
    if (parsed.length > request.limit || parsed.length > this.maxResults) {
      throw new AiVerseMemoryRecallError("MEMORY_INVALID_OUTPUT", "Memory engine returned more items than the requested recall limit");
    }

    const items: HistoricalRecallItem[] = parsed.map((item) => {
      const digest = sha256(canonicalJson({
        id: item.id,
        kind: item.kind,
        type: item.type,
        scope: item.scope,
        content: item.content,
        path: item.path,
        source: item.source,
        updated_at: item.updated_at,
        source_version: item.source_version,
        freshness: item.freshness
      }));
      return { ...item, digest };
    });
    const queryDigest = sha256(request.query);
    const recallDigest = sha256(canonicalJson({
      provider: this.provider,
      workspace_id: workspace,
      query_digest: queryDigest,
      include_history: request.include_history,
      items: items.map((item) => ({ id: item.id, digest: item.digest, scope: item.scope, path: item.path }))
    }));

    return {
      schema_version: AI_VERSE_MEMORY_RECALL_SCHEMA_VERSION,
      provider: this.provider,
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
