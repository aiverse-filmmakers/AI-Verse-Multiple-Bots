import {
  existsSync,
  lstatSync,
  readFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BotRegistryRules,
  botRegistryAddresses,
  normalizeBotAddress
} from "./bot-registry.js";
import { createId } from "./id.js";
import { CoordinationStore } from "./store.js";
import type {
  BotManifest,
  CoordinationEvent,
  JsonObject,
  ProtocolKind,
  StoredObject
} from "./types.js";
import { validateBotManifest, validateProtocolObject } from "./validator.js";

export type StarterTemplateKind = "bot" | "team";

interface CatalogBotDefinition {
  slot: string;
  name: string;
  role_title: string;
  mission: string;
  can_create_workers: boolean;
  can_handoff: boolean;
}

interface CatalogRoomDefinition {
  name: string;
  leader_slot: string;
  mode: "conversational" | "manager" | "review" | "hybrid";
  speaker_policy: string;
  work_owner_policy: "explicit_single_owner" | "leader_owned" | "task_owned";
  max_rounds_per_user_turn: number;
  max_bot_messages_per_user_turn: number;
}

export interface StarterTemplateDefinition {
  id: string;
  kind: StarterTemplateKind;
  name: string;
  description: string;
  bots: CatalogBotDefinition[];
  room?: CatalogRoomDefinition;
}

interface StarterCatalog {
  schema_version: "1.0";
  templates: StarterTemplateDefinition[];
}

export interface StarterTemplateSummary {
  id: string;
  kind: StarterTemplateKind;
  name: string;
  description: string;
  bot_count: number;
  creates_room: boolean;
}

export interface StarterTemplateOptions {
  templateId: string;
  workspaceId: string;
  prefix?: string;
  runtimeAdapter?: string;
}

export interface StarterTemplateObjectPlan {
  kind: "bot" | "room";
  id: string;
  name: string;
  state: "missing" | "current" | "conflict";
  action: "create" | "none";
  payload: JsonObject;
}

export interface StarterTemplatePlan {
  template: StarterTemplateSummary;
  workspace_id: string;
  prefix: string;
  runtime_adapter: string;
  objects: StarterTemplateObjectPlan[];
  can_apply: boolean;
  conflicts: Array<{ id: string; reason: string }>;
  creates_durable_bots: true;
  creates_team_run: false;
  mutates_ai_verse_os_truth: false;
}

export interface StarterTemplateApplyResult extends StarterTemplatePlan {
  status: "applied" | "unchanged";
  created_ids: string[];
}

export class StarterTemplateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "StarterTemplateError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function catalogPath(): string {
  return resolve(packageRoot(), "templates", "starter-catalog.json");
}

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `${context}.${key} must be a non-empty string`);
  }
  return value.trim();
}

function requiredBoolean(record: Record<string, unknown>, key: string, context: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `${context}.${key} must be boolean`);
  }
  return value;
}

function requiredPositiveInteger(record: Record<string, unknown>, key: string, context: string): number {
  const value = record[key];
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `${context}.${key} must be a positive integer`);
  }
  return Number(value);
}

