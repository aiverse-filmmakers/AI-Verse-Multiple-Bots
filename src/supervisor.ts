import type { AppendedEvent, JsonObject } from "./types.js";
import { ExecutionOwnershipError, ExecutionQueue } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { RecoveryCoordinator, type RecoveryDecision } from "./recovery.js";
import { BotRunner } from "./runner.js";
import { TeamRunCleanup } from "./team-run-cleanup.js";
import { TeamRunControl } from "./team-run-control.js";
import { TeamRunDiscussion } from "./team-run-discussion.js";
import { TeamRunFanout } from "./team-run-fanout.js";
import { TeamRunCoordinator } from "./team-runs.js";
import { TeamRunSynthesis } from "./team-run-synthesis.js";
import { TeamRunVerifier } from "./team-run-verifier.js";
import { validateProtocolObject } from "./validator.js";

const TERMINAL_WORKER_STATES = new Set(["completed", "failed", "canceled", "expired"]);
const CONTROLLED_TERMINAL_RUN_STATES = new Set(["canceled", "budget_exhausted"]);

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

export class ExecutionSupervisor {
  private unsubscribe: (() => void) | null = null;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Map<string, Promise<void>>();
  private startupFanoutReconcile: Promise<void> | null = null;
  private startupTerminationReconcile: Promise<void> | null = null;
  readonly recovery: RecoveryCoordinator;
  readonly cleanup: TeamRunCleanup;
  readonly control: TeamRunControl;
  readonly fanout: TeamRunFanout;
  readonly discussion: TeamRunDiscussion;
  readonly verifier: TeamRunVerifier;
  readonly synthesis: TeamRunSynthesis;

