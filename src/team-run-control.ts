import { createHash } from "node:crypto";
import { normalizeBudget, type BudgetEnvelope, type RuntimeUsage } from "./budget.js";
import { ExecutionQueue } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { TeamRunCoordinator, type TeamRunStatus, type WorkerStatus } from "./team-runs.js";
import type { JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

const TERMINAL_RUN_STATES = new Set<TeamRunStatus>(["completed", "failed", "canceled", "budget_exhausted"]);
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "canceled"]);
const TERMINAL_WORKER_STATES = new Set<WorkerStatus>(["completed", "failed", "canceled", "expired"]);
const ACTIVE_HANDOFF_STATES = new Set(["requested", "accepted", "ownership_changed"]);
const ACTIVE_FANOUT_STATES = new Set(["preparing", "running"]);
const OPTIMISTIC_RETRY_LIMIT = 6;

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function runtimeUsage(value: unknown): RuntimeUsage {
  const source = asObject(value);
  return {
    input_tokens: Number(source.input_tokens ?? 0),
    output_tokens: Number(source.output_tokens ?? 0),
    cost: Number(source.cost ?? 0),
    actions: Number(source.actions ?? 0)
  };
}

function addUsage(a: RuntimeUsage, b: RuntimeUsage): RuntimeUsage {
  return {
    input_tokens: Number(a.input_tokens ?? 0) + Number(b.input_tokens ?? 0),
    output_tokens: Number(a.output_tokens ?? 0) + Number(b.output_tokens ?? 0),
    cost: Number(a.cost ?? 0) + Number(b.cost ?? 0),
    actions: Number(a.actions ?? 0) + Number(b.actions ?? 0)
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function deterministicKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32);
}

function isOptimisticConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes("changed since it was read");
}

function isLeaseActive(lease: StoredObject, now = Date.now()): boolean {
  if (typeof lease.payload.revoked_at === "string" || typeof lease.payload.termination_revoked_at === "string") return false;
  const expiry = Date.parse(String(lease.payload.expires_at ?? ""));
  return !Number.isFinite(expiry) || expiry > now;
}

export type TeamRunTerminationOutcome = "canceled" | "budget_exhausted";

export interface TeamRunTaskCanceler {
  cancelTask(taskId: string, actorId: string, reason?: string): Promise<unknown>;
}

export interface TeamRunBudgetSnapshot {
  run_id: string;
  budget: BudgetEnvelope;
  usage: RuntimeUsage;
  task_count: number;
  worker_count: number;
  message_count: number;
  round_count: number;
  max_observed_hop: number;
  created_at: string | null;
  wall_clock_deadline_at: string | null;
  elapsed_seconds: number | null;
  violations: string[];
}

export interface TeamRunExecutionGuard {
  executable: boolean;
  task: StoredObject | null;
  run: StoredObject | null;
  snapshot: TeamRunBudgetSnapshot | null;
}

export interface TeamRunTerminationResult {
  run: StoredObject;
  outcome: TeamRunTerminationOutcome;
  task_ids_canceled: string[];
  worker_ids_canceled: string[];
  approval_ids_canceled: string[];
  handoff_ids_canceled: string[];
  capability_lease_ids_revoked: string[];
  environment_lease_ids_revoked: string[];
  shared_environment_lease_ids_preserved: string[];
  room_ids_closed: string[];
  thread_ids_closed: string[];
  already_terminal: boolean;
}

interface TerminationTargets {
  taskIds: string[];
  workerIds: string[];
  approvalIds: string[];
  handoffIds: string[];
  capabilityLeaseIds: string[];
  environmentLeaseIds: string[];
  sharedEnvironmentLeaseIds: string[];
  roomIds: string[];
  threadIds: string[];
}

/**
 * Canonical host-neutral Team Run control plane for Phase 2.
 *
 * Topology coordinators remain responsible for their local scheduling rules,
 * while this class owns the run-wide invariants that must not vary by topology:
 * aggregate budget inspection, one absolute wall-clock deadline, hierarchical
 * cancellation, budget exhaustion, terminal execution fencing and restart-safe
 * normalization of temporary authority/state.
 */
export class TeamRunControl {
  constructor(
    readonly teams: TeamRunCoordinator,
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue,
    readonly taskCanceler: TeamRunTaskCanceler
  ) {}

