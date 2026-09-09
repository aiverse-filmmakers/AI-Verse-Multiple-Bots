import { CoordinationStore } from "./store.js";
import type { JsonObject, StoredObject } from "./types.js";

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

const ACTIVE_TASK_STATES = new Set([
  "created",
  "assigned",
  "accepted",
  "running",
  "waiting_input",
  "waiting_approval",
  "blocked"
]);

export class PolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface CoordinationPolicyOptions {
  requireRegisteredBots?: boolean;
  defaultMaxHops?: number;
  absoluteMaxHops?: number;
  maxToolsPerTask?: number;
  maxConnectionsPerTask?: number;
}

export interface DelegationSafetyInput {
  createdBy: string;
  assigneeId: string;
  workspaceId: string;
  rootObjectiveId: string;
  objective: string;
  requiredConstraints?: string[];
  tools?: string[];
  connections?: string[];
  parentTaskId?: string;
  hop?: number;
  maxHops?: number;
}

export interface PreparedDelegationSafety {
  parentTaskId: string | null;
  requiredConstraints: string[];
  hop: number;
  maxHops: number;
}

export class CoordinationPolicy {
  readonly requireRegisteredBots: boolean;
  readonly defaultMaxHops: number;
  readonly absoluteMaxHops: number;
  readonly maxToolsPerTask: number;
  readonly maxConnectionsPerTask: number;

  constructor(readonly store: CoordinationStore, options: CoordinationPolicyOptions = {}) {
    this.requireRegisteredBots = options.requireRegisteredBots ?? false;
    this.defaultMaxHops = options.defaultMaxHops ?? 6;
    this.absoluteMaxHops = options.absoluteMaxHops ?? 12;
    this.maxToolsPerTask = options.maxToolsPerTask ?? 64;
    this.maxConnectionsPerTask = options.maxConnectionsPerTask ?? 64;
  }

  prepareDelegation(input: DelegationSafetyInput): PreparedDelegationSafety {
    if (!input.objective.trim()) throw new PolicyError("INVALID_OBJECTIVE", "Delegation objective cannot be empty");
    this.assertPrincipalWorkspace(input.createdBy, input.workspaceId, "creator");
    this.assertPrincipalWorkspace(input.assigneeId, input.workspaceId, "assignee");
    this.assertPeerAllowed(input.createdBy, input.assigneeId);
    this.assertRequestedAuthority(input.assigneeId, input.tools ?? [], input.connections ?? []);

    if ((input.tools?.length ?? 0) > this.maxToolsPerTask) {
      throw new PolicyError("TOOL_LIMIT_EXCEEDED", `Task requests more than ${this.maxToolsPerTask} tools`);
    }
    if ((input.connections?.length ?? 0) > this.maxConnectionsPerTask) {
      throw new PolicyError("CONNECTION_LIMIT_EXCEEDED", `Task requests more than ${this.maxConnectionsPerTask} connections`);
    }

    let parentTaskId: string | null = null;
    let inheritedConstraints: string[] = [];
    let hop = Math.max(0, input.hop ?? 0);
    let maxHops = Math.min(input.maxHops ?? this.defaultMaxHops, this.absoluteMaxHops);

    if (input.parentTaskId) {
      const parent = this.requireTask(input.parentTaskId);
      parentTaskId = parent.id;
      if (parent.workspaceId !== input.workspaceId) {
        throw new PolicyError("WORKSPACE_DENIED", `Parent Task ${parent.id} is outside workspace ${input.workspaceId}`);
      }
      if (String(parent.payload.root_objective_id) !== input.rootObjectiveId) {
        throw new PolicyError("ROOT_OBJECTIVE_MISMATCH", `Child Task must preserve root objective ${String(parent.payload.root_objective_id)}`);
      }
      inheritedConstraints = stringArray(parent.payload.required_constraints);
      hop = Number(parent.payload.hop ?? 0) + 1;
      const parentMax = Number(parent.payload.max_hops ?? this.defaultMaxHops);
      maxHops = Math.min(maxHops, parentMax, this.absoluteMaxHops);
    }

    if (!Number.isFinite(maxHops) || maxHops < 0) throw new PolicyError("INVALID_HOP_LIMIT", "maxHops must be a non-negative number");
    if (hop > maxHops) {
      throw new PolicyError("HOP_LIMIT_EXCEEDED", `Delegation hop ${hop} exceeds max_hops ${maxHops}`);
    }

    const requiredConstraints = [...new Set([...inheritedConstraints, ...(input.requiredConstraints ?? [])])];
    this.assertNoActiveDuplicate({ ...input, hop, maxHops });

    return { parentTaskId, requiredConstraints, hop, maxHops };
  }