function parseCatalog(): StarterCatalog {
  const path = catalogPath();
  if (!existsSync(path)) {
    throw new StarterTemplateError("TEMPLATE_CATALOG_MISSING", `Starter template catalog is missing: ${path}`);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new StarterTemplateError("TEMPLATE_CATALOG_UNSAFE", `Starter template catalog must be a regular file: ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new StarterTemplateError(
      "INVALID_TEMPLATE_CATALOG",
      `Starter template catalog is invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const root = asRecord(parsed);
  if (!root || root.schema_version !== "1.0" || !Array.isArray(root.templates)) {
    throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", "Starter template catalog requires schema_version 1.0 and templates[]");
  }

  const ids = new Set<string>();
  const templates = root.templates.map((value, templateIndex): StarterTemplateDefinition => {
    const record = asRecord(value);
    const context = `templates[${templateIndex}]`;
    if (!record) throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `${context} must be an object`);

    const id = requiredString(record, "id", context);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `${context}.id must be a lowercase slug`);
    }
    if (ids.has(id)) throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `Duplicate starter template id: ${id}`);
    ids.add(id);

    const kind = requiredString(record, "kind", context);
    if (kind !== "bot" && kind !== "team") {
      throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `${context}.kind must be bot or team`);
    }

    if (!Array.isArray(record.bots) || record.bots.length < 1) {
      throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `${context}.bots must contain at least one Bot`);
    }

    const slots = new Set<string>();
    const bots = record.bots.map((botValue, botIndex): CatalogBotDefinition => {
      const bot = asRecord(botValue);
      const botContext = `${context}.bots[${botIndex}]`;
      if (!bot) throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `${botContext} must be an object`);
      const slot = requiredString(bot, "slot", botContext);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slot)) {
        throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `${botContext}.slot must be a lowercase slug`);
      }
      if (slots.has(slot)) throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `Duplicate Bot slot '${slot}' in template ${id}`);
      slots.add(slot);
      return {
        slot,
        name: requiredString(bot, "name", botContext),
        role_title: requiredString(bot, "role_title", botContext),
        mission: requiredString(bot, "mission", botContext),
        can_create_workers: requiredBoolean(bot, "can_create_workers", botContext),
        can_handoff: requiredBoolean(bot, "can_handoff", botContext)
      };
    });

    let room: CatalogRoomDefinition | undefined;
    if (record.room !== undefined) {
      const roomRecord = asRecord(record.room);
      if (!roomRecord) throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `${context}.room must be an object`);
      const leaderSlot = requiredString(roomRecord, "leader_slot", `${context}.room`);
      if (!slots.has(leaderSlot)) {
        throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `${context}.room.leader_slot must reference a Bot slot`);
      }
      const mode = requiredString(roomRecord, "mode", `${context}.room`);
      if (!["conversational", "manager", "review", "hybrid"].includes(mode)) {
        throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `${context}.room.mode is unsupported`);
      }
      const workOwnerPolicy = requiredString(roomRecord, "work_owner_policy", `${context}.room`);
      if (!["explicit_single_owner", "leader_owned", "task_owned"].includes(workOwnerPolicy)) {
        throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `${context}.room.work_owner_policy is unsupported`);
      }
      room = {
        name: requiredString(roomRecord, "name", `${context}.room`),
        leader_slot: leaderSlot,
        mode: mode as CatalogRoomDefinition["mode"],
        speaker_policy: requiredString(roomRecord, "speaker_policy", `${context}.room`),
        work_owner_policy: workOwnerPolicy as CatalogRoomDefinition["work_owner_policy"],
        max_rounds_per_user_turn: requiredPositiveInteger(roomRecord, "max_rounds_per_user_turn", `${context}.room`),
        max_bot_messages_per_user_turn: requiredPositiveInteger(roomRecord, "max_bot_messages_per_user_turn", `${context}.room`)
      };
    }

    if (kind === "bot" && (bots.length !== 1 || room)) {
      throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `Bot template ${id} must contain exactly one Bot and no Room`);
    }
    if (kind === "team" && (!room || bots.length < 2)) {
      throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `Team template ${id} requires at least two Bots and one Room`);
    }

    return {
      id,
      kind,
      name: requiredString(record, "name", context),
      description: requiredString(record, "description", context),
      bots,
      ...(room ? { room } : {})
    };
  });

  return { schema_version: "1.0", templates };
}

function summary(template: StarterTemplateDefinition): StarterTemplateSummary {
  return {
    id: template.id,
    kind: template.kind,
    name: template.name,
    description: template.description,
    bot_count: template.bots.length,
    creates_room: Boolean(template.room)
  };
}

export function listStarterTemplates(): StarterTemplateSummary[] {
  return parseCatalog().templates.map(summary);
}

