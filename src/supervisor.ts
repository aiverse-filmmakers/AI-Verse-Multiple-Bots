import type { AppendedEvent } from "./types.js";
import { ExecutionOwnershipError, ExecutionQueue } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { RecoveryCoordinator, type RecoveryDecision } from "./recovery.js";
import { BotRunner } from "./runner.js";

export class ExecutionSupervisor {
  private unsubscribe: (() => void) | null = null;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Map<string, Promise<void>>();
  readonly recovery: RecoveryCoordinator;

  constructor(
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue,
    readonly runner: BotRunner,
    readonly recoverySweepMs = 5000
  ) {
    this.recovery = new RecoveryCoordinator(gateway.store, queue, gateway);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.gateway.subscribeEvents((event) => this.onEvent(event));
    this.sweepRecovery();
    for (const targetId of this.queue.listQueuedTargets()) this.trigger(targetId);
    if (this.recoverySweepMs > 0) {
      this.recoveryTimer = setInterval(() => this.sweepRecovery(), this.recoverySweepMs);
    }
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

  trigger(botId: string): void {
    if (this.inFlight.has(botId)) return;
    const bot = this.gateway.getBot(botId);
    if (!bot) return;
    const adapterId = String(bot.payload.runtime.adapter);
    if (!this.runner.runtimes.has(adapterId)) return;

    const work = this.drain(botId).finally(() => {
      this.inFlight.delete(botId);
      if (this.queue.list(botId, ["queued"]).length > 0) this.trigger(botId);
    });
    this.inFlight.set(botId, work);
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
    for (const decision of decisions) {
      if (decision.action === "requeued") this.trigger(decision.execution.targetId);
    }
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
    if (appended.event.type !== "task.assigned" || !appended.event.task_id) return;
    const task = this.gateway.store.getObject(appended.event.task_id);
    if (!task || task.kind !== "task") return;
    const assigneeId = task.payload.assignee_id;
    if (typeof assigneeId === "string" && assigneeId.length > 0) this.trigger(assigneeId);
  }

  private async drain(botId: string): Promise<void> {
    while (true) {
      try {
        const result = await this.runner.runNext(botId);
        if (!result) return;
      } catch (error) {
        if (error instanceof ExecutionOwnershipError) return;
        throw error;
      }
    }
  }
}
