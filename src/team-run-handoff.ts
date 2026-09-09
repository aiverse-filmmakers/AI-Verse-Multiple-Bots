import { constraintsDigest, normalizeConstraints } from "./constraints.js";
import { createId } from "./id.js";
import { ExecutionQueue } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { BotRunner } from "./runner.js";
import { TeamRunCoordinator, type TeamRunStatus, type WorkerStatus } from "./team-runs.js";
import type { JsonObject, ProtocolKind, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

const HANDOFF_TOPOLOGIES = new Set(["handoff", "dynamic_squad", "hybrid"]);
const ACTIVE_RUN_STATES = new Set<TeamRunStatus>(["running", "synthesizing", "verifying"]);
const ACTIVE_TASK_STATES = new Set(["assigned", "waiting_approval"]);
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "canceled"]);
const TERMINAL_WORKER_STATES = new Set<WorkerStatus>(["completed", "failed", "canceled", "expired"]);

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function nowIso(): string {
  return new Date().toISOString();
}

export type TeamRunHandoffReturnPolicy = "stay_with_target" | "return_on_completion" | "return_on_block" | "explicit_only";
export type TeamRunHandoffPrincipalKind = "bot" | "worker";

export interface RequestTeamRunHandoffInput {
  runId: string;
  sourceOwnerId: string;
  targetOwnerId: string;
  taskId: string;
  reason: string;
  requiredConstraints?: string[];
  artifactRefs?: string[];
  returnPolicy?: TeamRunHandoffReturnPolicy;
}

export interface TeamRunHandoffMutation {
  handoff: StoredObject;
  task: StoredObject;
  run: StoredObject;
  sourcePrincipal: StoredObject;
  targetPrincipal: StoredObject;
}

/**
 * TeamRun-aware direct ownership transfer built on the canonical Handoff object.
 *
 * Protocol v1.1 names the compatibility field `target_bot_id`; TeamRun handoffs
 * also persist `target_owner_id` and `target_principal_kind` as the generic
 * principal identity. A temporary Worker is never registered or promoted as a Bot.
 */
export class TeamRunHandoff {
  constructor(
    readonly teams: TeamRunCoordinator,
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue,
    readonly runner: BotRunner
  ) {}

