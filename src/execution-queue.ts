import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type ExecutionState = "queued" | "claimed" | "running" | "completed" | "failed" | "canceled" | "dead_letter";
export type RecoveryPolicy = "manual" | "retry_safe";

export class ExecutionOwnershipError extends Error {
  constructor(readonly executionId: string, message: string) {
    super(message);
    this.name = "ExecutionOwnershipError";
  }
}

export interface EnqueueExecutionOptions {
  recoveryPolicy?: RecoveryPolicy;
  maxAttempts?: number;
}

export interface ExecutionRecord {
  id: string;
  itemKind: "task" | "message";
  itemId: string;
  targetId: string;
  workspaceId: string;
  state: ExecutionState;
  attempts: number;
  maxAttempts: number;
  recoveryPolicy: RecoveryPolicy;
  claimedBy: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaleExecution extends ExecutionRecord {
  staleAt: string;
}

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function leaseExpiry(seconds: number, now = Date.now()): string {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Execution lease seconds must be positive");
  return new Date(now + seconds * 1000).toISOString();
}

export class ExecutionQueue {
  private readonly db: DatabaseSync;

  constructor(readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_queue (
        id TEXT PRIMARY KEY,
        item_kind TEXT NOT NULL,
        item_id TEXT NOT NULL UNIQUE,
        target_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        recovery_policy TEXT NOT NULL DEFAULT 'manual',
        claimed_by TEXT,
        claimed_at TEXT,
        heartbeat_at TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_target_state
        ON execution_queue(target_id, state, created_at);
    `);
    this.ensureColumn("max_attempts", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("recovery_policy", "TEXT NOT NULL DEFAULT 'manual'");
    this.ensureColumn("heartbeat_at", "TEXT");
    this.ensureColumn("lease_expires_at", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_execution_lease ON execution_queue(state, lease_expires_at);");
  }

  private ensureColumn(name: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(execution_queue)").all() as Array<{ name: string }>;
    if (columns.some((column) => String(column.name) === name)) return;
    this.db.exec(`ALTER TABLE execution_queue ADD COLUMN ${name} ${definition};`);
  }

  close(): void {
    this.db.close();
  }

  enqueueTask(taskId: string, targetId: string, workspaceId: string, options: EnqueueExecutionOptions = {}): ExecutionRecord {
    const existing = this.getByItem(taskId);
    if (existing) return existing;
    const recoveryPolicy = options.recoveryPolicy ?? "manual";
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? (recoveryPolicy === "retry_safe" ? 3 : 1)));
    const timestamp = nowIso();
    const record: ExecutionRecord = {
      id: `exec_${randomUUID()}`,
      itemKind: "task",
      itemId: taskId,
      targetId,
      workspaceId,
      state: "queued",
      attempts: 0,
      maxAttempts,
      recoveryPolicy,
      claimedBy: null,
      claimedAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.prepare(`
      INSERT INTO execution_queue(
        id, item_kind, item_id, target_id, workspace_id, state, attempts, max_attempts, recovery_policy,
        claimed_by, claimed_at, heartbeat_at, lease_expires_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.itemKind,
      record.itemId,
      record.targetId,
      record.workspaceId,
      record.state,
      record.attempts,
      record.maxAttempts,
      record.recoveryPolicy,
      record.claimedBy,
      record.claimedAt,
      record.heartbeatAt,
      record.leaseExpiresAt,
      record.lastError,
      record.createdAt,
      record.updatedAt
    );
    return record;
  }

  getByItem(itemId: string): ExecutionRecord | null {
    const row = this.db.prepare("SELECT * FROM execution_queue WHERE item_id = ?").get(itemId) as any;
    return row ? this.row(row) : null;
  }

  list(targetId: string, states: ExecutionState[] = ["queued", "claimed", "running"]): ExecutionRecord[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT * FROM execution_queue
      WHERE target_id = ? AND state IN (${placeholders})
      ORDER BY created_at, id
    `).all(targetId, ...states) as any[];
    return rows.map((row) => this.row(row));
  }

  listQueuedTargets(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT target_id FROM execution_queue
      WHERE state = 'queued'
      ORDER BY target_id
    `).all() as Array<{ target_id: string }>;
    return rows.map((row) => String(row.target_id));
  }

  listStale(now = Date.now()): StaleExecution[] {
    const staleAt = nowIso(now);
    const rows = this.db.prepare(`
      SELECT * FROM execution_queue
      WHERE state IN ('claimed', 'running')
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
      ORDER BY lease_expires_at, id
    `).all(staleAt) as any[];
    return rows.map((row) => ({ ...this.row(row), staleAt }));
  }

