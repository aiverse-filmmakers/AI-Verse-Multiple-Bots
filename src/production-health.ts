import process from "node:process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { delimiter, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
  findAiVerseOsRoot
} from "./ai-verse-os-registration.js";
import { planAiVerseOsInstall } from "./ai-verse-os-install.js";
import {
  findStandaloneRoot,
  readStandaloneInstallation
} from "./standalone-install.js";
import type { JsonObject } from "./types.js";

export const PRODUCTION_HEALTH_SCHEMA = "1.0";
export const PRODUCTION_HEALTH_PROVIDER = "ai-verse-multiple-bots/production-health-v1";

export type ProductionHealthMode = "standalone" | "ai-verse-os";
export type ProductionHealthDepth =
  | "structural"
  | "attachment"
  | "runtime"
  | "dependency"
  | "operational"
  | "system/composed";
export type ProductionHealthCheckStatus = "pass" | "fail" | "warning" | "not_applicable" | "delegated";
export type ProductionLifecycleState = "setup-required" | "disabled" | "unhealthy" | "ready";

export interface ProductionHealthCheck extends JsonObject {
  id: string;
  depth: ProductionHealthDepth;
  status: ProductionHealthCheckStatus;
  summary: string;
  details?: JsonObject;
}

export interface ProductionHealthOptions {
  mode?: string;
  root?: string;
  cwd?: string;
  dbPath?: string;
  env?: Record<string, string | undefined>;
}

export interface ProductionHealthReport extends JsonObject {
  schema_version: typeof PRODUCTION_HEALTH_SCHEMA;
  provider: typeof PRODUCTION_HEALTH_PROVIDER;
  component_id: typeof AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID;
  component_version: string;
  generated_at: string;
  read_only: true;
  mode: ProductionHealthMode | null;
  root: string | null;
  database: string | null;
  state: ProductionLifecycleState;
  ready: boolean;
  checked_depths: ProductionHealthDepth[];
  delegated_depths: ProductionHealthDepth[];
  checks: ProductionHealthCheck[];
  summary: {
    passed: number;
    failed: number;
    warnings: number;
    not_applicable: number;
    delegated: number;
  };
}

export interface ProductionStatus extends JsonObject {
  schema_version: typeof PRODUCTION_HEALTH_SCHEMA;
  component_id: typeof AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID;
  component_version: string;
  generated_at: string;
  mode: ProductionHealthMode | null;
  root: string | null;
  database: string | null;
  state: ProductionLifecycleState;
  ready: boolean;
  failed_checks: number;
  warning_checks: number;
  doctor_command: string;
}

interface SelectedInstallation {
  mode: ProductionHealthMode;
  root: string;
}

interface ReadOnlyDatabaseInspection {
  schemaVersion: string | null;
  quickCheck: string;
  tableNames: Set<string>;
  bots: JsonObject[];
  tasks: JsonObject[];
  deadLetterCount: number;
  staleExecutionCount: number;
  queueConsistencyFailures: string[];
}

const REGISTERED_RUNTIME_ADAPTERS = new Set([
  "deterministic",
  "openai-compatible",
  "a2a",
  "hermes",
  "openclaw",
  "codex",
  "claude-code",
  "external-managed"
]);

const CORE_TABLES = ["meta", "objects", "events", "deliveries", "idempotency", "room_sequences"];

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function packageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(resolve(packageRoot(), "package.json"), "utf8")) as Record<string, unknown>;
    return typeof parsed.version === "string" && parsed.version ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

function safeRegularFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return !stat.isSymbolicLink() && stat.isFile();
}

function safeDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return !stat.isSymbolicLink() && stat.isDirectory();
}

function parseMode(value: string | undefined): ProductionHealthMode | null {
  if (value === undefined) return null;
  const mode = value.trim().toLowerCase();
  if (mode === "standalone") return "standalone";
  if (mode === "os" || mode === "ai-verse-os" || mode === "aiverse-os") return "ai-verse-os";
  throw new Error(`Unsupported health mode '${value}'. Use standalone or os.`);
}

