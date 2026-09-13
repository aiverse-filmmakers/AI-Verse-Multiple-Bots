import type { ExecutionQueue, ExecutionRecord } from "./execution-queue.js";
import type { CoordinationGateway } from "./gateway.js";
import type { CoordinationStore } from "./store.js";
import type { AppendedEvent, JsonObject, StoredObject } from "./types.js";

export const OPERATOR_ATTENTION_SCHEMA = "1.0";
export const OPERATOR_ATTENTION_PROVIDER = "ai-verse-multiple-bots/operator-attention-v1";

export type OperatorAttentionState =
  | "needs_approval"
  | "needs_input"
  | "blocked"
  | "failed"
  | "handoff_waiting"
  | "unread_result";

export interface OperatorApprovalCard extends JsonObject {
  id: string;
  workspace_id: string;
  status: string;
  task_id: string | null;
  task_status: string | null;
  task_objective: string | null;
  assignee_id: string | null;
  owner_id: string | null;
  requested_by: string | null;
  actor_id: string | null;
  requested_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  reason: string | null;
  rejection_reason: string | null;
  action_kind: string | null;
  action_summary: string | null;
  controls: string[];
  updated_at: string;
}

export interface OperatorAttentionItem extends JsonObject {
  id: string;
  workspace_id: string;
  state: OperatorAttentionState;
  priority: number;
  source_kind: "approval" | "task" | "handoff" | "event";
  source_id: string;
  task_id: string | null;
  run_id: string | null;
  room_id: string | null;
  thread_id: string | null;
  summary: string;
  owner_id: string | null;
  controls: string[];
  updated_at: string;
  event_sequence: number | null;
}

export interface OperatorAttentionSnapshot extends JsonObject {
  schema_version: typeof OPERATOR_ATTENTION_SCHEMA;
  provider: typeof OPERATOR_ATTENTION_PROVIDER;
  projection_only: true;
  canonical_owner: "ai-verse-multiple-bots";
  operator_ux_owns_truth: false;
  workspace_id: string;
  observed_at: string;
  requested_after: number;
  event_cursor: number;
  priority_order: OperatorAttentionState[];
  counts: Record<OperatorAttentionState, number> & { total: number };
  items: OperatorAttentionItem[];
}

export interface OperatorApprovalDecisionReceipt extends JsonObject {
  schema_version: typeof OPERATOR_ATTENTION_SCHEMA;
  provider: typeof OPERATOR_ATTENTION_PROVIDER;
  control_only: true;
  canonical_owner: "ai-verse-multiple-bots";
  operator_ux_owns_truth: false;
  workspace_id: string;
  approval_id: string;
  task_id: string;
  decision: "approve" | "deny";
  actor_id: string;
  approval_status: string;
  task_status: string;
  event_cursor: number;
  observed_at: string;
}

export class OperatorAttentionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "OperatorAttentionError";
  }
}

const PRIORITY_ORDER: OperatorAttentionState[] = [
  "needs_approval",
  "needs_input",
  "blocked",
  "failed",
  "handoff_waiting",
  "unread_result"
];

const PRIORITY = new Map(PRIORITY_ORDER.map((state, index) => [state, index + 1]));

function requiredScope(value: string): string {
  const workspaceId = value.trim();
  if (!workspaceId || workspaceId.length > 256 || /[\0\r\n]/.test(workspaceId)) {
    throw new OperatorAttentionError(
      "INVALID_OPERATOR_WORKSPACE",
      "Operator attention requires a non-empty workspace id of at most 256 characters"
    );
  }
  return workspaceId;
}

function operatorActor(value: string): string {
  const actorId = value.trim();
  if (!actorId.startsWith("operator_") || actorId.length > 256 || /[\0\r\n]/.test(actorId)) {
    throw new OperatorAttentionError(
      "OPERATOR_ID_REQUIRED",
      "Operator approval decisions require an operator_* actor id",
      403
    );
  }
  return actorId;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function taskRetryAllowed(execution: ExecutionRecord | null): boolean {
  return Boolean(
    execution
    && execution.state === "dead_letter"
    && execution.recoveryPolicy === "retry_safe"
    && execution.attempts < execution.maxAttempts
  );
}

function attentionItemSort(a: OperatorAttentionItem, b: OperatorAttentionItem): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id);
}

