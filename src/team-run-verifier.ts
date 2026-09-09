import { createHash } from "node:crypto";
import { inheritBudget, normalizeBudget, type BudgetEnvelope } from "./budget.js";
import { constraintsDigest, normalizeConstraints } from "./constraints.js";
import { createId } from "./id.js";
import { ExecutionQueue, type RecoveryPolicy } from "./execution-queue.js";
import { CoordinationGateway } from "./gateway.js";
import { BotRunner } from "./runner.js";
import { TeamRunCoordinator, type TeamRunStatus } from "./team-runs.js";
import type { JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

const EXECUTABLE_RUN_STATES = new Set<TeamRunStatus>(["running", "synthesizing", "verifying"]);
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "canceled"]);
const REPORT_OUTCOMES = new Set(["resolved", "unresolved", "insufficient_evidence"]);
const FINDING_STATUSES = new Set(["resolved", "unresolved", "insufficient_evidence"]);
const OPTIMISTIC_RETRY_LIMIT = 4;

export type VerificationReportOutcome = "resolved" | "unresolved" | "insufficient_evidence";
export type VerificationOutcome = VerificationReportOutcome | "verifier_failed" | "canceled";

export interface ScheduleVerificationInput {
  runId: string;
  createdBy: string;
  reportRefs?: string[];
  workerId?: string;
  runtime?: JsonObject;
  execution?: JsonObject;
  tools?: string[];
  connections?: string[];
  budget?: BudgetEnvelope;
  deadlineAt?: string;
  leaseExpiresAt?: string;
  recoveryPolicy?: RecoveryPolicy;
  maxAttempts?: number;
}

export type VerificationScheduleResult =
  | { status: "skipped"; run: StoredObject; reason: string }
  | { status: "scheduled"; run: StoredObject; worker: StoredObject; task: StoredObject; lease: StoredObject; reportRefs: string[] };

export interface VerificationReconcileResult {
  run: StoredObject;
  task: StoredObject;
  verdict: StoredObject | null;
  outcome: VerificationOutcome | null;
  resolvedReportRefs: string[];
  remainingReportRefs: string[];
}

interface ParsedFindingVerdict {
  finding_id: string;
  status: "resolved" | "unresolved" | "insufficient_evidence";
  conclusion: string;
  preferred_artifact_refs: string[];
  rejected_artifact_refs: string[];
  evidence_artifact_refs: string[];
}