function detectInstallation(options: ProductionHealthOptions): SelectedInstallation | null {
  const cwd = resolve(options.cwd ?? ".");
  const explicit = parseMode(options.mode);
  if (explicit) {
    if (options.root) return { mode: explicit, root: resolve(options.root) };
    if (explicit === "standalone") return { mode: explicit, root: findStandaloneRoot(cwd) ?? cwd };
    return { mode: explicit, root: findAiVerseOsRoot(cwd) ?? cwd };
  }

  const start = options.root ? resolve(options.root) : cwd;
  const standalone = findStandaloneRoot(start);
  const os = findAiVerseOsRoot(start);
  if (standalone && os) {
    throw new Error("Both standalone and AI-Verse OS installations are discoverable; pass --mode explicitly.");
  }
  if (standalone) return { mode: "standalone", root: standalone };
  if (os) return { mode: "ai-verse-os", root: os };
  return null;
}

function check(
  checks: ProductionHealthCheck[],
  id: string,
  depth: ProductionHealthDepth,
  status: ProductionHealthCheckStatus,
  summary: string,
  details?: JsonObject
): void {
  checks.push({ id, depth, status, summary, ...(details ? { details } : {}) });
}

function nodeVersionOk(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 5);
}

function commandCandidates(command: string, env: Record<string, string | undefined>): string[] {
  if (!command.trim()) return [];
  if (command.includes("/") || command.includes("\\")) return [resolve(command)];
  const path = env.PATH ?? "";
  const dirs = path.split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  return dirs.flatMap((dir) => extensions.map((extension) => resolve(dir, command + extension)));
}

function commandAvailable(command: string, env: Record<string, string | undefined>): boolean {
  return commandCandidates(command, env).some((candidate) => safeRegularFile(candidate));
}

function objectValue(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function readPayloadRows(db: DatabaseSync, kind: string): JsonObject[] {
  const rows = db.prepare("SELECT payload FROM objects WHERE kind = ? ORDER BY id").all(kind) as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(String(row.payload)) as JsonObject);
}

