import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  RemoteLeaseBroker,
  RemoteLeaseError,
  type RemoteLeaseGrant,
  type RemoteLeaseTarget
} from "./remote-leases.js";
import type { JsonObject } from "./types.js";
import type { RuntimeExecutionResult } from "./runtime.js";

export const REMOTE_RECOVERY_A2A_EXTENSION_URI =
  "https://github.com/aiverse-filmmakers/AI-Verse-Multiple-Bots/extensions/remote-task-recovery/v1";

export type RemoteRecoveryAdapter = "a2a" | "external-managed";
export type RemoteRecoveryState = "submitting" | "remote_active" | "completed";

export interface RemoteExecutionCheckpoint {
  localTaskId: string;
  adapterId: RemoteRecoveryAdapter;
  targetKind: string;
  targetRef: string;
  operationKey: string;
  state: RemoteRecoveryState;
  remoteOperationId: string | null;
  remoteContextId: string | null;
  resume: JsonObject;
  leaseGrant: RemoteLeaseGrant | null;
  result: RuntimeExecutionResult | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingRemoteLeaseRevocation {
  id: string;
  localTaskId: string;
  target: RemoteLeaseTarget;
  grant: RemoteLeaseGrant;
  attempts: number;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BeginRemoteExecutionInput {
  localTaskId: string;
  adapterId: RemoteRecoveryAdapter;
  targetKind: string;
  targetRef: string;
  operationKey: string;
  resume?: JsonObject;
  leaseGrant?: RemoteLeaseGrant | null;
}

const MAX_RECOVERY_JSON_BYTES = 5 * 1024 * 1024;

function nowIso(): string {
  return new Date().toISOString();
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundedJson(value: unknown, label: string): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not JSON serializable`);
  }
  if (bytes(serialized) > MAX_RECOVERY_JSON_BYTES) {
    throw new Error(`${label} exceeds ${MAX_RECOVERY_JSON_BYTES} bytes`);
  }
  return serialized;
}

function parseObject(value: string | null): JsonObject {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as JsonObject
    : {};
}

function parseGrant(value: string | null): RemoteLeaseGrant | null {
  if (!value) return null;
  return JSON.parse(value) as RemoteLeaseGrant;
}

function parseResult(value: string | null): RuntimeExecutionResult | null {
  if (!value) return null;
  return JSON.parse(value) as RuntimeExecutionResult;
}

function safePart(value: string, label: string, max = 2048): string {
  if (!value || value.length > max || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} is invalid or too long`);
  }
  return value;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function remoteOperationKey(
  adapterId: RemoteRecoveryAdapter,
  localTaskId: string,
  targetRef: string
): string {
  return hash(`ai-verse-multiple-bots/remote-operation-v1\0${adapterId}\0${localTaskId}\0${targetRef}`);
}

export class RemoteRecoveryStore {
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
      CREATE TABLE IF NOT EXISTS remote_execution_recovery (
        local_task_id TEXT PRIMARY KEY,
        adapter_id TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        operation_key TEXT NOT NULL,
        state TEXT NOT NULL,
        remote_operation_id TEXT,
        remote_context_id TEXT,
        resume_json TEXT NOT NULL,
        lease_grant_json TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_execution_operation_key
        ON remote_execution_recovery(operation_key);
      CREATE INDEX IF NOT EXISTS idx_remote_execution_state
        ON remote_execution_recovery(state, updated_at);

      CREATE TABLE IF NOT EXISTS remote_lease_revocation_queue (
        id TEXT PRIMARY KEY,
        local_task_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        target_json TEXT NOT NULL,
        grant_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_remote_lease_revocation_updated
        ON remote_lease_revocation_queue(updated_at, id);
    `);
  }

  close(): void {
    this.db.close();
  }

  get(localTaskId: string): RemoteExecutionCheckpoint | null {
    const row = this.db.prepare(
      "SELECT * FROM remote_execution_recovery WHERE local_task_id = ?"
    ).get(localTaskId) as any;
    return row ? this.rowCheckpoint(row) : null;
  }

  list(): RemoteExecutionCheckpoint[] {
    const rows = this.db.prepare(
      "SELECT * FROM remote_execution_recovery ORDER BY created_at, local_task_id"
    ).all() as any[];
    return rows.map((row) => this.rowCheckpoint(row));
  }

  begin(input: BeginRemoteExecutionInput): RemoteExecutionCheckpoint {
    const localTaskId = safePart(input.localTaskId, "localTaskId", 512);
    const targetRef = safePart(input.targetRef, "targetRef", 2048);
    const operationKey = safePart(input.operationKey, "operationKey", 256);
    const existing = this.get(localTaskId);
    if (existing) {
      if (
        existing.adapterId !== input.adapterId
        || existing.targetKind !== input.targetKind
        || existing.targetRef !== targetRef
        || existing.operationKey !== operationKey
      ) {
        throw new Error(`Remote recovery identity drift for Task ${localTaskId}`);
      }
      return existing;
    }

    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO remote_execution_recovery(
        local_task_id, adapter_id, target_kind, target_ref, operation_key, state,
        remote_operation_id, remote_context_id, resume_json, lease_grant_json,
        result_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'submitting', NULL, NULL, ?, ?, NULL, ?, ?)
    `).run(
      localTaskId,
      input.adapterId,
      safePart(input.targetKind, "targetKind", 128),
      targetRef,
      operationKey,
      boundedJson(input.resume ?? {}, "remote recovery resume"),
      input.leaseGrant ? boundedJson(input.leaseGrant, "remote lease grant") : null,
      timestamp,
      timestamp
    );
    return this.get(localTaskId) as RemoteExecutionCheckpoint;
  }

