import { ExecutionQueue, type ExecutionState } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { TeamRunCoordinator, type TeamRunStatus, type WorkerStatus } from "./team-runs.js";
import type { JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

const TERMINAL_RUN_STATES = new Set<TeamRunStatus>(["completed", "failed", "canceled", "budget_exhausted"]);
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "canceled"]);
const TERMINAL_WORKER_STATES = new Set<WorkerStatus>(["completed", "failed", "canceled", "expired"]);
const CANCELABLE_EXECUTION_STATES = new Set<ExecutionState>(["queued", "claimed", "running", "dead_letter"]);
const OPTIMISTIC_RETRY_LIMIT = 4;
const DEFAULT_STALE_OPENING_MS = 5 * 60 * 1000;

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isOptimisticConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes("changed since it was read");
}

export interface TeamRunCleanupSummary {
  worker_ids_expired: string[];
  capability_lease_ids_revoked: string[];
  environment_lease_ids_revoked: string[];
  shared_environment_lease_ids_preserved: string[];
  execution_item_ids_canceled: string[];
  room_ids_closed: string[];
  thread_ids_closed: string[];
  preserved_artifact_refs: string[];
  discussion_opening_id_cleared: string | null;
}

export interface TeamRunCleanupResult {
  status: "completed" | "already_clean" | "blocked";
  run: StoredObject;
  summary: TeamRunCleanupSummary;
  blocker_ids: string[];
}

export interface ReapStaleDiscussionOpeningsOptions {
  now?: number;
  olderThanMs?: number;
  actorId?: string;
}

export interface DiscussionOpeningReapResult {
  run: StoredObject;
  openingId: string;
  status: "reaped" | "blocked";
  expiredWorkerIds: string[];
  blockerIds: string[];
}

/**
 * Host-neutral cleanup/reaping coordinator for temporary Team Run state.
 *
 * Cleanup never deletes canonical Tasks, Messages, Artifacts, Handoffs, Rooms,
 * Threads, Workers, events, or provenance. It terminalizes/revokes transient
 * execution authority and marks temporary identity/surfaces inactive while
 * preserving the audit graph required to explain a final result later.
 */
export class TeamRunCleanup {
  constructor(
    readonly teams: TeamRunCoordinator,
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue
  ) {}

