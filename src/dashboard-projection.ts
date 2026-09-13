import type { ExecutionQueue, ExecutionRecord } from "./execution-queue.js";
import type { CoordinationStore } from "./store.js";
import type { JsonObject, StoredObject } from "./types.js";

export const DASHBOARD_PROJECTION_SCHEMA = "1.0";
export const DASHBOARD_PROJECTION_PROVIDER = "ai-verse-multiple-bots/dashboard-projection-v1";

export type DashboardBotActivity =
  | "idle"
  | "working"
  | "approval-needed"
  | "blocked"
  | "disabled"
  | "archived";

export interface DashboardBotProjection extends JsonObject {
  id: string;
  workspace_id: string;
  name: string;
  status: string;
  activity: DashboardBotActivity;
  role_title: string | null;
  runtime_adapter: string | null;
  active_task_count: number;
  pending_approval_count: number;
  dead_letter_count: number;
  updated_at: string;
  controls: string[];
}

export interface DashboardTaskProjection extends JsonObject {
  id: string;
  workspace_id: string;
  status: string;
  objective: string | null;
  assignee_id: string | null;
  owner_id: string | null;
  run_id: string | null;
  root_objective_id: string | null;
  approval_id: string | null;
  deadline_at: string | null;
  execution_state: string | null;
  recovery_policy: string | null;
  attempts: number | null;
  max_attempts: number | null;
  last_error: string | null;
  updated_at: string;
  controls: string[];
}

export interface DashboardTeamRunProjection extends JsonObject {
  id: string;
  workspace_id: string;
  status: string;
  objective: string | null;
  leader_id: string | null;
  topology: string | null;
  participant_ids: string[];
  updated_at: string;
  controls: string[];
}

export interface DashboardRoomProjection extends JsonObject {
  id: string;
  workspace_id: string;
  name: string;
  status: string | null;
  member_ids: string[];
  leader_id: string | null;
  mode: string | null;
  temporary: boolean;
  updated_at: string;
}

export interface DashboardApprovalProjection extends JsonObject {
  id: string;
  workspace_id: string;
  status: string;
  task_id: string | null;
  actor_id: string | null;
  requested_by: string | null;
  requested_at: string | null;
  reason: string | null;
  action_kind: string | null;
  action_summary: string | null;
  updated_at: string;
  controls: string[];
}

export interface DashboardArtifactProjection extends JsonObject {
  id: string;
  workspace_id: string;
  task_id: string | null;
  run_id: string | null;
  producer_id: string | null;
  artifact_kind: string | null;
  title: string | null;
  summary: string | null;
  updated_at: string;
}

export interface DashboardAttentionItem extends JsonObject {
  id: string;
  workspace_id: string;
  kind: "approval" | "dead-letter" | "failed-task";
  severity: "action-required" | "error" | "warning";
  target_id: string;
  summary: string;
  updated_at: string;
  control: string | null;
}

export interface DashboardProjectionSnapshot extends JsonObject {
  schema_version: typeof DASHBOARD_PROJECTION_SCHEMA;
  provider: typeof DASHBOARD_PROJECTION_PROVIDER;
  projection_only: true;
  canonical_owner: "ai-verse-multiple-bots";
  dashboard_owns_truth: false;
  workspace_id: string;
  observed_at: string;
  event_cursor: number;
  counts: {
    bots: number;
    active_bots: number;
    tasks: number;
    active_tasks: number;
    team_runs: number;
    active_team_runs: number;
    rooms: number;
    pending_approvals: number;
    artifacts: number;
    attention: number;
  };
  bots: DashboardBotProjection[];
  tasks: DashboardTaskProjection[];
  team_runs: DashboardTeamRunProjection[];
  rooms: DashboardRoomProjection[];
  approvals: DashboardApprovalProjection[];
  artifacts: DashboardArtifactProjection[];
  attention: DashboardAttentionItem[];
}

export class DashboardProjectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DashboardProjectionError";
  }
}

function requiredScope(value: string): string {
  const workspaceId = value.trim();
  if (!workspaceId || workspaceId.length > 256 || /[\0\r\n]/.test(workspaceId)) {
    throw new DashboardProjectionError(
      "INVALID_DASHBOARD_WORKSPACE",
      "Dashboard projection requires a non-empty workspace id of at most 256 characters"
    );
  }
  return workspaceId;
}

