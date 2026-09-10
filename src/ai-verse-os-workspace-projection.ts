import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { detectAiVerseOsCompatibility } from "./ai-verse-os-registration.js";
import type { WorkspaceStateProjection, WorkspaceStateProjector } from "./runtime.js";
import type { JsonObject } from "./types.js";

export const AI_VERSE_OS_WORKSPACE_PROJECTION_PROVIDER = "ai-verse-os-workspace-v1";
export const AI_VERSE_OS_WORKSPACE_PROJECTION_SCHEMA = "1.0";

const DEFAULT_MAX_MANIFEST_BYTES = 64 * 1024;
const DEFAULT_MAX_CONTEXT_BYTES = 32 * 1024;
const MAX_LIST_ITEMS = 128;
const MAX_LIST_ITEM_LENGTH = 2048;
const MAX_SECTION_LENGTH = 8192;
const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]*$/;

export interface AiVerseOsWorkspaceProjectorOptions {
  maxManifestBytes?: number;
  maxCurrentContextBytes?: number;
  requireActiveWorkspace?: boolean;
}

export class AiVerseOsWorkspaceProjectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AiVerseOsWorkspaceProjectionError";
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalString(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function unquoteScalar(input: string, label: string): string | null {
  let value = input.trim();
  if (!value) return null;
  if (value === "null" || value === "~") return null;
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error("not a string");
      return parsed;
    } catch {
      throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_MANIFEST", `${label} must be a valid YAML string scalar`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_MANIFEST", `${label} has an unterminated quoted scalar`);
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  const commentIndex = value.indexOf(" #");
  if (commentIndex >= 0) value = value.slice(0, commentIndex).trimEnd();
  if (["|", ">", "|-", ">-", "|+", ">+"].includes(value)) {
    throw new AiVerseOsWorkspaceProjectionError("UNSUPPORTED_WORKSPACE_MANIFEST_SCALAR", `${label} must use a single-line scalar in AI-Verse OS v2`);
  }
  return value || null;
}

interface YamlEntry {
  indent: number;
  key: string;
  raw: string;
  line: number;
}

function yamlEntries(text: string): YamlEntry[] {
  const entries: YamlEntry[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (line.slice(0, indent).includes("\t")) {
      throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_MANIFEST", `Tabs are not supported in WORKSPACE.yaml indentation (line ${index + 1})`);
    }
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line.trimStart());
    if (!match) continue;
    entries.push({ indent, key: match[1]!, raw: match[2] ?? "", line: index + 1 });
  }
  return entries;
}

function topLevelScalar(text: string, key: string, required = false): string | null {
  const matches = yamlEntries(text).filter((entry) => entry.indent === 0 && entry.key === key);
  if (matches.length > 1) {
    throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_MANIFEST", `WORKSPACE.yaml contains duplicate top-level key '${key}'`);
  }
  if (matches.length === 0) {
    if (required) throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_MANIFEST", `WORKSPACE.yaml is missing required key '${key}'`);
    return null;
  }
  const value = unquoteScalar(matches[0]!.raw, `WORKSPACE.yaml ${key}`);
  if (required && !value) {
    throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_MANIFEST", `WORKSPACE.yaml '${key}' must be a non-empty scalar`);
  }
  return value;
}

function nestedScalar(text: string, parent: string, key: string): string | null {
  const lines = text.split(/\r?\n/);
  let parentLine = -1;
  let parentIndent = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line.trimStart());
    const indent = line.length - line.trimStart().length;
    if (match && indent === 0 && match[1] === parent) {
      if (parentLine >= 0) throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_MANIFEST", `WORKSPACE.yaml contains duplicate top-level key '${parent}'`);
      parentLine = i;
      parentIndent = indent;
    }
  }
  if (parentLine < 0) return null;
  const matches: Array<{ raw: string; line: number }> = [];
  for (let i = parentLine + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= parentIndent) break;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line.trimStart());
    if (match && match[1] === key) matches.push({ raw: match[2] ?? "", line: i + 1 });
  }
  if (matches.length > 1) {
    throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_MANIFEST", `WORKSPACE.yaml contains duplicate '${parent}.${key}'`);
  }
  return matches.length === 0 ? null : unquoteScalar(matches[0]!.raw, `WORKSPACE.yaml ${parent}.${key}`);
}