  request(input: RequestTeamRunHandoffInput): { handoff: StoredObject; eventSequence: number } {
    const run = this.requireActiveRun(input.runId);
    if (!HANDOFF_TOPOLOGIES.has(String(run.payload.topology))) {
      throw new Error(`Team Run ${run.id} topology ${String(run.payload.topology)} does not support direct handoff`);
    }
    const task = this.requireTask(input.taskId);
    this.assertTaskInRun(task, run);
    if (!ACTIVE_TASK_STATES.has(String(task.payload.status))) {
      throw new Error(`Task ${task.id} cannot be handed off from status ${String(task.payload.status)}`);
    }
    if (String(task.payload.owner_id) !== input.sourceOwnerId || String(task.payload.assignee_id) !== input.sourceOwnerId) {
      throw new Error(`Task ${task.id} is not currently owned and assigned to ${input.sourceOwnerId}`);
    }
    if (input.sourceOwnerId === input.targetOwnerId) throw new Error("Direct handoff target must differ from the current owner");

    const source = this.requireRunPrincipal(run, input.sourceOwnerId, "source", task);
    const target = this.requireRunPrincipal(run, input.targetOwnerId, "target", task);
    const leader = this.requireLeader(run);
    this.assertHandoffAuthority(leader, source, target, task);
    this.assertNoActiveHandoff(task.id, String(run.payload.workspace_id));

    const sourceLease = this.requireCapabilityLease(String(task.payload.lease_id), source.id, task.id, String(run.payload.workspace_id));
    const sourceEnvironment = this.optionalEnvironmentLease(task.payload.environment_lease_id);
    this.assertEnvironmentTransfer(sourceEnvironment, target, leader, task);

    const taskConstraints = normalizeConstraints(task.payload.required_constraints);
    const taskDigest = constraintsDigest(taskConstraints);
    if (typeof task.payload.constraints_digest === "string" && task.payload.constraints_digest !== taskDigest) {
      throw new Error(`Task ${task.id} immutable constraint digest is invalid`);
    }
    const requiredConstraints = normalizeConstraints([...taskConstraints, ...(input.requiredConstraints ?? [])]);
    this.validateArtifacts(input.artifactRefs ?? [], String(run.payload.workspace_id));

    const nextHandoffHop = this.nextHandoffHop(task, run);
    const ownerHistory = this.ownerHistory(task);
    if (ownerHistory.includes(target.id)) {
      throw new Error(`Direct handoff loop detected: ${target.id} already appears in Task ${task.id} ownership history`);
    }

    const handoffId = createId("handoff");
    const timestamp = nowIso();
    const handoffPayload = validateProtocolObject({
      schema_version: "1.0",
      id: handoffId,
      type: "handoff",
      source_owner_id: source.id,
      // Protocol v1.1 compatibility field. Generic identity is target_owner_id below.
      target_bot_id: target.id,
      target_owner_id: target.id,
      target_principal_kind: target.kind,
      source_principal_kind: source.kind,
      workspace_id: String(run.payload.workspace_id),
      task_id: task.id,
      work_item_id: task.id,
      run_id: run.id,
      root_objective_id: String(run.payload.root_objective_id),
      reason: input.reason,
      required_constraints: requiredConstraints,
      constraints_digest: constraintsDigest(requiredConstraints),
      artifact_refs: [...new Set(input.artifactRefs ?? [])],
      capability_lease_id: sourceLease.id,
      environment_lease_id: sourceEnvironment?.id ?? null,
      handoff_hop: nextHandoffHop,
      owner_history_before: ownerHistory,
      return_policy: input.returnPolicy ?? "return_on_completion",
      requested_at: timestamp,
      status: "requested"
    }, "handoff");

    const mutation = this.gateway.store.atomicMutation({
      preconditions: [
        { id: run.id, kind: "team_run", status: String(run.payload.status), updatedAt: run.updatedAt },
        { id: task.id, kind: "task", status: String(task.payload.status), ownerId: source.id },
        ...(source.kind === "worker" ? [{ id: source.id, kind: "worker" as const, status: String(source.payload.status) }] : [{ id: source.id, kind: "bot" as const, status: "active" }]),
        ...(target.kind === "worker" ? [{ id: target.id, kind: "worker" as const, status: String(target.payload.status) }] : [{ id: target.id, kind: "bot" as const, status: "active" }])
      ],
      objects: [{ kind: "handoff", payload: handoffPayload }],
      events: []
    });
    const handoff = mutation.objects[0];
    if (!handoff) throw new Error(`Direct Handoff ${handoffId} was not persisted`);
    const event = this.gateway.emit({
      type: "handoff.requested",
      actorId: source.id,
      workspaceId: String(run.payload.workspace_id),
      runId: run.id,
      taskId: task.id,
      correlationId: String(run.payload.root_objective_id),
      summary: `Team Run direct handoff requested from ${source.id} to ${target.id}`,
      attentionState: "handoff_waiting"
    });
    return { handoff, eventSequence: event.sequence };
  }

