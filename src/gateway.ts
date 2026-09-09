import { createId } from "./id.js";
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

export class CoordinationGateway {
  constructor(readonly store: CoordinationStore) {}

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

  sendMessage(input: SendMessageInput): { message: StoredObject; delivery: DeliveryRecord; event: AppendedEvent } {
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
    return this.store.appendEvent(event, input.idempotencyKey);
  }
}
