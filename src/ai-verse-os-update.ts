import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
  AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION,
  AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH,
  planAiVerseOsUpgrade,
  upgradeAiVerseOsExtension
} from "./ai-verse-os-registration.js";
import {
  AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH,
  expectedAiVerseOsEngine,
  expectedAiVerseOsInstructions
} from "./ai-verse-os-install.js";
import { assessCoordinationMigration } from "./coordination-migration.js";
import { versionOrder, type VersionOrder } from "./versioning.js";

export interface AiVerseOsUpdateFilePlan {
  path: string;
  state: "missing" | "current" | "outdated" | "unsafe";
  action: "create" | "replace" | "none";
}

export interface AiVerseOsProductUpdatePlan {
  mode: "ai-verse-os";
  root: string;
  current_version: string;
  current_version_state: VersionOrder;
  target_version: string;
  enabled: boolean;
  files: AiVerseOsUpdateFilePlan[];
  registered_adapters: string[];
  adapter_failures: string[];
  database: string;
  coordination_schema: {
    installed: string | null;
    target: string;
    quick_check: string;
  };
  update_required: boolean;
  migration_required: boolean;
  migration_supported: boolean;
  can_update: boolean;
  blocked_reasons: string[];
  preserves_enabled_state: true;
  preserves_coordination_state: true;
  preserves_unknown_registry_fields: true;
  preserves_canonical_host_state: true;
}

export interface AiVerseOsProductUpdateResult extends AiVerseOsProductUpdatePlan {
  status: "unchanged" | "updated";
  previous_version: string;
  changed_files: string[];
  registration_status: "updated" | "unchanged";
}

export class AiVerseOsProductUpdateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AiVerseOsProductUpdateError";
  }
}

interface PreviousFile {
  path: string;
  existed: boolean;
  content: string | null;
  mode: number;
}

function resolveInsideRoot(rootInput: string, relativePath: string): string {
  if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\") || relativePath.split("/").some((part) => part === ".." || part === "")) {
    throw new AiVerseOsProductUpdateError("INVALID_REGISTERED_PATH", `Unsafe registered path: ${relativePath}`);
  }
  const root = resolve(rootInput);
  const target = resolve(root, ...relativePath.split("/"));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new AiVerseOsProductUpdateError("PATH_ESCAPES_OS_ROOT", `Registered path escapes AI-Verse OS root: ${relativePath}`);
  }
  return target;
}

function assertNoSymlinkChain(rootInput: string, relativePath: string, includeLeaf: boolean): void {
  const root = resolve(rootInput);
  const segments = relativePath.split("/");
  const limit = includeLeaf ? segments.length : Math.max(0, segments.length - 1);
  let current = root;
  for (let index = 0; index < limit; index += 1) {
    current = resolve(current, segments[index]!);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new AiVerseOsProductUpdateError("SYMLINK_PATH_REJECTED", `Update path traverses a symlink: ${relativePath}`);
    }
  }
}

function filePlan(root: string, relativePath: string, expected: string): AiVerseOsUpdateFilePlan {
  assertNoSymlinkChain(root, relativePath, true);
  const target = resolveInsideRoot(root, relativePath);
  if (!existsSync(target)) return { path: relativePath, state: "missing", action: "create" };
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { path: relativePath, state: "unsafe", action: "none" };
  }
  return readFileSync(target, "utf8") === expected
    ? { path: relativePath, state: "current", action: "none" }
    : { path: relativePath, state: "outdated", action: "replace" };
}