  accept(handoffId: string, actorId: string): TeamRunHandoffMutation {
    const handoff = this.requireHandoff(handoffId);
    if (handoff.payload.status !== "requested") throw new Error(`Handoff ${handoffId} is not requested`);
    const targetId = String(handoff.payload.target_owner_id ?? handoff.payload.target_bot_id ?? "");
    if (actorId !== targetId) throw new Error(`Only target principal ${targetId} can accept Handoff ${handoffId}`);

    const run = this.requireActiveRun(String(handoff.payload.run_id));
    const task = this.requireTask(String(handoff.payload.task_id));
    this.assertTaskInRun(task, run);
    const sourceId = String(handoff.payload.source_owner_id);
    if (String(task.payload.owner_id) !== sourceId || String(task.payload.assignee_id) !== sourceId) {
      throw new Error(`Task ${task.id} ownership changed before Handoff ${handoffId} acceptance`);
    }
    if (!ACTIVE_TASK_STATES.has(String(task.payload.status))) {
      throw new Error(`Task ${task.id} cannot accept Handoff from status ${String(task.payload.status)}`);
    }

    const source = this.requireRunPrincipal(run, sourceId, "source", task);
    const target = this.requireRunPrincipal(run, targetId, "target", task);
    const leader = this.requireLeader(run);
    this.assertHandoffAuthority(leader, source, target, task);

    const handoffConstraints = normalizeConstraints(handoff.payload.required_constraints);
    if (String(handoff.payload.constraints_digest ?? "") !== constraintsDigest(handoffConstraints)) {
      throw new Error(`Handoff ${handoffId} immutable constraint digest is invalid`);
    }
    const taskConstraints = normalizeConstraints(task.payload.required_constraints);
    if (typeof task.payload.constraints_digest === "string" && task.payload.constraints_digest !== constraintsDigest(taskConstraints)) {
      throw new Error(`Task ${task.id} immutable constraint digest is invalid`);
    }
    for (const constraint of taskConstraints) {
      if (!handoffConstraints.includes(constraint)) throw new Error(`Handoff ${handoffId} dropped immutable Task constraint: ${constraint}`);
    }

    const sourceLease = this.requireCapabilityLease(String(task.payload.lease_id), source.id, task.id, String(run.payload.workspace_id));
    const sourceEnvironment = this.optionalEnvironmentLease(task.payload.environment_lease_id);
    this.assertEnvironmentTransfer(sourceEnvironment, target, leader, task);

    if (target.kind === "worker") {
      const targetStatus = String(target.payload.status) as WorkerStatus;
      if (targetStatus !== "created") throw new Error(`Target Worker ${target.id} must be created and unbound before direct handoff, not ${targetStatus}`);
      if (typeof target.payload.task_id === "string" && target.payload.task_id.length > 0) {
        throw new Error(`Target Worker ${target.id} is already bound to Task ${String(target.payload.task_id)}`);
      }
    }

    let approval: StoredObject | null = null;
    if (task.payload.status === "waiting_approval") {
      const approvalId = typeof task.payload.approval_id === "string" ? task.payload.approval_id : null;
      if (!approvalId) throw new Error(`Task ${task.id} is waiting for approval but has no approval_id`);
      approval = this.gateway.store.getObject(approvalId);
      if (!approval || approval.kind !== "approval" || approval.payload.status !== "pending") {
        throw new Error(`Approval ${String(approvalId)} is not pending`);
      }
      const unexpected = this.queue.getByItem(task.id);
      if (unexpected && new Set(["queued", "claimed", "running"]).has(unexpected.state)) {
        throw new Error(`Approval-gated Task ${task.id} unexpectedly has execution state ${unexpected.state}`);
      }
    }

    let queueRetarget: { itemId: string; fromTargetId: string; toTargetId: string; required: boolean } | undefined;
    if (task.payload.status === "assigned") {
      const execution = this.queue.getByItem(task.id);
      if (!execution) throw new Error(`Assigned Task ${task.id} has no execution queue item`);
      if (execution.state !== "queued") {
        throw new Error(`Cannot accept Handoff ${handoffId} while Task ${task.id} execution is ${execution.state}`);
      }
      if (execution.targetId !== source.id) {
        throw new Error(`Execution queue for ${task.id} targets ${execution.targetId}, not source ${source.id}`);
      }
      queueRetarget = { itemId: task.id, fromTargetId: source.id, toTargetId: target.id, required: true };
    }

    const timestamp = nowIso();
    const newLeaseId = createId("lease");
    const newEnvironmentLeaseId = sourceEnvironment ? createId("envlease") : null;
    const objects: Array<{ kind: ProtocolKind; payload: JsonObject }> = [
      {
        kind: "handoff",
        payload: validateProtocolObject({
          ...handoff.payload,
          target_owner_id: target.id,
          target_bot_id: target.id,
          target_principal_kind: target.kind,
          status: "accepted",
          accepted_at: timestamp,
          accepted_by: actorId,
          capability_lease_id: newLeaseId,
          environment_lease_id: newEnvironmentLeaseId
        }, "handoff")
      },
      {
        kind: "capability_lease",
        payload: validateProtocolObject({
          ...sourceLease.payload,
          revoked_at: timestamp,
          revoked_reason: `Team Run Handoff ${handoffId} accepted by ${target.id}`,
          superseded_by: newLeaseId
        }, "capability_lease")
      },
      {
        kind: "capability_lease",
        payload: validateProtocolObject({
          ...sourceLease.payload,
          id: newLeaseId,
          issued_to: target.id,
          transferred_from: sourceLease.id,
          transferred_at: timestamp,
          revoked_at: null,
          revoked_reason: null,
          superseded_by: null
        }, "capability_lease")
      }
    ];

    if (sourceEnvironment && newEnvironmentLeaseId) {
      objects.push({
        kind: "environment_lease",
        payload: validateProtocolObject({
          ...sourceEnvironment.payload,
          revoked_at: timestamp,
          revoked_reason: `Team Run Handoff ${handoffId} accepted by ${target.id}`,
          superseded_by: newEnvironmentLeaseId
        }, "environment_lease")
      });
      objects.push({
        kind: "environment_lease",
        payload: validateProtocolObject({
          ...sourceEnvironment.payload,
          id: newEnvironmentLeaseId,
          issued_to: target.id,
          transferred_from: sourceEnvironment.id,
          transferred_at: timestamp,
          revoked_at: null,
          revoked_reason: null,
          superseded_by: null
        }, "environment_lease")
      });
    }

    const ownerHistory = [...this.ownerHistory(task), target.id];
    const updatedTask = validateProtocolObject({
      ...task.payload,
      owner_id: target.id,
      assignee_id: target.id,
      required_constraints: handoffConstraints,
      constraints_digest: String(handoff.payload.constraints_digest),
      lease_id: newLeaseId,
      environment_lease_id: newEnvironmentLeaseId,
      handoff_id: handoff.id,
      handed_off_from: source.id,
      handed_off_at: timestamp,
      handoff_hop: Number(handoff.payload.handoff_hop ?? 1),
      handoff_owner_history: ownerHistory
    }, "task");
    objects.push({ kind: "task", payload: updatedTask });

    let sourcePayload = source.payload;
    if (source.kind === "worker") {
      sourcePayload = validateProtocolObject({
        ...source.payload,
        status: "canceled",
        terminal_at: timestamp,
        status_reason: `Task ownership transferred to ${target.id} by Handoff ${handoffId}`,
        handoff_transferred_to: target.id,
        updated_at: timestamp
      }, "worker");
      objects.push({ kind: "worker", payload: sourcePayload });
    }

    let targetPayload = target.payload;
    if (target.kind === "worker") {
      targetPayload = validateProtocolObject({
        ...target.payload,
        task_id: task.id,
        capability_lease_id: newLeaseId,
        environment_lease_id: newEnvironmentLeaseId,
        status: task.payload.status === "waiting_approval" ? "waiting" : "ready",
        handoff_received_from: source.id,
        updated_at: timestamp
      }, "worker");
      objects.push({ kind: "worker", payload: targetPayload });
    }

    if (approval) {
      objects.push({
        kind: "approval",
        payload: validateProtocolObject({
          ...approval.payload,
          actor_id: target.id,
          retargeted_at: timestamp,
          retargeted_by_handoff: handoff.id
        }, "approval")
      });
    }

    const updatedRunPayload = validateProtocolObject({
      ...run.payload,
      participant_ids: [...new Set([...stringArray(run.payload.participant_ids), target.id])],
      updated_at: timestamp
    }, "team_run");
    objects.push({ kind: "team_run", payload: updatedRunPayload });

    const preconditions = [
      { id: handoff.id, kind: "handoff" as const, status: "requested" },
      { id: task.id, kind: "task" as const, status: String(task.payload.status), ownerId: source.id },
      { id: run.id, kind: "team_run" as const, status: String(run.payload.status), updatedAt: run.updatedAt },
      ...(source.kind === "worker" ? [{ id: source.id, kind: "worker" as const, status: String(source.payload.status) }] : [{ id: source.id, kind: "bot" as const, status: "active" }]),
      ...(target.kind === "worker" ? [{ id: target.id, kind: "worker" as const, status: String(target.payload.status) }] : [{ id: target.id, kind: "bot" as const, status: "active" }]),
      ...(approval ? [{ id: approval.id, kind: "approval" as const, status: "pending" }] : [])
    ];

    const mutation = this.gateway.store.atomicMutation({
      preconditions,
      objects,
      events: [],
      queueRetarget
    });

    this.gateway.emit({
      type: "handoff.accepted",
      actorId,
      workspaceId: String(run.payload.workspace_id),
      runId: run.id,
      taskId: task.id,
      correlationId: String(run.payload.root_objective_id),
      summary: `${target.id} accepted Team Run Handoff ${handoff.id}`
    });
    this.gateway.emit({
      type: "ownership.changed",
      actorId,
      workspaceId: String(run.payload.workspace_id),
      runId: run.id,
      taskId: task.id,
      correlationId: String(run.payload.root_objective_id),
      summary: `${target.id} now owns ${task.id}; previous owner ${source.id}`
    });
    this.gateway.emit({
      type: "capability_lease.reissued",
      actorId,
      workspaceId: String(run.payload.workspace_id),
      runId: run.id,
      taskId: task.id,
      correlationId: String(run.payload.root_objective_id),
      summary: `Reissued Team Run Task authority from ${source.id} to ${target.id}`
    });
    if (sourceEnvironment) {
      this.gateway.emit({
        type: "environment_lease.reissued",
        actorId,
        workspaceId: String(run.payload.workspace_id),
        runId: run.id,
        taskId: task.id,
        correlationId: String(run.payload.root_objective_id),
        summary: `Transferred shared Team Run execution environment to ${target.id}`
      });
    }
    if (source.kind === "worker") {
      this.gateway.emit({
        type: "worker.status_changed",
        actorId,
        workspaceId: String(run.payload.workspace_id),
        runId: run.id,
        taskId: task.id,
        correlationId: String(run.payload.root_objective_id),
        summary: `${source.id} ended temporary participation after ownership transfer to ${target.id}`
      });
    }
    if (target.kind === "worker") {
      this.gateway.emit({
        type: "worker.task_bound",
        actorId,
        workspaceId: String(run.payload.workspace_id),
        runId: run.id,
        taskId: task.id,
        correlationId: String(run.payload.root_objective_id),
        summary: `Bound target Worker ${target.id} to handed-off Task ${task.id}`
      });
    }
    if (approval) {
      this.gateway.emit({
        type: "approval.retargeted",
        actorId,
        workspaceId: String(run.payload.workspace_id),
        runId: run.id,
        taskId: task.id,
        correlationId: String(run.payload.root_objective_id),
        summary: `Approval actor retargeted to ${target.id}`,
        attentionState: "needs_approval"
      });
    } else {
      this.gateway.emit({
        type: "task.assigned",
        actorId,
        workspaceId: String(run.payload.workspace_id),
        runId: run.id,
        taskId: task.id,
        correlationId: String(run.payload.root_objective_id),
        summary: `Handed-off Team Run Task ${task.id} assigned to ${target.id}`
      });
    }

    return {
      handoff: this.requireHandoff(handoff.id),
      task: this.requireTask(task.id),
      run: this.requireActiveRun(run.id),
      sourcePrincipal: source.kind === "worker" ? this.requireWorker(source.id) : this.requireBot(source.id),
      targetPrincipal: target.kind === "worker" ? this.requireWorker(target.id) : this.requireBot(target.id)
    };
  }

