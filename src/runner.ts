import { assertUsageWithinBudget, BudgetError, effectiveDeadline } from "./budget.js";
import { createId } from "./id.js";
import { ExecutionOwnershipError, ExecutionQueue, type ExecutionRecord } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { CoordinationLoopError, progressFingerprint } from "./loop-guard.js";
import { RuntimeRegistry, type RuntimeAdapter, type RuntimeExecutionContext, type RuntimeExecutionResult } from "./runtime.js";
import { CoordinationStore } from "./store.js";
import type { AppendedEvent, JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

function nowIso(): string {
  return new Date().toISOString();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

const TERMINAL_TASK_STATES = new Set(["completed", "failed", "canceled"]);

class TaskCancellationError extends Error {
  constructor(readonly code: "CANCELED" | "DEADLINE_EXCEEDED", message: string) {
    super(message);
    this.name = "TaskCancellationError";
  }
}

export interface RunResult {
  execution: ExecutionRecord;
  task: StoredObject;
  artifact: StoredObject | null;
  status: "completed" | "failed" | "canceled";
}

export interface CancelResult {
  tasks: StoredObject[];
  events: AppendedEvent[];
}

interface ActiveExecution {
  controller: AbortController;
  adapter: RuntimeAdapter;
  executionId: string;
}

export class BotRunner {
  private readonly active = new Map<string, ActiveExecution>();

  constructor(
    readonly store: CoordinationStore,
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue,
    readonly runtimes: RuntimeRegistry,
    readonly runnerId = createId("runner"),
    readonly executionLeaseSeconds = 30,
    readonly heartbeatIntervalMs = Math.max(100, Math.floor(executionLeaseSeconds * 1000 / 3))
  ) {}

  async cancelTask(taskId: string, actorId: string, reason = "Canceled by operator or owner"): Promise<CancelResult> {
    const task = this.store.getObject(taskId);
    if (!task || task.kind !== "task") throw new Error(`Task ${taskId} not found`);
    this.assertCanCancel(task, actorId);

    const tasks: StoredObject[] = [];
    const events: AppendedEvent[] = [];
    await this.cancelTree(task, actorId, reason, tasks, events, new Set<string>());
    return { tasks, events };
  }

  async runNext(botId: string): Promise<RunResult | null> {
    const bot = this.gateway.getBot(botId);
    if (!bot) throw new Error(`Bot ${botId} not found`);
    if (bot.payload.status !== "active") throw new Error(`Bot ${botId} is not active`);

    const adapterId = String(bot.payload.runtime.adapter);
    if (!this.runtimes.has(adapterId)) {
      throw new Error(`Runtime adapter ${adapterId} is not registered`);
    }

    const claimed = this.queue.claimNext(botId, this.runnerId, this.executionLeaseSeconds);
    if (!claimed) return null;

    if (claimed.itemKind !== "task") {
      this.queue.finishOwned(claimed.id, this.runnerId, "failed", `Unsupported execution kind ${claimed.itemKind}`);
      throw new Error(`Unsupported execution kind ${claimed.itemKind}`);
    }

    const task = this.store.getObject(claimed.itemId);
    if (!task || task.kind !== "task") {
      this.queue.finishOwned(claimed.id, this.runnerId, "failed", `Task ${claimed.itemId} not found`);
      throw new Error(`Task ${claimed.itemId} not found`);
    }

    try {
      if (task.payload.assignee_id !== botId) {
        throw new Error(`Task ${task.id} is assigned to ${String(task.payload.assignee_id)}, not ${botId}`);
      }
      if (task.payload.owner_id !== botId) {
        throw new Error(`Task ${task.id} is owned by ${String(task.payload.owner_id)}, not ${botId}`);
      }
      if (task.payload.status !== "assigned") {
        throw new Error(`Task ${task.id} is not executable from status ${String(task.payload.status)}`);
      }

      const explicitDeadlineAt = typeof task.payload.deadline_at === "string" ? task.payload.deadline_at : null;
      const explicitDeadlineMs = explicitDeadlineAt ? Date.parse(explicitDeadlineAt) : null;
      if (explicitDeadlineMs !== null && (!Number.isFinite(explicitDeadlineMs) || explicitDeadlineMs <= Date.now())) {
        throw new TaskCancellationError("DEADLINE_EXCEEDED", `Task ${task.id} deadline has elapsed`);
      }

      const leaseId = String(task.payload.lease_id);
      const lease = this.store.getObject(leaseId);
      if (!lease || lease.kind !== "capability_lease") throw new Error(`Capability lease ${leaseId} not found`);
      if (lease.payload.issued_to !== botId) throw new Error(`Capability lease ${leaseId} is not issued to ${botId}`);
      if (lease.payload.task_id !== task.id) throw new Error(`Capability lease ${leaseId} is not scoped to task ${task.id}`);
      const expiresAt = Date.parse(String(lease.payload.expires_at));
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error(`Capability lease ${leaseId} is expired`);

      let environmentLease: StoredObject | null = null;
      if (typeof task.payload.environment_lease_id === "string" && task.payload.environment_lease_id.length > 0) {
        environmentLease = this.store.getObject(task.payload.environment_lease_id);
        if (!environmentLease || environmentLease.kind !== "environment_lease") {
          throw new Error(`Environment lease ${String(task.payload.environment_lease_id)} not found`);
        }
      }

      const inputArtifacts = stringArray(task.payload.input_artifact_refs)
        .map((id) => this.store.getObject(id))
        .filter((item): item is StoredObject => Boolean(item && item.kind === "artifact"));

      this.queue.markRunning(claimed.id, this.runnerId, this.executionLeaseSeconds);
      const startedAtMs = Date.now();
      const runningTaskPayload: JsonObject = {
        ...task.payload,
        status: "running",
        started_at: new Date(startedAtMs).toISOString(),
        execution_runner_id: this.runnerId,
        execution_attempt: claimed.attempts
      };
      const runningTask = this.store.putObject("task", validateProtocolObject(runningTaskPayload, "task"));
      this.gateway.emit({
        type: "task.started",
        actorId: botId,
        workspaceId: claimed.workspaceId,
        taskId: task.id,
        correlationId: String(task.payload.root_objective_id),
        summary: `${botId} started ${task.id}`
      });

      const adapter = this.runtimes.get(adapterId);
      const controller = new AbortController();
      this.active.set(task.id, { controller, adapter, executionId: claimed.id });
      const context: RuntimeExecutionContext = {
        bot,
        task: runningTask,
        capabilityLease: lease,
        environmentLease,
        inputArtifacts,
        signal: controller.signal
      };
      const deadlineAt = effectiveDeadline(explicitDeadlineAt, startedAtMs, task.payload.budget);
      const result = await this.executeWithControls(adapter, context, deadlineAt, claimed.id);

      const latestExecution = this.queue.getByItem(task.id);
      const latestTask = this.store.getObject(task.id);
      if (controller.signal.aborted || latestExecution?.state === "canceled" || latestTask?.payload.status === "canceled") {
        const reasonValue = controller.signal.reason;
        throw reasonValue instanceof Error
          ? reasonValue
          : new TaskCancellationError("CANCELED", "Task canceled");
      }

      const ownedExecution = this.queue.heartbeat(claimed.id, this.runnerId, this.executionLeaseSeconds);
      const usage = assertUsageWithinBudget(task.payload.budget, result.usage ?? {});
      const fingerprint = progressFingerprint(result.output);
      this.gateway.policy?.loopGuard.assertProgress({ task: runningTask, fingerprint });

      const artifactId = createId("art");
      const artifactPayload: JsonObject = {
        schema_version: "1.0",
        id: artifactId,
        type: "artifact",
        workspace_id: claimed.workspaceId,
        created_by: botId,
        task_id: task.id,
        kind: result.artifactKind,
        version: 1,
        content_ref: null,
        inline_content: result.output,
        runtime_receipts: result.receipts ?? [],
        usage,
        progress_fingerprint: fingerprint,
        provenance: {
          origin: "bot_generated",
          trusted_instruction: false,
          source_refs: stringArray(task.payload.input_artifact_refs)
        }
      };
      validateProtocolObject(artifactPayload, "artifact");

      const completedTaskPayload: JsonObject = {
        ...runningTask.payload,
        status: "completed",
        completed_at: nowIso(),
        output_artifact_refs: [artifactId],
        usage,
        progress_fingerprint: fingerprint
      };
      validateProtocolObject(completedTaskPayload, "task");

      const completionMutation = this.store.atomicMutation({
        preconditions: [{ id: task.id, kind: "task", status: "running", ownerId: botId }],
        objects: [
          { kind: "artifact", payload: artifactPayload },
          { kind: "task", payload: completedTaskPayload }
        ],
        events: [],
        queueTransition: {
          itemId: task.id,
          fromStates: ["running"],
          toState: "completed",
          expectedClaimedBy: this.runnerId,
          expectedLeaseExpiresAt: ownedExecution.leaseExpiresAt,
          clearClaim: true,
          required: true
        }
      });
      const artifact = completionMutation.objects.find((object) => object.id === artifactId);
      const completedTask = completionMutation.objects.find((object) => object.id === task.id);
      const completedExecution = this.queue.getByItem(task.id);
      if (!artifact || !completedTask || !completedExecution) {
        throw new Error(`Task ${task.id} completion committed without expected records`);
      }

      this.gateway.emit({
        type: "task.completed",
        actorId: botId,
        workspaceId: claimed.workspaceId,
        taskId: task.id,
        correlationId: String(task.payload.root_objective_id),
        summary: result.summary,
        attentionState: "unread_result"
      });
      const completionSettlement = this.gateway.settleHandoffForTask(task.id, "completed", botId);
      const finalCompletedTask = completionSettlement?.task ?? completedTask;

      const responseTarget = asObject(task.payload.response_target);
      if (responseTarget && typeof responseTarget.kind === "string" && typeof responseTarget.id === "string") {
        if (responseTarget.kind === "room" || responseTarget.kind === "thread") {
          let roomId = typeof responseTarget.roomId === "string" ? responseTarget.roomId : null;
          const threadId = responseTarget.kind === "thread"
            ? (typeof responseTarget.threadId === "string" ? responseTarget.threadId : responseTarget.id)
            : (typeof responseTarget.threadId === "string" ? responseTarget.threadId : undefined);
          if (!roomId && threadId) {
            const thread = this.store.getObject(threadId);
            if (thread?.kind === "thread" && typeof thread.payload.room_id === "string") roomId = thread.payload.room_id;
          }
          if (!roomId && responseTarget.kind === "room") roomId = responseTarget.id;
          if (!roomId) throw new Error(`Response target ${responseTarget.kind}:${responseTarget.id} has no Room`);
          this.gateway.publishRoomMessage({
            senderId: botId,
            roomId,
            workspaceId: claimed.workspaceId,
            threadId,
            text: result.summary,
            artifactRefs: [artifactId],
            correlationId: String(task.payload.root_objective_id)
          });
        } else {
          this.gateway.sendMessage({
            senderId: botId,
            targetKind: responseTarget.kind === "operator" ? "operator" : "bot",
            targetId: responseTarget.id,
            workspaceId: claimed.workspaceId,
            text: `Task ${task.id} completed. Artifact: ${artifactId}. ${result.summary}`,
            correlationId: String(task.payload.root_objective_id)
          });
        }
      } else {
        const creatorId = String(task.payload.created_by);
        if (creatorId !== botId) {
          this.gateway.sendMessage({
            senderId: botId,
            targetKind: this.gateway.getBot(creatorId) ? "bot" : "operator",
            targetId: creatorId,
            workspaceId: claimed.workspaceId,
            text: `Task ${task.id} completed. Artifact: ${artifactId}. ${result.summary}`,
            correlationId: String(task.payload.root_objective_id)
          });
        }
      }

      return {
        execution: completedExecution,
        task: finalCompletedTask,
        artifact,
        status: "completed"
      };
    } catch (error) {
      if (error instanceof ExecutionOwnershipError) throw error;

      const latestTask = this.store.getObject(task.id);
      const latestExecution = this.queue.getByItem(task.id);
      if (latestExecution && latestExecution.claimedBy !== null && latestExecution.claimedBy !== this.runnerId
        && new Set(["claimed", "running"]).has(latestExecution.state)) {
        throw new ExecutionOwnershipError(claimed.id, `Runner ${this.runnerId} no longer owns Task ${task.id}`);
      }

      const cancellation = error instanceof TaskCancellationError
        || latestTask?.payload.status === "canceled"
        || latestExecution?.state === "canceled";

      if (cancellation) {
        const cancelError = error instanceof TaskCancellationError
          ? error
          : new TaskCancellationError("CANCELED", error instanceof Error ? error.message : "Task canceled");
        let canceledTask = latestTask ?? task;
        let canceledExecution = latestExecution ?? claimed;
        if (canceledTask.payload.status !== "canceled") {
          const currentExecution = this.queue.getByItem(task.id);
          if (!currentExecution || currentExecution.claimedBy !== this.runnerId || !new Set(["claimed", "running"]).has(currentExecution.state)) {
            throw new ExecutionOwnershipError(claimed.id, `Runner ${this.runnerId} cannot cancel Task ${task.id} after losing execution ownership`);
          }
          const canceledPayload = validateProtocolObject({
            ...canceledTask.payload,
            status: "canceled",
            canceled_at: nowIso(),
            cancellation_reason: cancelError.message,
            cancellation_code: cancelError.code
          }, "task");
          const mutation = this.store.atomicMutation({
            preconditions: [{ id: task.id, kind: "task", status: String(canceledTask.payload.status), ownerId: botId }],
            objects: [{ kind: "task", payload: canceledPayload }],
            events: [],
            queueTransition: {
              itemId: task.id,
              fromStates: [currentExecution.state],
              toState: "canceled",
              expectedClaimedBy: this.runnerId,
              expectedLeaseExpiresAt: currentExecution.leaseExpiresAt,
              clearClaim: true,
              lastError: cancelError.message,
              required: true
            }
          });
          canceledTask = mutation.objects[0] ?? canceledTask;
          canceledExecution = this.queue.getByItem(task.id) ?? canceledExecution;
          if (cancelError.code === "DEADLINE_EXCEEDED") {
            this.gateway.emit({
              type: "task.deadline_exceeded",
              actorId: botId,
              workspaceId: claimed.workspaceId,
              taskId: task.id,
              correlationId: String(task.payload.root_objective_id),
              summary: cancelError.message,
              attentionState: "failed"
            });
          }
          this.gateway.emit({
            type: "task.canceled",
            actorId: botId,
            workspaceId: claimed.workspaceId,
            taskId: task.id,
            correlationId: String(task.payload.root_objective_id),
            summary: cancelError.message,
            attentionState: "canceled"
          });
        }
        const cancellationSettlement = this.gateway.settleHandoffForTask(task.id, "canceled", botId);
        canceledTask = cancellationSettlement?.task ?? canceledTask;
        return {
          execution: canceledExecution,
          task: canceledTask,
          artifact: null,
          status: "canceled"
        };
      }

      const message = error instanceof Error ? error.message : String(error);
      const failureCode = error instanceof BudgetError || error instanceof CoordinationLoopError ? error.code : null;
      const currentExecution = this.queue.getByItem(task.id);
      if (!currentExecution || currentExecution.claimedBy !== this.runnerId || !new Set(["claimed", "running"]).has(currentExecution.state)) {
        throw new ExecutionOwnershipError(claimed.id, `Runner ${this.runnerId} cannot fail Task ${task.id} after losing execution ownership`);
      }
      const failureBase = latestTask?.kind === "task" ? latestTask : task;
      const failedTaskPayload: JsonObject = validateProtocolObject({
        ...failureBase.payload,
        status: "failed",
        failed_at: nowIso(),
        failure_reason: message,
        failure_code: failureCode
      }, "task");
      const failureMutation = this.store.atomicMutation({
        preconditions: [{ id: task.id, kind: "task", status: String(failureBase.payload.status), ownerId: botId }],
        objects: [{ kind: "task", payload: failedTaskPayload }],
        events: [],
        queueTransition: {
          itemId: task.id,
          fromStates: [currentExecution.state],
          toState: "failed",
          expectedClaimedBy: this.runnerId,
          expectedLeaseExpiresAt: currentExecution.leaseExpiresAt,
          clearClaim: true,
          lastError: message,
          required: true
        }
      });
      let failedTask = failureMutation.objects[0] ?? failureBase;
      const failedExecution = this.queue.getByItem(task.id) ?? currentExecution;
      if (error instanceof BudgetError) {
        this.gateway.emit({
          type: "task.budget_exceeded",
          actorId: botId,
          workspaceId: claimed.workspaceId,
          taskId: task.id,
          correlationId: String(task.payload.root_objective_id),
          summary: message,
          attentionState: "failed"
        });
      }
      if (error instanceof CoordinationLoopError) {
        this.gateway.emit({
          type: "task.no_progress",
          actorId: botId,
          workspaceId: claimed.workspaceId,
          taskId: task.id,
          correlationId: String(task.payload.root_objective_id),
          summary: message,
          attentionState: "failed"
        });
      }
      this.gateway.emit({
        type: "task.failed",
        actorId: botId,
        workspaceId: claimed.workspaceId,
        taskId: task.id,
        correlationId: String(task.payload.root_objective_id),
        summary: message,
        attentionState: "failed"
      });
      const failureSettlement = this.gateway.settleHandoffForTask(task.id, "failed", botId);
      failedTask = failureSettlement?.task ?? failedTask;
      return {
        execution: failedExecution,
        task: failedTask,
        artifact: null,
        status: "failed"
      };
    } finally {
      this.active.delete(task.id);
    }
  }

  private async executeWithControls(
    adapter: RuntimeAdapter,
    context: RuntimeExecutionContext,
    deadlineAt: number | null,
    executionId: string
  ): Promise<RuntimeExecutionResult> {
    const taskId = context.task.id;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const rejectFromSignal = () => {
        const reason = context.signal.reason;
        reject(reason instanceof Error ? reason : new TaskCancellationError("CANCELED", "Task canceled"));
      };
      if (context.signal.aborted) rejectFromSignal();
      else context.signal.addEventListener("abort", rejectFromSignal, { once: true });
    });

    heartbeatTimer = setInterval(() => {
      try {
        this.queue.heartbeat(executionId, this.runnerId, this.executionLeaseSeconds);
      } catch (error) {
        const ownershipError = error instanceof ExecutionOwnershipError
          ? error
          : new ExecutionOwnershipError(executionId, error instanceof Error ? error.message : String(error));
        const active = this.active.get(taskId);
        if (active && !active.controller.signal.aborted) active.controller.abort(ownershipError);
        void adapter.cancel?.(taskId);
      }
    }, this.heartbeatIntervalMs);

    if (deadlineAt !== null) {
      const delay = Math.max(0, deadlineAt - Date.now());
      deadlineTimer = setTimeout(() => {
        const error = new TaskCancellationError("DEADLINE_EXCEEDED", `Task ${taskId} exceeded its execution deadline`);
        const active = this.active.get(taskId);
        active?.controller.abort(error);
        void adapter.cancel?.(taskId);
      }, delay);
    }

    try {
      return await Promise.race([adapter.execute(context), abortPromise]);
    } finally {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    }
  }

  private assertCanCancel(task: StoredObject, actorId: string): void {
    if (actorId.startsWith("operator_")) return;
    if (actorId === task.payload.created_by || actorId === task.payload.owner_id || actorId === task.payload.assignee_id) return;
    throw new Error(`Actor ${actorId} cannot cancel Task ${task.id}`);
  }

  private async cancelTree(
    task: StoredObject,
    actorId: string,
    reason: string,
    tasks: StoredObject[],
    events: AppendedEvent[],
    visited: Set<string>
  ): Promise<void> {
    if (visited.has(task.id)) return;
    visited.add(task.id);

    const children = this.store.listObjects("task", task.workspaceId ?? undefined)
      .filter((candidate) => candidate.payload.parent_task_id === task.id && !TERMINAL_TASK_STATES.has(String(candidate.payload.status)));
    for (const child of children) {
      await this.cancelTree(child, actorId, `Parent ${task.id} canceled: ${reason}`, tasks, events, visited);
    }

    const current = this.store.getObject(task.id);
    if (!current || current.kind !== "task" || TERMINAL_TASK_STATES.has(String(current.payload.status))) return;

    const active = this.active.get(task.id);
    if (active) {
      const cancellation = new TaskCancellationError("CANCELED", reason);
      active.controller.abort(cancellation);
      await active.adapter.cancel?.(task.id);
    }

    this.queue.cancelByItem(task.id, reason);
    let canceled = this.store.putObject("task", validateProtocolObject({
      ...current.payload,
      status: "canceled",
      canceled_at: nowIso(),
      canceled_by: actorId,
      cancellation_reason: reason,
      cancellation_code: "CANCELED"
    }, "task"));
    const event = this.gateway.emit({
      type: "task.canceled",
      actorId,
      workspaceId: current.workspaceId,
      taskId: current.id,
      correlationId: String(current.payload.root_objective_id),
      summary: reason,
      attentionState: "canceled"
    });
    const settlement = this.gateway.settleHandoffForTask(current.id, "canceled", actorId);
    canceled = settlement?.task ?? canceled;
    tasks.push(canceled);
    events.push(event, ...(settlement?.events ?? []));
  }
}