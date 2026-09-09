import { createHash } from "node:crypto";
import { normalizeBudget, type BudgetEnvelope } from "./budget.js";
import { constraintsDigest, normalizeConstraints } from "./constraints.js";
import { CoordinationStore } from "./store.js";
import type { TeamRunTopology } from "./team-runs.js";
import type { AppendedEvent, CoordinationEvent, JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

export type DecisionLevel = "low" | "medium" | "high";
export type VerificationNeed = "none" | "recommended" | "required";
export type CollaborationMode = "single" | "squad";
export type CollaborationExecutionStatus = "ready" | "degraded" | "blocked";

export interface CollaborationWorkSignals extends JsonObject {
  independentWorkstreams?: number;
  specialistRoles?: number;
  sequentialStages?: number;
  uncertainty?: DecisionLevel;
  verificationNeed?: VerificationNeed;
  parallelSafe?: boolean;
  discussionNeeded?: boolean;
  discussionParticipants?: number;
  discussionRounds?: number;
  ownershipTransferNeeded?: boolean;
  costSensitivity?: DecisionLevel;
  latencySensitivity?: DecisionLevel;
}

export interface CollaborationDecisionInput {
  leaderId: string;
  workspaceId: string;
  rootObjectiveId: string;
  objective: string;
  work?: CollaborationWorkSignals;
  requiredConstraints?: string[];
  requiredTools?: string[];
  requiredConnections?: string[];
  approvalRequired?: boolean;
  budget?: BudgetEnvelope;
}

export interface CollaborationReason extends JsonObject {
  code: string;
  summary: string;
}

export interface CollaborationDecisionView {
  artifact: StoredObject;
  mode: CollaborationMode;
  topology: TeamRunTopology;
  suggestedWorkerCount: number;
  executionStatus: CollaborationExecutionStatus;
  reasons: CollaborationReason[];
  selectedRunId: string | null;
}

export interface CollaborationOpenResult extends CollaborationDecisionView {
  run: StoredObject | null;
}

interface NormalizedSignals extends JsonObject {
  independent_workstreams: number;
  specialist_roles: number;
  sequential_stages: number;
  uncertainty: DecisionLevel;
  verification_need: VerificationNeed;
  parallel_safe: boolean;
  discussion_needed: boolean;
  discussion_participants: number;
  discussion_rounds: number;
  ownership_transfer_needed: boolean;
  cost_sensitivity: DecisionLevel;
  latency_sensitivity: DecisionLevel;
}

interface Selection {
  mode: CollaborationMode;
  topology: TeamRunTopology;
  workerCount: number;
  executionStatus: CollaborationExecutionStatus;
  reasons: CollaborationReason[];
}

const POLICY_VERSION = "team-run-decision-v1";
const DEFAULT_WORKER_CEILING = 4;
const POLICY_WORKER_CEILING = 8;
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "canceled", "budget_exhausted"]);

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))].sort();
}

function nonNegativeInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  const result = nonNegativeInteger(value, fallback, label);
  if (result < 1) throw new Error(`${label} must be at least 1`);
  return result;
}

function level(value: unknown, fallback: DecisionLevel, label: string): DecisionLevel {
  if (value === undefined || value === null) return fallback;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`${label} must be low, medium, or high`);
}

