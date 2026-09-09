import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type ExecutionState = "queued" | "claimed" | "running" | "completed" | "failed" | "canceled";

export interface ExecutionRecord {
  id: string;
  itemKind: "task" | "message";
  itemId: string;
  targetId: string;
  workspaceId: string;
  state: ExecutionState;
  attempts: number;
  claimedBy: string | null;
  claimedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
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
        claimed_by TEXT,
        claimed_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_target_state
        ON execution_queue(target_id, state, created_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  enqueueTask(taskId: string, targetId: string, workspaceId: string): ExecutionRecord {
    const existing = this.getByItem(taskId);
    if (existing) return existing;
    const timestamp = nowIso();
    const record: ExecutionRecord = {
      id: `exec_${randomUUID()}`,
      itemKind: "task",
      itemId: taskId,
      targetId,
      workspaceId,
      state: "queued",
      attempts: 0,
      claimedBy: null,
      claimedAt: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.db.prepare(`
      INSERT INTO execution_queue(
        id, item_kind, item_id, target_id, workspace_id, state, attempts,
        claimed_by, claimed_at, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.itemKind,
      record.itemId,
      record.targetId,
      record.workspaceId,
      record.state,
      record.attempts,
      record.claimedBy,
      record.claimedAt,
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

  claimNext(targetId: string, runnerId: string): ExecutionRecord | null {
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
      const result = this.db.prepare(`
        UPDATE execution_queue
        SET state = 'claimed', attempts = attempts + 1,
            claimed_by = ?, claimed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(runnerId, timestamp, timestamp, row.id) as { changes: number | bigint };
      if (Number(result.changes) !== 1) throw new Error(`Execution claim lost for ${String(row.id)}`);
      const claimed = this.db.prepare("SELECT * FROM execution_queue WHERE id = ?").get(row.id) as any;
      this.db.exec("COMMIT;");
      return this.row(claimed);
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  updateState(id: string, state: ExecutionState, lastError: string | null = null): ExecutionRecord {
    const updatedAt = nowIso();
    const result = this.db.prepare(`
      UPDATE execution_queue SET state = ?, last_error = ?, updated_at = ? WHERE id = ?
    `).run(state, lastError, updatedAt, id) as { changes: number | bigint };
    if (Number(result.changes) !== 1) throw new Error(`Execution item ${id} not found`);
    const row = this.db.prepare("SELECT * FROM execution_queue WHERE id = ?").get(id) as any;
    return this.row(row);
  }

  cancelByItem(itemId: string, reason = "canceled"): ExecutionRecord | null {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE execution_queue
      SET state = 'canceled', last_error = ?, updated_at = ?
      WHERE item_id = ? AND state IN ('queued', 'claimed', 'running')
    `).run(reason, timestamp, itemId);
    return this.getByItem(itemId);
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
      claimedBy: row.claimed_by === null ? null : String(row.claimed_by),
      claimedAt: row.claimed_at === null ? null : String(row.claimed_at),
      lastError: row.last_error === null ? null : String(row.last_error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }
}
