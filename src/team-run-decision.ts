import { createHash } from "node:crypto";
import { normalizeBudget, type BudgetEnvelope } from "./budget.js";
import { constraintsDigest, normalizeConstraints } from "./constraints.js";
import { CoordinationStore } from "./store.js";
import type { TeamRunTopology } from "./team-runs.js";
import type { CoordinationEvent, JsonObject, StoredObject } from "./types.js";
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

interface AuthorityState {
  canCreateWorkers: boolean;
  capabilitiesAvailable: boolean;
  workerIdentityCapacity: number;
  parallelCapacity: number;
}

const POLICY_VERSION = "team-run-decision-v1";
const DEFAULT_WORKER_CEILING = 4;
const POLICY_WORKER_CEILING = 8;
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "canceled", "budget_exhausted"]);
const ADAPTIVE_TOPOLOGIES = new Set<TeamRunTopology>([
  "single",
  "manager",
  "handoff",
  "parallel_panel",
  "group_room",
  "dynamic_squad",
  "hybrid"
]);
const BUDGET_KEYS = [
  "token_limit",
  "cost_limit",
  "wall_clock_seconds",
  "max_workers",
  "max_hops",
  "max_messages",
  "max_rounds",
  "max_tasks",
  "max_actions"
] as const;

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))].sort();
}