  cleanupRun(runId: string, actorId: string): TeamRunCleanupResult {
    for (let attempt = 0; attempt < OPTIMISTIC_RETRY_LIMIT; attempt += 1) {
      const run = this.requireRun(runId);
      this.assertCleanupActor(run, actorId);
      const runStatus = String(run.payload.status) as TeamRunStatus;
      if (!TERMINAL_RUN_STATES.has(runStatus)) {
        throw new Error(`Cannot clean Team Run ${run.id} while status is ${runStatus}`);
      }

      const workspaceId = String(run.payload.workspace_id);
      const tasks = this.gateway.store.listObjects("task", workspaceId)
        .filter((task) => String(task.payload.run_id ?? "") === run.id);
      const workers = this.teams.listWorkers(run.id);
      const liveTasks = tasks.filter((task) => !TERMINAL_TASK_STATES.has(String(task.payload.status)));
      const liveWorkers = workers.filter((worker) => !TERMINAL_WORKER_STATES.has(String(worker.payload.status) as WorkerStatus));
      const blockerIds = uniqueSorted([...liveTasks.map((task) => task.id), ...liveWorkers.map((worker) => worker.id)]);
      if (blockerIds.length > 0) {
        this.gateway.emit({
          type: "team_run.cleanup_blocked",
          actorId,
          workspaceId,
          runId: run.id,
          correlationId: String(run.payload.root_objective_id),
          summary: `Cleanup blocked by nonterminal run objects: ${blockerIds.join(", ")}`,
          attentionState: "failed",
          idempotencyKey: `team-run:${run.id}:cleanup-blocked:${blockerIds.join(":")}`
        });
        return {
          status: "blocked",
          run,
          summary: this.emptySummary(run),
          blocker_ids: blockerIds
        };
      }

      const taskIds = new Set(tasks.map((task) => task.id));
      const workerIds = new Set(workers.map((worker) => worker.id));
      const preservedArtifacts = this.gateway.store.listObjects("artifact", workspaceId)
        .filter((artifact) => String(artifact.payload.run_id ?? "") === run.id)
        .map((artifact) => artifact.id);

      const capabilityLeases = this.gateway.store.listObjects("capability_lease", workspaceId)
        .filter((lease) => taskIds.has(String(lease.payload.task_id ?? "")));

      const environmentLeaseRefs = new Set<string>();
      for (const task of tasks) {
        if (typeof task.payload.environment_lease_id === "string") environmentLeaseRefs.add(task.payload.environment_lease_id);
      }
      for (const worker of workers) {
        if (typeof worker.payload.environment_lease_id === "string") environmentLeaseRefs.add(worker.payload.environment_lease_id);
      }
      const allWorkspaceTasks = this.gateway.store.listObjects("task", workspaceId);
      const environmentLeases: StoredObject[] = [];
      const sharedEnvironmentLeaseIds: string[] = [];
      for (const leaseId of environmentLeaseRefs) {
        const lease = this.gateway.store.getObject(leaseId);
        if (!lease || lease.kind !== "environment_lease") continue;
        const externalRef = allWorkspaceTasks.some((task) =>
          task.payload.environment_lease_id === lease.id && String(task.payload.run_id ?? "") !== run.id
        );
        if (externalRef) {
          sharedEnvironmentLeaseIds.push(lease.id);
          continue;
        }
        environmentLeases.push(lease);
      }

      const temporaryRooms = this.gateway.store.listObjects("room", workspaceId)
        .filter((room) => room.payload.temporary === true && String(room.payload.run_id ?? asObject(room.payload.discussion).run_id ?? "") === run.id);
      const temporaryRoomIds = new Set(temporaryRooms.map((room) => room.id));
      const temporaryThreads = this.gateway.store.listObjects("thread", workspaceId)
        .filter((thread) => temporaryRoomIds.has(String(thread.payload.room_id ?? "")));

      const workersToExpire = workers.filter((worker) => worker.payload.status !== "expired");
      const roomsToClose = temporaryRooms.filter((room) => String(room.payload.status) !== "closed");
      const threadsToClose = temporaryThreads.filter((thread) => String(thread.payload.status) !== "closed");
      const capabilityLeasesToRevoke = capabilityLeases.filter((lease) => lease.payload.cleanup_revoked_at === undefined);
      const environmentLeasesToRevoke = environmentLeases.filter((lease) => lease.payload.cleanup_revoked_at === undefined);

      const canceledExecutionItemIds: string[] = [];
      for (const task of tasks) {
        const execution = this.queue.getByItem(task.id);
        if (!execution || !CANCELABLE_EXECUTION_STATES.has(execution.state)) continue;
        this.queue.cancelByItem(task.id, `Team Run ${run.id} cleanup after ${runStatus}`);
        canceledExecutionItemIds.push(task.id);
      }

      const priorSummary = asObject(run.payload.cleanup_summary);
      const alreadyCompleted = run.payload.cleanup_status === "completed";
      const noObjectChanges = workersToExpire.length === 0
        && roomsToClose.length === 0
        && threadsToClose.length === 0
        && capabilityLeasesToRevoke.length === 0
        && environmentLeasesToRevoke.length === 0
        && canceledExecutionItemIds.length === 0
        && run.payload.discussion_opening_id == null;
      if (alreadyCompleted && noObjectChanges) {
        const summary = this.summaryFromPayload(priorSummary, run);
        this.emitCleanupAudit(run, actorId, summary);
        return { status: "already_clean", run, summary, blocker_ids: [] };
      }

      const timestamp = nowIso();
      const workerObjects = workersToExpire.map((worker) => ({
        kind: "worker" as const,
        payload: validateProtocolObject({
          ...worker.payload,
          status: "expired",
          cleanup_previous_status: String(worker.payload.status),
          status_reason: `Expired by Team Run cleanup after ${runStatus}`,
          terminal_at: typeof worker.payload.terminal_at === "string" ? worker.payload.terminal_at : timestamp,
          expired_at: typeof worker.payload.expired_at === "string" ? worker.payload.expired_at : timestamp,
          cleanup_expired_at: timestamp,
          updated_at: timestamp
        }, "worker")
      }));
      const leaseObjects = [
        ...capabilityLeasesToRevoke.map((lease) => ({
          kind: "capability_lease" as const,
          payload: validateProtocolObject({
            ...lease.payload,
            expires_at: timestamp,
            cleanup_revoked_at: timestamp,
            cleanup_run_id: run.id,
            revocation_reason: `Team Run ${run.id} reached ${runStatus}`
          }, "capability_lease")
        })),
        ...environmentLeasesToRevoke.map((lease) => ({
          kind: "environment_lease" as const,
          payload: validateProtocolObject({
            ...lease.payload,
            expires_at: timestamp,
            cleanup_revoked_at: timestamp,
            cleanup_run_id: run.id,
            revocation_reason: `Team Run ${run.id} reached ${runStatus}`
          }, "environment_lease")
        }))
      ];
      const roomObjects = roomsToClose.map((room) => {
        const discussion = asObject(room.payload.discussion);
        const nextDiscussion = Object.keys(discussion).length === 0 ? discussion : {
          ...discussion,
          status: discussion.status === "open" ? "canceled" : discussion.status,
          current_task_id: null,
          cleanup_closed_at: timestamp,
          close_reason: discussion.close_reason ?? `Closed during Team Run ${runStatus} cleanup`
        };
        return {
          kind: "room" as const,
          payload: validateProtocolObject({
            ...room.payload,
            status: "closed",
            closed_at: room.payload.closed_at ?? timestamp,
            cleanup_closed_at: timestamp,
            ...(Object.keys(discussion).length > 0 ? { discussion: nextDiscussion } : {})
          }, "room")
        };
      });
      const threadObjects = threadsToClose.map((thread) => ({
        kind: "thread" as const,
        payload: validateProtocolObject({
          ...thread.payload,
          status: "closed",
          closed_at: thread.payload.closed_at ?? timestamp,
          cleanup_closed_at: timestamp
        }, "thread")
      }));

      const summary: TeamRunCleanupSummary = {
        worker_ids_expired: uniqueSorted([...stringArray(priorSummary.worker_ids_expired), ...workersToExpire.map((worker) => worker.id)]),
        capability_lease_ids_revoked: uniqueSorted([...stringArray(priorSummary.capability_lease_ids_revoked), ...capabilityLeasesToRevoke.map((lease) => lease.id)]),
        environment_lease_ids_revoked: uniqueSorted([...stringArray(priorSummary.environment_lease_ids_revoked), ...environmentLeasesToRevoke.map((lease) => lease.id)]),
        shared_environment_lease_ids_preserved: uniqueSorted([...stringArray(priorSummary.shared_environment_lease_ids_preserved), ...sharedEnvironmentLeaseIds]),
        execution_item_ids_canceled: uniqueSorted([...stringArray(priorSummary.execution_item_ids_canceled), ...canceledExecutionItemIds]),
        room_ids_closed: uniqueSorted([...stringArray(priorSummary.room_ids_closed), ...roomsToClose.map((room) => room.id)]),
        thread_ids_closed: uniqueSorted([...stringArray(priorSummary.thread_ids_closed), ...threadsToClose.map((thread) => thread.id)]),
        preserved_artifact_refs: uniqueSorted([...stringArray(priorSummary.preserved_artifact_refs), ...preservedArtifacts]),
        discussion_opening_id_cleared: typeof run.payload.discussion_opening_id === "string"
          ? run.payload.discussion_opening_id
          : typeof priorSummary.discussion_opening_id_cleared === "string" ? priorSummary.discussion_opening_id_cleared : null
      };

      const updatedRunPayload = validateProtocolObject({
        ...run.payload,
        discussion_opening_id: null,
        discussion_opening_reserved_at: null,
        cleanup_status: "completed",
        cleanup_completed_at: timestamp,
        cleanup_summary: summary,
        updated_at: timestamp
      }, "team_run");
      const objects = [
        { kind: "team_run" as const, payload: updatedRunPayload },
        ...workerObjects,
        ...leaseObjects,
        ...roomObjects,
        ...threadObjects
      ];
      const preconditions = [
        { id: run.id, kind: "team_run" as const, status: runStatus, updatedAt: run.updatedAt },
        ...workersToExpire.map((worker) => ({ id: worker.id, kind: "worker" as const, status: String(worker.payload.status), updatedAt: worker.updatedAt })),
        ...capabilityLeasesToRevoke.map((lease) => ({ id: lease.id, kind: "capability_lease" as const, updatedAt: lease.updatedAt })),
        ...environmentLeasesToRevoke.map((lease) => ({ id: lease.id, kind: "environment_lease" as const, updatedAt: lease.updatedAt })),
        ...roomsToClose.map((room) => ({ id: room.id, kind: "room" as const, status: String(room.payload.status), updatedAt: room.updatedAt })),
        ...threadsToClose.map((thread) => ({ id: thread.id, kind: "thread" as const, status: String(thread.payload.status), updatedAt: thread.updatedAt }))
      ];

      try {
        const mutation = this.gateway.store.atomicMutation({ preconditions, objects, events: [] });
        const updatedRun = mutation.objects.find((object) => object.id === run.id) ?? this.requireRun(run.id);
        this.emitCleanupAudit(updatedRun, actorId, summary);
        return { status: "completed", run: updatedRun, summary, blocker_ids: [] };
      } catch (error) {
        if (isOptimisticConflict(error) && attempt < OPTIMISTIC_RETRY_LIMIT - 1) continue;
        throw error;
      }
    }
    throw new Error(`Team Run ${runId} cleanup could not settle after optimistic retries`);
  }

