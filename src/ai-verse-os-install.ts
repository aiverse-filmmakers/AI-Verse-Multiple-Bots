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
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_ROOT,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_SOURCE,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION,
  AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH,
  AiVerseOsRegistrationError,
  detectAiVerseOsCompatibility,
  planAiVerseOsRegistration,
  registerAiVerseOsExtension
} from "./ai-verse-os-registration.js";
import { CoordinationStore } from "./store.js";

export const AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH = "runtime/ai-verse-bots/coordination.db";

export interface AiVerseOsInstallFilePlan {
  path: string;
  state: "missing" | "current" | "conflict";
  action: "create" | "none";
}

export interface AiVerseOsInstallPlan {
  root: string;
  extension_id: typeof AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID;
  version: typeof AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION;
  extension_root: string;
  instructions_path: string;
  engine_path: string;
  coordination_db_path: string;
  registry_path: string;
  current_registration: Record<string, unknown> | null;
  files: AiVerseOsInstallFilePlan[];
  database_state: "missing" | "present";
  can_install: boolean;
  conflicts: string[];
  tracked_os_files_mutated: string[];
  preserves_canonical_host_state: true;
}

export interface AiVerseOsInstallResult extends AiVerseOsInstallPlan {
  status: "installed" | "unchanged";
  materialized_files: string[];
  database_initialized: boolean;
  schema_version: string;
  registration_status: "registered" | "updated" | "unchanged";
}

export class AiVerseOsInstallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AiVerseOsInstallError";
  }
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function sourceInstructionsPath(): string {
  return resolve(packageRoot(), "integrations", "ai-verse-os", "INSTRUCTIONS.md");
}

function sourceServerModulePath(): string {
  return resolve(packageRoot(), "dist", "src", "server.js");
}

function assertPackagedSource(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new AiVerseOsInstallError("PACKAGE_ASSET_MISSING", `Installed package is missing ${label}: ${path}`);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AiVerseOsInstallError("PACKAGE_ASSET_UNSAFE", `Installed package ${label} must be a regular file: ${path}`);
  }
}

function expectedInstructions(): string {
  const path = sourceInstructionsPath();
  assertPackagedSource(path, "AI-Verse OS instructions");
  return readFileSync(path, "utf8");
}

function expectedEngine(): string {
  const serverPath = sourceServerModulePath();
  assertPackagedSource(serverPath, "compiled Gateway server");
  const serverUrl = pathToFileURL(serverPath).href;
  return `import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGatewayServer } from ${JSON.stringify(serverUrl)};

const extensionRoot = dirname(fileURLToPath(import.meta.url));
export const aiVerseOsRoot = resolve(extensionRoot, "..", "..", "..");
export const packageVersion = ${JSON.stringify(AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION)};

export function createGateway(options = {}) {
  return createGatewayServer({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 8787,
    dbPath: options.dbPath ?? resolve(aiVerseOsRoot, "runtime", "ai-verse-bots", "coordination.db"),
    aiVerseOsRoot
  });
}

export async function startGateway(options = {}) {
  const service = createGateway(options);
  const address = await service.listen();
  return {
    service,
    address,
    root: aiVerseOsRoot,
    db: service.store.dbPath
  };
}

export default {
  id: "ai-verse-multiple-bots",
  version: packageVersion,
  root: aiVerseOsRoot,
  createGateway,
  startGateway
};
`;
}

function resolveInsideRoot(rootInput: string, relativePath: string): string {
  const root = resolve(rootInput);
  const target = resolve(root, ...relativePath.split("/"));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new AiVerseOsInstallError("PATH_ESCAPES_OS_ROOT", `Install path resolves outside AI-Verse OS root: ${relativePath}`);
  }
  return target;
}

function assertPathChainHasNoSymlinks(rootInput: string, relativePath: string, includeLeaf: boolean): void {
  const root = resolve(rootInput);
  const segments = relativePath.split("/");
  const limit = includeLeaf ? segments.length : Math.max(0, segments.length - 1);
  let current = root;
  for (let index = 0; index < limit; index += 1) {
    current = resolve(current, segments[index]!);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new AiVerseOsInstallError("SYMLINK_PATH_REJECTED", `Install path traverses a symlink: ${relativePath}`);
    }
  }
}

function assertOwnedOrAbsentRegistration(current: Record<string, unknown> | null): void {
  if (!current) return;
  if (
    current.id !== AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID
    || current.source !== AI_VERSE_MULTIPLE_BOTS_EXTENSION_SOURCE
    || current.instructions !== AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH
    || current.engine !== AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH
  ) {
    throw new AiVerseOsInstallError(
      "EXTENSION_OWNERSHIP_MISMATCH",
      `Refusing install because the existing '${AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID}' registry entry is not owned by this package`
    );
  }
  if (current.version !== AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION) {
    throw new AiVerseOsInstallError(
      "EXTENSION_REQUIRES_UPGRADE",
      `Existing Multiple Bots registration is version '${String(current.version ?? "unknown")}', not '${AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION}'. Use the upgrade lifecycle instead of install.`
    );
  }
  if (!Array.isArray(current.adapters)) {
    throw new AiVerseOsInstallError(
      "EXTENSION_OWNERSHIP_MISMATCH",
      "Existing Multiple Bots registration has invalid adapter metadata"
    );
  }
}

function filePlan(
  root: string,
  relativePath: string,
  expected: string
): AiVerseOsInstallFilePlan {
  assertPathChainHasNoSymlinks(root, relativePath, true);
  const path = resolveInsideRoot(root, relativePath);
  if (!existsSync(path)) return { path: relativePath, state: "missing", action: "create" };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { path: relativePath, state: "conflict", action: "none" };
  }
  const actual = readFileSync(path, "utf8");
  return actual === expected
    ? { path: relativePath, state: "current", action: "none" }
    : { path: relativePath, state: "conflict", action: "none" };
}

