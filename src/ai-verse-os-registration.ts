import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve, sep } from "node:path";

export const AI_VERSE_OS_HOST_ID = "ai-verse-os";
export const AI_VERSE_OS_SUPPORTED_SCHEMA_MAJOR = 2;
export const AI_VERSE_OS_SUPPORTED_ARCHITECTURE = "unified-workspace";
export const AI_VERSE_OS_EXTENSION_REGISTRY_SCHEMA = "1.0";
export const AI_VERSE_OS_EXTENSION_REGISTRY_PATH = ".aiverse/extensions/registry.json";
export const AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH = ".aiverse/extensions/registry.json.lock";
export const AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID = "ai-verse-multiple-bots";
export const AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION = "0.1.0-alpha.1";
export const AI_VERSE_MULTIPLE_BOTS_EXTENSION_SOURCE = "AI-Verse-Multiple-Bots";
export const AI_VERSE_MULTIPLE_BOTS_EXTENSION_ROOT = ".aiverse/extensions/ai-verse-multiple-bots";
export const AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH = `${AI_VERSE_MULTIPLE_BOTS_EXTENSION_ROOT}/INSTRUCTIONS.md`;
export const AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH = `${AI_VERSE_MULTIPLE_BOTS_EXTENSION_ROOT}/engine.mjs`;

export type AiVerseOsCompatibilityStatus = "no-os" | "compatible" | "incompatible";
export type JsonRecord = Record<string, unknown>;

export interface AiVerseOsCompatibility {
  host_id: typeof AI_VERSE_OS_HOST_ID;
  root: string;
  status: AiVerseOsCompatibilityStatus;
  reason: string;
  schema_version: string | null;
  architecture: string | null;
  registry_path: string;
}

export interface AiVerseOsRegistrationOptions {
  version?: string;
  source?: string;
  instructions?: string;
  engine?: string;
  adapters?: string[];
  enabled?: boolean;
  verify_installed_paths?: boolean;
}

export interface AiVerseOsRegistrationPlan {
  host_id: typeof AI_VERSE_OS_HOST_ID;
  root: string;
  extension_id: typeof AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID;
  registry_path: string;
  compatibility: AiVerseOsCompatibility;
  current_entry: JsonRecord | null;
  next_entry: JsonRecord;
  files_to_verify: string[];
  requires_write: boolean;
  tracked_os_files_mutated: string[];
  preserves_unknown_registry_fields: true;
}

export interface AiVerseOsRegistrationResult extends AiVerseOsRegistrationPlan {
  status: "registered" | "updated" | "unchanged";
}

export interface AiVerseOsRegistrationAdapter {
  readonly id: typeof AI_VERSE_OS_HOST_ID;
  detect(root: string): AiVerseOsCompatibility;
  plan(root: string, options?: AiVerseOsRegistrationOptions): AiVerseOsRegistrationPlan;
  register(root: string, options?: AiVerseOsRegistrationOptions): AiVerseOsRegistrationResult;
}

export class AiVerseOsRegistrationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AiVerseOsRegistrationError";
  }
}

interface RegistryDocument {
  document: JsonRecord;
  extensions: JsonRecord;
  exists: boolean;
  raw_text: string | null;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function topLevelScalar(text: string, key: string): { value: string | null; error: string | null } {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}:\\s*([^#\\r\\n]+?)\\s*$`, "gm");
  const matches = [...text.matchAll(pattern)].map((match) => String(match[1] ?? "").trim());
  if (matches.length === 0) return { value: null, error: `AI-VERSE.yaml is missing required top-level key '${key}'` };
  if (matches.length !== 1) return { value: null, error: `AI-VERSE.yaml contains duplicate top-level key '${key}'` };
  let value = matches[0] ?? "";
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1).trim();
  }
  if (!value) return { value: null, error: `AI-VERSE.yaml has an empty '${key}' value` };
  return { value, error: null };
}