  recoverTerminalRuns(actorId = "operator_cleanup"): TeamRunCleanupResult[] {
    const results: TeamRunCleanupResult[] = [];
    for (const run of this.teams.listRuns()) {
      if (!TERMINAL_RUN_STATES.has(String(run.payload.status) as TeamRunStatus)) continue;
      if (run.payload.cleanup_status === "completed") continue;
      try {
        results.push(this.cleanupRun(run.id, actorId));
      } catch (error) {
        this.gateway.emit({
          type: "team_run.cleanup_failed",
          actorId,
          workspaceId: run.workspaceId,
          runId: run.id,
          correlationId: typeof run.payload.root_objective_id === "string" ? run.payload.root_objective_id : null,
          summary: error instanceof Error ? error.message : String(error),
          attentionState: "failed",
          idempotencyKey: `team-run:${run.id}:cleanup-failed:${String(run.updatedAt)}`
        });
      }
    }
    return results;
  }

  reapStaleDiscussionOpenings(options: ReapStaleDiscussionOpeningsOptions = {}): DiscussionOpeningReapResult[] {
    const now = options.now ?? Date.now();
    const olderThanMs = options.olderThanMs ?? DEFAULT_STALE_OPENING_MS;
    const actorId = options.actorId ?? "operator_cleanup";
    if (!Number.isFinite(olderThanMs) || olderThanMs < 1) throw new Error("olderThanMs must be positive");
    const results: DiscussionOpeningReapResult[] = [];

    for (const snapshot of this.teams.listRuns()) {
      const openingId = typeof snapshot.payload.discussion_opening_id === "string" ? snapshot.payload.discussion_opening_id : null;
      const reservedAt = typeof snapshot.payload.discussion_opening_reserved_at === "string" ? Date.parse(snapshot.payload.discussion_opening_reserved_at) : Number.NaN;
      if (!openingId || !Number.isFinite(reservedAt) || reservedAt > now - olderThanMs) continue;
      if (TERMINAL_RUN_STATES.has(String(snapshot.payload.status) as TeamRunStatus)) continue;

      for (let attempt = 0; attempt < OPTIMISTIC_RETRY_LIMIT; attempt += 1) {
        const run = this.requireRun(snapshot.id);
        if (run.payload.discussion_opening_id !== openingId) break;
        this.assertCleanupActor(run, actorId);
        const workspaceId = String(run.payload.workspace_id);
        const room = this.gateway.store.getObject(openingId);
        if (room) {
          const blockerIds = [room.id];
          this.gateway.emit({
            type: "discussion.opening_reap_blocked",
            actorId,
            workspaceId,
            runId: run.id,
            roomId: room.kind === "room" ? room.id : null,
            correlationId: String(run.payload.root_objective_id),
            summary: `Stale discussion opening ${openingId} cannot be reaped because protocol object ${room.id} exists`,
            attentionState: "failed",
            idempotencyKey: `discussion:${openingId}:reap-blocked:room`
          });
          results.push({ run, openingId, status: "blocked", expiredWorkerIds: [], blockerIds });
          break;
        }

        const workers = this.teams.listWorkers(run.id);
        const taggedWorkers = workers.filter((worker) => {
          const lifecycle = asObject(worker.payload.lifecycle);
          return lifecycle.origin === "discussion_setup" && lifecycle.discussion_opening_id === openingId;
        });
        const unsafeTagged = taggedWorkers.filter((worker) =>
          typeof worker.payload.task_id === "string"
          || !["created", "canceled", "expired"].includes(String(worker.payload.status))
        );
        const legacySuspects = workers.filter((worker) => {
          if (taggedWorkers.some((tagged) => tagged.id === worker.id)) return false;
          if (worker.payload.status !== "created" || worker.payload.task_id != null) return false;
          const createdAt = Date.parse(String(worker.payload.created_at ?? worker.createdAt));
          return Number.isFinite(createdAt) && createdAt >= reservedAt && createdAt <= reservedAt + 60_000;
        });
        const blockerIds = uniqueSorted([...unsafeTagged.map((worker) => worker.id), ...legacySuspects.map((worker) => worker.id)]);
        if (blockerIds.length > 0) {
          this.gateway.emit({
            type: "discussion.opening_reap_blocked",
            actorId,
            workspaceId,
            runId: run.id,
            correlationId: String(run.payload.root_objective_id),
            summary: `Stale discussion opening ${openingId} has ambiguous or active setup Workers: ${blockerIds.join(", ")}`,
            attentionState: "failed",
            idempotencyKey: `discussion:${openingId}:reap-blocked:${blockerIds.join(":")}`
          });
          results.push({ run, openingId, status: "blocked", expiredWorkerIds: [], blockerIds });
          break;
        }

        const timestamp = nowIso(now);
        const workersToExpire = taggedWorkers.filter((worker) => worker.payload.status !== "expired");
        const workerObjects = workersToExpire.map((worker) => ({
          kind: "worker" as const,
          payload: validateProtocolObject({
            ...worker.payload,
            status: "expired",
            cleanup_previous_status: String(worker.payload.status),
            status_reason: `Reaped stale discussion setup ${openingId}`,
            terminal_at: typeof worker.payload.terminal_at === "string" ? worker.payload.terminal_at : timestamp,
            expired_at: timestamp,
            cleanup_expired_at: timestamp,
            updated_at: timestamp
          }, "worker")
        }));
        const history = Array.isArray(run.payload.discussion_opening_reap_history)
          ? run.payload.discussion_opening_reap_history.filter((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry))
          : [];
        const updatedRunPayload = validateProtocolObject({
          ...run.payload,
          discussion_opening_id: null,
          discussion_opening_reserved_at: null,
          discussion_opening_reaped_at: timestamp,
          discussion_opening_reap_history: [
            ...history.slice(-9),
            { opening_id: openingId, reaped_at: timestamp, expired_worker_ids: workersToExpire.map((worker) => worker.id) }
          ],
          updated_at: timestamp
        }, "team_run");
        try {
          const mutation = this.gateway.store.atomicMutation({
            preconditions: [
              { id: run.id, kind: "team_run", status: String(run.payload.status), updatedAt: run.updatedAt },
              ...workersToExpire.map((worker) => ({ id: worker.id, kind: "worker" as const, status: String(worker.payload.status), updatedAt: worker.updatedAt }))
            ],
            objects: [{ kind: "team_run", payload: updatedRunPayload }, ...workerObjects],
            events: []
          });
          const updatedRun = mutation.objects.find((object) => object.id === run.id) ?? this.requireRun(run.id);
          const expiredWorkerIds = workersToExpire.map((worker) => worker.id);
          this.gateway.emit({
            type: "discussion.opening_reaped",
            actorId,
            workspaceId,
            runId: run.id,
            correlationId: String(run.payload.root_objective_id),
            summary: `Reaped stale discussion opening ${openingId}${expiredWorkerIds.length ? ` and ${expiredWorkerIds.length} setup Worker(s)` : ""}`,
            idempotencyKey: `discussion:${openingId}:reaped`
          });
          results.push({ run: updatedRun, openingId, status: "reaped", expiredWorkerIds, blockerIds: [] });
          break;
        } catch (error) {
          if (isOptimisticConflict(error) && attempt < OPTIMISTIC_RETRY_LIMIT - 1) continue;
          throw error;
        }
      }
    }
    return results;
  }