  markRemoteActive(
    localTaskId: string,
    remoteOperationId: string,
    options: {
      remoteContextId?: string | null;
      resume?: JsonObject;
      leaseGrant?: RemoteLeaseGrant | null;
    } = {}
  ): RemoteExecutionCheckpoint {
    const current = this.require(localTaskId);
    if (current.state === "completed") return current;
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE remote_execution_recovery
      SET state = 'remote_active',
          remote_operation_id = ?,
          remote_context_id = ?,
          resume_json = ?,
          lease_grant_json = ?,
          updated_at = ?
      WHERE local_task_id = ?
    `).run(
      safePart(remoteOperationId, "remoteOperationId", 2048),
      options.remoteContextId ? safePart(options.remoteContextId, "remoteContextId", 2048) : null,
      boundedJson(options.resume ?? current.resume, "remote recovery resume"),
      options.leaseGrant
        ? boundedJson(options.leaseGrant, "remote lease grant")
        : current.leaseGrant
          ? boundedJson(current.leaseGrant, "remote lease grant")
          : null,
      timestamp,
      localTaskId
    );
    return this.require(localTaskId);
  }

  updateLease(localTaskId: string, grant: RemoteLeaseGrant | null): RemoteExecutionCheckpoint {
    this.require(localTaskId);
    this.db.prepare(`
      UPDATE remote_execution_recovery
      SET lease_grant_json = ?, updated_at = ?
      WHERE local_task_id = ?
    `).run(
      grant ? boundedJson(grant, "remote lease grant") : null,
      nowIso(),
      localTaskId
    );
    return this.require(localTaskId);
  }

  updateResume(localTaskId: string, resume: JsonObject): RemoteExecutionCheckpoint {
    this.require(localTaskId);
    this.db.prepare(`
      UPDATE remote_execution_recovery
      SET resume_json = ?, updated_at = ?
      WHERE local_task_id = ?
    `).run(boundedJson(resume, "remote recovery resume"), nowIso(), localTaskId);
    return this.require(localTaskId);
  }

  complete(
    localTaskId: string,
    result: RuntimeExecutionResult,
    options: { leaseGrant?: RemoteLeaseGrant | null; resume?: JsonObject } = {}
  ): RemoteExecutionCheckpoint {
    const current = this.require(localTaskId);
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE remote_execution_recovery
      SET state = 'completed',
          result_json = ?,
          lease_grant_json = ?,
          resume_json = ?,
          updated_at = ?
      WHERE local_task_id = ?
    `).run(
      boundedJson(result, "remote recovery result"),
      options.leaseGrant
        ? boundedJson(options.leaseGrant, "remote lease grant")
        : current.leaseGrant
          ? boundedJson(current.leaseGrant, "remote lease grant")
          : null,
      boundedJson(options.resume ?? current.resume, "remote recovery resume"),
      timestamp,
      localTaskId
    );
    return this.require(localTaskId);
  }

  clear(localTaskId: string): void {
    this.db.prepare("DELETE FROM remote_execution_recovery WHERE local_task_id = ?").run(localTaskId);
  }