function verification(value: unknown): VerificationNeed {
  if (value === undefined || value === null) return "none";
  if (value === "none" || value === "recommended" || value === "required") return value;
  throw new Error("verificationNeed must be none, recommended, or required");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function reason(code: string, summary: string): CollaborationReason {
  return { code, summary };
}

function numberLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Host-neutral, inspectable policy for deciding whether one durable Bot is
 * sufficient or whether a bounded Team Run is justified.
 *
 * The policy deliberately consumes declared work characteristics rather than
 * model chain-of-thought. Its durable output is a deterministic Artifact with
 * bounded reason codes that can be audited by any host.
 */
export class TeamRunDecisionPolicy {
  constructor(readonly store: CoordinationStore) {}

  decide(input: CollaborationDecisionInput): CollaborationDecisionView {
    const leader = this.requireLeader(input.leaderId, input.workspaceId);
    if (!input.rootObjectiveId.trim()) throw new Error("rootObjectiveId cannot be empty");
    if (!input.objective.trim()) throw new Error("objective cannot be empty");

    const signals = this.normalizeSignals(input.work);
    const constraints = normalizeConstraints(input.requiredConstraints ?? []);
    const requiredTools = uniqueStrings(input.requiredTools);
    const requiredConnections = uniqueStrings(input.requiredConnections);
    const budget = normalizeBudget(input.budget);
    const existingRun = this.existingObjectiveRun(input.workspaceId, input.rootObjectiveId, input.leaderId);
    const authority = this.authorityState(leader, requiredTools, requiredConnections, budget);

    const normalizedInput = {
      policy_version: POLICY_VERSION,
      leader_id: input.leaderId,
      workspace_id: input.workspaceId,
      root_objective_id: input.rootObjectiveId,
      objective: input.objective.trim(),
      work: signals,
      required_constraints: constraints,
      required_tools: requiredTools,
      required_connections: requiredConnections,
      approval_required: input.approvalRequired === true,
      budget
    };
    const inputDigest = digest(normalizedInput);
    const artifactId = `artifact_collaboration_decision_${inputDigest.slice(0, 32)}`;

    const existingDecision = this.store.getObject(artifactId);
    if (existingDecision) return this.view(existingDecision);

    const selection = existingRun
      ? this.selectionForExistingRun(existingRun)
      : this.select(signals, budget, authority.workerCapacity, authority.canCreateWorkers, authority.capabilitiesAvailable);
    const selectedRunId = selection.mode === "squad"
      ? existingRun?.id ?? `run_adaptive_${inputDigest.slice(0, 32)}`
      : null;
    const effectiveBudget = selection.mode === "squad"
      ? { ...budget, max_workers: selection.workerCount }
      : budget;

    const artifactPayload = validateProtocolObject({
      schema_version: "1.0",
      id: artifactId,
      type: "artifact",
      workspace_id: input.workspaceId,
      created_by: input.leaderId,
      kind: "collaboration_decision",
      root_objective_id: input.rootObjectiveId,
      objective: input.objective.trim(),
      policy_version: POLICY_VERSION,
      input_digest: inputDigest,
      required_constraints: constraints,
      constraints_digest: constraintsDigest(constraints),
      required_tools: requiredTools,
      required_connections: requiredConnections,
      approval_required: input.approvalRequired === true,
      input_budget: budget,
      effective_budget: effectiveBudget,
      work_signals: signals,
      decision: {
        mode: selection.mode,
        topology: selection.topology,
        suggested_worker_count: selection.workerCount,
        execution_status: selection.executionStatus,
        selected_run_id: selectedRunId,
        existing_run_reused: Boolean(existingRun),
        reasons: selection.reasons
      },
      provenance: {
        type: "policy_generated",
        policy: POLICY_VERSION,
        input_digest: inputDigest
      }
    }, "artifact");

    this.store.putObject("artifact", artifactPayload);
    const event: CoordinationEvent = {
      schema_version: "1.0",
      id: `evt_collaboration_decision_${inputDigest.slice(0, 32)}`,
      type: "collaboration.decision_recorded",
      timestamp: new Date().toISOString(),
      actor_id: input.leaderId,
      workspace_id: input.workspaceId,
      run_id: selectedRunId,
      correlation_id: input.rootObjectiveId,
      summary: selection.mode === "squad"
        ? `Adaptive policy selected ${selection.topology} with a ceiling of ${selection.workerCount} temporary Workers`
        : `Adaptive policy kept objective ${input.rootObjectiveId} with the durable Bot`
    };
    this.store.appendEvent(event, `collaboration-decision:${artifactId}`);

    const stored = this.store.getObject(artifactId);
    if (!stored) throw new Error(`Collaboration decision ${artifactId} was not persisted`);
    return this.view(stored);
  }

  openSelectedRun(decisionId: string): CollaborationOpenResult {
    const decision = this.requireDecision(decisionId);
    const view = this.view(decision);
    if (view.mode === "single" || view.executionStatus === "blocked") return { ...view, run: null };
    if (!view.selectedRunId) throw new Error(`Squad decision ${decision.id} has no selected run ID`);

    const existing = this.store.getObject(view.selectedRunId);
    if (existing) {
      const run = this.validateSelectedRun(existing, decision);
      return { ...view, run };
    }

    const leaderId = String(decision.payload.created_by);
    const workspaceId = String(decision.payload.workspace_id);
    const leader = this.requireLeader(leaderId, workspaceId);
    const decisionData = asObject(decision.payload.decision);
    const topology = String(decisionData.topology) as TeamRunTopology;
    const selectedRunId = String(decisionData.selected_run_id);
    const timestamp = new Date().toISOString();
    const runPayload = validateProtocolObject({
      schema_version: "1.0",
      id: selectedRunId,
      type: "team_run",
      workspace_id: workspaceId,
      root_objective_id: String(decision.payload.root_objective_id),
      objective: String(decision.payload.objective),
      leader_id: leaderId,
      participant_ids: [leaderId],
      topology,
      status: "created",
      budget: asObject(decision.payload.effective_budget),
      required_constraints: stringArray(decision.payload.required_constraints),
      constraints_digest: decision.payload.constraints_digest ?? null,
      approval_required: decision.payload.approval_required === true,
      decision_artifact_ref: decision.id,
      created_at: timestamp,
      updated_at: timestamp
    }, "team_run");
    const event: CoordinationEvent = {
      schema_version: "1.0",
      id: `evt_adaptive_run_${digest({ decision_id: decision.id, run_id: selectedRunId }).slice(0, 32)}`,
      type: "team_run.created",
      timestamp,
      actor_id: leaderId,
      workspace_id: workspaceId,
      run_id: selectedRunId,
      correlation_id: String(decision.payload.root_objective_id),
      summary: `Opened adaptive Team Run ${selectedRunId} using ${topology}`
    };

    try {
      this.store.atomicMutation({
        preconditions: [{ id: leader.id, kind: "bot", status: "active" }],
        objects: [{ kind: "team_run", payload: runPayload }],
        events: [event]
      });
    } catch (error) {
      const raced = this.store.getObject(selectedRunId);
      if (raced) return { ...view, run: this.validateSelectedRun(raced, decision) };
      throw error;
    }

    const run = this.store.getObject(selectedRunId);
    if (!run) throw new Error(`Adaptive Team Run ${selectedRunId} was not persisted`);
    return { ...view, run: this.validateSelectedRun(run, decision) };
  }

  decideAndOpen(input: CollaborationDecisionInput): CollaborationOpenResult {
    const decision = this.decide(input);
    return this.openSelectedRun(decision.artifact.id);
  }

  getDecision(decisionId: string): StoredObject | null {
    const object = this.store.getObject(decisionId);
    return object?.kind === "artifact" && object.payload.kind === "collaboration_decision" ? object : null;
  }

  listDecisions(workspaceId?: string): StoredObject[] {
    return this.store.listObjects("artifact", workspaceId)
      .filter((artifact) => artifact.payload.kind === "collaboration_decision");
  }

  private select(
    signals: NormalizedSignals,
    budget: BudgetEnvelope,
    workerCapacity: number,
    canCreateWorkers: boolean,
    capabilitiesAvailable: boolean
  ): Selection {
    const reasons: CollaborationReason[] = [];
    if (!capabilitiesAvailable) {
      return {
        mode: "single",
        topology: "single",
        workerCount: 0,
        executionStatus: "blocked",
        reasons: [reason("REQUIRED_AUTHORITY_UNAVAILABLE", "Required tool or connection authority is outside the durable leader's allowed capability set.")]
      };
    }

    const hasCollaborationNeed = this.hasCollaborationNeed(signals);
    if (!canCreateWorkers || workerCapacity < 1) {
      reasons.push(reason(
        !canCreateWorkers ? "WORKER_CREATION_NOT_AUTHORIZED" : "WORKER_BUDGET_UNAVAILABLE",
        !canCreateWorkers
          ? "The durable leader is not authorized to create temporary Workers."
          : "The available budget leaves no temporary Worker capacity."
      ));
      if (hasCollaborationNeed) reasons.push(reason("SQUAD_NEED_DEGRADED_TO_SINGLE", "Collaboration signals exist, but policy must fail closed to the durable Bot."));
      else reasons.push(reason("SIMPLE_LINEAR_WORK", "The declared work does not justify temporary collaboration."));
      return { mode: "single", topology: "single", workerCount: 0, executionStatus: hasCollaborationNeed ? "degraded" : "ready", reasons };
    }

    const maxTasks = numberLimit(budget.max_tasks) ?? Number.POSITIVE_INFINITY;
    const maxMessages = numberLimit(budget.max_messages) ?? Number.POSITIVE_INFINITY;
    const maxRounds = numberLimit(budget.max_rounds) ?? Number.POSITIVE_INFINITY;
    const parallelWanted = signals.parallel_safe && signals.independent_workstreams >= 2;
    const verificationRequired = signals.verification_need === "required";
    const verificationRecommended = signals.verification_need === "recommended";
    const discussionWanted = signals.discussion_needed;
    const handoffWanted = signals.ownership_transfer_needed;

    const parallelWorkers = Math.min(signals.independent_workstreams, workerCapacity, Math.floor(maxTasks));
    const parallelFeasible = parallelWanted && parallelWorkers >= 2;
    const discussionTasks = signals.discussion_participants * signals.discussion_rounds;
    const discussionMessages = discussionTasks + 2;
    const discussionFeasible = discussionWanted
      && workerCapacity >= signals.discussion_participants
      && maxTasks >= discussionTasks
      && maxMessages >= discussionMessages
      && maxRounds >= signals.discussion_rounds;
    const verifierFeasible = verificationRequired && maxTasks >= 1;

    if (discussionWanted && !discussionFeasible) {
      reasons.push(reason("DISCUSSION_BUDGET_INSUFFICIENT", "Worker, task, message, or round limits cannot support the declared bounded discussion."));
    }
    if (parallelWanted && !parallelFeasible) {
      reasons.push(reason("PARALLEL_CAPACITY_INSUFFICIENT", "Available Worker or task capacity cannot support at least two independent parallel assignments."));
    }

    if (discussionFeasible && (parallelFeasible || verificationRequired || handoffWanted)) {
      const workers = Math.max(signals.discussion_participants, parallelFeasible ? parallelWorkers : 1);
      reasons.push(reason("MULTIPLE_COLLABORATION_MODES", "The work needs more than one bounded collaboration mode, so the combined topology is justified."));
      if (parallelFeasible) reasons.push(reason("PARALLEL_WORKSTREAMS", "Independent parallel-safe workstreams justify bounded fan-out."));
      if (verificationRequired) reasons.push(reason("VERIFICATION_REQUIRED", "The declared result requires independent verification before final synthesis."));
      if (handoffWanted) reasons.push(reason("OWNERSHIP_TRANSFER_REQUIRED", "The work declares an explicit ownership-transfer need."));
      reasons.push(reason("DISCUSSION_REQUIRED", "The work declares bounded multi-role discussion as necessary."));
      return { mode: "squad", topology: "hybrid", workerCount: workers, executionStatus: "ready", reasons };
    }

    if (discussionFeasible) {
      reasons.push(reason("DISCUSSION_REQUIRED", "The work declares bounded multi-role discussion as necessary."));
      return {
        mode: "squad",
        topology: "group_room",
        workerCount: signals.discussion_participants,
        executionStatus: "ready",
        reasons
      };
    }

    if (handoffWanted && maxTasks >= 1) {
      reasons.push(reason("OWNERSHIP_TRANSFER_REQUIRED", "The work declares an explicit ownership-transfer need."));
      return { mode: "squad", topology: "handoff", workerCount: 1, executionStatus: "ready", reasons };
    }

    if (parallelFeasible) {
      if (signals.cost_sensitivity === "high" && signals.latency_sensitivity !== "high" && !verificationRequired) {
        reasons.push(reason("COST_SENSITIVITY_FAVORS_SERIAL", "High cost sensitivity favors one bounded helper over parallel fan-out."));
        return { mode: "squad", topology: "manager", workerCount: 1, executionStatus: "ready", reasons };
      }
      reasons.push(reason("PARALLEL_WORKSTREAMS", "Independent parallel-safe workstreams justify bounded fan-out."));
      if (signals.latency_sensitivity === "high") reasons.push(reason("LATENCY_SENSITIVITY_FAVORS_PARALLEL", "High latency sensitivity strengthens the case for safe parallel execution."));
      if (verificationRequired) {
        reasons.push(reason("VERIFICATION_REQUIRED", "The declared result requires independent verification before final synthesis."));
        return { mode: "squad", topology: "dynamic_squad", workerCount: parallelWorkers, executionStatus: "ready", reasons };
      }
      return { mode: "squad", topology: "parallel_panel", workerCount: parallelWorkers, executionStatus: "ready", reasons };
    }

    if (verifierFeasible) {
      reasons.push(reason("VERIFICATION_REQUIRED", "The durable Bot may produce primary work, but a bounded temporary verifier is required."));
      return { mode: "squad", topology: "dynamic_squad", workerCount: 1, executionStatus: "ready", reasons };
    }

    if (verificationRequired && !verifierFeasible) {
      reasons.push(reason("TASK_BUDGET_INSUFFICIENT", "Verification is required but the task budget cannot schedule a verifier."));
      return { mode: "single", topology: "single", workerCount: 0, executionStatus: "degraded", reasons };
    }

    const managerJustified = signals.specialist_roles >= 1
      || signals.sequential_stages >= 2
      || verificationRecommended
      || signals.uncertainty === "high"
      || (parallelWanted && !parallelFeasible)
      || (discussionWanted && !discussionFeasible);
    if (managerJustified && maxTasks >= 1) {
      if (signals.specialist_roles >= 1) reasons.push(reason("SPECIALIST_ROLE_NEEDED", "At least one bounded specialist contribution is declared."));
      if (signals.sequential_stages >= 2) reasons.push(reason("SEQUENTIAL_STAGES", "The work has multiple sequential stages that do not justify parallel fan-out."));
      if (verificationRecommended) reasons.push(reason("VERIFICATION_RECOMMENDED", "Independent checking is recommended but not mandatory."));
      if (signals.uncertainty === "high") reasons.push(reason("HIGH_UNCERTAINTY", "Declared uncertainty justifies one bounded independent contribution."));
      if (reasons.length === 0) reasons.push(reason("MINIMUM_SQUAD_NOT_AVAILABLE", "The preferred collaboration shape is not feasible, so policy selected one bounded helper."));
      return { mode: "squad", topology: "manager", workerCount: 1, executionStatus: "ready", reasons };
    }

    if (managerJustified && maxTasks < 1) {
      reasons.push(reason("TASK_BUDGET_INSUFFICIENT", "The task budget cannot schedule temporary collaboration."));
      return { mode: "single", topology: "single", workerCount: 0, executionStatus: "degraded", reasons };
    }

    reasons.push(reason("SIMPLE_LINEAR_WORK", "One durable Bot is sufficient for the declared work shape and risk level."));
    return { mode: "single", topology: "single", workerCount: 0, executionStatus: "ready", reasons };
  }

  private normalizeSignals(value: CollaborationWorkSignals | undefined): NormalizedSignals {
    const source = asObject(value);
    return {
      independent_workstreams: positiveInteger(source.independentWorkstreams, 1, "independentWorkstreams"),
      specialist_roles: nonNegativeInteger(source.specialistRoles, 0, "specialistRoles"),
      sequential_stages: positiveInteger(source.sequentialStages, 1, "sequentialStages"),
      uncertainty: level(source.uncertainty, "low", "uncertainty"),
      verification_need: verification(source.verificationNeed),
      parallel_safe: source.parallelSafe === true,
      discussion_needed: source.discussionNeeded === true,
      discussion_participants: positiveInteger(source.discussionParticipants, 2, "discussionParticipants"),
      discussion_rounds: positiveInteger(source.discussionRounds, 1, "discussionRounds"),
      ownership_transfer_needed: source.ownershipTransferNeeded === true,
      cost_sensitivity: level(source.costSensitivity, "medium", "costSensitivity"),
      latency_sensitivity: level(source.latencySensitivity, "medium", "latencySensitivity")
    };
  }

  private hasCollaborationNeed(signals: NormalizedSignals): boolean {
    return signals.independent_workstreams >= 2
      || signals.specialist_roles >= 1
      || signals.sequential_stages >= 2
      || signals.uncertainty === "high"
      || signals.verification_need !== "none"
      || signals.discussion_needed
      || signals.ownership_transfer_needed;
  }

  private authorityState(
    leader: StoredObject,
    requiredTools: string[],
    requiredConnections: string[],
    budget: BudgetEnvelope
  ): { canCreateWorkers: boolean; capabilitiesAvailable: boolean; workerCapacity: number } {
    const permissions = asObject(leader.payload.permissions);
    const coordination = asObject(leader.payload.coordination);
    const canCreateWorkers = permissions.can_create_workers !== false;
    const allowedTools = Array.isArray(permissions.allowed_tools) ? stringArray(permissions.allowed_tools) : null;
    const allowedConnections = Array.isArray(permissions.allowed_connections) ? stringArray(permissions.allowed_connections) : null;
    const toolsAvailable = !allowedTools || allowedTools.includes("*") || requiredTools.every((tool) => allowedTools.includes(tool));
    const connectionsAvailable = !allowedConnections || allowedConnections.includes("*") || requiredConnections.every((connection) => allowedConnections.includes(connection));
    const leaderParallel = numberLimit(coordination.max_parallel_workers) ?? DEFAULT_WORKER_CEILING;
    const budgetWorkers = numberLimit(budget.max_workers) ?? leaderParallel;
    const workerCapacity = canCreateWorkers
      ? Math.max(0, Math.min(POLICY_WORKER_CEILING, Math.floor(leaderParallel), Math.floor(budgetWorkers)))
      : 0;
    return { canCreateWorkers, capabilitiesAvailable: toolsAvailable && connectionsAvailable, workerCapacity };
  }

  private existingObjectiveRun(workspaceId: string, rootObjectiveId: string, leaderId: string): StoredObject | null {
    const matches = this.store.listObjects("team_run", workspaceId)
      .filter((run) => String(run.payload.root_objective_id) === rootObjectiveId);
    if (matches.length === 0) return null;
    const sameLeader = matches.find((run) => String(run.payload.leader_id ?? "") === leaderId);
    if (sameLeader) return sameLeader;
    throw new Error(`Root objective ${rootObjectiveId} already has a Team Run owned by another durable leader`);
  }

  private selectionForExistingRun(run: StoredObject): Selection {
    const topology = String(run.payload.topology) as TeamRunTopology;
    const runBudget = normalizeBudget(run.payload.budget);
    const workerCount = Math.max(1, Math.floor(numberLimit(runBudget.max_workers) ?? 1));
    return {
      mode: "squad",
      topology,
      workerCount,
      executionStatus: TERMINAL_RUN_STATES.has(String(run.payload.status)) ? "degraded" : "ready",
      reasons: [reason("EXISTING_OBJECTIVE_RUN_REUSED", "The root objective already has a Team Run, so adaptive policy reuses it instead of creating another squad.")]
    };
  }

  private requireLeader(leaderId: string, workspaceId: string): StoredObject {
    const leader = this.store.getObject(leaderId);
    if (!leader || leader.kind !== "bot") throw new Error(`Adaptive collaboration leader ${leaderId} must be a durable Bot`);
    if (leader.payload.status !== "active") throw new Error(`Adaptive collaboration leader ${leaderId} must be active`);
    if (leader.workspaceId !== workspaceId) throw new Error(`Adaptive collaboration leader ${leaderId} is outside workspace ${workspaceId}`);
    return leader;
  }

  private requireDecision(decisionId: string): StoredObject {
    const decision = this.getDecision(decisionId);
    if (!decision) throw new Error(`Collaboration decision ${decisionId} not found`);
    return decision;
  }

  private validateSelectedRun(run: StoredObject, decision: StoredObject): StoredObject {
    if (run.kind !== "team_run") throw new Error(`Selected run ${run.id} is not a Team Run`);
    if (run.workspaceId !== decision.workspaceId) throw new Error(`Selected run ${run.id} is outside decision workspace`);
    if (String(run.payload.root_objective_id) !== String(decision.payload.root_objective_id)) {
      throw new Error(`Selected run ${run.id} does not preserve root objective lineage`);
    }
    if (String(run.payload.leader_id ?? "") !== String(decision.payload.created_by)) {
      throw new Error(`Selected run ${run.id} does not preserve durable leader ownership`);
    }
    return run;
  }

  private view(artifact: StoredObject): CollaborationDecisionView {
    if (artifact.kind !== "artifact" || artifact.payload.kind !== "collaboration_decision") {
      throw new Error(`Artifact ${artifact.id} is not a collaboration decision`);
    }
    const decision = asObject(artifact.payload.decision);
    const mode = String(decision.mode) as CollaborationMode;
    const topology = String(decision.topology) as TeamRunTopology;
    const workerCount = Number(decision.suggested_worker_count ?? 0);
    const executionStatus = String(decision.execution_status) as CollaborationExecutionStatus;
    const reasons = Array.isArray(decision.reasons)
      ? decision.reasons.map((item) => asObject(item) as CollaborationReason)
      : [];
    return {
      artifact,
      mode,
      topology,
      suggestedWorkerCount: workerCount,
      executionStatus,
      reasons,
      selectedRunId: typeof decision.selected_run_id === "string" ? decision.selected_run_id : null
    };
  }
}
