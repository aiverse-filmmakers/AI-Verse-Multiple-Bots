import type { AppendedEvent } from "./types.js";
import { ExecutionOwnershipError, ExecutionQueue } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { RecoveryCoordinator, type RecoveryDecision } from "./recovery.js";
import { BotRunner } from "./runner.js";
import type { ManagerTopologyCoordinator } from "./manager-topology.js";

export class ExecutionSupervisor {
  private unsubscribe: (() => void) | null = null;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Map<string, Promise<void>>();
  readonly recovery: RecoveryCoordinator;

  constructor(
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue,
    readonly runner: BotRunner,
    readonly recoverySweepMs = 5000,
    readonly managerTopology?: ManagerTopologyCoordinator
  ) {
    this.recovery = new RecoveryCoordinator(gateway.store, queue, gateway);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.gateway.subscribeEvents((event) => this.onEvent(event));
    this.managerTopology?.reconcileAll();
    this.sweepRecovery();
    for (const targetId of this.queue.listQueuedTargets()) this.trigger(targetId);
    if (this.recoverySweepMs > 0) this.recoveryTimer = setInterval(() => this.sweepRecovery(), this.recoverySweepMs);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.recoveryTimer !== null) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight.values()]);
  }

  trigger(principalId: string): void {
    if (this.inFlight.has(principalId)) return;
    const bot = this.gateway.getBot(principalId);
    const principal = bot ?? this.gateway.store.getObject(principalId);
    if (!principal) return;
    if (principal.kind === "bot" && principal.payload.status !== "active") return;
    if (principal.kind === "worker" && !new Set(["ready", "running"]).has(String(principal.payload.status))) return;
    if (principal.kind !== "bot" && principal.kind !== "worker") return;
    const runtime = typeof principal.payload.runtime === "object" && principal.payload.runtime !== null && !Array.isArray(principal.payload.runtime)
      ? principal.payload.runtime as Record<string, unknown>
      : {};
    const adapterId = typeof runtime.adapter === "string" ? runtime.adapter : "";
    if (!adapterId || !this.runner.runtimes.has(adapterId)) return;

    const work = Promise.resolve().then(() => this.drain(principalId)).finally(() => {
      this.inFlight.delete(principalId);
      if (this.queue.list(principalId, ["queued"]).length > 0) this.trigger(principalId);
    });
    this.inFlight.set(principalId, work);
  }

  sweepRecovery(now = Date.now()): RecoveryDecision[] {
    let decisions: RecoveryDecision[] = [];
    try {
      decisions = this.recovery.recoverStale(now);
    } catch (error) {
      if (error instanceof ExecutionOwnershipError) return decisions;
      this.gateway.emit({
        type: "execution.recovery_failed",
        actorId: "system_recovery",
        summary: error instanceof Error ? error.message : String(error),
        attentionState: "failed"
      });
      return decisions;
    }
    for (const decision of decisions) if (decision.action === "requeued") this.trigger(decision.execution.targetId);
    return decisions;
  }

  retryDeadLetter(taskId: string, actorId: string, reason?: string) {
    const result = this.recovery.retryDeadLetter(taskId, actorId, reason);
    this.trigger(result.execution.targetId);
    return result;
  }

  private onEvent(appended: AppendedEvent): void {
    if (appended.event.type === "bot.created") {
      this.trigger(appended.event.actor_id);
      return;
    }

    if (appended.event.task_id && new Set(["task.started", "task.completed", "task.failed", "task.canceled"]).has(appended.event.type)) {
      try {
        this.managerTopology?.reconcileTask(appended.event.task_id);
      } catch (error) {
        this.gateway.emit({
          type: "manager.reconciliation_failed",
          actorId: "system_supervisor",
          workspaceId: appended.event.workspace_id ?? null,
          runId: appended.event.run_id ?? null,
          taskId: appended.event.task_id,
          correlationId: appended.event.correlation_id ?? null,
          summary: error instanceof Error ? error.message : String(error),
          attentionState: "failed"
        });
      }
    }

    if (appended.event.type !== "task.assigned" || !appended.event.task_id) return;
    const task = this.gateway.store.getObject(appended.event.task_id);
    if (!task || task.kind !== "task") return;
    const assigneeId = task.payload.assignee_id;
    if (typeof assigneeId === "string" && assigneeId.length > 0) this.trigger(assigneeId);
  }

  private async drain(principalId: string): Promise<void> {
    while (true) {
      try {
        const result = await this.runner.runNext(principalId);
        if (!result) return;
      } catch (error) {
        if (error instanceof ExecutionOwnershipError) return;
        throw error;
      }
    }
  }
}