function topLevelStringList(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/);
  const headers: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if ((line.length - line.trimStart().length) !== 0) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (match?.[1] === key) headers.push(i);
  }
  if (headers.length > 1) throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_MANIFEST", `WORKSPACE.yaml contains duplicate top-level key '${key}'`);
  if (headers.length === 0) return [];
  const header = lines[headers[0]!]!;
  const raw = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(header)?.[2]?.trim() ?? "";
  if (raw === "[]" || raw === "") {
    if (raw === "[]") return [];
  } else {
    throw new AiVerseOsWorkspaceProjectionError("UNSUPPORTED_WORKSPACE_MANIFEST_LIST", `WORKSPACE.yaml '${key}' must use [] or a block sequence of scalar values`);
  }

  const values: string[] = [];
  for (let i = headers[0]! + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    const item = /^-\s+(.+)$/.exec(line.trimStart());
    if (!item) continue;
    const value = unquoteScalar(item[1]!, `WORKSPACE.yaml ${key} item`);
    if (value === null) throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_MANIFEST", `WORKSPACE.yaml '${key}' contains an empty list item`);
    if (value.length > MAX_LIST_ITEM_LENGTH) throw new AiVerseOsWorkspaceProjectionError("WORKSPACE_PROJECTION_TOO_LARGE", `WORKSPACE.yaml '${key}' item exceeds ${MAX_LIST_ITEM_LENGTH} characters`);
    values.push(value);
    if (values.length > MAX_LIST_ITEMS) throw new AiVerseOsWorkspaceProjectionError("WORKSPACE_PROJECTION_TOO_LARGE", `WORKSPACE.yaml '${key}' exceeds ${MAX_LIST_ITEMS} items`);
  }
  return values;
}

function normalizeRelativePath(input: string, label: string): string {
  if (typeof input !== "string" || !input.trim()) throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_PATH", `${label} must be a non-empty relative path`);
  if (input.includes("\0")) throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_PATH", `${label} contains a NUL character`);
  if (/^[A-Za-z]:[\\/]/.test(input) || input.startsWith("\\\\") || input.startsWith("/") || input.startsWith("\\")) {
    throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_PATH", `${label} must be relative to the AI-Verse OS root`);
  }
  const normalized = input.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_PATH", `${label} contains unsafe traversal or empty segments`);
  }
  return segments.join("/");
}

function resolveInside(root: string, relativePath: string, label: string): string {
  const safe = normalizeRelativePath(relativePath, label);
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, ...safe.split("/"));
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
    throw new AiVerseOsWorkspaceProjectionError("WORKSPACE_PATH_ESCAPE", `${label} resolves outside its allowed root`);
  }
  return target;
}

function assertNoSymlinkPath(root: string, relativePath: string, label: string): void {
  const safe = normalizeRelativePath(relativePath, label);
  let current = resolve(root);
  for (const segment of safe.split("/")) {
    current = resolve(current, segment);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new AiVerseOsWorkspaceProjectionError("WORKSPACE_SYMLINK_REJECTED", `${label} traverses a symlink: ${safe}`);
    }
  }
}