function eventTimestamp(event: AppendedEvent): string {
  return typeof event.event.timestamp === "string"
    ? event.event.timestamp
    : new Date(0).toISOString();
}

export class OperatorAttentionProjector {
  constructor(
    readonly store: CoordinationStore,
    readonly executionQueue: ExecutionQueue
  ) {}

  capabilities(workspaceInput: string): JsonObject {
    const workspaceId = requiredScope(workspaceInput);
    return {
      schema_version: OPERATOR_ATTENTION_SCHEMA,
      provider: OPERATOR_ATTENTION_PROVIDER,
      projection_only: true,
      canonical_owner: "ai-verse-multiple-bots",
      operator_ux_owns_truth: false,
      workspace_id: workspaceId,
      priority_order: PRIORITY_ORDER,
      queries: [
        "operator.attention",
        "operator.approvals"
      ],
      controls: [
        "operator.approval.approve",
        "operator.approval.deny"
      ],
      realtime: {
        canonical_event_cursor: true,
        existing_workspace_event_stream: "/v1/dashboard/events/stream"
      }
    };
  }

  project(workspaceInput: string, afterInput = 0): OperatorAttentionSnapshot {
    const workspaceId = requiredScope(workspaceInput);
    if (!Number.isInteger(afterInput) || afterInput < 0) {
      throw new OperatorAttentionError(
        "INVALID_OPERATOR_CURSOR",
        "Operator attention cursor must be a non-negative integer"
      );
    }

    const tasks = this.store.listObjects("task", workspaceId);
    const approvals = this.store.listObjects("approval", workspaceId);
    const handoffs = this.store.listObjects("handoff", workspaceId);
    const executionByTask = new Map(
      tasks.map((task) => [task.id, this.executionQueue.getByItem(task.id)])
    );
    const items: OperatorAttentionItem[] = [];
    const representedTasks = new Set<string>();

    for (const approval of approvals) {
      if (String(approval.payload.status ?? "") !== "pending") continue;
      const taskId = optionalString(approval.payload.task_id);
      if (taskId) representedTasks.add(taskId);
      const action = asObject(approval.payload.action);
      items.push({
        id: `operator-attention:approval:${approval.id}`,
        workspace_id: workspaceId,
        state: "needs_approval",
        priority: PRIORITY.get("needs_approval") as number,
        source_kind: "approval",
        source_id: approval.id,
        task_id: taskId,
        run_id: taskId ? optionalString(this.store.getObject(taskId)?.payload.run_id) : null,
        room_id: null,
        thread_id: null,
        summary:
          optionalString(action.summary)
          ?? optionalString(approval.payload.reason)
          ?? `Approval ${approval.id} requires an operator decision`,
        owner_id: taskId ? optionalString(this.store.getObject(taskId)?.payload.owner_id) : null,
        controls: ["operator.approval.approve", "operator.approval.deny"],
        updated_at: approval.updatedAt,
        event_sequence: null
      });
    }

    for (const task of tasks) {
      const status = String(task.payload.status ?? "");
      if (representedTasks.has(task.id) && status === "waiting_approval") continue;
      const execution = executionByTask.get(task.id) ?? null;
      const ownerId = optionalString(task.payload.owner_id ?? task.payload.assignee_id);
      const runId = optionalString(task.payload.run_id);
      const objective = optionalString(task.payload.objective);

      if (status === "waiting_input") {
        representedTasks.add(task.id);
        items.push({
          id: `operator-attention:task-input:${task.id}`,
          workspace_id: workspaceId,
          state: "needs_input",
          priority: PRIORITY.get("needs_input") as number,
          source_kind: "task",
          source_id: task.id,
          task_id: task.id,
          run_id: runId,
          room_id: null,
          thread_id: null,
          summary: optionalString(task.payload.waiting_reason) ?? objective ?? `Task ${task.id} needs operator input`,
          owner_id: ownerId,
          controls: ["task.cancel"],
          updated_at: task.updatedAt,
          event_sequence: null
        });
        continue;
      }

      if (status === "blocked") {
        representedTasks.add(task.id);
        const retryAllowed = taskRetryAllowed(execution);
        items.push({
          id: `operator-attention:task-blocked:${task.id}`,
          workspace_id: workspaceId,
          state: "blocked",
          priority: PRIORITY.get("blocked") as number,
          source_kind: "task",
          source_id: task.id,
          task_id: task.id,
          run_id: runId,
          room_id: null,
          thread_id: null,
          summary: execution?.lastError ?? optionalString(task.payload.failure_reason) ?? objective ?? `Task ${task.id} is blocked`,
          owner_id: ownerId,
          controls: [
            ...(retryAllowed ? ["task.retry"] : []),
            "task.cancel"
          ],
          updated_at: execution?.updatedAt ?? task.updatedAt,
          event_sequence: null
        });
        continue;
      }

      if (["failed", "timeout", "budget_exhausted", "rejected_policy"].includes(status)) {
        representedTasks.add(task.id);
        items.push({
          id: `operator-attention:task-failed:${task.id}`,
          workspace_id: workspaceId,
          state: "failed",
          priority: PRIORITY.get("failed") as number,
          source_kind: "task",
          source_id: task.id,
          task_id: task.id,
          run_id: runId,
          room_id: null,
          thread_id: null,
          summary: execution?.lastError ?? optionalString(task.payload.failure_reason) ?? objective ?? `Task ${task.id} failed`,
          owner_id: ownerId,
          controls: [],
          updated_at: execution?.updatedAt ?? task.updatedAt,
          event_sequence: null
        });
      }
    }

    for (const handoff of handoffs) {
      if (String(handoff.payload.status ?? "") !== "requested") continue;
      const taskId = optionalString(handoff.payload.task_id ?? handoff.payload.work_item_id);
      items.push({
        id: `operator-attention:handoff:${handoff.id}`,
        workspace_id: workspaceId,
        state: "handoff_waiting",
        priority: PRIORITY.get("handoff_waiting") as number,
        source_kind: "handoff",
        source_id: handoff.id,
        task_id: taskId,
        run_id: taskId ? optionalString(this.store.getObject(taskId)?.payload.run_id) : null,
        room_id: null,
        thread_id: null,
        summary:
          optionalString(handoff.payload.reason)
          ?? `Handoff ${handoff.id} is waiting for ${String(handoff.payload.target_bot_id ?? handoff.payload.target_owner_id ?? "target")}`,
        owner_id: optionalString(handoff.payload.source_owner_id),
        controls: [],
        updated_at: handoff.updatedAt,
        event_sequence: null
      });
    }

    const events = this.store.listWorkspaceEventsAfter(workspaceId, afterInput, 1000);
    const currentKeys = new Set(
      items.flatMap((item) => [
        item.task_id ? `task:${item.task_id}` : "",
        `${item.source_kind}:${item.source_id}`
      ]).filter(Boolean)
    );

    for (const event of events) {
      const state = optionalString(event.event.attention_state) as OperatorAttentionState | null;
      if (!state || !PRIORITY.has(state)) continue;
      if (state === "needs_approval") continue;

      const taskId = optionalString(event.event.task_id);
      if (taskId && currentKeys.has(`task:${taskId}`) && state !== "unread_result") continue;

      const sourceId = event.event.id;
      items.push({
        id: `operator-attention:event:${event.sequence}`,
        workspace_id: workspaceId,
        state,
        priority: PRIORITY.get(state) as number,
        source_kind: "event",
        source_id: sourceId,
        task_id: taskId,
        run_id: optionalString(event.event.run_id),
        room_id: optionalString(event.event.room_id),
        thread_id: optionalString(event.event.thread_id),
        summary: optionalString(event.event.summary) ?? `Coordination event ${event.event.type} requires attention`,
        owner_id: null,
        controls: [],
        updated_at: eventTimestamp(event),
        event_sequence: event.sequence
      });
    }

    items.sort(attentionItemSort);
    const counts = {
      total: items.length,
      needs_approval: items.filter((item) => item.state === "needs_approval").length,
      needs_input: items.filter((item) => item.state === "needs_input").length,
      blocked: items.filter((item) => item.state === "blocked").length,
      failed: items.filter((item) => item.state === "failed").length,
      handoff_waiting: items.filter((item) => item.state === "handoff_waiting").length,
      unread_result: items.filter((item) => item.state === "unread_result").length
    };

    return {
      schema_version: OPERATOR_ATTENTION_SCHEMA,
      provider: OPERATOR_ATTENTION_PROVIDER,
      projection_only: true,
      canonical_owner: "ai-verse-multiple-bots",
      operator_ux_owns_truth: false,
      workspace_id: workspaceId,
      observed_at: new Date().toISOString(),
      requested_after: afterInput,
      event_cursor: this.store.latestEventSequence(),
      priority_order: PRIORITY_ORDER,
      counts,
      items
    };
  }

