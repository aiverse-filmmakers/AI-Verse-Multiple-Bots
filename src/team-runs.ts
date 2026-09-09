import { BudgetError, normalizeBudget, type BudgetEnvelope } from "./budget.js";
import { createId } from "./id.js";
import { CoordinationStore } from "./store.js";
import type { AppendedEvent, CoordinationEvent, JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

function nowIso(): string {
  return new Date().toISOString();
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function requiredAt<T>(values: T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Atomic mutation did not return ${label}`);
  return value;
}

export type TeamRunTopology =
  | "single"
  | "manager"
  | "handoff"
  | "parallel_panel"
  | "group_room"
  | "pipeline"
  | "review"
  | "dynamic_squad"
  | "hybrid";

export type TeamRunStatus =
  | "created"
  | "planning"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "synthesizing"
  | "verifying"
  | "completed"
  | "failed"
  | "canceled"
  | "budget_exhausted";

export type WorkerStatus =
  | "created"
  | "ready"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "canceled"
  | "expired";

export interface CreateTeamRunInput {
  leaderId: string;
  workspaceId: string;
  rootObjectiveId: string;
  objective?: string;
  topology?: TeamRunTopology;
  budget?: BudgetEnvelope;
}

export interface CreateWorkerInput {
  runId: string;
  createdBy: string;
  roleTitle: string;
  objective: string;
  workerId?: string;
  taskId?: string | null;
  runtime?: JsonObject;
  execution?: JsonObject;
  capabilityLeaseId?: string | null;
  environmentLeaseId?: string | null;
  budget?: BudgetEnvelope;
}

export interface TeamRunMutationResult {
  run: StoredObject;
  workers: StoredObject[];
  events: AppendedEvent[];
}

const TERMINAL_RUN_STATES = new Set<TeamRunStatus>(["completed", "failed", "canceled", "budget_exhausted"]);
const TERMINAL_WORKER_STATES = new Set<WorkerStatus>(["completed", "failed", "canceled", "expired"]);
const ACTIVE_TASK_STATES = new Set(["created", "assigned", "accepted", "running", "waiting_input", "waiting_approval", "blocked"]);

const RUN_TRANSITIONS: Record<TeamRunStatus, ReadonlySet<TeamRunStatus>> = {
  created: new Set(["planning", "running", "failed", "canceled"]),
  planning: new Set(["running", "waiting_input", "waiting_approval", "failed", "canceled", "budget_exhausted"]),
  running: new Set(["waiting_input", "waiting_approval", "synthesizing", "verifying", "failed", "canceled", "budget_exhausted"]),
  waiting_input: new Set(["planning", "running", "failed", "canceled", "budget_exhausted"]),
  waiting_approval: new Set(["planning", "running", "failed", "canceled", "budget_exhausted"]),
  synthesizing: new Set(["verifying", "completed", "failed", "canceled", "budget_exhausted"]),
  verifying: new Set(["synthesizing", "completed", "failed", "canceled", "budget_exhausted"]),
  completed: new Set(),
  failed: new Set(),
  canceled: new Set(),
  budget_exhausted: new Set()
};

const WORKER_TRANSITIONS: Record<WorkerStatus, ReadonlySet<WorkerStatus>> = {
  created: new Set(["ready", "failed", "canceled"]),
  ready: new Set(["running", "waiting", "failed", "canceled"]),
  running: new Set(["waiting", "completed", "failed", "canceled"]),
  waiting: new Set(["ready", "running", "completed", "failed", "canceled"]),
  completed: new Set(["expired"]),
  failed: new Set(["expired"]),
  canceled: new Set(["expired"]),
  expired: new Set()
};

/** Host-neutral Phase 2 Team Run and temporary Worker lifecycle. */
export class TeamRunCoordinator {
  constructor(readonly store: CoordinationStore) {}

  createRun(input: CreateTeamRunInput): { run: StoredObject; event: AppendedEvent } {
    const leader = this.requireActiveLeader(input.leaderId, input.workspaceId);
    const budget = normalizeBudget(input.budget);
    if (budget.max_workers === 0) throw new BudgetError("INVALID_BUDGET", "max_workers must be at least 1 when configured");
    const runId = createId("run");
    const timestamp = nowIso();
    const run: JsonObject = {
      schema_version: "1.0",
      id: runId,
      type: "team_run",
      workspace_id: input.workspaceId,
      root_objective_id: input.rootObjectiveId,
      objective: input.objective ?? null,
      leader_id: leader.id,
      participant_ids: [leader.id],
      topology: input.topology ?? "dynamic_squad",
      status: "created",
      budget,
      created_at: timestamp,
      updated_at: timestamp
    };
    const event = this.makeEvent({
      type: "team_run.created",
      actorId: leader.id,
      workspaceId: input.workspaceId,
      runId,
      correlationId: input.rootObjectiveId,
      summary: `Created Team Run ${runId} with leader ${leader.id}`
    });
    const result = this.store.atomicMutation({
      preconditions: [{ id: leader.id, kind: "bot", status: "active" }],
      objects: [{ kind: "team_run", payload: validateProtocolObject(run, "team_run") }],
      events: [event]
    });
    return {
      run: requiredAt(result.objects, 0, "created Team Run"),
      event: requiredAt(result.events, 0, "Team Run creation event")
    };
  }

  getRun(runId: string): StoredObject | null {
    const object = this.store.getObject(runId);
    return object?.kind === "team_run" ? object : null;
  }

  listRuns(workspaceId?: string): StoredObject[] {
    return this.store.listObjects("team_run", workspaceId);
  }

  listWorkers(runId: string): StoredObject[] {
    return this.store.listObjects("worker").filter((worker) => String(worker.payload.run_id) === runId);
  }

  getWorker(workerId: string): StoredObject | null {
    const object = this.store.getObject(workerId);
    return object?.kind === "worker" ? object : null;
  }

  createWorker(input: CreateWorkerInput): { worker: StoredObject; run: StoredObject; event: AppendedEvent } {
    const run = this.requireRun(input.runId);
    const runStatus = String(run.payload.status) as TeamRunStatus;
    if (TERMINAL_RUN_STATES.has(runStatus)) throw new Error(`Cannot create Worker for terminal Team Run ${run.id} (${runStatus})`);

    const leaderId = String(run.payload.leader_id ?? "");
    if (input.createdBy !== leaderId) throw new Error(`Only Team Run leader ${leaderId} can create temporary Workers for ${run.id}`);
    const leader = this.requireActiveLeader(leaderId, String(run.payload.workspace_id));
    if (asObject(leader.payload.permissions).can_create_workers === false) {
      throw new Error(`Bot ${leader.id} is not allowed to create temporary Workers`);
    }
    if (!input.roleTitle.trim()) throw new Error("Worker role title cannot be empty");
    if (!input.objective.trim()) throw new Error("Worker objective cannot be empty");

    const currentWorkers = this.listWorkers(run.id).filter((worker) => worker.payload.status !== "expired");
    const runBudget = normalizeBudget(run.payload.budget);
    if (typeof runBudget.max_workers === "number" && currentWorkers.length >= runBudget.max_workers) {
      throw new BudgetError(
        "WORKER_BUDGET_EXCEEDED",
        `Team Run ${run.id} already has ${currentWorkers.length} Workers with a limit of ${runBudget.max_workers}`
      );
    }

    const workerId = input.workerId ?? createId("worker");
    if (!workerId.startsWith("worker_")) throw new Error(`Temporary Worker ID must start with worker_: ${workerId}`);
    if (this.store.getObject(workerId)) throw new Error(`Protocol object ${workerId} already exists`);

    const task = input.taskId ? this.requireWorkerTask(input.taskId, workerId, String(run.payload.workspace_id)) : null;
    const workerBudget = normalizeBudget(input.budget);
    this.assertWorkerBudgetWithinRun(runBudget, workerBudget);
    const timestamp = nowIso();
    const discussionOpeningId = typeof run.payload.discussion_opening_id === "string" ? run.payload.discussion_opening_id : null;
    const worker: JsonObject = {
      schema_version: "1.0",
      id: workerId,
      type: "worker",
      kind: "temporary",
      run_id: run.id,
      task_id: task?.id ?? null,
      created_by: input.createdBy,
      parent_owner_id: leaderId,
      workspace_id: String(run.payload.workspace_id),
      role: { title: input.roleTitle.trim(), objective: input.objective.trim() },
      runtime: input.runtime ?? {},
      capability_lease_id: input.capabilityLeaseId ?? null,
      environment_lease_id: input.environmentLeaseId ?? null,
      budget: workerBudget,
      status: task ? "ready" : "created",
      created_at: timestamp,
      updated_at: timestamp,
      ...(discussionOpeningId ? {
        lifecycle: {
          origin: "discussion_setup",
          discussion_opening_id: discussionOpeningId,
          discussion_opening_reserved_at: run.payload.discussion_opening_reserved_at ?? null
        }
      } : {}),
      ...(input.execution ? { execution: input.execution } : {})
    };
    const updatedRun: JsonObject = {
      ...run.payload,
      participant_ids: [...new Set([...stringArray(run.payload.participant_ids), workerId])],
      updated_at: timestamp
    };
    const event = this.makeEvent({
      type: "worker.created",
      actorId: input.createdBy,
      workspaceId: String(run.payload.workspace_id),
      runId: run.id,
      taskId: task?.id ?? null,
      correlationId: String(run.payload.root_objective_id),
      summary: `Created temporary Worker ${workerId} for Team Run ${run.id}`
    });
    const result = this.store.atomicMutation({
      preconditions: [
        { id: run.id, kind: "team_run", status: runStatus },
        { id: leader.id, kind: "bot", status: "active" }
      ],
      objects: [
        { kind: "team_run", payload: validateProtocolObject(updatedRun, "team_run") },
        { kind: "worker", payload: validateProtocolObject(worker, "worker") }
      ],
      events: [event]
    });
    return {
      run: requiredAt(result.objects, 0, "updated Team Run"),
      worker: requiredAt(result.objects, 1, "created Worker"),
      event: requiredAt(result.events, 0, "Worker creation event")
    };
  }

  attachWorkerTask(workerId: string, taskId: string, actorId: string): { worker: StoredObject; event: AppendedEvent } {
    const worker = this.requireWorker(workerId);
    const run = this.requireRun(String(worker.payload.run_id));
    this.assertLeaderActor(run, actorId);
    const runStatus = String(run.payload.status) as TeamRunStatus;
    if (TERMINAL_RUN_STATES.has(runStatus)) throw new Error(`Cannot bind Task while Team Run ${run.id} is ${runStatus}`);

    const currentTaskId = worker.payload.task_id;
    if (typeof currentTaskId === "string" && currentTaskId.length > 0 && currentTaskId !== taskId) {
      throw new Error(`Worker ${workerId} is already bound to Task ${currentTaskId}`);
    }
    const task = this.requireWorkerTask(taskId, workerId, String(worker.payload.workspace_id));
    const status = String(worker.payload.status) as WorkerStatus;
    if (TERMINAL_WORKER_STATES.has(status)) throw new Error(`Cannot bind Task to terminal Worker ${workerId}`);

    const updated: JsonObject = {
      ...worker.payload,
      task_id: task.id,
      status: status === "created" ? "ready" : status,
      updated_at: nowIso()
    };
    const event = this.makeEvent({
      type: "worker.task_bound",
      actorId,
      workspaceId: String(worker.payload.workspace_id),
      runId: String(worker.payload.run_id),
      taskId,
      correlationId: String(run.payload.root_objective_id),
      summary: `Bound Worker ${workerId} to Task ${taskId}`
    });
    const result = this.store.atomicMutation({
      preconditions: [
        { id: run.id, kind: "team_run", status: runStatus },
        { id: worker.id, kind: "worker", status }
      ],
      objects: [{ kind: "worker", payload: validateProtocolObject(updated, "worker") }],
      events: [event]
    });
    return {
      worker: requiredAt(result.objects, 0, "Task-bound Worker"),
      event: requiredAt(result.events, 0, "Worker Task binding event")
    };
  }

  transitionWorker(workerId: string, targetStatus: WorkerStatus, actorId: string, reason?: string): { worker: StoredObject; event: AppendedEvent } {
    const worker = this.requireWorker(workerId);
    const run = this.requireRun(String(worker.payload.run_id));
    this.assertLeaderActor(run, actorId);
    const runStatus = String(run.payload.status) as TeamRunStatus;
    const current = String(worker.payload.status) as WorkerStatus;
    if (!WORKER_TRANSITIONS[current]?.has(targetStatus)) throw new Error(`Invalid Worker transition ${workerId}: ${current} -> ${targetStatus}`);
    if ((targetStatus === "ready" || targetStatus === "running") && !worker.payload.task_id) {
      throw new Error(`Worker ${workerId} cannot become ${targetStatus} without a bound Task`);
    }
    if (targetStatus === "expired" && !TERMINAL_RUN_STATES.has(runStatus)) {
      throw new Error(`Worker ${workerId} cannot expire while Team Run ${run.id} is active`);
    }
    if (TERMINAL_RUN_STATES.has(runStatus) && targetStatus !== "expired") {
      throw new Error(`Worker ${workerId} cannot transition to ${targetStatus} after Team Run ${run.id} became ${runStatus}`);
    }

    const timestamp = nowIso();
    const updated: JsonObject = {
      ...worker.payload,
      status: targetStatus,
      updated_at: timestamp,
      status_reason: reason ?? null,
      ...(TERMINAL_WORKER_STATES.has(targetStatus) ? { terminal_at: timestamp } : {})
    };
    const event = this.makeEvent({
      type: targetStatus === "expired" ? "worker.expired" : "worker.status_changed",
      actorId,
      workspaceId: String(worker.payload.workspace_id),
      runId: String(worker.payload.run_id),
      taskId: typeof worker.payload.task_id === "string" ? worker.payload.task_id : null,
      correlationId: String(run.payload.root_objective_id),
      summary: `${workerId} changed from ${current} to ${targetStatus}${reason ? `: ${reason}` : ""}`
    });
    const result = this.store.atomicMutation({
      preconditions: [
        { id: run.id, kind: "team_run", status: runStatus },
        { id: worker.id, kind: "worker", status: current }
      ],
      objects: [{ kind: "worker", payload: validateProtocolObject(updated, "worker") }],
      events: [event]
    });
    return {
      worker: requiredAt(result.objects, 0, "transitioned Worker"),
      event: requiredAt(result.events, 0, "Worker transition event")
    };
  }

  transitionRun(runId: string, targetStatus: TeamRunStatus, actorId: string, reason?: string): TeamRunMutationResult {
    const run = this.requireRun(runId);
    this.assertLeaderActor(run, actorId);
    const current = String(run.payload.status) as TeamRunStatus;
    if (!RUN_TRANSITIONS[current]?.has(targetStatus)) throw new Error(`Invalid Team Run transition ${runId}: ${current} -> ${targetStatus}`);

    const workers = this.listWorkers(run.id);
    const activeWorkers = workers.filter((worker) => !TERMINAL_WORKER_STATES.has(String(worker.payload.status) as WorkerStatus));
    if (targetStatus === "completed" && activeWorkers.length > 0) {
      throw new Error(`Team Run ${runId} cannot complete while ${activeWorkers.length} Worker(s) are still active`);
    }
    if (["failed", "canceled", "budget_exhausted"].includes(targetStatus)) {
      const liveWorkerTasks = activeWorkers
        .map((worker) => typeof worker.payload.task_id === "string" ? this.store.getObject(worker.payload.task_id) : null)
        .filter((task): task is StoredObject => Boolean(task && task.kind === "task" && ACTIVE_TASK_STATES.has(String(task.payload.status))));
      if (liveWorkerTasks.length > 0) {
        throw new Error(`Team Run ${runId} cannot become ${targetStatus} while ${liveWorkerTasks.length} Worker Task(s) remain live; cancel them through the execution manager first`);
      }
    }

    const timestamp = nowIso();
    const updatedRun: JsonObject = {
      ...run.payload,
      status: targetStatus,
      updated_at: timestamp,
      status_reason: reason ?? null,
      ...(TERMINAL_RUN_STATES.has(targetStatus) ? { terminal_at: timestamp } : {})
    };
    const objects: Array<{ kind: "team_run" | "worker"; payload: JsonObject }> = [
      { kind: "team_run", payload: validateProtocolObject(updatedRun, "team_run") }
    ];
    const events: CoordinationEvent[] = [this.makeEvent({
      type: "team_run.status_changed",
      actorId,
      workspaceId: String(run.payload.workspace_id),
      runId: run.id,
      correlationId: String(run.payload.root_objective_id),
      summary: `${run.id} changed from ${current} to ${targetStatus}${reason ? `: ${reason}` : ""}`
    })];

    if (["failed", "canceled", "budget_exhausted"].includes(targetStatus)) {
      for (const worker of activeWorkers) {
        objects.push({
          kind: "worker",
          payload: validateProtocolObject({
            ...worker.payload,
            status: "canceled",
            status_reason: `Team Run ${run.id} became ${targetStatus}`,
            terminal_at: timestamp,
            updated_at: timestamp
          }, "worker")
        });
        events.push(this.makeEvent({
          type: "worker.status_changed",
          actorId,
          workspaceId: String(run.payload.workspace_id),
          runId: run.id,
          taskId: typeof worker.payload.task_id === "string" ? worker.payload.task_id : null,
          correlationId: String(run.payload.root_objective_id),
          summary: `${worker.id} canceled because Team Run ${run.id} became ${targetStatus}`
        }));
      }
    }

    const result = this.store.atomicMutation({
      preconditions: [
        { id: run.id, kind: "team_run", status: current },
        ...activeWorkers.map((worker) => ({ id: worker.id, kind: "worker" as const, status: String(worker.payload.status) }))
      ],
      objects,
      events
    });
    return {
      run: requiredAt(result.objects, 0, "transitioned Team Run"),
      workers: result.objects.slice(1),
      events: result.events
    };
  }

  cleanupWorkers(runId: string, actorId: string): { workers: StoredObject[]; events: AppendedEvent[] } {
    const run = this.requireRun(runId);
    this.assertLeaderActor(run, actorId);
    const runStatus = String(run.payload.status) as TeamRunStatus;
    if (!TERMINAL_RUN_STATES.has(runStatus)) throw new Error(`Cannot clean up Workers while Team Run ${runId} is ${runStatus}`);

    const workers = this.listWorkers(runId).filter((worker) => worker.payload.status !== "expired");
    if (workers.length === 0) return { workers: [], events: [] };
    const timestamp = nowIso();
    const objects = workers.map((worker) => ({
      kind: "worker" as const,
      payload: validateProtocolObject({ ...worker.payload, status: "expired", expired_at: timestamp, updated_at: timestamp }, "worker")
    }));
    const events = workers.map((worker) => this.makeEvent({
      type: "worker.expired",
      actorId,
      workspaceId: String(run.payload.workspace_id),
      runId,
      taskId: typeof worker.payload.task_id === "string" ? worker.payload.task_id : null,
      correlationId: String(run.payload.root_objective_id),
      summary: `Expired temporary Worker ${worker.id} after Team Run ${runId} reached ${runStatus}`
    }));
    const result = this.store.atomicMutation({
      preconditions: [
        { id: run.id, kind: "team_run", status: runStatus },
        ...workers.map((worker) => ({ id: worker.id, kind: "worker" as const, status: String(worker.payload.status) }))
      ],
      objects,
      events
    });
    return { workers: result.objects, events: result.events };
  }

  private requireRun(runId: string): StoredObject {
    const run = this.store.getObject(runId);
    if (!run || run.kind !== "team_run") throw new Error(`Team Run ${runId} not found`);
    return run;
  }

  private requireWorker(workerId: string): StoredObject {
    const worker = this.store.getObject(workerId);
    if (!worker || worker.kind !== "worker") throw new Error(`Worker ${workerId} not found`);
    return worker;
  }

  private requireActiveLeader(leaderId: string, workspaceId: string): StoredObject {
    const leader = this.store.getObject(leaderId);
    if (!leader || leader.kind !== "bot") throw new Error(`Team Run leader ${leaderId} must be a durable Bot`);
    if (leader.payload.status !== "active") throw new Error(`Team Run leader ${leaderId} must be active`);
    if (leader.workspaceId !== workspaceId) throw new Error(`Team Run leader ${leaderId} is outside workspace ${workspaceId}`);
    return leader;
  }

  private assertLeaderActor(run: StoredObject, actorId: string): void {
    const leaderId = String(run.payload.leader_id ?? "");
    if (actorId !== leaderId) throw new Error(`Only Team Run leader ${leaderId} can mutate ${run.id}`);
    this.requireActiveLeader(leaderId, String(run.payload.workspace_id));
  }

  private requireWorkerTask(taskId: string, workerId: string, workspaceId: string): StoredObject {
    const task = this.store.getObject(taskId);
    if (!task || task.kind !== "task") throw new Error(`Worker Task ${taskId} not found`);
    if (task.workspaceId !== workspaceId) throw new Error(`Worker Task ${taskId} is outside workspace ${workspaceId}`);
    if (String(task.payload.assignee_id ?? "") !== workerId || String(task.payload.owner_id ?? "") !== workerId) {
      throw new Error(`Worker Task ${taskId} must be assigned to and owned by ${workerId}`);
    }
    if (!ACTIVE_TASK_STATES.has(String(task.payload.status))) throw new Error(`Worker Task ${taskId} is not active`);
    return task;
  }

  private assertWorkerBudgetWithinRun(runBudget: BudgetEnvelope, workerBudget: BudgetEnvelope): void {
    for (const key of ["token_limit", "cost_limit", "wall_clock_seconds", "max_hops", "max_messages", "max_rounds", "max_tasks", "max_actions"] as const) {
      const runLimit = runBudget[key];
      const workerLimit = workerBudget[key];
      if (typeof runLimit === "number" && typeof workerLimit === "number" && workerLimit > runLimit) {
        throw new BudgetError("WORKER_BUDGET_EXPANSION", `Worker ${key} ${workerLimit} exceeds Team Run limit ${runLimit}`);
      }
    }
  }

  private makeEvent(input: {
    type: string;
    actorId: string;
    workspaceId: string;
    runId: string;
    taskId?: string | null;
    correlationId?: string | null;
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
      correlation_id: input.correlationId ?? null,
      summary: input.summary
    };
  }
}
