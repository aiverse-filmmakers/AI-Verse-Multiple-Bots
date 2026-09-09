import { createId } from "./id.js";
import type { ExecutionQueue, ExecutionRecord } from "./execution-queue.js";
import type { CoordinationGateway } from "./gateway.js";
import type { CoordinationStore } from "./store.js";
import type { TeamRunCoordinator } from "./team-runs.js";
import type { CoordinationEvent, JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

const TERMINAL_RUN_STATES = new Set(["completed", "failed", "canceled", "budget_exhausted"]);
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "canceled"]);

function nowIso(): string {
  return new Date().toISOString();
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export interface ScheduleManagerWorkerInput {
  runId: string;
  workerId: string;
  actorId: string;
}

export interface ManagerScheduleResult {
  run: StoredObject;
  worker: StoredObject;
  task: StoredObject;
  execution: ExecutionRecord;
  events: Array<{ sequence: number; roomSequence: number | null; runSequence: number | null; event: CoordinationEvent }>;
}

export interface ManagerReconciliationResult {
  run: StoredObject;
  worker: StoredObject;
  task: StoredObject;
}

export class ManagerTopologyCoordinator {
  constructor(
    readonly store: CoordinationStore,
    readonly gateway: CoordinationGateway,
    readonly teamRuns: TeamRunCoordinator,
    readonly queue: ExecutionQueue
  ) {}

  getState(runId: string): JsonObject {
    const run = this.requireManagerRun(runId);
    return this.managerState(run);
  }

  schedule(input: ScheduleManagerWorkerInput): ManagerScheduleResult {
    this.reconcileRun(input.runId);
    const run = this.requireManagerRun(input.runId);
    if (String(run.payload.status) !== "running") {
      throw new Error(`Manager Team Run ${run.id} can schedule specialists only while running`);
    }
    const leaderId = String(run.payload.leader_id ?? "");
    this.assertManagerActor(input.actorId, leaderId);

    const worker = this.requireWorker(input.workerId);
    if (worker.workspaceId !== run.workspaceId || String(worker.payload.run_id) !== run.id) {
      throw new Error(`Worker ${worker.id} is outside Manager Team Run ${run.id}`);
    }
    if (String(worker.payload.parent_owner_id) !== leaderId) {
      throw new Error(`Worker ${worker.id} is not supervised by Team Run leader ${leaderId}`);
    }
    if (String(worker.payload.status) !== "created") {
      throw new Error(`Worker ${worker.id} cannot be manager-scheduled from status ${String(worker.payload.status)}`);
    }

    const task = this.requireTask(String(worker.payload.task_id ?? ""));
    if (task.workspaceId !== run.workspaceId || String(task.payload.run_id) !== run.id) {
      throw new Error(`Worker ${worker.id} Task ${task.id} is outside Manager Team Run ${run.id}`);
    }
    if (String(task.payload.owner_id) !== worker.id || String(task.payload.assignee_id) !== worker.id) {
      throw new Error(`Manager specialist Task ${task.id} must remain owned and assigned to Worker ${worker.id}`);
    }
    if (String(task.payload.root_owner_id) !== leaderId) {
      throw new Error(`Manager specialist Task ${task.id} does not preserve leader ${leaderId} as root owner`);
    }
    if (String(task.payload.status) !== "created" || String(task.payload.execution_state ?? "") !== "not_scheduled") {
      throw new Error(`Manager specialist Task ${task.id} is already scheduled or no longer pending`);
    }
    if (this.queue.getByItem(task.id)) throw new Error(`Manager specialist Task ${task.id} already has execution state`);

    const currentState = this.managerState(run);
    const activeTaskId = typeof currentState.active_task_id === "string" ? currentState.active_task_id : null;
    const activeWorkerId = typeof currentState.active_worker_id === "string" ? currentState.active_worker_id : null;
    if (activeTaskId || activeWorkerId) {
      throw new Error(`Manager Team Run ${run.id} already has active specialist ${activeWorkerId ?? activeTaskId}`);
    }

    const sequence = Number(currentState.sequence ?? 0) + 1;
    const timestamp = nowIso();
    const nextState: JsonObject = {
      ...currentState,
      supervisor_id: leaderId,
      sequence,
      active_worker_id: worker.id,
      active_task_id: task.id,
      phase: "specialist_scheduled",
      updated_at: timestamp
    };
    const runPayload = validateProtocolObject({ ...run.payload, manager_state: nextState, updated_at: timestamp }, "team_run");
    const workerPayload = validateProtocolObject({
      ...worker.payload,
      status: "ready",
      supervised_by: leaderId,
      manager_sequence: sequence,
      scheduled_at: timestamp
    }, "worker");
    const taskPayload = validateProtocolObject({
      ...task.payload,
      status: "assigned",
      execution_state: "scheduled",
      supervisor_id: leaderId,
      manager_sequence: sequence,
      assigned_at: timestamp
    }, "task");

    const preparedEvents = [
      this.event(run, "manager.specialist_scheduled", input.actorId, task.id, `Manager ${leaderId} scheduled Worker ${worker.id} as specialist ${sequence}`),
      this.event(run, "worker.ready", input.actorId, task.id, `Worker ${worker.id} is ready for manager-supervised execution`),
      this.event(run, "task.assigned", input.actorId, task.id, `Manager specialist Task ${task.id} assigned to ${worker.id}`)
    ];
    const executionId = createId("exec");
    const mutation = this.store.atomicMutation({
      preconditions: [
        { id: run.id, kind: "team_run", status: "running" },
        { id: worker.id, kind: "worker", status: "created" },
        { id: task.id, kind: "task", status: "created", ownerId: worker.id }
      ],
      objects: [
        { kind: "team_run", payload: runPayload },
        { kind: "worker", payload: workerPayload },
        { kind: "task", payload: taskPayload }
      ],
      events: preparedEvents,
      queueInsert: {
        id: executionId,
        itemKind: "task",
        itemId: task.id,
        targetId: worker.id,
        workspaceId: String(run.workspaceId),
        state: "queued",
        attempts: 0,
        maxAttempts: 1,
        recoveryPolicy: "manual",
        createdAt: timestamp,
        updatedAt: timestamp,
        required: this.store.dbPath !== ":memory:"
      }
    });

    let execution = this.queue.getByItem(task.id);
    if (!execution) execution = this.queue.enqueueTask(task.id, worker.id, String(run.workspaceId));
    this.gateway.events.publishCommitted(mutation.events);

    const byId = new Map(mutation.objects.map((object) => [object.id, object]));
    const storedRun = byId.get(run.id);
    const storedWorker = byId.get(worker.id);
    const storedTask = byId.get(task.id);
    if (!storedRun || !storedWorker || !storedTask || !execution) {
      throw new Error(`Manager specialist ${worker.id} scheduling committed incompletely`);
    }
    return { run: storedRun, worker: storedWorker, task: storedTask, execution, events: mutation.events };
  }

  reconcileTask(taskId: string, actorId = "system_supervisor"): ManagerReconciliationResult | null {
    const task = this.store.getObject(taskId);
    if (!task || task.kind !== "task" || typeof task.payload.run_id !== "string") return null;
    const run = this.teamRuns.getRun(task.payload.run_id);
    if (!run || String(run.payload.topology) !== "manager") return null;
    const worker = this.store.getObject(String(task.payload.assignee_id ?? ""));
    if (!worker || worker.kind !== "worker") return null;
    if (worker.workspaceId !== run.workspaceId || String(worker.payload.run_id) !== run.id || String(worker.payload.task_id) !== task.id) {
      throw new Error(`Manager reconciliation rejected mismatched Worker ${worker.id} and Task ${task.id}`);
    }

    const taskStatus = String(task.payload.status);
    const desiredWorkerStatus = taskStatus === "assigned"
      ? "ready"
      : taskStatus === "running"
        ? "running"
        : taskStatus === "completed"
          ? "completed"
          : taskStatus === "failed"
            ? "failed"
            : taskStatus === "canceled"
              ? "canceled"
              : null;
    if (!desiredWorkerStatus) return null;

    const state = this.managerState(run);
    const currentWorkerStatus = String(worker.payload.status);
    const timestamp = nowIso();
    let nextState: JsonObject = { ...state, supervisor_id: String(run.payload.leader_id), updated_at: timestamp };
    let managerEventType: string | null = null;
    let managerSummary: string | null = null;

    if (taskStatus === "assigned" || taskStatus === "running") {
      const activeTaskId = typeof state.active_task_id === "string" ? state.active_task_id : null;
      const activeWorkerId = typeof state.active_worker_id === "string" ? state.active_worker_id : null;
      if ((activeTaskId && activeTaskId !== task.id) || (activeWorkerId && activeWorkerId !== worker.id)) {
        throw new Error(`Manager Team Run ${run.id} has a different active specialist`);
      }
      nextState = {
        ...nextState,
        active_task_id: task.id,
        active_worker_id: worker.id,
        phase: taskStatus === "running" ? "specialist_running" : "specialist_scheduled"
      };
      if (taskStatus === "running" && currentWorkerStatus !== "running") {
        managerEventType = "manager.specialist_started";
        managerSummary = `Manager specialist Worker ${worker.id} started Task ${task.id}`;
      }
    } else if (TERMINAL_TASK_STATES.has(taskStatus)) {
      const activeTaskId = typeof state.active_task_id === "string" ? state.active_task_id : null;
      const activeWorkerId = typeof state.active_worker_id === "string" ? state.active_worker_id : null;
      if ((activeTaskId && activeTaskId !== task.id) || (activeWorkerId && activeWorkerId !== worker.id)) {
        throw new Error(`Manager Team Run ${run.id} cannot settle ${worker.id}; another specialist is active`);
      }
      const completed = stringArray(state.completed_worker_ids);
      const failed = stringArray(state.failed_worker_ids);
      const canceled = stringArray(state.canceled_worker_ids);
      if (taskStatus === "completed") completed.push(worker.id);
      if (taskStatus === "failed") failed.push(worker.id);
      if (taskStatus === "canceled") canceled.push(worker.id);
      nextState = {
        ...nextState,
        active_task_id: null,
        active_worker_id: null,
        phase: "awaiting_specialist",
        completed_worker_ids: unique(completed),
        failed_worker_ids: unique(failed),
        canceled_worker_ids: unique(canceled),
        last_settled_task_id: task.id,
        last_settled_worker_id: worker.id,
        last_outcome: taskStatus
      };
      managerEventType = `manager.specialist_${taskStatus}`;
      managerSummary = `Manager specialist Worker ${worker.id} settled Task ${task.id} as ${taskStatus}`;
    }

    const workerPayload = validateProtocolObject({
      ...worker.payload,
      status: desiredWorkerStatus,
      ...(desiredWorkerStatus === "running" && typeof worker.payload.started_at !== "string" ? { started_at: timestamp } : {}),
      ...(TERMINAL_TASK_STATES.has(taskStatus) ? { ended_at: timestamp } : {})
    }, "worker");
    const runPayload = validateProtocolObject({ ...run.payload, manager_state: nextState, updated_at: timestamp }, "team_run");

    const workerChanged = currentWorkerStatus !== desiredWorkerStatus;
    const stateChanged = JSON.stringify(state) !== JSON.stringify(nextState);
    if (!workerChanged && !stateChanged) return { run, worker, task };

    const events: CoordinationEvent[] = [];
    if (workerChanged) {
      events.push(this.event(run, `worker.${desiredWorkerStatus}`, actorId, task.id, `Worker ${worker.id} reconciled from Task ${task.id} status ${taskStatus}`));
    }
    if (managerEventType && managerSummary) events.push(this.event(run, managerEventType, actorId, task.id, managerSummary));

    const mutation = this.store.atomicMutation({
      preconditions: [
        { id: run.id, kind: "team_run", status: String(run.payload.status) },
        { id: worker.id, kind: "worker", status: currentWorkerStatus },
        { id: task.id, kind: "task", status: taskStatus, ownerId: worker.id }
      ],
      objects: [
        { kind: "team_run", payload: runPayload },
        { kind: "worker", payload: workerPayload }
      ],
      events
    });
    this.gateway.events.publishCommitted(mutation.events);
    const storedRun = mutation.objects.find((object) => object.id === run.id);
    const storedWorker = mutation.objects.find((object) => object.id === worker.id);
    if (!storedRun || !storedWorker) throw new Error(`Manager reconciliation for ${task.id} committed incompletely`);
    return { run: storedRun, worker: storedWorker, task };
  }

  reconcileRun(runId: string): StoredObject {
    const run = this.requireManagerRun(runId);
    const state = this.managerState(run);
    const activeTaskId = typeof state.active_task_id === "string" ? state.active_task_id : null;
    if (!activeTaskId) return run;
    const task = this.store.getObject(activeTaskId);
    if (!task || task.kind !== "task") throw new Error(`Manager Team Run ${run.id} active Task ${activeTaskId} was not found`);

    if (String(task.payload.status) === "assigned" && !this.queue.getByItem(task.id)) {
      const workerId = String(task.payload.assignee_id ?? "");
      this.queue.enqueueTask(task.id, workerId, String(run.workspaceId));
      this.gateway.events.publish(this.event(run, "manager.execution_recovered", "system_supervisor", task.id, `Recovered missing execution queue entry for ${task.id}`));
    }
    const reconciled = this.reconcileTask(task.id);
    return reconciled?.run ?? this.requireManagerRun(runId);
  }

  reconcileAll(): void {
    for (const run of this.teamRuns.listRuns()) {
      if (String(run.payload.topology) !== "manager") continue;
      if (TERMINAL_RUN_STATES.has(String(run.payload.status))) continue;
      try {
        this.reconcileRun(run.id);
      } catch (error) {
        this.gateway.events.publish(this.event(
          run,
          "manager.reconciliation_failed",
          "system_supervisor",
          typeof asObject(run.payload.manager_state).active_task_id === "string" ? String(asObject(run.payload.manager_state).active_task_id) : undefined,
          error instanceof Error ? error.message : String(error),
          "failed"
        ));
      }
    }
  }

  private managerState(run: StoredObject): JsonObject {
    const state = asObject(run.payload.manager_state);
    return {
      supervisor_id: typeof state.supervisor_id === "string" ? state.supervisor_id : String(run.payload.leader_id ?? ""),
      sequence: Number.isInteger(state.sequence) && Number(state.sequence) >= 0 ? Number(state.sequence) : 0,
      active_worker_id: typeof state.active_worker_id === "string" ? state.active_worker_id : null,
      active_task_id: typeof state.active_task_id === "string" ? state.active_task_id : null,
      completed_worker_ids: unique(stringArray(state.completed_worker_ids)),
      failed_worker_ids: unique(stringArray(state.failed_worker_ids)),
      canceled_worker_ids: unique(stringArray(state.canceled_worker_ids)),
      ...(typeof state.phase === "string" ? { phase: state.phase } : {}),
      ...(typeof state.last_settled_task_id === "string" ? { last_settled_task_id: state.last_settled_task_id } : {}),
      ...(typeof state.last_settled_worker_id === "string" ? { last_settled_worker_id: state.last_settled_worker_id } : {}),
      ...(typeof state.last_outcome === "string" ? { last_outcome: state.last_outcome } : {})
    };
  }

  private requireManagerRun(runId: string): StoredObject {
    const run = this.teamRuns.getRun(runId);
    if (!run) throw new Error(`Team Run ${runId} not found`);
    if (String(run.payload.topology) !== "manager") throw new Error(`Team Run ${run.id} uses topology ${String(run.payload.topology)}, not manager`);
    return run;
  }

  private requireWorker(workerId: string): StoredObject {
    const worker = this.store.getObject(workerId);
    if (!worker || worker.kind !== "worker") throw new Error(`Worker ${workerId} not found`);
    return worker;
  }

  private requireTask(taskId: string): StoredObject {
    const task = this.store.getObject(taskId);
    if (!task || task.kind !== "task") throw new Error(`Task ${taskId} not found`);
    return task;
  }

  private assertManagerActor(actorId: string, leaderId: string): void {
    if (actorId === leaderId || actorId.startsWith("operator_")) return;
    throw new Error(`Only Manager Team Run leader ${leaderId} or an operator can schedule specialists`);
  }

  private event(
    run: StoredObject,
    type: string,
    actorId: string,
    taskId: string | undefined,
    summary: string,
    attentionState?: string
  ): CoordinationEvent {
    return this.gateway.events.prepare({
      schema_version: "1.0",
      id: createId("evt"),
      type,
      timestamp: nowIso(),
      actor_id: actorId,
      workspace_id: run.workspaceId,
      run_id: run.id,
      task_id: taskId ?? null,
      room_id: null,
      thread_id: null,
      correlation_id: String(run.payload.root_objective_id),
      causation_id: null,
      trace_id: null,
      summary,
      ...(attentionState ? { attention_state: attentionState } : {})
    });
  }
}
