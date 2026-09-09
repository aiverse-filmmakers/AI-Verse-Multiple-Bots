import { assertUsageWithinBudget, BudgetError, effectiveDeadline, type RuntimeUsage } from "./budget.js";
import { createId } from "./id.js";
import { ExecutionOwnershipError, ExecutionQueue, type ExecutionRecord } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { CoordinationLoopError, progressFingerprint } from "./loop-guard.js";
import { RuntimeRegistry, type ExecutionPrincipalKind, type RuntimeAdapter, type RuntimeExecutionContext, type RuntimeExecutionResult } from "./runtime.js";
import { CoordinationStore } from "./store.js";
import { TeamRunCoordinator, type TeamRunStatus, type WorkerStatus } from "./team-runs.js";
import type { AppendedEvent, BotManifest, JsonObject, StoredObject } from "./types.js";
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

function runtimeUsage(value: unknown): RuntimeUsage {
  const source = asObject(value) ?? {};
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

const TERMINAL_TASK_STATES = new Set(["completed", "failed", "canceled"]);
const TERMINAL_WORKER_STATES = new Set<WorkerStatus>(["completed", "failed", "canceled", "expired"]);
const EXECUTABLE_RUN_STATES = new Set<TeamRunStatus>(["running", "synthesizing", "verifying"]);

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

interface ResolvedExecutionPrincipal {
  principal: StoredObject;
  principalKind: ExecutionPrincipalKind;
  bot: StoredObject<BotManifest> | null;
  leaderBot: StoredObject<BotManifest>;
  run: StoredObject | null;
  runtime: JsonObject;
  adapterId: string;
  provenanceOrigin: "bot_generated" | "worker_generated";
}

/**
 * Common execution engine for durable Bots and temporary Workers.
 *
 * Identity is resolved from canonical protocol objects. A Worker never enters the
 * durable Bot registry and is never converted into a synthetic Bot manifest.
 */
export class PrincipalRunner {
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

  runtimeAdapterIdFor(targetId: string): string | null {
    try {
      return this.resolvePrincipal(targetId).adapterId;
    } catch {
      return null;
    }
  }

  async cancelTask(taskId: string, actorId: string, reason = "Canceled by operator or owner"): Promise<CancelResult> {
    const task = this.store.getObject(taskId);
    if (!task || task.kind !== "task") throw new Error(`Task ${taskId} not found`);
    this.assertCanCancel(task, actorId);

    const tasks: StoredObject[] = [];
    const events: AppendedEvent[] = [];
    await this.cancelTree(task, actorId, reason, tasks, events, new Set<string>());
    return { tasks, events };
  }

  async runNext(targetId: string): Promise<RunResult | null> {
    const resolved = this.resolvePrincipal(targetId);
    if (!this.runtimes.has(resolved.adapterId)) throw new Error(`Runtime adapter ${resolved.adapterId} is not registered`);

    const claimed = this.queue.claimNext(targetId, this.runnerId, this.executionLeaseSeconds);
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

    const runId = resolved.run?.id ?? (typeof task.payload.run_id === "string" ? task.payload.run_id : null);

    try {
      this.assertExecutableTask(resolved, task, claimed.workspaceId);

      const explicitDeadlineAt = typeof task.payload.deadline_at === "string" ? task.payload.deadline_at : null;
      const explicitDeadlineMs = explicitDeadlineAt ? Date.parse(explicitDeadlineAt) : null;
      if (explicitDeadlineMs !== null && (!Number.isFinite(explicitDeadlineMs) || explicitDeadlineMs <= Date.now())) {
        throw new TaskCancellationError("DEADLINE_EXCEEDED", `Task ${task.id} deadline has elapsed`);
      }

      const leaseId = String(task.payload.lease_id);
      const lease = this.store.getObject(leaseId);
      if (!lease || lease.kind !== "capability_lease") throw new Error(`Capability lease ${leaseId} not found`);
      if (lease.payload.issued_to !== targetId) throw new Error(`Capability lease ${leaseId} is not issued to ${targetId}`);
      if (lease.payload.task_id !== task.id) throw new Error(`Capability lease ${leaseId} is not scoped to task ${task.id}`);
      if (lease.workspaceId !== claimed.workspaceId) throw new Error(`Capability lease ${leaseId} is outside workspace ${claimed.workspaceId}`);
      const expiresAt = Date.parse(String(lease.payload.expires_at));
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error(`Capability lease ${leaseId} is expired`);

      let environmentLease: StoredObject | null = null;
      if (typeof task.payload.environment_lease_id === "string" && task.payload.environment_lease_id.length > 0) {
        environmentLease = this.store.getObject(task.payload.environment_lease_id);
        if (!environmentLease || environmentLease.kind !== "environment_lease") {
          throw new Error(`Environment lease ${String(task.payload.environment_lease_id)} not found`);
        }
        if (environmentLease.payload.issued_to !== targetId) throw new Error(`Environment lease ${environmentLease.id} is not issued to ${targetId}`);
        if (environmentLease.workspaceId !== claimed.workspaceId) throw new Error(`Environment lease ${environmentLease.id} is outside workspace ${claimed.workspaceId}`);
        if (typeof environmentLease.payload.task_id === "string" && environmentLease.payload.task_id !== task.id) {
          throw new Error(`Environment lease ${environmentLease.id} is not scoped to task ${task.id}`);
        }
        const environmentExpiry = Date.parse(String(environmentLease.payload.expires_at));
        if (!Number.isFinite(environmentExpiry) || environmentExpiry <= Date.now()) throw new Error(`Environment lease ${environmentLease.id} is expired`);
      }

      if (resolved.principalKind === "worker") {
        if (typeof resolved.principal.payload.capability_lease_id === "string" && resolved.principal.payload.capability_lease_id !== lease.id) {
          throw new Error(`Worker ${targetId} capability lease does not match Task ${task.id}`);
        }
        if (typeof resolved.principal.payload.environment_lease_id === "string") {
          if (!environmentLease || resolved.principal.payload.environment_lease_id !== environmentLease.id) {
            throw new Error(`Worker ${targetId} environment lease does not match Task ${task.id}`);
          }
        }
      }

      const inputArtifacts = stringArray(task.payload.input_artifact_refs)
        .map((id) => this.store.getObject(id))
        .filter((item): item is StoredObject => Boolean(item && item.kind === "artifact"));

      this.queue.markRunning(claimed.id, this.runnerId, this.executionLeaseSeconds);
      const startedAtMs = Date.now();
      const runningTaskPayload: JsonObject = validateProtocolObject({
        ...task.payload,
        status: "running",
        started_at: new Date(startedAtMs).toISOString(),
        execution_runner_id: this.runnerId,
        execution_attempt: claimed.attempts
      }, "task");
      const startObjects: Array<{ kind: "task" | "worker"; payload: JsonObject }> = [{ kind: "task", payload: runningTaskPayload }];
      const startPreconditions: Array<{ id: string; kind: "task" | "worker" | "team_run"; status?: string; ownerId?: string }> = [
        { id: task.id, kind: "task", status: "assigned", ownerId: targetId }
      ];
      if (resolved.principalKind === "worker") {
        const workerStatus = String(resolved.principal.payload.status);
        startObjects.push({
          kind: "worker",
          payload: validateProtocolObject({ ...resolved.principal.payload, status: "running", started_at: nowIso(), updated_at: nowIso() }, "worker")
        });
        startPreconditions.push({ id: resolved.principal.id, kind: "worker", status: workerStatus });
        if (resolved.run) startPreconditions.push({ id: resolved.run.id, kind: "team_run", status: String(resolved.run.payload.status) });
      }
      const startMutation = this.store.atomicMutation({ preconditions: startPreconditions, objects: startObjects, events: [] });
      const runningTask = startMutation.objects.find((object) => object.id === task.id);
      if (!runningTask) throw new Error(`Task ${task.id} start transition did not persist`);
      if (resolved.principalKind === "worker") resolved.principal = startMutation.objects.find((object) => object.id === targetId) ?? resolved.principal;

      this.gateway.emit({
        type: "task.started",
        actorId: targetId,
        workspaceId: claimed.workspaceId,
        runId,
        taskId: task.id,
        correlationId: String(task.payload.root_objective_id),
        summary: `${targetId} started ${task.id}`
      });
      if (resolved.principalKind === "worker") {
        this.gateway.emit({
          type: "worker.status_changed",
          actorId: targetId,
          workspaceId: claimed.workspaceId,
          runId,
          taskId: task.id,
          correlationId: String(task.payload.root_objective_id),
          summary: `${targetId} changed to running for ${task.id}`
        });
      }

      const adapter = this.runtimes.get(resolved.adapterId);
      const controller = new AbortController();
      this.active.set(task.id, { controller, adapter, executionId: claimed.id });
      const context: RuntimeExecutionContext = {
        principal: resolved.principal,
        principalKind: resolved.principalKind,
        ...(resolved.bot ? { bot: resolved.bot } : {}),
        runtime: resolved.runtime,
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
        throw reasonValue instanceof Error ? reasonValue : new TaskCancellationError("CANCELED", "Task canceled");
      }

      const ownedExecution = this.queue.heartbeat(claimed.id, this.runnerId, this.executionLeaseSeconds);
      const usage = assertUsageWithinBudget(task.payload.budget, result.usage ?? {});
      const aggregateUsage = resolved.run ? this.assertTeamRunAggregateUsage(resolved.run, task.id, usage) : null;
      const fingerprint = progressFingerprint(result.output);
      this.gateway.policy?.loopGuard.assertProgress({ task: runningTask, fingerprint });

      const artifactId = createId("art");
      const artifactPayload: JsonObject = validateProtocolObject({
        schema_version: "1.0",
        id: artifactId,
        type: "artifact",
        workspace_id: claimed.workspaceId,
        created_by: targetId,
        run_id: runId,
        task_id: task.id,
        kind: result.artifactKind,
        version: 1,
        content_ref: null,
        inline_content: result.output,
        runtime_receipts: result.receipts ?? [],
        usage,
        progress_fingerprint: fingerprint,
        provenance: { origin: resolved.provenanceOrigin, trusted_instruction: false, source_refs: stringArray(task.payload.input_artifact_refs) }
      }, "artifact");
      const completedTaskPayload: JsonObject = validateProtocolObject({
        ...runningTask.payload,
        status: "completed",
        completed_at: nowIso(),
        output_artifact_refs: [artifactId],
        usage,
        progress_fingerprint: fingerprint
      }, "task");

      const completionObjects: Array<{ kind: "artifact" | "task" | "worker" | "team_run"; payload: JsonObject }> = [
        { kind: "artifact", payload: artifactPayload },
        { kind: "task", payload: completedTaskPayload }
      ];
      const completionPreconditions: Array<{ id: string; kind: "task" | "worker" | "team_run"; status?: string; ownerId?: string }> = [
        { id: task.id, kind: "task", status: "running", ownerId: targetId }
      ];
      if (resolved.principalKind === "worker") {
        const latestWorker = this.requireWorker(targetId);
        completionObjects.push({
          kind: "worker",
          payload: validateProtocolObject({ ...latestWorker.payload, status: "completed", completed_at: nowIso(), terminal_at: nowIso(), updated_at: nowIso() }, "worker")
        });
        completionPreconditions.push({ id: targetId, kind: "worker", status: String(latestWorker.payload.status) });
        const latestRun = this.requireActiveRun(String(latestWorker.payload.run_id));
        completionObjects.push({
          kind: "team_run",
          payload: validateProtocolObject({ ...latestRun.payload, usage: aggregateUsage ?? {}, updated_at: nowIso() }, "team_run")
        });
        completionPreconditions.push({ id: latestRun.id, kind: "team_run", status: String(latestRun.payload.status) });
      }

      const completionBase = { preconditions: completionPreconditions, objects: completionObjects, events: [] };
      const completionMutation = this.store.dbPath === ":memory:"
        ? this.store.atomicMutation(completionBase)
        : this.store.atomicMutation({
            ...completionBase,
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
      if (this.store.dbPath === ":memory:") this.queue.finishOwned(claimed.id, this.runnerId, "completed");

      const artifact = completionMutation.objects.find((object) => object.id === artifactId);
      const completedTask = completionMutation.objects.find((object) => object.id === task.id);
      const completedExecution = this.queue.getByItem(task.id);
      if (!artifact || !completedTask || !completedExecution) throw new Error(`Task ${task.id} completion committed without expected records`);

      this.gateway.emit({ type: "artifact.published", actorId: targetId, workspaceId: claimed.workspaceId, runId, taskId: task.id, correlationId: String(task.payload.root_objective_id), summary: `Published artifact ${artifactId}` });
      this.gateway.emit({ type: "task.completed", actorId: targetId, workspaceId: claimed.workspaceId, runId, taskId: task.id, correlationId: String(task.payload.root_objective_id), summary: result.summary, attentionState: "unread_result" });
      if (resolved.principalKind === "worker") {
        this.gateway.emit({ type: "worker.status_changed", actorId: targetId, workspaceId: claimed.workspaceId, runId, taskId: task.id, correlationId: String(task.payload.root_objective_id), summary: `${targetId} completed ${task.id}` });
      }
      const completionSettlement = resolved.principalKind === "bot" ? this.gateway.settleHandoffForTask(task.id, "completed", targetId) : null;
      const finalCompletedTask = completionSettlement?.task ?? completedTask;

      this.publishResult(resolved, task, claimed.workspaceId, artifactId, result.summary);
      return { execution: completedExecution, task: finalCompletedTask, artifact, status: "completed" };
    } catch (error) {
      if (error instanceof ExecutionOwnershipError) throw error;

      const latestTask = this.store.getObject(task.id);
      const latestExecution = this.queue.getByItem(task.id);
      if (latestExecution && latestExecution.claimedBy !== null && latestExecution.claimedBy !== this.runnerId && new Set(["claimed", "running"]).has(latestExecution.state)) {
        throw new ExecutionOwnershipError(claimed.id, `Runner ${this.runnerId} no longer owns Task ${task.id}`);
      }

      const cancellation = error instanceof TaskCancellationError || latestTask?.payload.status === "canceled" || latestExecution?.state === "canceled";
      if (cancellation) {
        const cancelError = error instanceof TaskCancellationError ? error : new TaskCancellationError("CANCELED", error instanceof Error ? error.message : "Task canceled");
        let canceledTask = latestTask ?? task;
        let canceledExecution = latestExecution ?? claimed;
        if (canceledTask.payload.status !== "canceled") {
          const currentExecution = this.queue.getByItem(task.id);
          if (!currentExecution || currentExecution.claimedBy !== this.runnerId || !new Set(["claimed", "running"]).has(currentExecution.state)) {
            throw new ExecutionOwnershipError(claimed.id, `Runner ${this.runnerId} cannot cancel Task ${task.id} after losing execution ownership`);
          }
          const canceledPayload = validateProtocolObject({ ...canceledTask.payload, status: "canceled", canceled_at: nowIso(), cancellation_reason: cancelError.message, cancellation_code: cancelError.code }, "task");
          const cancelObjects: Array<{ kind: "task" | "worker"; payload: JsonObject }> = [{ kind: "task", payload: canceledPayload }];
          const cancelPreconditions: Array<{ id: string; kind: "task" | "worker"; status?: string; ownerId?: string }> = [
            { id: task.id, kind: "task", status: String(canceledTask.payload.status), ownerId: targetId }
          ];
          if (resolved.principalKind === "worker") {
            const worker = this.store.getObject(targetId);
            if (worker?.kind === "worker" && !TERMINAL_WORKER_STATES.has(String(worker.payload.status) as WorkerStatus)) {
              cancelObjects.push({ kind: "worker", payload: validateProtocolObject({ ...worker.payload, status: "canceled", terminal_at: nowIso(), status_reason: cancelError.message, updated_at: nowIso() }, "worker") });
              cancelPreconditions.push({ id: worker.id, kind: "worker", status: String(worker.payload.status) });
            }
          }
          const cancelBase = { preconditions: cancelPreconditions, objects: cancelObjects, events: [] };
          const mutation = this.store.dbPath === ":memory:"
            ? this.store.atomicMutation(cancelBase)
            : this.store.atomicMutation({
                ...cancelBase,
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
          if (this.store.dbPath === ":memory:") this.queue.cancelByItem(task.id, cancelError.message);
          canceledTask = mutation.objects.find((object) => object.id === task.id) ?? canceledTask;
          canceledExecution = this.queue.getByItem(task.id) ?? canceledExecution;
          if (cancelError.code === "DEADLINE_EXCEEDED") this.gateway.emit({ type: "task.deadline_exceeded", actorId: targetId, workspaceId: claimed.workspaceId, runId, taskId: task.id, correlationId: String(task.payload.root_objective_id), summary: cancelError.message, attentionState: "failed" });
          this.gateway.emit({ type: "task.canceled", actorId: targetId, workspaceId: claimed.workspaceId, runId, taskId: task.id, correlationId: String(task.payload.root_objective_id), summary: cancelError.message, attentionState: "canceled" });
          if (resolved.principalKind === "worker") this.gateway.emit({ type: "worker.status_changed", actorId: targetId, workspaceId: claimed.workspaceId, runId, taskId: task.id, correlationId: String(task.payload.root_objective_id), summary: `${targetId} canceled: ${cancelError.message}` });
        }
        const cancellationSettlement = resolved.principalKind === "bot" ? this.gateway.settleHandoffForTask(task.id, "canceled", targetId) : null;
        canceledTask = cancellationSettlement?.task ?? canceledTask;
        return { execution: canceledExecution, task: canceledTask, artifact: null, status: "canceled" };
      }

      const message = error instanceof Error ? error.message : String(error);
      const failureCode = error instanceof BudgetError || error instanceof CoordinationLoopError ? error.code : null;
      const currentExecution = this.queue.getByItem(task.id);
      if (!currentExecution || currentExecution.claimedBy !== this.runnerId || !new Set(["claimed", "running"]).has(currentExecution.state)) {
        throw new ExecutionOwnershipError(claimed.id, `Runner ${this.runnerId} cannot fail Task ${task.id} after losing execution ownership`);
      }
      const failureBase = latestTask?.kind === "task" ? latestTask : task;
      const failedTaskPayload = validateProtocolObject({ ...failureBase.payload, status: "failed", failed_at: nowIso(), failure_reason: message, failure_code: failureCode }, "task");
      const failureObjects: Array<{ kind: "task" | "worker"; payload: JsonObject }> = [{ kind: "task", payload: failedTaskPayload }];
      const failurePreconditions: Array<{ id: string; kind: "task" | "worker"; status?: string; ownerId?: string }> = [
        { id: task.id, kind: "task", status: String(failureBase.payload.status), ownerId: targetId }
      ];
      if (resolved.principalKind === "worker") {
        const worker = this.store.getObject(targetId);
        if (worker?.kind === "worker" && !TERMINAL_WORKER_STATES.has(String(worker.payload.status) as WorkerStatus)) {
          failureObjects.push({ kind: "worker", payload: validateProtocolObject({ ...worker.payload, status: "failed", failed_at: nowIso(), terminal_at: nowIso(), status_reason: message, updated_at: nowIso() }, "worker") });
          failurePreconditions.push({ id: worker.id, kind: "worker", status: String(worker.payload.status) });
        }
      }
      const failureBaseMutation = { preconditions: failurePreconditions, objects: failureObjects, events: [] };
      const failureMutation = this.store.dbPath === ":memory:"
        ? this.store.atomicMutation(failureBaseMutation)
        : this.store.atomicMutation({
            ...failureBaseMutation,
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
      if (this.store.dbPath === ":memory:") this.queue.finishOwned(claimed.id, this.runnerId, "failed", message);
      let failedTask = failureMutation.objects.find((object) => object.id === task.id) ?? failureBase;
      const failedExecution = this.queue.getByItem(task.id) ?? currentExecution;
      if (error instanceof BudgetError) this.gateway.emit({ type: "task.budget_exceeded", actorId: targetId, workspaceId: claimed.workspaceId, runId, taskId: task.id, correlationId: String(task.payload.root_objective_id), summary: message, attentionState: "failed" });
      if (error instanceof CoordinationLoopError) this.gateway.emit({ type: "task.no_progress", actorId: targetId, workspaceId: claimed.workspaceId, runId, taskId: task.id, correlationId: String(task.payload.root_objective_id), summary: message, attentionState: "failed" });
      this.gateway.emit({ type: "task.failed", actorId: targetId, workspaceId: claimed.workspaceId, runId, taskId: task.id, correlationId: String(task.payload.root_objective_id), summary: message, attentionState: "failed" });
      if (resolved.principalKind === "worker") this.gateway.emit({ type: "worker.status_changed", actorId: targetId, workspaceId: claimed.workspaceId, runId, taskId: task.id, correlationId: String(task.payload.root_objective_id), summary: `${targetId} failed: ${message}` });
      const failureSettlement = resolved.principalKind === "bot" ? this.gateway.settleHandoffForTask(task.id, "failed", targetId) : null;
      failedTask = failureSettlement?.task ?? failedTask;
      if (error instanceof BudgetError && error.code.startsWith("TEAM_RUN_") && resolved.run) {
        await this.exhaustTeamRun(resolved.run.id, resolved.leaderBot.id, message, task.id);
      }
      return { execution: failedExecution, task: failedTask, artifact: null, status: "failed" };
    } finally {
      this.active.delete(task.id);
    }
  }

  private resolvePrincipal(targetId: string): ResolvedExecutionPrincipal {
    const object = this.store.getObject(targetId);
    if (!object) throw new Error(`Execution principal ${targetId} not found`);

    if (object.kind === "bot") {
      const bot = object as StoredObject<BotManifest>;
      if (bot.payload.status !== "active") throw new Error(`Bot ${targetId} is not active`);
      const runtime = asObject(bot.payload.runtime) ?? {};
      const adapterId = typeof runtime.adapter === "string" ? runtime.adapter : "";
      if (!adapterId) throw new Error(`Bot ${targetId} has no runtime adapter`);
      return { principal: bot, principalKind: "bot", bot, leaderBot: bot, run: null, runtime, adapterId, provenanceOrigin: "bot_generated" };
    }

    if (object.kind !== "worker") throw new Error(`Execution principal ${targetId} must be a Bot or Worker`);
    const workerStatus = String(object.payload.status) as WorkerStatus;
    if (!new Set<WorkerStatus>(["ready", "running", "waiting"]).has(workerStatus)) throw new Error(`Worker ${targetId} is not executable from status ${workerStatus}`);
    const run = this.requireActiveRun(String(object.payload.run_id));
    const leaderId = String(run.payload.leader_id ?? object.payload.parent_owner_id ?? "");
    const leader = this.store.getObject(leaderId);
    if (!leader || leader.kind !== "bot" || leader.payload.status !== "active") throw new Error(`Worker ${targetId} has no active durable leader`);
    if (leader.workspaceId !== object.workspaceId || run.workspaceId !== object.workspaceId) throw new Error(`Worker ${targetId} scope does not match its Team Run leader`);
    const leaderRuntime = asObject(leader.payload.runtime) ?? {};
    const workerRuntime = asObject(object.payload.runtime) ?? {};
    const runtime: JsonObject = { ...leaderRuntime, ...workerRuntime };
    const adapterId = typeof runtime.adapter === "string" ? runtime.adapter : "";
    if (!adapterId) throw new Error(`Worker ${targetId} has no effective runtime adapter`);
    return {
      principal: object,
      principalKind: "worker",
      bot: null,
      leaderBot: leader as StoredObject<BotManifest>,
      run,
      runtime,
      adapterId,
      provenanceOrigin: "worker_generated"
    };
  }

  private assertExecutableTask(resolved: ResolvedExecutionPrincipal, task: StoredObject, workspaceId: string): void {
    const targetId = resolved.principal.id;
    if (task.payload.assignee_id !== targetId) throw new Error(`Task ${task.id} is assigned to ${String(task.payload.assignee_id)}, not ${targetId}`);
    if (task.payload.owner_id !== targetId) throw new Error(`Task ${task.id} is owned by ${String(task.payload.owner_id)}, not ${targetId}`);
    if (task.payload.status !== "assigned") throw new Error(`Task ${task.id} is not executable from status ${String(task.payload.status)}`);
    if (task.workspaceId !== workspaceId || resolved.principal.workspaceId !== workspaceId) throw new Error(`Task ${task.id} and ${targetId} do not share workspace ${workspaceId}`);
    if (resolved.principalKind === "worker") {
      if (!resolved.run) throw new Error(`Worker ${targetId} has no Team Run`);
      if (String(task.payload.run_id ?? "") !== resolved.run.id) throw new Error(`Worker Task ${task.id} is not scoped to Team Run ${resolved.run.id}`);
      if (String(resolved.principal.payload.task_id ?? "") !== task.id) throw new Error(`Worker ${targetId} is bound to ${String(resolved.principal.payload.task_id)}, not ${task.id}`);
      this.assertBudgetDoesNotExpand(resolved.run.payload.budget, resolved.principal.payload.budget, `Worker ${targetId}`);
      this.assertBudgetDoesNotExpand(resolved.principal.payload.budget, task.payload.budget, `Task ${task.id}`);
    }
  }

  private assertBudgetDoesNotExpand(parentValue: unknown, childValue: unknown, label: string): void {
    const parent = asObject(parentValue) ?? {};
    const child = asObject(childValue) ?? {};
    for (const key of ["token_limit", "cost_limit", "wall_clock_seconds", "max_hops", "max_messages", "max_rounds", "max_tasks", "max_actions"]) {
      const p = parent[key];
      const c = child[key];
      if (typeof p === "number" && typeof c === "number" && c > p) throw new BudgetError("WORKER_BUDGET_EXPANSION", `${label} ${key} ${c} exceeds parent limit ${p}`);
    }
  }

  private assertTeamRunAggregateUsage(run: StoredObject, currentTaskId: string, currentUsage: RuntimeUsage): RuntimeUsage {
    let aggregate: RuntimeUsage = { input_tokens: 0, output_tokens: 0, cost: 0, actions: 0 };
    for (const task of this.store.listObjects("task", run.workspaceId ?? undefined)) {
      if (task.id === currentTaskId || task.payload.run_id !== run.id || task.payload.status !== "completed") continue;
      aggregate = addUsage(aggregate, runtimeUsage(task.payload.usage));
    }
    aggregate = addUsage(aggregate, currentUsage);
    try {
      return assertUsageWithinBudget(run.payload.budget, aggregate);
    } catch (error) {
      if (error instanceof BudgetError) throw new BudgetError(`TEAM_RUN_${error.code}`, `Team Run ${run.id}: ${error.message}`);
      throw error;
    }
  }

  private requireActiveRun(runId: string): StoredObject {
    const run = this.store.getObject(runId);
    if (!run || run.kind !== "team_run") throw new Error(`Team Run ${runId} not found`);
    const status = String(run.payload.status) as TeamRunStatus;
    if (!EXECUTABLE_RUN_STATES.has(status)) throw new Error(`Team Run ${runId} is not executable from status ${status}`);
    return run;
  }

  private requireWorker(workerId: string): StoredObject {
    const worker = this.store.getObject(workerId);
    if (!worker || worker.kind !== "worker") throw new Error(`Worker ${workerId} not found`);
    return worker;
  }

  private publishResult(resolved: ResolvedExecutionPrincipal, task: StoredObject, workspaceId: string, artifactId: string, summary: string): void {
    const senderId = resolved.principal.id;
    const responseTarget = asObject(task.payload.response_target);
    if (responseTarget && typeof responseTarget.kind === "string" && typeof responseTarget.id === "string") {
      if (responseTarget.kind === "room" || responseTarget.kind === "thread") {
        if (resolved.principalKind === "worker") throw new Error(`Temporary Worker ${senderId} cannot publish directly into durable Room/Thread membership`);
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
        this.gateway.publishRoomMessage({ senderId, roomId, workspaceId, threadId, text: summary, artifactRefs: [artifactId], correlationId: String(task.payload.root_objective_id) });
      } else {
        this.gateway.sendMessage({ senderId, targetKind: responseTarget.kind === "operator" ? "operator" : "bot", targetId: responseTarget.id, workspaceId, text: `Task ${task.id} completed. Artifact: ${artifactId}. ${summary}`, correlationId: String(task.payload.root_objective_id) });
      }
      return;
    }

    const creatorId = String(task.payload.created_by);
    if (creatorId !== senderId) {
      this.gateway.sendMessage({ senderId, targetKind: this.gateway.getBot(creatorId) ? "bot" : "operator", targetId: creatorId, workspaceId, text: `Task ${task.id} completed. Artifact: ${artifactId}. ${summary}`, correlationId: String(task.payload.root_objective_id) });
    }
  }

  private async exhaustTeamRun(runId: string, leaderId: string, reason: string, failedTaskId: string): Promise<void> {
    const run = this.store.getObject(runId);
    if (!run || run.kind !== "team_run") return;
    if (new Set(["completed", "failed", "canceled", "budget_exhausted"]).has(String(run.payload.status))) return;

    for (const worker of this.store.listObjects("worker", run.workspaceId ?? undefined)) {
      if (worker.payload.run_id !== runId || TERMINAL_WORKER_STATES.has(String(worker.payload.status) as WorkerStatus)) continue;
      const taskId = typeof worker.payload.task_id === "string" ? worker.payload.task_id : null;
      if (!taskId || taskId === failedTaskId) continue;
      const task = this.store.getObject(taskId);
      if (!task || task.kind !== "task" || TERMINAL_TASK_STATES.has(String(task.payload.status))) continue;
      await this.cancelTask(taskId, leaderId, `Team Run ${runId} budget exhausted: ${reason}`);
    }

    const teams = new TeamRunCoordinator(this.store);
    const latest = teams.getRun(runId);
    if (latest && !new Set(["completed", "failed", "canceled", "budget_exhausted"]).has(String(latest.payload.status))) {
      teams.transitionRun(runId, "budget_exhausted", leaderId, reason);
    }
  }

  private async executeWithControls(adapter: RuntimeAdapter, context: RuntimeExecutionContext, deadlineAt: number | null, executionId: string): Promise<RuntimeExecutionResult> {
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
        const ownershipError = error instanceof ExecutionOwnershipError ? error : new ExecutionOwnershipError(executionId, error instanceof Error ? error.message : String(error));
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

  private async cancelTree(task: StoredObject, actorId: string, reason: string, tasks: StoredObject[], events: AppendedEvent[], visited: Set<string>): Promise<void> {
    if (visited.has(task.id)) return;
    visited.add(task.id);

    const children = this.store.listObjects("task", task.workspaceId ?? undefined)
      .filter((candidate) => candidate.payload.parent_task_id === task.id && !TERMINAL_TASK_STATES.has(String(candidate.payload.status)));
    for (const child of children) await this.cancelTree(child, actorId, `Parent ${task.id} canceled: ${reason}`, tasks, events, visited);

    const current = this.store.getObject(task.id);
    if (!current || current.kind !== "task" || TERMINAL_TASK_STATES.has(String(current.payload.status))) return;

    const active = this.active.get(task.id);
    if (active) {
      const cancellation = new TaskCancellationError("CANCELED", reason);
      active.controller.abort(cancellation);
      await active.adapter.cancel?.(task.id);
    }

    this.queue.cancelByItem(task.id, reason);
    const runId = typeof current.payload.run_id === "string" ? current.payload.run_id : null;
    const objects: Array<{ kind: "task" | "worker"; payload: JsonObject }> = [
      { kind: "task", payload: validateProtocolObject({ ...current.payload, status: "canceled", canceled_at: nowIso(), canceled_by: actorId, cancellation_reason: reason, cancellation_code: "CANCELED" }, "task") }
    ];
    const ownerId = String(current.payload.owner_id ?? "");
    const worker = ownerId.startsWith("worker_") ? this.store.getObject(ownerId) : null;
    if (worker?.kind === "worker" && !TERMINAL_WORKER_STATES.has(String(worker.payload.status) as WorkerStatus)) {
      objects.push({ kind: "worker", payload: validateProtocolObject({ ...worker.payload, status: "canceled", terminal_at: nowIso(), status_reason: reason, updated_at: nowIso() }, "worker") });
    }
    const mutation = this.store.atomicMutation({ objects, events: [] });
    let canceled = mutation.objects.find((object) => object.id === current.id) ?? current;
    const event = this.gateway.emit({ type: "task.canceled", actorId, workspaceId: current.workspaceId, runId, taskId: current.id, correlationId: String(current.payload.root_objective_id), summary: reason, attentionState: "canceled" });
    if (worker?.kind === "worker") this.gateway.emit({ type: "worker.status_changed", actorId, workspaceId: current.workspaceId, runId, taskId: current.id, correlationId: String(current.payload.root_objective_id), summary: `${worker.id} canceled: ${reason}` });
    const settlement = ownerId.startsWith("bot_") ? this.gateway.settleHandoffForTask(current.id, "canceled", actorId) : null;
    canceled = settlement?.task ?? canceled;
    tasks.push(canceled);
    events.push(event, ...(settlement?.events ?? []));
  }
}