function classifyRegularFile(path: string, label: string): string | null {
  if (!existsSync(path)) return `${label} is missing`;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return `${label} must not be a symlink`;
  if (!stat.isFile()) return `${label} is not a regular file`;
  return null;
}

function classifyDirectory(path: string, label: string): string | null {
  if (!existsSync(path)) return `${label} is missing`;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return `${label} must not be a symlink`;
  if (!stat.isDirectory()) return `${label} is not a directory`;
  return null;
}

function incompatible(root: string, reason: string, schemaVersion: string | null = null, architecture: string | null = null): AiVerseOsCompatibility {
  return {
    host_id: AI_VERSE_OS_HOST_ID,
    root,
    status: "incompatible",
    reason,
    schema_version: schemaVersion,
    architecture,
    registry_path: resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/"))
  };
}

export function detectAiVerseOsCompatibility(rootInput: string): AiVerseOsCompatibility {
  const root = resolve(rootInput);
  const manifestPath = resolve(root, "AI-VERSE.yaml");
  const registryPath = resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/"));
  if (!existsSync(manifestPath)) {
    return {
      host_id: AI_VERSE_OS_HOST_ID,
      root,
      status: "no-os",
      reason: "AI-VERSE.yaml is absent",
      schema_version: null,
      architecture: null,
      registry_path: registryPath
    };
  }

  const manifestError = classifyRegularFile(manifestPath, "AI-VERSE.yaml");
  if (manifestError) return incompatible(root, manifestError);

  let manifest: string;
  try {
    manifest = readFileSync(manifestPath, "utf8");
  } catch (error) {
    return incompatible(root, `AI-VERSE.yaml is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const schema = topLevelScalar(manifest, "schema_version");
  if (schema.error) return incompatible(root, schema.error);
  const architecture = topLevelScalar(manifest, "architecture");
  if (architecture.error) return incompatible(root, architecture.error, schema.value);

  const version = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(schema.value ?? "");
  if (!version) {
    return incompatible(root, `Unsupported or malformed AI-Verse OS schema_version '${schema.value ?? ""}'`, schema.value, architecture.value);
  }
  if (Number(version[1]) !== AI_VERSE_OS_SUPPORTED_SCHEMA_MAJOR) {
    return incompatible(
      root,
      `AI-Verse Multiple Bots supports AI-Verse OS schema major ${AI_VERSE_OS_SUPPORTED_SCHEMA_MAJOR}; found ${schema.value}`,
      schema.value,
      architecture.value
    );
  }
  if (architecture.value !== AI_VERSE_OS_SUPPORTED_ARCHITECTURE) {
    return incompatible(
      root,
      `Unsupported AI-Verse OS architecture '${architecture.value ?? ""}'; expected '${AI_VERSE_OS_SUPPORTED_ARCHITECTURE}'`,
      schema.value,
      architecture.value
    );
  }

  const requiredFiles: Array<[string, string]> = [
    [resolve(root, "AGENTS.md"), "AGENTS.md"],
    [resolve(root, "system", "extensions", "README.md"), "system/extensions/README.md"]
  ];
  for (const [path, label] of requiredFiles) {
    const error = classifyRegularFile(path, label);
    if (error) return incompatible(root, `AI-Verse OS v2 layout is incomplete: ${error}`, schema.value, architecture.value);
  }

  const requiredDirectories: Array<[string, string]> = [
    [resolve(root, "operator"), "operator/"],
    [resolve(root, "workspaces"), "workspaces/"]
  ];
  for (const [path, label] of requiredDirectories) {
    const error = classifyDirectory(path, label);
    if (error) return incompatible(root, `AI-Verse OS v2 layout is incomplete: ${error}`, schema.value, architecture.value);
  }

  let runtimeContract = "";
  let extensionContract = "";
  try {
    runtimeContract = readFileSync(resolve(root, "AGENTS.md"), "utf8");
    extensionContract = readFileSync(resolve(root, "system", "extensions", "README.md"), "utf8");
  } catch (error) {
    return incompatible(root, `AI-Verse OS extension contract is unreadable: ${error instanceof Error ? error.message : String(error)}`, schema.value, architecture.value);
  }
  if (!runtimeContract.includes(AI_VERSE_OS_EXTENSION_REGISTRY_PATH)) {
    return incompatible(root, "AGENTS.md does not expose the AI-Verse OS local extension runtime hook", schema.value, architecture.value);
  }
  if (!extensionContract.includes(AI_VERSE_OS_EXTENSION_REGISTRY_PATH)) {
    return incompatible(root, "system/extensions/README.md does not declare the AI-Verse OS local extension registry", schema.value, architecture.value);
  }

  return {
    host_id: AI_VERSE_OS_HOST_ID,
    root,
    status: "compatible",
    reason: "compatible AI-Verse OS v2 unified-workspace host with local extension registry support",
    schema_version: schema.value,
    architecture: architecture.value,
    registry_path: registryPath
  };
}

export function findAiVerseOsRoot(startInput: string): string | null {
  let current = resolve(startInput);
  while (true) {
    if (existsSync(resolve(current, "AI-VERSE.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function validateAiVerseOsRelativePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new AiVerseOsRegistrationError("INVALID_EXTENSION_PATH", "Extension path must be a non-empty repository-relative string");
  }
  if (input.includes("\0")) {
    throw new AiVerseOsRegistrationError("INVALID_EXTENSION_PATH", "Extension path must not contain NUL characters");
  }
  if (/^[A-Za-z]:[\\/]/.test(input) || input.startsWith("\\\\") || input.startsWith("/") || input.startsWith("\\")) {
    throw new AiVerseOsRegistrationError("INVALID_EXTENSION_PATH", `Extension path must be repository-relative: ${input}`);
  }
  const normalized = input.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new AiVerseOsRegistrationError("INVALID_EXTENSION_PATH", `Extension path contains unsafe traversal or empty segments: ${input}`);
  }
  return segments.join("/");
}

function resolveInsideRoot(root: string, relativePath: string): string {
  const safe = validateAiVerseOsRelativePath(relativePath);
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, ...safe.split("/"));
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${sep}`)) {
    throw new AiVerseOsRegistrationError("PATH_ESCAPES_OS_ROOT", `Extension path resolves outside AI-Verse OS root: ${relativePath}`);
  }
  return target;
}