  private emitCleanupAudit(run: StoredObject, actorId: string, summary: TeamRunCleanupSummary): void {
    const workspaceId = String(run.payload.workspace_id);
    const runId = run.id;
    for (const workerId of summary.worker_ids_expired) {
      this.gateway.emit({
        type: "worker.expired",
        actorId,
        workspaceId,
        runId,
        correlationId: String(run.payload.root_objective_id),
        summary: `Expired temporary Worker ${workerId} during Team Run cleanup`,
        idempotencyKey: `team-run:${runId}:cleanup:worker:${workerId}`
      });
    }
    for (const leaseId of [...summary.capability_lease_ids_revoked, ...summary.environment_lease_ids_revoked]) {
      this.gateway.emit({
        type: "lease.cleanup_revoked",
        actorId,
        workspaceId,
        runId,
        correlationId: String(run.payload.root_objective_id),
        summary: `Revoked transient lease ${leaseId} during Team Run cleanup`,
        idempotencyKey: `team-run:${runId}:cleanup:lease:${leaseId}`
      });
    }
    this.gateway.emit({
      type: "team_run.cleanup_completed",
      actorId,
      workspaceId,
      runId,
      correlationId: String(run.payload.root_objective_id),
      summary: `Cleanup completed: ${summary.worker_ids_expired.length} Worker(s) expired, ${summary.execution_item_ids_canceled.length} execution item(s) canceled, ${summary.room_ids_closed.length} temporary Room(s) closed; ${summary.preserved_artifact_refs.length} Artifact(s) preserved`,
      idempotencyKey: `team-run:${runId}:cleanup-completed`
    });
  }

