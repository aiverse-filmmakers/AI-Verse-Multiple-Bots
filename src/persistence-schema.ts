import { DatabaseSync } from "node:sqlite";

export const PERSISTENCE_SCHEMA_VERSION = 2;

export interface SchemaMigrationRecord {
  version: number;
  name: string;
  appliedAt: string;
}

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "core-coordination-tables",
    sql: `
      CREATE TABLE IF NOT EXISTS objects (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        workspace_id TEXT,
        status TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_objects_kind_workspace ON objects(kind, workspace_id);
      CREATE INDEX IF NOT EXISTS idx_objects_status ON objects(kind, status);

      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        workspace_id TEXT,
        run_id TEXT,
        task_id TEXT,
        room_id TEXT,
        thread_id TEXT,
        correlation_id TEXT,
        causation_id TEXT,
        trace_id TEXT,
        room_sequence INTEGER,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_workspace_sequence ON events(workspace_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_room_sequence ON events(room_id, room_sequence);
      CREATE INDEX IF NOT EXISTS idx_events_run_sequence ON events(run_id, sequence);

      CREATE TABLE IF NOT EXISTS room_sequences (
        room_id TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE,
        sender_id TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_target_state ON deliveries(target_id, state, created_at);

      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `
  },
  {
    version: 2,
    name: "protocol-relation-views",
    sql: `
      CREATE VIEW IF NOT EXISTS bots AS
        SELECT id, workspace_id, status, payload, created_at, updated_at FROM objects WHERE kind = 'bot';
      CREATE VIEW IF NOT EXISTS workers AS
        SELECT id, workspace_id, status, payload, created_at, updated_at FROM objects WHERE kind = 'worker';
      CREATE VIEW IF NOT EXISTS rooms AS
        SELECT id, workspace_id, status, payload, created_at, updated_at FROM objects WHERE kind = 'room';
      CREATE VIEW IF NOT EXISTS threads AS
        SELECT id, workspace_id, status, payload, created_at, updated_at FROM objects WHERE kind = 'thread';
      CREATE VIEW IF NOT EXISTS messages AS
        SELECT id, workspace_id, status, payload, created_at, updated_at FROM objects WHERE kind = 'message';
      CREATE VIEW IF NOT EXISTS tasks AS
        SELECT id, workspace_id, status, payload, created_at, updated_at FROM objects WHERE kind = 'task';
      CREATE VIEW IF NOT EXISTS handoffs AS
        SELECT id, workspace_id, status, payload, created_at, updated_at FROM objects WHERE kind = 'handoff';
      CREATE VIEW IF NOT EXISTS team_runs AS
        SELECT id, workspace_id, status, payload, created_at, updated_at FROM objects WHERE kind = 'team_run';
      CREATE VIEW IF NOT EXISTS artifacts AS
        SELECT id, workspace_id, status, payload, created_at, updated_at FROM objects WHERE kind = 'artifact';
      CREATE VIEW IF NOT EXISTS approvals AS
        SELECT id, workspace_id, status, payload, created_at, updated_at FROM objects WHERE kind = 'approval';
      CREATE VIEW IF NOT EXISTS capability_leases AS
        SELECT id, workspace_id, status, payload, created_at, updated_at FROM objects WHERE kind = 'capability_lease';
      CREATE VIEW IF NOT EXISTS environment_leases AS
        SELECT id, workspace_id, status, payload, created_at, updated_at FROM objects WHERE kind = 'environment_lease';
      CREATE VIEW IF NOT EXISTS delivery_queue AS
        SELECT id, message_id, sender_id, target_kind, target_id, workspace_id, state, created_at, updated_at FROM deliveries;
    `
  }
];

export const PERSISTENCE_RELATIONS = [
  "objects",
  "bots",
  "workers",
  "rooms",
  "threads",
  "messages",
  "tasks",
  "handoffs",
  "team_runs",
  "artifacts",
  "approvals",
  "capability_leases",
  "environment_leases",
  "events",
  "deliveries",
  "delivery_queue",
  "idempotency"
] as const;

function nowIso(): string {
  return new Date().toISOString();
}

function readCurrentVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  if (!row) return 0;
  const version = Number(row.value);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`Invalid coordination schema version: ${row.value}`);
  }
  return version;
}

function recordAppliedMigration(db: DatabaseSync, migration: Migration, appliedAt = nowIso()): void {
  db.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (?, ?, ?)
  `).run(migration.version, migration.name, appliedAt);
}

export function applyPersistenceMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  let currentVersion = readCurrentVersion(db);
  if (currentVersion > PERSISTENCE_SCHEMA_VERSION) {
    throw new Error(
      `Coordination database schema ${currentVersion} is newer than supported schema ${PERSISTENCE_SCHEMA_VERSION}`
    );
  }

  // Existing v1 databases predate schema_migrations. Backfill their known history without rewriting state.
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) recordAppliedMigration(db, migration);
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(migration.sql);
      db.prepare(`
        INSERT INTO meta(key, value) VALUES ('schema_version', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(String(migration.version));
      recordAppliedMigration(db, migration);
      db.exec("COMMIT;");
      currentVersion = migration.version;
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }
}

export function listSchemaMigrations(db: DatabaseSync): SchemaMigrationRecord[] {
  const rows = db.prepare(`
    SELECT version, name, applied_at FROM schema_migrations ORDER BY version
  `).all() as Array<{ version: number; name: string; applied_at: string }>;
  return rows.map((row) => ({
    version: Number(row.version),
    name: String(row.name),
    appliedAt: String(row.applied_at)
  }));
}

export function listSchemaRelations(db: DatabaseSync): string[] {
  const rows = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  return rows.map((row) => String(row.name));
}