export function getStarterTemplate(templateId: string): StarterTemplateDefinition {
  const template = parseCatalog().templates.find((item) => item.id === templateId);
  if (!template) throw new StarterTemplateError("TEMPLATE_NOT_FOUND", `Starter template '${templateId}' was not found`);
  return template;
}

function normalizedPrefix(workspaceId: string, templateId: string, explicit?: string): string {
  if (!workspaceId.trim()) throw new StarterTemplateError("WORKSPACE_REQUIRED", "Template application requires a non-empty workspace ID");
  const raw = explicit?.trim() || `${workspaceId}-${templateId}`;
  const normalized = normalizeBotAddress(raw);
  if (!normalized) throw new StarterTemplateError("INVALID_TEMPLATE_PREFIX", "Template prefix must contain letters or numbers");
  return normalized.replace(/-/g, "_");
}

function runtimeAdapter(input?: string): string {
  const adapter = input?.trim() ?? "";
  if (!adapter) {
    throw new StarterTemplateError(
      "RUNTIME_ADAPTER_REQUIRED",
      "Starter template planning/application requires an explicit runtime adapter; the stock Gateway has no implicit native execution adapter"
    );
  }
  if (adapter === "external-managed") {
    throw new StarterTemplateError(
      "EXTERNAL_MANAGED_TEMPLATE_UNSUPPORTED",
      "Starter templates cannot bind external-managed persistent identities because provider/ref/fingerprint ownership must be explicit per Bot"
    );
  }
  return adapter;
}

function buildBotManifest(
  definition: CatalogBotDefinition,
  botId: string,
  workspaceId: string,
  adapter: string,
  peerIds: string[]
): BotManifest {
  return validateBotManifest({
    schema_version: "1.0",
    id: botId,
    name: definition.name,
    kind: "durable",
    status: "active",
    role: {
      title: definition.role_title,
      mission: definition.mission
    },
    runtime: {
      adapter
    },
    execution: {
      environment_policy: "shared_workspace",
      environment_ref: "host-default",
      persistence: "durable"
    },
    scope: {
      type: "workspace",
      workspace_id: workspaceId
    },
    capabilities: {
      role_refs: [],
      skill_refs: [],
      operator_refs: [],
      tool_refs: []
    },
    permissions: {
      policy_ref: "default-bot",
      allowed_peers: peerIds,
      can_create_workers: definition.can_create_workers,
      can_create_bots: false,
      can_handoff: definition.can_handoff
    },
    memory: {
      adapter: "host",
      view_policy: "role_scoped",
      write_policy: "candidate_only"
    },
    coordination: {
      manager_id: null,
      default_mode: "direct",
      max_parallel_workers: definition.can_create_workers ? 4 : 1,
      max_hops: 6
    },
    attention: {
      notifications: "host_default"
    },
    ui: {
      avatar: null,
      hidden: false
    }
  });
}

function buildRoomPayload(
  template: StarterTemplateDefinition,
  room: CatalogRoomDefinition,
  roomId: string,
  workspaceId: string,
  botIdsBySlot: Map<string, string>
): JsonObject {
  const members = template.bots.map((bot) => {
    const id = botIdsBySlot.get(bot.slot);
    if (!id) throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `Missing generated Bot ID for slot ${bot.slot}`);
    return id;
  });
  const leader = botIdsBySlot.get(room.leader_slot);
  if (!leader) throw new StarterTemplateError("INVALID_TEMPLATE_CATALOG", `Missing generated leader for slot ${room.leader_slot}`);

  return validateProtocolObject({
    schema_version: "1.0",
    id: roomId,
    name: room.name,
    status: "active",
    scope: { type: "workspace", workspace_id: workspaceId },
    members,
    orchestration: {
      mode: room.mode,
      speaker_policy: room.speaker_policy,
      leader,
      work_owner_policy: room.work_owner_policy,
      max_rounds_per_user_turn: room.max_rounds_per_user_turn,
      max_bot_messages_per_user_turn: room.max_bot_messages_per_user_turn,
      allow_member_mentions: true,
      allow_user_escalation: true
    },
    threads: { enabled: true, inherit_room_scope: true },
    context: { history_policy: "summarized", max_recent_messages: 30 },
    attention: { notify_on_unresolved_mention: true },
    active_work: null,
    budget: {
      token_limit: null,
      cost_limit: null,
      wall_clock_seconds: 300,
      max_workers: null,
      max_hops: 6,
      max_messages: room.max_bot_messages_per_user_turn,
      max_rounds: room.max_rounds_per_user_turn
    }
  }, "room");
}

