import { createHash } from "node:crypto";
import type { CoordinationGateway } from "./gateway.js";
import type { RoomCoordinator } from "./rooms.js";
import type { CoordinationStore } from "./store.js";
import type { JsonObject, StoredObject } from "./types.js";

export const CHANNEL_BRIDGE_SCHEMA = "1.0";
export const CHANNEL_BRIDGE_PROVIDER = "ai-verse-multiple-bots/channel-bridge-v1";

export type ChannelTargetKind = "bot" | "room" | "thread";
export type ChannelAttachmentKind = "file" | "image" | "audio" | "video";

export interface ChannelBinding {
  id: string;
  provider: string;
  accountId: string;
  conversationId: string;
  workspaceId: string;
  targetKind: ChannelTargetKind;
  targetId: string;
  roomId?: string;
  enabled?: boolean;
  allowedSenderExternalIds?: string[];
}

export interface ChannelAttachment {
  kind: ChannelAttachmentKind;
  externalRef: string;
  fileName?: string;
  mediaType?: string;
  sizeBytes?: number;
}

export interface NormalizedChannelIngress {
  provider: string;
  accountId: string;
  deliveryId: string;
  conversationId: string;
  senderExternalId: string;
  externalMessageId: string;
  text: string;
  timestamp?: string;
  replyToExternalMessageId?: string;
  attachments?: ChannelAttachment[];
  adapterVerified: boolean;
}

export interface ChannelIngressResult {
  schema_version: typeof CHANNEL_BRIDGE_SCHEMA;
  provider: typeof CHANNEL_BRIDGE_PROVIDER;
  binding_id: string;
  channel_provider: string;
  workspace_id: string;
  actor_id: string;
  canonical_message_id: string;
  event_sequence: number;
  target: {
    kind: ChannelTargetKind;
    id: string;
    room_id?: string;
  };
  scheduled_task_ids: string[];
  duplicate: boolean;
  canonical_owner: "ai-verse-multiple-bots";
  channel_owns_truth: false;
}

export interface ChannelEgressResult {
  schema_version: typeof CHANNEL_BRIDGE_SCHEMA;
  provider: typeof CHANNEL_BRIDGE_PROVIDER;
  binding_id: string;
  channel_provider: string;
  workspace_id: string;
  canonical_message_id: string;
  conversation_id: string;
  external_recipient_id: string | null;
  reply_to_external_message_id: string | null;
  text: string;
  attachments: JsonObject[];
  dedupe_key: string;
  delivery_receipt_required: true;
  transport_command: JsonObject;
  canonical_owner: "ai-verse-multiple-bots";
  channel_owns_truth: false;
}

export class ChannelBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "ChannelBridgeError";
  }
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function requiredScalar(value: unknown, label: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) {
    throw new ChannelBridgeError("INVALID_CHANNEL_PAYLOAD", `${label} is required`);
  }
  return String(value);
}

function providerName(value: unknown): string {
  const provider = requiredScalar(value, "provider").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) {
    throw new ChannelBridgeError("INVALID_CHANNEL_PROVIDER", `Invalid channel provider ${provider}`);
  }
  return provider;
}

function stableHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32);
}

function channelMessageId(provider: string, accountId: string, externalMessageId: string): string {
  return `msg_channel_${stableHash(provider, accountId, externalMessageId)}`;
}

function channelCorrelationId(provider: string, accountId: string, conversationId: string): string {
  return `corr_channel_${stableHash(provider, accountId, conversationId)}`;
}

export function channelActorId(provider: string, accountId: string, senderExternalId: string): string {
  const id = `channel_actor:${encodeURIComponent(provider)}:${encodeURIComponent(accountId)}:${encodeURIComponent(senderExternalId)}`;
  if (id.length > 256) {
    throw new ChannelBridgeError(
      "CHANNEL_ACTOR_ID_TOO_LONG",
      "Channel actor identity exceeds the coordination protocol ID limit"
    );
  }
  return id;
}