  approvals(workspaceInput: string, status?: string): {
    schema_version: typeof OPERATOR_ATTENTION_SCHEMA;
    provider: typeof OPERATOR_ATTENTION_PROVIDER;
    projection_only: true;
    canonical_owner: "ai-verse-multiple-bots";
    operator_ux_owns_truth: false;
    workspace_id: string;
    observed_at: string;
    event_cursor: number;
    approvals: OperatorApprovalCard[];
  } {
    const workspaceId = requiredScope(workspaceInput);
    if (status && !["pending", "approved", "denied"].includes(status)) {
      throw new OperatorAttentionError(
        "INVALID_APPROVAL_STATUS",
        "Approval status filter must be pending, approved or denied"
      );
    }

    const cards = this.store.listObjects("approval", workspaceId)
      .filter((approval) => !status || String(approval.payload.status ?? "") === status)
      .map((approval) => this.approvalCard(workspaceId, approval))
      .sort((a, b) => {
        const aPending = a.status === "pending" ? 0 : 1;
        const bPending = b.status === "pending" ? 0 : 1;
        return aPending - bPending || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id);
      });

    return {
      schema_version: OPERATOR_ATTENTION_SCHEMA,
      provider: OPERATOR_ATTENTION_PROVIDER,
      projection_only: true,
      canonical_owner: "ai-verse-multiple-bots",
      operator_ux_owns_truth: false,
      workspace_id: workspaceId,
      observed_at: new Date().toISOString(),
      event_cursor: this.store.latestEventSequence(),
      approvals: cards
    };
  }

  requireWorkspaceApproval(workspaceInput: string, approvalId: string): StoredObject {
    const workspaceId = requiredScope(workspaceInput);
    const approval = this.store.getObject(approvalId);
    if (!approval || approval.kind !== "approval") {
      throw new OperatorAttentionError(
        "OPERATOR_APPROVAL_NOT_FOUND",
        `Approval ${approvalId} was not found`,
        404
      );
    }
    if (approval.workspaceId !== workspaceId) {
      throw new OperatorAttentionError(
        "OPERATOR_WORKSPACE_MISMATCH",
        `Approval ${approvalId} does not belong to workspace ${workspaceId}`,
        403
      );
    }
    return approval;
  }

  private approvalCard(workspaceId: string, approval: StoredObject): OperatorApprovalCard {
    const action = asObject(approval.payload.action);
    const taskId = optionalString(approval.payload.task_id);
    const task = taskId ? this.store.getObject(taskId) : null;
    return {
      id: approval.id,
      workspace_id: workspaceId,
      status: String(approval.payload.status ?? "unknown"),
      task_id: taskId,
      task_status: task?.kind === "task" ? String(task.payload.status ?? "unknown") : null,
      task_objective: task?.kind === "task" ? optionalString(task.payload.objective) : null,
      assignee_id: task?.kind === "task" ? optionalString(task.payload.assignee_id) : null,
      owner_id: task?.kind === "task" ? optionalString(task.payload.owner_id) : null,
      requested_by: optionalString(approval.payload.requested_by),
      actor_id: optionalString(approval.payload.actor_id),
      requested_at: optionalString(approval.payload.requested_at),
      decided_at: optionalString(approval.payload.decided_at ?? approval.payload.rejected_at),
      decided_by: optionalString(approval.payload.decided_by ?? approval.payload.rejected_by),
      reason: optionalString(approval.payload.reason),
      rejection_reason: optionalString(approval.payload.rejection_reason),
      action_kind: optionalString(action.kind),
      action_summary: optionalString(action.summary),
      controls: String(approval.payload.status ?? "") === "pending"
        ? ["operator.approval.approve", "operator.approval.deny"]
        : [],
      updated_at: approval.updatedAt
    };
  }
}

