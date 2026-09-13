import type { CoordinationGateway } from "./gateway.js";
import {
  DashboardProjectionError,
  DashboardProjectionProjector
} from "./dashboard-projection.js";
import type { BotRunner } from "./runner.js";
import type { ExecutionSupervisor } from "./supervisor.js";
import type { TeamRunControl } from "./team-run-control.js";
import type { JsonObject } from "./types.js";

export const DASHBOARD_CONTROL_SCHEMA = "1.0";
export const DASHBOARD_CONTROL_PROVIDER = "ai-verse-multiple-bots/dashboard-control-v1";

export type DashboardControlAction =
  | "bot.activate"
  | "bot.disable"
  | "bot.archive"
  | "approval.approve"
  | "approval.deny"
  | "task.cancel"
  | "task.retry"
  | "team_run.cancel";

export interface DashboardControlInput {
  action: DashboardControlAction;
  workspaceId: string;
  targetId: string;
  actorId: string;
  reason?: string;
}

export interface DashboardControlReceipt extends JsonObject {
  schema_version: typeof DASHBOARD_CONTROL_SCHEMA;
  provider: typeof DASHBOARD_CONTROL_PROVIDER;
  control_only: true;
  canonical_owner: "ai-verse-multiple-bots";
  dashboard_owns_truth: false;
  action: DashboardControlAction;
  workspace_id: string;
  target_id: string;
  actor_id: string;
  resulting_status: string | null;
  event_cursor: number;
  observed_at: string;
}

export class DashboardControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DashboardControlError";
  }
}

function operatorActor(value: string): string {
  const actorId = value.trim();
  if (!actorId.startsWith("operator_") || actorId.length > 256 || /[\0\r\n]/.test(actorId)) {
    throw new DashboardControlError(
      "DASHBOARD_OPERATOR_REQUIRED",
      "Dashboard controls require an operator_* actor id"
    );
  }
  return actorId;
}

function targetId(value: string): string {
  const result = value.trim();
  if (!result || result.length > 256 || /[\0\r\n]/.test(result)) {
    throw new DashboardControlError(
      "INVALID_DASHBOARD_TARGET",
      "Dashboard control targetId must be a non-empty id of at most 256 characters"
    );
  }
  return result;
}

function reasonText(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const result = value.trim();
  if (!result || result.length > 2048 || /[\0]/.test(result)) {
    throw new DashboardControlError(
      "INVALID_DASHBOARD_REASON",
      "Dashboard control reason must be a non-empty string of at most 2048 characters"
    );
  }
  return result;
}

export class DashboardControlBoundary {
  constructor(
    readonly projection: DashboardProjectionProjector,
    readonly gateway: CoordinationGateway,
    readonly runner: BotRunner,
    readonly supervisor: ExecutionSupervisor,
    readonly teamRuns: TeamRunControl
  ) {}

  async execute(input: DashboardControlInput): Promise<DashboardControlReceipt> {
    const workspaceId = input.workspaceId.trim();
    const id = targetId(input.targetId);
    const actorId = operatorActor(input.actorId);
    let resultingStatus: string | null = null;

    try {
      switch (input.action) {
        case "bot.activate": {
          this.projection.requireWorkspaceObject(workspaceId, id, ["bot"]);
          const result = this.gateway.transitionBot(id, "active", actorId);
          resultingStatus = String(result.payload.status ?? "active");
          break;
        }
        case "bot.disable": {
          this.projection.requireWorkspaceObject(workspaceId, id, ["bot"]);
          const result = this.gateway.transitionBot(id, "disabled", actorId);
          resultingStatus = String(result.payload.status ?? "disabled");
          break;
        }
        case "bot.archive": {
          this.projection.requireWorkspaceObject(workspaceId, id, ["bot"]);
          const result = this.gateway.transitionBot(id, "archived", actorId);
          resultingStatus = String(result.payload.status ?? "archived");
          break;
        }
        case "approval.approve": {
          this.projection.requireWorkspaceObject(workspaceId, id, ["approval"]);
          const result = this.gateway.approve(id, actorId);
          resultingStatus = String(result.approval.payload.status ?? "approved");
          break;
        }
        case "approval.deny": {
          this.projection.requireWorkspaceObject(workspaceId, id, ["approval"]);
          const result = this.gateway.rejectApproval(
            id,
            actorId,
            reasonText(input.reason, "Denied by operator through Dashboard")
          );
          resultingStatus = String(result.approval.payload.status ?? "denied");
          break;
        }
        case "task.cancel": {
          this.projection.requireWorkspaceObject(workspaceId, id, ["task"]);
          await this.runner.cancelTask(
            id,
            actorId,
            reasonText(input.reason, "Canceled by operator through Dashboard")
          );
          const task = this.projection.requireWorkspaceObject(workspaceId, id, ["task"]);
          resultingStatus = String(task.payload.status ?? "canceled");
          break;
        }
        case "task.retry": {
          this.projection.requireWorkspaceObject(workspaceId, id, ["task"]);
          const execution = this.supervisor.retryDeadLetter(
            id,
            actorId,
            reasonText(input.reason, "Operator authorized retry through Dashboard")
          );
          resultingStatus = String(execution.state ?? "queued");
          break;
        }
        case "team_run.cancel": {
          this.projection.requireWorkspaceObject(workspaceId, id, ["team_run"]);
          const result = await this.teamRuns.cancelRun(
            id,
            actorId,
            reasonText(input.reason, "Team Run canceled by operator through Dashboard")
          );
          resultingStatus = String(result.run.payload.status ?? "canceled");
          break;
        }
        default:
          throw new DashboardControlError(
            "DASHBOARD_CONTROL_UNSUPPORTED",
            `Unsupported Dashboard control action ${String(input.action)}`
          );
      }
    } catch (error) {
      if (error instanceof DashboardControlError || error instanceof DashboardProjectionError) throw error;
      throw new DashboardControlError(
        "DASHBOARD_CONTROL_REJECTED",
        error instanceof Error ? error.message : String(error)
      );
    }

    return {
      schema_version: DASHBOARD_CONTROL_SCHEMA,
      provider: DASHBOARD_CONTROL_PROVIDER,
      control_only: true,
      canonical_owner: "ai-verse-multiple-bots",
      dashboard_owns_truth: false,
      action: input.action,
      workspace_id: workspaceId,
      target_id: id,
      actor_id: actorId,
      resulting_status: resultingStatus,
      event_cursor: this.gateway.store.latestEventSequence(),
      observed_at: new Date().toISOString()
    };
  }
}