export function parseChannelActorId(id: string): {
  provider: string;
  accountId: string;
  senderExternalId: string;
} | null {
  if (!id.startsWith("channel_actor:")) return null;
  const parts = id.split(":");
  if (parts.length !== 4) return null;
  try {
    return {
      provider: decodeURIComponent(parts[1] as string),
      accountId: decodeURIComponent(parts[2] as string),
      senderExternalId: decodeURIComponent(parts[3] as string)
    };
  } catch {
    return null;
  }
}

function normalizeAttachments(value: unknown): ChannelAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ChannelBridgeError("INVALID_CHANNEL_PAYLOAD", "attachments must be an array");
  }
  return value.map((item, index) => {
    const object = asObject(item);
    if (!object) throw new ChannelBridgeError("INVALID_CHANNEL_PAYLOAD", `attachments[${index}] must be an object`);
    const kind = requiredScalar(object.kind, `attachments[${index}].kind`) as ChannelAttachmentKind;
    if (!new Set(["file", "image", "audio", "video"]).has(kind)) {
      throw new ChannelBridgeError("INVALID_CHANNEL_PAYLOAD", `Unsupported attachment kind ${kind}`);
    }
    const sizeBytes = object.sizeBytes === undefined
      ? undefined
      : Number(object.sizeBytes);
    if (sizeBytes !== undefined && (!Number.isInteger(sizeBytes) || sizeBytes < 0)) {
      throw new ChannelBridgeError("INVALID_CHANNEL_PAYLOAD", `attachments[${index}].sizeBytes is invalid`);
    }
    return {
      kind,
      externalRef: requiredScalar(object.externalRef, `attachments[${index}].externalRef`),
      ...(typeof object.fileName === "string" ? { fileName: object.fileName } : {}),
      ...(typeof object.mediaType === "string" ? { mediaType: object.mediaType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {})
    };
  });
}

function contentParts(input: NormalizedChannelIngress): JsonObject[] {
  const parts: JsonObject[] = [];
  if (input.text.length > 0) parts.push({ kind: "text", text: input.text });
  for (const attachment of input.attachments ?? []) {
    const kind = attachment.kind === "image"
      ? "image_ref"
      : attachment.kind === "audio"
        ? "audio_ref"
        : attachment.kind === "video"
          ? "video_ref"
          : "file_ref";
    parts.push({
      kind,
      ref: `channel_attachment_${stableHash(input.provider, input.accountId, attachment.externalRef)}`,
      data: {
        provider: input.provider,
        account_id: input.accountId,
        external_ref: attachment.externalRef,
        ...(attachment.fileName ? { file_name: attachment.fileName } : {}),
        ...(attachment.mediaType ? { media_type: attachment.mediaType } : {}),
        ...(attachment.sizeBytes !== undefined ? { size_bytes: attachment.sizeBytes } : {}),
        remote_fetch_required: true,
        trusted_instruction: false
      }
    });
  }
  if (parts.length === 0) {
    throw new ChannelBridgeError("EMPTY_CHANNEL_MESSAGE", "Channel message has no text or supported attachments");
  }
  return parts;
}

function textForScheduling(input: NormalizedChannelIngress): string {
  if (input.text.trim().length > 0) return input.text;
  const count = input.attachments?.length ?? 0;
  return count === 1 ? "[Channel attachment]" : `[Channel attachments: ${count}]`;
}

function externalChannelMetadata(input: NormalizedChannelIngress, bindingId: string): JsonObject {
  return {
    origin: "external_message",
    trusted_instruction: false,
    channel: {
      provider: input.provider,
      account_id: input.accountId,
      binding_id: bindingId,
      conversation_id: input.conversationId,
      sender_external_id: input.senderExternalId,
      delivery_id: input.deliveryId,
      external_message_id: input.externalMessageId,
      reply_to_external_message_id: input.replyToExternalMessageId ?? null,
      adapter_verified: true
    }
  };
}

