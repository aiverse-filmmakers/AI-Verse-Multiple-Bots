import { CoordinationStore } from "./store.js";
import {
  EXTERNAL_MANAGED_RUNTIME_ADAPTER_ID,
  externalManagedBindingKey,
  externalManagedFingerprintKey,
  parseExternalManagedBinding
} from "./external-managed-runtime.js";
import type { BotManifest, JsonObject, StoredObject } from "./types.js";
import { validateBotManifest } from "./validator.js";

const LIVE_TASK_STATES = new Set([
  "created",
  "assigned",
  "accepted",
  "running",
  "waiting_input",
  "waiting_approval",
  "blocked"
]);

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function normalizeBotAddress(value: string): string {
  return value
    .trim()
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function botRegistryAddresses(manifest: BotManifest): string[] {
  const addresses = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = normalizeBotAddress(value);
    if (normalized) addresses.add(normalized);
  };

  add(manifest.id);
  add(manifest.id.replace(/^bot_/, ""));
  add(manifest.name);
  const coordination = asObject(manifest.coordination);
  for (const alias of stringArray(coordination?.aliases)) add(alias);
  const ui = asObject(manifest.ui);
  add(ui?.handle);
  return [...addresses].sort();
}

export type BotLifecycleStatus = "active" | "disabled" | "archived";

export interface BotTransitionPlan {
  bot: StoredObject<BotManifest>;
  previousStatus: BotLifecycleStatus;
  targetStatus: BotLifecycleStatus;
  payload: BotManifest;
}

export class BotRegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BotRegistryError";
  }
}

export class BotRegistryRules {
  constructor(readonly store: CoordinationStore) {}

  prepareCreate(manifest: BotManifest): BotManifest {
    const bot = validateBotManifest(manifest);
    if (this.store.getObject(bot.id)) {
      throw new BotRegistryError("BOT_ID_COLLISION", `Object ${bot.id} already exists; Bot creation never overwrites durable identity`);
    }
    if (bot.status === "archived") {
      throw new BotRegistryError("INVALID_INITIAL_STATUS", "A new Bot cannot be created directly as archived");
    }
    this.assertAddressAvailability(bot);
    this.assertExternalManagedBindingAvailability(bot);
    this.assertRelationships(bot);
    this.assertInboundPeerDeclarations(bot);
    return bot;
  }

  prepareTransition(botId: string, targetStatus: BotLifecycleStatus): BotTransitionPlan {
    const stored = this.requireBot(botId);
    const previousStatus = stored.payload.status;
    if (previousStatus === targetStatus) {
      throw new BotRegistryError("NO_STATUS_CHANGE", `Bot ${botId} is already ${targetStatus}`);
    }
    if (previousStatus === "archived") {
      throw new BotRegistryError("ARCHIVED_TERMINAL", `Bot ${botId} is archived and cannot transition to ${targetStatus}`);
    }

    if (targetStatus === "disabled" || targetStatus === "archived") {
      this.assertNoLiveOwnedWork(stored);
    }
    if (targetStatus === "disabled") {
      this.assertNoManagerDependents(stored, true);
    }
    if (targetStatus === "active") {
      this.assertAddressAvailability(stored.payload, stored.id);
      this.assertExternalManagedBindingAvailability(stored.payload, stored.id);
      this.assertRelationships(stored.payload);
      this.assertInboundPeerDeclarations(stored.payload);
    }
    if (targetStatus === "archived") {
      this.assertNoManagerDependents(stored, false);
      this.assertNoActiveRoomReferences(stored);
    }

    const payload = validateBotManifest({
      ...stored.payload,
      status: targetStatus,
      lifecycle: {
        ...(asObject(stored.payload.lifecycle) ?? {}),
        previous_status: previousStatus,
        changed_at: new Date().toISOString()
      }
    } as BotManifest);
    return { bot: stored, previousStatus, targetStatus, payload };
  }

