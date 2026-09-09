import { createId } from "./id.js";
import { ExecutionQueue } from "./execution-queue.js";
import { CoordinationPolicy } from "./policy.js";
import { CoordinationStore } from "./store.js";
import type { AppendedEvent, BotManifest, CoordinationEvent, DeliveryRecord, JsonObject, StoredObject } from "./types.js";
import { validateBotManifest, validateProtocolObject } from "./validator.js";

function nowIso(): string {
  return new Date().toISOString();
}

export interface SendMessageInput {
  senderId: string;
  targetKind: "bot" | "worker" | "room" | "thread" | "task" | "operator";
  targetId: string;
  workspaceId: string;
  text: string;
  correlationId?: string;
  roomId?: string;
  threadId?: string;
  idempotencyKey?: string;
}

export interface ResponseTarget {
  kind: "bot" | "room" | "thread" | "operator";
  id: string;
  roomId?: string;
  threadId?: string;
}

export interface DelegateInput {
  createdBy: string;
  assigneeId: string;
  workspaceId: string;
  rootObjectiveId: string;
  objective: string;
  reason: string;
  requiredConstraints?: string[];
  expectedOutput?: JsonObject;
  tools?: string[];
  connections?: string[];
  parentTaskId?: string;
  maxHops?: number;
  hop?: number;
  leaseExpiresAt?: string;
  deadlineAt?: string;
  responseTarget?: ResponseTarget;
}

export interface HandoffInput {
  sourceOwnerId: string;
  targetOwnerId: string;
  workspaceId: string;
  workItemId: string;
  rootObjectiveId: string;
  reason: string;
  requiredConstraints?: string[];
  artifactRefs?: string[];
  returnPolicy?: string;
}

export interface PublishRoomMessageInput {
  senderId: string;
  roomId: string;
  workspaceId: string;
  text: string;
  threadId?: string;
  mentions?: string[];
  artifactRefs?: string[];
  correlationId?: string;
  replyToMessageId?: string;
}

export class CoordinationGateway {
  private readonly subscribers = new Set<(event: AppendedEvent) => void>();

  constructor(
    readonly store: CoordinationStore,
    readonly executionQueue?: ExecutionQueue,
    readonly policy?: CoordinationPolicy
  ) {}