export function normalizeTelegramUpdate(
  accountId: string,
  update: JsonObject,
  adapterVerified: boolean
): NormalizedChannelIngress {
  const provider = "telegram";
  const message = asObject(update.message)
    ?? asObject(update.edited_message)
    ?? asObject(update.channel_post)
    ?? asObject(update.edited_channel_post);
  if (!message) {
    throw new ChannelBridgeError("UNSUPPORTED_TELEGRAM_UPDATE", "Telegram update does not contain a supported message payload");
  }
  const chat = asObject(message.chat);
  const from = asObject(message.from) ?? asObject(message.sender_chat);
  if (!chat || !from) {
    throw new ChannelBridgeError("INVALID_CHANNEL_PAYLOAD", "Telegram message requires chat and sender identity");
  }

  const attachments: ChannelAttachment[] = [];
  const photos = Array.isArray(message.photo) ? message.photo : [];
  const largestPhoto = photos.length > 0 ? asObject(photos[photos.length - 1]) : null;
  if (largestPhoto?.file_id) {
    attachments.push({
      kind: "image",
      externalRef: String(largestPhoto.file_id),
      ...(typeof largestPhoto.file_size === "number" ? { sizeBytes: largestPhoto.file_size } : {})
    });
  }
  for (const [key, kind] of [
    ["document", "file"],
    ["audio", "audio"],
    ["voice", "audio"],
    ["video", "video"],
    ["animation", "video"],
    ["sticker", "image"]
  ] as const) {
    const media = asObject(message[key]);
    if (!media?.file_id) continue;
    attachments.push({
      kind,
      externalRef: String(media.file_id),
      ...(typeof media.file_name === "string" ? { fileName: media.file_name } : {}),
      ...(typeof media.mime_type === "string" ? { mediaType: media.mime_type } : {}),
      ...(typeof media.file_size === "number" ? { sizeBytes: media.file_size } : {})
    });
  }

  const externalMessageId = requiredScalar(message.message_id, "Telegram message_id");
  const reply = asObject(message.reply_to_message);
  return {
    provider,
    accountId: requiredScalar(accountId, "accountId"),
    deliveryId: requiredScalar(update.update_id ?? externalMessageId, "Telegram update_id"),
    conversationId: requiredScalar(chat.id, "Telegram chat.id"),
    senderExternalId: requiredScalar(from.id, "Telegram sender id"),
    externalMessageId,
    text: typeof message.text === "string"
      ? message.text
      : typeof message.caption === "string"
        ? message.caption
        : "",
    ...(typeof message.date === "number" ? { timestamp: new Date(message.date * 1000).toISOString() } : {}),
    ...(reply?.message_id !== undefined ? { replyToExternalMessageId: String(reply.message_id) } : {}),
    attachments,
    adapterVerified
  };
}

export function normalizeDiscordMessage(
  accountId: string,
  message: JsonObject,
  adapterVerified: boolean
): NormalizedChannelIngress {
  const author = asObject(message.author);
  if (!author) throw new ChannelBridgeError("INVALID_CHANNEL_PAYLOAD", "Discord message requires author");
  const attachments: ChannelAttachment[] = Array.isArray(message.attachments)
    ? message.attachments.map((item, index) => {
        const attachment = asObject(item);
        if (!attachment) throw new ChannelBridgeError("INVALID_CHANNEL_PAYLOAD", `Discord attachments[${index}] must be an object`);
        const mediaType = typeof attachment.content_type === "string" ? attachment.content_type : undefined;
        const kind: ChannelAttachmentKind = mediaType?.startsWith("image/")
          ? "image"
          : mediaType?.startsWith("audio/")
            ? "audio"
            : mediaType?.startsWith("video/")
              ? "video"
              : "file";
        return {
          kind,
          externalRef: requiredScalar(attachment.id ?? attachment.url, `Discord attachments[${index}].id`),
          ...(typeof attachment.filename === "string" ? { fileName: attachment.filename } : {}),
          ...(mediaType ? { mediaType } : {}),
          ...(typeof attachment.size === "number" ? { sizeBytes: attachment.size } : {})
        };
      })
    : [];
  const referenced = asObject(message.referenced_message);
  const externalMessageId = requiredScalar(message.id, "Discord message.id");
  return {
    provider: "discord",
    accountId: requiredScalar(accountId, "accountId"),
    deliveryId: externalMessageId,
    conversationId: requiredScalar(message.channel_id, "Discord channel_id"),
    senderExternalId: requiredScalar(author.id, "Discord author.id"),
    externalMessageId,
    text: typeof message.content === "string" ? message.content : "",
    ...(typeof message.timestamp === "string" ? { timestamp: message.timestamp } : {}),
    ...(referenced?.id !== undefined ? { replyToExternalMessageId: String(referenced.id) } : {}),
    attachments,
    adapterVerified
  };
}