  reject(handoffId: string, actorId: string, reason = "Direct handoff rejected"): StoredObject {
    const handoff = this.requireHandoff(handoffId);
    if (handoff.payload.status !== "requested") throw new Error(`Handoff ${handoffId} is not requested`);
    const targetId = String(handoff.payload.target_owner_id ?? handoff.payload.target_bot_id ?? "");
    if (actorId !== targetId && !actorId.startsWith("operator_")) {
      throw new Error(`Only target principal ${targetId} or an operator can reject Handoff ${handoffId}`);
    }
    const rejected = validateProtocolObject({
      ...handoff.payload,
      status: "rejected",
      rejected_by: actorId,
      rejected_at: nowIso(),
      rejection_reason: reason
    }, "handoff");
    const mutation = this.gateway.store.atomicMutation({
      preconditions: [{ id: handoff.id, kind: "handoff", status: "requested" }],
      objects: [{ kind: "handoff", payload: rejected }],
      events: []
    });
    this.gateway.emit({
      type: "handoff.rejected",
      actorId,
      workspaceId: handoff.workspaceId,
      runId: typeof handoff.payload.run_id === "string" ? handoff.payload.run_id : null,
      taskId: String(handoff.payload.task_id),
      correlationId: String(handoff.payload.root_objective_id),
      summary: reason,
      attentionState: "unread_result"
    });
    const stored = mutation.objects[0];
    if (!stored) throw new Error(`Rejected Handoff ${handoffId} was not persisted`);
    return stored;
  }