  subscribeEvents(listener: (event: AppendedEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  createBot(manifest: BotManifest): StoredObject<BotManifest> {
    const bot = validateBotManifest(manifest);
    const stored = this.store.putObject("bot", bot) as StoredObject<BotManifest>;
    this.emit({
      type: "bot.created",
      actorId: bot.id,
      workspaceId: stored.workspaceId,
      summary: `Created Bot ${bot.name}`
    });
    return stored;
  }

  listBots(workspaceId?: string): StoredObject<BotManifest>[] {
    return this.store.listObjects("bot", workspaceId) as StoredObject<BotManifest>[];
  }

  getBot(id: string): StoredObject<BotManifest> | null {
    const object = this.store.getObject(id);
    return object?.kind === "bot" ? object as StoredObject<BotManifest> : null;
  }

  record(kind: Parameters<CoordinationStore["putObject"]>[0], payload: JsonObject): StoredObject {
    return this.store.putObject(kind, validateProtocolObject(payload, kind));
  }

  delegate(input: DelegateInput): { task: StoredObject; lease: StoredObject; event: AppendedEvent } {
    const prepared = this.policy?.prepareDelegation({
      createdBy: input.createdBy,
      assigneeId: input.assigneeId,
      workspaceId: input.workspaceId,
      rootObjectiveId: input.rootObjectiveId,
      objective: input.objective,
      requiredConstraints: input.requiredConstraints,
      tools: input.tools,
      connections: input.connections,
      parentTaskId: input.parentTaskId,
      hop: input.hop,
      maxHops: input.maxHops,
      deadlineAt: input.deadlineAt
    }) ?? {
      parentTaskId: input.parentTaskId ?? null,
      requiredConstraints: input.requiredConstraints ?? [],
      hop: input.hop ?? 0,
      maxHops: input.maxHops ?? 6
    };

    const leaseId = createId("lease");
    const taskId = createId("task");
    const lease: JsonObject = {
      schema_version: "1.0",
      id: leaseId,
      type: "capability_lease",
      principal: input.createdBy,
      issued_to: input.assigneeId,
      workspace_id: input.workspaceId,
      task_id: taskId,
      tools: input.tools ?? [],
      connections: input.connections ?? [],
      destructive_actions: "deny",
      expires_at: input.leaseExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()
    };
    const storedLease = this.store.putObject("capability_lease", validateProtocolObject(lease, "capability_lease"));
    const task: JsonObject = {
      schema_version: "1.0",
      id: taskId,
      type: "task.delegate",
      created_by: input.createdBy,
      assignee_id: input.assigneeId,
      owner_id: input.assigneeId,
      workspace_id: input.workspaceId,
      root_objective_id: input.rootObjectiveId,
      parent_task_id: prepared.parentTaskId,
      reason: input.reason,
      objective: input.objective,
      required_constraints: prepared.requiredConstraints,
      expected_output: input.expectedOutput ?? { contract: "artifact-or-structured-result" },
      input_artifact_refs: [],
      lease_id: leaseId,
      environment_lease_id: null,
      response_target: input.responseTarget ?? null,
      deadline_at: input.deadlineAt ?? null,
      hop: prepared.hop,
      max_hops: prepared.maxHops,
      status: "assigned"
    };
    const storedTask = this.store.putObject("task", validateProtocolObject(task, "task"));
    this.executionQueue?.enqueueTask(taskId, input.assigneeId, input.workspaceId);
    const event = this.emit({
      type: "task.assigned",
      actorId: input.createdBy,
      workspaceId: input.workspaceId,
      taskId,
      roomId: input.responseTarget?.roomId ?? (input.responseTarget?.kind === "room" ? input.responseTarget.id : null),
      threadId: input.responseTarget?.threadId ?? (input.responseTarget?.kind === "thread" ? input.responseTarget.id : null),
      correlationId: input.rootObjectiveId,
      summary: `Delegated task ${taskId} to ${input.assigneeId}`
    });
    return { task: storedTask, lease: storedLease, event };
  }

  requestHandoff(input: HandoffInput): { handoff: StoredObject; event: AppendedEvent } {
    const handoffId = createId("handoff");
    const handoff: JsonObject = {
      schema_version: "1.0",
      id: handoffId,
      type: "handoff",
      source_owner_id: input.sourceOwnerId,
      target_owner_id: input.targetOwnerId,
      workspace_id: input.workspaceId,
      work_item_id: input.workItemId,
      root_objective_id: input.rootObjectiveId,
      reason: input.reason,
      required_constraints: input.requiredConstraints ?? [],
      artifact_refs: input.artifactRefs ?? [],
      return_policy: input.returnPolicy ?? "return_on_completion",
      status: "requested"
    };
    const stored = this.store.putObject("handoff", validateProtocolObject(handoff, "handoff"));
    const event = this.emit({
      type: "handoff.requested",
      actorId: input.sourceOwnerId,
      workspaceId: input.workspaceId,
      taskId: input.workItemId.startsWith("task_") ? input.workItemId : null,
      correlationId: input.rootObjectiveId,
      summary: `Handoff requested from ${input.sourceOwnerId} to ${input.targetOwnerId}`
    });
    return { handoff: stored, event };
  }

  acceptHandoff(handoffId: string, actorId: string): { handoff: StoredObject; workItem: StoredObject | null; events: AppendedEvent[] } {
    const stored = this.store.getObject(handoffId);
    if (!stored || stored.kind !== "handoff") throw new Error(`Handoff ${handoffId} not found`);
    const handoff = { ...stored.payload };
    if (handoff.status !== "requested") throw new Error(`Handoff ${handoffId} is not requested`);
    if (handoff.target_owner_id !== actorId) throw new Error(`Only target owner ${String(handoff.target_owner_id)} can accept this handoff`);
    handoff.status = "accepted";
    handoff.accepted_at = nowIso();
    const accepted = this.store.putObject("handoff", handoff);

    const workItemId = String(handoff.work_item_id);
    const workItem = this.store.getObject(workItemId);
    let updatedWorkItem: StoredObject | null = null;
    if (workItem && (workItem.kind === "task" || workItem.kind === "team_run")) {
      const payload = { ...workItem.payload, owner_id: actorId };
      updatedWorkItem = this.store.putObject(workItem.kind, payload);
    }

    const workspaceId = String(handoff.workspace_id);
    const events = [
      this.emit({ type: "handoff.accepted", actorId, workspaceId, correlationId: String(handoff.root_objective_id), summary: `Accepted handoff ${handoffId}` }),
      this.emit({ type: "ownership.changed", actorId, workspaceId, taskId: workItem?.kind === "task" ? workItemId : null, correlationId: String(handoff.root_objective_id), summary: `${actorId} now owns ${workItemId}` })
    ];
    return { handoff: accepted, workItem: updatedWorkItem, events };
  }

  sendMessage(input: SendMessageInput): { message: StoredObject; delivery: DeliveryRecord; event: AppendedEvent } {
    if (input.targetKind === "bot") this.policy?.assertMessage(input.senderId, input.targetId, input.workspaceId);

    const messageId = createId("msg");
    const message: JsonObject = {
      schema_version: "1.0",
      id: messageId,
      type: "message.chat",
      timestamp: nowIso(),
      sender_id: input.senderId,
      target: { kind: input.targetKind, id: input.targetId },
      workspace_id: input.workspaceId,
      room_id: input.roomId ?? null,
      thread_id: input.threadId ?? null,
      correlation_id: input.correlationId ?? null,
      delivery_state: "queued",
      content: [{ kind: "text", text: input.text }],
      provenance: { origin: "bot_generated", trusted_instruction: false }
    };
    validateProtocolObject(message, "message");
    const stored = this.store.putObject("message", message);
    const timestamp = nowIso();
    const delivery = this.store.enqueueDelivery({
      id: createId("delivery"),
      messageId,
      senderId: input.senderId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      workspaceId: input.workspaceId,
      state: "queued",
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const event = this.emit({
      type: "message.queued",
      actorId: input.senderId,
      workspaceId: input.workspaceId,
      roomId: input.roomId,
      threadId: input.threadId,
      correlationId: input.correlationId,
      summary: `Message queued for ${input.targetKind}:${input.targetId}`,
      idempotencyKey: input.idempotencyKey
    });
    return { message: stored, delivery, event };
  }

  publishRoomMessage(input: PublishRoomMessageInput): { message: StoredObject; event: AppendedEvent } {
    const room = this.store.getObject(input.roomId);
    if (!room || room.kind !== "room") throw new Error(`Room ${input.roomId} not found`);
    if (room.payload.status !== "active") throw new Error(`Room ${input.roomId} is not active`);
    if (room.workspaceId !== input.workspaceId) throw new Error(`Room ${input.roomId} is not in workspace ${input.workspaceId}`);

    const members = Array.isArray(room.payload.members) ? room.payload.members.map(String) : [];
    if (input.senderId.startsWith("bot_") && !members.includes(input.senderId)) {
      throw new Error(`Bot ${input.senderId} is not a member of Room ${input.roomId}`);
    }
    for (const mentionId of input.mentions ?? []) {
      if (!members.includes(mentionId)) throw new Error(`Mentioned Bot ${mentionId} is not a member of Room ${input.roomId}`);
    }

    if (input.threadId) {
      const thread = this.store.getObject(input.threadId);
      if (!thread || thread.kind !== "thread") throw new Error(`Thread ${input.threadId} not found`);
      if (thread.payload.room_id !== input.roomId) throw new Error(`Thread ${input.threadId} does not belong to Room ${input.roomId}`);
    }

    const messageId = createId("msg");
    const message: JsonObject = {
      schema_version: "1.0",
      id: messageId,
      type: "message.chat",
      timestamp: nowIso(),
      sender_id: input.senderId,
      target: { kind: input.threadId ? "thread" : "room", id: input.threadId ?? input.roomId },
      workspace_id: input.workspaceId,
      room_id: input.roomId,
      thread_id: input.threadId ?? null,
      reply_to_message_id: input.replyToMessageId ?? null,
      correlation_id: input.correlationId ?? null,
      delivery_state: "delivered",
      content: [{ kind: "text", text: input.text }],
      mentions: input.mentions ?? [],
      artifact_refs: input.artifactRefs ?? [],
      provenance: {
        origin: input.senderId.startsWith("bot_") ? "bot_generated" : input.senderId.startsWith("worker_") ? "worker_generated" : "operator_input",
        trusted_instruction: !input.senderId.startsWith("bot_") && !input.senderId.startsWith("worker_")
      }
    };
    const stored = this.store.putObject("message", validateProtocolObject(message, "message"));
    const event = this.emit({
      type: "room.message",
      actorId: input.senderId,
      workspaceId: input.workspaceId,
      roomId: input.roomId,
      threadId: input.threadId,
      correlationId: input.correlationId,
      summary: input.text.length > 160 ? `${input.text.slice(0, 157)}...` : input.text
    });
    return { message: stored, event };
  }

  emit(input: {
    type: string;
    actorId: string;
    workspaceId?: string | null;
    roomId?: string | null;
    threadId?: string | null;
    runId?: string | null;
    taskId?: string | null;
    correlationId?: string | null;
    causationId?: string | null;
    traceId?: string | null;
    summary?: string | null;
    attentionState?: string;
    idempotencyKey?: string;
  }): AppendedEvent {
    const event: CoordinationEvent = {
      schema_version: "1.0",
      id: createId("evt"),
      type: input.type,
      timestamp: nowIso(),
      actor_id: input.actorId,
      workspace_id: input.workspaceId ?? null,
      room_id: input.roomId ?? null,
      thread_id: input.threadId ?? null,
      run_id: input.runId ?? null,
      task_id: input.taskId ?? null,
      correlation_id: input.correlationId ?? null,
      causation_id: input.causationId ?? null,
      trace_id: input.traceId ?? null,
      summary: input.summary ?? null,
      ...(input.attentionState ? { attention_state: input.attentionState } : {})
    };
    const appended = this.store.appendEvent(event, input.idempotencyKey);
    for (const listener of this.subscribers) listener(appended);
    return appended;
  }
}
