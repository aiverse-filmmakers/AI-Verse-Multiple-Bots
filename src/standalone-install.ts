import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION } from "./ai-verse-os-registration.js";
import {
  currentStandaloneReceipt,
  readStandaloneReceipt,
  standaloneReceiptPath,
  writeStandaloneReceipt
} from "./standalone-receipt.js";
import { CoordinationStore } from "./store.js";

export const STANDALONE_HOME_DIRECTORY = ".ai-verse-bots";
export const STANDALONE_CONFIG_FILE = "config.json";
export const STANDALONE_CONFIG_SCHEMA_VERSION = "1.0";
export const STANDALONE_COORDINATION_DB = "runtime/coordination.db";
export const STANDALONE_DEFAULT_HOST = "127.0.0.1";
export const STANDALONE_DEFAULT_PORT = 8787;

export interface StandaloneConfig {
  schema_version: typeof STANDALONE_CONFIG_SCHEMA_VERSION;
  mode: "standalone";
  storage: {
    coordination_db: typeof STANDALONE_COORDINATION_DB;
  };
  gateway: {
    host: string;
    port: number;
  };
  [key: string]: unknown;
}

export interface StandaloneInstallPaths {
  root: string;
  home: string;
  configPath: string;
  dbPath: string;
}

export interface StandaloneInstallation extends StandaloneInstallPaths {
  config: StandaloneConfig;
}

export interface StandaloneInitOptions {
  host?: string;
  port?: number;
}

export interface StandaloneInitResult extends StandaloneInstallation {
  status: "initialized" | "unchanged";
  schemaVersion: string;
  componentVersion: string | null;
  receiptPath: string;
  receiptStatus: "created" | "current" | "legacy-unversioned" | "version-mismatch";
}

export interface StandaloneDoctorResult {
  ok: boolean;
  mode: "standalone";
  root: string;
  home: string;
  configPath: string;
  dbPath: string | null;
  schemaVersion: string | null;
  checks: {
    home: boolean;
    config: boolean;
    database: boolean;
    coordination_schema: boolean;
    store_health: boolean;
  };
  code?: string;
  error?: string;
}

export class StandaloneInstallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "StandaloneInstallError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new StandaloneInstallError("INVALID_STANDALONE_PORT", "Standalone gateway port must be an integer between 0 and 65535");
  }
  return port;
}

function assertHost(host: string): string {
  if (!host.trim()) {
    throw new StandaloneInstallError("INVALID_STANDALONE_HOST", "Standalone gateway host must be a non-empty string");
  }
  return host;
}

function assertRootDirectory(root: string, create: boolean): void {
  if (!existsSync(root)) {
    if (!create) {
      throw new StandaloneInstallError("STANDALONE_ROOT_NOT_FOUND", `Standalone root does not exist: ${root}`);
    }
    mkdirSync(root, { recursive: true });
  }
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new StandaloneInstallError("INVALID_STANDALONE_ROOT", `Standalone root must be a real directory, not a symlink: ${root}`);
  }
}

function assertDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new StandaloneInstallError("STANDALONE_INSTALL_NOT_FOUND", `${label} is missing: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new StandaloneInstallError("UNSAFE_STANDALONE_PATH", `${label} must be a real directory, not a symlink: ${path}`);
  }
}

function assertRegularFile(path: string, label: string): void {
  if (!existsSync(path)) throw new StandaloneInstallError("STANDALONE_INSTALL_NOT_FOUND", `${label} is missing: ${path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new StandaloneInstallError("UNSAFE_STANDALONE_PATH", `${label} must be a regular file, not a symlink: ${path}`);
  }
}

function assertInternalPathChain(home: string, relativePath: string, includeLeaf: boolean): void {
  const segments = relativePath.split("/");
  let current = home;
  const last = includeLeaf ? segments.length : Math.max(0, segments.length - 1);
  for (let index = 0; index < last; index += 1) {
    current = resolve(current, segments[index]!);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new StandaloneInstallError(
        "UNSAFE_STANDALONE_PATH",
        `Standalone path must not traverse a symlink: ${relativePath}`
      );
    }
  }
}