  async cancelRun(runId: string, actorId: string, reason = "Team Run canceled during direct handoff"): Promise<StoredObject> {
    const run = this.teams.getRun(runId);
    if (!run) throw new Error(`Team Run ${runId} not found`);
    const leaderId = String(run.payload.leader_id ?? "");
    if (actorId !== leaderId && !actorId.startsWith("operator_")) {
      throw new Error(`Only Team Run leader ${leaderId} or an operator can cancel ${runId}`);
    }
    const cancellationActor = actorId.startsWith("operator_") ? actorId : leaderId;
    for (const task of this.gateway.store.listObjects("task", run.workspaceId ?? undefined)) {
      if (task.payload.run_id !== runId || TERMINAL_TASK_STATES.has(String(task.payload.status))) continue;
      await this.runner.cancelTask(task.id, cancellationActor, reason);
    }
    const latest = this.teams.getRun(runId);
    if (!latest) throw new Error(`Team Run ${runId} disappeared during cancellation`);
    if (new Set(["completed", "failed", "canceled", "budget_exhausted"]).has(String(latest.payload.status))) return latest;
    return this.teams.transitionRun(runId, "canceled", leaderId, reason).run;
  }

  private requireActiveRun(runId: string): StoredObject {
    const run = this.teams.getRun(runId);
    if (!run) throw new Error(`Team Run ${runId} not found`);
    const status = String(run.payload.status) as TeamRunStatus;
    if (!ACTIVE_RUN_STATES.has(status)) throw new Error(`Team Run ${runId} is not active for direct handoff from status ${status}`);
    return run;
  }

