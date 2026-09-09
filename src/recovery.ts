import { createId } from "./id.js";
import { ExecutionQueue, type ExecutionRecord, type StaleExecution } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { CoordinationStore } from "./store.js";
import type { AppendedEvent, CoordinationEvent, JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

const TERMINAL_TASK_STATES = new Set(["completed", "failed", "canceled"]);

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

export type RecoveryAction = "requeued" | "dead_letter" | "reconciled";

export interface RecoveryDecision {
  action: RecoveryAction;
  execution: ExecutionRecord;
  task: StoredObject | null;
  events: AppendedEvent[];
}

export interface RetryDecision {
  execution: ExecutionRecord;
  task: StoredObject;
  events: AppendedEvent[];
}

export class RecoveryCoordinator {
  constructor(
    readonly store: CoordinationStore,
    readonly queue: ExecutionQueue,
    readonly gateway?: CoordinationGateway
  ) {}

  listDeadLetters(workspaceId?: string): ExecutionRecord[] {
    return this.queue.listDeadLetters(workspaceId);
  }

  recoverStale(now = Date.now()): RecoveryDecision[] {
    const decisions: RecoveryDecision[] = [];
    for (const stale of this.queue.listStale(now)) {
      const decision = this.recoverOne(stale, now);
      if (decision) decisions.push(decision);
    }
    return decisions;
  }

  retryDeadLetter(taskId: string, actorId: string, reason = "Operator authorized recovery retry"): RetryDecision {
    this.assertOperator(actorId);
    const execution = this.queue.getByItem(taskId);
    if (!execution || execution.state !== "dead_letter") throw new Error(`Task ${taskId} has no dead-letter execution`);
    const task = this.store.getObject(taskId);
    if (!task || task.kind !== "task") throw new Error(`Dead-letter Task ${taskId} not found`);
    if (task.payload.status !== "blocked") throw new Error(`Dead-letter Task ${taskId} is ${String(task.payload.status)}, expected blocked`);

    const timestamp = nowIso();
    const assignedPayload = validateProtocolObject({
      ...task.payload,
      status: "assigned",
      recovery_required: false,
      recovery_retry_authorized_by: actorId,
      recovery_retry_authorized_at: timestamp,
      recovery_retry_reason: reason
    }, "task");
    const event = this.buildEvent({
      type: "execution.retry_authorized",
      actorId,
      workspaceId: execution.workspaceId,
      taskId,
      correlationId: String(task.payload.root_objective_id),
      summary: reason
    });

    const mutation = this.store.atomicMutation({
      preconditions: [{ id: task.id, kind: "task", status: "blocked", ownerId: String(task.payload.owner_id) }],
      objects: [{ kind: "task", payload: assignedPayload }],
      events: [event],
      queueTransition: {
        itemId: taskId,
        fromStates: ["dead_letter"],
        toState: "queued",
        clearClaim: true,
        lastError: reason,
        required: true
      }
    });
    const assigned = mutation.objects[0];
    const queued = this.queue.getByItem(taskId);
    if (!assigned || !queued) throw new Error(`Retry authorization for ${taskId} committed without expected records`);
    return { execution: queued, task: assigned, events: mutation.events };
  }

  private recoverOne(stale: StaleExecution, now: number): RecoveryDecision | null {
    const task = this.store.getObject(stale.itemId);
    if (!task || task.kind !== "task") return this.deadLetterMissingTask(stale, now);

    const taskStatus = String(task.payload.status);
    if (TERMINAL_TASK_STATES.has(taskStatus)) return this.reconcileTerminal(stale, task, taskStatus, now);

    if (stale.recoveryPolicy === "retry_safe" && stale.attempts < stale.maxAttempts) {
      return this.requeueReplaySafe(stale, task, now);
    }
    return this.deadLetter(stale, task, now, stale.recoveryPolicy === "retry_safe"
      ? `Execution ${stale.id} exhausted ${stale.maxAttempts} attempts`
      : `Execution ${stale.id} became stale and is not declared replay-safe`);
  }

  private requeueReplaySafe(stale: StaleExecution, task: StoredObject, now: number): RecoveryDecision {
    if (!new Set(["assigned", "running"]).has(String(task.payload.status))) {
      return this.deadLetter(stale, task, now, `Task ${task.id} is ${String(task.payload.status)} and cannot be safely auto-requeued`);
    }
    const timestamp = nowIso(now);
    const assignedPayload = validateProtocolObject({
      ...task.payload,
      status: "assigned",
      recovered_from_status: task.payload.status,
      recovery_required: false,
      recovered_at: timestamp,
      recovered_execution_id: stale.id,
      recovered_runner_id: stale.claimedBy
    }, "task");
    const reason = `Recovered stale replay-safe execution ${stale.id}; attempt ${stale.attempts} of ${stale.maxAttempts}`;
    const event = this.buildEvent({
      type: "execution.requeued",
      actorId: "system_recovery",
      workspaceId: stale.workspaceId,
      taskId: task.id,
      correlationId: String(task.payload.root_objective_id),
      summary: reason
    });
    const mutation = this.store.atomicMutation({
      preconditions: [{ id: task.id, kind: "task", status: String(task.payload.status), ownerId: String(task.payload.owner_id) }],
      objects: [{ kind: "task", payload: assignedPayload }],
      events: [event],
      queueTransition: {
        itemId: stale.itemId,
        fromStates: [stale.state],
        toState: "queued",
        expectedClaimedBy: stale.claimedBy,
        expectedLeaseExpiresAt: stale.leaseExpiresAt,
        clearClaim: true,
        lastError: reason,
        required: true
      }
    });
    const assigned = mutation.objects[0];
    const queued = this.queue.getByItem(stale.itemId);
    if (!assigned || !queued) throw new Error(`Recovery of ${stale.id} committed without expected records`);
    return { action: "requeued", execution: queued, task: assigned, events: mutation.events };
  }

  private deadLetter(stale: StaleExecution, task: StoredObject, now: number, reason: string): RecoveryDecision {
    const timestamp = nowIso(now);
    const blockedPayload = validateProtocolObject({
      ...task.payload,
      status: "blocked",
      recovery_required: true,
      recovery_previous_status: task.payload.status,
      recovery_detected_at: timestamp,
      recovery_reason: reason,
      recovery_execution_id: stale.id,
      recovery_runner_id: stale.claimedBy
    }, "task");
    const event = this.buildEvent({
      type: "execution.dead_letter",
      actorId: "system_recovery",
      workspaceId: stale.workspaceId,
      taskId: task.id,
      correlationId: String(task.payload.root_objective_id),
      summary: reason,
      attentionState: "failed"
    });
    const mutation = this.store.atomicMutation({
      preconditions: [{ id: task.id, kind: "task", status: String(task.payload.status), ownerId: String(task.payload.owner_id) }],
      objects: [{ kind: "task", payload: blockedPayload }],
      events: [event],
      queueTransition: {
        itemId: stale.itemId,
        fromStates: [stale.state],
        toState: "dead_letter",
        expectedClaimedBy: stale.claimedBy,
        expectedLeaseExpiresAt: stale.leaseExpiresAt,
        clearClaim: true,
        lastError: reason,
        required: true
      }
    });
    const blocked = mutation.objects[0];
    const dead = this.queue.getByItem(stale.itemId);
    if (!blocked || !dead) throw new Error(`Dead-letter transition for ${stale.id} committed without expected records`);
    return { action: "dead_letter", execution: dead, task: blocked, events: mutation.events };
  }

  private deadLetterMissingTask(stale: StaleExecution, now: number): RecoveryDecision {
    const reason = `Execution ${stale.id} references missing Task ${stale.itemId}`;
    const event = this.buildEvent({
      type: "execution.dead_letter",
      actorId: "system_recovery",
      workspaceId: stale.workspaceId,
      taskId: stale.itemId,
      summary: reason,
      attentionState: "failed",
      timestamp: nowIso(now)
    });
    const mutation = this.store.atomicMutation({
      objects: [],
      events: [event],
      queueTransition: {
        itemId: stale.itemId,
        fromStates: [stale.state],
        toState: "dead_letter",
        expectedClaimedBy: stale.claimedBy,
        expectedLeaseExpiresAt: stale.leaseExpiresAt,
        clearClaim: true,
        lastError: reason,
        required: true
      }
    });
    const dead = this.queue.getByItem(stale.itemId);
    if (!dead) throw new Error(`Missing-Task dead-letter transition for ${stale.id} did not persist`);
    return { action: "dead_letter", execution: dead, task: null, events: mutation.events };
  }

  private reconcileTerminal(stale: StaleExecution, task: StoredObject, taskStatus: string, now: number): RecoveryDecision {
    const queueState = taskStatus === "completed" ? "completed" : taskStatus === "canceled" ? "canceled" : "failed";
    const reason = `Reconciled stale execution ${stale.id} to terminal Task state ${taskStatus}`;
    const event = this.buildEvent({
      type: "execution.reconciled",
      actorId: "system_recovery",
      workspaceId: stale.workspaceId,
      taskId: task.id,
      correlationId: String(task.payload.root_objective_id),
      summary: reason,
      timestamp: nowIso(now)
    });
    const mutation = this.store.atomicMutation({
      preconditions: [{ id: task.id, kind: "task", status: taskStatus }],
      objects: [],
      events: [event],
      queueTransition: {
        itemId: stale.itemId,
        fromStates: [stale.state],
        toState: queueState,
        expectedClaimedBy: stale.claimedBy,
        expectedLeaseExpiresAt: stale.leaseExpiresAt,
        clearClaim: true,
        lastError: reason,
        required: true
      }
    });
    const reconciled = this.queue.getByItem(stale.itemId);
    if (!reconciled) throw new Error(`Terminal reconciliation for ${stale.id} did not persist`);
    return { action: "reconciled", execution: reconciled, task, events: mutation.events };
  }

  private buildEvent(input: {
    type: string;
    actorId: string;
    workspaceId?: string | null;
    taskId?: string | null;
    correlationId?: string | null;
    summary?: string | null;
    attentionState?: string;
    timestamp?: string;
  }): CoordinationEvent {
    const event: JsonObject = {
      schema_version: "1.0",
      id: createId("evt"),
      type: input.type,
      timestamp: input.timestamp ?? nowIso(),
      actor_id: input.actorId,
      workspace_id: input.workspaceId ?? null,
      task_id: input.taskId ?? null,
      correlation_id: input.correlationId ?? null,
      summary: input.summary ?? null,
      attention_state: input.attentionState ?? "none"
    };
    return validateProtocolObject(event, "event") as CoordinationEvent;
  }

  private assertOperator(actorId: string): void {
    if (!actorId.startsWith("operator_")) throw new Error(`Only an operator can authorize dead-letter retry; got ${actorId}`);
  }
}