function objectValue(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function taskIsActive(status: string): boolean {
  return ["assigned", "waiting_approval", "running"].includes(status);
}

function runIsActive(status: string): boolean {
  return ["created", "planning", "running", "synthesizing", "verifying"].includes(status);
}

function taskControls(task: StoredObject, execution: ExecutionRecord | null): string[] {
  const status = String(task.payload.status ?? "");
  const controls: string[] = [];
  if (!["completed", "failed", "canceled"].includes(status)) controls.push("task.cancel");
  if (
    status === "blocked"
    && execution?.state === "dead_letter"
    && execution.recoveryPolicy === "retry_safe"
    && execution.attempts < execution.maxAttempts
  ) {
    controls.push("task.retry");
  }
  return controls;
}

function botControls(status: string): string[] {
  if (status === "active") return ["bot.disable", "bot.archive"];
  if (status === "disabled") return ["bot.activate", "bot.archive"];
  return [];
}

function approvalControls(status: string): string[] {
  return status === "pending" ? ["approval.approve", "approval.deny"] : [];
}

function runControls(status: string): string[] {
  return runIsActive(status) ? ["team_run.cancel"] : [];
}

function attentionSort(a: DashboardAttentionItem, b: DashboardAttentionItem): number {
  const rank = { "action-required": 0, error: 1, warning: 2 } as const;
  const severity = rank[a.severity] - rank[b.severity];
  if (severity !== 0) return severity;
  return b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id);
}

export class DashboardProjectionProjector {
  constructor(
    readonly store: CoordinationStore,
    readonly executionQueue: ExecutionQueue
  ) {}