  assertMessage(senderId: string, targetId: string, workspaceId: string): void {
    this.assertPrincipalWorkspace(senderId, workspaceId, "sender");
    this.assertPrincipalWorkspace(targetId, workspaceId, "target");
    this.assertPeerAllowed(senderId, targetId);
  }

  private assertPrincipalWorkspace(principalId: string, workspaceId: string, role: string): void {
    if (!principalId.startsWith("bot_")) return;
    const object = this.store.getObject(principalId);
    if (!object || object.kind !== "bot") {
      if (this.requireRegisteredBots) throw new PolicyError("NOT_FOUND", `${role} Bot ${principalId} is not registered`);
      return;
    }
    if (object.payload.status !== "active") throw new PolicyError("AGENT_UNAVAILABLE", `${role} Bot ${principalId} is not active`);
    if (object.workspaceId !== workspaceId) {
      throw new PolicyError("WORKSPACE_DENIED", `${role} Bot ${principalId} is outside workspace ${workspaceId}`);
    }
  }

  private assertPeerAllowed(senderId: string, targetId: string): void {
    if (!senderId.startsWith("bot_") || !targetId.startsWith("bot_")) return;
    const sender = this.store.getObject(senderId);
    if (!sender || sender.kind !== "bot") return;
    const permissions = asObject(sender.payload.permissions);
    if (!permissions || !Array.isArray(permissions.allowed_peers)) return;
    const allowed = stringArray(permissions.allowed_peers);
    if (!allowed.includes("*") && !allowed.includes(targetId)) {
      throw new PolicyError("PEER_DENIED", `${senderId} is not allowed to delegate or message ${targetId}`);
    }
  }

  private assertRequestedAuthority(assigneeId: string, tools: string[], connections: string[]): void {
    if (!assigneeId.startsWith("bot_")) return;
    const assignee = this.store.getObject(assigneeId);
    if (!assignee || assignee.kind !== "bot") return;
    const permissions = asObject(assignee.payload.permissions);
    if (!permissions) return;

    if (Array.isArray(permissions.allowed_tools)) {
      const allowedTools = new Set(stringArray(permissions.allowed_tools));
      for (const tool of tools) {
        if (!allowedTools.has("*") && !allowedTools.has(tool)) {
          throw new PolicyError("CAPABILITY_UNAVAILABLE", `${assigneeId} is not granted tool ${tool}`);
        }
      }
    }

    if (Array.isArray(permissions.allowed_connections)) {
      const allowedConnections = new Set(stringArray(permissions.allowed_connections));
      for (const connection of connections) {
        if (!allowedConnections.has("*") && !allowedConnections.has(connection)) {
          throw new PolicyError("CAPABILITY_UNAVAILABLE", `${assigneeId} is not granted connection ${connection}`);
        }
      }
    }
  }

  private assertNoActiveDuplicate(input: DelegationSafetyInput): void {
    const objective = input.objective.trim().replace(/\s+/g, " ").toLowerCase();
    for (const task of this.store.listObjects("task", input.workspaceId)) {
      if (!ACTIVE_TASK_STATES.has(String(task.payload.status))) continue;
      if (String(task.payload.root_objective_id) !== input.rootObjectiveId) continue;
      if (String(task.payload.assignee_id) !== input.assigneeId) continue;
      const existingObjective = String(task.payload.objective ?? "").trim().replace(/\s+/g, " ").toLowerCase();
      if (existingObjective === objective) {
        throw new PolicyError("DUPLICATE_TASK", `Equivalent active Task ${task.id} already exists for ${input.assigneeId}`);
      }
    }
  }

  private requireTask(taskId: string): StoredObject {
    const task = this.store.getObject(taskId);
    if (!task || task.kind !== "task") throw new PolicyError("NOT_FOUND", `Parent Task ${taskId} not found`);
    return task;
  }
}
