import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppendedEvent, CoordinationEvent, DeliveryRecord, JsonObject, ProtocolKind, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseObject(value: string): JsonObject {
  return JSON.parse(value) as JsonObject;
}

export class CoordinationStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(dbPath = "runtime/ai-verse-bots/coordination.db") {
    this.dbPath = dbPath === ":memory:" ? dbPath : resolve(dbPath);
    if (this.dbPath !== ":memory:") mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.configure();
    this.migrate();
  }

  private configure(): void {
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');

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
    `);
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): string {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    return row?.value ?? "unknown";
  }

  putObject(kind: ProtocolKind, payload: JsonObject): StoredObject {
    validateProtocolObject(payload, kind);
    const id = String(payload.id);
    const workspaceId = this.extractWorkspaceId(payload);
    const status = typeof payload.status === "string" ? payload.status : null;
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO objects(id, kind, workspace_id, status, payload, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        workspace_id = excluded.workspace_id,
        status = excluded.status,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `).run(id, kind, workspaceId, status, json(payload), timestamp, timestamp);
    return this.getObject(id) as StoredObject;
  }

  getObject(id: string): StoredObject | null {
    const row = this.db.prepare("SELECT * FROM objects WHERE id = ?").get(id) as any;
    return row ? this.rowToObject(row) : null;
  }

  listObjects(kind?: ProtocolKind, workspaceId?: string): StoredObject[] {
    let sql = "SELECT * FROM objects";
    const where: string[] = [];
    const args: unknown[] = [];
    if (kind) {
      where.push("kind = ?");
      args.push(kind);
    }
    if (workspaceId) {
      where.push("workspace_id = ?");
      args.push(workspaceId);
    }
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY created_at, id";
    const rows = this.db.prepare(sql).all(...args) as any[];
    return rows.map((row) => this.rowToObject(row));
  }

  appendEvent(event: CoordinationEvent, idempotencyKey?: string): AppendedEvent {
    validateProtocolObject(event, "event");
    if (idempotencyKey) {
      const prior = this.db.prepare("SELECT result_json FROM idempotency WHERE key = ?").get(idempotencyKey) as { result_json: string } | undefined;
      if (prior) return JSON.parse(prior.result_json) as AppendedEvent;
    }

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      let roomSequence: number | null = null;
      if (event.room_id) {
        this.db.prepare("INSERT OR IGNORE INTO room_sequences(room_id, last_sequence) VALUES (?, 0)").run(event.room_id);
        this.db.prepare("UPDATE room_sequences SET last_sequence = last_sequence + 1 WHERE room_id = ?").run(event.room_id);
        const seqRow = this.db.prepare("SELECT last_sequence FROM room_sequences WHERE room_id = ?").get(event.room_id) as { last_sequence: number };
        roomSequence = Number(seqRow.last_sequence);
      }

      const result = this.db.prepare(`
        INSERT INTO events(
          id, type, timestamp, actor_id, workspace_id, run_id, task_id, room_id, thread_id,
          correlation_id, causation_id, trace_id, room_sequence, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.type,
        event.timestamp,
        event.actor_id,
        event.workspace_id ?? null,
        event.run_id ?? null,
        event.task_id ?? null,
        event.room_id ?? null,
        event.thread_id ?? null,
        event.correlation_id ?? null,
        event.causation_id ?? null,
        event.trace_id ?? null,
        roomSequence,
        json(event)
      ) as { lastInsertRowid: number | bigint };

      const appended: AppendedEvent = {
        sequence: Number(result.lastInsertRowid),
        roomSequence,
        event
      };
      if (idempotencyKey) {
        this.db.prepare("INSERT INTO idempotency(key, operation, result_json, created_at) VALUES (?, ?, ?, ?)")
          .run(idempotencyKey, "appendEvent", json(appended), nowIso());
      }
      this.db.exec("COMMIT;");
      return appended;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  listEventsAfter(sequence = 0, limit = 100): AppendedEvent[] {
    const rows = this.db.prepare("SELECT sequence, room_sequence, payload FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?")
      .all(sequence, limit) as any[];
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      roomSequence: row.room_sequence === null ? null : Number(row.room_sequence),
      event: parseObject(row.payload) as CoordinationEvent
    }));
  }

  enqueueDelivery(delivery: DeliveryRecord): DeliveryRecord {
    const existing = this.db.prepare("SELECT * FROM deliveries WHERE message_id = ?").get(delivery.messageId) as any;
    if (existing) return this.rowToDelivery(existing);
    this.db.prepare(`
      INSERT INTO deliveries(id, message_id, sender_id, target_kind, target_id, workspace_id, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      delivery.id, delivery.messageId, delivery.senderId, delivery.targetKind, delivery.targetId,
      delivery.workspaceId, delivery.state, delivery.createdAt, delivery.updatedAt
    );
    return delivery;
  }

  updateDeliveryState(messageId: string, state: DeliveryRecord["state"]): DeliveryRecord {
    const updatedAt = nowIso();
    const result = this.db.prepare("UPDATE deliveries SET state = ?, updated_at = ? WHERE message_id = ?")
      .run(state, updatedAt, messageId) as { changes: number | bigint };
    if (Number(result.changes) !== 1) throw new Error(`Delivery not found for message ${messageId}`);
    const row = this.db.prepare("SELECT * FROM deliveries WHERE message_id = ?").get(messageId) as any;
    return this.rowToDelivery(row);
  }

  listMailbox(targetId: string, states: DeliveryRecord["state"][] = ["queued", "accepted", "delivered", "processing"]): DeliveryRecord[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT * FROM deliveries WHERE target_id = ? AND state IN (${placeholders}) ORDER BY created_at`)
      .all(targetId, ...states) as any[];
    return rows.map((row) => this.rowToDelivery(row));
  }

  doctor(): { ok: boolean; schemaVersion: string; checks: Record<string, boolean> } {
    const checks: Record<string, boolean> = {};
    checks.schema = this.schemaVersion() === "1";
    checks.objects = Boolean(this.db.prepare("SELECT 1 AS ok FROM objects LIMIT 1").get() ?? { ok: 1 });
    checks.events = Boolean(this.db.prepare("SELECT 1 AS ok FROM events LIMIT 1").get() ?? { ok: 1 });
    checks.deliveries = Boolean(this.db.prepare("SELECT 1 AS ok FROM deliveries LIMIT 1").get() ?? { ok: 1 });
    return { ok: Object.values(checks).every(Boolean), schemaVersion: this.schemaVersion(), checks };
  }

  private extractWorkspaceId(payload: JsonObject): string | null {
    if (typeof payload.workspace_id === "string") return payload.workspace_id;
    const scope = payload.scope;
    if (typeof scope === "object" && scope !== null && !Array.isArray(scope)) {
      const workspaceId = (scope as JsonObject).workspace_id;
      if (typeof workspaceId === "string") return workspaceId;
    }
    return null;
  }

  private rowToObject(row: any): StoredObject {
    return {
      id: String(row.id),
      kind: row.kind as ProtocolKind,
      workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
      status: row.status === null ? null : String(row.status),
      payload: parseObject(String(row.payload)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private rowToDelivery(row: any): DeliveryRecord {
    return {
      id: String(row.id),
      messageId: String(row.message_id),
      senderId: String(row.sender_id),
      targetKind: String(row.target_kind),
      targetId: String(row.target_id),
      workspaceId: String(row.workspace_id),
      state: row.state as DeliveryRecord["state"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }
}
