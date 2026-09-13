import { existsSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION } from "./ai-verse-os-registration.js";
import {
  currentStandaloneReceipt,
  readStandaloneReceipt,
  standaloneReceiptPath,
  writeStandaloneReceipt
} from "./standalone-receipt.js";
import { readStandaloneInstallation } from "./standalone-install.js";
import { COORDINATION_SCHEMA_VERSION } from "./store.js";
import { versionOrder, type VersionOrder } from "./versioning.js";

export interface StandaloneUpdatePlan {
  mode: "standalone";
  root: string;
  home: string;
  config_path: string;
  database: string;
  receipt_path: string;
  installed_version: string | null;
  installed_version_state: VersionOrder | "legacy-unversioned";
  target_version: string;
  coordination_schema: {
    installed: string | null;
    target: typeof COORDINATION_SCHEMA_VERSION;
    quick_check: string;
  };
  update_required: boolean;
  migration_required: boolean;
  migration_supported: boolean;
  can_update: boolean;
  blocked_reason: string | null;
  actions: string[];
  preserves_coordination_state: true;
  preserves_config: true;
}

export interface StandaloneUpdateResult extends StandaloneUpdatePlan {
  status: "unchanged" | "adopted" | "updated";
  previous_version: string | null;
  receipt_written: boolean;
}

export class StandaloneUpdateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "StandaloneUpdateError";
  }
}

function inspectSchema(dbPath: string): { schema: string | null; quickCheck: string } {
  if (!existsSync(dbPath)) {
    throw new StandaloneUpdateError("COORDINATION_DATABASE_MISSING", `Standalone coordination database is missing: ${dbPath}`);
  }
  const stat = lstatSync(dbPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new StandaloneUpdateError(
      "INVALID_COORDINATION_DATABASE_PATH",
      `Standalone coordination database must be a regular file: ${dbPath}`
    );
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map((row) => String(row.name)));
    const row = names.has("meta")
      ? db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined
      : undefined;
    const quick = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    return {
      schema: row?.value ? String(row.value) : null,
      quickCheck: quick ? String(Object.values(quick)[0] ?? "unknown") : "unknown"
    };
  } finally {
    db.close();
  }
}

export function planStandaloneUpdate(rootInput: string): StandaloneUpdatePlan {
  const installation = readStandaloneInstallation(rootInput);
  const receipt = readStandaloneReceipt(installation.home);
  const inspection = inspectSchema(installation.dbPath);
  const installedVersionState = receipt
    ? versionOrder(receipt.component_version, AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION)
    : "legacy-unversioned";
  const migrationRequired = inspection.schema !== COORDINATION_SCHEMA_VERSION;
  const receiptSchemaDrift = Boolean(receipt && receipt.coordination_schema !== inspection.schema);
  const downgradeBlocked = installedVersionState === "newer";
  const quickCheckFailed = inspection.quickCheck !== "ok";

  let blockedReason: string | null = null;
  if (quickCheckFailed) blockedReason = "coordination database integrity check failed";
  else if (receiptSchemaDrift) blockedReason = "standalone install receipt coordination schema does not match the database";
  else if (migrationRequired) blockedReason = `coordination schema '${String(inspection.schema ?? "missing")}' requires an explicit migration before update`;
  else if (downgradeBlocked) blockedReason = "installed standalone receipt is newer than this package; downgrade requires a separate rollback flow";

  const updateRequired = installedVersionState !== "same";
  const canUpdate = blockedReason === null;
  const actions: string[] = [];
  if (canUpdate && updateRequired) {
    actions.push(receipt ? "update-install-receipt" : "adopt-legacy-installation-receipt");
  }

  return {
    mode: "standalone",
    root: installation.root,
    home: installation.home,
    config_path: installation.configPath,
    database: installation.dbPath,
    receipt_path: standaloneReceiptPath(installation.home),
    installed_version: receipt?.component_version ?? null,
    installed_version_state: installedVersionState,
    target_version: AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION,
    coordination_schema: {
      installed: inspection.schema,
      target: COORDINATION_SCHEMA_VERSION,
      quick_check: inspection.quickCheck
    },
    update_required: updateRequired,
    migration_required: migrationRequired,
    migration_supported: !migrationRequired,
    can_update: canUpdate,
    blocked_reason: blockedReason,
    actions,
    preserves_coordination_state: true,
    preserves_config: true
  };
}

export function updateStandaloneInstallation(rootInput: string): StandaloneUpdateResult {
  const plan = planStandaloneUpdate(rootInput);
  if (!plan.can_update) {
    const code = plan.migration_required
      ? "MIGRATION_REQUIRED"
      : plan.installed_version_state === "newer"
        ? "DOWNGRADE_REQUIRES_ROLLBACK"
        : "STANDALONE_UPDATE_BLOCKED";
    throw new StandaloneUpdateError(code, plan.blocked_reason ?? "Standalone update is blocked");
  }
  if (!plan.update_required) {
    return {
      ...plan,
      status: "unchanged",
      previous_version: plan.installed_version,
      receipt_written: false
    };
  }

  const installation = readStandaloneInstallation(plan.root);
  const existing = readStandaloneReceipt(installation.home);
  writeStandaloneReceipt(installation.home, currentStandaloneReceipt(existing));
  const finalPlan = planStandaloneUpdate(plan.root);
  if (!finalPlan.can_update || finalPlan.update_required) {
    throw new StandaloneUpdateError(
      "STANDALONE_UPDATE_VERIFICATION_FAILED",
      "Standalone update receipt did not converge to the current package state"
    );
  }

  return {
    ...finalPlan,
    status: plan.installed_version === null ? "adopted" : "updated",
    previous_version: plan.installed_version,
    receipt_written: true
  };
}