  claimNext(targetId: string, runnerId: string, leaseSeconds = 30): ExecutionRecord | null {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const row = this.db.prepare(`
        SELECT * FROM execution_queue
        WHERE target_id = ? AND state = 'queued'
        ORDER BY created_at, id
        LIMIT 1
      `).get(targetId) as any;
      if (!row) {
        this.db.exec("COMMIT;");
        return null;
      }
      const timestamp = nowIso();
      const expiresAt = leaseExpiry(leaseSeconds);
      const result = this.db.prepare(`
        UPDATE execution_queue
        SET state = 'claimed', attempts = attempts + 1,
            claimed_by = ?, claimed_at = ?, heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(runnerId, timestamp, timestamp, expiresAt, timestamp, row.id) as { changes: number | bigint };
      if (Number(result.changes) !== 1) throw new Error(`Execution claim lost for ${String(row.id)}`);
      const claimed = this.db.prepare("SELECT * FROM execution_queue WHERE id = ?").get(row.id) as any;
      this.db.exec("COMMIT;");
      return this.row(claimed);
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  markRunning(id: string, runnerId: string, leaseSeconds = 30): ExecutionRecord {
    return this.ownedTransition(id, runnerId, ["claimed"], "running", null, leaseSeconds);
  }

  heartbeat(id: string, runnerId: string, leaseSeconds = 30): ExecutionRecord {
    const timestamp = nowIso();
    const expiresAt = leaseExpiry(leaseSeconds);
    const result = this.db.prepare(`
      UPDATE execution_queue
      SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND claimed_by = ? AND state IN ('claimed', 'running')
    `).run(timestamp, expiresAt, timestamp, id, runnerId) as { changes: number | bigint };
    if (Number(result.changes) !== 1) {
      throw new ExecutionOwnershipError(id, `Execution ownership lost for ${id}`);
    }
    return this.requireById(id);
  }

  finishOwned(id: string, runnerId: string, state: "completed" | "failed", lastError: string | null = null): ExecutionRecord {
    return this.ownedTransition(id, runnerId, ["claimed", "running"], state, lastError, null);
  }

  requeueStale(record: StaleExecution, reason: string): ExecutionRecord {
    if (record.recoveryPolicy !== "retry_safe") throw new Error(`Execution ${record.id} is not replay-safe`);
    if (record.attempts >= record.maxAttempts) throw new Error(`Execution ${record.id} exhausted ${record.maxAttempts} attempts`);
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE execution_queue
      SET state = 'queued', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
          lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ? AND state = ? AND claimed_by = ? AND lease_expires_at = ?
    `).run(reason, timestamp, record.id, record.state, record.claimedBy, record.leaseExpiresAt) as { changes: number | bigint };
    if (Number(result.changes) !== 1) throw new ExecutionOwnershipError(record.id, `Stale recovery race for ${record.id}`);
    return this.requireById(record.id);
  }

  deadLetterStale(record: StaleExecution, reason: string): ExecutionRecord {
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE execution_queue
      SET state = 'dead_letter', heartbeat_at = NULL, lease_expires_at = NULL,
          last_error = ?, updated_at = ?
      WHERE id = ? AND state = ? AND claimed_by = ? AND lease_expires_at = ?
    `).run(reason, timestamp, record.id, record.state, record.claimedBy, record.leaseExpiresAt) as { changes: number | bigint };
    if (Number(result.changes) !== 1) throw new ExecutionOwnershipError(record.id, `Dead-letter recovery race for ${record.id}`);
    return this.requireById(record.id);
  }

  retryDeadLetter(itemId: string, reason = "Operator authorized retry"): ExecutionRecord {
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE execution_queue
      SET state = 'queued', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL,
          lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE item_id = ? AND state = 'dead_letter'
    `).run(reason, timestamp, itemId) as { changes: number | bigint };
    if (Number(result.changes) !== 1) throw new Error(`Dead-letter execution for ${itemId} not found`);
    return this.getByItem(itemId) as ExecutionRecord;
  }

  updateState(id: string, state: ExecutionState, lastError: string | null = null): ExecutionRecord {
    const updatedAt = nowIso();
    const result = this.db.prepare(`
      UPDATE execution_queue SET state = ?, last_error = ?, updated_at = ? WHERE id = ?
    `).run(state, lastError, updatedAt, id) as { changes: number | bigint };
    if (Number(result.changes) !== 1) throw new Error(`Execution item ${id} not found`);
    return this.requireById(id);
  }

  cancelByItem(itemId: string, reason = "canceled"): ExecutionRecord | null {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE execution_queue
      SET state = 'canceled', heartbeat_at = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE item_id = ? AND state IN ('queued', 'claimed', 'running', 'dead_letter')
    `).run(reason, timestamp, itemId);
    return this.getByItem(itemId);
  }

  private ownedTransition(
    id: string,
    runnerId: string,
    fromStates: ExecutionState[],
    state: ExecutionState,
    lastError: string | null,
    leaseSeconds: number | null
  ): ExecutionRecord {
    const timestamp = nowIso();
    const placeholders = fromStates.map(() => "?").join(", ");
    const expiresAt = leaseSeconds === null ? null : leaseExpiry(leaseSeconds);
    const result = this.db.prepare(`
      UPDATE execution_queue
      SET state = ?, last_error = ?, heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND claimed_by = ? AND state IN (${placeholders})
    `).run(state, lastError, leaseSeconds === null ? null : timestamp, expiresAt, timestamp, id, runnerId, ...fromStates) as { changes: number | bigint };
    if (Number(result.changes) !== 1) {
      throw new ExecutionOwnershipError(id, `Execution ownership/state transition lost for ${id}`);
    }
    return this.requireById(id);
  }

  private requireById(id: string): ExecutionRecord {
    const row = this.db.prepare("SELECT * FROM execution_queue WHERE id = ?").get(id) as any;
    if (!row) throw new Error(`Execution item ${id} not found`);
    return this.row(row);
  }

  private row(row: any): ExecutionRecord {
    return {
      id: String(row.id),
      itemKind: row.item_kind as ExecutionRecord["itemKind"],
      itemId: String(row.item_id),
      targetId: String(row.target_id),
      workspaceId: String(row.workspace_id),
      state: row.state as ExecutionState,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts ?? 1),
      recoveryPolicy: (row.recovery_policy === "retry_safe" ? "retry_safe" : "manual") as RecoveryPolicy,
      claimedBy: row.claimed_by === null ? null : String(row.claimed_by),
      claimedAt: row.claimed_at === null ? null : String(row.claimed_at),
      heartbeatAt: row.heartbeat_at === null ? null : String(row.heartbeat_at),
      leaseExpiresAt: row.lease_expires_at === null ? null : String(row.lease_expires_at),
      lastError: row.last_error === null ? null : String(row.last_error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }
}
