import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppendedEvent, CoordinationEvent, DeliveryRecord, DeliveryState, JsonObject, ProtocolKind, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";
import {
  PERSISTENCE_RELATIONS,
  PERSISTENCE_SCHEMA_VERSION,
  applyPersistenceMigrations,
  listSchemaMigrations,
  listSchemaRelations,
  type SchemaMigrationRecord
} from "./persistence-schema.js";

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, stableValue(object[key])]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function parseObject(value: string): JsonObject {
  return JSON.parse(value) as JsonObject;
}

export interface AtomicMutationObject {
  kind: ProtocolKind;
  payload: JsonObject;
}

export interface AtomicMutationPrecondition {
  id: string;
  kind: ProtocolKind;
  status?: string;
  ownerId?: string;
}

export interface AtomicQueueRetarget {
  itemId: string;
  fromTargetId: string;
  toTargetId: string;
  required?: boolean;
}

export interface AtomicQueueTransition {
  itemId: string;
  fromStates: string[];
  toState: string;
  expectedClaimedBy?: string | null;
  expectedLeaseExpiresAt?: string | null;
  clearClaim?: boolean;
  lastError?: string | null;
  required?: boolean;
}

export interface AtomicDeliveryTransition {
  messageId: string;
  targetId: string;
  fromStates: DeliveryState[];
  toState: DeliveryState;
  updatedAt: string;
}

export interface AtomicMutationInput {
  preconditions?: AtomicMutationPrecondition[];
  objects: AtomicMutationObject[];
  events: CoordinationEvent[];
  queueRetarget?: AtomicQueueRetarget;
  queueTransition?: AtomicQueueTransition;
  deliveryInsert?: DeliveryRecord;
  deliveryTransition?: AtomicDeliveryTransition;
}

export interface AtomicMutationResult {
  objects: StoredObject[];
  events: AppendedEvent[];
}

