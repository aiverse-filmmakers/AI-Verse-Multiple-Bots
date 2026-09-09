import { BudgetError, inheritBudget, normalizeBudget, type BudgetEnvelope, type RuntimeUsage } from "./budget.js";
import { constraintsDigest, normalizeConstraints } from "./constraints.js";
import { createId } from "./id.js";
import type { RecoveryPolicy } from "./execution-queue.js";
import { ExecutionQueue } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { BotRunner } from "./runner.js";
import { TeamRunCoordinator, type TeamRunStatus } from "./team-runs.js";
import type { CoordinationEvent, JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

const TERMINAL_TASK_STATES = new Set(["completed", "failed", "canceled"]);
const TERMINAL_FANOUT_STATES = new Set(["satisfied", "partial", "failed", "canceled"]);
const FANOUT_TOPOLOGIES = new Set(["parallel_panel", "dynamic_squad", "hybrid"]);
const DEFAULT_MAX_PARALLEL_WORKERS = 4;
const CONSUMPTIVE_BUDGET_KEYS = ["token_limit", "cost_limit", "max_actions"] as const;

type ConsumptiveBudgetKey = typeof CONSUMPTIVE_BUDGET_KEYS[number];
export type FanoutJoinMode = "all" | "first_success" | "quorum";
export type FanoutStatus = "preparing" | "running" | "satisfied" | "partial" | "failed" | "canceled";

export interface FanoutJoinPolicy extends JsonObject {
  mode: FanoutJoinMode;
  quorum?: number;
  cancel_remainder?: boolean;
}

export interface FanoutWorkerInput {
  key?: string;
  roleTitle: string;
  objective: string;
  reason: string;
  workerId?: string;
  runtime?: JsonObject;
  execution?: JsonObject;
  requiredConstraints?: string[];
  expectedOutput?: JsonObject;
  inputArtifactRefs?: string[];
  tools?: string[];
  connections?: string[];
  parentTaskId?: string;
  maxHops?: number;
  deadlineAt?: string;
  leaseExpiresAt?: string;
  budget?: BudgetEnvelope;
  recoveryPolicy?: RecoveryPolicy;
  maxAttempts?: number;
}

export interface CreateFanoutInput {
  runId: string;
  createdBy: string;
  workers: FanoutWorkerInput[];
  join?: FanoutJoinPolicy;
  maxConcurrency?: number;
  fanoutId?: string;
}

export interface FanoutSnapshot {
  fanoutId: string;
  run: StoredObject;
  status: FanoutStatus;
  join: FanoutJoinPolicy;
  tasks: StoredObject[];
  workers: StoredObject[];
  artifacts: StoredObject[];
  successfulTaskIds: string[];
  failedTaskIds: string[];
  canceledTaskIds: string[];
  pendingTaskIds: string[];
  satisfied: boolean;
  terminal: boolean;
}

interface PlannedWorker {
  workerId: string;
  taskId: string;
  leaseId: string;
  worker: JsonObject;
  task: JsonObject;
  lease: JsonObject;
  recoveryPolicy: RecoveryPolicy;
  maxAttempts: number;
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
  return Array.isArray(value) ? value.map(String) : [];
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

function usageForBudgetKey(usage: RuntimeUsage, key: ConsumptiveBudgetKey): number {
  if (key === "token_limit") return Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0);
  if (key === "cost_limit") return Number(usage.cost ?? 0);
  return Number(usage.actions ?? 0);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Host-neutral bounded parallel fan-out for temporary Workers.
 *
 * The fan-out scheduler reserves consumptive Team Run budgets before any Worker
 * becomes executable. This makes concurrent completion safe even though each
 * Worker is executed independently by the shared PrincipalRunner.
 */
export class TeamRunFanout {
  private readonly runLocks = new Map<string, Promise<void>>();

  constructor(
    readonly teams: TeamRunCoordinator,
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue,
    readonly runner: BotRunner
  ) {}

  createFanout(input: CreateFanoutInput): FanoutSnapshot {
    if (!Array.isArray(input.workers) || input.workers.length === 0) throw new Error("Parallel fan-out requires at least one Worker");
    const run = this.ensureRunning(input.runId, input.createdBy);
    const leaderId = String(run.payload.leader_id ?? "");
    if (leaderId !== input.createdBy) throw new Error(`Only Team Run leader ${leaderId} can create fan-out work`);
    if (!FANOUT_TOPOLOGIES.has(String(run.payload.topology))) {
      throw new Error(`Team Run ${run.id} topology ${String(run.payload.topology)} does not support parallel fan-out`);
    }

    const leader = this.gateway.getBot(leaderId);
    if (!leader || leader.payload.status !== "active") throw new Error(`Team Run leader ${leaderId} is not active`);
    const permissions = asObject(leader.payload.permissions);
    if (permissions.can_create_workers === false) throw new Error(`Bot ${leaderId} is not allowed to create temporary Workers`);

    this.assertNoActiveFanout(run);
    this.assertNoLiveWorkerTasks(run.id);

    const runBudget = normalizeBudget(run.payload.budget);
    const existingWorkers = this.teams.listWorkers(run.id).filter((worker) => worker.payload.status !== "expired");
    if (typeof runBudget.max_workers === "number" && existingWorkers.length + input.workers.length > runBudget.max_workers) {
      throw new BudgetError(
        "WORKER_BUDGET_EXCEEDED",
        `Team Run ${run.id} would have ${existingWorkers.length + input.workers.length} Workers with a limit of ${runBudget.max_workers}`
      );
    }

    const ceiling = this.parallelCeiling(leader, runBudget, input.maxConcurrency);
    if (input.workers.length > ceiling) {
      throw new BudgetError(
        "FANOUT_CONCURRENCY_EXCEEDED",
        `Parallel fan-out requested ${input.workers.length} Workers with a concurrency ceiling of ${ceiling}`
      );
    }

    const join = this.normalizeJoin(input.join, input.workers.length);
    const priorUsage = this.aggregateRunUsage(run.id);
    const workerBudgets = this.reserveWorkerBudgets(runBudget, input.workers, priorUsage);
    const fanoutId = input.fanoutId ?? createId("fanout");
    if (!fanoutId.startsWith("fanout_")) throw new Error(`Fan-out ID must start with fanout_: ${fanoutId}`);
    if (objectArray(run.payload.fanouts).some((fanout) => fanout.id === fanoutId)) throw new Error(`Fan-out ${fanoutId} already exists in Team Run ${run.id}`);

    const planned = input.workers.map((spec, index) => this.planWorker(run, leader, spec, workerBudgets[index] ?? {}, fanoutId));
    const rootTaskLimits = planned
      .map((item) => finiteNumber(asObject(item.task.budget).max_tasks))
      .filter((value): value is number => value !== null);
    if (rootTaskLimits.length > 0) {
      const limit = Math.min(...rootTaskLimits);
      const existingRootTasks = this.gateway.store.listObjects("task", String(run.payload.workspace_id))
        .filter((task) => String(task.payload.root_objective_id) === String(run.payload.root_objective_id)).length;
      if (existingRootTasks + planned.length > limit) {
        throw new BudgetError(
          "TASK_BUDGET_EXCEEDED",
          `Root objective ${String(run.payload.root_objective_id)} would have ${existingRootTasks + planned.length} Tasks with a limit of ${limit}`
        );
      }
    }

    const timestamp = nowIso();
    const fanoutRecord: JsonObject = {
      id: fanoutId,
      status: "preparing",
      join,
      max_concurrency: ceiling,
      worker_ids: planned.map((item) => item.workerId),
      task_ids: planned.map((item) => item.taskId),
      artifact_refs: [],
      successful_task_ids: [],
      failed_task_ids: [],
      canceled_task_ids: [],
      pending_task_ids: planned.map((item) => item.taskId),
      budget_reservations: planned.map((item) => ({ worker_id: item.workerId, task_id: item.taskId, budget: item.task.budget })),
      created_at: timestamp,
      updated_at: timestamp
    };
    const runPayload = validateProtocolObject({
      ...run.payload,
      participant_ids: [...new Set([...stringArray(run.payload.participant_ids), ...planned.map((item) => item.workerId)])],
      fanouts: [...objectArray(run.payload.fanouts), fanoutRecord],
      active_fanout_id: fanoutId,
      updated_at: timestamp
    }, "team_run");

    const events: CoordinationEvent[] = [this.event({
      type: "fanout.created",
      actorId: leaderId,
      workspaceId: String(run.payload.workspace_id),
      runId: run.id,
      correlationId: String(run.payload.root_objective_id),
      summary: `Created fan-out ${fanoutId} with ${planned.length} bounded Workers`
    })];
    for (const item of planned) {
      events.push(this.event({
        type: "worker.created",
        actorId: leaderId,
        workspaceId: String(run.payload.workspace_id),
        runId: run.id,
        taskId: item.taskId,
        correlationId: String(run.payload.root_objective_id),
        summary: `Created temporary Worker ${item.workerId} for fan-out ${fanoutId}`
      }));
    }

    this.gateway.store.atomicMutation({
      preconditions: [
        { id: run.id, kind: "team_run", status: String(run.payload.status) },
        { id: leader.id, kind: "bot", status: "active" }
      ],
      objects: [
        { kind: "team_run", payload: runPayload },
        ...planned.flatMap((item) => [
          { kind: "capability_lease" as const, payload: item.lease },
          { kind: "task" as const, payload: item.task },
          { kind: "worker" as const, payload: item.worker }
        ])
      ],
      events
    });

    this.activatePreparedFanout(run.id, fanoutId, false);
    return this.snapshot(run.id, fanoutId);
  }

  recoverPreparedFanouts(): string[] {
    const recovered: string[] = [];
    for (const run of this.gateway.store.listObjects("team_run")) {
      for (const fanout of objectArray(run.payload.fanouts)) {
        if (String(fanout.status) !== "preparing") continue;
        this.activatePreparedFanout(run.id, String(fanout.id), true);
        recovered.push(String(fanout.id));
      }
    }
    return recovered;
  }

  async reconcileOpenFanouts(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const run of this.gateway.store.listObjects("team_run")) {
      const fanoutId = typeof run.payload.active_fanout_id === "string" ? run.payload.active_fanout_id : null;
      if (!fanoutId) continue;
      pending.push(this.reconcileRun(run.id, fanoutId));
    }
    await Promise.all(pending);
  }

  async reconcileTask(taskId: string): Promise<void> {
    const task = this.gateway.store.getObject(taskId);
    if (!task || task.kind !== "task") return;
    const fanoutId = typeof task.payload.fanout_id === "string" ? task.payload.fanout_id : null;
    const runId = typeof task.payload.run_id === "string" ? task.payload.run_id : null;
    if (!fanoutId || !runId) return;
    await this.reconcileRun(runId, fanoutId);
  }

  async reconcileRun(runId: string, fanoutId?: string): Promise<void> {
    await this.withRunLock(runId, async () => {
      await this.reconcileRunUnlocked(runId, fanoutId);
    });
  }

  async cancelFanout(runId: string, actorId: string, reason = "Fan-out canceled"): Promise<FanoutSnapshot> {
    await this.withRunLock(runId, async () => {
      const run = this.requireRun(runId);
      const leaderId = String(run.payload.leader_id ?? "");
      if (actorId !== leaderId && !actorId.startsWith("operator_")) {
        throw new Error(`Only Team Run leader ${leaderId} or an operator can cancel fan-out work`);
      }
      const fanoutId = String(run.payload.active_fanout_id ?? "");
      if (!fanoutId) throw new Error(`Team Run ${runId} has no active fan-out`);
      const snapshot = this.snapshot(runId, fanoutId);
      for (const taskId of snapshot.pendingTaskIds) {
        const task = this.gateway.store.getObject(taskId);
        if (!task || task.kind !== "task" || TERMINAL_TASK_STATES.has(String(task.payload.status))) continue;
        await this.runner.cancelTask(task.id, actorId, reason);
      }
      this.persistFanoutState(runId, fanoutId, "canceled", true);
      this.gateway.emit({
        type: "fanout.canceled",
        actorId,
        workspaceId: run.workspaceId,
        runId,
        correlationId: String(run.payload.root_objective_id),
        summary: `${fanoutId} canceled: ${reason}`,
        attentionState: "failed"
      });
    });
    return this.snapshot(runId);
  }

  snapshot(runId: string, fanoutId?: string): FanoutSnapshot {
    const run = this.requireRun(runId);
    const record = this.fanoutRecord(run, fanoutId);
    const id = String(record.id);
    const taskIds = stringArray(record.task_ids);
    const workerIds = stringArray(record.worker_ids);
    const tasks = taskIds
      .map((taskId) => this.gateway.store.getObject(taskId))
      .filter((task): task is StoredObject => Boolean(task && task.kind === "task"));
    const workers = workerIds
      .map((workerId) => this.gateway.store.getObject(workerId))
      .filter((worker): worker is StoredObject => Boolean(worker && worker.kind === "worker"));
    const artifactIds = [...new Set(tasks.flatMap((task) => stringArray(task.payload.output_artifact_refs)))];
    const artifacts = artifactIds
      .map((artifactId) => this.gateway.store.getObject(artifactId))
      .filter((artifact): artifact is StoredObject => Boolean(artifact && artifact.kind === "artifact"));
    const successfulTaskIds = tasks.filter((task) => task.payload.status === "completed").map((task) => task.id);
    const failedTaskIds = tasks.filter((task) => task.payload.status === "failed").map((task) => task.id);
    const canceledTaskIds = tasks.filter((task) => task.payload.status === "canceled").map((task) => task.id);
    const pendingTaskIds = tasks.filter((task) => !TERMINAL_TASK_STATES.has(String(task.payload.status))).map((task) => task.id);
    const join = this.normalizeJoin(asObject(record.join) as FanoutJoinPolicy, Math.max(1, taskIds.length));
    const status = String(record.status) as FanoutStatus;
    const satisfied = status === "satisfied";
    return {
      fanoutId: id,
      run,
      status,
      join,
      tasks,
      workers,
      artifacts,
      successfulTaskIds,
      failedTaskIds,
      canceledTaskIds,
      pendingTaskIds,
      satisfied,
      terminal: TERMINAL_FANOUT_STATES.has(status)
    };
  }

  collectArtifacts(runId: string, fanoutId?: string): StoredObject[] {
    return this.snapshot(runId, fanoutId).artifacts;
  }

  async waitForIdle(): Promise<void> {
    while (this.runLocks.size > 0) await Promise.allSettled([...this.runLocks.values()]);
  }

  isIdle(): boolean {
    return this.runLocks.size === 0;
  }

  private activatePreparedFanout(runId: string, fanoutId: string, recovered: boolean): void {
    const run = this.requireRun(runId);
    const record = this.fanoutRecord(run, fanoutId);
    if (String(record.status) !== "preparing") return;
    const taskIds = stringArray(record.task_ids);
    const workerIds = stringArray(record.worker_ids);
    const tasks = taskIds.map((taskId) => {
      const task = this.gateway.store.getObject(taskId);
      if (!task || task.kind !== "task") throw new Error(`Prepared fan-out Task ${taskId} not found`);
      return task;
    });
    const workers = workerIds.map((workerId) => {
      const worker = this.gateway.store.getObject(workerId);
      if (!worker || worker.kind !== "worker") throw new Error(`Prepared fan-out Worker ${workerId} not found`);
      return worker;
    });

    for (const task of tasks) {
      const recoveryPolicy = task.payload.recovery_policy === "retry_safe" ? "retry_safe" : "manual";
      const maxAttempts = Number(task.payload.max_attempts ?? (recoveryPolicy === "retry_safe" ? 3 : 1));
      this.queue.enqueueTask(task.id, String(task.payload.assignee_id), String(task.payload.workspace_id), {
        recoveryPolicy,
        maxAttempts: Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : undefined
      });
    }

    const timestamp = nowIso();
    const latestRun = this.requireRun(runId);
    const updatedFanouts = objectArray(latestRun.payload.fanouts).map((fanout) => fanout.id === fanoutId
      ? { ...fanout, status: "running", activated_at: timestamp, updated_at: timestamp }
      : fanout);
    const objects = [
      { kind: "team_run" as const, payload: validateProtocolObject({ ...latestRun.payload, fanouts: updatedFanouts, active_fanout_id: fanoutId, updated_at: timestamp }, "team_run") },
      ...tasks.map((task) => ({ kind: "task" as const, payload: validateProtocolObject({ ...task.payload, status: "assigned", assigned_at: timestamp }, "task") })),
      ...workers.map((worker) => ({ kind: "worker" as const, payload: validateProtocolObject({ ...worker.payload, status: "ready", updated_at: timestamp }, "worker") }))
    ];
    this.gateway.store.atomicMutation({
      preconditions: [
        { id: latestRun.id, kind: "team_run", status: String(latestRun.payload.status) },
        ...tasks.map((task) => ({ id: task.id, kind: "task" as const, status: "created", ownerId: String(task.payload.owner_id) })),
        ...workers.map((worker) => ({ id: worker.id, kind: "worker" as const, status: "created" }))
      ],
      objects,
      events: []
    });

    this.gateway.emit({
      type: recovered ? "fanout.recovered" : "fanout.started",
      actorId: String(latestRun.payload.leader_id),
      workspaceId: latestRun.workspaceId,
      runId,
      correlationId: String(latestRun.payload.root_objective_id),
      summary: `${fanoutId} activated ${taskIds.length} parallel Worker Tasks${recovered ? " after recovery" : ""}`
    });
    for (const task of tasks) {
      this.gateway.emit({
        type: "worker.task_bound",
        actorId: String(latestRun.payload.leader_id),
        workspaceId: latestRun.workspaceId,
        runId,
        taskId: task.id,
        correlationId: String(latestRun.payload.root_objective_id),
        summary: `Bound ${String(task.payload.assignee_id)} to fan-out Task ${task.id}`
      });
      this.gateway.emit({
        type: "task.assigned",
        actorId: String(latestRun.payload.leader_id),
        workspaceId: latestRun.workspaceId,
        runId,
        taskId: task.id,
        correlationId: String(latestRun.payload.root_objective_id),
        summary: `Assigned parallel fan-out Task ${task.id} to ${String(task.payload.assignee_id)}`
      });
    }
  }

  private async reconcileRunUnlocked(runId: string, requestedFanoutId?: string): Promise<void> {
    let run = this.requireRun(runId);
    const record = this.fanoutRecord(run, requestedFanoutId);
    const fanoutId = String(record.id);
    const currentStatus = String(record.status) as FanoutStatus;
    if (currentStatus === "preparing") {
      this.activatePreparedFanout(runId, fanoutId, true);
      run = this.requireRun(runId);
    } else if (TERMINAL_FANOUT_STATES.has(currentStatus)) {
      return;
    }

    let snapshot = this.snapshot(runId, fanoutId);
    const requiredSuccesses = snapshot.join.mode === "quorum"
      ? Number(snapshot.join.quorum ?? 1)
      : snapshot.join.mode === "first_success" ? 1 : snapshot.tasks.length;
    const thresholdMet = snapshot.successfulTaskIds.length >= requiredSuccesses;
    const cancelRemainder = snapshot.join.mode !== "all" && snapshot.join.cancel_remainder !== false;

    if (thresholdMet && cancelRemainder && snapshot.pendingTaskIds.length > 0) {
      const leaderId = String(snapshot.run.payload.leader_id);
      for (const taskId of snapshot.pendingTaskIds) {
        const task = this.gateway.store.getObject(taskId);
        if (!task || task.kind !== "task" || TERMINAL_TASK_STATES.has(String(task.payload.status))) continue;
        await this.runner.cancelTask(task.id, leaderId, `Fan-out ${fanoutId} join condition satisfied`);
      }
      snapshot = this.snapshot(runId, fanoutId);
    }

    let nextStatus: FanoutStatus = "running";
    if (snapshot.join.mode === "all") {
      if (snapshot.pendingTaskIds.length === 0) {
        if (snapshot.successfulTaskIds.length === snapshot.tasks.length) nextStatus = "satisfied";
        else if (snapshot.successfulTaskIds.length > 0) nextStatus = "partial";
        else nextStatus = "failed";
      }
    } else if (snapshot.join.mode === "first_success") {
      if (snapshot.successfulTaskIds.length >= 1) nextStatus = "satisfied";
      else if (snapshot.pendingTaskIds.length === 0) nextStatus = "failed";
    } else {
      const quorum = Number(snapshot.join.quorum ?? 1);
      if (snapshot.successfulTaskIds.length >= quorum) nextStatus = "satisfied";
      else if (snapshot.successfulTaskIds.length + snapshot.pendingTaskIds.length < quorum) nextStatus = "failed";
    }

    const terminal = TERMINAL_FANOUT_STATES.has(nextStatus);
    this.persistFanoutState(runId, fanoutId, nextStatus, terminal);
    const latest = this.snapshot(runId, fanoutId);
    this.gateway.emit({
      type: terminal
        ? nextStatus === "satisfied" ? "fanout.join_satisfied" : nextStatus === "partial" ? "fanout.partial" : "fanout.failed"
        : "fanout.progress",
      actorId: String(latest.run.payload.leader_id),
      workspaceId: latest.run.workspaceId,
      runId,
      correlationId: String(latest.run.payload.root_objective_id),
      summary: `${fanoutId}: ${latest.successfulTaskIds.length} succeeded, ${latest.failedTaskIds.length} failed, ${latest.canceledTaskIds.length} canceled, ${latest.pendingTaskIds.length} pending`,
      attentionState: nextStatus === "failed" ? "failed" : undefined
    });
  }

  private persistFanoutState(runId: string, fanoutId: string, status: FanoutStatus, terminal: boolean): void {
    const run = this.requireRun(runId);
    const snapshot = this.snapshot(runId, fanoutId);
    const timestamp = nowIso();
    const fanouts = objectArray(run.payload.fanouts).map((fanout) => fanout.id === fanoutId
      ? {
          ...fanout,
          status,
          artifact_refs: snapshot.artifacts.map((artifact) => artifact.id),
          successful_task_ids: snapshot.successfulTaskIds,
          failed_task_ids: snapshot.failedTaskIds,
          canceled_task_ids: snapshot.canceledTaskIds,
          pending_task_ids: snapshot.pendingTaskIds,
          updated_at: timestamp,
          ...(terminal ? { settled_at: timestamp } : {})
        }
      : fanout);
    const payload = validateProtocolObject({
      ...run.payload,
      fanouts,
      usage: this.aggregateRunUsage(runId),
      active_fanout_id: terminal && run.payload.active_fanout_id === fanoutId ? null : run.payload.active_fanout_id,
      updated_at: timestamp
    }, "team_run");
    this.gateway.store.atomicMutation({
      preconditions: [{ id: run.id, kind: "team_run", status: String(run.payload.status) }],
      objects: [{ kind: "team_run", payload }],
      events: []
    });
  }

  private planWorker(run: StoredObject, leader: StoredObject, spec: FanoutWorkerInput, budget: BudgetEnvelope, fanoutId: string): PlannedWorker {
    if (!spec.roleTitle.trim()) throw new Error("Worker role title cannot be empty");
    if (!spec.objective.trim()) throw new Error("Worker objective cannot be empty");
    this.assertLeaderAuthority(leader, spec.tools ?? [], spec.connections ?? []);

    const workerId = spec.workerId ?? createId("worker");
    if (!workerId.startsWith("worker_")) throw new Error(`Temporary Worker ID must start with worker_: ${workerId}`);
    if (this.gateway.store.getObject(workerId)) throw new Error(`Protocol object ${workerId} already exists`);
    const taskId = createId("task");
    const leaseId = createId("lease");
    const prepared = this.gateway.policy?.prepareDelegation({
      createdBy: String(run.payload.leader_id),
      assigneeId: workerId,
      workspaceId: String(run.payload.workspace_id),
      rootObjectiveId: String(run.payload.root_objective_id),
      objective: spec.objective,
      requiredConstraints: spec.requiredConstraints,
      tools: spec.tools,
      connections: spec.connections,
      parentTaskId: spec.parentTaskId,
      maxHops: spec.maxHops,
      deadlineAt: spec.deadlineAt,
      budget
    }) ?? {
      parentTaskId: spec.parentTaskId ?? null,
      requiredConstraints: spec.requiredConstraints ?? [],
      hop: 0,
      maxHops: spec.maxHops ?? 6,
      deadlineAt: spec.deadlineAt ?? null,
      budget
    };
    const requiredConstraints = normalizeConstraints(prepared.requiredConstraints);
    const artifactRefs = this.validateInputArtifacts(spec.inputArtifactRefs ?? [], String(run.payload.workspace_id));
    const recoveryPolicy: RecoveryPolicy = spec.recoveryPolicy === "retry_safe" ? "retry_safe" : "manual";
    const maxAttempts = Math.max(1, Math.floor(spec.maxAttempts ?? (recoveryPolicy === "retry_safe" ? 3 : 1)));
    const timestamp = nowIso();

    const lease = validateProtocolObject({
      schema_version: "1.0",
      id: leaseId,
      type: "capability_lease",
      principal: String(run.payload.leader_id),
      issued_to: workerId,
      workspace_id: String(run.payload.workspace_id),
      task_id: taskId,
      tools: spec.tools ?? [],
      connections: spec.connections ?? [],
      destructive_actions: "deny",
      expires_at: spec.leaseExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()
    }, "capability_lease");
    const task = validateProtocolObject({
      schema_version: "1.0",
      id: taskId,
      type: "task.delegate",
      created_by: String(run.payload.leader_id),
      assignee_id: workerId,
      owner_id: workerId,
      workspace_id: String(run.payload.workspace_id),
      run_id: run.id,
      fanout_id: fanoutId,
      fanout_key: spec.key ?? null,
      root_objective_id: String(run.payload.root_objective_id),
      parent_task_id: prepared.parentTaskId,
      reason: spec.reason,
      objective: spec.objective,
      required_constraints: requiredConstraints,
      constraints_digest: constraintsDigest(requiredConstraints),
      expected_output: spec.expectedOutput ?? { contract: "artifact-or-structured-result" },
      input_artifact_refs: artifactRefs,
      lease_id: leaseId,
      environment_lease_id: null,
      response_target: { kind: "bot", id: String(run.payload.leader_id) },
      deadline_at: prepared.deadlineAt,
      budget: prepared.budget,
      budget_reservation: prepared.budget,
      hop: prepared.hop,
      max_hops: prepared.maxHops,
      recovery_policy: recoveryPolicy,
      max_attempts: maxAttempts,
      status: "created",
      created_at: timestamp
    }, "task");
    const worker = validateProtocolObject({
      schema_version: "1.0",
      id: workerId,
      type: "worker",
      kind: "temporary",
      run_id: run.id,
      fanout_id: fanoutId,
      task_id: taskId,
      created_by: String(run.payload.leader_id),
      parent_owner_id: String(run.payload.leader_id),
      workspace_id: String(run.payload.workspace_id),
      role: { title: spec.roleTitle.trim(), objective: spec.objective.trim() },
      runtime: spec.runtime ?? {},
      capability_lease_id: leaseId,
      environment_lease_id: null,
      budget: prepared.budget,
      status: "created",
      created_at: timestamp,
      updated_at: timestamp,
      ...(spec.execution ? { execution: spec.execution } : {})
    }, "worker");
    return { workerId, taskId, leaseId, worker, task, lease, recoveryPolicy, maxAttempts };
  }

  private reserveWorkerBudgets(runBudget: BudgetEnvelope, specs: FanoutWorkerInput[], priorUsage: RuntimeUsage): BudgetEnvelope[] {
    const budgets = specs.map((spec) => inheritBudget(runBudget, spec.budget));
    const requested = specs.map((spec) => normalizeBudget(spec.budget));

    for (const key of CONSUMPTIVE_BUDGET_KEYS) {
      const runLimit = runBudget[key];
      if (typeof runLimit !== "number") continue;
      const used = usageForBudgetKey(priorUsage, key);
      const remaining = Math.max(0, runLimit - used);
      const explicit = requested.map((budget) => typeof budget[key] === "number" ? budget[key] as number : null);
      const explicitSum = explicit.reduce((sum: number, value) => sum + (value ?? 0), 0);
      const epsilon = key === "cost_limit" ? 1e-9 : 0;
      if (explicitSum > remaining + epsilon) {
        throw new BudgetError(
          "FANOUT_BUDGET_RESERVATION_EXCEEDED",
          `Fan-out ${key} reservations ${explicitSum} exceed Team Run remaining budget ${remaining}`
        );
      }

      const unspecified = explicit.map((value, index) => value === null ? index : -1).filter((index) => index >= 0);
      let undistributed = Math.max(0, remaining - explicitSum);
      const allocations = [...explicit];
      if (unspecified.length > 0) {
        if (key === "cost_limit") {
          for (let position = 0; position < unspecified.length; position += 1) {
            const index = unspecified[position];
            if (index === undefined) continue;
            const slots = unspecified.length - position;
            const allocation = slots === 1 ? undistributed : undistributed / slots;
            allocations[index] = allocation;
            undistributed -= allocation;
          }
        } else {
          const whole = Math.floor(undistributed);
          const base = Math.floor(whole / unspecified.length);
          let remainder = whole - base * unspecified.length;
          for (const index of unspecified) {
            allocations[index] = base + (remainder > 0 ? 1 : 0);
            if (remainder > 0) remainder -= 1;
          }
        }
      }

      allocations.forEach((allocation, index) => {
        if (allocation === null || allocation === undefined) return;
        const target = budgets[index];
        if (target) target[key] = allocation;
      });
    }
    return budgets;
  }

  private aggregateRunUsage(runId: string): RuntimeUsage {
    let aggregate: RuntimeUsage = { input_tokens: 0, output_tokens: 0, cost: 0, actions: 0 };
    for (const task of this.gateway.store.listObjects("task")) {
      if (task.payload.run_id !== runId || task.payload.status !== "completed") continue;
      aggregate = addUsage(aggregate, runtimeUsage(task.payload.usage));
    }
    return aggregate;
  }

  private parallelCeiling(leader: StoredObject, runBudget: BudgetEnvelope, requested?: number): number {
    const coordination = asObject(leader.payload.coordination);
    const configured = finiteNumber(coordination.max_parallel_workers);
    const runLimit = finiteNumber(runBudget.max_workers);
    const requestedLimit = requested === undefined ? null : finiteNumber(requested);
    if (requested !== undefined && (requestedLimit === null || !Number.isInteger(requestedLimit) || requestedLimit < 1)) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    const candidates = [configured, runLimit, requestedLimit].filter((value): value is number => value !== null);
    const ceiling = candidates.length > 0 ? Math.min(...candidates) : DEFAULT_MAX_PARALLEL_WORKERS;
    if (!Number.isInteger(ceiling) || ceiling < 1) throw new Error("Parallel Worker ceiling must be a positive integer");
    return ceiling;
  }

  private normalizeJoin(value: FanoutJoinPolicy | undefined, workerCount: number): FanoutJoinPolicy {
    const mode: FanoutJoinMode = value?.mode === "first_success" || value?.mode === "quorum" ? value.mode : "all";
    if (mode === "all") return { mode: "all", cancel_remainder: false };
    if (mode === "first_success") return { mode: "first_success", quorum: 1, cancel_remainder: value?.cancel_remainder !== false };
    const quorum = Number(value?.quorum ?? Math.ceil(workerCount / 2));
    if (!Number.isInteger(quorum) || quorum < 1 || quorum > workerCount) {
      throw new Error(`Fan-out quorum must be between 1 and ${workerCount}`);
    }
    return { mode: "quorum", quorum, cancel_remainder: value?.cancel_remainder !== false };
  }

  private ensureRunning(runId: string, actorId: string): StoredObject {
    let run = this.requireRun(runId);
    if (String(run.payload.leader_id ?? "") !== actorId) throw new Error(`Only Team Run leader ${String(run.payload.leader_id)} can start fan-out work`);
    const status = String(run.payload.status) as TeamRunStatus;
    if (status === "created") {
      run = this.teams.transitionRun(runId, "planning", actorId, "Parallel fan-out planning started").run;
      run = this.teams.transitionRun(runId, "running", actorId, "Parallel fan-out execution started").run;
    } else if (status === "planning" || status === "waiting_input" || status === "waiting_approval") {
      run = this.teams.transitionRun(runId, "running", actorId, "Parallel fan-out execution resumed").run;
    } else if (status !== "running") {
      throw new Error(`Team Run ${runId} cannot create parallel fan-out from status ${status}`);
    }
    return run;
  }

  private assertNoActiveFanout(run: StoredObject): void {
    const activeId = typeof run.payload.active_fanout_id === "string" ? run.payload.active_fanout_id : null;
    if (!activeId) return;
    const active = objectArray(run.payload.fanouts).find((fanout) => fanout.id === activeId);
    if (active && !TERMINAL_FANOUT_STATES.has(String(active.status))) {
      throw new Error(`Team Run ${run.id} already has active fan-out ${activeId}`);
    }
  }

  private assertNoLiveWorkerTasks(runId: string): void {
    for (const worker of this.teams.listWorkers(runId)) {
      const taskId = typeof worker.payload.task_id === "string" ? worker.payload.task_id : null;
      if (!taskId) continue;
      const task = this.gateway.store.getObject(taskId);
      if (task?.kind === "task" && !TERMINAL_TASK_STATES.has(String(task.payload.status))) {
        throw new Error(`Parallel fan-out cannot start while Worker Task ${task.id} is still ${String(task.payload.status)}`);
      }
    }
  }

  private assertLeaderAuthority(leader: StoredObject, tools: string[], connections: string[]): void {
    const permissions = asObject(leader.payload.permissions);
    const allowedTools = Array.isArray(permissions.allowed_tools) ? stringArray(permissions.allowed_tools) : null;
    const allowedConnections = Array.isArray(permissions.allowed_connections) ? stringArray(permissions.allowed_connections) : null;
    if (allowedTools && !allowedTools.includes("*")) {
      for (const tool of tools) if (!allowedTools.includes(tool)) throw new Error(`Fan-out Worker cannot expand leader tool authority to ${tool}`);
    }
    if (allowedConnections && !allowedConnections.includes("*")) {
      for (const connection of connections) if (!allowedConnections.includes(connection)) throw new Error(`Fan-out Worker cannot expand leader connection authority to ${connection}`);
    }
  }

  private validateInputArtifacts(refs: string[], workspaceId: string): string[] {
    const unique = [...new Set(refs)];
    for (const ref of unique) {
      const artifact = this.gateway.store.getObject(ref);
      if (!artifact || artifact.kind !== "artifact") throw new Error(`Input Artifact ${ref} not found`);
      if (artifact.workspaceId !== workspaceId) throw new Error(`Input Artifact ${ref} is outside workspace ${workspaceId}`);
    }
    return unique;
  }

  private fanoutRecord(run: StoredObject, fanoutId?: string): JsonObject {
    const fanouts = objectArray(run.payload.fanouts);
    const id = fanoutId ?? (typeof run.payload.active_fanout_id === "string" ? run.payload.active_fanout_id : null) ?? String(fanouts.at(-1)?.id ?? "");
    const record = fanouts.find((fanout) => String(fanout.id) === id);
    if (!record) throw new Error(`Fan-out ${id || "<unknown>"} not found in Team Run ${run.id}`);
    return record;
  }

  private requireRun(runId: string): StoredObject {
    const run = this.teams.getRun(runId);
    if (!run) throw new Error(`Team Run ${runId} not found`);
    return run;
  }

  private async withRunLock(runId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    let tracked: Promise<void>;
    tracked = next.finally(() => {
      if (this.runLocks.get(runId) === tracked) this.runLocks.delete(runId);
    });
    this.runLocks.set(runId, tracked);
    await tracked;
  }

  private event(input: {
    type: string;
    actorId: string;
    workspaceId: string;
    runId: string;
    taskId?: string;
    correlationId: string;
    summary: string;
  }): CoordinationEvent {
    return {
      schema_version: "1.0",
      id: createId("evt"),
      type: input.type,
      timestamp: nowIso(),
      actor_id: input.actorId,
      workspace_id: input.workspaceId,
      run_id: input.runId,
      task_id: input.taskId ?? null,
      correlation_id: input.correlationId,
      summary: input.summary
    };
  }
}