function normalizedStoredStrings(value: unknown): string[] {
  return [...new Set(stringArray(value).map((item) => item.trim()).filter(Boolean))].sort();
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

function containsAll(haystack: string[], needles: string[]): boolean {
  return needles.every((value) => haystack.includes(value));
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
    if (existingRun) {
      this.assertExistingRunCompatible(
        existingRun,
        constraints,
        requiredTools,
        requiredConnections,
        input.approvalRequired === true,
        budget
      );
    }
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
      : this.select(
        signals,
        budget,
        authority.workerIdentityCapacity,
        authority.parallelCapacity,
        authority.canCreateWorkers,
        authority.capabilitiesAvailable
      );
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
        ? `Adaptive policy selected ${selection.topology} with a lifetime ceiling of ${selection.workerCount} temporary Worker identities`
        : `Adaptive policy kept objective ${input.rootObjectiveId} with the durable Bot`
    };

    try {
      this.store.atomicMutation({
        preconditions: [{ id: leader.id, kind: "bot", status: "active" }],
        objects: [{ kind: "artifact", payload: artifactPayload }],
        events: [event]
      });
    } catch (error) {
      const raced = this.store.getObject(artifactId);
      if (raced) return this.view(raced);
      throw error;
    }

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
      required_tools: stringArray(decision.payload.required_tools),
      required_connections: stringArray(decision.payload.required_connections),
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
    workerIdentityCapacity: number,
    parallelCapacity: number,
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
    if (!canCreateWorkers || workerIdentityCapacity < 1) {
      reasons.push(reason(
        !canCreateWorkers ? "WORKER_CREATION_NOT_AUTHORIZED" : "WORKER_BUDGET_UNAVAILABLE",
        !canCreateWorkers
          ? "The durable leader is not authorized to create temporary Workers."
          : "The available budget leaves no temporary Worker identity capacity."
      ));
      if (hasCollaborationNeed) reasons.push(reason("SQUAD_NEED_DEGRADED_TO_SINGLE", "Collaboration signals exist, but policy must fail closed to the durable Bot."));
      else reasons.push(reason("SIMPLE_LINEAR_WORK", "The declared work does not justify temporary collaboration."));
      return { mode: "single", topology: "single", workerCount: 0, executionStatus: hasCollaborationNeed ? "degraded" : "ready", reasons };
    }

    const maxTasks = numberLimit(budget.max_tasks) ?? Number.POSITIVE_INFINITY;
    const maxMessages = numberLimit(budget.max_messages) ?? Number.POSITIVE_INFINITY;
    const maxRounds = numberLimit(budget.max_rounds) ?? Number.POSITIVE_INFINITY;
    const maxHops = numberLimit(budget.max_hops) ?? Number.POSITIVE_INFINITY;
    const parallelWanted = signals.parallel_safe && signals.independent_workstreams >= 2;
    const verificationRequired = signals.verification_need === "required";
    const verificationRecommended = signals.verification_need === "recommended";
    const discussionWanted = signals.discussion_needed;
    const handoffWanted = signals.ownership_transfer_needed;
    const verifierFeasible = verificationRequired && workerIdentityCapacity >= 1 && maxTasks >= 1;

    if (handoffWanted && maxHops < 1) {
      return {
        mode: "single",
        topology: "single",
        workerCount: 0,
        executionStatus: "blocked",
        reasons: [reason("HANDOFF_HOP_BUDGET_UNAVAILABLE", "Ownership transfer is required but the Team Run hop budget does not permit even one handoff.")]
      };
    }

    const discussionTasks = signals.discussion_participants * signals.discussion_rounds;
    const discussionMessages = discussionTasks + 2;
    const discussionSurfaceFeasible = maxMessages >= discussionMessages && maxRounds >= signals.discussion_rounds;
    const discussionOnlyFeasible = discussionWanted
      && discussionSurfaceFeasible
      && workerIdentityCapacity >= signals.discussion_participants
      && maxTasks >= discussionTasks;

    if (verificationRequired && !verifierFeasible) {
      return {
        mode: "single",
        topology: "single",
        workerCount: 0,
        executionStatus: "blocked",
        reasons: [reason("VERIFICATION_CAPACITY_UNAVAILABLE", "Verification is required but Worker identity or task capacity cannot schedule a verifier.")]
      };
    }

    if (discussionWanted && !discussionOnlyFeasible) {
      reasons.push(reason("DISCUSSION_BUDGET_INSUFFICIENT", "Worker identity, task, message, or round limits cannot support the declared bounded discussion."));
    }

    if (discussionWanted && parallelWanted) {
      const reservedVerifier = verificationRequired ? 1 : 0;
      const availableForParallelByWorkers = workerIdentityCapacity - signals.discussion_participants - reservedVerifier;
      const availableForParallelByTasks = maxTasks - discussionTasks - reservedVerifier;
      const parallelWorkers = Math.min(
        signals.independent_workstreams,
        parallelCapacity,
        Math.floor(availableForParallelByWorkers),
        Math.floor(availableForParallelByTasks)
      );
      const fullHybridFeasible = discussionSurfaceFeasible && parallelWorkers >= 2;
      if (fullHybridFeasible) {
        const workers = signals.discussion_participants + parallelWorkers + reservedVerifier;
        reasons.push(reason("MULTIPLE_COLLABORATION_MODES", "Separate bounded discussion and parallel participants require cumulative Worker identity capacity, so a combined topology is justified."));
        reasons.push(reason("DISCUSSION_REQUIRED", "The work declares bounded multi-role discussion as necessary."));
        reasons.push(reason("PARALLEL_WORKSTREAMS", "Independent parallel-safe workstreams justify bounded fan-out."));
        if (verificationRequired) reasons.push(reason("VERIFICATION_REQUIRED", "One additional Worker identity is reserved for required verification after candidate work."));
        if (handoffWanted) reasons.push(reason("OWNERSHIP_TRANSFER_REQUIRED", "The work declares an explicit ownership-transfer need."));
        return { mode: "squad", topology: "hybrid", workerCount: workers, executionStatus: "ready", reasons };
      }

      if (verificationRequired && discussionOnlyFeasible
        && workerIdentityCapacity >= signals.discussion_participants + 1
        && maxTasks >= discussionTasks + 1) {
        reasons.push(reason("PARALLEL_DROPPED_FOR_VERIFICATION_CAPACITY", "Parallel fan-out was dropped so the run can preserve required verification capacity after the bounded discussion."));
        reasons.push(reason("DISCUSSION_REQUIRED", "The work declares bounded multi-role discussion as necessary."));
        reasons.push(reason("VERIFICATION_REQUIRED", "One additional Worker identity is reserved for required verification."));
        return {
          mode: "squad",
          topology: "hybrid",
          workerCount: signals.discussion_participants + 1,
          executionStatus: "degraded",
          reasons
        };
      }

      if (verificationRequired) {
        const parallelWithVerifier = Math.min(
          signals.independent_workstreams,
          parallelCapacity,
          workerIdentityCapacity - 1,
          Math.floor(maxTasks - 1)
        );
        if (parallelWithVerifier >= 2) {
          reasons.push(reason("DISCUSSION_DROPPED_FOR_VERIFICATION_CAPACITY", "Bounded discussion was dropped because available capacity can preserve parallel candidate work plus required verification, but not all requested modes."));
          reasons.push(reason("PARALLEL_WORKSTREAMS", "Independent parallel-safe workstreams remain feasible."));
          reasons.push(reason("VERIFICATION_REQUIRED", "One additional Worker identity is reserved for required verification."));
          return {
            mode: "squad",
            topology: "dynamic_squad",
            workerCount: parallelWithVerifier + 1,
            executionStatus: "degraded",
            reasons
          };
        }
        reasons.push(reason("COLLABORATION_DROPPED_FOR_VERIFICATION_CAPACITY", "The requested discussion and parallel work cannot fit alongside required verification, so only the verifier is reserved."));
        reasons.push(reason("VERIFICATION_REQUIRED", "Required verification takes precedence over optional collaboration expansion."));
        return { mode: "squad", topology: "dynamic_squad", workerCount: 1, executionStatus: "degraded", reasons };
      }

      if (discussionOnlyFeasible) {
        reasons.push(reason("PARALLEL_CAPACITY_INSUFFICIENT", "Cumulative Worker or task capacity cannot support separate parallel participants in addition to the bounded discussion."));
        reasons.push(reason("DISCUSSION_REQUIRED", "The bounded discussion remains feasible and is retained."));
        return {
          mode: "squad",
          topology: handoffWanted ? "hybrid" : "group_room",
          workerCount: signals.discussion_participants,
          executionStatus: "degraded",
          reasons
        };
      }
    }

    if (discussionWanted) {
      const requiredWorkers = signals.discussion_participants + (verificationRequired ? 1 : 0);
      const requiredTasks = discussionTasks + (verificationRequired ? 1 : 0);
      const fullDiscussionFeasible = discussionSurfaceFeasible
        && workerIdentityCapacity >= requiredWorkers
        && maxTasks >= requiredTasks;
      if (fullDiscussionFeasible) {
        reasons.push(reason("DISCUSSION_REQUIRED", "The work declares bounded multi-role discussion as necessary."));
        if (verificationRequired) reasons.push(reason("VERIFICATION_REQUIRED", "One additional Worker identity is reserved for required verification after discussion."));
        if (handoffWanted) reasons.push(reason("OWNERSHIP_TRANSFER_REQUIRED", "The work declares an explicit ownership-transfer need."));
        return {
          mode: "squad",
          topology: verificationRequired || handoffWanted ? "hybrid" : "group_room",
          workerCount: requiredWorkers,
          executionStatus: "ready",
          reasons
        };
      }
      if (verificationRequired) {
        reasons.push(reason("DISCUSSION_DROPPED_FOR_VERIFICATION_CAPACITY", "The discussion cannot fit without consuming capacity required for independent verification."));
        reasons.push(reason("VERIFICATION_REQUIRED", "Required verification takes precedence over the larger discussion shape."));
        return { mode: "squad", topology: "dynamic_squad", workerCount: 1, executionStatus: "degraded", reasons };
      }
    }

    if (parallelWanted) {
      if (verificationRequired) {
        const parallelWorkers = Math.min(
          signals.independent_workstreams,
          parallelCapacity,
          workerIdentityCapacity - 1,
          Math.floor(maxTasks - 1)
        );
        if (parallelWorkers >= 2) {
          reasons.push(reason("PARALLEL_WORKSTREAMS", "Independent parallel-safe workstreams justify bounded fan-out."));
          reasons.push(reason("VERIFICATION_REQUIRED", "One additional Worker identity is reserved for required verification after fan-out."));
          if (signals.latency_sensitivity === "high") reasons.push(reason("LATENCY_SENSITIVITY_FAVORS_PARALLEL", "High latency sensitivity strengthens the case for safe parallel execution."));
          if (handoffWanted) reasons.push(reason("OWNERSHIP_TRANSFER_REQUIRED", "The work declares an explicit ownership-transfer need."));
          return {
            mode: "squad",
            topology: handoffWanted ? "hybrid" : "dynamic_squad",
            workerCount: parallelWorkers + 1,
            executionStatus: "ready",
            reasons
          };
        }
        reasons.push(reason("PARALLEL_DROPPED_FOR_VERIFICATION_CAPACITY", "Parallel fan-out would consume Worker or task capacity required for the verifier, so the durable leader keeps primary work."));
        reasons.push(reason("VERIFICATION_REQUIRED", "Required verification takes precedence over parallel expansion."));
        return { mode: "squad", topology: "dynamic_squad", workerCount: 1, executionStatus: "degraded", reasons };
      }

      const parallelWorkers = Math.min(
        signals.independent_workstreams,
        parallelCapacity,
        workerIdentityCapacity,
        Math.floor(maxTasks)
      );
      if (parallelWorkers >= 2) {
        if (signals.cost_sensitivity === "high" && signals.latency_sensitivity !== "high") {
          reasons.push(reason("COST_SENSITIVITY_FAVORS_SERIAL", "High cost sensitivity favors one bounded helper over parallel fan-out."));
          return { mode: "squad", topology: "manager", workerCount: 1, executionStatus: "ready", reasons };
        }
        reasons.push(reason("PARALLEL_WORKSTREAMS", "Independent parallel-safe workstreams justify bounded fan-out."));
        if (signals.latency_sensitivity === "high") reasons.push(reason("LATENCY_SENSITIVITY_FAVORS_PARALLEL", "High latency sensitivity strengthens the case for safe parallel execution."));
        if (handoffWanted) reasons.push(reason("OWNERSHIP_TRANSFER_REQUIRED", "The work declares an explicit ownership-transfer need."));
        return {
          mode: "squad",
          topology: handoffWanted ? "hybrid" : "parallel_panel",
          workerCount: parallelWorkers,
          executionStatus: "ready",
          reasons
        };
      }
      reasons.push(reason("PARALLEL_CAPACITY_INSUFFICIENT", "Available Worker identity, task, or concurrency capacity cannot support at least two independent parallel assignments."));
    }

    if (verificationRequired) {
      reasons.push(reason("VERIFICATION_REQUIRED", "The durable Bot may produce primary work, but a bounded temporary verifier is required."));
      return { mode: "squad", topology: handoffWanted ? "hybrid" : "dynamic_squad", workerCount: 1, executionStatus: reasons.length > 1 ? "degraded" : "ready", reasons };
    }

    if (handoffWanted && maxTasks >= 1) {
      reasons.push(reason("OWNERSHIP_TRANSFER_REQUIRED", "The work declares an explicit ownership-transfer need."));
      return { mode: "squad", topology: "handoff", workerCount: 1, executionStatus: "ready", reasons };
    }

    const managerJustified = signals.specialist_roles >= 1
      || signals.sequential_stages >= 2
      || verificationRecommended
      || signals.uncertainty === "high"
      || parallelWanted
      || discussionWanted;
    if (managerJustified && maxTasks >= 1) {
      const requestedManagerWorkers = Math.max(
        1,
        signals.specialist_roles,
        Math.max(1, signals.sequential_stages - 1)
      );
      const managerWorkers = Math.max(1, Math.min(requestedManagerWorkers, workerIdentityCapacity, Math.floor(maxTasks)));
      if (signals.specialist_roles >= 1) reasons.push(reason("SPECIALIST_ROLE_NEEDED", "At least one bounded specialist contribution is declared."));
      if (signals.sequential_stages >= 2) reasons.push(reason("SEQUENTIAL_STAGES", "Multiple sequential stages may consume distinct temporary Worker identities over the run lifetime."));
      if (verificationRecommended) reasons.push(reason("VERIFICATION_RECOMMENDED", "Independent checking is recommended but not mandatory."));
      if (signals.uncertainty === "high") reasons.push(reason("HIGH_UNCERTAINTY", "Declared uncertainty justifies bounded independent contribution."));
      if (managerWorkers < requestedManagerWorkers) reasons.push(reason("MANAGER_CAPACITY_DEGRADED", "The manager topology is retained with fewer lifetime Worker identities than the declared specialist/stage shape would ideally use."));
      if (reasons.length === 0) reasons.push(reason("MINIMUM_SQUAD_NOT_AVAILABLE", "The preferred collaboration shape is not feasible, so policy selected bounded serial help."));
      return {
        mode: "squad",
        topology: "manager",
        workerCount: managerWorkers,
        executionStatus: managerWorkers < requestedManagerWorkers || reasons.some((item) => String(item.code).endsWith("INSUFFICIENT")) ? "degraded" : "ready",
        reasons
      };
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
  ): AuthorityState {
    const permissions = asObject(leader.payload.permissions);
    const coordination = asObject(leader.payload.coordination);
    const canCreateWorkers = permissions.can_create_workers !== false;
    const allowedTools = Array.isArray(permissions.allowed_tools) ? stringArray(permissions.allowed_tools) : null;
    const allowedConnections = Array.isArray(permissions.allowed_connections) ? stringArray(permissions.allowed_connections) : null;
    const toolsAvailable = !allowedTools || allowedTools.includes("*") || requiredTools.every((tool) => allowedTools.includes(tool));
    const connectionsAvailable = !allowedConnections || allowedConnections.includes("*") || requiredConnections.every((connection) => allowedConnections.includes(connection));
    const leaderParallel = Math.max(0, Math.floor(numberLimit(coordination.max_parallel_workers) ?? DEFAULT_WORKER_CEILING));
    const defaultIdentityCapacity = Math.max(DEFAULT_WORKER_CEILING, leaderParallel);
    const budgetWorkers = numberLimit(budget.max_workers) ?? defaultIdentityCapacity;
    const workerIdentityCapacity = canCreateWorkers
      ? Math.max(0, Math.min(POLICY_WORKER_CEILING, Math.floor(budgetWorkers)))
      : 0;
    const parallelCapacity = canCreateWorkers
      ? Math.max(0, Math.min(workerIdentityCapacity, POLICY_WORKER_CEILING, leaderParallel))
      : 0;
    return {
      canCreateWorkers,
      capabilitiesAvailable: toolsAvailable && connectionsAvailable,
      workerIdentityCapacity,
      parallelCapacity
    };
  }

  private existingObjectiveRun(workspaceId: string, rootObjectiveId: string, leaderId: string): StoredObject | null {
    const matches = this.store.listObjects("team_run", workspaceId)
      .filter((run) => String(run.payload.root_objective_id) === rootObjectiveId);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new Error(`Root objective ${rootObjectiveId} already has multiple Team Runs; adaptive policy will not create or reuse another`);
    }
    const run = matches[0]!;
    if (String(run.payload.leader_id ?? "") !== leaderId) {
      throw new Error(`Root objective ${rootObjectiveId} already has a Team Run owned by another durable leader`);
    }
    return run;
  }

  private assertExistingRunCompatible(
    run: StoredObject,
    constraints: string[],
    requiredTools: string[],
    requiredConnections: string[],
    approvalRequired: boolean,
    requestedBudget: BudgetEnvelope
  ): void {
    const existingConstraints = normalizedStoredStrings(run.payload.required_constraints);
    if (!containsAll(existingConstraints, constraints)) {
      throw new Error(`Existing Team Run ${run.id} does not preserve all current immutable constraints`);
    }
    if (approvalRequired && run.payload.approval_required !== true) {
      throw new Error(`Existing Team Run ${run.id} does not preserve the current approval requirement`);
    }
    const existingTools = normalizedStoredStrings(run.payload.required_tools);
    if (!containsAll(existingTools, requiredTools)) {
      throw new Error(`Existing Team Run ${run.id} does not preserve all current required tools`);
    }
    const existingConnections = normalizedStoredStrings(run.payload.required_connections);
    if (!containsAll(existingConnections, requiredConnections)) {
      throw new Error(`Existing Team Run ${run.id} does not preserve all current required connections`);
    }
    const existingBudget = normalizeBudget(run.payload.budget);
    if (typeof existingBudget.max_workers !== "number" || existingBudget.max_workers < 1) {
      throw new Error(`Existing Team Run ${run.id} has no explicit bounded max_workers ceiling for adaptive reuse`);
    }
    for (const key of BUDGET_KEYS) {
      const requested = requestedBudget[key];
      if (typeof requested !== "number") continue;
      const existing = existingBudget[key];
      if (typeof existing !== "number" || existing > requested) {
        throw new Error(`Existing Team Run ${run.id} has a broader ${key} boundary than the current adaptive decision permits`);
      }
    }
  }

  private selectionForExistingRun(run: StoredObject): Selection {
    const topology = String(run.payload.topology) as TeamRunTopology;
    if (!ADAPTIVE_TOPOLOGIES.has(topology) || topology === "single") {
      throw new Error(`Existing Team Run ${run.id} uses unsupported adaptive topology ${topology}`);
    }
    const runBudget = normalizeBudget(run.payload.budget);
    const workerCount = Math.max(1, Math.floor(numberLimit(runBudget.max_workers) ?? 1));
    return {
      mode: "squad",
      topology,
      workerCount,
      executionStatus: TERMINAL_RUN_STATES.has(String(run.payload.status)) ? "degraded" : "ready",
      reasons: [reason("EXISTING_OBJECTIVE_RUN_REUSED", "The root objective already has a compatible Team Run, so adaptive policy reuses it instead of creating another squad.")]
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
    this.assertDecisionArtifact(decision);
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
    const decisionData = asObject(decision.payload.decision);
    if (String(run.payload.topology) !== String(decisionData.topology)) {
      throw new Error(`Selected run ${run.id} topology does not match collaboration decision ${decision.id}`);
    }
    this.assertExistingRunCompatible(
      run,
      normalizedStoredStrings(decision.payload.required_constraints),
      normalizedStoredStrings(decision.payload.required_tools),
      normalizedStoredStrings(decision.payload.required_connections),
      decision.payload.approval_required === true,
      normalizeBudget(decision.payload.effective_budget)
    );
    if (decisionData.existing_run_reused !== true && String(run.payload.decision_artifact_ref ?? "") !== decision.id) {
      throw new Error(`Selected adaptive run ${run.id} does not reference collaboration decision ${decision.id}`);
    }
    const runBudget = normalizeBudget(run.payload.budget);
    if (typeof runBudget.max_workers !== "number" || runBudget.max_workers !== Number(decisionData.suggested_worker_count)) {
      throw new Error(`Selected run ${run.id} does not preserve the decision Worker identity ceiling`);
    }
    return run;
  }

  private assertDecisionArtifact(artifact: StoredObject): void {
    const problems: string[] = [];
    if (artifact.kind !== "artifact" || artifact.payload.kind !== "collaboration_decision") {
      throw new Error(`Artifact ${artifact.id} is not a collaboration decision`);
    }
    const payload = artifact.payload;
    const inputDigest = typeof payload.input_digest === "string" ? payload.input_digest : "";
    if (payload.policy_version !== POLICY_VERSION) problems.push("unsupported policy_version");
    if (!/^[a-f0-9]{64}$/.test(inputDigest)) problems.push("input_digest must be a 64-character hex digest");
    for (const key of ["workspace_id", "created_by", "root_objective_id", "objective"] as const) {
      if (typeof payload[key] !== "string" || !String(payload[key]).trim()) problems.push(`${key} must be non-empty`);
    }
    const provenance = asObject(payload.provenance);
    if (provenance.type !== "policy_generated" || provenance.policy !== POLICY_VERSION || provenance.input_digest !== inputDigest) {
      problems.push("provenance does not match the decision policy and input digest");
    }
    const constraints = normalizedStoredStrings(payload.required_constraints);
    const requiredTools = normalizedStoredStrings(payload.required_tools);
    const requiredConnections = normalizedStoredStrings(payload.required_connections);
    if (payload.constraints_digest !== constraintsDigest(constraints)) problems.push("constraints_digest does not match required_constraints");

    let inputBudget: BudgetEnvelope = {};
    let effectiveBudget: BudgetEnvelope = {};
    try {
      inputBudget = normalizeBudget(payload.input_budget);
      effectiveBudget = normalizeBudget(payload.effective_budget);
    } catch (error) {
      problems.push(`budget is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (/^[a-f0-9]{64}$/.test(inputDigest)) {
      const recomputedDigest = digest({
        policy_version: POLICY_VERSION,
        leader_id: typeof payload.created_by === "string" ? payload.created_by : "",
        workspace_id: typeof payload.workspace_id === "string" ? payload.workspace_id : "",
        root_objective_id: typeof payload.root_objective_id === "string" ? payload.root_objective_id : "",
        objective: typeof payload.objective === "string" ? payload.objective.trim() : "",
        work: asObject(payload.work_signals),
        required_constraints: constraints,
        required_tools: requiredTools,
        required_connections: requiredConnections,
        approval_required: payload.approval_required === true,
        budget: inputBudget
      });
      if (recomputedDigest !== inputDigest) problems.push("input_digest does not match stored decision inputs");
      const expectedArtifactId = `artifact_collaboration_decision_${inputDigest.slice(0, 32)}`;
      if (artifact.id !== expectedArtifactId || payload.id !== expectedArtifactId) {
        problems.push("artifact ID does not match input_digest");
      }
    }

    const decision = asObject(payload.decision);
    const mode = decision.mode;
    const topology = decision.topology;
    const workerCount = decision.suggested_worker_count;
    const executionStatus = decision.execution_status;
    const selectedRunId = decision.selected_run_id;
    if (mode !== "single" && mode !== "squad") problems.push("decision.mode is unsupported");
    if (typeof topology !== "string" || !ADAPTIVE_TOPOLOGIES.has(topology as TeamRunTopology)) problems.push("decision.topology is unsupported");
    if (executionStatus !== "ready" && executionStatus !== "degraded" && executionStatus !== "blocked") problems.push("decision.execution_status is unsupported");
    if (typeof workerCount !== "number" || !Number.isInteger(workerCount) || workerCount < 0) problems.push("suggested_worker_count must be a non-negative integer");
    if (typeof decision.existing_run_reused !== "boolean") problems.push("existing_run_reused must be boolean");

    if (mode === "single") {
      if (topology !== "single") problems.push("single mode requires single topology");
      if (workerCount !== 0) problems.push("single mode requires zero Workers");
      if (selectedRunId !== null) problems.push("single mode cannot select a Team Run ID");
    }
    if (mode === "squad") {
      if (topology === "single") problems.push("squad mode cannot use single topology");
      if (typeof workerCount !== "number" || workerCount < 1) problems.push("squad mode requires at least one Worker identity");
      if (typeof selectedRunId !== "string" || !selectedRunId.trim()) problems.push("squad mode requires a selected Team Run ID");
      if (executionStatus === "blocked") problems.push("blocked decisions cannot open a squad");
      if (effectiveBudget.max_workers !== workerCount) problems.push("effective max_workers must equal suggested_worker_count");
      if (typeof inputBudget.max_workers === "number" && typeof workerCount === "number" && workerCount > inputBudget.max_workers) {
        problems.push("suggested_worker_count exceeds input max_workers");
      }
      if (decision.existing_run_reused !== true && /^[a-f0-9]{64}$/.test(inputDigest)) {
        const expectedRunId = `run_adaptive_${inputDigest.slice(0, 32)}`;
        if (selectedRunId !== expectedRunId) problems.push("selected_run_id does not match deterministic input_digest run ID");
      }
    }
    if (executionStatus === "blocked" && mode !== "single") problems.push("blocked execution must remain single");

    if (!Array.isArray(decision.reasons) || decision.reasons.length < 1 || decision.reasons.length > 16) {
      problems.push("decision.reasons must contain between 1 and 16 entries");
    } else {
      for (const item of decision.reasons) {
        const entry = asObject(item);
        if (typeof entry.code !== "string" || !entry.code.trim() || typeof entry.summary !== "string" || !entry.summary.trim()) {
          problems.push("each decision reason requires a non-empty code and summary");
          break;
        }
      }
    }

    if (problems.length > 0) {
      throw new Error(`Collaboration decision ${artifact.id} is invalid: ${problems.join("; ")}`);
    }
  }

  private view(artifact: StoredObject): CollaborationDecisionView {
    this.assertDecisionArtifact(artifact);
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