  constructor(
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue,
    readonly runner: BotRunner,
    readonly recoverySweepMs = 5000
  ) {
    this.recovery = new RecoveryCoordinator(gateway.store, queue, gateway);
    const teams = new TeamRunCoordinator(gateway.store);
    this.cleanup = new TeamRunCleanup(teams, gateway, queue);
    this.control = runner.teamRunControl;
    this.fanout = new TeamRunFanout(teams, gateway, queue, runner);
    this.discussion = new TeamRunDiscussion(teams, gateway, queue, runner);
    this.verifier = new TeamRunVerifier(teams, gateway, queue, runner);
    this.synthesis = new TeamRunSynthesis(teams, gateway, queue, runner);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.gateway.subscribeEvents((event) => this.onEvent(event));
    const startup = this.startAfterTerminationRecovery();
    this.startupTerminationReconcile = startup;
    void startup.catch((error) => {
      this.gateway.emit({
        type: "team_run.termination_recovery_failed",
        actorId: "system_recovery",
        summary: error instanceof Error ? error.message : String(error),
        attentionState: "failed"
      });
    }).finally(() => {
      if (this.startupTerminationReconcile === startup) this.startupTerminationReconcile = null;
    });
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.recoveryTimer !== null) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    while (true) {
      const terminationStartup = this.startupTerminationReconcile;
      if (terminationStartup) await terminationStartup;
      const startup = this.startupFanoutReconcile;
      if (startup) await startup;
      if (this.inFlight.size > 0) await Promise.all([...this.inFlight.values()]);
      await this.fanout.waitForIdle();
      if (this.inFlight.size === 0 && this.startupFanoutReconcile === null && this.startupTerminationReconcile === null && this.fanout.isIdle()) return;
    }
  }

  trigger(targetId: string): void {
    const startup = this.startupTerminationReconcile;
    if (startup) {
      void startup.finally(() => this.trigger(targetId));
      return;
    }
    if (this.inFlight.has(targetId)) return;
    const adapterId = this.runner.runtimeAdapterIdFor(targetId);
    if (!adapterId || !this.runner.runtimes.has(adapterId)) return;

    const work = Promise.resolve().then(() => this.drain(targetId)).finally(() => {
      this.inFlight.delete(targetId);
      if (this.queue.list(targetId, ["queued"]).length > 0) this.trigger(targetId);
    });
    this.inFlight.set(targetId, work);
  }

  sweepRecovery(now = Date.now()): RecoveryDecision[] {
    this.cleanup.reapStaleDiscussionOpenings({ now });
    let decisions: RecoveryDecision[] = [];
    try {
      decisions = this.recovery.recoverStale(now);
    } catch (error) {
      if (error instanceof ExecutionOwnershipError) {
        this.cleanup.recoverTerminalRuns();
        return decisions;
      }
      this.gateway.emit({
        type: "execution.recovery_failed",
        actorId: "system_recovery",
        summary: error instanceof Error ? error.message : String(error),
        attentionState: "failed"
      });
      this.cleanup.recoverTerminalRuns();
      return decisions;
    }
    for (const decision of decisions) {
      this.syncWorkerRecovery(decision);
      if (decision.action === "requeued") this.trigger(decision.execution.targetId);
      if (decision.action === "dead_letter") {
        void this.runner.cancelRuntimeRecovery(
          decision.execution.itemId,
          decision.execution.targetId
        ).catch(() => undefined);
      }
      if (decision.action === "reconciled" && decision.task) {
        const runId = typeof decision.task.payload.run_id === "string" ? decision.task.payload.run_id : null;
        const run = runId ? this.gateway.store.getObject(runId) : null;
        if (run?.kind === "team_run" && CONTROLLED_TERMINAL_RUN_STATES.has(String(run.payload.status))) {
          void this.control.reconcileTerminalRun(run.id).catch((error) => {
            this.gateway.emit({
              type: "team_run.termination_recovery_failed",
              actorId: "system_recovery",
              workspaceId: run.workspaceId,
              runId: run.id,
              correlationId: String(run.payload.root_objective_id),
              summary: error instanceof Error ? error.message : String(error),
              attentionState: "failed"
            });
          });
          continue;
        }
        void this.fanout.reconcileTask(decision.task.id);
        this.discussion.reconcileTask(decision.task.id);
        this.verifier.reconcileTask(decision.task.id);
        this.synthesis.reconcileTask(decision.task.id);
      }
    }
    this.cleanup.recoverTerminalRuns();
    return decisions;
  }

  retryDeadLetter(taskId: string, actorId: string, reason?: string) {
    const task = this.gateway.store.getObject(taskId);
    const runId = task?.kind === "task" && typeof task.payload.run_id === "string" ? task.payload.run_id : null;
    const run = runId ? this.gateway.store.getObject(runId) : null;
    if (run?.kind === "team_run" && CONTROLLED_TERMINAL_RUN_STATES.has(String(run.payload.status))) {
      throw new Error(`Cannot retry dead-letter Task ${taskId} after Team Run ${run.id} reached ${String(run.payload.status)}`);
    }
    const result = this.recovery.retryDeadLetter(taskId, actorId, reason);
    const worker = this.gateway.store.getObject(result.execution.targetId);
    if (worker?.kind === "worker" && !TERMINAL_WORKER_STATES.has(String(worker.payload.status))) {
      this.setWorkerStatus(worker.id, "ready", `Dead-letter Task ${taskId} was authorized for retry`);
    }
    this.trigger(result.execution.targetId);
    return result;
  }

  private async startAfterTerminationRecovery(): Promise<void> {
    await this.control.recoverPendingTerminations();
    this.cleanup.reapStaleDiscussionOpenings();
    this.fanout.recoverPreparedFanouts();
    const startup = this.fanout.reconcileOpenFanouts();
    this.startupFanoutReconcile = startup;
    void startup.finally(() => {
      if (this.startupFanoutReconcile === startup) this.startupFanoutReconcile = null;
    });
    this.discussion.recoverOpenDiscussions();
    this.verifier.recoverPendingVerifications();
    this.synthesis.recoverPendingSyntheses();
    this.cleanup.recoverTerminalRuns();
    this.sweepRecovery();
    for (const targetId of this.queue.listQueuedTargets()) this.trigger(targetId);
    if (this.recoverySweepMs > 0 && this.recoveryTimer === null) {
      this.recoveryTimer = setInterval(() => this.sweepRecovery(), this.recoverySweepMs);
    }
  }

  private onEvent(appended: AppendedEvent): void {
    if (appended.event.type === "bot.created") {
      this.trigger(appended.event.actor_id);
      return;
    }
    if (appended.event.type !== "task.assigned" || !appended.event.task_id) return;
    const task = this.gateway.store.getObject(appended.event.task_id);
    if (!task || task.kind !== "task") return;
    const runId = typeof task.payload.run_id === "string" ? task.payload.run_id : null;
    const run = runId ? this.gateway.store.getObject(runId) : null;
    if (run?.kind === "team_run" && CONTROLLED_TERMINAL_RUN_STATES.has(String(run.payload.status))) return;
    const assigneeId = task.payload.assignee_id;
    if (typeof assigneeId === "string" && assigneeId.length > 0) this.trigger(assigneeId);
  }

  private syncWorkerRecovery(decision: RecoveryDecision): void {
    const worker = this.gateway.store.getObject(decision.execution.targetId);
    if (!worker || worker.kind !== "worker" || TERMINAL_WORKER_STATES.has(String(worker.payload.status))) return;
    const runId = typeof worker.payload.run_id === "string" ? worker.payload.run_id : null;
    const run = runId ? this.gateway.store.getObject(runId) : null;
    if (run?.kind === "team_run" && CONTROLLED_TERMINAL_RUN_STATES.has(String(run.payload.status))) return;
    if (decision.action === "requeued") this.setWorkerStatus(worker.id, "ready", `Recovered Task ${decision.execution.itemId} was requeued`);
    if (decision.action === "dead_letter") this.setWorkerStatus(worker.id, "waiting", `Task ${decision.execution.itemId} requires recovery review`);
    if (decision.action === "reconciled" && decision.task) {
      const taskStatus = String(decision.task.payload.status);
      const expectedOutput = asObject(decision.task.payload.expected_output);
      const reusableDiscussionWorker = taskStatus === "completed"
        && expectedOutput.contract === "discussion-turn-v1"
        && typeof decision.task.payload.discussion_room_id === "string"
        && Number.isInteger(Number(decision.task.payload.discussion_turn_index));
      const workerStatus = reusableDiscussionWorker ? "waiting" : taskStatus === "completed" ? "completed" : taskStatus === "canceled" ? "canceled" : "failed";
      const reason = reusableDiscussionWorker
        ? `Recovered completed discussion turn ${String(decision.task.payload.discussion_turn_index)}; awaiting explicit next turn`
        : `Recovered execution reconciled to Task ${taskStatus}`;
      this.setWorkerStatus(worker.id, workerStatus, reason);
    }
  }

  private setWorkerStatus(workerId: string, status: string, reason: string): void {
    const worker = this.gateway.store.getObject(workerId);
    if (!worker || worker.kind !== "worker") return;
    const payload: JsonObject = validateProtocolObject({
      ...worker.payload,
      status,
      status_reason: reason,
      updated_at: new Date().toISOString(),
      ...(TERMINAL_WORKER_STATES.has(status) ? { terminal_at: new Date().toISOString() } : { terminal_at: null })
    }, "worker");
    this.gateway.store.putObject("worker", payload);
    this.gateway.emit({
      type: "worker.recovery_status_changed",
      actorId: "system_recovery",
      workspaceId: worker.workspaceId,
      runId: typeof worker.payload.run_id === "string" ? worker.payload.run_id : null,
      taskId: typeof worker.payload.task_id === "string" ? worker.payload.task_id : null,
      summary: `${workerId} -> ${status}: ${reason}`,
      attentionState: status === "waiting" || status === "failed" ? "failed" : undefined
    });
  }

  private async drain(targetId: string): Promise<void> {
    while (true) {
      try {
        const result = await this.runner.runNext(targetId);
        if (!result) return;
        const runId = typeof result.task.payload.run_id === "string" ? result.task.payload.run_id : null;
        const run = runId ? this.gateway.store.getObject(runId) : null;
        if (run?.kind === "team_run" && CONTROLLED_TERMINAL_RUN_STATES.has(String(run.payload.status))) {
          await this.control.reconcileTerminalRun(run.id);
        } else {
          await this.fanout.reconcileTask(result.task.id);
          this.discussion.reconcileTask(result.task.id);
          this.verifier.reconcileTask(result.task.id);
          this.synthesis.reconcileTask(result.task.id);
        }
        if (this.queue.list(targetId, ["queued"]).length === 0) return;
      } catch (error) {
        if (error instanceof ExecutionOwnershipError) return;
        throw error;
      }
    }
  }
}