  private requireTask(taskId: string): StoredObject {
    const task = this.gateway.store.getObject(taskId);
    if (!task || task.kind !== "task") throw new Error(`Task ${taskId} not found`);
    return task;
  }

  private requireHandoff(handoffId: string): StoredObject {
    const handoff = this.gateway.store.getObject(handoffId);
    if (!handoff || handoff.kind !== "handoff") throw new Error(`Handoff ${handoffId} not found`);
    return handoff;
  }

  private requireWorker(workerId: string): StoredObject {
    const worker = this.gateway.store.getObject(workerId);
    if (!worker || worker.kind !== "worker") throw new Error(`Worker ${workerId} not found`);
    return worker;
  }

  private requireBot(botId: string): StoredObject {
    const bot = this.gateway.store.getObject(botId);
    if (!bot || bot.kind !== "bot") throw new Error(`Bot ${botId} not found`);
    return bot;
  }

  private requireLeader(run: StoredObject): StoredObject {
    const leaderId = String(run.payload.leader_id ?? "");
    const leader = this.requireBot(leaderId);
    if (leader.payload.status !== "active" || leader.workspaceId !== run.workspaceId) {
      throw new Error(`Team Run ${run.id} has no active same-workspace durable leader`);
    }
    return leader;
  }

  private assertTaskInRun(task: StoredObject, run: StoredObject): void {
    if (String(task.payload.run_id ?? "") !== run.id) throw new Error(`Task ${task.id} is not scoped to Team Run ${run.id}`);
    if (task.workspaceId !== run.workspaceId) throw new Error(`Task ${task.id} is outside Team Run workspace ${String(run.workspaceId)}`);
    if (String(task.payload.root_objective_id) !== String(run.payload.root_objective_id)) {
      throw new Error(`Task ${task.id} does not preserve Team Run root objective ${String(run.payload.root_objective_id)}`);
    }
  }