export class CoordinationStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(dbPath = "runtime/ai-verse-bots/coordination.db") {
    this.dbPath = dbPath === ":memory:" ? dbPath : resolve(dbPath);
    if (this.dbPath !== ":memory:") mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.configure();
    try {
      applyPersistenceMigrations(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private configure(): void {
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
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
    this.writeObject(kind, payload, nowIso());
    return this.getObject(String(payload.id)) as StoredObject;
  }

  getObject(id: string): StoredObject | null {
    const row = this.db.prepare("SELECT * FROM objects WHERE id = ?").get(id) as any;
    return row ? this.rowToObject(row) : null;
  }

  getEventById(id: string): AppendedEvent | null {
    const row = this.db.prepare("SELECT sequence, room_sequence, run_sequence, payload FROM events WHERE id = ?").get(id) as any;
    return row ? this.rowToEvent(row) : null;
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

    const existingById = this.getEventById(event.id);
    if (existingById) {
      if (stableJson(existingById.event) !== stableJson(event)) {
        throw new Error(`Event ID ${event.id} already exists with different payload`);
      }
      return existingById;
    }

    if (idempotencyKey) {
      const prior = this.db.prepare("SELECT result_json FROM idempotency WHERE key = ?").get(idempotencyKey) as { result_json: string } | undefined;
      if (prior) {
        const replay = JSON.parse(prior.result_json) as AppendedEvent;
        const stored = replay.event?.id ? this.getEventById(replay.event.id) : null;
        return stored ?? { ...replay, runSequence: replay.runSequence ?? null };
      }
    }

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const appended = this.writeEvent(event);
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

  atomicMutation(input: AtomicMutationInput): AtomicMutationResult {
    for (const object of input.objects) validateProtocolObject(object.payload, object.kind);
    for (const event of input.events) validateProtocolObject(event, "event");

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      for (const precondition of input.preconditions ?? []) {
        const row = this.db.prepare("SELECT kind, status, payload FROM objects WHERE id = ?").get(precondition.id) as any;
        if (!row) throw new Error(`Atomic precondition failed: object ${precondition.id} not found`);
        if (String(row.kind) !== precondition.kind) {
          throw new Error(`Atomic precondition failed: ${precondition.id} is ${String(row.kind)}, expected ${precondition.kind}`);
        }
        if (precondition.status !== undefined && String(row.status) !== precondition.status) {
          throw new Error(`Atomic precondition failed: ${precondition.id} status is ${String(row.status)}, expected ${precondition.status}`);
        }
        if (precondition.ownerId !== undefined) {
          const payload = parseObject(String(row.payload));
          if (String(payload.owner_id) !== precondition.ownerId) {
            throw new Error(`Atomic precondition failed: ${precondition.id} owner is ${String(payload.owner_id)}, expected ${precondition.ownerId}`);
          }
        }
      }

      if (input.queueRetarget) this.retargetQueueInTransaction(input.queueRetarget);
      if (input.queueTransition) this.transitionQueueInTransaction(input.queueTransition);
      if (input.deliveryInsert) this.insertDeliveryInTransaction(input.deliveryInsert);
      if (input.deliveryTransition) this.transitionDeliveryInTransaction(input.deliveryTransition);

      const timestamp = nowIso();
      for (const object of input.objects) this.writeObject(object.kind, object.payload, timestamp);
      const appendedEvents = input.events.map((event) => this.writeEvent(event));

      this.db.exec("COMMIT;");
      return {
        objects: input.objects.map((object) => this.getObject(String(object.payload.id)) as StoredObject),
        events: appendedEvents
      };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  listEventsAfter(sequence = 0, limit = 100): AppendedEvent[] {
    const rows = this.db.prepare("SELECT sequence, room_sequence, run_sequence, payload FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?")
      .all(sequence, limit) as any[];
    return rows.map((row) => this.rowToEvent(row));
  }

  listRoomEvents(roomId: string, afterRoomSequence = 0, limit = 100, threadId?: string): AppendedEvent[] {
    let sql = `
      SELECT sequence, room_sequence, run_sequence, payload FROM events
      WHERE room_id = ? AND room_sequence > ?
    `;
    const args: unknown[] = [roomId, afterRoomSequence];
    if (threadId) {
      sql += " AND thread_id = ?";
      args.push(threadId);
    }
    sql += " ORDER BY room_sequence LIMIT ?";
    args.push(limit);
    const rows = this.db.prepare(sql).all(...args) as any[];
    return rows.map((row) => this.rowToEvent(row));
  }

  listRunEvents(runId: string, afterRunSequence = 0, limit = 100): AppendedEvent[] {
    const rows = this.db.prepare(`
      SELECT sequence, room_sequence, run_sequence, payload FROM events
      WHERE run_id = ? AND run_sequence > ?
      ORDER BY run_sequence LIMIT ?
    `).all(runId, afterRunSequence, limit) as any[];
    return rows.map((row) => this.rowToEvent(row));
  }

  listCorrelationEvents(correlationId: string, afterSequence = 0, limit = 100): AppendedEvent[] {
    const rows = this.db.prepare(`
      SELECT sequence, room_sequence, run_sequence, payload FROM events
      WHERE correlation_id = ? AND sequence > ?
      ORDER BY sequence LIMIT ?
    `).all(correlationId, afterSequence, limit) as any[];
    return rows.map((row) => this.rowToEvent(row));
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

  getDelivery(messageId: string): DeliveryRecord | null {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE message_id = ?").get(messageId) as any;
    return row ? this.rowToDelivery(row) : null;
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

  schemaMigrations(): SchemaMigrationRecord[] {
    return listSchemaMigrations(this.db);
  }

  schemaRelations(): string[] {
    return listSchemaRelations(this.db);
  }

  doctor(): { ok: boolean; schemaVersion: string; checks: Record<string, boolean> } {
    const checks: Record<string, boolean> = {};
    checks.schema = this.schemaVersion() === String(PERSISTENCE_SCHEMA_VERSION);
    checks.objects = Boolean(this.db.prepare("SELECT 1 AS ok FROM objects LIMIT 1").get() ?? { ok: 1 });
    checks.events = Boolean(this.db.prepare("SELECT 1 AS ok FROM events LIMIT 1").get() ?? { ok: 1 });
    checks.deliveries = Boolean(this.db.prepare("SELECT 1 AS ok FROM deliveries LIMIT 1").get() ?? { ok: 1 });
    const relations = new Set(this.schemaRelations());
    for (const relation of PERSISTENCE_RELATIONS) checks[`relation:${relation}`] = relations.has(relation);
    return { ok: Object.values(checks).every(Boolean), schemaVersion: this.schemaVersion(), checks };
  }

  private writeObject(kind: ProtocolKind, payload: JsonObject, timestamp: string): void {
    const id = String(payload.id);
    const workspaceId = this.extractWorkspaceId(payload);
    const status = typeof payload.status === "string" ? payload.status : null;
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
  }

  private writeEvent(event: CoordinationEvent): AppendedEvent {
    let roomSequence: number | null = null;
    let runSequence: number | null = null;
    if (event.room_id) {
      this.db.prepare("INSERT OR IGNORE INTO room_sequences(room_id, last_sequence) VALUES (?, 0)").run(event.room_id);
      this.db.prepare("UPDATE room_sequences SET last_sequence = last_sequence + 1 WHERE room_id = ?").run(event.room_id);
      const seqRow = this.db.prepare("SELECT last_sequence FROM room_sequences WHERE room_id = ?").get(event.room_id) as { last_sequence: number };
      roomSequence = Number(seqRow.last_sequence);
    }

    if (event.run_id) {
      this.db.prepare("INSERT OR IGNORE INTO run_sequences(run_id, last_sequence) VALUES (?, 0)").run(event.run_id);
      this.db.prepare("UPDATE run_sequences SET last_sequence = last_sequence + 1 WHERE run_id = ?").run(event.run_id);
      const seqRow = this.db.prepare("SELECT last_sequence FROM run_sequences WHERE run_id = ?").get(event.run_id) as { last_sequence: number };
      runSequence = Number(seqRow.last_sequence);
    }

    const result = this.db.prepare(`
      INSERT INTO events(
        id, type, timestamp, actor_id, workspace_id, run_id, task_id, room_id, thread_id,
        correlation_id, causation_id, trace_id, room_sequence, run_sequence, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      runSequence,
      json(event)
    ) as { lastInsertRowid: number | bigint };

    return {
      sequence: Number(result.lastInsertRowid),
      roomSequence,
      runSequence,
      event
    };
  }

  private queueTableAvailable(): boolean {
    const table = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_queue'").get() as { name: string } | undefined;
    return Boolean(table);
  }

  private retargetQueueInTransaction(input: AtomicQueueRetarget): void {
    if (!this.queueTableAvailable()) {
      if (input.required) throw new Error("Atomic queue retarget required but execution_queue table is not available in this database connection");
      return;
    }
    const row = this.db.prepare("SELECT target_id, state FROM execution_queue WHERE item_id = ?").get(input.itemId) as any;
    if (!row) {
      if (input.required) throw new Error(`Execution queue item for ${input.itemId} not found`);
      return;
    }
    if (String(row.state) !== "queued") {
      throw new Error(`Cannot hand off ${input.itemId} while execution state is ${String(row.state)}; only queued work can be retargeted atomically`);
    }
    if (String(row.target_id) !== input.fromTargetId) {
      throw new Error(`Execution queue target for ${input.itemId} is ${String(row.target_id)}, expected ${input.fromTargetId}`);
    }
    const result = this.db.prepare(`
      UPDATE execution_queue
      SET target_id = ?, claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
          lease_expires_at = NULL, updated_at = ?
      WHERE item_id = ? AND target_id = ? AND state = 'queued'
    `).run(input.toTargetId, nowIso(), input.itemId, input.fromTargetId) as { changes: number | bigint };
    if (Number(result.changes) !== 1) throw new Error(`Atomic queue retarget lost for ${input.itemId}`);
  }

  private transitionQueueInTransaction(input: AtomicQueueTransition): void {
    if (!this.queueTableAvailable()) {
      if (input.required) throw new Error("Atomic queue transition required but execution_queue table is not available in this database connection");
      return;
    }
    if (input.fromStates.length === 0) throw new Error("Atomic queue transition requires at least one source state");

    const row = this.db.prepare(`
      SELECT state, claimed_by, lease_expires_at FROM execution_queue WHERE item_id = ?
    `).get(input.itemId) as any;
    if (!row) {
      if (input.required) throw new Error(`Execution queue item for ${input.itemId} not found`);
      return;
    }

    const currentState = String(row.state);
    if (!input.fromStates.includes(currentState)) {
      throw new Error(`Execution queue state for ${input.itemId} is ${currentState}, expected one of ${input.fromStates.join(", ")}`);
    }
    const claimedBy = row.claimed_by === null ? null : String(row.claimed_by);
    const leaseExpiresAt = row.lease_expires_at === null ? null : String(row.lease_expires_at);
    if (input.expectedClaimedBy !== undefined && claimedBy !== input.expectedClaimedBy) {
      throw new Error(`Execution queue owner for ${input.itemId} is ${String(claimedBy)}, expected ${String(input.expectedClaimedBy)}`);
    }
    if (input.expectedLeaseExpiresAt !== undefined && leaseExpiresAt !== input.expectedLeaseExpiresAt) {
      throw new Error(`Execution queue lease for ${input.itemId} changed before atomic transition`);
    }

    const timestamp = nowIso();
    const clearClaim = input.clearClaim === true;
    const result = this.db.prepare(`
      UPDATE execution_queue
      SET state = ?,
          claimed_by = CASE WHEN ? THEN NULL ELSE claimed_by END,
          claimed_at = CASE WHEN ? THEN NULL ELSE claimed_at END,
          heartbeat_at = CASE WHEN ? THEN NULL ELSE heartbeat_at END,
          lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END,
          last_error = ?,
          updated_at = ?
      WHERE item_id = ? AND state = ?
    `).run(
      input.toState,
      clearClaim ? 1 : 0,
      clearClaim ? 1 : 0,
      clearClaim ? 1 : 0,
      clearClaim ? 1 : 0,
      input.lastError ?? null,
      timestamp,
      input.itemId,
      currentState
    ) as { changes: number | bigint };
    if (Number(result.changes) !== 1) throw new Error(`Atomic queue transition lost for ${input.itemId}`);
  }

  private insertDeliveryInTransaction(delivery: DeliveryRecord): void {
    const existing = this.db.prepare("SELECT id FROM deliveries WHERE message_id = ?").get(delivery.messageId) as any;
    if (existing) throw new Error(`Delivery already exists for message ${delivery.messageId}`);
    this.db.prepare(`
      INSERT INTO deliveries(id, message_id, sender_id, target_kind, target_id, workspace_id, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      delivery.id,
      delivery.messageId,
      delivery.senderId,
      delivery.targetKind,
      delivery.targetId,
      delivery.workspaceId,
      delivery.state,
      delivery.createdAt,
      delivery.updatedAt
    );
  }

  private transitionDeliveryInTransaction(input: AtomicDeliveryTransition): void {
    if (input.fromStates.length === 0) throw new Error("Atomic delivery transition requires a source state");
    const row = this.db.prepare("SELECT target_id, state FROM deliveries WHERE message_id = ?").get(input.messageId) as any;
    if (!row) throw new Error(`Delivery not found for message ${input.messageId}`);
    const currentState = String(row.state) as DeliveryState;
    if (String(row.target_id) !== input.targetId) {
      throw new Error(`Delivery target for ${input.messageId} is ${String(row.target_id)}, expected ${input.targetId}`);
    }
    if (!input.fromStates.includes(currentState)) {
      throw new Error(`Delivery state for ${input.messageId} is ${currentState}, expected one of ${input.fromStates.join(", ")}`);
    }
    const result = this.db.prepare(
      "UPDATE deliveries SET state = ?, updated_at = ? WHERE message_id = ? AND target_id = ? AND state = ?"
    ).run(input.toState, input.updatedAt, input.messageId, input.targetId, currentState) as { changes: number | bigint };
    if (Number(result.changes) !== 1) throw new Error(`Atomic delivery transition lost for ${input.messageId}`);
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

  private rowToEvent(row: any): AppendedEvent {
    return {
      sequence: Number(row.sequence),
      roomSequence: row.room_sequence === null ? null : Number(row.room_sequence),
      runSequence: row.run_sequence === null || row.run_sequence === undefined ? null : Number(row.run_sequence),
      event: parseObject(String(row.payload)) as CoordinationEvent
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