  queueRevocation(
    localTaskId: string,
    target: RemoteLeaseTarget,
    grant: RemoteLeaseGrant
  ): PendingRemoteLeaseRevocation {
    const id = hash([
      "ai-verse-multiple-bots/remote-revocation-v1",
      localTaskId,
      grant.provider,
      target.kind,
      target.ref,
      grant.remote_lease_id,
      grant.grant_fingerprint
    ].join("\0"));
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT OR IGNORE INTO remote_lease_revocation_queue(
        id, local_task_id, provider_id, target_json, grant_json,
        attempts, last_error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)
    `).run(
      id,
      safePart(localTaskId, "localTaskId", 512),
      safePart(grant.provider, "provider", 256),
      boundedJson(target, "remote lease target"),
      boundedJson(grant, "remote lease grant"),
      timestamp,
      timestamp
    );
    return this.requireRevocation(id);
  }

  listPendingRevocations(limit = 100): PendingRemoteLeaseRevocation[] {
    const bounded = Math.max(1, Math.min(1000, Math.floor(limit)));
    const rows = this.db.prepare(`
      SELECT * FROM remote_lease_revocation_queue
      ORDER BY updated_at, id
      LIMIT ?
    `).all(bounded) as any[];
    return rows.map((row) => this.rowRevocation(row));
  }

  markRevoked(id: string): void {
    this.db.prepare("DELETE FROM remote_lease_revocation_queue WHERE id = ?").run(id);
  }

  markRevocationFailed(id: string, code: string): PendingRemoteLeaseRevocation {
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE remote_lease_revocation_queue
      SET attempts = attempts + 1, last_error_code = ?, updated_at = ?
      WHERE id = ?
    `).run(safePart(code, "revocation error code", 256), timestamp, id) as { changes: number | bigint };
    if (Number(result.changes) !== 1) throw new Error(`Remote revocation ${id} not found`);
    return this.requireRevocation(id);
  }

  async reconcileRevocations(
    broker: RemoteLeaseBroker,
    limit = 100
  ): Promise<{ attempted: number; revoked: number; failed: number }> {
    let attempted = 0;
    let revoked = 0;
    let failed = 0;
    for (const pending of this.listPendingRevocations(limit)) {
      attempted += 1;
      try {
        await broker.revoke(pending.grant, pending.localTaskId, pending.target);
        this.markRevoked(pending.id);
        revoked += 1;
      } catch (error) {
        const code = error instanceof RemoteLeaseError ? error.code : "REMOTE_LEASE_REVOKE_FAILED";
        this.markRevocationFailed(pending.id, code);
        failed += 1;
      }
    }
    return { attempted, revoked, failed };
  }

  private require(localTaskId: string): RemoteExecutionCheckpoint {
    const value = this.get(localTaskId);
    if (!value) throw new Error(`Remote recovery checkpoint for Task ${localTaskId} not found`);
    return value;
  }

  private requireRevocation(id: string): PendingRemoteLeaseRevocation {
    const row = this.db.prepare(
      "SELECT * FROM remote_lease_revocation_queue WHERE id = ?"
    ).get(id) as any;
    if (!row) throw new Error(`Remote revocation ${id} not found`);
    return this.rowRevocation(row);
  }

  private rowCheckpoint(row: any): RemoteExecutionCheckpoint {
    return {
      localTaskId: String(row.local_task_id),
      adapterId: String(row.adapter_id) as RemoteRecoveryAdapter,
      targetKind: String(row.target_kind),
      targetRef: String(row.target_ref),
      operationKey: String(row.operation_key),
      state: String(row.state) as RemoteRecoveryState,
      remoteOperationId: row.remote_operation_id === null ? null : String(row.remote_operation_id),
      remoteContextId: row.remote_context_id === null ? null : String(row.remote_context_id),
      resume: parseObject(row.resume_json === null ? null : String(row.resume_json)),
      leaseGrant: parseGrant(row.lease_grant_json === null ? null : String(row.lease_grant_json)),
      result: parseResult(row.result_json === null ? null : String(row.result_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private rowRevocation(row: any): PendingRemoteLeaseRevocation {
    return {
      id: String(row.id),
      localTaskId: String(row.local_task_id),
      target: JSON.parse(String(row.target_json)) as RemoteLeaseTarget,
      grant: JSON.parse(String(row.grant_json)) as RemoteLeaseGrant,
      attempts: Number(row.attempts),
      lastErrorCode: row.last_error_code === null ? null : String(row.last_error_code),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }
}
