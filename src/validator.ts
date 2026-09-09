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

function requiredObject(object: JsonObject, key: string, issues: string[]): JsonObject | null {
  const value = object[key];
  if (!isObject(value)) {
    issues.push(`${key} must be an object`);
    return null;
  }
  return value;
}

function supportedString(object: JsonObject, key: string, allowed: readonly string[], issues: string[]): void {
  requiredString(object, key, issues);
  if (typeof object[key] === "string" && !allowed.includes(String(object[key]))) {
    issues.push(`${key} is not supported`);
  }
}

function optionalStringArray(object: JsonObject, key: string, issues: string[], unique = false): void {
  const value = object[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    issues.push(`${key} must be an array of non-empty strings`);
    return;
  }
  if (unique && new Set(value).size !== value.length) issues.push(`${key} must contain unique values`);
}

function optionalBoolean(object: JsonObject, key: string, issues: string[]): void {
  if (object[key] !== undefined && typeof object[key] !== "boolean") issues.push(`${key} must be a boolean`);
}

function optionalInteger(object: JsonObject, key: string, minimum: number, issues: string[]): void {
  const value = object[key];
  if (value !== undefined && (!Number.isInteger(value) || Number(value) < minimum)) {
    issues.push(`${key} must be an integer >= ${minimum}`);
  }
}

export function inferProtocolKind(object: JsonObject): ProtocolKind {
  if (object.kind === "durable" && typeof object.role === "object") return "bot";
  if (object.kind === "temporary" && object.type === "worker") return "worker";
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
      if (typeof value.id === "string" && !value.id.startsWith("bot_")) issues.push("bot.id must use the bot_ prefix");
      requiredString(value, "name", issues);
      supportedString(value, "status", ["active", "disabled", "archived"], issues);

      const role = requiredObject(value, "role", issues);
      if (role) {
        requiredString(role, "title", issues);
        requiredString(role, "mission", issues);
        optionalStringArray(role, "responsibilities", issues);
        optionalStringArray(role, "non_responsibilities", issues);
      }

      const runtime = requiredObject(value, "runtime", issues);
      if (runtime) {
        requiredString(runtime, "adapter", issues);
        if (runtime.profile_ref !== undefined && runtime.profile_ref !== null && (typeof runtime.profile_ref !== "string" || runtime.profile_ref.length === 0)) {
          issues.push("runtime.profile_ref must be a non-empty string or null");
        }
      }

      const execution = requiredObject(value, "execution", issues);
      if (execution) {
        supportedString(execution, "environment_policy", ["shared_workspace", "isolated_bot", "isolated_run", "external_managed"], issues);
        if (execution.environment_ref !== undefined && execution.environment_ref !== null && (typeof execution.environment_ref !== "string" || execution.environment_ref.length === 0)) {
          issues.push("execution.environment_ref must be a non-empty string or null");
        }
        if (execution.persistence !== undefined && !["durable", "run_scoped", "disposable", "external"].includes(String(execution.persistence))) {
          issues.push("execution.persistence is not supported");
        }
      }

      if (value.model_policy !== undefined && !isObject(value.model_policy)) issues.push("model_policy must be an object");

      const scope = requiredObject(value, "scope", issues);
      if (scope) {
        supportedString(scope, "type", ["workspace", "operator"], issues);
        if (scope.type === "workspace") requiredString(scope, "workspace_id", issues);
      }

      if (value.capabilities !== undefined) {
        if (!isObject(value.capabilities)) {
          issues.push("capabilities must be an object");
        } else {
          for (const key of ["role_refs", "skill_refs", "operator_refs", "tool_refs"]) {
            optionalStringArray(value.capabilities, key, issues, true);
          }
        }
      }

      const permissions = requiredObject(value, "permissions", issues);
      if (permissions) {
        requiredString(permissions, "policy_ref", issues);
        optionalStringArray(permissions, "allowed_peers", issues);
        optionalStringArray(permissions, "allowed_tools", issues);
        optionalStringArray(permissions, "allowed_connections", issues);
        optionalBoolean(permissions, "can_create_workers", issues);
        optionalBoolean(permissions, "can_create_bots", issues);
        optionalBoolean(permissions, "can_handoff", issues);
      }

      const coordination = requiredObject(value, "coordination", issues);
      if (coordination) {
        if (coordination.manager_id !== undefined && coordination.manager_id !== null && (typeof coordination.manager_id !== "string" || coordination.manager_id.length === 0)) {
          issues.push("coordination.manager_id must be a non-empty string or null");
        }
        if (coordination.default_mode !== undefined && (typeof coordination.default_mode !== "string" || coordination.default_mode.length === 0)) {
          issues.push("coordination.default_mode must be a non-empty string");
        }
        optionalStringArray(coordination, "aliases", issues, true);
        optionalInteger(coordination, "max_parallel_workers", 1, issues);
        optionalInteger(coordination, "max_hops", 0, issues);
      }
      break;
    }
    case "worker":
      requiredString(value, "parent_owner_id", issues);
      requiredString(value, "workspace_id", issues);
      requiredString(value, "task_id", issues);
      requiredString(value, "run_id", issues);
      break;
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
    case "team_run":
      for (const key of ["workspace_id", "root_objective_id", "topology", "status"]) requiredString(value, key, issues);
      break;
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
