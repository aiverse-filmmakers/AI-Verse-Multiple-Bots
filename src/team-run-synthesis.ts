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

const SYNTHESIS_CONTRACT = "synthesis-final-v1";
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "canceled"]);
const TERMINAL_WORKER_STATES = new Set(["completed", "failed", "canceled", "expired"]);
const SYNTHESIS_RUN_STATES = new Set<TeamRunStatus>(["running", "synthesizing", "verifying"]);
const OPTIMISTIC_RETRY_LIMIT = 4;
const DEFAULT_MAX_SOURCE_ARTIFACTS = 64;
const ABSOLUTE_MAX_SOURCE_ARTIFACTS = 256;

function nowIso(): string {
  return new Date().toISOString();
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

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
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

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export interface ScheduleSynthesisInput {
  runId: string;
  createdBy: string;
  sourceArtifactRefs?: string[];
  tools?: string[];
  connections?: string[];
  budget?: BudgetEnvelope;
  deadlineAt?: string;
  leaseExpiresAt?: string;
  recoveryPolicy?: RecoveryPolicy;
  maxAttempts?: number;
  maxSourceArtifacts?: number;
}

export type SynthesisScheduleResult =
  | { status: "existing"; run: StoredObject; task: StoredObject | null; artifact: StoredObject }
  | { status: "scheduled"; run: StoredObject; task: StoredObject; lease: StoredObject; sourceArtifactRefs: string[] };

export interface SynthesisReconcileResult {
  run: StoredObject;
  task: StoredObject;
  artifact: StoredObject | null;
  outcome: "completed" | "failed" | "canceled" | null;
  failureReason: string | null;
}

/**
 * Final Team Run synthesis coordinator.
 *
 * Synthesis is owned by the durable Team Run leader, not by a new temporary
 * Worker. Runtime output is treated as an untrusted draft. Only this coordinator
 * can create the canonical `synthesis_final` Artifact and point the Team Run at
 * it after verification debt and live squad work are both clear.
 */
export class TeamRunSynthesis {
  constructor(
    readonly teams: TeamRunCoordinator,
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue,
    readonly runner: BotRunner
  ) {}

  schedule(input: ScheduleSynthesisInput): SynthesisScheduleResult {
    let run = this.requireRun(input.runId);
    const leaderId = String(run.payload.leader_id ?? "");
    if (input.createdBy !== leaderId) throw new Error(`Only Team Run leader ${leaderId} can schedule synthesis for ${run.id}`);
    const leader = this.requireActiveLeader(leaderId, String(run.payload.workspace_id));

    const existingFinal = this.finalArtifact(run.id);
    if (existingFinal) {
      const taskId = typeof existingFinal.payload.task_id === "string" ? existingFinal.payload.task_id : null;
      const task = taskId ? this.gateway.store.getObject(taskId) : null;
      return { status: "existing", run, task: task?.kind === "task" ? task : null, artifact: existingFinal };
    }

    const runStatus = String(run.payload.status) as TeamRunStatus;
    if (!SYNTHESIS_RUN_STATES.has(runStatus)) throw new Error(`Team Run ${run.id} cannot synthesize from status ${runStatus}`);
    this.assertVerificationClear(run);

    const activeSynthesisTaskId = typeof run.payload.active_synthesis_task_id === "string" ? run.payload.active_synthesis_task_id : null;
    if (activeSynthesisTaskId) {
      const activeTask = this.gateway.store.getObject(activeSynthesisTaskId);
      if (activeTask?.kind === "task" && !TERMINAL_TASK_STATES.has(String(activeTask.payload.status))) {
        throw new Error(`Team Run ${run.id} already has active synthesis Task ${activeTask.id}`);
      }
      if (activeTask?.kind === "task") {
        const reconciled = this.reconcileTask(activeTask.id);
        const latestFinal = this.finalArtifact(run.id);
        if (latestFinal) return { status: "existing", run: this.requireRun(run.id), task: activeTask, artifact: latestFinal };
        if (reconciled?.outcome === null) throw new Error(`Team Run ${run.id} synthesis Task ${activeTask.id} has not settled`);
      }
      run = this.requireRun(run.id);
    }

    this.assertNoLiveWork(run);
    this.assertTaskCapacity(run);
    this.assertLeaderAuthority(leader, input.tools ?? [], input.connections ?? []);

    if (String(run.payload.status) !== "synthesizing") {
      run = this.teams.transitionRun(run.id, "synthesizing", leaderId, "Ready for canonical synthesis").run;
    }
    this.assertVerificationClear(run);

    const maxSources = this.normalizeSourceLimit(input.maxSourceArtifacts);
    const sourceArtifactRefs = input.sourceArtifactRefs === undefined
      ? this.defaultSourceArtifactRefs(run)
      : uniqueSorted(input.sourceArtifactRefs);
    if (sourceArtifactRefs.length === 0) throw new Error(`Team Run ${run.id} has no eligible source Artifacts to synthesize`);
    if (sourceArtifactRefs.length > maxSources) {
      throw new Error(`Team Run ${run.id} has ${sourceArtifactRefs.length} synthesis inputs; maximum is ${maxSources}. Select an explicit bounded subset.`);
    }
    const sourceArtifacts = sourceArtifactRefs.map((ref) => this.requireSynthesisSource(ref, run));
    const requiredConstraints = this.collectConstraints(run);
    const taskId = createId("task");
    const leaseId = createId("lease");
    const timestamp = nowIso();
    const budget = inheritBudget(run.payload.budget, input.budget);

    const leasePayload = validateProtocolObject({
      schema_version: "1.0",
      id: leaseId,
      type: "capability_lease",
      principal: leaderId,
      issued_to: leaderId,
      workspace_id: String(run.payload.workspace_id),
      task_id: taskId,
      tools: uniqueSorted(input.tools ?? []),
      connections: uniqueSorted(input.connections ?? []),
      destructive_actions: "deny",
      expires_at: input.leaseExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()
    }, "capability_lease");

    const taskPayload = validateProtocolObject({
      schema_version: "1.0",
      id: taskId,
      type: "task.delegate",
      created_by: leaderId,
      assignee_id: leaderId,
      owner_id: leaderId,
      workspace_id: String(run.payload.workspace_id),
      run_id: run.id,
      root_objective_id: String(run.payload.root_objective_id),
      parent_task_id: null,
      reason: `Produce one canonical final synthesis from ${sourceArtifactRefs.length} scoped Artifact(s)`,
      objective: this.synthesisObjective(run, sourceArtifactRefs),
      required_constraints: requiredConstraints,
      constraints_digest: constraintsDigest(requiredConstraints),
      expected_output: {
        contract: SYNTHESIS_CONTRACT,
        required_fields: ["contract", "result"],
        optional_fields: ["summary", "used_source_artifact_refs", "unresolved_items", "confidence"]
      },
      input_artifact_refs: sourceArtifacts.map((artifact) => artifact.id),
      lease_id: leaseId,
      environment_lease_id: null,
      response_target: { kind: "bot", id: leaderId },
      deadline_at: input.deadlineAt ?? null,
      budget,
      hop: 0,
      max_hops: typeof normalizeBudget(run.payload.budget).max_hops === "number" ? normalizeBudget(run.payload.budget).max_hops : 6,
      recovery_policy: input.recoveryPolicy ?? "retry_safe",
      max_attempts: Math.max(1, Math.floor(input.maxAttempts ?? 2)),
      synthesis_contract: SYNTHESIS_CONTRACT,
      synthesis_source_artifact_refs: sourceArtifactRefs,
      status: "assigned",
      created_at: timestamp
    }, "task");

    const updatedRunPayload = validateProtocolObject({
      ...run.payload,
      status: "synthesizing",
      active_synthesis_task_id: taskId,
      synthesis_task_ids: uniqueSorted([...stringArray(run.payload.synthesis_task_ids), taskId]),
      synthesis_source_artifact_refs: sourceArtifactRefs,
      synthesis_started_at: timestamp,
      synthesis_last_outcome: "running",
      synthesis_failure_reason: null,
      updated_at: timestamp
    }, "team_run");

    const mutation = this.gateway.store.atomicMutation({
      preconditions: [
        { id: run.id, kind: "team_run", status: "synthesizing", updatedAt: run.updatedAt },
        { id: leader.id, kind: "bot", status: "active" }
      ],
      objects: [
        { kind: "capability_lease", payload: leasePayload },
        { kind: "task", payload: taskPayload },
        { kind: "team_run", payload: updatedRunPayload }
      ],
      events: []
    });
    const lease = mutation.objects.find((object) => object.id === leaseId)!;
    const task = mutation.objects.find((object) => object.id === taskId)!;
    const updatedRun = mutation.objects.find((object) => object.id === run.id)!;

    try {
      this.queue.enqueueTask(task.id, leaderId, String(run.payload.workspace_id), {
        recoveryPolicy: input.recoveryPolicy ?? "retry_safe",
        maxAttempts: Math.max(1, Math.floor(input.maxAttempts ?? 2))
      });
    } catch (error) {
      this.failUnqueued(task, updatedRun, error instanceof Error ? error.message : String(error));
      throw error;
    }

    this.gateway.emit({
      type: "synthesis.scheduled",
      actorId: leaderId,
      workspaceId: String(run.payload.workspace_id),
      runId: run.id,
      taskId: task.id,
      correlationId: String(run.payload.root_objective_id),
      summary: `Scheduled canonical synthesis Task ${task.id} for durable leader ${leaderId}`,
      idempotencyKey: `synthesis:${task.id}:scheduled`
    });
    this.gateway.emit({
      type: "task.assigned",
      actorId: leaderId,
      workspaceId: String(run.payload.workspace_id),
      runId: run.id,
      taskId: task.id,
      correlationId: String(run.payload.root_objective_id),
      summary: `Assigned synthesis Task ${task.id} to ${leaderId}`
    });

    return { status: "scheduled", run: updatedRun, task, lease, sourceArtifactRefs };
  }

  reconcileTask(taskId: string): SynthesisReconcileResult | null {
    for (let attempt = 0; attempt < OPTIMISTIC_RETRY_LIMIT; attempt += 1) {
      const task = this.gateway.store.getObject(taskId);
      if (!task || task.kind !== "task" || task.payload.synthesis_contract !== SYNTHESIS_CONTRACT) return null;
      let run = this.requireRun(String(task.payload.run_id));
      const taskStatus = String(task.payload.status);

      const existingFinal = this.findFinalForTask(task.id, run);
      if (existingFinal) {
        run = this.ensureCompletedWithFinal(run, existingFinal);
        return { run, task, artifact: existingFinal, outcome: "completed", failureReason: null };
      }

      if (!TERMINAL_TASK_STATES.has(taskStatus)) {
        return { run, task, artifact: null, outcome: null, failureReason: null };
      }

      if (taskStatus === "failed" || taskStatus === "canceled") {
        const failureReason = String(task.payload.failure_reason ?? task.payload.cancel_reason ?? `Synthesis Task ${taskStatus}`);
        try {
          const updatedRunPayload = validateProtocolObject({
            ...run.payload,
            status: "synthesizing",
            active_synthesis_task_id: null,
            synthesis_last_outcome: taskStatus,
            synthesis_failure_reason: failureReason,
            synthesis_settled_at: nowIso(),
            updated_at: nowIso()
          }, "team_run");
          const mutation = this.gateway.store.atomicMutation({
            preconditions: [
              { id: run.id, kind: "team_run", status: String(run.payload.status), updatedAt: run.updatedAt },
              { id: task.id, kind: "task", status: taskStatus }
            ],
            objects: [{ kind: "team_run", payload: updatedRunPayload }],
            events: []
          });
          run = mutation.objects[0] ?? this.requireRun(run.id);
          this.emitSettled(run, task, taskStatus, null, failureReason);
          return { run, task, artifact: null, outcome: taskStatus as "failed" | "canceled", failureReason };
        } catch (error) {
          if (error instanceof Error && error.message.includes("changed since it was read") && attempt < OPTIMISTIC_RETRY_LIMIT - 1) continue;
          throw error;
        }
      }

      const rawArtifactId = stringArray(task.payload.output_artifact_refs)[0] ?? null;
      const rawArtifact = rawArtifactId ? this.gateway.store.getObject(rawArtifactId) : null;
      let parsed: { result: unknown; summary: string | null; usedSourceRefs: string[]; unresolvedItems: unknown[]; confidence: number | null };
      try {
        if (!rawArtifact || rawArtifact.kind !== "artifact") throw new Error("Completed synthesis Task has no runtime output Artifact");
        parsed = this.parseRuntimeSynthesis(rawArtifact, task, run);
      } catch (error) {
        const failureReason = error instanceof Error ? error.message : String(error);
        try {
          const updatedRunPayload = validateProtocolObject({
            ...run.payload,
            status: "synthesizing",
            active_synthesis_task_id: null,
            synthesis_last_outcome: "failed",
            synthesis_failure_reason: failureReason,
            synthesis_settled_at: nowIso(),
            updated_at: nowIso()
          }, "team_run");
          const mutation = this.gateway.store.atomicMutation({
            preconditions: [
              { id: run.id, kind: "team_run", status: String(run.payload.status), updatedAt: run.updatedAt },
              { id: task.id, kind: "task", status: "completed" }
            ],
            objects: [{ kind: "team_run", payload: updatedRunPayload }],
            events: []
          });
          run = mutation.objects[0] ?? this.requireRun(run.id);
          this.emitSettled(run, task, "failed", null, failureReason);
          return { run, task, artifact: null, outcome: "failed", failureReason };
        } catch (settleError) {
          if (settleError instanceof Error && settleError.message.includes("changed since it was read") && attempt < OPTIMISTIC_RETRY_LIMIT - 1) continue;
          throw settleError;
        }
      }

      this.assertVerificationClear(run);
      const sourceRefs = uniqueSorted(stringArray(task.payload.synthesis_source_artifact_refs));
      for (const ref of sourceRefs) this.requireSynthesisSource(ref, run);
      const finalMaterial = {
        contract: SYNTHESIS_CONTRACT,
        run_id: run.id,
        task_id: task.id,
        source_artifact_refs: sourceRefs,
        result: parsed.result,
        summary: parsed.summary,
        used_source_artifact_refs: parsed.usedSourceRefs,
        unresolved_items: parsed.unresolvedItems,
        confidence: parsed.confidence,
        raw_artifact_ref: rawArtifact!.id
      };
      const finalDigest = digest(finalMaterial);
      const finalId = `art_synthesis_${finalDigest.slice(0, 32)}`;
      const timestamp = nowIso();
      const disagreementRefs = stringArray(run.payload.disagreement_report_refs).filter((ref) => sourceRefs.includes(ref));
      const verificationVerdictRefs = stringArray(run.payload.verification_verdict_refs).filter((ref) => sourceRefs.includes(ref));
      const finalPayload = validateProtocolObject({
        schema_version: "1.0",
        id: finalId,
        type: "artifact",
        workspace_id: String(run.payload.workspace_id),
        created_by: String(run.payload.leader_id),
        run_id: run.id,
        task_id: task.id,
        media_type: "application/vnd.ai-verse.synthesis-final+json",
        kind: "synthesis_final",
        version: 1,
        content_ref: null,
        digest: finalDigest,
        root_objective_id: String(run.payload.root_objective_id),
        source_artifact_refs: sourceRefs,
        source_disagreement_report_refs: disagreementRefs,
        source_verification_verdict_refs: verificationVerdictRefs,
        inline_content: {
          contract: SYNTHESIS_CONTRACT,
          result: parsed.result,
          summary: parsed.summary,
          input_artifact_refs: sourceRefs,
          used_source_artifact_refs: parsed.usedSourceRefs,
          unresolved_items: parsed.unresolvedItems,
          confidence: parsed.confidence,
          raw_synthesis_artifact_ref: rawArtifact!.id
        },
        created_at: timestamp,
        provenance: {
          origin: "bot_generated",
          trusted_instruction: false,
          source_refs: uniqueSorted([...sourceRefs, rawArtifact!.id])
        }
      }, "artifact");
      const updatedRunPayload = validateProtocolObject({
        ...run.payload,
        active_synthesis_task_id: null,
        final_artifact_ref: finalId,
        latest_synthesis_artifact_ref: finalId,
        synthesis_artifact_refs: uniqueSorted([...stringArray(run.payload.synthesis_artifact_refs), finalId]),
        synthesis_last_outcome: "completed",
        synthesis_failure_reason: null,
        synthesis_settled_at: timestamp,
        updated_at: timestamp
      }, "team_run");

      try {
        const mutation = this.gateway.store.atomicMutation({
          preconditions: [
            { id: run.id, kind: "team_run", status: String(run.payload.status), updatedAt: run.updatedAt },
            { id: task.id, kind: "task", status: "completed" }
          ],
          objects: [
            { kind: "artifact", payload: finalPayload },
            { kind: "team_run", payload: updatedRunPayload }
          ],
          events: []
        });
        const artifact = mutation.objects.find((object) => object.id === finalId)!;
        run = mutation.objects.find((object) => object.id === run.id) ?? this.requireRun(run.id);
        run = this.ensureCompletedWithFinal(run, artifact);
        this.emitSettled(run, task, "completed", artifact, null);
        return { run, task, artifact, outcome: "completed", failureReason: null };
      } catch (error) {
        const existing = this.gateway.store.getObject(finalId);
        if (existing?.kind === "artifact" && existing.payload.kind === "synthesis_final" && existing.payload.run_id === run.id) {
          run = this.ensureCompletedWithFinal(this.requireRun(run.id), existing);
          return { run, task, artifact: existing, outcome: "completed", failureReason: null };
        }
        if (error instanceof Error && error.message.includes("changed since it was read") && attempt < OPTIMISTIC_RETRY_LIMIT - 1) continue;
        throw error;
      }
    }
    return null;
  }

  recoverPendingSyntheses(): SynthesisReconcileResult[] {
    const recovered: SynthesisReconcileResult[] = [];
    for (const run of this.teams.listRuns()) {
      const taskId = typeof run.payload.active_synthesis_task_id === "string" ? run.payload.active_synthesis_task_id : null;
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

  async cancel(runId: string, actorId: string, reason = "Synthesis canceled"): Promise<SynthesisReconcileResult | null> {
    const run = this.requireRun(runId);
    const leaderId = String(run.payload.leader_id ?? "");
    if (actorId !== leaderId && !actorId.startsWith("operator_")) throw new Error(`Only Team Run leader ${leaderId} or an operator can cancel synthesis work`);
    const taskId = typeof run.payload.active_synthesis_task_id === "string" ? run.payload.active_synthesis_task_id : null;
    if (!taskId) return null;
    const task = this.gateway.store.getObject(taskId);
    if (!task || task.kind !== "task") return null;
    if (!TERMINAL_TASK_STATES.has(String(task.payload.status))) {
      await this.runner.cancelTask(task.id, actorId.startsWith("operator_") ? actorId : leaderId, reason);
    }
    return this.reconcileTask(task.id);
  }

  finalArtifact(runId: string): StoredObject | null {
    const run = this.requireRun(runId);
    const ref = typeof run.payload.final_artifact_ref === "string" ? run.payload.final_artifact_ref : null;
    if (!ref) return null;
    const artifact = this.gateway.store.getObject(ref);
    return this.isFinalForRun(artifact, run) ? artifact : null;
  }

  list(runId: string): StoredObject[] {
    const run = this.requireRun(runId);
    return stringArray(run.payload.synthesis_artifact_refs)
      .map((ref) => this.gateway.store.getObject(ref))
      .filter((artifact): artifact is StoredObject => this.isFinalForRun(artifact, run));
  }

  private parseRuntimeSynthesis(rawArtifact: StoredObject, task: StoredObject, run: StoredObject) {
    if (rawArtifact.workspaceId !== run.workspaceId || String(rawArtifact.payload.run_id ?? "") !== run.id) {
      throw new Error("Synthesis runtime Artifact escaped Team Run scope");
    }
    if (String(rawArtifact.payload.task_id ?? "") !== task.id) throw new Error("Synthesis runtime Artifact is not scoped to the synthesis Task");
    const output = asObject(rawArtifact.payload.inline_content);
    if (output.contract !== SYNTHESIS_CONTRACT) throw new Error(`Synthesis output contract must be ${SYNTHESIS_CONTRACT}`);
    if (!hasOwn(output, "result")) throw new Error("Synthesis output is missing result");
    const expectedSources = uniqueSorted(stringArray(task.payload.synthesis_source_artifact_refs));
    const usedSourceRefs = output.used_source_artifact_refs === undefined
      ? []
      : uniqueSorted(stringArray(output.used_source_artifact_refs));
    for (const ref of usedSourceRefs) if (!expectedSources.includes(ref)) throw new Error(`Synthesis output cited unscoped source Artifact ${ref}`);
    const confidence = output.confidence === undefined || output.confidence === null ? null : Number(output.confidence);
    if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new Error("Synthesis confidence must be between 0 and 1");
    }
    const unresolvedItems = output.unresolved_items === undefined
      ? []
      : Array.isArray(output.unresolved_items) ? output.unresolved_items : (() => { throw new Error("Synthesis unresolved_items must be an array"); })();
    return {
      result: output.result,
      summary: typeof output.summary === "string" ? output.summary : null,
      usedSourceRefs,
      unresolvedItems,
      confidence
    };
  }

  private defaultSourceArtifactRefs(run: StoredObject): string[] {
    const refs: string[] = [];
    for (const task of this.gateway.store.listObjects("task", String(run.payload.workspace_id))) {
      if (String(task.payload.run_id ?? "") !== run.id || String(task.payload.status) !== "completed") continue;
      if (task.payload.verification_contract === "verifier-verdict-v1" || task.payload.synthesis_contract === SYNTHESIS_CONTRACT) continue;
      refs.push(...stringArray(task.payload.output_artifact_refs));
    }
    refs.push(...stringArray(run.payload.candidate_artifact_refs));
    for (const fanout of objectArray(run.payload.fanouts)) refs.push(...stringArray(fanout.artifact_refs));
    refs.push(...stringArray(run.payload.disagreement_report_refs));
    for (const verdictRef of stringArray(run.payload.verification_verdict_refs)) {
      const verdict = this.gateway.store.getObject(verdictRef);
      if (!verdict || verdict.kind !== "artifact" || verdict.payload.kind !== "verification_verdict") continue;
      const inline = asObject(verdict.payload.inline_content);
      if (stringArray(inline.resolved_report_refs).length > 0) refs.push(verdictRef);
    }
    return uniqueSorted(refs).filter((ref) => {
      try {
        this.requireSynthesisSource(ref, run);
        return true;
      } catch {
        return false;
      }
    });
  }

  private requireSynthesisSource(ref: string, run: StoredObject): StoredObject {
    const artifact = this.gateway.store.getObject(ref);
    if (!artifact || artifact.kind !== "artifact") throw new Error(`Synthesis source Artifact ${ref} not found`);
    if (artifact.workspaceId !== run.workspaceId || String(artifact.payload.run_id ?? "") !== run.id) {
      throw new Error(`Synthesis source Artifact ${ref} is outside Team Run ${run.id}`);
    }
    if (artifact.payload.kind === "synthesis_final") throw new Error(`Synthesis source Artifact ${ref} is already a final synthesis`);
    const taskId = typeof artifact.payload.task_id === "string" ? artifact.payload.task_id : null;
    if (taskId) {
      const task = this.gateway.store.getObject(taskId);
      if (task?.kind === "task" && task.payload.verification_contract === "verifier-verdict-v1" && artifact.payload.kind !== "verification_verdict") {
        throw new Error(`Raw verifier Artifact ${ref} cannot bypass the canonical verification verdict`);
      }
      if (task?.kind === "task" && task.payload.synthesis_contract === SYNTHESIS_CONTRACT) {
        throw new Error(`Raw synthesis Artifact ${ref} cannot become a synthesis source`);
      }
    }
    return artifact;
  }

  private collectConstraints(run: StoredObject): string[] {
    const values: string[] = [];
    for (const task of this.gateway.store.listObjects("task", String(run.payload.workspace_id))) {
      if (String(task.payload.run_id ?? "") !== run.id || task.payload.synthesis_contract === SYNTHESIS_CONTRACT) continue;
      values.push(...stringArray(task.payload.required_constraints));
    }
    return normalizeConstraints(values);
  }

  private assertVerificationClear(run: StoredObject): void {
    const debt = uniqueSorted(stringArray(run.payload.verification_required_report_refs));
    if (run.payload.requires_verification === true || debt.length > 0) {
      throw new Error(`Team Run ${run.id} cannot synthesize while verification debt remains${debt.length ? `: ${debt.join(", ")}` : ""}`);
    }
    const verificationTaskId = typeof run.payload.active_verification_task_id === "string" ? run.payload.active_verification_task_id : null;
    if (verificationTaskId) {
      const task = this.gateway.store.getObject(verificationTaskId);
      if (task?.kind === "task" && !TERMINAL_TASK_STATES.has(String(task.payload.status))) {
        throw new Error(`Team Run ${run.id} cannot synthesize while verifier Task ${verificationTaskId} is active`);
      }
    }
  }

  private assertNoLiveWork(run: StoredObject): void {
    const liveTasks = this.gateway.store.listObjects("task", String(run.payload.workspace_id)).filter((task) =>
      String(task.payload.run_id ?? "") === run.id && !TERMINAL_TASK_STATES.has(String(task.payload.status))
    );
    if (liveTasks.length > 0) throw new Error(`Team Run ${run.id} cannot synthesize while ${liveTasks.length} Task(s) remain live`);
    const activeWorkers = this.teams.listWorkers(run.id).filter((worker) => !TERMINAL_WORKER_STATES.has(String(worker.payload.status)));
    if (activeWorkers.length > 0) throw new Error(`Team Run ${run.id} cannot synthesize while ${activeWorkers.length} Worker(s) remain active`);
  }

  private assertTaskCapacity(run: StoredObject): void {
    const budget = normalizeBudget(run.payload.budget);
    if (typeof budget.max_tasks !== "number") return;
    const current = this.gateway.store.listObjects("task", String(run.payload.workspace_id)).filter((task) => String(task.payload.run_id ?? "") === run.id).length;
    if (current + 1 > budget.max_tasks) throw new Error(`Team Run ${run.id} has no remaining Task capacity for synthesis (${current}/${budget.max_tasks})`);
  }

  private assertLeaderAuthority(leader: StoredObject, tools: string[], connections: string[]): void {
    const permissions = asObject(leader.payload.permissions);
    const allowedTools = Array.isArray(permissions.allowed_tools) ? stringArray(permissions.allowed_tools) : null;
    const allowedConnections = Array.isArray(permissions.allowed_connections) ? stringArray(permissions.allowed_connections) : null;
    if (allowedTools && !allowedTools.includes("*")) for (const tool of tools) if (!allowedTools.includes(tool)) throw new Error(`Synthesis cannot expand leader tool authority to ${tool}`);
    if (allowedConnections && !allowedConnections.includes("*")) for (const connection of connections) if (!allowedConnections.includes(connection)) throw new Error(`Synthesis cannot expand leader connection authority to ${connection}`);
  }

  private synthesisObjective(run: StoredObject, refs: string[]): string {
    return [
      `Root objective: ${String(run.payload.objective ?? run.payload.root_objective_id)}.`,
      `Synthesize one final answer from exactly ${refs.length} scoped canonical input Artifact(s).`,
      "Respect all required constraints. Preserve material uncertainty and do not invent agreement where source evidence remains uncertain.",
      "Canonical verification verdicts override superseded conflicting candidate claims for the findings they explicitly resolve.",
      `Return JSON with contract=${SYNTHESIS_CONTRACT} and a result field. Optional: summary, used_source_artifact_refs, unresolved_items, confidence.`
    ].join("\n");
  }

  private ensureCompletedWithFinal(run: StoredObject, artifact: StoredObject): StoredObject {
    const latest = this.requireRun(run.id);
    if (String(latest.payload.final_artifact_ref ?? "") !== artifact.id) {
      throw new Error(`Team Run ${run.id} final Artifact pointer does not match ${artifact.id}`);
    }
    if (String(latest.payload.status) === "completed") return latest;
    this.assertVerificationClear(latest);
    try {
      return this.teams.transitionRun(latest.id, "completed", String(latest.payload.leader_id), `Canonical synthesis ${artifact.id} completed`).run;
    } catch (error) {
      const after = this.requireRun(latest.id);
      if (String(after.payload.status) === "completed" && String(after.payload.final_artifact_ref ?? "") === artifact.id) return after;
      throw error;
    }
  }

  private findFinalForTask(taskId: string, run: StoredObject): StoredObject | null {
    return this.gateway.store.listObjects("artifact", String(run.payload.workspace_id)).find((artifact) =>
      artifact.payload.kind === "synthesis_final" && artifact.payload.task_id === taskId && artifact.payload.run_id === run.id
    ) ?? null;
  }

  private isFinalForRun(artifact: StoredObject | null, run: StoredObject): artifact is StoredObject {
    return Boolean(artifact?.kind === "artifact" && artifact.payload.kind === "synthesis_final" && artifact.workspaceId === run.workspaceId && artifact.payload.run_id === run.id);
  }

  private normalizeSourceLimit(value: number | undefined): number {
    const resolved = value ?? DEFAULT_MAX_SOURCE_ARTIFACTS;
    if (!Number.isInteger(resolved) || resolved < 1 || resolved > ABSOLUTE_MAX_SOURCE_ARTIFACTS) {
      throw new Error(`maxSourceArtifacts must be an integer between 1 and ${ABSOLUTE_MAX_SOURCE_ARTIFACTS}`);
    }
    return resolved;
  }

  private requireRun(runId: string): StoredObject {
    const run = this.teams.getRun(runId);
    if (!run) throw new Error(`Team Run ${runId} not found`);
    return run;
  }

  private requireActiveLeader(leaderId: string, workspaceId: string): StoredObject {
    const leader = this.gateway.getBot(leaderId);
    if (!leader || leader.payload.status !== "active") throw new Error(`Team Run leader ${leaderId} is not active`);
    if (leader.workspaceId !== workspaceId) throw new Error(`Team Run leader ${leaderId} is outside workspace ${workspaceId}`);
    return leader;
  }

  private failUnqueued(task: StoredObject, run: StoredObject, reason: string): void {
    const timestamp = nowIso();
    const updatedRunPayload = validateProtocolObject({
      ...run.payload,
      active_synthesis_task_id: null,
      synthesis_last_outcome: "failed",
      synthesis_failure_reason: reason,
      synthesis_settled_at: timestamp,
      updated_at: timestamp
    }, "team_run");
    this.gateway.store.atomicMutation({
      preconditions: [
        { id: task.id, kind: "task", status: "assigned", ownerId: String(run.payload.leader_id) },
        { id: run.id, kind: "team_run", status: String(run.payload.status), updatedAt: run.updatedAt }
      ],
      objects: [
        { kind: "task", payload: validateProtocolObject({ ...task.payload, status: "failed", failed_at: timestamp, failure_reason: reason }, "task") },
        { kind: "team_run", payload: updatedRunPayload }
      ],
      events: []
    });
  }

  private emitSettled(run: StoredObject, task: StoredObject, outcome: "completed" | "failed" | "canceled", artifact: StoredObject | null, failureReason: string | null): void {
    this.gateway.emit({
      type: outcome === "completed" ? "synthesis.completed" : "synthesis.settled",
      actorId: String(run.payload.leader_id),
      workspaceId: String(run.payload.workspace_id),
      runId: run.id,
      taskId: task.id,
      correlationId: String(run.payload.root_objective_id),
      summary: outcome === "completed"
        ? `Canonical synthesis completed as ${artifact?.id}`
        : `Synthesis Task ${task.id} settled as ${outcome}: ${failureReason ?? "unknown reason"}`,
      attentionState: outcome === "completed" ? "unread_result" : "failed",
      idempotencyKey: `synthesis:${task.id}:${outcome}:${artifact?.id ?? "none"}`
    });
  }
}