function samePayload(existing: StoredObject | null, kind: ProtocolKind, expected: JsonObject): boolean {
  return Boolean(
    existing
    && existing.kind === kind
    && JSON.stringify(existing.payload) === JSON.stringify(expected)
  );
}

function createEvent(input: {
  type: string;
  actorId: string;
  workspaceId: string;
  summary: string;
  roomId?: string | null;
}): CoordinationEvent {
  return {
    schema_version: "1.0",
    id: createId("evt"),
    type: input.type,
    timestamp: new Date().toISOString(),
    actor_id: input.actorId,
    workspace_id: input.workspaceId,
    room_id: input.roomId ?? null,
    summary: input.summary
  };
}

function plannedObjects(
  store: CoordinationStore,
  options: StarterTemplateOptions
): {
  template: StarterTemplateDefinition;
  templateSummary: StarterTemplateSummary;
  workspaceId: string;
  prefix: string;
  adapter: string;
  objects: StarterTemplateObjectPlan[];
} {
  const template = getStarterTemplate(options.templateId);
  const workspaceId = options.workspaceId.trim();
  if (!workspaceId) throw new StarterTemplateError("WORKSPACE_REQUIRED", "Template application requires --workspace");
  const prefix = normalizedPrefix(workspaceId, template.id, options.prefix);
  const adapter = runtimeAdapter(options.runtimeAdapter);

  const botIdsBySlot = new Map<string, string>();
  for (const bot of template.bots) botIdsBySlot.set(bot.slot, `bot_${prefix}_${bot.slot.replace(/-/g, "_")}`);
  const botIds = [...botIdsBySlot.values()];

  const manifests = template.bots.map((bot) => {
    const id = botIdsBySlot.get(bot.slot)!;
    return buildBotManifest(bot, id, workspaceId, adapter, botIds.filter((peerId) => peerId !== id));
  });

  const seenAddresses = new Map<string, string>();
  for (const manifest of manifests) {
    for (const address of botRegistryAddresses(manifest)) {
      const prior = seenAddresses.get(address);
      if (prior) {
        throw new StarterTemplateError(
          "TEMPLATE_ADDRESS_COLLISION",
          `Template ${template.id} generates duplicate Bot address @${address} for ${prior} and ${manifest.id}`
        );
      }
      seenAddresses.set(address, manifest.id);
    }
  }

  const registry = new BotRegistryRules(store);
  const objects: StarterTemplateObjectPlan[] = manifests.map((manifest) => {
    const existing = store.getObject(manifest.id);
    if (!existing) {
      registry.prepareCreate(manifest);
      return {
        kind: "bot" as const,
        id: manifest.id,
        name: manifest.name,
        state: "missing" as const,
        action: "create" as const,
        payload: manifest
      };
    }
    if (samePayload(existing, "bot", manifest)) {
      return {
        kind: "bot" as const,
        id: manifest.id,
        name: manifest.name,
        state: "current" as const,
        action: "none" as const,
        payload: manifest
      };
    }
    return {
      kind: "bot" as const,
      id: manifest.id,
      name: manifest.name,
      state: "conflict" as const,
      action: "none" as const,
      payload: manifest
    };
  });

  if (template.room) {
    const roomId = `room_${prefix}`;
    const payload = buildRoomPayload(template, template.room, roomId, workspaceId, botIdsBySlot);
    const existing = store.getObject(roomId);
    objects.push({
      kind: "room",
      id: roomId,
      name: template.room.name,
      state: !existing ? "missing" : samePayload(existing, "room", payload) ? "current" : "conflict",
      action: !existing ? "create" : "none",
      payload
    });
  }

  return {
    template,
    templateSummary: summary(template),
    workspaceId,
    prefix,
    adapter,
    objects
  };
}