  private requireRunPrincipal(run: StoredObject, principalId: string, role: "source" | "target", task: StoredObject): StoredObject & { kind: TeamRunHandoffPrincipalKind } {
    const principal = this.gateway.store.getObject(principalId);
    if (!principal || (principal.kind !== "bot" && principal.kind !== "worker")) {
      throw new Error(`${role} principal ${principalId} must be a durable Bot or temporary Worker`);
    }
    if (principal.workspaceId !== run.workspaceId) throw new Error(`${role} principal ${principalId} is outside Team Run workspace`);
    if (principal.kind === "bot") {
      if (principal.payload.status !== "active") throw new Error(`${role} Bot ${principalId} is not active`);
      if (role === "source") {
        const participants = stringArray(run.payload.participant_ids);
        if (principal.id !== run.payload.leader_id && !participants.includes(principal.id)) {
          throw new Error(`Source Bot ${principal.id} is not a Team Run participant`);
        }
      }
      return principal as StoredObject & { kind: "bot" };
    }

    if (String(principal.payload.run_id) !== run.id) throw new Error(`${role} Worker ${principalId} belongs to another Team Run`);
    const status = String(principal.payload.status) as WorkerStatus;
    if (TERMINAL_WORKER_STATES.has(status)) throw new Error(`${role} Worker ${principalId} is terminal (${status})`);
    if (role === "source") {
      if (String(principal.payload.task_id ?? "") !== task.id) throw new Error(`Source Worker ${principalId} is not bound to Task ${task.id}`);
      if (!new Set<WorkerStatus>(["ready", "waiting"]).has(status)) throw new Error(`Source Worker ${principalId} cannot hand off from status ${status}`);
    }
    return principal as StoredObject & { kind: "worker" };
  }

  private assertHandoffAuthority(leader: StoredObject, source: StoredObject, target: StoredObject, task: StoredObject): void {
    const leaderPermissions = asObject(leader.payload.permissions);
    if (leaderPermissions.can_handoff === false) throw new Error(`Team Run leader ${leader.id} is not allowed to hand off work`);
    if (source.kind === "bot" && asObject(source.payload.permissions).can_handoff === false) {
      throw new Error(`Source Bot ${source.id} is not allowed to hand off work`);
    }

    const sourceLease = this.requireCapabilityLease(String(task.payload.lease_id), source.id, task.id, String(task.payload.workspace_id));
    const tools = stringArray(sourceLease.payload.tools);
    const connections = stringArray(sourceLease.payload.connections);
    const authorityPrincipal = target.kind === "worker" ? leader : target;
    const permissions = asObject(authorityPrincipal.payload.permissions);
    this.assertGrantSubset(tools, permissions.allowed_tools, "tool", authorityPrincipal.id);
    this.assertGrantSubset(connections, permissions.allowed_connections, "connection", authorityPrincipal.id);

    if (target.kind === "bot") {
      const leaderPeers = Array.isArray(leaderPermissions.allowed_peers) ? stringArray(leaderPermissions.allowed_peers) : null;
      if (leaderPeers && !leaderPeers.includes("*") && !leaderPeers.includes(target.id)) {
        throw new Error(`Team Run leader ${leader.id} is not allowed to route work to ${target.id}`);
      }
      if (source.kind === "bot") {
        const sourcePeers = Array.isArray(asObject(source.payload.permissions).allowed_peers)
          ? stringArray(asObject(source.payload.permissions).allowed_peers)
          : null;
        if (sourcePeers && !sourcePeers.includes("*") && !sourcePeers.includes(target.id)) {
          throw new Error(`Source Bot ${source.id} is not allowed to hand off to ${target.id}`);
        }
      }
    }
  }

  private assertGrantSubset(requested: string[], allowedValue: unknown, label: string, principalId: string): void {
    if (!Array.isArray(allowedValue)) return;
    const allowed = stringArray(allowedValue);
    if (allowed.includes("*")) return;
    for (const value of requested) {
      if (!allowed.includes(value)) throw new Error(`${principalId} is not granted ${label} ${value} required by handed-off Task`);
    }
  }