function normalizeGenericIngress(input: JsonObject): NormalizedChannelIngress {
  return {
    provider: providerName(input.provider),
    accountId: requiredScalar(input.accountId, "accountId"),
    deliveryId: requiredScalar(input.deliveryId, "deliveryId"),
    conversationId: requiredScalar(input.conversationId, "conversationId"),
    senderExternalId: requiredScalar(input.senderExternalId, "senderExternalId"),
    externalMessageId: requiredScalar(input.externalMessageId ?? input.deliveryId, "externalMessageId"),
    text: typeof input.text === "string" ? input.text : "",
    ...(typeof input.timestamp === "string" ? { timestamp: input.timestamp } : {}),
    ...(typeof input.replyToExternalMessageId === "string"
      ? { replyToExternalMessageId: input.replyToExternalMessageId }
      : {}),
    attachments: normalizeAttachments(input.attachments),
    adapterVerified: input.adapterVerified === true
  };
}

export class ChannelBindingRegistry {
  private readonly bindings = new Map<string, Required<Omit<ChannelBinding, "roomId" | "allowedSenderExternalIds">> & Pick<ChannelBinding, "roomId" | "allowedSenderExternalIds">>();

  constructor(bindings: ChannelBinding[] = []) {
    for (const binding of bindings) this.register(binding);
  }

  register(binding: ChannelBinding): void {
    if (!binding.id || binding.id.length > 128) throw new ChannelBridgeError("INVALID_CHANNEL_BINDING", "Channel binding id is invalid");
    const provider = providerName(binding.provider);
    if (!binding.accountId || !binding.conversationId || !binding.workspaceId || !binding.targetId) {
      throw new ChannelBridgeError("INVALID_CHANNEL_BINDING", `Channel binding ${binding.id} is incomplete`);
    }
    if (!new Set(["bot", "room", "thread"]).has(binding.targetKind)) {
      throw new ChannelBridgeError("INVALID_CHANNEL_BINDING", `Channel binding ${binding.id} has invalid target kind`);
    }
    if (binding.targetKind === "thread" && !binding.roomId) {
      throw new ChannelBridgeError("INVALID_CHANNEL_BINDING", `Thread binding ${binding.id} requires roomId`);
    }
    if (this.bindings.has(binding.id)) {
      throw new ChannelBridgeError("CHANNEL_BINDING_CONFLICT", `Channel binding id ${binding.id} already exists`, 409);
    }
    const routeKey = this.routeKey(provider, binding.accountId, binding.conversationId);
    for (const existing of this.bindings.values()) {
      if (existing.enabled && (binding.enabled ?? true) && this.routeKey(existing.provider, existing.accountId, existing.conversationId) === routeKey) {
        throw new ChannelBridgeError(
          "CHANNEL_BINDING_CONFLICT",
          `Channel route ${provider}/${binding.accountId}/${binding.conversationId} is already bound by ${existing.id}`,
          409
        );
      }
    }
    this.bindings.set(binding.id, {
      ...binding,
      provider,
      enabled: binding.enabled ?? true,
      allowedSenderExternalIds: binding.allowedSenderExternalIds
        ? [...new Set(binding.allowedSenderExternalIds.map(String))]
        : undefined
    });
  }

  get(id: string) {
    return this.bindings.get(id) ?? null;
  }

  resolve(provider: string, accountId: string, conversationId: string) {
    const normalizedProvider = providerName(provider);
    const routeKey = this.routeKey(normalizedProvider, accountId, conversationId);
    const binding = [...this.bindings.values()].find((candidate) =>
      candidate.enabled && this.routeKey(candidate.provider, candidate.accountId, candidate.conversationId) === routeKey
    );
    if (!binding) {
      throw new ChannelBridgeError(
        "CHANNEL_ROUTE_NOT_FOUND",
        `No enabled channel binding for ${normalizedProvider}/${accountId}/${conversationId}`,
        404
      );
    }
    return binding;
  }