  budgetSnapshot(runId: string, now = Date.now()): TeamRunBudgetSnapshot {
    const run = this.requireRun(runId);
    const budget = normalizeBudget(run.payload.budget);
    const workspaceId = String(run.payload.workspace_id);
    const tasks = this.runTasks(run);
    const workers = this.teams.listWorkers(run.id).filter((worker) => worker.payload.status !== "expired");
    let usage: RuntimeUsage = { input_tokens: 0, output_tokens: 0, cost: 0, actions: 0 };
    let maxObservedHop = 0;
    const roundKeys = new Set<string>();
    for (const task of tasks) {
      if (task.payload.status === "completed") usage = addUsage(usage, runtimeUsage(task.payload.usage));
      const hop = finiteNumber(task.payload.hop);
      if (hop !== null) maxObservedHop = Math.max(maxObservedHop, hop);
      const roomId = typeof task.payload.discussion_room_id === "string" ? task.payload.discussion_room_id : null;
      const round = finiteNumber(task.payload.discussion_round);
      if (roomId && round !== null) roundKeys.add(`${roomId}:${round}`);
    }

    const temporaryRoomIds = new Set(this.runTemporaryRooms(run).map((room) => room.id));
    const messageCount = this.gateway.store.listObjects("message", workspaceId)
      .filter((message) => typeof message.payload.room_id === "string" && temporaryRoomIds.has(message.payload.room_id)).length;

    const createdAt = typeof run.payload.created_at === "string" ? run.payload.created_at : null;
    const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
    const deadlineMs = Number.isFinite(createdAtMs) && typeof budget.wall_clock_seconds === "number"
      ? createdAtMs + budget.wall_clock_seconds * 1000
      : null;
    const deadlineAt = deadlineMs === null ? null : nowIso(deadlineMs);
    const elapsedSeconds = Number.isFinite(createdAtMs) ? Math.max(0, (now - createdAtMs) / 1000) : null;
    const violations: string[] = [];
    const totalTokens = Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0);
    if (typeof budget.token_limit === "number" && totalTokens > budget.token_limit) violations.push("TEAM_RUN_TOKEN_BUDGET_EXCEEDED");
    if (typeof budget.cost_limit === "number" && Number(usage.cost ?? 0) > budget.cost_limit) violations.push("TEAM_RUN_COST_BUDGET_EXCEEDED");
    if (typeof budget.max_actions === "number" && Number(usage.actions ?? 0) > budget.max_actions) violations.push("TEAM_RUN_ACTION_BUDGET_EXCEEDED");
    if (typeof budget.max_tasks === "number" && tasks.length > budget.max_tasks) violations.push("TEAM_RUN_TASK_BUDGET_EXCEEDED");
    if (typeof budget.max_workers === "number" && workers.length > budget.max_workers) violations.push("TEAM_RUN_WORKER_BUDGET_EXCEEDED");
    if (typeof budget.max_hops === "number" && maxObservedHop > budget.max_hops) violations.push("TEAM_RUN_HOP_BUDGET_EXCEEDED");
    if (typeof budget.max_messages === "number" && messageCount > budget.max_messages) violations.push("TEAM_RUN_MESSAGE_BUDGET_EXCEEDED");
    if (typeof budget.max_rounds === "number" && roundKeys.size > budget.max_rounds) violations.push("TEAM_RUN_ROUND_BUDGET_EXCEEDED");
    if (deadlineMs !== null && now >= deadlineMs) violations.push("TEAM_RUN_WALL_CLOCK_BUDGET_EXCEEDED");

