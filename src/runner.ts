import { createId } from "./id.js";
import { ExecutionQueue, type ExecutionRecord } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { RuntimeRegistry } from "./runtime.js";
import { CoordinationStore } from "./store.js";
import type { JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

function nowIso(): string {
  return new Date().toISOString();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export interface RunResult {
  execution: ExecutionRecord;
  task: StoredObject;
  artifact: StoredObject | null;
  status: "completed" | "failed";
}

export class BotRunner {
  constructor(
    readonly store: CoordinationStore,
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue,
    readonly runtimes: RuntimeRegistry,
    readonly runnerId = "runner_local"
  ) {}

  async runNext(botId: string): Promise<RunResult | null> {
    const bot = this.gateway.getBot(botId);
    if (!bot) throw new Error(`Bot ${botId} not found`);
    if (bot.payload.status !== "active") throw new Error(`Bot ${botId} is not active`);

    const adapterId = String(bot.payload.runtime.adapter);
    if (!this.runtimes.has(adapterId)) {
      throw new Error(`Runtime adapter ${adapterId} is not registered`);
    }

    const claimed = this.queue.claimNext(botId, this.runnerId);
    if (!claimed) return null;

    if (claimed.itemKind !== "task") {
      this.queue.updateState(claimed.id, "failed", `Unsupported execution kind ${claimed.itemKind}`);
      throw new Error(`Unsupported execution kind ${claimed.itemKind}`);
    }

    const task = this.store.getObject(claimed.itemId);
    if (!task || task.kind !== "task") {
      this.queue.updateState(claimed.id, "failed", `Task ${claimed.itemId} not found`);
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

      const runningTaskPayload: JsonObject = {
        ...task.payload,
        status: "running",
        started_at: nowIso()
      };
      const runningTask = this.store.putObject("task", validateProtocolObject(runningTaskPayload, "task"));
      this.queue.updateState(claimed.id, "running");
      this.gateway.emit({
        type: "task.started",
        actorId: botId,
        workspaceId: claimed.workspaceId,
        taskId: task.id,
        summary: `${botId} started ${task.id}`
      });

      const adapter = this.runtimes.get(adapterId);
      const result = await adapter.execute({
        bot,
        task: runningTask,
        capabilityLease: lease,
        environmentLease,
        inputArtifacts
      });

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
        provenance: {
          origin: "bot_generated",
          trusted_instruction: false,
          source_refs: stringArray(task.payload.input_artifact_refs)
        }
      };
      const artifact = this.store.putObject("artifact", validateProtocolObject(artifactPayload, "artifact"));
      this.gateway.emit({
        type: "artifact.published",
        actorId: botId,
        workspaceId: claimed.workspaceId,
        taskId: task.id,
        summary: `Published artifact ${artifactId}`
      });

      const completedTaskPayload: JsonObject = {
        ...runningTask.payload,
        status: "completed",
        completed_at: nowIso(),
        output_artifact_refs: [artifactId]
      };
      const completedTask = this.store.putObject("task", validateProtocolObject(completedTaskPayload, "task"));
      const completedExecution = this.queue.updateState(claimed.id, "completed");
      this.gateway.emit({
        type: "task.completed",
        actorId: botId,
        workspaceId: claimed.workspaceId,
        taskId: task.id,
        summary: result.summary,
        attentionState: "unread_result"
      });

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

      return {
        execution: completedExecution,
        task: completedTask,
        artifact,
        status: "completed"
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedTaskPayload: JsonObject = {
        ...task.payload,
        status: "failed",
        failed_at: nowIso(),
        failure_reason: message
      };
      const failedTask = this.store.putObject("task", validateProtocolObject(failedTaskPayload, "task"));
      const failedExecution = this.queue.updateState(claimed.id, "failed", message);
      this.gateway.emit({
        type: "task.failed",
        actorId: botId,
        workspaceId: claimed.workspaceId,
        taskId: task.id,
        summary: message,
        attentionState: "failed"
      });
      return {
        execution: failedExecution,
        task: failedTask,
        artifact: null,
        status: "failed"
      };
    }
  }
}