  publicBindings(): JsonObject[] {
    return [...this.bindings.values()].map((binding) => ({
      id: binding.id,
      provider: binding.provider,
      account_id: binding.accountId,
      conversation_id: binding.conversationId,
      workspace_id: binding.workspaceId,
      target: {
        kind: binding.targetKind,
        id: binding.targetId,
        ...(binding.roomId ? { room_id: binding.roomId } : {})
      },
      enabled: binding.enabled
    }));
  }

  private routeKey(provider: string, accountId: string, conversationId: string): string {
    return `${provider}\u001f${accountId}\u001f${conversationId}`;
  }
}

export class ChannelBridgeBoundary {
  readonly bindings: ChannelBindingRegistry;

  constructor(
    readonly gateway: CoordinationGateway,
    readonly rooms: RoomCoordinator,
    readonly store: CoordinationStore,
    bindings: ChannelBinding[] = []
  ) {
    this.bindings = new ChannelBindingRegistry(bindings);
  }

  capabilities(): JsonObject {
    return {
      schema_version: CHANNEL_BRIDGE_SCHEMA,
      provider: CHANNEL_BRIDGE_PROVIDER,
      contract_only: true,
      canonical_owner: "ai-verse-multiple-bots",
      channel_owns_truth: false,
      supported_adapters: ["telegram", "discord", "generic"],
      ingress: {
        verification_owner: "external-channel-adapter",
        normalized_endpoint: "/v1/channels/ingress",
        telegram_endpoint: "/v1/channels/telegram/ingress",
        discord_endpoint: "/v1/channels/discord/ingress",
        raw_public_webhooks_terminated_here: false
      },
      egress: {
        formatting_endpoint: "/v1/channels/egress",
        receipt_endpoint: "/v1/channels/egress/receipt",
        network_delivery_owner: "external-channel-adapter"
      },
      bindings: this.bindings.publicBindings()
    };
  }

  ingestGeneric(input: JsonObject): ChannelIngressResult {
    return this.ingestNormalized(normalizeGenericIngress(input));
  }

  ingestTelegram(accountId: string, update: JsonObject, adapterVerified: boolean): ChannelIngressResult {
    return this.ingestNormalized(normalizeTelegramUpdate(accountId, update, adapterVerified));
  }

  ingestDiscord(accountId: string, message: JsonObject, adapterVerified: boolean): ChannelIngressResult {
    return this.ingestNormalized(normalizeDiscordMessage(accountId, message, adapterVerified));
  }

