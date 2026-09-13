import { existsSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { COORDINATION_SCHEMA_VERSION } from "./store.js";

export interface CoordinationMigrationAssessment {
  database: string;
  installed_schema: string | null;
  target_schema: typeof COORDINATION_SCHEMA_VERSION;
  quick_check: string;
  migration_required: boolean;
  migration_supported: boolean;
  can_use_current_package: boolean;
  blocked_reason: string | null;
}

export class CoordinationMigrationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CoordinationMigrationError";
  }
}

export function assessCoordinationMigration(dbPath: string): CoordinationMigrationAssessment {
  if (!existsSync(dbPath)) {
    throw new CoordinationMigrationError("COORDINATION_DATABASE_MISSING", `Coordination database is missing: ${dbPath}`);
  }
  const stat = lstatSync(dbPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CoordinationMigrationError(
      "INVALID_COORDINATION_DATABASE_PATH",
      `Coordination database must be a regular file: ${dbPath}`
    );
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const names = new Set(tables.map((row) => String(row.name)));
    const schemaRow = names.has("meta")
      ? db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined
      : undefined;
    const quickRow = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    const installedSchema = schemaRow?.value ? String(schemaRow.value) : null;
    const quickCheck = quickRow ? String(Object.values(quickRow)[0] ?? "unknown") : "unknown";
    const migrationRequired = installedSchema !== COORDINATION_SCHEMA_VERSION;
    const migrationSupported = !migrationRequired;
    const blockedReason = quickCheck !== "ok"
      ? "coordination database integrity check failed"
      : migrationRequired
        ? `coordination schema '${String(installedSchema ?? "missing")}' has no registered migration path to '${COORDINATION_SCHEMA_VERSION}'`
        : null;

    return {
      database: dbPath,
      installed_schema: installedSchema,
      target_schema: COORDINATION_SCHEMA_VERSION,
      quick_check: quickCheck,
      migration_required: migrationRequired,
      migration_supported: migrationSupported,
      can_use_current_package: blockedReason === null,
      blocked_reason: blockedReason
    };
  } finally {
    db.close();
  }
}