  private summaryFromPayload(value: JsonObject, run: StoredObject): TeamRunCleanupSummary {
    return {
      worker_ids_expired: uniqueSorted(stringArray(value.worker_ids_expired)),
      capability_lease_ids_revoked: uniqueSorted(stringArray(value.capability_lease_ids_revoked)),
      environment_lease_ids_revoked: uniqueSorted(stringArray(value.environment_lease_ids_revoked)),
      shared_environment_lease_ids_preserved: uniqueSorted(stringArray(value.shared_environment_lease_ids_preserved)),
      execution_item_ids_canceled: uniqueSorted(stringArray(value.execution_item_ids_canceled)),
      room_ids_closed: uniqueSorted(stringArray(value.room_ids_closed)),
      thread_ids_closed: uniqueSorted(stringArray(value.thread_ids_closed)),
      preserved_artifact_refs: uniqueSorted([
        ...stringArray(value.preserved_artifact_refs),
        ...this.gateway.store.listObjects("artifact", String(run.payload.workspace_id))
          .filter((artifact) => String(artifact.payload.run_id ?? "") === run.id)
          .map((artifact) => artifact.id)
      ]),
      discussion_opening_id_cleared: typeof value.discussion_opening_id_cleared === "string" ? value.discussion_opening_id_cleared : null
    };
  }

  private emptySummary(run: StoredObject): TeamRunCleanupSummary {
    return {
      worker_ids_expired: [],
      capability_lease_ids_revoked: [],
      environment_lease_ids_revoked: [],
      shared_environment_lease_ids_preserved: [],
      execution_item_ids_canceled: [],
      room_ids_closed: [],
      thread_ids_closed: [],
      preserved_artifact_refs: this.gateway.store.listObjects("artifact", String(run.payload.workspace_id))
        .filter((artifact) => String(artifact.payload.run_id ?? "") === run.id)
        .map((artifact) => artifact.id),
      discussion_opening_id_cleared: null
    };
  }

  private assertCleanupActor(run: StoredObject, actorId: string): void {
    const leaderId = String(run.payload.leader_id ?? "");
    if (actorId !== leaderId && !actorId.startsWith("operator_")) {
      throw new Error(`Only Team Run leader ${leaderId} or an operator can clean ${run.id}`);
    }
  }

  private requireRun(runId: string): StoredObject {
    const run = this.teams.getRun(runId);
    if (!run) throw new Error(`Team Run ${runId} not found`);
    return run;
  }
}