function assertPathChainHasNoSymlinks(root: string, relativePath: string, includeLeaf: boolean): void {
  const safe = validateAiVerseOsRelativePath(relativePath);
  const segments = safe.split("/");
  const last = includeLeaf ? segments.length : Math.max(0, segments.length - 1);
  let current = resolve(root);
  for (let index = 0; index < last; index += 1) {
    current = resolve(current, segments[index]!);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new AiVerseOsRegistrationError("SYMLINK_PATH_REJECTED", `Extension path traverses symlink: ${safe}`);
    }
  }
}

function readRegistryDocument(root: string): RegistryDocument {
  const registryRelative = AI_VERSE_OS_EXTENSION_REGISTRY_PATH;
  const registryPath = resolveInsideRoot(root, registryRelative);
  assertPathChainHasNoSymlinks(root, registryRelative, true);
  if (!existsSync(registryPath)) {
    const extensions: JsonRecord = {};
    return {
      document: { schema_version: AI_VERSE_OS_EXTENSION_REGISTRY_SCHEMA, extensions },
      extensions,
      exists: false,
      raw_text: null
    };
  }
  const stat = lstatSync(registryPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AiVerseOsRegistrationError("INVALID_EXTENSION_REGISTRY", `Local extension registry must be a regular file: ${registryPath}`);
  }

  let parsed: unknown;
  let rawText: string;
  try {
    rawText = readFileSync(registryPath, "utf8");
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new AiVerseOsRegistrationError(
      "INVALID_EXTENSION_REGISTRY",
      `Local extension registry is unreadable or invalid JSON; left unchanged: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const document = asRecord(parsed);
  if (!document) throw new AiVerseOsRegistrationError("INVALID_EXTENSION_REGISTRY", "Local extension registry must contain a JSON object; left unchanged");
  if (String(document.schema_version ?? "") !== AI_VERSE_OS_EXTENSION_REGISTRY_SCHEMA) {
    throw new AiVerseOsRegistrationError(
      "UNSUPPORTED_EXTENSION_REGISTRY_SCHEMA",
      `Unsupported local extension registry schema '${String(document.schema_version ?? "") || "missing"}'; left unchanged`
    );
  }
  const extensions = asRecord(document.extensions);
  if (!extensions) {
    throw new AiVerseOsRegistrationError("INVALID_EXTENSION_REGISTRY", "Local extension registry 'extensions' must be a JSON object; left unchanged");
  }
  return { document, extensions, exists: true, raw_text: rawText };
}

function normalizedAdapters(adapters: string[] | undefined): string[] {
  const source = adapters ?? [];
  return [...new Set(source.map(validateAiVerseOsRelativePath))].sort();
}

function buildEntry(existing: JsonRecord | null, options: AiVerseOsRegistrationOptions = {}): JsonRecord {
  const current = existing ?? {};
  const instructions = validateAiVerseOsRelativePath(options.instructions ?? AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH);
  const engine = validateAiVerseOsRelativePath(options.engine ?? AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH);
  const adapters = normalizedAdapters(options.adapters);
  const enabled = options.enabled ?? (typeof current.enabled === "boolean" ? current.enabled : true);
  return {
    ...current,
    id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
    supported: true,
    installed: true,
    enabled,
    version: options.version ?? AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION,
    source: options.source ?? AI_VERSE_MULTIPLE_BOTS_EXTENSION_SOURCE,
    instructions,
    engine,
    adapters
  };
}

function canonicalString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(",")}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalString(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertInstalledFile(root: string, relativePath: string): void {
  const target = resolveInsideRoot(root, relativePath);
  assertPathChainHasNoSymlinks(root, relativePath, true);
  if (!existsSync(target)) {
    throw new AiVerseOsRegistrationError("MISSING_EXTENSION_FILE", `Required installed extension file is missing: ${relativePath}`);
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AiVerseOsRegistrationError("INVALID_EXTENSION_FILE", `Installed extension path must be a regular file: ${relativePath}`);
  }
}

function writeRegistryAtomic(root: string, document: JsonRecord, expectedRawText: string | null): void {
  const registryPath = resolveInsideRoot(root, AI_VERSE_OS_EXTENSION_REGISTRY_PATH);
  const registryDirectory = dirname(registryPath);
  assertPathChainHasNoSymlinks(root, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, false);
  mkdirSync(registryDirectory, { recursive: true });
  assertPathChainHasNoSymlinks(root, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, false);
  const temporaryPath = `${registryPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    assertPathChainHasNoSymlinks(root, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, true);
    const currentRawText = existsSync(registryPath) ? readFileSync(registryPath, "utf8") : null;
    if (currentRawText !== expectedRawText) {
      throw new AiVerseOsRegistrationError(
        "EXTENSION_REGISTRY_CHANGED",
        "Local extension registry changed during registration; no write was applied. Retry against the latest registry state."
      );
    }
    renameSync(temporaryPath, registryPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function withRegistryLock<T>(root: string, operation: () => T): T {
  const lockPath = resolveInsideRoot(root, AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH);
  const lockDirectory = dirname(lockPath);
  assertPathChainHasNoSymlinks(root, AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH, false);
  mkdirSync(lockDirectory, { recursive: true });
  assertPathChainHasNoSymlinks(root, AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH, false);
  let acquired = false;
  try {
    try {
      writeFileSync(
        lockPath,
        `${JSON.stringify({ extension_id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID, created_at: new Date().toISOString() })}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" }
      );
      acquired = true;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
      if (code === "EEXIST") {
        throw new AiVerseOsRegistrationError(
          "EXTENSION_REGISTRY_BUSY",
          `Local extension registry is already locked at ${AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH}; retry after the active installer finishes.`
        );
      }
      throw new AiVerseOsRegistrationError(
        "EXTENSION_REGISTRY_LOCK_FAILED",
        `Could not acquire local extension registry lock: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return operation();
  } finally {
    if (acquired) rmSync(lockPath, { force: true });
  }
}

function requireCompatible(rootInput: string): AiVerseOsCompatibility {
  const compatibility = detectAiVerseOsCompatibility(rootInput);
  if (compatibility.status !== "compatible") {
    throw new AiVerseOsRegistrationError(
      compatibility.status === "no-os" ? "AI_VERSE_OS_NOT_FOUND" : "INCOMPATIBLE_AI_VERSE_OS",
      `AI-Verse OS registration blocked: ${compatibility.reason}`
    );
  }
  return compatibility;
}

function planFromRegistry(
  compatibility: AiVerseOsCompatibility,
  extensions: JsonRecord,
  options: AiVerseOsRegistrationOptions
): AiVerseOsRegistrationPlan {
  const rawExisting = extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID];
  if (rawExisting !== undefined && rawExisting !== null && !asRecord(rawExisting)) {
    throw new AiVerseOsRegistrationError(
      "INVALID_EXISTING_EXTENSION_ENTRY",
      `Existing ${AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID} registration is not an object; left unchanged`
    );
  }
  const currentEntry = rawExisting === undefined || rawExisting === null ? null : asRecord(rawExisting)!;
  const nextEntry = buildEntry(currentEntry, options);
  const filesToVerify = [
    String(nextEntry.instructions),
    String(nextEntry.engine),
    ...((Array.isArray(nextEntry.adapters) ? nextEntry.adapters : []).map(String))
  ];
  return {
    host_id: AI_VERSE_OS_HOST_ID,
    root: compatibility.root,
    extension_id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
    registry_path: compatibility.registry_path,
    compatibility,
    current_entry: currentEntry,
    next_entry: nextEntry,
    files_to_verify: filesToVerify,
    requires_write: currentEntry === null || canonicalString(currentEntry) !== canonicalString(nextEntry),
    tracked_os_files_mutated: [],
    preserves_unknown_registry_fields: true
  };
}

export function planAiVerseOsRegistration(rootInput: string, options: AiVerseOsRegistrationOptions = {}): AiVerseOsRegistrationPlan {
  const compatibility = requireCompatible(rootInput);
  const { extensions } = readRegistryDocument(compatibility.root);
  return planFromRegistry(compatibility, extensions, options);
}

export function registerAiVerseOsExtension(rootInput: string, options: AiVerseOsRegistrationOptions = {}): AiVerseOsRegistrationResult {
  const compatibility = requireCompatible(rootInput);
  return withRegistryLock(compatibility.root, () => {
    const registry = readRegistryDocument(compatibility.root);
    const plan = planFromRegistry(compatibility, registry.extensions, options);
    if (options.verify_installed_paths !== false) {
      for (const relativePath of plan.files_to_verify) assertInstalledFile(plan.root, relativePath);
    }
    if (!plan.requires_write) return { ...plan, status: "unchanged" };

    const nextExtensions: JsonRecord = {
      ...registry.extensions,
      [AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID]: plan.next_entry
    };
    const nextDocument: JsonRecord = {
      ...registry.document,
      schema_version: AI_VERSE_OS_EXTENSION_REGISTRY_SCHEMA,
      extensions: nextExtensions
    };
    writeRegistryAtomic(plan.root, nextDocument, registry.raw_text);
    return {
      ...plan,
      status: plan.current_entry ? "updated" : "registered"
    };
  });
}

export const aiVerseOsRegistrationAdapter: AiVerseOsRegistrationAdapter = {
  id: AI_VERSE_OS_HOST_ID,
  detect: detectAiVerseOsCompatibility,
  plan: planAiVerseOsRegistration,
  register: registerAiVerseOsExtension
};