  ingestNormalized(input: NormalizedChannelIngress): ChannelIngressResult {
    if (!input.adapterVerified) {
      throw new ChannelBridgeError(
        "CHANNEL_ADAPTER_UNVERIFIED",
        "Channel ingress must come from an adapter that already verified the provider transport",
        403
      );
    }
    input.provider = providerName(input.provider);
    if (input.timestamp && !Number.isFinite(Date.parse(input.timestamp))) {
      throw new ChannelBridgeError("INVALID_CHANNEL_PAYLOAD", "Channel timestamp is invalid");
    }
    const binding = this.bindings.resolve(input.provider, input.accountId, input.conversationId);
    this.assertSenderAllowed(binding, input.senderExternalId);
    this.assertTarget(binding);

    const actorId = channelActorId(input.provider, input.accountId, input.senderExternalId);
    const messageId = channelMessageId(input.provider, input.accountId, input.externalMessageId);
    const replyToMessageId = input.replyToExternalMessageId
      ? channelMessageId(input.provider, input.accountId, input.replyToExternalMessageId)
      : undefined;
    const correlationId = channelCorrelationId(input.provider, input.accountId, input.conversationId);
    const idempotencyKey = `channel-ingress:${stableHash(input.provider, input.accountId, input.deliveryId)}`;
    const content = contentParts(input);
    const provenance = externalChannelMetadata(input, binding.id);
    const text = textForScheduling(input);
    const duplicate = Boolean(this.store.getObject(messageId));

    let message: StoredObject;
    let eventSequence: number;
    let scheduledTaskIds: string[] = [];
    if (binding.targetKind === "bot") {
      const result = this.gateway.sendMessage({
        senderId: actorId,
        targetKind: "bot",
        targetId: binding.targetId,
        workspaceId: binding.workspaceId,
        text,
        messageId,
        timestamp: input.timestamp,
        replyToMessageId,
        correlationId,
        idempotencyKey,
        content,
        provenance
      });
      message = result.message;
      eventSequence = result.event.sequence;
    } else {
      const roomId = binding.targetKind === "room" ? binding.targetId : String(binding.roomId);
      const result = this.rooms.sendMessage({
        roomId,
        senderId: actorId,
        text,
        threadId: binding.targetKind === "thread" ? binding.targetId : undefined,
        replyToMessageId,
        correlationId,
        activateSpeakers: true,
        messageId,
        timestamp: input.timestamp,
        idempotencyKey,
        content,
        provenance
      });
      message = result.message;
      eventSequence = result.event.sequence;
      scheduledTaskIds = result.scheduledTaskIds;
    }

    return {
      schema_version: CHANNEL_BRIDGE_SCHEMA,
      provider: CHANNEL_BRIDGE_PROVIDER,
      binding_id: binding.id,
      channel_provider: binding.provider,
      workspace_id: binding.workspaceId,
      actor_id: actorId,
      canonical_message_id: message.id,
      event_sequence: eventSequence,
      target: {
        kind: binding.targetKind,
        id: binding.targetId,
        ...(binding.roomId ? { room_id: binding.roomId } : {})
      },
      scheduled_task_ids: scheduledTaskIds,
      duplicate,
      canonical_owner: "ai-verse-multiple-bots",
      channel_owns_truth: false
    };
  }

  formatEgress(bindingId: string, messageId: string): ChannelEgressResult {
    const binding = this.bindings.get(bindingId);
    if (!binding || !binding.enabled) {
      throw new ChannelBridgeError("CHANNEL_BINDING_NOT_FOUND", `Enabled channel binding ${bindingId} not found`, 404);
    }
    const message = this.store.getObject(messageId);
    if (!message || message.kind !== "message") {
      throw new ChannelBridgeError("CHANNEL_MESSAGE_NOT_FOUND", `Canonical message ${messageId} not found`, 404);
    }
    if (message.workspaceId !== binding.workspaceId) {
      throw new ChannelBridgeError("CHANNEL_WORKSPACE_MISMATCH", `Message ${messageId} is outside channel binding workspace`, 403);
    }
    const provenance = asObject(message.payload.provenance);
    if (provenance?.origin === "external_message" || String(message.payload.sender_id).startsWith("channel_actor:")) {
      throw new ChannelBridgeError("CHANNEL_ECHO_DENIED", "Inbound external messages cannot be formatted back to the same channel", 403);
    }

    const target = asObject(message.payload.target);
    const senderId = String(message.payload.sender_id ?? "");
    let externalRecipientId: string | null = null;
    if (binding.targetKind === "bot") {
      if (senderId !== binding.targetId) {
        throw new ChannelBridgeError("CHANNEL_EGRESS_NOT_BOUND", `Message ${messageId} was not sent by bound Bot ${binding.targetId}`, 403);
      }
      const actor = parseChannelActorId(String(target?.id ?? ""));
      if (String(target?.kind ?? "") !== "operator" || !actor) {
        throw new ChannelBridgeError("CHANNEL_EGRESS_NOT_BOUND", `Message ${messageId} is not addressed to a channel actor`, 403);
      }
      if (actor.provider !== binding.provider || actor.accountId !== binding.accountId) {
        throw new ChannelBridgeError("CHANNEL_EGRESS_NOT_BOUND", `Message ${messageId} targets another channel account`, 403);
      }
      externalRecipientId = actor.senderExternalId;
    } else if (binding.targetKind === "room") {
      if (String(message.payload.room_id ?? "") !== binding.targetId) {
        throw new ChannelBridgeError("CHANNEL_EGRESS_NOT_BOUND", `Message ${messageId} is not in bound Room ${binding.targetId}`, 403);
      }
    } else {
      if (
        String(message.payload.thread_id ?? "") !== binding.targetId
        || String(message.payload.room_id ?? "") !== String(binding.roomId)
      ) {
        throw new ChannelBridgeError("CHANNEL_EGRESS_NOT_BOUND", `Message ${messageId} is not in bound Thread ${binding.targetId}`, 403);
      }
    }

    const parts = Array.isArray(message.payload.content) ? message.payload.content : [];
    const text = parts
      .map((part) => asObject(part))
      .filter((part): part is JsonObject => Boolean(part) && part?.kind === "text" && typeof part.text === "string")
      .map((part) => String(part.text))
      .join("\n");
    const attachments = parts
      .map((part) => asObject(part))
      .filter((part): part is JsonObject => Boolean(part) && part?.kind !== "text");

    const replyToExternalMessageId = this.resolveExternalReply(
      binding.provider,
      binding.accountId,
      typeof message.payload.reply_to_message_id === "string" ? message.payload.reply_to_message_id : null
    );
    const transportCommand = this.transportCommand(
      binding.provider,
      binding.conversationId,
      externalRecipientId,
      text,
      attachments,
      replyToExternalMessageId
    );

    return {
      schema_version: CHANNEL_BRIDGE_SCHEMA,
      provider: CHANNEL_BRIDGE_PROVIDER,
      binding_id: binding.id,
      channel_provider: binding.provider,
      workspace_id: binding.workspaceId,
      canonical_message_id: message.id,
      conversation_id: binding.conversationId,
      external_recipient_id: externalRecipientId,
      reply_to_external_message_id: replyToExternalMessageId,
      text,
      attachments,
      dedupe_key: `channel-egress:${binding.id}:${message.id}`,
      delivery_receipt_required: true,
      transport_command: transportCommand,
      canonical_owner: "ai-verse-multiple-bots",
      channel_owns_truth: false
    };
  }