function registeredAdapterFailures(root: string, adapters: string[]): string[] {
  const failures: string[] = [];
  for (const relativePath of adapters) {
    try {
      assertNoSymlinkChain(root, relativePath, true);
      const target = resolveInsideRoot(root, relativePath);
      if (!existsSync(target)) {
        failures.push(`${relativePath}:missing`);
        continue;
      }
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) failures.push(`${relativePath}:unsafe`);
    } catch (error) {
      failures.push(`${relativePath}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

function snapshotFile(root: string, relativePath: string): PreviousFile {
  assertNoSymlinkChain(root, relativePath, true);
  const path = resolveInsideRoot(root, relativePath);
  if (!existsSync(path)) return { path: relativePath, existed: false, content: null, mode: 0o600 };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AiVerseOsProductUpdateError("UNSAFE_UPDATE_FILE", `Refusing update of non-regular extension file: ${relativePath}`);
  }
  return {
    path: relativePath,
    existed: true,
    content: readFileSync(path, "utf8"),
    mode: Number(stat.mode ?? 0o600) & 0o777
  };
}

function replaceFile(root: string, relativePath: string, content: string): PreviousFile {
  const previous = snapshotFile(root, relativePath);
  const target = resolveInsideRoot(root, relativePath);
  assertNoSymlinkChain(root, relativePath, false);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    assertNoSymlinkChain(root, relativePath, false);
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new AiVerseOsProductUpdateError("UNSAFE_UPDATE_FILE", `Extension path changed during update: ${relativePath}`);
      }
    }
    renameSync(temporary, target);
    return previous;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function restoreFile(root: string, previous: PreviousFile): void {
  const target = resolveInsideRoot(root, previous.path);
  assertNoSymlinkChain(root, previous.path, false);
  if (!previous.existed) {
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (!stat.isSymbolicLink() && stat.isFile()) rmSync(target);
    }
    return;
  }
  const temporary = `${target}.${randomUUID()}.rollback.tmp`;
  try {
    writeFileSync(temporary, previous.content ?? "", {
      encoding: "utf8",
      mode: previous.mode || 0o600,
      flag: "wx"
    });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function planAiVerseOsProductUpdate(rootInput: string): AiVerseOsProductUpdatePlan {
  const registration = planAiVerseOsUpgrade(rootInput);
  const currentVersion = registration.previous_version;
  let currentVersionState: VersionOrder;
  try {
    currentVersionState = versionOrder(currentVersion, AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION);
  } catch (error) {
    throw new AiVerseOsProductUpdateError(
      "INVALID_INSTALLED_VERSION",
      error instanceof Error ? error.message : String(error)
    );
  }

  const root = registration.root;
  const instructions = expectedAiVerseOsInstructions();
  const engine = expectedAiVerseOsEngine();
  const files = [
    filePlan(root, AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH, instructions),
    filePlan(root, AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH, engine)
  ];
  const adapters = Array.isArray(registration.current_entry.adapters)
    ? registration.current_entry.adapters.map(String)
    : [];
  const adapterFailures = registeredAdapterFailures(root, adapters);
  const database = resolveInsideRoot(root, AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH);
  const migration = assessCoordinationMigration(database);
  const blocked: string[] = [];

  if (currentVersionState === "newer") {
    blocked.push("installed AI-Verse OS registration is newer than this package; downgrade requires the distribution rollback flow");
  }
  for (const file of files) {
    if (file.state === "unsafe") blocked.push(`unsafe package-owned extension path: ${file.path}`);
  }
  if (adapterFailures.length > 0) {
    blocked.push(`registered adapter paths are unavailable or unsafe: ${adapterFailures.join(", ")}`);
  }
  if (!migration.can_use_current_package && migration.blocked_reason) blocked.push(migration.blocked_reason);

  const fileUpdateRequired = files.some((file) => file.action !== "none");
  const versionUpdateRequired = currentVersionState === "older";
  const updateRequired = fileUpdateRequired || versionUpdateRequired;

  return {
    mode: "ai-verse-os",
    root,
    current_version: currentVersion,
    current_version_state: currentVersionState,
    target_version: AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION,
    enabled: registration.current_entry.enabled !== false,
    files,
    registered_adapters: adapters,
    adapter_failures: adapterFailures,
    database,
    coordination_schema: {
      installed: migration.installed_schema,
      target: migration.target_schema,
      quick_check: migration.quick_check
    },
    update_required: updateRequired,
    migration_required: migration.migration_required,
    migration_supported: migration.migration_supported,
    can_update: blocked.length === 0,
    blocked_reasons: blocked,
    preserves_enabled_state: true,
    preserves_coordination_state: true,
    preserves_unknown_registry_fields: true,
    preserves_canonical_host_state: true
  };
}

export function updateAiVerseOsProduct(rootInput: string): AiVerseOsProductUpdateResult {
  const plan = planAiVerseOsProductUpdate(rootInput);
  if (!plan.can_update) {
    const code = plan.migration_required
      ? "MIGRATION_REQUIRED"
      : plan.current_version_state === "newer"
        ? "DOWNGRADE_REQUIRES_ROLLBACK"
        : "AI_VERSE_OS_UPDATE_BLOCKED";
    throw new AiVerseOsProductUpdateError(code, plan.blocked_reasons.join("; ") || "AI-Verse OS update is blocked");
  }
  if (!plan.update_required) {
    return {
      ...plan,
      status: "unchanged",
      previous_version: plan.current_version,
      changed_files: [],
      registration_status: "unchanged"
    };
  }

  const expected = new Map<string, string>([
    [AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH, expectedAiVerseOsInstructions()],
    [AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH, expectedAiVerseOsEngine()]
  ]);
  const previousFiles: PreviousFile[] = [];
  const changedFiles: string[] = [];

  try {
    for (const file of plan.files) {
      if (file.action === "none") continue;
      const content = expected.get(file.path);
      if (content === undefined) throw new AiVerseOsProductUpdateError("UNKNOWN_UPDATE_FILE", `No package payload for ${file.path}`);
      previousFiles.push(replaceFile(plan.root, file.path, content));
      changedFiles.push(file.path);
    }

    const registration = upgradeAiVerseOsExtension(plan.root, { adapters: plan.registered_adapters });
    const finalPlan = planAiVerseOsProductUpdate(plan.root);
    if (!finalPlan.can_update || finalPlan.update_required) {
      throw new AiVerseOsProductUpdateError(
        "AI_VERSE_OS_UPDATE_VERIFICATION_FAILED",
        "AI-Verse OS update did not converge to the current package state"
      );
    }

    return {
      ...finalPlan,
      status: "updated",
      previous_version: plan.current_version,
      changed_files: changedFiles.sort(),
      registration_status: registration.status
    };
  } catch (error) {
    for (const previous of previousFiles.reverse()) {
      try {
        restoreFile(plan.root, previous);
      } catch {
        // Do not broaden rollback into unknown paths. Any failed restoration is
        // surfaced by the next plan/doctor instead of deleting more state.
      }
    }
    if (error instanceof AiVerseOsProductUpdateError) throw error;
    throw new AiVerseOsProductUpdateError(
      "AI_VERSE_OS_UPDATE_FAILED",
      error instanceof Error ? error.message : String(error)
    );
  }
}