interface ParsedReportVerdict {
  report_id: string;
  outcome: VerificationReportOutcome;
  finding_verdicts: ParsedFindingVerdict[];
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) result[key] = canonical(source[key]);
    return result;
  }
  return String(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Bounded verifier/critic coordinator for Team Run disagreement reports.
 *
 * A verifier runtime may reason freely, but its output is not trusted to mutate
 * Team Run debt directly. This coordinator validates report/finding lineage and
 * creates the canonical verification verdict before resolving any debt entry.
 */
export class TeamRunVerifier {
  constructor(
    readonly teams: TeamRunCoordinator,
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue,
    readonly runner: BotRunner
  ) {}

  schedule(input: ScheduleVerificationInput): VerificationScheduleResult {
    const run = this.requireRun(input.runId);
    const leaderId = String(run.payload.leader_id ?? "");
    if (input.createdBy !== leaderId) throw new Error(`Only Team Run leader ${leaderId} can schedule verifier work for ${run.id}`);
    const leader = this.requireActiveLeader(leaderId, String(run.payload.workspace_id));
    const runStatus = String(run.payload.status) as TeamRunStatus;
    if (!EXECUTABLE_RUN_STATES.has(runStatus)) throw new Error(`Team Run ${run.id} cannot schedule verifier work from status ${runStatus}`);

    const activeTaskId = typeof run.payload.active_verification_task_id === "string" ? run.payload.active_verification_task_id : null;
    if (activeTaskId) {
      const activeTask = this.gateway.store.getObject(activeTaskId);
      if (activeTask?.kind === "task" && !TERMINAL_TASK_STATES.has(String(activeTask.payload.status))) {
        throw new Error(`Team Run ${run.id} already has active verifier Task ${activeTask.id}`);
      }
      if (activeTask?.kind === "task") this.reconcileTask(activeTask.id);
    }

    const latestRun = this.requireRun(run.id);
    const debtRefs = unique(stringArray(latestRun.payload.verification_required_report_refs));
    const requested = input.reportRefs === undefined ? debtRefs : unique(input.reportRefs);
    if (requested.length === 0) return { status: "skipped", run: latestRun, reason: "No unresolved verification-required disagreement reports" };
    for (const ref of requested) {
      if (!debtRefs.includes(ref)) throw new Error(`Disagreement report ${ref} is not pending verification debt on Team Run ${run.id}`);
    }

    const reports = requested.map((ref) => this.requireVerificationReport(ref, latestRun));
    this.assertLeaderAuthority(leader, input.tools ?? [], input.connections ?? []);
    this.assertWorkerCapacity(latestRun);

    const leaderExecution = asObject(leader.payload.execution);
    const leaderEnvironmentPolicy = typeof leaderExecution.environment_policy === "string" ? leaderExecution.environment_policy : null;
    if (!leaderEnvironmentPolicy) throw new Error(`Team Run leader ${leader.id} has no execution environment policy`);
    const executionOverride = input.execution ?? {};
    if (
      typeof executionOverride.environment_policy === "string"
      && executionOverride.environment_policy !== leaderEnvironmentPolicy
    ) {
      throw new Error(`Verifier Worker cannot change leader environment policy from ${leaderEnvironmentPolicy} to ${executionOverride.environment_policy}`);
    }
    const workerExecution: JsonObject = { ...leaderExecution, ...executionOverride, environment_policy: leaderEnvironmentPolicy };

    const workerId = input.workerId ?? createId("worker");
    if (!workerId.startsWith("worker_")) throw new Error(`Verifier Worker ID must start with worker_: ${workerId}`);
    if (this.gateway.store.getObject(workerId)) throw new Error(`Protocol object ${workerId} already exists`);
    const taskId = createId("task");
    const leaseId = createId("lease");
    const effectiveBudget = inheritBudget(latestRun.payload.budget, input.budget);
    const sourceArtifactRefs = this.verifierInputs(reports, latestRun);
    const requiredConstraints = this.verifierConstraints(sourceArtifactRefs, latestRun);
    const timestamp = nowIso();

    const workerPayload = validateProtocolObject({
      schema_version: "1.0",
      id: workerId,
      type: "worker",
      kind: "temporary",
      run_id: latestRun.id,
      task_id: taskId,
      created_by: leaderId,
      parent_owner_id: leaderId,
      workspace_id: String(latestRun.payload.workspace_id),
      role: {
        title: "Verifier / Critic",
        objective: "Evaluate explicit disagreement findings against scoped candidate evidence and return a structured verdict without expanding the original objective."
      },
      runtime: input.runtime ?? {},
      execution: workerExecution,
      capability_lease_id: leaseId,
      environment_lease_id: null,
      budget: effectiveBudget,
      verification_report_refs: requested,
      status: "ready",
      created_at: timestamp,
      updated_at: timestamp
    }, "worker");

    const leasePayload = validateProtocolObject({
      schema_version: "1.0",
      id: leaseId,
      type: "capability_lease",
      principal: leaderId,
      issued_to: workerId,
      workspace_id: String(latestRun.payload.workspace_id),
      task_id: taskId,
      tools: input.tools ?? [],
      connections: input.connections ?? [],
      destructive_actions: "deny",
      expires_at: input.leaseExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()
    }, "capability_lease");

    const taskPayload = validateProtocolObject({
      schema_version: "1.0",
      id: taskId,
      type: "task.delegate",
      created_by: leaderId,
      assignee_id: workerId,
      owner_id: workerId,
      workspace_id: String(latestRun.payload.workspace_id),
      run_id: latestRun.id,
      root_objective_id: String(latestRun.payload.root_objective_id),
      parent_task_id: null,
      reason: `Verify ${requested.length} unresolved disagreement report${requested.length === 1 ? "" : "s"}`,
      objective: this.verifierObjective(latestRun, requested),
      required_constraints: requiredConstraints,
      constraints_digest: constraintsDigest(requiredConstraints),
      expected_output: {
        contract: "verifier-verdict-v1",
        report_refs: requested,
        report_outcomes: ["resolved", "unresolved", "insufficient_evidence"],
        finding_statuses: ["resolved", "unresolved", "insufficient_evidence"],
        required_report_fields: ["report_id", "outcome", "finding_verdicts"],
        required_finding_fields: ["finding_id", "status", "conclusion"]
      },
      input_artifact_refs: sourceArtifactRefs,
      lease_id: leaseId,
      environment_lease_id: null,
      response_target: { kind: "bot", id: leaderId },
      deadline_at: input.deadlineAt ?? null,
      budget: effectiveBudget,
      hop: 0,
      max_hops: typeof normalizeBudget(latestRun.payload.budget).max_hops === "number" ? normalizeBudget(latestRun.payload.budget).max_hops : 6,
      recovery_policy: input.recoveryPolicy ?? "retry_safe",
      max_attempts: Math.max(1, Math.floor(input.maxAttempts ?? 2)),
      verification_report_refs: requested,
      verification_contract: "verifier-verdict-v1",
      status: "assigned",
      created_at: timestamp
    }, "task");

    const targetRunStatus: TeamRunStatus = "verifying";
    const updatedRunPayload = validateProtocolObject({
      ...latestRun.payload,
      status: targetRunStatus,
      participant_ids: unique([...stringArray(latestRun.payload.participant_ids), workerId]),
      active_verification_task_id: taskId,
      verification_task_ids: unique([...stringArray(latestRun.payload.verification_task_ids), taskId]),
      verification_pending_report_refs: requested,
      verification_started_at: timestamp,
      updated_at: timestamp
    }, "team_run");

    const mutation = this.gateway.store.atomicMutation({
      preconditions: [
        { id: latestRun.id, kind: "team_run", status: String(latestRun.payload.status), updatedAt: latestRun.updatedAt },
        { id: leader.id, kind: "bot", status: "active" }
      ],
      objects: [
        { kind: "worker", payload: workerPayload },
        { kind: "capability_lease", payload: leasePayload },
        { kind: "task", payload: taskPayload },
        { kind: "team_run", payload: updatedRunPayload }
      ],
      events: []
    });
    const worker = mutation.objects.find((object) => object.id === workerId)!;
    const lease = mutation.objects.find((object) => object.id === leaseId)!;
    const task = mutation.objects.find((object) => object.id === taskId)!;
    const updatedRun = mutation.objects.find((object) => object.id === latestRun.id)!;

    try {
      this.queue.enqueueTask(task.id, worker.id, String(updatedRun.payload.workspace_id), {
        recoveryPolicy: input.recoveryPolicy ?? "retry_safe",
        maxAttempts: Math.max(1, Math.floor(input.maxAttempts ?? 2))
      });
    } catch (error) {
      this.failUnqueued(task, worker, updatedRun, error instanceof Error ? error.message : String(error));
      throw error;
    }

    this.gateway.emit({
      type: "verification.scheduled",
      actorId: leaderId,
      workspaceId: String(updatedRun.payload.workspace_id),
      runId: updatedRun.id,
      taskId: task.id,
      correlationId: String(updatedRun.payload.root_objective_id),
      summary: `Scheduled verifier ${worker.id} for ${requested.length} disagreement report(s)`
    });
    this.gateway.emit({
      type: "task.assigned",
      actorId: leaderId,
      workspaceId: String(updatedRun.payload.workspace_id),
      runId: updatedRun.id,
      taskId: task.id,
      correlationId: String(updatedRun.payload.root_objective_id),
      summary: `Assigned bounded verifier Task ${task.id} to ${worker.id}`
    });
    return { status: "scheduled", run: updatedRun, worker, task, lease, reportRefs: requested };
  }

  reconcileTask(taskId: string): VerificationReconcileResult | null {
    for (let attempt = 0; attempt < OPTIMISTIC_RETRY_LIMIT; attempt += 1) {
      const task = this.gateway.store.getObject(taskId);
      if (!task || task.kind !== "task" || task.payload.verification_contract !== "verifier-verdict-v1") return null;
      const run = this.requireRun(String(task.payload.run_id));
      const status = String(task.payload.status);
      const reportRefs = unique(stringArray(task.payload.verification_report_refs));
      if (!TERMINAL_TASK_STATES.has(status)) {
        return { run, task, verdict: null, outcome: null, resolvedReportRefs: [], remainingReportRefs: stringArray(run.payload.verification_required_report_refs) };
      }

      const existingVerdict = this.findVerdictForTask(task.id, run);
      if (existingVerdict) return this.resultFromVerdict(run, task, existingVerdict);

      const rawArtifactId = stringArray(task.payload.output_artifact_refs)[0] ?? null;
      const rawArtifact = rawArtifactId ? this.gateway.store.getObject(rawArtifactId) : null;
      let outcome: VerificationOutcome;
      let reportVerdicts: JsonObject[];
      let failureReason: string | null = null;

      if (status === "canceled") {
        outcome = "canceled";
        reportVerdicts = reportRefs.map((report_id) => ({ report_id, outcome: "unresolved", finding_verdicts: [] }));
        failureReason = String(task.payload.cancel_reason ?? task.payload.failure_reason ?? "Verifier Task canceled");
      } else if (status === "failed") {
        outcome = "verifier_failed";
        reportVerdicts = reportRefs.map((report_id) => ({ report_id, outcome: "unresolved", finding_verdicts: [] }));
        failureReason = String(task.payload.failure_reason ?? "Verifier Task failed");
      } else {
        try {
          if (!rawArtifact || rawArtifact.kind !== "artifact") throw new Error("Completed verifier Task has no runtime output Artifact");
          const parsed = this.parseRuntimeVerdict(rawArtifact, reportRefs, run);
          reportVerdicts = parsed.map((verdict) => this.validateReportVerdict(verdict, run));
          outcome = this.aggregateOutcome(reportVerdicts);
        } catch (error) {
          outcome = "verifier_failed";
          reportVerdicts = reportRefs.map((report_id) => ({ report_id, outcome: "unresolved", finding_verdicts: [] }));
          failureReason = error instanceof Error ? error.message : String(error);
        }
      }

      const resolvedReportRefs = reportVerdicts
        .filter((item) => item.outcome === "resolved")
        .map((item) => String(item.report_id));
      const currentDebt = unique(stringArray(run.payload.verification_required_report_refs));
      const remainingReportRefs = currentDebt.filter((ref) => !resolvedReportRefs.includes(ref));
      const verdictMaterial = {
        contract: "verification-verdict-v1",
        task_id: task.id,
        run_id: run.id,
        report_refs: reportRefs,
        outcome,
        report_verdicts: reportVerdicts,
        raw_artifact_ref: rawArtifact?.id ?? null,
        failure_reason: failureReason
      };
      const verdictDigest = digest(verdictMaterial);
      const verdictId = `art_verification_${verdictDigest.slice(0, 32)}`;
      const timestamp = nowIso();
      const sourceRefs = unique([
        ...reportRefs,
        ...reportRefs.flatMap((ref) => stringArray(asObject(this.requireVerificationReport(ref, run).payload.inline_content).source_artifact_refs)),
        ...(rawArtifact ? [rawArtifact.id] : [])
      ]);
      const verdictPayload = validateProtocolObject({
        schema_version: "1.0",
        id: verdictId,
        type: "artifact",
        workspace_id: String(run.payload.workspace_id),
        created_by: String(task.payload.assignee_id),
        run_id: run.id,
        task_id: task.id,
        media_type: "application/vnd.ai-verse.verification-verdict+json",
        kind: "verification_verdict",
        version: 1,
        content_ref: null,
        digest: verdictDigest,
        source_disagreement_report_refs: reportRefs,
        inline_content: {
          contract: "verification-verdict-v1",
          outcome,
          report_verdicts: reportVerdicts,
          resolved_report_refs: resolvedReportRefs,
          remaining_verification_report_refs: remainingReportRefs,
          raw_verifier_artifact_ref: rawArtifact?.id ?? null,
          failure_reason: failureReason
        },
        created_at: timestamp,
        provenance: {
          origin: rawArtifact ? String(asObject(rawArtifact.payload.provenance).origin ?? "worker_generated") : "runtime_tool",
          trusted_instruction: false,
          source_refs: sourceRefs
        }
      }, "artifact");

      const nextStatus: TeamRunStatus = remainingReportRefs.length === 0 && status === "completed" && outcome === "resolved"
        ? "synthesizing"
        : "verifying";
      const updatedRunPayload = validateProtocolObject({
        ...run.payload,
        status: nextStatus,
        active_verification_task_id: null,
        verification_pending_report_refs: [],
        verification_required_report_refs: remainingReportRefs,
        requires_verification: remainingReportRefs.length > 0,
        resolved_verification_report_refs: unique([...stringArray(run.payload.resolved_verification_report_refs), ...resolvedReportRefs]),
        verification_verdict_refs: unique([...stringArray(run.payload.verification_verdict_refs), verdictId]),
        latest_verification_verdict_ref: verdictId,
        verification_last_outcome: outcome,
        verification_settled_at: timestamp,
        updated_at: timestamp
      }, "team_run");

      try {
        const mutation = this.gateway.store.atomicMutation({
          preconditions: [
            { id: run.id, kind: "team_run", status: String(run.payload.status), updatedAt: run.updatedAt },
            { id: task.id, kind: "task", status }
          ],
          objects: [
            { kind: "artifact", payload: verdictPayload },
            { kind: "team_run", payload: updatedRunPayload }
          ],
          events: []
        });
        const verdict = mutation.objects.find((object) => object.id === verdictId)!;
        const updatedRun = mutation.objects.find((object) => object.id === run.id)!;
        this.gateway.emit({
          type: "verification.settled",
          actorId: String(task.payload.assignee_id),
          workspaceId: String(run.payload.workspace_id),
          runId: run.id,
          taskId: task.id,
          correlationId: String(run.payload.root_objective_id),
          summary: `Verifier Task ${task.id} settled as ${outcome}; ${resolvedReportRefs.length} report(s) resolved`,
          attentionState: remainingReportRefs.length > 0 ? "unread_result" : undefined,
          idempotencyKey: `verification:${verdictId}:settled`
        });
        return { run: updatedRun, task, verdict, outcome, resolvedReportRefs, remainingReportRefs };
      } catch (error) {
        const existing = this.gateway.store.getObject(verdictId);
        if (existing?.kind === "artifact" && existing.payload.kind === "verification_verdict") {
          return this.resultFromVerdict(this.requireRun(run.id), task, existing);
        }
        if (error instanceof Error && error.message.includes("changed since it was read") && attempt < OPTIMISTIC_RETRY_LIMIT - 1) continue;
        throw error;
      }
    }
    return null;
  }

  recoverPendingVerifications(): VerificationReconcileResult[] {
    const recovered: VerificationReconcileResult[] = [];
    for (const run of this.teams.listRuns()) {
      const taskId = typeof run.payload.active_verification_task_id === "string" ? run.payload.active_verification_task_id : null;
      if (!taskId) continue;
      const task = this.gateway.store.getObject(taskId);
      if (!task || task.kind !== "task") continue;
      if (TERMINAL_TASK_STATES.has(String(task.payload.status))) {
        const settled = this.reconcileTask(task.id);
        if (settled) recovered.push(settled);
      } else if (task.payload.status === "assigned") {
        this.queue.enqueueTask(task.id, String(task.payload.assignee_id), String(task.payload.workspace_id), {
          recoveryPolicy: task.payload.recovery_policy === "manual" ? "manual" : "retry_safe",
          maxAttempts: Number(task.payload.max_attempts ?? 2)
        });
      }
    }
    return recovered;
  }

  async cancel(runId: string, actorId: string, reason = "Verifier canceled"): Promise<VerificationReconcileResult | null> {
    const run = this.requireRun(runId);
    const leaderId = String(run.payload.leader_id ?? "");
    if (actorId !== leaderId && !actorId.startsWith("operator_")) throw new Error(`Only Team Run leader ${leaderId} or an operator can cancel verifier work`);
    const taskId = typeof run.payload.active_verification_task_id === "string" ? run.payload.active_verification_task_id : null;
    if (!taskId) return null;
    const task = this.gateway.store.getObject(taskId);
    if (!task || task.kind !== "task") return null;
    if (!TERMINAL_TASK_STATES.has(String(task.payload.status))) {
      await this.runner.cancelTask(task.id, actorId.startsWith("operator_") ? actorId : leaderId, reason);
    }
    return this.reconcileTask(task.id);
  }

  latest(runId: string): StoredObject | null {
    const run = this.requireRun(runId);
    const ref = typeof run.payload.latest_verification_verdict_ref === "string" ? run.payload.latest_verification_verdict_ref : null;
    if (!ref) return null;
    const artifact = this.gateway.store.getObject(ref);
    return this.isVerdictForRun(artifact, run) ? artifact : null;
  }

  list(runId: string): StoredObject[] {
    const run = this.requireRun(runId);
    return stringArray(run.payload.verification_verdict_refs)
      .map((ref) => this.gateway.store.getObject(ref))
      .filter((artifact): artifact is StoredObject => this.isVerdictForRun(artifact, run));
  }

  private parseRuntimeVerdict(rawArtifact: StoredObject, expectedReportRefs: string[], run: StoredObject): ParsedReportVerdict[] {
    if (rawArtifact.workspaceId !== run.workspaceId || String(rawArtifact.payload.run_id ?? "") !== run.id) throw new Error("Verifier runtime Artifact escaped Team Run scope");
    const output = asObject(rawArtifact.payload.inline_content);
    if (output.contract !== "verifier-verdict-v1") throw new Error("Verifier output contract must be verifier-verdict-v1");
    const rawReports = objectArray(output.report_verdicts);
    if (rawReports.length !== expectedReportRefs.length) throw new Error(`Verifier returned ${rawReports.length} report verdicts for ${expectedReportRefs.length} requested reports`);
    const parsed = rawReports.map((item) => this.parseReportVerdict(item));
    const ids = parsed.map((item) => item.report_id);
    if (unique(ids).length !== ids.length) throw new Error("Verifier output contains duplicate report verdicts");
    for (const ref of expectedReportRefs) if (!ids.includes(ref)) throw new Error(`Verifier output omitted disagreement report ${ref}`);
    for (const ref of ids) if (!expectedReportRefs.includes(ref)) throw new Error(`Verifier output included unrequested disagreement report ${ref}`);
    return parsed;
  }

  private parseReportVerdict(value: JsonObject): ParsedReportVerdict {
    const reportId = typeof value.report_id === "string" ? value.report_id : "";
    const outcome = typeof value.outcome === "string" ? value.outcome : "";
    if (!reportId) throw new Error("Verifier report verdict is missing report_id");
    if (!REPORT_OUTCOMES.has(outcome)) throw new Error(`Unsupported verifier report outcome ${outcome}`);
    const findingVerdicts = objectArray(value.finding_verdicts).map((finding) => {
      const findingId = typeof finding.finding_id === "string" ? finding.finding_id : "";
      const status = typeof finding.status === "string" ? finding.status : "";
      const conclusion = typeof finding.conclusion === "string" ? finding.conclusion.trim() : "";
      if (!findingId) throw new Error(`Verifier report ${reportId} contains a finding without finding_id`);
      if (!FINDING_STATUSES.has(status)) throw new Error(`Verifier finding ${findingId} has unsupported status ${status}`);
      if (!conclusion) throw new Error(`Verifier finding ${findingId} must include a conclusion`);
      return {
        finding_id: findingId,
        status: status as ParsedFindingVerdict["status"],
        conclusion,
        preferred_artifact_refs: unique(stringArray(finding.preferred_artifact_refs)),
        rejected_artifact_refs: unique(stringArray(finding.rejected_artifact_refs)),
        evidence_artifact_refs: unique(stringArray(finding.evidence_artifact_refs))
      };
    });
    return { report_id: reportId, outcome: outcome as VerificationReportOutcome, finding_verdicts: findingVerdicts };
  }

  private validateReportVerdict(verdict: ParsedReportVerdict, run: StoredObject): JsonObject {
    const report = this.requireVerificationReport(verdict.report_id, run);
    const reportInline = asObject(report.payload.inline_content);
    const hardFindings = objectArray(reportInline.findings).filter((finding) => finding.kind !== "confidence_gap");
    const expectedFindingIds = hardFindings.map((finding) => String(finding.finding_id));
    const receivedFindingIds = verdict.finding_verdicts.map((finding) => finding.finding_id);
    if (unique(receivedFindingIds).length !== receivedFindingIds.length) throw new Error(`Verifier report ${report.id} contains duplicate finding verdicts`);
    for (const id of receivedFindingIds) if (!expectedFindingIds.includes(id)) throw new Error(`Verifier report ${report.id} references unknown finding ${id}`);
    for (const id of expectedFindingIds) if (!receivedFindingIds.includes(id)) throw new Error(`Verifier report ${report.id} omitted finding ${id}`);

    for (const finding of verdict.finding_verdicts) {
      for (const ref of [...finding.preferred_artifact_refs, ...finding.rejected_artifact_refs, ...finding.evidence_artifact_refs]) {
        this.requireScopedArtifact(ref, run);
      }
      if (finding.status === "resolved") {
        const hasResolutionEvidence = finding.preferred_artifact_refs.length > 0 || finding.rejected_artifact_refs.length > 0 || finding.evidence_artifact_refs.length > 0;
        if (!hasResolutionEvidence) throw new Error(`Resolved finding ${finding.finding_id} must cite scoped resolution evidence`);
      }
    }

    const allResolved = verdict.finding_verdicts.every((finding) => finding.status === "resolved");
    const hasUnresolved = verdict.finding_verdicts.some((finding) => finding.status === "unresolved");
    const hasInsufficient = verdict.finding_verdicts.some((finding) => finding.status === "insufficient_evidence");
    if (verdict.outcome === "resolved" && !allResolved) throw new Error(`Report ${report.id} cannot be resolved while a finding remains unresolved`);
    if (verdict.outcome === "unresolved" && !hasUnresolved) throw new Error(`Report ${report.id} outcome unresolved requires at least one unresolved finding`);
    if (verdict.outcome === "insufficient_evidence" && !hasInsufficient) throw new Error(`Report ${report.id} outcome insufficient_evidence requires at least one insufficient-evidence finding`);

    return {
      report_id: report.id,
      outcome: verdict.outcome,
      finding_verdicts: verdict.finding_verdicts
    };
  }

  private aggregateOutcome(reportVerdicts: JsonObject[]): VerificationOutcome {
    if (reportVerdicts.every((item) => item.outcome === "resolved")) return "resolved";
    if (reportVerdicts.some((item) => item.outcome === "unresolved")) return "unresolved";
    return "insufficient_evidence";
  }

  private verifierInputs(reports: StoredObject[], run: StoredObject): string[] {
    const refs = new Set<string>();
    for (const report of reports) {
      refs.add(report.id);
      const inline = asObject(report.payload.inline_content);
      for (const ref of unique([...stringArray(report.payload.source_artifact_refs), ...stringArray(inline.source_artifact_refs)])) {
        this.requireScopedArtifact(ref, run);
        refs.add(ref);
      }
    }
    return [...refs];
  }

  private verifierConstraints(inputRefs: string[], run: StoredObject): string[] {
    const constraints: string[] = [
      "Evaluate only the explicit disagreement findings and scoped evidence supplied to this verifier Task",
      "Do not expand the Team Run root objective or invent hidden reasoning from other agents",
      "Do not resolve a finding without citing same-TeamRun Artifact evidence",
      "Return exactly the verifier-verdict-v1 structured contract"
    ];
    for (const ref of inputRefs) {
      const artifact = this.gateway.store.getObject(ref);
      const taskId = artifact?.kind === "artifact" && typeof artifact.payload.task_id === "string" ? artifact.payload.task_id : null;
      if (!taskId) continue;
      const task = this.gateway.store.getObject(taskId);
      if (task?.kind === "task" && task.payload.run_id === run.id) constraints.push(...stringArray(task.payload.required_constraints));
    }
    return normalizeConstraints(constraints);
  }

  private verifierObjective(run: StoredObject, reportRefs: string[]): string {
    return [
      `Verify unresolved disagreement evidence for Team Run ${run.id}.`,
      `Root objective: ${String(run.payload.objective ?? run.payload.root_objective_id)}`,
      `Disagreement reports: ${reportRefs.join(", ")}.`,
      "For every hard finding in every report, decide whether it is resolved, unresolved, or lacks sufficient evidence.",
      "A resolved finding must cite scoped Artifact evidence. Do not clear unrelated disagreement reports.",
      "Return JSON with contract=verifier-verdict-v1 and report_verdicts[]."
    ].join("\n");
  }

  private requireVerificationReport(ref: string, run: StoredObject): StoredObject {
    const report = this.gateway.store.getObject(ref);
    if (!report || report.kind !== "artifact" || report.payload.kind !== "disagreement_report") throw new Error(`Disagreement report ${ref} not found`);
    if (report.workspaceId !== run.workspaceId || String(report.payload.run_id ?? "") !== run.id) throw new Error(`Disagreement report ${ref} is outside Team Run ${run.id}`);
    const inline = asObject(report.payload.inline_content);
    if (inline.requires_verification !== true) throw new Error(`Disagreement report ${ref} does not require verifier work`);
    return report;
  }

  private requireScopedArtifact(ref: string, run: StoredObject): StoredObject {
    const artifact = this.gateway.store.getObject(ref);
    if (!artifact || artifact.kind !== "artifact") throw new Error(`Verification evidence Artifact ${ref} not found`);
    if (artifact.workspaceId !== run.workspaceId || String(artifact.payload.run_id ?? "") !== run.id) throw new Error(`Verification evidence Artifact ${ref} escaped Team Run ${run.id}`);
    return artifact;
  }

  private assertWorkerCapacity(run: StoredObject): void {
    const budget = normalizeBudget(run.payload.budget);
    if (typeof budget.max_workers !== "number") return;
    const workers = this.teams.listWorkers(run.id).filter((worker) => worker.payload.status !== "expired");
    if (workers.length >= budget.max_workers) throw new Error(`Team Run ${run.id} has no remaining temporary Worker capacity for verifier work (${workers.length}/${budget.max_workers})`);
  }

  private assertLeaderAuthority(leader: StoredObject, tools: string[], connections: string[]): void {
    const permissions = asObject(leader.payload.permissions);
    if (permissions.can_create_workers === false) throw new Error(`Team Run leader ${leader.id} cannot create verifier Workers`);
    const allowedTools = Array.isArray(permissions.allowed_tools) ? stringArray(permissions.allowed_tools) : null;
    const allowedConnections = Array.isArray(permissions.allowed_connections) ? stringArray(permissions.allowed_connections) : null;
    if (allowedTools && !allowedTools.includes("*")) for (const tool of tools) if (!allowedTools.includes(tool)) throw new Error(`Verifier Worker cannot expand leader tool authority to ${tool}`);
    if (allowedConnections && !allowedConnections.includes("*")) for (const connection of connections) if (!allowedConnections.includes(connection)) throw new Error(`Verifier Worker cannot expand leader connection authority to ${connection}`);
  }

  private requireActiveLeader(leaderId: string, workspaceId: string): StoredObject {
    const leader = this.gateway.getBot(leaderId);
    if (!leader || leader.payload.status !== "active") throw new Error(`Team Run leader ${leaderId} is not active`);
    if (leader.workspaceId !== workspaceId) throw new Error(`Team Run leader ${leaderId} is outside workspace ${workspaceId}`);
    return leader;
  }

  private findVerdictForTask(taskId: string, run: StoredObject): StoredObject | null {
    return this.gateway.store.listObjects("artifact", String(run.workspaceId)).find((artifact) =>
      artifact.payload.kind === "verification_verdict" && artifact.payload.task_id === taskId && artifact.payload.run_id === run.id
    ) ?? null;
  }

  private resultFromVerdict(run: StoredObject, task: StoredObject, verdict: StoredObject): VerificationReconcileResult {
    const inline = asObject(verdict.payload.inline_content);
    return {
      run: this.requireRun(run.id),
      task,
      verdict,
      outcome: String(inline.outcome) as VerificationOutcome,
      resolvedReportRefs: stringArray(inline.resolved_report_refs),
      remainingReportRefs: stringArray(inline.remaining_verification_report_refs)
    };
  }

  private isVerdictForRun(artifact: StoredObject | null, run: StoredObject): artifact is StoredObject {
    return Boolean(artifact?.kind === "artifact" && artifact.payload.kind === "verification_verdict" && artifact.workspaceId === run.workspaceId && artifact.payload.run_id === run.id);
  }

  private failUnqueued(task: StoredObject, worker: StoredObject, run: StoredObject, reason: string): void {
    const timestamp = nowIso();
    const updatedRun = validateProtocolObject({
      ...run.payload,
      active_verification_task_id: null,
      verification_pending_report_refs: [],
      verification_last_outcome: "verifier_failed",
      updated_at: timestamp
    }, "team_run");
    this.gateway.store.atomicMutation({
      preconditions: [
        { id: task.id, kind: "task", status: "assigned", ownerId: worker.id },
        { id: worker.id, kind: "worker", status: "ready" },
        { id: run.id, kind: "team_run", status: String(run.payload.status), updatedAt: run.updatedAt }
      ],
      objects: [
        { kind: "task", payload: validateProtocolObject({ ...task.payload, status: "failed", failed_at: timestamp, failure_reason: reason }, "task") },
        { kind: "worker", payload: validateProtocolObject({ ...worker.payload, status: "failed", failed_at: timestamp, terminal_at: timestamp, status_reason: reason, updated_at: timestamp }, "worker") },
        { kind: "team_run", payload: updatedRun }
      ],
      events: []
    });
  }

  private requireRun(runId: string): StoredObject {
    const run = this.teams.getRun(runId);
    if (!run) throw new Error(`Team Run ${runId} not found`);
    return run;
  }
}