  project(workspaceInput: string): DashboardProjectionSnapshot {
    const workspaceId = requiredScope(workspaceInput);
    const bots = this.store.listObjects("bot", workspaceId);
    const tasks = this.store.listObjects("task", workspaceId);
    const runs = this.store.listObjects("team_run", workspaceId);
    const rooms = this.store.listObjects("room", workspaceId);
    const approvals = this.store.listObjects("approval", workspaceId);
    const artifacts = this.store.listObjects("artifact", workspaceId);
    const deadLetters = this.executionQueue.listDeadLetters(workspaceId);
    const deadByTask = new Map(deadLetters.map((item) => [item.itemId, item]));
    const executionByTask = new Map(tasks.map((task) => [task.id, this.executionQueue.getByItem(task.id)]));
    const pendingApprovalByTask = new Map(
      approvals
        .filter((approval) => approval.payload.status === "pending")
        .map((approval) => [String(approval.payload.task_id ?? ""), approval])
    );

    const taskProjections: DashboardTaskProjection[] = tasks.map((task) => {
      const execution = executionByTask.get(task.id) ?? null;
      return {
        id: task.id,
        workspace_id: workspaceId,
        status: String(task.payload.status ?? "unknown"),
        objective: stringValue(task.payload.objective),
        assignee_id: stringValue(task.payload.assignee_id),
        owner_id: stringValue(task.payload.owner_id),
        run_id: stringValue(task.payload.run_id),
        root_objective_id: stringValue(task.payload.root_objective_id),
        approval_id: stringValue(task.payload.approval_id),
        deadline_at: stringValue(task.payload.deadline_at),
        execution_state: execution?.state ?? null,
        recovery_policy: execution?.recoveryPolicy ?? null,
        attempts: execution?.attempts ?? null,
        max_attempts: execution?.maxAttempts ?? null,
        last_error: execution?.lastError ?? null,
        updated_at: task.updatedAt,
        controls: taskControls(task, execution)
      };
    });

    const tasksByBot = new Map<string, DashboardTaskProjection[]>();
    for (const task of taskProjections) {
      const owner = task.owner_id ?? task.assignee_id;
      if (!owner) continue;
      const current = tasksByBot.get(owner) ?? [];
      current.push(task);
      tasksByBot.set(owner, current);
    }

    const botProjections: DashboardBotProjection[] = bots.map((bot) => {
      const status = String(bot.payload.status ?? "unknown");
      const assigned = tasksByBot.get(bot.id) ?? [];
      const active = assigned.filter((task) => taskIsActive(task.status));
      const pending = active.filter((task) => task.status === "waiting_approval").length;
      const dead = assigned.filter((task) => deadByTask.has(task.id)).length;
      const role = objectValue(bot.payload.role);
      const runtime = objectValue(bot.payload.runtime);
      const activity: DashboardBotActivity = status === "disabled"
        ? "disabled"
        : status === "archived"
          ? "archived"
          : dead > 0
            ? "blocked"
            : pending > 0
              ? "approval-needed"
              : active.length > 0
                ? "working"
                : "idle";
      return {
        id: bot.id,
        workspace_id: workspaceId,
        name: String(bot.payload.name ?? bot.id),
        status,
        activity,
        role_title: stringValue(role.title),
        runtime_adapter: stringValue(runtime.adapter),
        active_task_count: active.length,
        pending_approval_count: pending,
        dead_letter_count: dead,
        updated_at: bot.updatedAt,
        controls: botControls(status)
      };
    });

    const runProjections: DashboardTeamRunProjection[] = runs.map((run) => {
      const status = String(run.payload.status ?? "unknown");
      return {
        id: run.id,
        workspace_id: workspaceId,
        status,
        objective: stringValue(run.payload.objective),
        leader_id: stringValue(run.payload.leader_id),
        topology: stringValue(run.payload.topology),
        participant_ids: stringArray(run.payload.participant_ids),
        updated_at: run.updatedAt,
        controls: runControls(status)
      };
    });

    const roomProjections: DashboardRoomProjection[] = rooms.map((room) => {
      const orchestration = objectValue(room.payload.orchestration);
      return {
        id: room.id,
        workspace_id: workspaceId,
        name: String(room.payload.name ?? room.id),
        status: stringValue(room.payload.status),
        member_ids: stringArray(room.payload.members),
        leader_id: stringValue(room.payload.leader_id),
        mode: stringValue(orchestration.mode),
        temporary: room.payload.temporary === true,
        updated_at: room.updatedAt
      };
    });

    const approvalProjections: DashboardApprovalProjection[] = approvals.map((approval) => {
      const action = objectValue(approval.payload.action);
      const status = String(approval.payload.status ?? "unknown");
      return {
        id: approval.id,
        workspace_id: workspaceId,
        status,
        task_id: stringValue(approval.payload.task_id),
        actor_id: stringValue(approval.payload.actor_id),
        requested_by: stringValue(approval.payload.requested_by),
        requested_at: stringValue(approval.payload.requested_at),
        reason: stringValue(approval.payload.reason),
        action_kind: stringValue(action.kind),
        action_summary: stringValue(action.summary),
        updated_at: approval.updatedAt,
        controls: approvalControls(status)
      };
    });

    const artifactProjections: DashboardArtifactProjection[] = artifacts.map((artifact) => ({
      id: artifact.id,
      workspace_id: workspaceId,
      task_id: stringValue(artifact.payload.task_id),
      run_id: stringValue(artifact.payload.run_id),
      producer_id: stringValue(artifact.payload.producer_id ?? artifact.payload.created_by),
      artifact_kind: stringValue(artifact.payload.artifact_kind ?? artifact.payload.kind),
      title: stringValue(artifact.payload.title),
      summary: stringValue(artifact.payload.summary),
      updated_at: artifact.updatedAt
    }));

    const attention: DashboardAttentionItem[] = [];
    for (const approval of approvalProjections) {
      if (approval.status !== "pending") continue;
      attention.push({
        id: `attention:approval:${approval.id}`,
        workspace_id: workspaceId,
        kind: "approval",
        severity: "action-required",
        target_id: approval.id,
        summary: approval.action_summary ?? approval.reason ?? `Approval ${approval.id} requires a decision`,
        updated_at: approval.updated_at,
        control: "approval.approve"
      });
    }
    for (const dead of deadLetters) {
      attention.push({
        id: `attention:dead-letter:${dead.itemId}`,
        workspace_id: workspaceId,
        kind: "dead-letter",
        severity: "error",
        target_id: dead.itemId,
        summary: dead.lastError ?? `Task ${dead.itemId} is dead-lettered`,
        updated_at: dead.updatedAt,
        control: dead.recoveryPolicy === "retry_safe" && dead.attempts < dead.maxAttempts ? "task.retry" : null
      });
    }
    for (const task of taskProjections) {
      if (task.status !== "failed" || deadByTask.has(task.id)) continue;
      attention.push({
        id: `attention:failed-task:${task.id}`,
        workspace_id: workspaceId,
        kind: "failed-task",
        severity: "warning",
        target_id: task.id,
        summary: task.last_error ?? task.objective ?? `Task ${task.id} failed`,
        updated_at: task.updated_at,
        control: null
      });
    }
    attention.sort(attentionSort);

    return {
      schema_version: DASHBOARD_PROJECTION_SCHEMA,
      provider: DASHBOARD_PROJECTION_PROVIDER,
      projection_only: true,
      canonical_owner: "ai-verse-multiple-bots",
      dashboard_owns_truth: false,
      workspace_id: workspaceId,
      observed_at: new Date().toISOString(),
      event_cursor: this.store.latestEventSequence(),
      counts: {
        bots: botProjections.length,
        active_bots: botProjections.filter((bot) => bot.status === "active").length,
        tasks: taskProjections.length,
        active_tasks: taskProjections.filter((task) => taskIsActive(task.status)).length,
        team_runs: runProjections.length,
        active_team_runs: runProjections.filter((run) => runIsActive(run.status)).length,
        rooms: roomProjections.length,
        pending_approvals: approvalProjections.filter((approval) => approval.status === "pending").length,
        artifacts: artifactProjections.length,
        attention: attention.length
      },
      bots: botProjections,
      tasks: taskProjections,
      team_runs: runProjections,
      rooms: roomProjections,
      approvals: approvalProjections,
      artifacts: artifactProjections,
      attention
    };
  }

  requireWorkspaceObject(workspaceInput: string, objectId: string, kinds: string[]): StoredObject {
    const workspaceId = requiredScope(workspaceInput);
    const object = this.store.getObject(objectId);
    if (!object || !kinds.includes(object.kind)) {
      throw new DashboardProjectionError(
        "DASHBOARD_TARGET_NOT_FOUND",
        `Dashboard target ${objectId} was not found for the requested control`
      );
    }
    if (object.workspaceId !== workspaceId) {
      throw new DashboardProjectionError(
        "DASHBOARD_WORKSPACE_MISMATCH",
        `Dashboard target ${objectId} does not belong to workspace ${workspaceId}`
      );
    }
    return object;
  }
}
