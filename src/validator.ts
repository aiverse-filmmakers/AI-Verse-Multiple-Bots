import type { BotManifest, JsonObject, ProtocolKind } from "./types.js";

export class ProtocolValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Protocol validation failed: ${issues.join("; ")}`);
    this.name = "ProtocolValidationError";
    this.issues = issues;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(object: JsonObject, key: string, issues: string[]): void {
  if (typeof object[key] !== "string" || String(object[key]).length === 0) {
    issues.push(`${key} must be a non-empty string`);
  }
}

function optionalStringOrNull(object: JsonObject, key: string, issues: string[]): void {
  const value = object[key];
  if (value !== undefined && value !== null && (typeof value !== "string" || value.length === 0)) {
    issues.push(`${key} must be a non-empty string or null`);
  }
}

function requiredObject(object: JsonObject, key: string, issues: string[]): JsonObject | null {
  const value = object[key];
  if (!isObject(value)) {
    issues.push(`${key} must be an object`);
    return null;
  }
  return value;
}

export function inferProtocolKind(object: JsonObject): ProtocolKind {
  if (object.kind === "durable" && typeof object.role === "object") return "bot";
  if (object.type === "worker") return "worker";
  if (object.type === "thread") return "thread";
  if (object.type === "message.chat") return "message";
  if (object.type === "task.delegate") return "task";
  if (object.type === "handoff") return "handoff";
  if (object.type === "artifact") return "artifact";
  if (object.type === "team_run") return "team_run";
  if (object.type === "capability_lease") return "capability_lease";
  if (object.type === "environment_lease") return "environment_lease";
  if (object.type === "approval") return "approval";
  if (typeof object.type === "string" && object.type.startsWith("event.")) return "event";
  if (typeof object.name === "string" && Array.isArray(object.members) && isObject(object.orchestration)) return "room";
  if (typeof object.type === "string" && typeof object.timestamp === "string" && typeof object.actor_id === "string") return "event";
  throw new ProtocolValidationError(["unable to infer protocol kind"]);
}

export function validateProtocolObject(value: unknown, expectedKind?: ProtocolKind): JsonObject {
  const issues: string[] = [];
  if (!isObject(value)) throw new ProtocolValidationError(["value must be an object"]);
  if (value.schema_version !== "1.0") issues.push("schema_version must equal 1.0");
  requiredString(value, "id", issues);

  let kind: ProtocolKind;
  try {
    kind = expectedKind ?? inferProtocolKind(value);
  } catch (error) {
    if (error instanceof ProtocolValidationError) issues.push(...error.issues);
    kind = expectedKind ?? "event";
  }

  switch (kind) {
    case "bot": {
      if (value.kind !== "durable") issues.push("bot.kind must equal durable");
      requiredString(value, "name", issues);
      requiredString(value, "status", issues);
      const role = requiredObject(value, "role", issues);
      if (role) {
        requiredString(role, "title", issues);
        requiredString(role, "mission", issues);
      }
      const runtime = requiredObject(value, "runtime", issues);
      if (runtime) {
        requiredString(runtime, "adapter", issues);
        if (runtime.adapter === "external-managed") {
          requiredString(runtime, "provider", issues);
          requiredString(runtime, "managed_bot_ref", issues);
          requiredString(runtime, "binding_fingerprint", issues);
        }
      }
      const execution = requiredObject(value, "execution", issues);
      if (execution) {
        requiredString(execution, "environment_policy", issues);
        if (runtime?.adapter === "external-managed" && execution.environment_policy !== "external_managed") {
          issues.push("external-managed Bot execution.environment_policy must equal external_managed");
        }
      }
      const scope = requiredObject(value, "scope", issues);
      if (scope) {
        requiredString(scope, "type", issues);
        if (scope.type === "workspace") requiredString(scope, "workspace_id", issues);
      }
      const permissions = requiredObject(value, "permissions", issues);
      if (permissions) requiredString(permissions, "policy_ref", issues);
      requiredObject(value, "coordination", issues);
      break;
    }
    case "worker": {
      if (value.type !== "worker") issues.push("worker.type must equal worker");
      if (value.kind !== undefined && value.kind !== "temporary") issues.push("worker.kind must equal temporary when present");
      for (const key of ["run_id", "created_by", "workspace_id", "status"]) requiredString(value, key, issues);
      optionalStringOrNull(value, "task_id", issues);
      optionalStringOrNull(value, "parent_owner_id", issues);
      const role = requiredObject(value, "role", issues);
      if (role) {
        requiredString(role, "title", issues);
        requiredString(role, "objective", issues);
      }
      if (
        typeof value.status === "string"
        && !["created", "ready", "running", "waiting", "completed", "failed", "canceled", "expired"].includes(value.status)
      ) {
        issues.push("worker.status is not supported");
      }
      break;
    }
    case "room":
      requiredString(value, "name", issues);
      requiredObject(value, "scope", issues);
      if (!Array.isArray(value.members) || value.members.length === 0) issues.push("members must be a non-empty array");
      requiredObject(value, "orchestration", issues);
      break;
    case "thread":
      requiredString(value, "workspace_id", issues);
      requiredString(value, "parent_message_id", issues);
      requiredString(value, "created_by", issues);
      requiredString(value, "status", issues);
      break;
    case "message":
      requiredString(value, "timestamp", issues);
      requiredString(value, "sender_id", issues);
      requiredString(value, "workspace_id", issues);
      requiredObject(value, "target", issues);
      if (!Array.isArray(value.content) || value.content.length === 0) issues.push("content must be a non-empty array");
      requiredObject(value, "provenance", issues);
      break;
    case "task":
      for (const key of ["created_by", "assignee_id", "owner_id", "workspace_id", "root_objective_id", "reason", "objective", "lease_id", "status"]) {
        requiredString(value, key, issues);
      }
      if (!Array.isArray(value.required_constraints)) issues.push("required_constraints must be an array");
      requiredObject(value, "expected_output", issues);
      break;
    case "handoff": {
      for (const key of ["source_owner_id", "target_bot_id", "workspace_id", "task_id", "root_objective_id", "reason", "return_policy", "status"]) {
        requiredString(value, key, issues);
      }
      if (!Array.isArray(value.required_constraints)) issues.push("required_constraints must be an array");
      if (
        typeof value.return_policy === "string"
        && !["stay_with_target", "return_on_completion", "return_on_block", "explicit_only"].includes(value.return_policy)
      ) {
        issues.push("return_policy is not supported");
      }
      if (
        typeof value.status === "string"
        && !["requested", "accepted", "rejected", "ownership_changed", "completed", "canceled", "failed"].includes(value.status)
      ) {
        issues.push("handoff.status is not supported");
      }
      break;
    }
    case "artifact":
      for (const key of ["workspace_id", "created_by", "kind"]) requiredString(value, key, issues);
      requiredObject(value, "provenance", issues);
      break;
    case "team_run": {
      if (value.type !== "team_run") issues.push("team_run.type must equal team_run");
      for (const key of ["workspace_id", "root_objective_id", "topology", "status"]) requiredString(value, key, issues);
      optionalStringOrNull(value, "leader_id", issues);
      if (value.participant_ids !== undefined && !Array.isArray(value.participant_ids)) issues.push("participant_ids must be an array");
      if (
        typeof value.topology === "string"
        && !["single", "manager", "handoff", "parallel_panel", "group_room", "pipeline", "review", "dynamic_squad", "hybrid"].includes(value.topology)
      ) {
        issues.push("team_run.topology is not supported");
      }
      if (
        typeof value.status === "string"
        && !["created", "planning", "running", "waiting_input", "waiting_approval", "synthesizing", "verifying", "completed", "failed", "canceled", "budget_exhausted"].includes(value.status)
      ) {
        issues.push("team_run.status is not supported");
      }
      break;
    }
    case "capability_lease":
      for (const key of ["principal", "issued_to", "workspace_id", "task_id", "expires_at"]) requiredString(value, key, issues);
      break;
    case "environment_lease":
      for (const key of ["issued_to", "workspace_id", "environment_policy", "environment_ref", "expires_at"]) requiredString(value, key, issues);
      break;
    case "approval": {
      for (const key of ["workspace_id", "actor_id", "status"]) requiredString(value, key, issues);
      const action = requiredObject(value, "action", issues);
      if (action) {
        requiredString(action, "kind", issues);
        requiredString(action, "summary", issues);
      }
      break;
    }
    case "event":
      requiredString(value, "type", issues);
      requiredString(value, "timestamp", issues);
      requiredString(value, "actor_id", issues);
      break;
  }

  if (issues.length > 0) throw new ProtocolValidationError(issues);
  return value;
}

export function validateBotManifest(value: unknown): BotManifest {
  return validateProtocolObject(value, "bot") as BotManifest;
}
