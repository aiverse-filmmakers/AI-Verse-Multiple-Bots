import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID, AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION } from "./ai-verse-os-registration.js";
import { COORDINATION_SCHEMA_VERSION } from "./store.js";
import { parseVersion } from "./versioning.js";

export const STANDALONE_INSTALL_RECEIPT_FILE = "install.json";
export const STANDALONE_INSTALL_RECEIPT_SCHEMA = "1.0";

export interface StandaloneInstallReceipt {
  schema_version: typeof STANDALONE_INSTALL_RECEIPT_SCHEMA;
  component_id: typeof AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID;
  component_version: string;
  coordination_schema: string;
  mode: "standalone";
  [key: string]: unknown;
}

export class StandaloneReceiptError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "StandaloneReceiptError";
  }
}

export function standaloneReceiptPath(home: string): string {
  return resolve(home, STANDALONE_INSTALL_RECEIPT_FILE);
}

function assertRegularReceipt(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new StandaloneReceiptError(
      "UNSAFE_STANDALONE_RECEIPT",
      `Standalone install receipt must be a regular file: ${path}`
    );
  }
}

function parseReceipt(raw: string, path: string): StandaloneInstallReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StandaloneReceiptError(
      "INVALID_STANDALONE_RECEIPT",
      `Standalone install receipt is invalid JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StandaloneReceiptError("INVALID_STANDALONE_RECEIPT", "Standalone install receipt must be a JSON object");
  }
  const receipt = parsed as Record<string, unknown>;
  if (receipt.schema_version !== STANDALONE_INSTALL_RECEIPT_SCHEMA) {
    throw new StandaloneReceiptError(
      "UNSUPPORTED_STANDALONE_RECEIPT_SCHEMA",
      `Unsupported standalone install receipt schema '${String(receipt.schema_version ?? "missing")}'`
    );
  }
  if (receipt.component_id !== AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID || receipt.mode !== "standalone") {
    throw new StandaloneReceiptError(
      "STANDALONE_RECEIPT_OWNERSHIP_MISMATCH",
      "Standalone install receipt is not owned by AI-Verse Multiple Bots"
    );
  }
  if (typeof receipt.component_version !== "string" || !receipt.component_version.trim()) {
    throw new StandaloneReceiptError("INVALID_STANDALONE_RECEIPT", "Standalone install receipt has no component version");
  }
  try {
    parseVersion(receipt.component_version);
  } catch (error) {
    throw new StandaloneReceiptError(
      "INVALID_STANDALONE_RECEIPT_VERSION",
      error instanceof Error ? error.message : String(error)
    );
  }
  if (typeof receipt.coordination_schema !== "string" || !receipt.coordination_schema.trim()) {
    throw new StandaloneReceiptError("INVALID_STANDALONE_RECEIPT", "Standalone install receipt has no coordination schema");
  }
  return receipt as StandaloneInstallReceipt;
}

export function readStandaloneReceipt(home: string): StandaloneInstallReceipt | null {
  const path = standaloneReceiptPath(home);
  if (!existsSync(path)) return null;
  assertRegularReceipt(path);
  return parseReceipt(readFileSync(path, "utf8"), path);
}

export function currentStandaloneReceipt(existing: StandaloneInstallReceipt | null = null): StandaloneInstallReceipt {
  return {
    ...(existing ?? {}),
    schema_version: STANDALONE_INSTALL_RECEIPT_SCHEMA,
    component_id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
    component_version: AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION,
    coordination_schema: COORDINATION_SCHEMA_VERSION,
    mode: "standalone"
  };
}

export function writeStandaloneReceipt(home: string, receipt: StandaloneInstallReceipt): string {
  const path = standaloneReceiptPath(home);
  assertRegularReceipt(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  rmSync(temporary, { force: true });
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    renameSync(temporary, path);
    return path;
  } finally {
    rmSync(temporary, { force: true });
  }
}
