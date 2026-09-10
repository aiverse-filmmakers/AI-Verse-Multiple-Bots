import { normalizeMemoryRecallRequest, type MemoryRecallRequest } from "./ai-verse-memory-recall.js";
import type { ExecutionQueue } from "./execution-queue.js";
import type { CoordinationGateway } from "./gateway.js";
import { createId } from "./id.js";
import type { CoordinationStore } from "./store.js";
import type { CoordinationEvent, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

export interface BindMemoryRecallInput {
  taskId: string;
  actorId: string;
  request: unknown;
}

export interface BindMemoryRecallResult {
  task: StoredObject;
  request: MemoryRecallRequest;
  changed: boolean;
}

export class MemoryRecallTaskBinder {
  constructor(
    readonly store: CoordinationStore,
    readonly queue?: ExecutionQueue,
    readonly gateway?: CoordinationGateway
  ) {}

  bind(input: BindMemoryRecallInput): BindMemoryRecallResult {
    const task = this.store.getObject(input.taskId);
    if (!task || task.kind !== "task") throw new Error(`Memory recall Task ${input.taskId} not found`);
    if (!new Set(["assigned", "waiting_approval"]).has(String(task.payload.status))) {
      throw new Error(`Task ${task.id} cannot change Memory recall from status ${String(task.payload.status)}`);
    }
    this.assertActor(task, input.actorId);

    const execution = this.queue?.getByItem(task.id);
    if (execution && execution.state !== "queued") {
      throw new Error(`Task ${task.id} execution is already ${execution.state}; Memory recall must be bound before claim`);
    }
    const request = normalizeMemoryRecallRequest(input.request, task.payload.objective);
    if (!request) throw new Error("Memory recall binder requires an enabled recall request");

    if (this.sameRequest(task.payload.memory_recall, request)) {
      return { task, request, changed: false };
    }

    const timestamp = new Date().toISOString();
    const payload = validateProtocolObject({
      ...task.payload,
      memory_recall: request,
      memory_recall_requested_at: timestamp,
      memory_recall_requested_by: input.actorId
    }, "task");
    const event: CoordinationEvent = {
      schema_version: "1.0",
      id: createId("evt"),
      type: "task.memory_recall_requested",
      timestamp,
      actor_id: input.actorId,
      workspace_id: task.workspaceId ?? null,
      task_id: task.id,
      correlation_id: typeof task.payload.root_objective_id === "string" ? task.payload.root_objective_id : null,
      summary: `Bound explicit AI-Verse Memory recall to ${task.id}`
    };
    const mutation = this.store.atomicMutation({
      preconditions: [{
        id: task.id,
        kind: "task",
        status: String(task.payload.status),
        updatedAt: task.updatedAt
      }],
      objects: [{ kind: "task", payload }],
      events: [event]
    });
    if (this.gateway) {
      // The store mutation is authoritative; this bounded event remains available
      // through normal replay even when no live Gateway subscriber is present.
    }
    const updated = mutation.objects.find((object) => object.id === task.id);
    if (!updated) throw new Error(`Memory recall binding for Task ${task.id} did not persist`);
    return { task: updated, request, changed: true };
  }

  private assertActor(task: StoredObject, actorId: string): void {
    if (actorId.startsWith("operator_")) return;
    const allowed = new Set([
      String(task.payload.owner_id ?? ""),
      String(task.payload.assignee_id ?? ""),
      String(task.payload.created_by ?? "")
    ].filter(Boolean));
    const runId = typeof task.payload.run_id === "string" ? task.payload.run_id : null;
    if (runId) {
      const run = this.store.getObject(runId);
      if (run?.kind === "team_run" && typeof run.payload.leader_id === "string") allowed.add(run.payload.leader_id);
    }
    if (!allowed.has(actorId)) {
      throw new Error(`Actor ${actorId} cannot bind Memory recall to Task ${task.id}`);
    }
  }

  private sameRequest(value: unknown, request: MemoryRecallRequest): boolean {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const current = value as Record<string, unknown>;
    return current.query === request.query
      && current.limit === request.limit
      && current.include_history === request.include_history;
  }
}
