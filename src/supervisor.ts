import type { AppendedEvent } from "./types.js";
import { ExecutionQueue } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { BotRunner } from "./runner.js";

export class ExecutionSupervisor {
  private unsubscribe: (() => void) | null = null;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue,
    readonly runner: BotRunner
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.gateway.subscribeEvents((event) => this.onEvent(event));
    for (const targetId of this.queue.listQueuedTargets()) this.trigger(targetId);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()]);
    }
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
      const result = await this.runner.runNext(botId);
      if (!result) return;
    }
  }
}
