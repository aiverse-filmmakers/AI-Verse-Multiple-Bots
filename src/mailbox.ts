import { createHash } from "node:crypto";
import { CanonicalEventBus } from "./event-bus.js";
import { createId } from "./id.js";
import { CoordinationPolicy } from "./policy.js";
import { CoordinationStore } from "./store.js";
import type { AppendedEvent, CoordinationEvent, DeliveryRecord, DeliveryState, JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

export const DELIVERY_STATES = [
  "queued",
  "accepted",
  "delivered",
  "processing",
  "replied",
  "expired",
  "failed",
  "canceled"
] as const satisfies readonly DeliveryState[];

const DELIVERY_STATE_SET = new Set<string>(DELIVERY_STATES);
const WAKEABLE_STATES: DeliveryState[] = ["queued", "accepted", "delivered", "processing"];
const EXPIRABLE_STATES = new Set<DeliveryState>(["queued", "accepted", "delivered"]);
const TRANSITIONS: Record<DeliveryState, readonly DeliveryState[]> = {
  queued: ["accepted", "expired", "failed", "canceled"],
  accepted: ["delivered", "expired", "failed", "canceled"],
  delivered: ["processing", "expired", "failed", "canceled"],
  processing: ["replied", "failed", "canceled"],
  replied: [],
  expired: [],
  failed: [],
  canceled: []
};

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
  expiresAt?: string;
}

export interface MailboxTransitionInput {
  state: DeliveryState;
  actorId: string;
  reason?: string;
  replyMessageId?: string;
  now?: number;
}

export interface MailboxWake {
  message: StoredObject;
  delivery: DeliveryRecord;
  event: AppendedEvent | null;
  recovered: boolean;
}

export type MailboxWakeListener = (wake: MailboxWake) => void;

export class MailboxError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MailboxError";
  }
}

function iso(now = Date.now()): string {
  return new Date(now).toISOString();
}

function deterministicId(prefix: string, namespace: string): string {
  return `${prefix}_${createHash("sha256").update(namespace).digest("hex").slice(0, 32)}`;
}

function requestFingerprint(input: SendMessageInput): string {
  return createHash("sha256").update(JSON.stringify([
    input.senderId,
    input.targetKind,
    input.targetId,
    input.workspaceId,
    input.text,
    input.correlationId ?? null,
    input.roomId ?? null,
    input.threadId ?? null,
    input.expiresAt ?? null
  ])).digest("hex");
}