  acknowledgeEgress(input: {
    bindingId: string;
    messageId: string;
    status: "sent" | "delivered" | "failed";
    externalDeliveryId: string;
    reason?: string;
  }) {
    const binding = this.bindings.get(input.bindingId);
    if (!binding || !binding.enabled) {
      throw new ChannelBridgeError("CHANNEL_BINDING_NOT_FOUND", `Enabled channel binding ${input.bindingId} not found`, 404);
    }
    const message = this.store.getObject(input.messageId);
    if (!message || message.kind !== "message") {
      throw new ChannelBridgeError("CHANNEL_MESSAGE_NOT_FOUND", `Canonical message ${input.messageId} not found`, 404);
    }
    if (message.workspaceId !== binding.workspaceId) {
      throw new ChannelBridgeError("CHANNEL_WORKSPACE_MISMATCH", `Message ${input.messageId} is outside channel binding workspace`, 403);
    }
    if (!input.externalDeliveryId) {
      throw new ChannelBridgeError("INVALID_CHANNEL_RECEIPT", "externalDeliveryId is required");
    }

    const event = this.gateway.emit({
      type: `channel.egress.${input.status}`,
      actorId: `channel_adapter:${binding.provider}`,
      workspaceId: binding.workspaceId,
      messageId: input.messageId,
      channelBindingId: binding.id,
      channelProvider: binding.provider,
      externalDeliveryId: input.externalDeliveryId,
      summary: input.reason ?? `Channel egress ${input.status} for ${input.messageId}`,
      attentionState: input.status === "failed" ? "failed" : undefined,
      idempotencyKey: `channel-receipt:${stableHash(binding.id, input.messageId, input.status, input.externalDeliveryId)}`
    });
    return {
      schema_version: CHANNEL_BRIDGE_SCHEMA,
      provider: CHANNEL_BRIDGE_PROVIDER,
      binding_id: binding.id,
      canonical_message_id: input.messageId,
      status: input.status,
      external_delivery_id: input.externalDeliveryId,
      event_sequence: event.sequence
    };
  }