    return {
      run_id: run.id,
      budget,
      usage,
      task_count: tasks.length,
      worker_count: workers.length,
      message_count: messageCount,
      round_count: roundKeys.size,
      max_observed_hop: maxObservedHop,
      created_at: createdAt,
      wall_clock_deadline_at: deadlineAt,
      elapsed_seconds: elapsedSeconds,
      violations: uniqueSorted(violations)
    };
  }

  async guardQueuedTask(taskId: string, now = Date.now()): Promise<TeamRunExecutionGuard> {
    let task = this.gateway.store.getObject(taskId);
    if (!task || task.kind !== "task") return { executable: false, task: null, run: null, snapshot: null };
    const runId = typeof task.payload.run_id === "string" ? task.payload.run_id : null;
    if (!runId) return { executable: true, task, run: null, snapshot: null };
    let run = this.requireRun(runId);
    const status = String(run.payload.status) as TeamRunStatus;
    if (TERMINAL_RUN_STATES.has(status)) {
      if (status === "canceled" || status === "budget_exhausted") await this.reconcileTerminalRun(run.id);
      return { executable: false, task: this.gateway.store.getObject(task.id), run: this.requireRun(run.id), snapshot: this.budgetSnapshot(run.id, now) };
    }

    const snapshot = this.budgetSnapshot(run.id, now);
    if (snapshot.violations.length > 0) {
      const reason = `Team Run ${run.id} budget guard failed: ${snapshot.violations.join(", ")}`;
      await this.exhaustBudget(run.id, String(run.payload.leader_id), reason, task.id);
      return { executable: false, task: this.gateway.store.getObject(task.id), run: this.requireRun(run.id), snapshot };
    }

    if (snapshot.wall_clock_deadline_at) {
      task = this.tightenTaskDeadline(task, run, snapshot.wall_clock_deadline_at);
      run = this.requireRun(run.id);
    }
    return { executable: true, task, run, snapshot };
  }

  async cancelRun(runId: string, actorId: string, reason = "Team Run canceled"): Promise<TeamRunTerminationResult> {
    const run = this.requireRun(runId);
    this.assertTerminationActor(run, actorId);
    return this.terminate(run, "canceled", actorId, reason, null);
  }

  async exhaustBudget(runId: string, actorId: string, reason: string, triggerTaskId: string | null = null): Promise<TeamRunTerminationResult> {
    const run = this.requireRun(runId);
    this.assertTerminationActor(run, actorId);
    return this.terminate(run, "budget_exhausted", actorId, reason, triggerTaskId);
  }

  async reconcileTerminalRun(runId: string): Promise<TeamRunTerminationResult | null> {
    const run = this.requireRun(runId);
    const status = String(run.payload.status) as TeamRunStatus;
    if (status !== "canceled" && status !== "budget_exhausted") return null;
    const termination = asObject(run.payload.termination);
    const actorId = typeof termination.requested_by === "string" ? termination.requested_by : String(run.payload.leader_id);
    const reason = typeof termination.reason === "string" ? termination.reason : String(run.payload.status_reason ?? `Recover ${status} Team Run`);
    const triggerTaskId = typeof termination.trigger_task_id === "string" ? termination.trigger_task_id : null;
    return this.terminate(run, status, actorId, reason, triggerTaskId);
  }

  async recoverPendingTerminations(): Promise<string[]> {
    const recovered: string[] = [];
    for (const run of this.teams.listRuns()) {
      const status = String(run.payload.status) as TeamRunStatus;
      if (status !== "canceled" && status !== "budget_exhausted") continue;
      const termination = asObject(run.payload.termination);
      if (termination.state === "completed" && !this.hasTerminalResidue(run)) continue;
      await this.reconcileTerminalRun(run.id);
      recovered.push(run.id);
    }
    return recovered;
  }

  private async terminate(
    initialRun: StoredObject,
    outcome: TeamRunTerminationOutcome,
    actorId: string,
    reason: string,
    triggerTaskId: string | null
  ): Promise<TeamRunTerminationResult> {
    let run = this.requireRun(initialRun.id);
    const initialStatus = String(run.payload.status) as TeamRunStatus;
    if (TERMINAL_RUN_STATES.has(initialStatus) && initialStatus !== outcome) {
      return this.resultFromRun(run, initialStatus === "budget_exhausted" ? "budget_exhausted" : "canceled", true);
    }

    const existingTermination = asObject(run.payload.termination);
    const alreadyTerminal = TERMINAL_RUN_STATES.has(initialStatus);
    if (alreadyTerminal && existingTermination.state === "completed" && !this.hasTerminalResidue(run)) {
      return this.resultFromRun(run, outcome, true);
    }

    const targets = this.captureTerminationTargets(run);
    run = this.fenceTermination(run, outcome, actorId, reason, triggerTaskId);
    this.emitTerminationStarted(run, outcome, actorId, reason, triggerTaskId);

    const leaderId = String(run.payload.leader_id);
    for (const taskId of targets.taskIds) {
      const task = this.gateway.store.getObject(taskId);
      if (!task || task.kind !== "task" || TERMINAL_TASK_STATES.has(String(task.payload.status))) continue;
      try {
        await this.taskCanceler.cancelTask(task.id, leaderId, `Team Run ${run.id} ${outcome}: ${reason}`);
      } catch {
        // The terminal run fence already prevents new successful execution. The
        // final CAS normalization below cancels any Task that lost a race.
      }
    }

    let result: TeamRunTerminationResult | null = null;
    for (let attempt = 0; attempt < OPTIMISTIC_RETRY_LIMIT; attempt += 1) {
      try {
        result = this.normalizeTerminalState(run.id, outcome, actorId, reason, triggerTaskId, alreadyTerminal, targets);
        break;
      } catch (error) {
        if (!isOptimisticConflict(error) || attempt === OPTIMISTIC_RETRY_LIMIT - 1) throw error;
      }
    }
    if (!result) throw new Error(`Team Run ${run.id} termination did not settle`);
    this.emitTerminationCompleted(result.run, outcome, actorId, reason, triggerTaskId);
    return result;
  }

  private fenceTermination(
    run: StoredObject,
    outcome: TeamRunTerminationOutcome,
    actorId: string,
    reason: string,
    triggerTaskId: string | null
  ): StoredObject {
    for (let attempt = 0; attempt < OPTIMISTIC_RETRY_LIMIT; attempt += 1) {
      const latest = this.requireRun(run.id);
      const status = String(latest.payload.status) as TeamRunStatus;
      if (TERMINAL_RUN_STATES.has(status) && status !== outcome) return latest;
      const existing = asObject(latest.payload.termination);
      if (status === outcome && existing.state === "stopping" && existing.outcome === outcome) return latest;
      if (status === outcome && existing.state === "completed" && !this.hasTerminalResidue(latest)) return latest;
      const timestamp = nowIso();
      const fanouts = objectArray(latest.payload.fanouts).map((fanout) => ACTIVE_FANOUT_STATES.has(String(fanout.status))
        ? { ...fanout, status: "canceled", pending_task_ids: [], cancellation_reason: reason, settled_at: timestamp, updated_at: timestamp }
        : fanout);
      const termination: JsonObject = {
        state: "stopping",
        outcome,
        requested_by: typeof existing.requested_by === "string" ? existing.requested_by : actorId,
        requested_at: typeof existing.requested_at === "string" ? existing.requested_at : timestamp,
        reason: typeof existing.reason === "string" ? existing.reason : reason,
        trigger_task_id: typeof existing.trigger_task_id === "string" ? existing.trigger_task_id : triggerTaskId,
        last_reconciled_at: timestamp
      };
      const payload = validateProtocolObject({
        ...latest.payload,
        status: outcome,
        status_reason: reason,
        terminal_at: typeof latest.payload.terminal_at === "string" ? latest.payload.terminal_at : timestamp,
        fanouts,
        active_fanout_id: null,
        active_verification_task_id: null,
        active_synthesis_task_id: null,
        discussion_opening_id: null,
        discussion_opening_reserved_at: null,
        termination,
        updated_at: timestamp
      }, "team_run");
      try {
        const mutation = this.gateway.store.atomicMutation({
          preconditions: [{ id: latest.id, kind: "team_run", status, updatedAt: latest.updatedAt }],
          objects: [{ kind: "team_run", payload }],
          events: []
        });
        return mutation.objects[0] ?? latest;
      } catch (error) {
        if (!isOptimisticConflict(error) || attempt === OPTIMISTIC_RETRY_LIMIT - 1) throw error;
      }
    }
    return this.requireRun(run.id);
  }

  private normalizeTerminalState(
    runId: string,
    outcome: TeamRunTerminationOutcome,
    actorId: string,
    reason: string,
    triggerTaskId: string | null,
    alreadyTerminal: boolean,
    targets: TerminationTargets
  ): TeamRunTerminationResult {
    const run = this.requireRun(runId);
    const status = String(run.payload.status) as TeamRunStatus;
    if (status !== outcome) return this.resultFromRun(run, status === "budget_exhausted" ? "budget_exhausted" : "canceled", true);
    const workspaceId = String(run.payload.workspace_id);
    const tasks = this.runTasks(run);
    const taskIds = new Set(tasks.map((task) => task.id));
    const timestamp = nowIso();

    for (const task of tasks) this.queue.cancelByItem(task.id, `Team Run ${run.id} ${outcome}: ${reason}`);

    const liveTasks = tasks.filter((task) => !TERMINAL_TASK_STATES.has(String(task.payload.status)));
    const workers = this.teams.listWorkers(run.id);
    const liveWorkers = workers.filter((worker) => !TERMINAL_WORKER_STATES.has(String(worker.payload.status) as WorkerStatus));
    const pendingApprovals = this.gateway.store.listObjects("approval", workspaceId)
      .filter((approval) => taskIds.has(String(approval.payload.task_id ?? "")) && approval.payload.status === "pending");
    const activeHandoffs = this.gateway.store.listObjects("handoff", workspaceId)
      .filter((handoff) => taskIds.has(String(handoff.payload.task_id ?? handoff.payload.work_item_id ?? "")) && ACTIVE_HANDOFF_STATES.has(String(handoff.payload.status)));
    const capabilityLeases = this.gateway.store.listObjects("capability_lease", workspaceId)
      .filter((lease) => taskIds.has(String(lease.payload.task_id ?? "")) && lease.payload.termination_revoked_at === undefined);

    const allWorkspaceTasks = this.gateway.store.listObjects("task", workspaceId);
    const environmentLeases: StoredObject[] = [];
    const sharedEnvironmentLeaseIds = new Set<string>(targets.sharedEnvironmentLeaseIds);
    const environmentRefs = new Set<string>();
    for (const task of tasks) if (typeof task.payload.environment_lease_id === "string") environmentRefs.add(task.payload.environment_lease_id);
    for (const worker of workers) if (typeof worker.payload.environment_lease_id === "string") environmentRefs.add(worker.payload.environment_lease_id);
    for (const leaseId of environmentRefs) {
      const lease = this.gateway.store.getObject(leaseId);
      if (!lease || lease.kind !== "environment_lease") continue;
      const externalRef = allWorkspaceTasks.some((task) => task.payload.environment_lease_id === lease.id && String(task.payload.run_id ?? "") !== run.id);
      if (externalRef) {
        sharedEnvironmentLeaseIds.add(lease.id);
        continue;
      }
      if (lease.payload.termination_revoked_at === undefined) environmentLeases.push(lease);
    }

    const allTemporaryRooms = this.runTemporaryRooms(run);
    const temporaryRooms = allTemporaryRooms.filter((room) => String(room.payload.status) !== "closed");
    const allRoomIds = new Set(allTemporaryRooms.map((room) => room.id));
    const temporaryThreads = this.gateway.store.listObjects("thread", workspaceId)
      .filter((thread) => allRoomIds.has(String(thread.payload.room_id ?? "")) && String(thread.payload.status) !== "closed");

    const taskObjects = liveTasks.map((task) => ({
      kind: "task" as const,
      payload: validateProtocolObject({
        ...task.payload,
        status: "canceled",
        canceled_at: timestamp,
        canceled_by: actorId,
        cancellation_reason: `Team Run ${run.id} ${outcome}: ${reason}`,
        cancellation_code: outcome === "budget_exhausted" ? "TEAM_RUN_BUDGET_EXHAUSTED" : "CANCELED"
      }, "task")
    }));
    const workerObjects = liveWorkers.map((worker) => ({
      kind: "worker" as const,
      payload: validateProtocolObject({
        ...worker.payload,
        status: "canceled",
        terminal_at: timestamp,
        status_reason: `Team Run ${run.id} ${outcome}: ${reason}`,
        updated_at: timestamp
      }, "worker")
    }));
    const approvalObjects = pendingApprovals.map((approval) => ({
      kind: "approval" as const,
      payload: validateProtocolObject({
        ...approval.payload,
        status: "canceled",
        canceled_at: timestamp,
        canceled_by: actorId,
        decision_reason: `Team Run ${run.id} ${outcome}: ${reason}`
      }, "approval")
    }));
    const handoffObjects = activeHandoffs.map((handoff) => ({
      kind: "handoff" as const,
      payload: validateProtocolObject({
        ...handoff.payload,
        status: "canceled",
        outcome: "canceled",
        settled_at: timestamp,
        canceled_at: timestamp,
        cancellation_reason: `Team Run ${run.id} ${outcome}: ${reason}`
      }, "handoff")
    }));
    const leaseObjects = capabilityLeases.map((lease) => ({
      kind: "capability_lease" as const,
      payload: validateProtocolObject({
        ...lease.payload,
        expires_at: timestamp,
        revoked_at: timestamp,
        termination_revoked_at: timestamp,
        termination_run_id: run.id,
        revocation_reason: `Team Run ${run.id} ${outcome}: ${reason}`
      }, "capability_lease")
    }));
    const environmentLeaseObjects = environmentLeases.map((lease) => ({
      kind: "environment_lease" as const,
      payload: validateProtocolObject({
        ...lease.payload,
        expires_at: timestamp,
        revoked_at: timestamp,
        termination_revoked_at: timestamp,
        termination_run_id: run.id,
        revocation_reason: `Team Run ${run.id} ${outcome}: ${reason}`
      }, "environment_lease")
    }));
    const roomObjects = temporaryRooms.map((room) => {
      const discussion = asObject(room.payload.discussion);
      return {
        kind: "room" as const,
        payload: validateProtocolObject({
          ...room.payload,
          status: "closed",
          closed_at: typeof room.payload.closed_at === "string" ? room.payload.closed_at : timestamp,
          termination_closed_at: timestamp,
          ...(Object.keys(discussion).length > 0 ? {
            discussion: {
              ...discussion,
              status: discussion.status === "open" ? "canceled" : discussion.status,
              current_task_id: null,
              closed_at: typeof discussion.closed_at === "string" ? discussion.closed_at : timestamp,
              close_reason: discussion.close_reason ?? `Team Run ${run.id} ${outcome}: ${reason}`
            }
          } : {})
        }, "room")
      };
    });
    const threadObjects = temporaryThreads.map((thread) => ({
      kind: "thread" as const,
      payload: validateProtocolObject({
        ...thread.payload,
        status: "closed",
        closed_at: typeof thread.payload.closed_at === "string" ? thread.payload.closed_at : timestamp,
        termination_closed_at: timestamp
      }, "thread")
    }));

    const snapshot = this.budgetSnapshot(run.id);
    const priorTermination = asObject(run.payload.termination);
    const priorSummary = asObject(priorTermination.summary);
    const summary: JsonObject = {
      task_ids_canceled: uniqueSorted([...stringArray(priorSummary.task_ids_canceled), ...targets.taskIds, ...liveTasks.map((task) => task.id)]),
      worker_ids_canceled: uniqueSorted([...stringArray(priorSummary.worker_ids_canceled), ...targets.workerIds, ...liveWorkers.map((worker) => worker.id)]),
      approval_ids_canceled: uniqueSorted([...stringArray(priorSummary.approval_ids_canceled), ...targets.approvalIds, ...pendingApprovals.map((approval) => approval.id)]),
      handoff_ids_canceled: uniqueSorted([...stringArray(priorSummary.handoff_ids_canceled), ...targets.handoffIds, ...activeHandoffs.map((handoff) => handoff.id)]),
      capability_lease_ids_revoked: uniqueSorted([...stringArray(priorSummary.capability_lease_ids_revoked), ...targets.capabilityLeaseIds, ...capabilityLeases.map((lease) => lease.id)]),
      environment_lease_ids_revoked: uniqueSorted([...stringArray(priorSummary.environment_lease_ids_revoked), ...targets.environmentLeaseIds, ...environmentLeases.map((lease) => lease.id)]),
      shared_environment_lease_ids_preserved: uniqueSorted([...stringArray(priorSummary.shared_environment_lease_ids_preserved), ...sharedEnvironmentLeaseIds]),
      room_ids_closed: uniqueSorted([...stringArray(priorSummary.room_ids_closed), ...targets.roomIds, ...temporaryRooms.map((room) => room.id)]),
      thread_ids_closed: uniqueSorted([...stringArray(priorSummary.thread_ids_closed), ...targets.threadIds, ...temporaryThreads.map((thread) => thread.id)])
    };
    const updatedRun = validateProtocolObject({
      ...run.payload,
      status: outcome,
      status_reason: reason,
      terminal_at: typeof run.payload.terminal_at === "string" ? run.payload.terminal_at : timestamp,
      usage: snapshot.usage,
      active_fanout_id: null,
      active_verification_task_id: null,
      active_synthesis_task_id: null,
      discussion_opening_id: null,
      discussion_opening_reserved_at: null,
      termination: {
        ...priorTermination,
        state: "completed",
        outcome,
        reason: typeof priorTermination.reason === "string" ? priorTermination.reason : reason,
        requested_by: typeof priorTermination.requested_by === "string" ? priorTermination.requested_by : actorId,
        requested_at: typeof priorTermination.requested_at === "string" ? priorTermination.requested_at : timestamp,
        trigger_task_id: typeof priorTermination.trigger_task_id === "string" ? priorTermination.trigger_task_id : triggerTaskId,
        completed_at: timestamp,
        summary,
        budget_snapshot: snapshot
      },
      updated_at: timestamp
    }, "team_run");

    const preconditions = [
      { id: run.id, kind: "team_run" as const, status: outcome, updatedAt: run.updatedAt },
      ...liveTasks.map((task) => ({ id: task.id, kind: "task" as const, status: String(task.payload.status), updatedAt: task.updatedAt })),
      ...liveWorkers.map((worker) => ({ id: worker.id, kind: "worker" as const, status: String(worker.payload.status), updatedAt: worker.updatedAt })),
      ...pendingApprovals.map((approval) => ({ id: approval.id, kind: "approval" as const, status: "pending", updatedAt: approval.updatedAt })),
      ...activeHandoffs.map((handoff) => ({ id: handoff.id, kind: "handoff" as const, status: String(handoff.payload.status), updatedAt: handoff.updatedAt })),
      ...capabilityLeases.map((lease) => ({ id: lease.id, kind: "capability_lease" as const, updatedAt: lease.updatedAt })),
      ...environmentLeases.map((lease) => ({ id: lease.id, kind: "environment_lease" as const, updatedAt: lease.updatedAt })),
      ...temporaryRooms.map((room) => ({ id: room.id, kind: "room" as const, status: String(room.payload.status), updatedAt: room.updatedAt })),
      ...temporaryThreads.map((thread) => ({ id: thread.id, kind: "thread" as const, status: String(thread.payload.status), updatedAt: thread.updatedAt }))
    ];
    this.gateway.store.atomicMutation({
      preconditions,
      objects: [
        { kind: "team_run", payload: updatedRun },
        ...taskObjects,
        ...workerObjects,
        ...approvalObjects,
        ...handoffObjects,
        ...leaseObjects,
        ...environmentLeaseObjects,
        ...roomObjects,
        ...threadObjects
      ],
      events: []
    });

    const stored = this.requireRun(run.id);
    return this.resultFromRun(stored, outcome, alreadyTerminal);
  }

  private captureTerminationTargets(run: StoredObject): TerminationTargets {
    const tasks = this.runTasks(run);
    const taskIds = new Set(tasks.map((task) => task.id));
    const workers = this.teams.listWorkers(run.id);
    const workspaceId = String(run.payload.workspace_id);
    const capabilityLeaseIds = this.gateway.store.listObjects("capability_lease", workspaceId)
      .filter((lease) => taskIds.has(String(lease.payload.task_id ?? "")) && lease.payload.termination_revoked_at === undefined)
      .map((lease) => lease.id);

    const environmentRefs = new Set<string>();
    for (const task of tasks) if (typeof task.payload.environment_lease_id === "string") environmentRefs.add(task.payload.environment_lease_id);
    for (const worker of workers) if (typeof worker.payload.environment_lease_id === "string") environmentRefs.add(worker.payload.environment_lease_id);
    const allWorkspaceTasks = this.gateway.store.listObjects("task", workspaceId);
    const environmentLeaseIds: string[] = [];
    const sharedEnvironmentLeaseIds: string[] = [];
    for (const leaseId of environmentRefs) {
      const lease = this.gateway.store.getObject(leaseId);
      if (!lease || lease.kind !== "environment_lease") continue;
      const externalRef = allWorkspaceTasks.some((task) => task.payload.environment_lease_id === lease.id && String(task.payload.run_id ?? "") !== run.id);
      if (externalRef) sharedEnvironmentLeaseIds.push(lease.id);
      else if (lease.payload.termination_revoked_at === undefined) environmentLeaseIds.push(lease.id);
    }

    const allRooms = this.runTemporaryRooms(run);
    const roomIds = allRooms.filter((room) => String(room.payload.status) !== "closed").map((room) => room.id);
    const allRoomIds = new Set(allRooms.map((room) => room.id));
    const threadIds = this.gateway.store.listObjects("thread", workspaceId)
      .filter((thread) => allRoomIds.has(String(thread.payload.room_id ?? "")) && String(thread.payload.status) !== "closed")
      .map((thread) => thread.id);

    return {
      taskIds: tasks.filter((task) => !TERMINAL_TASK_STATES.has(String(task.payload.status))).map((task) => task.id),
      workerIds: workers.filter((worker) => !TERMINAL_WORKER_STATES.has(String(worker.payload.status) as WorkerStatus)).map((worker) => worker.id),
      approvalIds: this.gateway.store.listObjects("approval", workspaceId)
        .filter((approval) => taskIds.has(String(approval.payload.task_id ?? "")) && approval.payload.status === "pending")
        .map((approval) => approval.id),
      handoffIds: this.gateway.store.listObjects("handoff", workspaceId)
        .filter((handoff) => taskIds.has(String(handoff.payload.task_id ?? handoff.payload.work_item_id ?? "")) && ACTIVE_HANDOFF_STATES.has(String(handoff.payload.status)))
        .map((handoff) => handoff.id),
      capabilityLeaseIds,
      environmentLeaseIds,
      sharedEnvironmentLeaseIds,
      roomIds,
      threadIds
    };
  }

  private tightenTaskDeadline(task: StoredObject, run: StoredObject, runDeadlineAt: string): StoredObject {
    const existingDeadline = typeof task.payload.deadline_at === "string" ? task.payload.deadline_at : null;
    const existingMs = existingDeadline ? Date.parse(existingDeadline) : Number.POSITIVE_INFINITY;
    const runMs = Date.parse(runDeadlineAt);
    const effective = Number.isFinite(existingMs) && existingMs < runMs ? existingDeadline! : runDeadlineAt;
    if (task.payload.team_run_budget_deadline_at === runDeadlineAt && task.payload.deadline_at === effective) return task;
    const payload = validateProtocolObject({
      ...task.payload,
      deadline_at: effective,
      team_run_budget_deadline_at: runDeadlineAt,
      team_run_budget_guarded_at: nowIso()
    }, "task");
    const mutation = this.gateway.store.atomicMutation({
      preconditions: [
        { id: run.id, kind: "team_run", status: String(run.payload.status), updatedAt: run.updatedAt },
        { id: task.id, kind: "task", status: String(task.payload.status), ownerId: String(task.payload.owner_id), updatedAt: task.updatedAt }
      ],
      objects: [{ kind: "task", payload }],
      events: []
    });
    return mutation.objects[0] ?? task;
  }

  private hasTerminalResidue(run: StoredObject): boolean {
    const tasks = this.runTasks(run);
    const taskIds = new Set(tasks.map((task) => task.id));
    if (tasks.some((task) => !TERMINAL_TASK_STATES.has(String(task.payload.status)))) return true;
    if (this.teams.listWorkers(run.id).some((worker) => !TERMINAL_WORKER_STATES.has(String(worker.payload.status) as WorkerStatus))) return true;
    if (this.gateway.store.listObjects("approval", run.workspaceId ?? undefined).some((approval) => taskIds.has(String(approval.payload.task_id ?? "")) && approval.payload.status === "pending")) return true;
    if (this.gateway.store.listObjects("handoff", run.workspaceId ?? undefined).some((handoff) => taskIds.has(String(handoff.payload.task_id ?? handoff.payload.work_item_id ?? "")) && ACTIVE_HANDOFF_STATES.has(String(handoff.payload.status)))) return true;
    if (objectArray(run.payload.fanouts).some((fanout) => ACTIVE_FANOUT_STATES.has(String(fanout.status)))) return true;
    if (typeof run.payload.active_fanout_id === "string" || typeof run.payload.active_verification_task_id === "string" || typeof run.payload.active_synthesis_task_id === "string") return true;
    if (this.gateway.store.listObjects("capability_lease", run.workspaceId ?? undefined).some((lease) => taskIds.has(String(lease.payload.task_id ?? "")) && isLeaseActive(lease))) return true;

    const allWorkspaceTasks = this.gateway.store.listObjects("task", run.workspaceId ?? undefined);
    const environmentRefs = new Set<string>();
    for (const task of tasks) if (typeof task.payload.environment_lease_id === "string") environmentRefs.add(task.payload.environment_lease_id);
    for (const worker of this.teams.listWorkers(run.id)) if (typeof worker.payload.environment_lease_id === "string") environmentRefs.add(worker.payload.environment_lease_id);
    for (const leaseId of environmentRefs) {
      const lease = this.gateway.store.getObject(leaseId);
      if (!lease || lease.kind !== "environment_lease" || !isLeaseActive(lease)) continue;
      const externalRef = allWorkspaceTasks.some((task) => task.payload.environment_lease_id === lease.id && String(task.payload.run_id ?? "") !== run.id);
      if (!externalRef) return true;
    }

    const allRooms = this.runTemporaryRooms(run);
    if (allRooms.some((room) => String(room.payload.status) !== "closed")) return true;
    const roomIds = new Set(allRooms.map((room) => room.id));
    return this.gateway.store.listObjects("thread", run.workspaceId ?? undefined)
      .some((thread) => roomIds.has(String(thread.payload.room_id ?? "")) && String(thread.payload.status) !== "closed");
  }

  private runTemporaryRooms(run: StoredObject): StoredObject[] {
    return this.gateway.store.listObjects("room", String(run.payload.workspace_id))
      .filter((room) => room.payload.temporary === true && String(room.payload.run_id ?? asObject(room.payload.discussion).run_id ?? "") === run.id);
  }

  private runTasks(run: StoredObject): StoredObject[] {
    return this.gateway.store.listObjects("task", String(run.payload.workspace_id))
      .filter((task) => String(task.payload.run_id ?? "") === run.id);
  }

  private resultFromRun(run: StoredObject, outcome: TeamRunTerminationOutcome, alreadyTerminal: boolean): TeamRunTerminationResult {
    const summary = asObject(asObject(run.payload.termination).summary);
    return {
      run,
      outcome,
      task_ids_canceled: stringArray(summary.task_ids_canceled),
      worker_ids_canceled: stringArray(summary.worker_ids_canceled),
      approval_ids_canceled: stringArray(summary.approval_ids_canceled),
      handoff_ids_canceled: stringArray(summary.handoff_ids_canceled),
      capability_lease_ids_revoked: stringArray(summary.capability_lease_ids_revoked),
      environment_lease_ids_revoked: stringArray(summary.environment_lease_ids_revoked),
      shared_environment_lease_ids_preserved: stringArray(summary.shared_environment_lease_ids_preserved),
      room_ids_closed: stringArray(summary.room_ids_closed),
      thread_ids_closed: stringArray(summary.thread_ids_closed),
      already_terminal: alreadyTerminal
    };
  }

  private assertTerminationActor(run: StoredObject, actorId: string): void {
    const leaderId = String(run.payload.leader_id ?? "");
    if (actorId !== leaderId && !actorId.startsWith("operator_")) {
      throw new Error(`Only Team Run leader ${leaderId} or an operator can terminate ${run.id}`);
    }
  }

  private emitTerminationStarted(run: StoredObject, outcome: TeamRunTerminationOutcome, actorId: string, reason: string, triggerTaskId: string | null): void {
    this.gateway.emit({
      type: "team_run.termination_started",
      actorId,
      workspaceId: String(run.payload.workspace_id),
      runId: run.id,
      taskId: triggerTaskId,
      correlationId: String(run.payload.root_objective_id),
      summary: `${run.id} fenced as ${outcome}: ${reason}`,
      attentionState: outcome === "canceled" ? "canceled" : "failed",
      idempotencyKey: `team-run:${run.id}:termination:${outcome}:started:${deterministicKey([run.id, outcome])}`
    });
  }

  private emitTerminationCompleted(run: StoredObject, outcome: TeamRunTerminationOutcome, actorId: string, reason: string, triggerTaskId: string | null): void {
    this.gateway.emit({
      type: outcome === "budget_exhausted" ? "team_run.budget_exhausted" : "team_run.canceled",
      actorId,
      workspaceId: String(run.payload.workspace_id),
      runId: run.id,
      taskId: triggerTaskId,
      correlationId: String(run.payload.root_objective_id),
      summary: `${run.id} ${outcome} cascade completed: ${reason}`,
      attentionState: outcome === "canceled" ? "canceled" : "failed",
      idempotencyKey: `team-run:${run.id}:termination:${outcome}:completed:${deterministicKey([run.id, outcome])}`
    });
  }

  private requireRun(runId: string): StoredObject {
    const run = this.teams.getRun(runId);
    if (!run) throw new Error(`Team Run ${runId} not found`);
    return run;
  }
}
