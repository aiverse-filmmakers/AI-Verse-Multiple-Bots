export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = Record<string, unknown>;

export type ProtocolKind =
  | "bot"
  | "worker"
  | "room"
  | "thread"
  | "message"
  | "task"
  | "handoff"
  | "artifact"
  | "team_run"
  | "capability_lease"
  | "environment_lease"
  | "approval"
  | "event";

export interface StoredObject<T extends JsonObject = JsonObject> {
  id: string;
  kind: ProtocolKind;
  workspaceId: string | null;
  status: string | null;
  payload: T;
  createdAt: string;
  updatedAt: string;
}

export interface CoordinationEvent extends JsonObject {
  schema_version: "1.0";
  id: string;
  type: string;
  timestamp: string;
  actor_id: string;
  workspace_id?: string | null;
  run_id?: string | null;
  task_id?: string | null;
  room_id?: string | null;
  thread_id?: string | null;
  correlation_id?: string | null;
  causation_id?: string | null;
  trace_id?: string | null;
  summary?: string | null;
  attention_state?: string;
}

export interface AppendedEvent {
  sequence: number;
  roomSequence: number | null;
  event: CoordinationEvent;
}

export interface BotManifest extends JsonObject {
  schema_version: "1.0";
  id: string;
  name: string;
  kind: "durable";
  status: "active" | "disabled" | "archived";
  role: {
    title: string;
    mission: string;
    [key: string]: unknown;
  };
  runtime: {
    adapter: string;
    [key: string]: unknown;
  };
  execution: {
    environment_policy: "shared_workspace" | "isolated_bot" | "isolated_run" | "external_managed";
    [key: string]: unknown;
  };
  scope: {
    type: "workspace" | "operator";
    workspace_id?: string;
  };
  permissions: {
    policy_ref: string;
    [key: string]: unknown;
  };
  coordination: JsonObject;
}

export interface DeliveryRecord {
  id: string;
  messageId: string;
  senderId: string;
  targetKind: string;
  targetId: string;
  workspaceId: string;
  state: "queued" | "accepted" | "delivered" | "processing" | "replied" | "expired" | "failed" | "canceled";
  createdAt: string;
  updatedAt: string;
}