function state(value: unknown): DeliveryState {
  const candidate = String(value);
  if (!DELIVERY_STATE_SET.has(candidate)) {
    throw new MailboxError("INVALID_DELIVERY_STATE", `Unsupported delivery state ${candidate}`);
  }
  return candidate as DeliveryState;
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

export class MailboxCoordinator {
  constructor(
    readonly store: CoordinationStore,
    readonly events: CanonicalEventBus,
    readonly policy?: CoordinationPolicy
  ) {}

  send(input: SendMessageInput): { message: StoredObject; delivery: DeliveryRecord; event: AppendedEvent } {
    if (!input.text.trim()) throw new MailboxError("EMPTY_MESSAGE", "Mailbox message text cannot be empty");
    if (input.targetKind === "bot") this.policy?.assertMessage(input.senderId, input.targetId, input.workspaceId);

    if (input.expiresAt !== undefined) {
      const expires = Date.parse(input.expiresAt);
      if (!Number.isFinite(expires)) throw new MailboxError("INVALID_EXPIRY", "expiresAt must be a valid timestamp");
      if (expires <= Date.now()) throw new MailboxError("INVALID_EXPIRY", "expiresAt must be in the future when queued");
    }

    const fingerprint = requestFingerprint(input);
    const namespace = input.idempotencyKey ? `mailbox:${input.idempotencyKey}` : null;
    const messageId = namespace ? deterministicId("msg", namespace) : createId("msg");
    const deliveryId = namespace ? deterministicId("delivery", namespace) : createId("delivery");
    const queuedEventId = namespace ? deterministicId("evt", `${namespace}:queued`) : createId("evt");

    const prior = this.store.getObject(messageId);
    if (prior) return this.resolveRetry(prior, input, fingerprint, deliveryId, queuedEventId);

    const timestamp = iso();
    const correlationId = input.correlationId ?? (namespace ? deterministicId("corr", namespace) : createId("corr"));
    const origin = input.senderId.startsWith("bot_")
      ? "bot_generated"
      : input.senderId.startsWith("worker_")
        ? "worker_generated"
        : "operator_input";

    const message: JsonObject = {
      schema_version: "1.0",
      id: messageId,
      type: "message.chat",
      timestamp,
      sender_id: input.senderId,
      target: { kind: input.targetKind, id: input.targetId },
      workspace_id: input.workspaceId,
      room_id: input.roomId ?? null,
      thread_id: input.threadId ?? null,
      correlation_id: correlationId,
      idempotency_key: input.idempotencyKey ?? null,
      request_fingerprint: fingerprint,
      queued_event_id: queuedEventId,
      last_delivery_event_id: queuedEventId,
      expires_at: input.expiresAt ?? null,
      delivery_state: "queued",
      delivery_updated_at: timestamp,
      delivery_history: [{ state: "queued", timestamp, actor_id: input.senderId }],
      content: [{ kind: "text", text: input.text }],
      provenance: { origin, trusted_instruction: origin === "operator_input" }
    };
    validateProtocolObject(message, "message");

    const delivery: DeliveryRecord = {
      id: deliveryId,
      messageId,
      senderId: input.senderId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      workspaceId: input.workspaceId,
      state: "queued",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const event = this.events.prepare(this.deliveryEvent({
      id: queuedEventId,
      type: "message.queued",
      timestamp,
      actorId: input.senderId,
      workspaceId: input.workspaceId,
      roomId: input.roomId ?? null,
      threadId: input.threadId ?? null,
      correlationId,
      causationId: null,
      messageId,
      deliveryId,
      summary: `Message queued for ${input.targetKind}:${input.targetId}`
    }));

    let mutation;
    try {
      mutation = this.store.atomicMutation({
        objects: [{ kind: "message", payload: message }],
        events: [event],
        deliveryInsert: delivery
      });
    } catch (error) {
      if (namespace) {
        const raced = this.store.getObject(messageId);
        if (raced) return this.resolveRetry(raced, input, fingerprint, deliveryId, queuedEventId);
      }
      throw error;
    }

    this.events.publishCommitted(mutation.events);
    const storedMessage = mutation.objects[0];
    const storedEvent = mutation.events[0];
    const storedDelivery = this.store.getDelivery(messageId);
    if (!storedMessage || !storedEvent || !storedDelivery) {
      throw new MailboxError("DELIVERY_COMMIT_FAILED", `Mailbox send ${messageId} committed incompletely`);
    }
    return { message: storedMessage, delivery: storedDelivery, event: storedEvent };
  }

  getDelivery(messageId: string): DeliveryRecord | null {
    return this.store.getDelivery(messageId);
  }

  list(targetId: string, states?: DeliveryState[]): DeliveryRecord[] {
    if (!targetId) throw new MailboxError("INVALID_TARGET", "Mailbox target ID is required");
    if (states) {
      for (const item of states) state(item);
      return this.store.listMailbox(targetId, states);
    }
    return this.store.listMailbox(targetId);
  }

  subscribeWake(targetId: string, listener: MailboxWakeListener, replayPending = true): () => void {
    if (!targetId) throw new MailboxError("INVALID_TARGET", "Mailbox wake target ID is required");

    if (replayPending) {
      for (const delivery of this.store.listMailbox(targetId, WAKEABLE_STATES)) {
        const message = this.store.getObject(delivery.messageId);
        if (!message || message.kind !== "message") continue;
        const eventId = typeof message.payload.last_delivery_event_id === "string"
          ? message.payload.last_delivery_event_id
          : typeof message.payload.queued_event_id === "string"
            ? message.payload.queued_event_id
            : null;
        this.safeWake(listener, {
          message,
          delivery,
          event: eventId ? this.store.getEventById(eventId) : null,
          recovered: true
        });
      }
    }

    return this.events.subscribe((event) => {
      if (event.event.type !== "message.queued" || typeof event.event.message_id !== "string") return;
      const delivery = this.store.getDelivery(event.event.message_id);
      if (!delivery || delivery.targetId !== targetId || delivery.state !== "queued") return;
      const message = this.store.getObject(delivery.messageId);
      if (!message || message.kind !== "message") return;
      this.safeWake(listener, { message, delivery, event, recovered: false });
    });
  }

  transition(messageId: string, input: MailboxTransitionInput): { message: StoredObject; delivery: DeliveryRecord; event: AppendedEvent } {
    const targetState = state(input.state);
    const delivery = this.store.getDelivery(messageId);
    if (!delivery) throw new MailboxError("DELIVERY_NOT_FOUND", `Delivery not found for message ${messageId}`);
    const currentState = delivery.state;
    if (currentState === targetState) {
      throw new MailboxError("NO_DELIVERY_CHANGE", `Delivery ${messageId} is already ${targetState}`);
    }
    if (!TRANSITIONS[currentState].includes(targetState)) {
      throw new MailboxError("INVALID_DELIVERY_TRANSITION", `Delivery ${messageId} cannot move from ${currentState} to ${targetState}`);
    }

    const message = this.store.getObject(messageId);
    if (!message || message.kind !== "message") throw new MailboxError("MESSAGE_NOT_FOUND", `Message ${messageId} not found`);
    this.assertActor(delivery, targetState, input.actorId);

    const transitionNow = input.now ?? Date.now();
    if (targetState === "expired") {
      const expires = typeof message.payload.expires_at === "string" ? Date.parse(message.payload.expires_at) : NaN;
      if (!Number.isFinite(expires) || expires > transitionNow) {
        throw new MailboxError("MESSAGE_NOT_EXPIRED", `Message ${messageId} has not reached its expiry`);
      }
    }
    if (targetState === "replied") this.assertReply(delivery, input.replyMessageId);

    const timestamp = iso(transitionNow);
    const correlationId = typeof message.payload.correlation_id === "string" ? message.payload.correlation_id : createId("corr");
    const priorEventId = typeof message.payload.last_delivery_event_id === "string"
      ? message.payload.last_delivery_event_id
      : typeof message.payload.queued_event_id === "string"
        ? message.payload.queued_event_id
        : null;

    const event = this.events.prepare(this.deliveryEvent({
      id: createId("evt"),
      type: `message.${targetState}`,
      timestamp,
      actorId: input.actorId,
      workspaceId: delivery.workspaceId,
      roomId: typeof message.payload.room_id === "string" ? message.payload.room_id : null,
      threadId: typeof message.payload.thread_id === "string" ? message.payload.thread_id : null,
      correlationId,
      causationId: priorEventId,
      messageId,
      deliveryId: delivery.id,
      summary: input.reason ?? `Message moved from ${currentState} to ${targetState}`,
      attentionState: targetState === "failed" ? "failed" : undefined
    }));

    const history = Array.isArray(message.payload.delivery_history) ? [...message.payload.delivery_history] : [];
    history.push({
      state: targetState,
      timestamp,
      actor_id: input.actorId,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.replyMessageId ? { reply_message_id: input.replyMessageId } : {})
    });
    const payload: JsonObject = {
      ...message.payload,
      delivery_state: targetState,
      delivery_updated_at: timestamp,
      delivery_history: history,
      last_delivery_event_id: event.id,
      ...(targetState === "replied" ? { reply_message_id: input.replyMessageId } : {})
    };

    const mutation = this.store.atomicMutation({
      preconditions: [{ id: message.id, kind: "message" }],
      objects: [{ kind: "message", payload }],
      events: [event],
      deliveryTransition: {
        messageId,
        targetId: delivery.targetId,
        fromStates: [currentState],
        toState: targetState,
        updatedAt: timestamp
      }
    });
    this.events.publishCommitted(mutation.events);

    const storedMessage = mutation.objects[0];
    const storedEvent = mutation.events[0];
    const storedDelivery = this.store.getDelivery(messageId);
    if (!storedMessage || !storedEvent || !storedDelivery) {
      throw new MailboxError("DELIVERY_COMMIT_FAILED", `Mailbox transition ${messageId} committed incompletely`);
    }
    return { message: storedMessage, delivery: storedDelivery, event: storedEvent };
  }

  sweepExpired(now = Date.now()): Array<{ message: StoredObject; delivery: DeliveryRecord; event: AppendedEvent }> {
    const results: Array<{ message: StoredObject; delivery: DeliveryRecord; event: AppendedEvent }> = [];
    for (const message of this.store.listObjects("message")) {
      if (typeof message.payload.expires_at !== "string") continue;
      const expiry = Date.parse(message.payload.expires_at);
      if (!Number.isFinite(expiry) || expiry > now) continue;
      const delivery = this.store.getDelivery(message.id);
      if (!delivery || !EXPIRABLE_STATES.has(delivery.state)) continue;
      results.push(this.transition(message.id, {
        state: "expired",
        actorId: "system_mailbox",
        reason: "Mailbox delivery expired",
        now
      }));
    }
    return results;
  }

  private resolveRetry(
    message: StoredObject,
    input: SendMessageInput,
    fingerprint: string,
    deliveryId: string,
    queuedEventId: string
  ): { message: StoredObject; delivery: DeliveryRecord; event: AppendedEvent } {
    if (message.kind !== "message" || String(message.payload.request_fingerprint ?? "") !== fingerprint) {
      throw new MailboxError("IDEMPOTENCY_CONFLICT", `Idempotency key ${String(input.idempotencyKey)} was already used for another send`);
    }
    const delivery = this.store.getDelivery(message.id);
    const event = this.store.getEventById(queuedEventId);
    if (!delivery || delivery.id !== deliveryId || !event) {
      throw new MailboxError("IDEMPOTENCY_INCOMPLETE", `Idempotent mailbox send ${message.id} is missing durable coordination state`);
    }
    return { message, delivery, event };
  }

  private assertActor(delivery: DeliveryRecord, targetState: DeliveryState, actorId: string): void {
    if (actorId.startsWith("operator_") || actorId.startsWith("system_")) return;

    if (["accepted", "delivered", "processing", "replied"].includes(targetState)) {
      if (actorId !== delivery.targetId) {
        throw new MailboxError("DELIVERY_ACTOR_DENIED", `Only target ${delivery.targetId} can move message ${delivery.messageId} to ${targetState}`);
      }
      if (delivery.targetKind === "bot") {
        const bot = this.store.getObject(delivery.targetId);
        if (!bot || bot.kind !== "bot" || bot.payload.status !== "active" || bot.workspaceId !== delivery.workspaceId) {
          throw new MailboxError("TARGET_UNAVAILABLE", `Target Bot ${delivery.targetId} is not active in workspace ${delivery.workspaceId}`);
        }
      }
      return;
    }

    if (targetState === "canceled") {
      if (actorId !== delivery.senderId && actorId !== delivery.targetId) {
        throw new MailboxError("DELIVERY_ACTOR_DENIED", `Only sender, target, system, or operator can cancel message ${delivery.messageId}`);
      }
      return;
    }

    if (targetState === "failed") {
      if (actorId !== delivery.targetId) {
        throw new MailboxError("DELIVERY_ACTOR_DENIED", `Only target, system, or operator can fail message ${delivery.messageId}`);
      }
      return;
    }

    if (targetState === "expired") {
      throw new MailboxError("DELIVERY_ACTOR_DENIED", `Only system or operator can expire message ${delivery.messageId}`);
    }
  }

  private assertReply(delivery: DeliveryRecord, replyMessageId: string | undefined): void {
    if (!replyMessageId) throw new MailboxError("REPLY_REQUIRED", `Message ${delivery.messageId} cannot become replied without replyMessageId`);
    const reply = this.store.getObject(replyMessageId);
    if (!reply || reply.kind !== "message") throw new MailboxError("REPLY_NOT_FOUND", `Reply message ${replyMessageId} not found`);
    if (reply.workspaceId !== delivery.workspaceId) throw new MailboxError("REPLY_SCOPE_MISMATCH", `Reply ${replyMessageId} is outside workspace ${delivery.workspaceId}`);
    if (String(reply.payload.sender_id) !== delivery.targetId) {
      throw new MailboxError("INVALID_REPLY", `Reply ${replyMessageId} was not sent by ${delivery.targetId}`);
    }
    const target = objectValue(reply.payload.target);
    if (!target || String(target.id) !== delivery.senderId) {
      throw new MailboxError("INVALID_REPLY", `Reply ${replyMessageId} is not addressed to ${delivery.senderId}`);
    }
  }

  private deliveryEvent(input: {
    id: string;
    type: string;
    timestamp: string;
    actorId: string;
    workspaceId: string;
    roomId: string | null;
    threadId: string | null;
    correlationId: string;
    causationId: string | null;
    messageId: string;
    deliveryId: string;
    summary: string;
    attentionState?: string;
  }): CoordinationEvent {
    return {
      schema_version: "1.0",
      id: input.id,
      type: input.type,
      timestamp: input.timestamp,
      actor_id: input.actorId,
      workspace_id: input.workspaceId,
      room_id: input.roomId,
      thread_id: input.threadId,
      correlation_id: input.correlationId,
      causation_id: input.causationId,
      trace_id: null,
      message_id: input.messageId,
      delivery_id: input.deliveryId,
      summary: input.summary,
      ...(input.attentionState ? { attention_state: input.attentionState } : {})
    };
  }

  private safeWake(listener: MailboxWakeListener, wake: MailboxWake): void {
    try {
      listener(wake);
    } catch {
      // Runtime wake failures never roll back the durable mailbox commit.
    }
  }
}