  assertRelationships(manifest: BotManifest): void {
    const scopeKey = this.scopeKey(manifest);
    const coordination = asObject(manifest.coordination);
    const managerId = typeof coordination?.manager_id === "string" && coordination.manager_id.length > 0
      ? coordination.manager_id
      : null;
    if (managerId) {
      if (managerId === manifest.id) throw new BotRegistryError("SELF_MANAGER", `Bot ${manifest.id} cannot manage itself`);
      const manager = this.requireBot(managerId);
      if (this.scopeKey(manager.payload) !== scopeKey) {
        throw new BotRegistryError("MANAGER_SCOPE_MISMATCH", `Manager ${managerId} is outside registry scope ${scopeKey}`);
      }
      if (manager.payload.status !== "active") {
        throw new BotRegistryError("MANAGER_UNAVAILABLE", `Manager ${managerId} is not active`);
      }
      this.assertNoManagerCycle(manifest.id, managerId);
    }

    const permissions = asObject(manifest.permissions);
    if (permissions && Array.isArray(permissions.allowed_peers)) {
      const peers = stringArray(permissions.allowed_peers);
      for (const peerId of peers) {
        if (peerId === "*") continue;
        if (peerId === manifest.id) throw new BotRegistryError("SELF_PEER", `Bot ${manifest.id} cannot list itself as an allowed peer`);
        if (!peerId.startsWith("bot_")) {
          throw new BotRegistryError("INVALID_PEER", `Explicit peer ${peerId} must be a durable Bot ID or *`);
        }
        const peer = this.optionalBot(peerId);
        if (!peer) continue;
        if (this.scopeKey(peer.payload) !== scopeKey) {
          throw new BotRegistryError("PEER_SCOPE_MISMATCH", `Peer ${peerId} is outside registry scope ${scopeKey}`);
        }
        if (peer.payload.status === "archived") {
          throw new BotRegistryError("PEER_ARCHIVED", `Peer ${peerId} is archived`);
        }
      }
    }
  }

  resolveAddress(workspaceId: string, address: string, includeDisabled = true): StoredObject<BotManifest> | null {
    const wanted = normalizeBotAddress(address);
    if (!wanted) return null;
    const matches = this.store.listObjects("bot", workspaceId)
      .map((entry) => entry as StoredObject<BotManifest>)
      .filter((bot) => bot.payload.status !== "archived")
      .filter((bot) => includeDisabled || bot.payload.status === "active")
      .filter((bot) => botRegistryAddresses(bot.payload).includes(wanted));
    if (matches.length > 1) {
      throw new BotRegistryError("AMBIGUOUS_ADDRESS", `Bot address @${wanted} is ambiguous in workspace ${workspaceId}: ${matches.map((bot) => bot.id).join(", ")}`);
    }
    return matches[0] ?? null;
  }

  resolveOperatorAddress(address: string, includeDisabled = true): StoredObject<BotManifest> | null {
    const wanted = normalizeBotAddress(address);
    if (!wanted) return null;
    const matches = (this.store.listObjects("bot") as StoredObject<BotManifest>[])
      .filter((bot) => bot.payload.scope.type === "operator")
      .filter((bot) => bot.payload.status !== "archived")
      .filter((bot) => includeDisabled || bot.payload.status === "active")
      .filter((bot) => botRegistryAddresses(bot.payload).includes(wanted));
    if (matches.length > 1) {
      throw new BotRegistryError("AMBIGUOUS_ADDRESS", `Operator Bot address @${wanted} is ambiguous: ${matches.map((bot) => bot.id).join(", ")}`);
    }
    return matches[0] ?? null;
  }

  private assertExternalManagedBindingAvailability(manifest: BotManifest, ignoreBotId?: string): void {
    const runtime = asObject(manifest.runtime);
    if (runtime?.adapter !== EXTERNAL_MANAGED_RUNTIME_ADAPTER_ID) return;

    const binding = parseExternalManagedBinding(runtime);
    const wantedRef = externalManagedBindingKey(binding);
    const wantedFingerprint = externalManagedFingerprintKey(binding);

    for (const stored of this.store.listObjects("bot") as StoredObject<BotManifest>[]) {
      if (stored.id === ignoreBotId) continue;
      const existingRuntime = asObject(stored.payload.runtime);
      if (existingRuntime?.adapter !== EXTERNAL_MANAGED_RUNTIME_ADAPTER_ID) continue;
      const existing = parseExternalManagedBinding(existingRuntime);
      const sameRef = externalManagedBindingKey(existing) === wantedRef;
      const sameFingerprint = externalManagedFingerprintKey(existing) === wantedFingerprint;
      if (!sameRef && !sameFingerprint) continue;

      throw new BotRegistryError(
        "EXTERNAL_MANAGED_BINDING_COLLISION",
        `External managed Bot ${manifest.id} conflicts with ${stored.id}: one external persistent profile cannot back multiple canonical Bot identities`
      );
    }
  }

  private assertAddressAvailability(manifest: BotManifest, ignoreBotId?: string): void {
    const scopeKey = this.scopeKey(manifest);
    const wanted = new Set(botRegistryAddresses(manifest));
    for (const stored of this.store.listObjects("bot") as StoredObject<BotManifest>[]) {
      if (stored.id === ignoreBotId || this.scopeKey(stored.payload) !== scopeKey) continue;
      const overlap = botRegistryAddresses(stored.payload).filter((address) => wanted.has(address));
      if (overlap.length > 0) {
        throw new BotRegistryError(
          "BOT_ADDRESS_COLLISION",
          `Bot ${manifest.id} conflicts with ${stored.id} in ${scopeKey} on address ${overlap.map((address) => `@${address}`).join(", ")}`
        );
      }
    }
  }