  private assertSenderAllowed(binding: ReturnType<ChannelBindingRegistry["resolve"]>, senderExternalId: string): void {
    const allowed = binding.allowedSenderExternalIds;
    if (!allowed || allowed.length === 0 || allowed.includes("*")) return;
    if (!allowed.includes(senderExternalId)) {
      throw new ChannelBridgeError(
        "CHANNEL_SENDER_DENIED",
        `External sender ${senderExternalId} is not admitted by channel binding ${binding.id}`,
        403
      );
    }
  }

  private assertTarget(binding: ReturnType<ChannelBindingRegistry["resolve"]>): void {
    if (binding.targetKind === "bot") {
      const bot = this.gateway.getBot(binding.targetId);
      if (!bot || bot.payload.status !== "active") {
        throw new ChannelBridgeError("CHANNEL_TARGET_UNAVAILABLE", `Bound Bot ${binding.targetId} is not active`, 409);
      }
      if (bot.workspaceId !== binding.workspaceId) {
        throw new ChannelBridgeError("CHANNEL_WORKSPACE_MISMATCH", `Bound Bot ${binding.targetId} is outside workspace ${binding.workspaceId}`, 403);
      }
      return;
    }
    const roomId = binding.targetKind === "room" ? binding.targetId : String(binding.roomId);
    const room = this.store.getObject(roomId);
    if (!room || room.kind !== "room" || room.payload.status !== "active") {
      throw new ChannelBridgeError("CHANNEL_TARGET_UNAVAILABLE", `Bound Room ${roomId} is not active`, 409);
    }
    if (room.workspaceId !== binding.workspaceId) {
      throw new ChannelBridgeError("CHANNEL_WORKSPACE_MISMATCH", `Bound Room ${roomId} is outside workspace ${binding.workspaceId}`, 403);
    }
    if (binding.targetKind === "thread") {
      const thread = this.store.getObject(binding.targetId);
      if (!thread || thread.kind !== "thread" || thread.payload.status !== "active") {
        throw new ChannelBridgeError("CHANNEL_TARGET_UNAVAILABLE", `Bound Thread ${binding.targetId} is not active`, 409);
      }
      if (thread.workspaceId !== binding.workspaceId || String(thread.payload.room_id) !== roomId) {
        throw new ChannelBridgeError("CHANNEL_WORKSPACE_MISMATCH", `Bound Thread ${binding.targetId} escaped its Room/workspace`, 403);
      }
    }
  }

  private resolveExternalReply(provider: string, accountId: string, canonicalMessageId: string | null): string | null {
    if (!canonicalMessageId) return null;
    const parent = this.store.getObject(canonicalMessageId);
    if (!parent || parent.kind !== "message") return null;
    const provenance = asObject(parent.payload.provenance);
    const channel = asObject(provenance?.channel);
    if (
      provenance?.origin === "external_message"
      && String(channel?.provider ?? "") === provider
      && String(channel?.account_id ?? "") === accountId
      && typeof channel?.external_message_id === "string"
    ) {
      return channel.external_message_id;
    }
    return null;
  }

  private transportCommand(
    provider: string,
    conversationId: string,
    externalRecipientId: string | null,
    text: string,
    attachments: JsonObject[],
    replyToExternalMessageId: string | null
  ): JsonObject {
    if (provider === "telegram") {
      return {
        kind: "telegram.bot-api",
        method: attachments.length === 0 ? "sendMessage" : "adapter.compose",
        chat_id: conversationId,
        text,
        ...(replyToExternalMessageId ? { reply_parameters: { message_id: replyToExternalMessageId } } : {}),
        attachments
      };
    }
    if (provider === "discord") {
      return {
        kind: "discord.rest",
        method: "POST",
        route: `/channels/${encodeURIComponent(conversationId)}/messages`,
        body: {
          content: text,
          ...(replyToExternalMessageId ? { message_reference: { message_id: replyToExternalMessageId } } : {}),
          attachments
        }
      };
    }
    return {
      kind: "generic.channel-send",
      provider,
      conversation_id: conversationId,
      recipient_id: externalRecipientId,
      text,
      reply_to_external_message_id: replyToExternalMessageId,
      attachments
    };
  }
}