function databaseState(root: string): "missing" | "present" {
  assertPathChainHasNoSymlinks(root, AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH, true);
  const path = resolveInsideRoot(root, AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH);
  if (!existsSync(path)) return "missing";
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AiVerseOsInstallError(
      "INVALID_COORDINATION_DATABASE_PATH",
      `AI-Verse OS coordination database path must be a regular file: ${AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH}`
    );
  }
  return "present";
}

function assertCompatibleHost(rootInput: string): string {
  const compatibility = detectAiVerseOsCompatibility(rootInput);
  if (compatibility.status !== "compatible") {
    throw new AiVerseOsInstallError(
      compatibility.status === "no-os" ? "AI_VERSE_OS_NOT_FOUND" : "INCOMPATIBLE_AI_VERSE_OS",
      `AI-Verse OS install blocked: ${compatibility.reason}`
    );
  }
  return compatibility.root;
}

export function planAiVerseOsInstall(rootInput: string): AiVerseOsInstallPlan {
  const root = assertCompatibleHost(rootInput);
  const registration = planAiVerseOsRegistration(root);
  assertOwnedOrAbsentRegistration(registration.current_entry);

  const instructions = expectedInstructions();
  const engine = expectedEngine();
  const files = [
    filePlan(root, AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH, instructions),
    filePlan(root, AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH, engine)
  ];
  const conflicts = files.filter((item) => item.state === "conflict").map((item) => item.path);
  const dbState = databaseState(root);

  return {
    root,
    extension_id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
    version: AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION,
    extension_root: resolveInsideRoot(root, AI_VERSE_MULTIPLE_BOTS_EXTENSION_ROOT),
    instructions_path: resolveInsideRoot(root, AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH),
    engine_path: resolveInsideRoot(root, AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH),
    coordination_db_path: resolveInsideRoot(root, AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH),
    registry_path: registration.registry_path,
    current_registration: registration.current_entry,
    files,
    database_state: dbState,
    can_install: conflicts.length === 0,
    conflicts,
    tracked_os_files_mutated: [],
    preserves_canonical_host_state: true
  };
}

function writeOwnedFile(root: string, relativePath: string, content: string): void {
  const target = resolveInsideRoot(root, relativePath);
  assertPathChainHasNoSymlinks(root, relativePath, false);
  mkdirSync(dirname(target), { recursive: true });
  assertPathChainHasNoSymlinks(root, relativePath, false);
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || readFileSync(target, "utf8") !== content) {
      throw new AiVerseOsInstallError("EXTENSION_FILE_CONFLICT", `Refusing to overwrite existing extension file: ${relativePath}`);
    }
    return;
  }

  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile() || readFileSync(target, "utf8") !== content) {
        throw new AiVerseOsInstallError("EXTENSION_FILE_CONFLICT", `Extension file changed during install: ${relativePath}`);
      }
      return;
    }
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function initializeCoordinationDatabase(root: string): { initialized: boolean; schemaVersion: string } {
  const path = resolveInsideRoot(root, AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH);
  const existed = existsSync(path);
  assertPathChainHasNoSymlinks(root, AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH, true);
  const store = new CoordinationStore(path);
  try {
    const doctor = store.doctor();
    if (!doctor.ok) {
      throw new AiVerseOsInstallError("COORDINATION_DATABASE_UNHEALTHY", "Coordination database failed its health check during AI-Verse OS install");
    }
    return { initialized: !existed, schemaVersion: store.schemaVersion() };
  } finally {
    store.close();
  }
}

export function installAiVerseOsExtension(rootInput: string): AiVerseOsInstallResult {
  const plan = planAiVerseOsInstall(rootInput);
  if (!plan.can_install) {
    throw new AiVerseOsInstallError(
      "EXTENSION_FILE_CONFLICT",
      `Refusing install because extension-owned paths already contain different content: ${plan.conflicts.join(", ")}`
    );
  }

  const instructions = expectedInstructions();
  const engine = expectedEngine();
  const created: string[] = [];

  try {
    for (const item of plan.files) {
      if (item.action !== "create") continue;
      const content = item.path === AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH ? instructions : engine;
      writeOwnedFile(plan.root, item.path, content);
      created.push(item.path);
    }

    const database = initializeCoordinationDatabase(plan.root);
    const registration = registerAiVerseOsExtension(plan.root);

    const finalPlan = planAiVerseOsInstall(plan.root);
    const status = (
      created.length === 0
      && !database.initialized
      && registration.status === "unchanged"
    ) ? "unchanged" : "installed";

    return {
      ...finalPlan,
      status,
      materialized_files: created.sort(),
      database_initialized: database.initialized,
      schema_version: database.schemaVersion,
      registration_status: registration.status
    };
  } catch (error) {
    for (const relativePath of created.reverse()) {
      const target = resolveInsideRoot(plan.root, relativePath);
      try {
        if (!existsSync(target)) continue;
        const stat = lstatSync(target);
        if (!stat.isSymbolicLink() && stat.isFile()) rmSync(target);
      } catch {
        // Leave any path we cannot prove safe rather than broadening cleanup.
      }
    }

    if (error instanceof AiVerseOsInstallError || error instanceof AiVerseOsRegistrationError) throw error;
    throw new AiVerseOsInstallError(
      "AI_VERSE_OS_INSTALL_FAILED",
      error instanceof Error ? error.message : String(error)
    );
  }
}