function readBoundedFile(root: string, relativePath: string, label: string, maxBytes: number): string {
  const path = resolveInside(root, relativePath, label);
  assertNoSymlinkPath(root, relativePath, label);
  if (!existsSync(path)) throw new AiVerseOsWorkspaceProjectionError("WORKSPACE_SOURCE_MISSING", `${label} is missing: ${relativePath}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_SOURCE", `${label} must be a regular file: ${relativePath}`);
  if (typeof stat.size === "number" && stat.size > maxBytes) {
    throw new AiVerseOsWorkspaceProjectionError("WORKSPACE_PROJECTION_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
  }
  const text = readFileSync(path, "utf8");
  if (byteLength(text) > maxBytes) throw new AiVerseOsWorkspaceProjectionError("WORKSPACE_PROJECTION_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
  return text;
}

function workspacePathFromArchitecture(root: string): string {
  const architecture = readBoundedFile(root, "AI-VERSE.yaml", "AI-VERSE.yaml", DEFAULT_MAX_MANIFEST_BYTES);
  const lines = architecture.split(/\r?\n/);
  let inPaths = false;
  let value: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inPaths = /^paths:\s*(?:#.*)?$/.test(line);
      continue;
    }
    if (!inPaths) continue;
    const match = /^workspaces:\s*(.+)$/.exec(line.trimStart());
    if (!match) continue;
    if (value !== null) throw new AiVerseOsWorkspaceProjectionError("INVALID_AI_VERSE_OS_PATHS", "AI-VERSE.yaml contains duplicate paths.workspaces");
    value = unquoteScalar(match[1]!, `AI-VERSE.yaml paths.workspaces`);
    if (!value) throw new AiVerseOsWorkspaceProjectionError("INVALID_AI_VERSE_OS_PATHS", "AI-VERSE.yaml paths.workspaces is empty");
    if (index < 0) break;
  }
  if (!value) throw new AiVerseOsWorkspaceProjectionError("INVALID_AI_VERSE_OS_PATHS", "AI-VERSE.yaml is missing paths.workspaces");
  return normalizeRelativePath(value, "AI-VERSE.yaml paths.workspaces");
}

function currentContextProjection(text: string): JsonObject {
  const fieldByHeading: Record<string, string> = {
    "objective": "objective",
    "current state": "current_state",
    "next useful actions": "next_useful_actions",
    "pending decisions": "pending_decisions",
    "constraints / approvals": "constraints_approvals",
    "source pointers": "source_pointers"
  };
  const sections: Record<string, string> = {};
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (!current) return;
    const value = buffer.join("\n").trim();
    if (value.length > MAX_SECTION_LENGTH) throw new AiVerseOsWorkspaceProjectionError("WORKSPACE_PROJECTION_TOO_LARGE", `Current context section '${current}' exceeds ${MAX_SECTION_LENGTH} characters`);
    sections[current] = value;
  };

  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      buffer = [];
      const normalized = heading[1]!.trim().toLowerCase();
      const field = fieldByHeading[normalized] ?? null;
      if (field && Object.prototype.hasOwnProperty.call(sections, field)) {
        throw new AiVerseOsWorkspaceProjectionError("INVALID_CURRENT_CONTEXT", `Current workspace context contains duplicate section '${heading[1]!.trim()}'`);
      }
      current = field;
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();

  const reviewedMatch = /^Last reviewed:\s*(.+?)\s*$/im.exec(text);
  const lastReviewed = reviewedMatch ? reviewedMatch[1]!.trim() : null;
  if (lastReviewed && lastReviewed.length > 512) throw new AiVerseOsWorkspaceProjectionError("WORKSPACE_PROJECTION_TOO_LARGE", "Current context Last reviewed value is too large");

  if (Object.keys(sections).length === 0) {
    throw new AiVerseOsWorkspaceProjectionError("INVALID_CURRENT_CONTEXT", "Current workspace context contains none of the canonical AI-Verse OS v2 sections");
  }
  return {
    last_reviewed: lastReviewed,
    ...sections
  };
}

function optionalNestedObject(text: string, parent: string, keys: string[]): JsonObject {
  const result: JsonObject = {};
  for (const key of keys) {
    const value = nestedScalar(text, parent, key);
    if (value !== null) result[key] = value;
  }
  return result;
}

export class AiVerseOsWorkspaceProjector implements WorkspaceStateProjector {
  readonly root: string;
  readonly maxManifestBytes: number;
  readonly maxCurrentContextBytes: number;
  readonly requireActiveWorkspace: boolean;

  constructor(root: string, options: AiVerseOsWorkspaceProjectorOptions = {}) {
    this.root = resolve(root);
    this.maxManifestBytes = options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES;
    this.maxCurrentContextBytes = options.maxCurrentContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
    this.requireActiveWorkspace = options.requireActiveWorkspace ?? true;
    if (!Number.isInteger(this.maxManifestBytes) || this.maxManifestBytes < 1024) throw new Error("maxManifestBytes must be an integer >= 1024");
    if (!Number.isInteger(this.maxCurrentContextBytes) || this.maxCurrentContextBytes < 1024) throw new Error("maxCurrentContextBytes must be an integer >= 1024");
  }

  project(workspaceId: string): WorkspaceStateProjection {
    if (!WORKSPACE_ID.test(workspaceId)) {
      throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_ID", `Workspace ID '${workspaceId}' is not a canonical AI-Verse workspace slug`);
    }
    const compatibility = detectAiVerseOsCompatibility(this.root);
    if (compatibility.status !== "compatible") {
      throw new AiVerseOsWorkspaceProjectionError("INCOMPATIBLE_AI_VERSE_OS", `Workspace projection blocked: ${compatibility.reason}`);
    }

    const workspacesPath = workspacePathFromArchitecture(this.root);
    const workspaceRelative = `${workspacesPath}/${workspaceId}`;
    const workspacePath = resolveInside(this.root, workspaceRelative, "workspace path");
    assertNoSymlinkPath(this.root, workspaceRelative, "workspace path");
    if (!existsSync(workspacePath)) throw new AiVerseOsWorkspaceProjectionError("WORKSPACE_NOT_FOUND", `AI-Verse OS workspace '${workspaceId}' does not exist`);
    const workspaceStat = lstatSync(workspacePath);
    if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
      throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_DIRECTORY", `AI-Verse OS workspace '${workspaceId}' must be a real directory`);
    }

    const manifestRelative = `${workspaceRelative}/WORKSPACE.yaml`;
    const manifestText = readBoundedFile(this.root, manifestRelative, "WORKSPACE.yaml", this.maxManifestBytes);
    const schemaVersion = topLevelScalar(manifestText, "schema_version", true)!;
    const schemaMajor = /^(\d+)(?:\.\d+){0,2}$/.exec(schemaVersion);
    if (!schemaMajor || Number(schemaMajor[1]) !== 2) {
      throw new AiVerseOsWorkspaceProjectionError("UNSUPPORTED_WORKSPACE_SCHEMA", `Workspace ${workspaceId} schema_version '${schemaVersion}' is not AI-Verse OS v2`);
    }
    const manifestId = topLevelScalar(manifestText, "id", true)!;
    if (manifestId !== workspaceId) {
      throw new AiVerseOsWorkspaceProjectionError("WORKSPACE_ID_MISMATCH", `Workspace directory '${workspaceId}' contains manifest id '${manifestId}'`);
    }
    const status = topLevelScalar(manifestText, "status", true)!;
    if (!["active", "paused", "archived"].includes(status)) {
      throw new AiVerseOsWorkspaceProjectionError("INVALID_WORKSPACE_STATUS", `Workspace ${workspaceId} has unsupported status '${status}'`);
    }
    if (this.requireActiveWorkspace && status !== "active") {
      throw new AiVerseOsWorkspaceProjectionError("WORKSPACE_NOT_ACTIVE", `Workspace ${workspaceId} is ${status}; execution requires an active workspace`);
    }

    const currentContextRelative = topLevelScalar(manifestText, "current_context", false);
    let currentContext: JsonObject | null = null;
    let currentContextSource: { ref: string; digest: string } | null = null;
    if (currentContextRelative) {
      const safeCurrentContext = normalizeRelativePath(currentContextRelative, "WORKSPACE.yaml current_context");
      const fullCurrentContextRelative = `${workspaceRelative}/${safeCurrentContext}`;
      const contextText = readBoundedFile(this.root, fullCurrentContextRelative, "workspace current context", this.maxCurrentContextBytes);
      currentContext = currentContextProjection(contextText);
      currentContextSource = { ref: fullCurrentContextRelative, digest: sha256(contextText) };
    }

    const privacy = optionalNestedObject(manifestText, "privacy", ["classification", "notes"]);
    const approval = optionalNestedObject(manifestText, "approval", ["external_actions", "destructive_actions", "high_stakes_decisions"]);
    const data: JsonObject = {
      identity: {
        id: manifestId,
        name: topLevelScalar(manifestText, "name", true)!,
        type: topLevelScalar(manifestText, "type", true)!,
        status,
        purpose: topLevelScalar(manifestText, "purpose", true)!,
        domains: topLevelStringList(manifestText, "domains"),
        owners: topLevelStringList(manifestText, "owners"),
        success_criteria: topLevelStringList(manifestText, "success_criteria")
      },
      boundaries: {
        canonical_sources: topLevelStringList(manifestText, "canonical_sources"),
        declared_connections: topLevelStringList(manifestText, "connections"),
        privacy,
        approval
      },
      current_context: currentContext
    };

    const sources = [
      { ref: manifestRelative, digest: sha256(manifestText) },
      ...(currentContextSource ? [currentContextSource] : [])
    ];
    const projectionDigest = sha256(canonicalString({
      schema_version: AI_VERSE_OS_WORKSPACE_PROJECTION_SCHEMA,
      provider: AI_VERSE_OS_WORKSPACE_PROJECTION_PROVIDER,
      workspace_id: workspaceId,
      sources,
      data
    }));

    return {
      schema_version: AI_VERSE_OS_WORKSPACE_PROJECTION_SCHEMA,
      provider: AI_VERSE_OS_WORKSPACE_PROJECTION_PROVIDER,
      workspace_id: workspaceId,
      projection_digest: projectionDigest,
      projected_at: new Date().toISOString(),
      sources,
      data
    };
  }
}