  private requireCapabilityLease(leaseId: string, ownerId: string, taskId: string, workspaceId: string): StoredObject {
    const lease = this.gateway.store.getObject(leaseId);
    if (!lease || lease.kind !== "capability_lease") throw new Error(`Capability lease ${leaseId} not found`);
    if (String(lease.payload.issued_to) !== ownerId) throw new Error(`Capability lease ${leaseId} is not issued to ${ownerId}`);
    if (String(lease.payload.task_id) !== taskId) throw new Error(`Capability lease ${leaseId} is not scoped to Task ${taskId}`);
    if (lease.workspaceId !== workspaceId) throw new Error(`Capability lease ${leaseId} is outside workspace ${workspaceId}`);
    const expiry = Date.parse(String(lease.payload.expires_at));
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error(`Capability lease ${leaseId} is expired`);
    return lease;
  }

  private optionalEnvironmentLease(value: unknown): StoredObject | null {
    if (typeof value !== "string" || value.length === 0) return null;
    const lease = this.gateway.store.getObject(value);
    if (!lease || lease.kind !== "environment_lease") throw new Error(`Environment lease ${value} not found`);
    const expiry = Date.parse(String(lease.payload.expires_at));
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error(`Environment lease ${value} is expired`);
    return lease;
  }

  private assertEnvironmentTransfer(environment: StoredObject | null, target: StoredObject, leader: StoredObject, task: StoredObject): void {
    if (!environment) return;
    if (String(environment.payload.issued_to) !== String(task.payload.owner_id)) {
      throw new Error(`Environment lease ${environment.id} is not issued to current Task owner ${String(task.payload.owner_id)}`);
    }
    if (environment.workspaceId !== task.workspaceId) throw new Error(`Environment lease ${environment.id} is outside Task workspace`);
    if (typeof environment.payload.task_id === "string" && environment.payload.task_id !== task.id) {
      throw new Error(`Environment lease ${environment.id} is not scoped to Task ${task.id}`);
    }
    const policy = String(environment.payload.environment_policy);
    if (policy !== "shared_workspace") {
      throw new Error(`Environment ${environment.id} uses ${policy} and requires adapter-specific transfer`);
    }
    const execution = target.kind === "worker"
      ? { ...asObject(leader.payload.execution), ...asObject(target.payload.execution) }
      : asObject(target.payload.execution);
    if (typeof execution.environment_policy === "string" && execution.environment_policy !== "shared_workspace") {
      throw new Error(`Target ${target.id} uses environment policy ${String(execution.environment_policy)}, incompatible with shared_workspace transfer`);
    }
  }

  private nextHandoffHop(task: StoredObject, run: StoredObject): number {
    const current = Math.max(0, Number(task.payload.handoff_hop ?? 0));
    const next = current + 1;
    const delegationHop = Math.max(0, Number(task.payload.hop ?? 0));
    const taskLimit = Number(task.payload.max_hops ?? 6);
    const runBudget = asObject(run.payload.budget);
    const runLimit = typeof runBudget.max_hops === "number" ? runBudget.max_hops : taskLimit;
    const limit = Math.min(taskLimit, Number(runLimit));
    if (!Number.isFinite(limit) || delegationHop + next > limit) {
      throw new Error(`Team Run Handoff hop ${delegationHop + next} exceeds Task/Run max_hops ${limit}`);
    }
    return next;
  }

  private ownerHistory(task: StoredObject): string[] {
    const history = stringArray(task.payload.handoff_owner_history);
    const source = String(task.payload.owner_id ?? "");
    if (history.length === 0) return source ? [source] : [];
    return history.includes(source) ? history : [...history, source];
  }

  private assertNoActiveHandoff(taskId: string, workspaceId: string): void {
    const active = this.gateway.store.listObjects("handoff", workspaceId).find((candidate) =>
      String(candidate.payload.task_id ?? candidate.payload.work_item_id ?? "") === taskId
      && new Set(["requested", "accepted"]).has(String(candidate.payload.status))
    );
    if (active) throw new Error(`Task ${taskId} already has active Handoff ${active.id}`);
  }

  private validateArtifacts(refs: string[], workspaceId: string): void {
    for (const ref of [...new Set(refs)]) {
      const artifact = this.gateway.store.getObject(ref);
      if (!artifact || artifact.kind !== "artifact") throw new Error(`Handoff Artifact ${ref} not found`);
      if (artifact.workspaceId !== workspaceId) throw new Error(`Handoff Artifact ${ref} is outside workspace ${workspaceId}`);
    }
  }
}