  private assertInboundPeerDeclarations(manifest: BotManifest): void {
    const scopeKey = this.scopeKey(manifest);
    for (const existing of this.store.listObjects("bot") as StoredObject<BotManifest>[]) {
      if (existing.id === manifest.id || existing.payload.status === "archived") continue;
      const permissions = asObject(existing.payload.permissions);
      if (!permissions || !Array.isArray(permissions.allowed_peers)) continue;
      const peers = stringArray(permissions.allowed_peers);
      if (!peers.includes(manifest.id)) continue;
      if (this.scopeKey(existing.payload) !== scopeKey) {
        throw new BotRegistryError(
          "PEER_SCOPE_MISMATCH",
          `Bot ${existing.id} declared ${manifest.id} as a peer from a different registry scope`
        );
      }
    }
  }

  private assertNoManagerCycle(candidateId: string, managerId: string): void {
    const visited = new Set<string>([candidateId]);
    let currentId: string | null = managerId;
    while (currentId) {
      if (visited.has(currentId)) {
        throw new BotRegistryError("MANAGER_CYCLE", `Manager relationship would create a cycle involving ${currentId}`);
      }
      visited.add(currentId);
      const current = this.requireBot(currentId);
      const coordination = asObject(current.payload.coordination);
      currentId = typeof coordination?.manager_id === "string" && coordination.manager_id.length > 0
        ? coordination.manager_id
        : null;
    }
  }

  private assertNoLiveOwnedWork(bot: StoredObject<BotManifest>): void {
    const candidates = bot.workspaceId
      ? this.store.listObjects("task", bot.workspaceId)
      : this.store.listObjects("task");
    const live = candidates
      .filter((task) => LIVE_TASK_STATES.has(String(task.payload.status)))
      .filter((task) => task.payload.owner_id === bot.id || task.payload.assignee_id === bot.id);
    if (live.length > 0) {
      throw new BotRegistryError(
        "BOT_HAS_LIVE_WORK",
        `Bot ${bot.id} cannot change availability while it owns or is assigned live work: ${live.map((task) => task.id).join(", ")}`
      );
    }
  }

  private assertNoManagerDependents(bot: StoredObject<BotManifest>, activeOnly: boolean): void {
    const scopeKey = this.scopeKey(bot.payload);
    const dependents = (this.store.listObjects("bot") as StoredObject<BotManifest>[])
      .filter((candidate) => candidate.id !== bot.id && candidate.payload.status !== "archived")
      .filter((candidate) => !activeOnly || candidate.payload.status === "active")
      .filter((candidate) => this.scopeKey(candidate.payload) === scopeKey)
      .filter((candidate) => asObject(candidate.payload.coordination)?.manager_id === bot.id);
    if (dependents.length > 0) {
      throw new BotRegistryError(
        "BOT_HAS_MANAGER_DEPENDENTS",
        `Bot ${bot.id} cannot ${activeOnly ? "be disabled while active Bots" : "be archived while Bots"} depend on it as manager: ${dependents.map((candidate) => candidate.id).join(", ")}`
      );
    }
  }

  private assertNoActiveRoomReferences(bot: StoredObject<BotManifest>): void {
    const rooms = this.store.listObjects("room")
      .filter((room) => room.payload.status === "active")
      .filter((room) => {
        const members = stringArray(room.payload.members);
        const orchestration = asObject(room.payload.orchestration);
        return members.includes(bot.id) || orchestration?.leader === bot.id;
      });
    if (rooms.length > 0) {
      throw new BotRegistryError(
        "BOT_IN_ACTIVE_ROOM",
        `Bot ${bot.id} cannot be archived while referenced by active Rooms: ${rooms.map((room) => room.id).join(", ")}`
      );
    }
  }

  private optionalBot(botId: string): StoredObject<BotManifest> | null {
    const object = this.store.getObject(botId);
    return object?.kind === "bot" ? object as StoredObject<BotManifest> : null;
  }

  private requireBot(botId: string): StoredObject<BotManifest> {
    const bot = this.optionalBot(botId);
    if (!bot) throw new BotRegistryError("BOT_NOT_FOUND", `Bot ${botId} not found`);
    return bot;
  }

  private scopeKey(manifest: BotManifest): string {
    if (manifest.scope.type === "operator") return "operator";
    if (manifest.scope.type === "workspace" && typeof manifest.scope.workspace_id === "string" && manifest.scope.workspace_id.length > 0) {
      return `workspace:${manifest.scope.workspace_id}`;
    }
    throw new BotRegistryError("INVALID_SCOPE", `Durable Bot ${manifest.id} has an invalid registry scope`);
  }
}