function inspectDatabase(dbPath: string): ReadOnlyDatabaseInspection {
  if (!safeRegularFile(dbPath)) throw new Error(`Coordination database is missing or unsafe: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
    const tableNames = new Set(tableRows.map((row) => String(row.name)));
    const metaRow = tableNames.has("meta")
      ? db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined
      : undefined;
    const quickRow = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    const quickCheck = quickRow ? String(Object.values(quickRow)[0] ?? "unknown") : "unknown";
    const bots = tableNames.has("objects") ? readPayloadRows(db, "bot") : [];
    const tasks = tableNames.has("objects") ? readPayloadRows(db, "task") : [];

    let deadLetterCount = 0;
    let staleExecutionCount = 0;
    const queueConsistencyFailures: string[] = [];
    if (tableNames.has("execution_queue")) {
      deadLetterCount = Number((db.prepare("SELECT COUNT(*) AS count FROM execution_queue WHERE state = 'dead_letter'").get() as any)?.count ?? 0);
      staleExecutionCount = Number((db.prepare(
        "SELECT COUNT(*) AS count FROM execution_queue WHERE state IN ('claimed','running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?"
      ).get(new Date().toISOString()) as any)?.count ?? 0);

      const activeQueue = db.prepare(
        "SELECT item_id, target_id, state FROM execution_queue WHERE state IN ('queued','claimed','running') ORDER BY id"
      ).all() as Array<{ item_id: string; target_id: string; state: string }>;
      for (const row of activeQueue) {
        const target = db.prepare("SELECT kind, status FROM objects WHERE id = ?").get(row.target_id) as { kind?: string; status?: string } | undefined;
        if (!target) {
          queueConsistencyFailures.push(`execution target ${row.target_id} for ${row.item_id} is missing`);
          continue;
        }
        const executable = (target.kind === "bot" && target.status === "active")
          || (target.kind === "worker" && ["ready", "running", "waiting"].includes(String(target.status)));
        if (!executable) queueConsistencyFailures.push(`execution target ${row.target_id} is not executable (${String(target.status)})`);
      }

      const executableTasks = tasks.filter((task) => ["assigned", "accepted", "running"].includes(String(task.status)));
      for (const task of executableTasks) {
        const row = db.prepare("SELECT state FROM execution_queue WHERE item_id = ?").get(String(task.id)) as { state?: string } | undefined;
        if (!row) queueConsistencyFailures.push(`executable Task ${String(task.id)} has no execution queue record`);
        else if (!["queued", "claimed", "running"].includes(String(row.state))) {
          queueConsistencyFailures.push(`executable Task ${String(task.id)} has non-executable queue state ${String(row.state)}`);
        }
      }
    }

    return {
      schemaVersion: metaRow?.value ? String(metaRow.value) : null,
      quickCheck,
      tableNames,
      bots,
      tasks,
      deadLetterCount,
      staleExecutionCount,
      queueConsistencyFailures
    };
  } finally {
    db.close();
  }
}

function validateHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function activeBotRuntimeChecks(
  checks: ProductionHealthCheck[],
  inspection: ReadOnlyDatabaseInspection,
  env: Record<string, string | undefined>
): void {
  const activeBots = inspection.bots.filter((bot) => bot.status === "active");
  if (activeBots.length === 0) {
    check(checks, "active-bot-runtime", "runtime", "pass", "No active durable Bots require a runtime adapter yet.", {
      active_bots: 0
    });
    check(checks, "runtime-dependencies", "dependency", "not_applicable", "No active Bot runtime dependencies are currently required.");
    return;
  }

  let runtimeFailures = 0;
  let dependencyFailures = 0;
  let dependencyWarnings = 0;
  const adapters = new Set<string>();

  for (const bot of activeBots) {
    const runtime = objectValue(bot.runtime);
    const adapter = typeof runtime.adapter === "string" ? runtime.adapter.trim() : "";
    adapters.add(adapter || "<missing>");

    if (!adapter || !REGISTERED_RUNTIME_ADAPTERS.has(adapter)) {
      runtimeFailures += 1;
      check(
        checks,
        `runtime:${String(bot.id)}`,
        "runtime",
        "fail",
        adapter === "native"
          ? `Bot ${String(bot.id)} declares runtime adapter 'native', but the stock Gateway does not register a 'native' execution adapter.`
          : `Bot ${String(bot.id)} declares unregistered runtime adapter '${adapter || "missing"}'.`,
        { bot_id: String(bot.id), adapter: adapter || null }
      );
      continue;
    }

    check(checks, `runtime:${String(bot.id)}`, "runtime", "pass", `Bot ${String(bot.id)} uses registered runtime adapter '${adapter}'.`, {
      bot_id: String(bot.id),
      adapter
    });

    if (adapter === "deterministic") continue;

    if (adapter === "openai-compatible") {
      const endpointOk = validateHttpUrl(runtime.endpoint);
      const modelOk = typeof runtime.model === "string" && runtime.model.trim().length > 0;
      const credentialEnv = typeof runtime.api_key_env === "string" && runtime.api_key_env.trim() ? runtime.api_key_env.trim() : null;
      const credentialOk = !credentialEnv || Boolean(env[credentialEnv]);
      if (!endpointOk || !modelOk || !credentialOk) {
        dependencyFailures += 1;
        check(checks, `dependency:${String(bot.id)}`, "dependency", "fail", `Bot ${String(bot.id)} has incomplete OpenAI-compatible runtime dependencies.`, {
          endpoint_configured: endpointOk,
          model_configured: modelOk,
          credential_handle_configured: credentialEnv !== null,
          credential_handle_resolved: credentialOk
        });
      } else {
        dependencyWarnings += 1;
        check(checks, `dependency:${String(bot.id)}`, "dependency", "warning", `Bot ${String(bot.id)} has valid OpenAI-compatible configuration; doctor does not send a live model request.`, {
          live_probe_performed: false,
          credential_source: credentialEnv ? "environment_handle" : "none"
        });
      }
      continue;
    }

    if (adapter === "a2a") {
      if (!validateHttpUrl(runtime.agent_card_url)) {
        dependencyFailures += 1;
        check(checks, `dependency:${String(bot.id)}`, "dependency", "fail", `Bot ${String(bot.id)} requires a valid HTTP(S) runtime.agent_card_url.`);
      } else if (runtime.remote_machine_ref) {
        dependencyFailures += 1;
        check(checks, `dependency:${String(bot.id)}`, "dependency", "fail", `Bot ${String(bot.id)} requires injected remote-machine/auth providers that the stock CLI doctor cannot verify or configure.`, {
          requires_host_injection: true,
          live_probe_performed: false
        });
      } else {
        dependencyWarnings += 1;
        check(checks, `dependency:${String(bot.id)}`, "dependency", "warning", `Bot ${String(bot.id)} has an A2A endpoint configured; doctor does not contact the remote agent.`, {
          live_probe_performed: false
        });
      }
      continue;
    }

    if (adapter === "external-managed") {
      dependencyFailures += 1;
      check(checks, `dependency:${String(bot.id)}`, "dependency", "fail", `Bot ${String(bot.id)} uses external-managed runtime, which requires a host-injected provider registry not available to the stock CLI serve path.`, {
        provider: typeof runtime.provider === "string" ? runtime.provider : null,
        requires_host_injection: true
      });
      continue;
    }

    const defaultCommand = adapter === "hermes"
      ? (typeof runtime.python === "string" && runtime.python.trim()
          ? runtime.python.trim()
          : env.HERMES_PYTHON ?? env.PYTHON ?? "python3")
      : adapter === "openclaw"
        ? (typeof runtime.command === "string" && runtime.command.trim() ? runtime.command.trim() : "openclaw")
        : adapter === "codex"
          ? (typeof runtime.command === "string" && runtime.command.trim() ? runtime.command.trim() : "codex")
          : (typeof runtime.command === "string" && runtime.command.trim() ? runtime.command.trim() : "claude");

    const available = commandAvailable(defaultCommand, env);
    const cwd = typeof runtime.cwd === "string" && runtime.cwd.trim() ? resolve(runtime.cwd.trim()) : null;
    const cwdOk = !cwd || safeDirectory(cwd);
    const hermesRoot = adapter === "hermes" && typeof runtime.hermes_root === "string" && runtime.hermes_root.trim()
      ? resolve(runtime.hermes_root.trim())
      : null;
    const hermesRootOk = !hermesRoot || safeDirectory(hermesRoot);

    if (!available || !cwdOk || !hermesRootOk) {
      dependencyFailures += 1;
      check(checks, `dependency:${String(bot.id)}`, "dependency", "fail", `Bot ${String(bot.id)} is missing a required local process runtime dependency.`, {
        adapter,
        command: defaultCommand,
        command_available: available,
        cwd: cwd,
        cwd_ok: cwdOk,
        hermes_root: hermesRoot,
        hermes_root_ok: hermesRootOk
      });
    } else {
      check(checks, `dependency:${String(bot.id)}`, "dependency", "pass", `Bot ${String(bot.id)} has its local '${adapter}' process dependency available.`, {
        adapter,
        command: defaultCommand
      });
    }
  }

  check(
    checks,
    "runtime-summary",
    "runtime",
    runtimeFailures === 0 ? "pass" : "fail",
    runtimeFailures === 0
      ? `All ${activeBots.length} active Bot runtime adapter declarations are registered.`
      : `${runtimeFailures} active Bot runtime adapter declaration(s) are not executable by the stock Gateway.`,
    { active_bots: activeBots.length, adapters: [...adapters].sort(), failures: runtimeFailures }
  );
  check(
    checks,
    "dependency-summary",
    "dependency",
    dependencyFailures > 0 ? "fail" : dependencyWarnings > 0 ? "warning" : "pass",
    dependencyFailures > 0
      ? `${dependencyFailures} active Bot runtime dependency check(s) failed.`
      : dependencyWarnings > 0
        ? "Configured remote/model dependencies were syntax/handle checked but not contacted."
        : "All active Bot local runtime dependencies are available.",
    { failures: dependencyFailures, warnings: dependencyWarnings }
  );
}

function packageStructuralChecks(checks: ProductionHealthCheck[]): void {
  const version = process.versions?.node ?? process.version.replace(/^v/, "");
  check(
    checks,
    "node-version",
    "structural",
    nodeVersionOk(version) ? "pass" : "fail",
    nodeVersionOk(version)
      ? `Node.js ${version} satisfies the >=22.5 runtime floor.`
      : `Node.js ${version} does not satisfy the >=22.5 runtime floor.`,
    { node_version: version, required: ">=22.5.0" }
  );

  const root = packageRoot();
  const assets = [
    resolve(root, "dist", "src", "server.js"),
    resolve(root, "templates", "starter-catalog.json"),
    resolve(root, "integrations", "ai-verse-os", "INSTRUCTIONS.md")
  ];
  const missing = assets.filter((path) => !safeRegularFile(path));
  check(
    checks,
    "package-assets",
    "structural",
    missing.length === 0 ? "pass" : "fail",
    missing.length === 0 ? "Required packaged runtime assets are present as regular files." : "Required packaged runtime assets are missing or unsafe.",
    { missing }
  );
}

function databaseChecks(checks: ProductionHealthCheck[], dbPath: string): ReadOnlyDatabaseInspection | null {
  try {
    const inspection = inspectDatabase(dbPath);
    const missingTables = CORE_TABLES.filter((table) => !inspection.tableNames.has(table));
    check(checks, "coordination-database", "structural", inspection.quickCheck === "ok" && inspection.schemaVersion === "1" && missingTables.length === 0 ? "pass" : "fail",
      inspection.quickCheck === "ok" && inspection.schemaVersion === "1" && missingTables.length === 0
        ? "Coordination database passed read-only integrity/schema checks."
        : "Coordination database failed integrity/schema checks.",
      {
        schema_version: inspection.schemaVersion,
        quick_check: inspection.quickCheck,
        missing_tables: missingTables,
        read_only: true
      }
    );

    check(
      checks,
      "execution-queue-schema",
      "runtime",
      inspection.tableNames.has("execution_queue") ? "pass" : "warning",
      inspection.tableNames.has("execution_queue")
        ? "Execution queue schema is materialized."
        : "Execution queue schema has not been materialized yet; the Gateway creates it on first runtime start.",
      { materialized: inspection.tableNames.has("execution_queue") }
    );

    const operationalFailures = inspection.deadLetterCount + inspection.staleExecutionCount + inspection.queueConsistencyFailures.length;
    check(
      checks,
      "coordination-operational-state",
      "operational",
      operationalFailures === 0 ? "pass" : "fail",
      operationalFailures === 0
        ? "No dead letters, stale executions, or queue/object consistency failures were found."
        : "Coordination operational state contains unresolved failures.",
      {
        dead_letters: inspection.deadLetterCount,
        stale_executions: inspection.staleExecutionCount,
        consistency_failures: inspection.queueConsistencyFailures
      }
    );
    return inspection;
  } catch (error) {
    check(checks, "coordination-database", "structural", "fail", error instanceof Error ? error.message : String(error), { read_only: true });
    check(checks, "coordination-operational-state", "operational", "fail", "Operational state could not be inspected because the coordination database is unavailable.");
    return null;
  }
}

function lifecycleState(checks: ProductionHealthCheck[], setupRequired: boolean, disabled: boolean): ProductionLifecycleState {
  if (setupRequired) return "setup-required";
  if (disabled) return "disabled";
  if (checks.some((item) => item.status === "fail")) return "unhealthy";
  return "ready";
}

function summary(checks: ProductionHealthCheck[]): ProductionHealthReport["summary"] {
  return {
    passed: checks.filter((item) => item.status === "pass").length,
    failed: checks.filter((item) => item.status === "fail").length,
    warnings: checks.filter((item) => item.status === "warning").length,
    not_applicable: checks.filter((item) => item.status === "not_applicable").length,
    delegated: checks.filter((item) => item.status === "delegated").length
  };
}

export function doctorProduction(options: ProductionHealthOptions = {}): ProductionHealthReport {
  const checks: ProductionHealthCheck[] = [];
  const env = options.env ?? process.env as Record<string, string | undefined>;
  packageStructuralChecks(checks);

  let selection: SelectedInstallation | null = null;
  try {
    selection = detectInstallation(options);
  } catch (error) {
    check(checks, "installation-discovery", "attachment", "fail", error instanceof Error ? error.message : String(error));
  }

  if (!selection) {
    check(checks, "installation-discovery", "attachment", "fail", "No standalone or AI-Verse OS Multiple Bots installation is discoverable. Run setup with an explicit mode.");
    check(checks, "runtime-readiness", "runtime", "not_applicable", "Runtime checks require a configured installation.");
    check(checks, "runtime-dependencies", "dependency", "not_applicable", "Dependency checks require a configured installation.");
    check(checks, "operational-readiness", "operational", "not_applicable", "Operational checks require a configured installation.");
    check(checks, "system-composed-readiness", "system/composed", "delegated", "Whole-system readiness is owned by AI-Verse OS/distribution, not Multiple Bots.");
    const state: ProductionLifecycleState = "setup-required";
    return {
      schema_version: PRODUCTION_HEALTH_SCHEMA,
      provider: PRODUCTION_HEALTH_PROVIDER,
      component_id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
      component_version: packageVersion(),
      generated_at: new Date().toISOString(),
      read_only: true,
      mode: null,
      root: null,
      database: null,
      state,
      ready: false,
      checked_depths: ["structural", "attachment"],
      delegated_depths: ["system/composed"],
      checks,
      summary: summary(checks)
    };
  }

  let dbPath: string | null = options.dbPath ? resolve(options.dbPath) : null;
  let setupRequired = false;
  let disabled = false;

  if (selection.mode === "standalone") {
    try {
      const installation = readStandaloneInstallation(selection.root);
      dbPath = dbPath ?? installation.dbPath;
      check(checks, "standalone-attachment", "attachment", "pass", "Standalone configuration is present, safe, and internally contained.", {
        config: installation.configPath,
        gateway_host: installation.config.gateway.host,
        gateway_port: installation.config.gateway.port
      });
    } catch (error) {
      setupRequired = true;
      check(checks, "standalone-attachment", "attachment", "fail", error instanceof Error ? error.message : String(error));
    }
  } else {
    try {
      const plan = planAiVerseOsInstall(selection.root);
      dbPath = dbPath ?? plan.coordination_db_path;
      const entry = plan.current_registration;
      const filesCurrent = plan.files.every((item) => item.state === "current");
      const registered = Boolean(
        entry
        && entry.id === AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID
        && entry.installed === true
        && entry.supported === true
      );
      disabled = registered && entry?.enabled === false;
      setupRequired = !registered || !filesCurrent || plan.database_state !== "present";
      check(
        checks,
        "ai-verse-os-attachment",
        "attachment",
        setupRequired ? "fail" : disabled ? "warning" : "pass",
        setupRequired
          ? "AI-Verse OS attachment is incomplete; setup/install is required."
          : disabled
            ? "AI-Verse OS attachment is structurally current but explicitly disabled."
            : "AI-Verse OS extension files, registration, and coordination database are current.",
        {
          registered,
          enabled: entry?.enabled === true,
          files_current: filesCurrent,
          database_state: plan.database_state,
          conflicts: plan.conflicts
        }
      );
    } catch (error) {
      setupRequired = true;
      check(checks, "ai-verse-os-attachment", "attachment", "fail", error instanceof Error ? error.message : String(error));
    }
  }

  const inspection = dbPath ? databaseChecks(checks, dbPath) : null;
  if (inspection) activeBotRuntimeChecks(checks, inspection, env);
  else {
    check(checks, "active-bot-runtime", "runtime", "fail", "Active Bot runtime readiness could not be inspected.");
    check(checks, "runtime-dependencies", "dependency", "fail", "Runtime dependencies could not be inspected.");
  }

  if (selection.mode === "standalone") {
    check(checks, "system-composed-readiness", "system/composed", "not_applicable", "Standalone mode has no AI-Verse OS composed-system readiness claim.");
  } else {
    check(checks, "system-composed-readiness", "system/composed", "delegated", "Whole-system/composed readiness remains owned by AI-Verse OS/distribution. Multiple Bots reports component evidence only.", {
      canonical_owner: "ai-verse-os/distribution"
    });
  }

  const state = lifecycleState(checks, setupRequired, disabled);
  return {
    schema_version: PRODUCTION_HEALTH_SCHEMA,
    provider: PRODUCTION_HEALTH_PROVIDER,
    component_id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
    component_version: packageVersion(),
    generated_at: new Date().toISOString(),
    read_only: true,
    mode: selection.mode,
    root: selection.root,
    database: dbPath,
    state,
    ready: state === "ready",
    checked_depths: ["structural", "attachment", "runtime", "dependency", "operational"],
    delegated_depths: selection.mode === "ai-verse-os" ? ["system/composed"] : [],
    checks,
    summary: summary(checks)
  };
}

export function statusProduction(options: ProductionHealthOptions = {}): ProductionStatus {
  const report = doctorProduction(options);
  const rootFlag = report.root ? ` --root "${report.root.replace(/"/g, '\\"')}"` : "";
  const modeFlag = report.mode ? ` --mode ${report.mode === "ai-verse-os" ? "os" : "standalone"}` : "";
  return {
    schema_version: PRODUCTION_HEALTH_SCHEMA,
    component_id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
    component_version: report.component_version,
    generated_at: report.generated_at,
    mode: report.mode,
    root: report.root,
    database: report.database,
    state: report.state,
    ready: report.ready,
    failed_checks: report.summary.failed,
    warning_checks: report.summary.warnings,
    doctor_command: `ai-verse-multiple-bots doctor${modeFlag}${rootFlag}`
  };
}