export function planStarterTemplate(
  store: CoordinationStore,
  options: StarterTemplateOptions
): StarterTemplatePlan {
  const planned = plannedObjects(store, options);
  const conflicts = planned.objects
    .filter((object) => object.state === "conflict")
    .map((object) => ({
      id: object.id,
      reason: `Existing ${object.kind} differs from starter template ${planned.template.id}; template application never overwrites durable identity or Room state`
    }));

  return {
    template: planned.templateSummary,
    workspace_id: planned.workspaceId,
    prefix: planned.prefix,
    runtime_adapter: planned.adapter,
    objects: planned.objects,
    can_apply: conflicts.length === 0,
    conflicts,
    creates_durable_bots: true,
    creates_team_run: false,
    mutates_ai_verse_os_truth: false
  };
}

export function applyStarterTemplate(
  store: CoordinationStore,
  options: StarterTemplateOptions
): StarterTemplateApplyResult {
  const plan = planStarterTemplate(store, options);
  if (!plan.can_apply) {
    throw new StarterTemplateError(
      "TEMPLATE_CONFLICT",
      `Starter template ${plan.template.id} conflicts with existing state: ${plan.conflicts.map((item) => item.id).join(", ")}`
    );
  }

  const creations = plan.objects.filter((object) => object.action === "create");
  if (creations.length === 0) {
    return { ...plan, status: "unchanged", created_ids: [] };
  }

  const current = plan.objects.filter((object) => object.state === "current");
  const preconditions = [
    ...creations.map((object) => ({
      id: object.id,
      kind: object.kind as ProtocolKind,
      absent: true
    })),
    ...current.map((object) => {
      const existing = store.getObject(object.id);
      if (!existing) {
        throw new StarterTemplateError("TEMPLATE_STATE_CHANGED", `Template object ${object.id} disappeared before apply`);
      }
      return {
        id: object.id,
        kind: object.kind as ProtocolKind,
        updatedAt: existing.updatedAt
      };
    })
  ];

  const events: CoordinationEvent[] = [];
  for (const object of creations) {
    if (object.kind === "bot") {
      events.push(createEvent({
        type: "bot.created",
        actorId: object.id,
        workspaceId: plan.workspace_id,
        summary: `Created Bot ${object.name} from starter template ${plan.template.id}`
      }));
    } else {
      const orchestration = asRecord(object.payload.orchestration);
      const leader = typeof orchestration?.leader === "string" ? orchestration.leader : "operator_local";
      events.push(createEvent({
        type: "room.created",
        actorId: leader,
        workspaceId: plan.workspace_id,
        roomId: object.id,
        summary: `Created Room ${object.name} from starter template ${plan.template.id}`
      }));
    }
  }

  try {
    store.atomicMutation({
      preconditions,
      objects: creations.map((object) => ({
        kind: object.kind,
        payload: object.payload
      })),
      events
    });
  } catch (error) {
    throw new StarterTemplateError(
      "TEMPLATE_APPLY_FAILED",
      error instanceof Error ? error.message : String(error)
    );
  }

  const finalPlan = planStarterTemplate(store, options);
  if (!finalPlan.can_apply || finalPlan.objects.some((object) => object.state !== "current")) {
    throw new StarterTemplateError("TEMPLATE_VERIFICATION_FAILED", `Starter template ${plan.template.id} did not verify after apply`);
  }

  return {
    ...finalPlan,
    status: "applied",
    created_ids: creations.map((object) => object.id)
  };
}