export class OperatorAttentionBoundary {
  readonly projector: OperatorAttentionProjector;

  constructor(
    readonly gateway: CoordinationGateway,
    executionQueue: ExecutionQueue
  ) {
    this.projector = new OperatorAttentionProjector(gateway.store, executionQueue);
  }

  decideApproval(input: {
    workspaceId: string;
    approvalId: string;
    actorId: string;
    decision: "approve" | "deny";
    reason?: string;
  }): OperatorApprovalDecisionReceipt {
    const workspaceId = requiredScope(input.workspaceId);
    const actorId = operatorActor(input.actorId);
    const approval = this.projector.requireWorkspaceApproval(workspaceId, input.approvalId);
    if (String(approval.payload.status ?? "") !== "pending") {
      throw new OperatorAttentionError(
        "APPROVAL_ALREADY_DECIDED",
        `Approval ${approval.id} is not pending`,
        409
      );
    }
    const taskId = optionalString(approval.payload.task_id);
    if (!taskId) {
      throw new OperatorAttentionError(
        "APPROVAL_TASK_MISSING",
        `Approval ${approval.id} has no Task reference`,
        409
      );
    }

    let approvalStatus: string;
    let taskStatus: string;
    try {
      if (input.decision === "approve") {
        const result = this.gateway.approve(approval.id, actorId);
        approvalStatus = String(result.approval.payload.status ?? "approved");
        taskStatus = String(result.task.payload.status ?? "assigned");
      } else if (input.decision === "deny") {
        const reason = typeof input.reason === "string" && input.reason.trim().length > 0
          ? input.reason.trim()
          : "Denied by operator";
        if (reason.length > 2048 || /[\0]/.test(reason)) {
          throw new OperatorAttentionError(
            "INVALID_OPERATOR_REASON",
            "Operator denial reason must be at most 2048 characters"
          );
        }
        const result = this.gateway.rejectApproval(approval.id, actorId, reason);
        approvalStatus = String(result.approval.payload.status ?? "denied");
        taskStatus = String(result.task.payload.status ?? "canceled");
      } else {
        throw new OperatorAttentionError(
          "INVALID_APPROVAL_DECISION",
          "Approval decision must be approve or deny"
        );
      }
    } catch (error) {
      if (error instanceof OperatorAttentionError) throw error;
      throw new OperatorAttentionError(
        "OPERATOR_APPROVAL_DECISION_REJECTED",
        error instanceof Error ? error.message : String(error),
        409
      );
    }

    return {
      schema_version: OPERATOR_ATTENTION_SCHEMA,
      provider: OPERATOR_ATTENTION_PROVIDER,
      control_only: true,
      canonical_owner: "ai-verse-multiple-bots",
      operator_ux_owns_truth: false,
      workspace_id: workspaceId,
      approval_id: approval.id,
      task_id: taskId,
      decision: input.decision,
      actor_id: actorId,
      approval_status: approvalStatus,
      task_status: taskStatus,
      event_cursor: this.gateway.store.latestEventSequence(),
      observed_at: new Date().toISOString()
    };
  }
}