function parseConfig(raw: string, configPath: string): StandaloneConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StandaloneInstallError(
      "INVALID_STANDALONE_CONFIG",
      `Standalone config is invalid JSON at ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const config = asRecord(parsed);
  if (!config) {
    throw new StandaloneInstallError("INVALID_STANDALONE_CONFIG", "Standalone config must contain a JSON object");
  }
  if (config.schema_version !== STANDALONE_CONFIG_SCHEMA_VERSION) {
    throw new StandaloneInstallError(
      "UNSUPPORTED_STANDALONE_CONFIG_SCHEMA",
      `Unsupported standalone config schema '${String(config.schema_version ?? "missing")}'`
    );
  }
  if (config.mode !== "standalone") {
    throw new StandaloneInstallError("INVALID_STANDALONE_MODE", "Standalone config mode must be exactly 'standalone'");
  }
  const storage = asRecord(config.storage);
  if (!storage || storage.coordination_db !== STANDALONE_COORDINATION_DB) {
    throw new StandaloneInstallError(
      "INVALID_STANDALONE_STORAGE",
      `Standalone storage.coordination_db must be exactly '${STANDALONE_COORDINATION_DB}'`
    );
  }
  const gateway = asRecord(config.gateway);
  if (!gateway || typeof gateway.host !== "string" || typeof gateway.port !== "number") {
    throw new StandaloneInstallError("INVALID_STANDALONE_GATEWAY", "Standalone gateway requires host and port");
  }
  assertHost(gateway.host);
  assertPort(gateway.port);
  return config as StandaloneConfig;
}

export function standalonePaths(rootInput: string): StandaloneInstallPaths {
  const root = resolve(rootInput);
  const home = resolve(root, STANDALONE_HOME_DIRECTORY);
  return {
    root,
    home,
    configPath: resolve(home, STANDALONE_CONFIG_FILE),
    dbPath: resolve(home, ...STANDALONE_COORDINATION_DB.split("/"))
  };
}

export function findStandaloneRoot(startInput: string): string | null {
  let current = resolve(startInput);
  while (true) {
    const configPath = resolve(current, STANDALONE_HOME_DIRECTORY, STANDALONE_CONFIG_FILE);
    if (existsSync(configPath)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function readStandaloneInstallation(rootInput: string): StandaloneInstallation {
  const paths = standalonePaths(rootInput);
  assertRootDirectory(paths.root, false);
  assertDirectory(paths.home, "Standalone home");
  assertInternalPathChain(paths.home, STANDALONE_CONFIG_FILE, true);
  assertRegularFile(paths.configPath, "Standalone config");
  const config = parseConfig(readFileSync(paths.configPath, "utf8"), paths.configPath);

  const dbPath = resolve(paths.home, ...config.storage.coordination_db.split("/"));
  if (dbPath !== paths.home && !dbPath.startsWith(`${paths.home}${sep}`)) {
    throw new StandaloneInstallError("UNSAFE_STANDALONE_PATH", "Standalone coordination database resolves outside .ai-verse-bots/");
  }
  assertInternalPathChain(paths.home, config.storage.coordination_db, true);

  return { ...paths, dbPath, config };
}

export function initializeStandalone(
  rootInput: string,
  options: StandaloneInitOptions = {}
): StandaloneInitResult {
  const paths = standalonePaths(rootInput);
  assertRootDirectory(paths.root, true);

  if (existsSync(paths.home)) {
    assertDirectory(paths.home, "Standalone home");
  } else {
    mkdirSync(paths.home, { recursive: false });
  }

  const configExisted = existsSync(paths.configPath);
  let config: StandaloneConfig;

  if (configExisted) {
    assertInternalPathChain(paths.home, STANDALONE_CONFIG_FILE, true);
    assertRegularFile(paths.configPath, "Standalone config");
    config = parseConfig(readFileSync(paths.configPath, "utf8"), paths.configPath);
    if (options.host !== undefined && assertHost(options.host) !== config.gateway.host) {
      throw new StandaloneInstallError(
        "STANDALONE_CONFIG_MISMATCH",
        `Existing standalone gateway host is '${config.gateway.host}', not '${options.host}'`
      );
    }
    if (options.port !== undefined && assertPort(options.port) !== config.gateway.port) {
      throw new StandaloneInstallError(
        "STANDALONE_CONFIG_MISMATCH",
        `Existing standalone gateway port is ${config.gateway.port}, not ${options.port}`
      );
    }
  } else {
    config = {
      schema_version: STANDALONE_CONFIG_SCHEMA_VERSION,
      mode: "standalone",
      storage: {
        coordination_db: STANDALONE_COORDINATION_DB
      },
      gateway: {
        host: assertHost(options.host ?? STANDALONE_DEFAULT_HOST),
        port: assertPort(options.port ?? STANDALONE_DEFAULT_PORT)
      }
    };
    writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
  }

  assertInternalPathChain(paths.home, STANDALONE_COORDINATION_DB, true);
  const dbExisted = existsSync(paths.dbPath);
  if (dbExisted) assertRegularFile(paths.dbPath, "Standalone coordination database");

  const store = new CoordinationStore(paths.dbPath);
  try {
    const doctor = store.doctor();
    if (!doctor.ok) {
      throw new StandaloneInstallError("STANDALONE_DATABASE_UNHEALTHY", "Standalone coordination database failed its health check");
    }
    const schemaVersion = store.schemaVersion();
    let receipt = readStandaloneReceipt(paths.home);
    let receiptStatus: StandaloneInitResult["receiptStatus"];
    if (!receipt && (!configExisted || !dbExisted)) {
      writeStandaloneReceipt(paths.home, currentStandaloneReceipt());
      receipt = readStandaloneReceipt(paths.home);
      receiptStatus = "created";
    } else if (!receipt) {
      receiptStatus = "legacy-unversioned";
    } else if (
      receipt.component_version === AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION
      && receipt.coordination_schema === schemaVersion
    ) {
      receiptStatus = "current";
    } else {
      receiptStatus = "version-mismatch";
    }

    return {
      ...paths,
      config,
      status: configExisted && dbExisted ? "unchanged" : "initialized",
      schemaVersion,
      componentVersion: receipt?.component_version ?? null,
      receiptPath: standaloneReceiptPath(paths.home),
      receiptStatus
    };
  } finally {
    store.close();
  }
}

export function doctorStandalone(rootInput: string): StandaloneDoctorResult {
  const paths = standalonePaths(rootInput);
  const checks = {
    home: false,
    config: false,
    database: false,
    coordination_schema: false,
    store_health: false
  };

  try {
    assertRootDirectory(paths.root, false);
    assertDirectory(paths.home, "Standalone home");
    checks.home = true;

    const installation = readStandaloneInstallation(paths.root);
    checks.config = true;

    assertRegularFile(installation.dbPath, "Standalone coordination database");
    checks.database = true;

    const store = new CoordinationStore(installation.dbPath);
    try {
      const storeDoctor = store.doctor();
      const schemaVersion = store.schemaVersion();
      checks.coordination_schema = schemaVersion === "1";
      checks.store_health = storeDoctor.ok;
      return {
        ok: Object.values(checks).every(Boolean),
        mode: "standalone",
        root: paths.root,
        home: paths.home,
        configPath: paths.configPath,
        dbPath: installation.dbPath,
        schemaVersion,
        checks
      };
    } finally {
      store.close();
    }
  } catch (error) {
    return {
      ok: false,
      mode: "standalone",
      root: paths.root,
      home: paths.home,
      configPath: paths.configPath,
      dbPath: existsSync(paths.dbPath) ? paths.dbPath : null,
      schemaVersion: null,
      checks,
      code: error instanceof StandaloneInstallError ? error.code : "STANDALONE_DOCTOR_ERROR",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function standaloneGatewayOptions(rootInput: string): {
  root: string;
  home: string;
  dbPath: string;
  host: string;
  port: number;
} {
  const installation = readStandaloneInstallation(rootInput);
  assertRegularFile(installation.dbPath, "Standalone coordination database");
  return {
    root: installation.root,
    home: installation.home,
    dbPath: installation.dbPath,
    host: installation.config.gateway.host,
    port: installation.config.gateway.port
  };
}
