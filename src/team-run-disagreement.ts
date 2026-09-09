import { createHash } from "node:crypto";
import { BudgetError } from "./budget.js";
import type { CoordinationGateway } from "./gateway.js";
import type { TeamRunCoordinator } from "./team-runs.js";
import type { JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

const ANALYZABLE_RUN_STATES = new Set(["running", "synthesizing", "verifying"]);
const CLAIM_KINDS = new Set<ClaimKind>(["fact", "constraint", "recommendation", "estimate", "opinion"]);
const STANCES = new Set<ClaimStance>(["support", "oppose", "neutral"]);
const RELATIONS = new Set<ClaimRelation>(["exclusive", "compatible"]);
const DEFAULT_MAX_ARTIFACTS = 32;
const ABSOLUTE_MAX_ARTIFACTS = 128;
const MAX_CLAIMS_PER_ARTIFACT = 64;
const MAX_TOTAL_CLAIMS = 512;
const OPTIMISTIC_RETRY_LIMIT = 4;

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

export type ClaimKind = "fact" | "constraint" | "recommendation" | "estimate" | "opinion";
export type ClaimStance = "support" | "oppose" | "neutral";
export type ClaimRelation = "exclusive" | "compatible";
export type DisagreementFindingKind = "contradiction" | "evidence_conflict" | "incompatible_recommendation" | "confidence_gap";
export type DisagreementStatus = "conflict" | "confidence_gap" | "compatible" | "insufficient_evidence";

export interface AnalyzeDisagreementInput {
  runId: string;
  actorId: string;
  artifactRefs?: string[];
  confidenceGapThreshold?: number;
  maxArtifacts?: number;
}

export interface DisagreementFinding extends JsonObject {
  finding_id: string;
  kind: DisagreementFindingKind;
  severity: "low" | "medium" | "high";
  subject: string;
  artifact_refs: string[];
  claim_refs: string[];
  values: CanonicalValue[];
  confidence_delta?: number;
  rationale_code: string;
}

export interface DisagreementAnalysisResult {
  run: StoredObject;
  report: StoredObject;
  status: DisagreementStatus;
  requiresVerification: boolean;
  findings: DisagreementFinding[];
}

interface NormalizedClaim {
  ref: string;
  artifactRef: string;
  subject: string;
  normalizedSubject: string;
  kind: ClaimKind;
  hasValue: boolean;
  value: CanonicalValue;
  valueKey: string;
  stance: ClaimStance | null;
  confidence: number | null;
  evidenceRefs: string[];
  exclusiveGroup: string | null;
  relation: ClaimRelation | null;
  tolerance: number | null;
}

interface ExtractionResult {
  claims: NormalizedClaim[];
  invalidClaims: Array<{ artifact_ref: string; claim_index: number; reason: string }>;
}

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
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeSubject(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function canonicalize(value: unknown): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(source).sort()) result[key] = canonicalize(source[key]);
    return result;
  }
  return String(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function finiteConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function finiteTolerance(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function oppositeStance(left: ClaimStance | null, right: ClaimStance | null): boolean {
  return (left === "support" && right === "oppose") || (left === "oppose" && right === "support");
}

/**
 * Deterministic disagreement analysis over explicit structured claims in
 * candidate Artifacts. It never infers hidden reasoning or asks a model to
 * expose chain-of-thought; unsupported/unstructured content is reported as
 * insufficient evidence instead of being guessed at.
 */
export class TeamRunDisagreementDetector {
  constructor(
    readonly teams: TeamRunCoordinator,
    readonly gateway: CoordinationGateway
  ) {}

  analyze(input: AnalyzeDisagreementInput): DisagreementAnalysisResult {
    const threshold = input.confidenceGapThreshold ?? 0.35;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new Error("confidenceGapThreshold must be between 0 and 1");
    }
    const maxArtifacts = input.maxArtifacts ?? DEFAULT_MAX_ARTIFACTS;
    if (!Number.isInteger(maxArtifacts) || maxArtifacts < 1 || maxArtifacts > ABSOLUTE_MAX_ARTIFACTS) {
      throw new Error(`maxArtifacts must be an integer between 1 and ${ABSOLUTE_MAX_ARTIFACTS}`);
    }

    for (let attempt = 0; attempt < OPTIMISTIC_RETRY_LIMIT; attempt += 1) {
      const run = this.requireRun(input.runId);
      this.assertActor(run, input.actorId);
      if (!ANALYZABLE_RUN_STATES.has(String(run.payload.status))) {
        throw new Error(`Team Run ${run.id} cannot analyze disagreement from status ${String(run.payload.status)}`);
      }

      const refs = uniqueSorted(input.artifactRefs ?? stringArray(run.payload.candidate_artifact_refs));
      if (refs.length > maxArtifacts) {
        throw new BudgetError(
          "DISAGREEMENT_INPUT_LIMIT",
          `Disagreement analysis received ${refs.length} candidate Artifacts; maximum for this comparison is ${maxArtifacts}`
        );
      }

      const artifacts = refs.map((ref) => this.requireCandidateArtifact(ref, run));
      const extraction = this.extractClaims(artifacts);
      if (extraction.claims.length > MAX_TOTAL_CLAIMS) {
        throw new BudgetError(
          "DISAGREEMENT_CLAIM_LIMIT",
          `Disagreement analysis extracted ${extraction.claims.length} claims; maximum is ${MAX_TOTAL_CLAIMS}`
        );
      }

      const comparison = this.compare(extraction.claims, artifacts.length, threshold);
      const digest = this.analysisDigest(run, artifacts, extraction.claims, threshold);
      const reportId = `art_disagreement_${digest.slice(0, 32)}`;
      const existing = this.gateway.store.getObject(reportId);
      if (existing) {
        if (!this.isReportForRun(existing, run)) {
          throw new Error(`Deterministic disagreement report ID ${reportId} is already bound to another object`);
        }
        this.emitAnalysis(existing, input.actorId, run);
        return this.result(run, existing);
      }

      const timestamp = nowIso();
      const reportPayload = validateProtocolObject({
        schema_version: "1.0",
        id: reportId,
        type: "artifact",
        workspace_id: String(run.payload.workspace_id),
        created_by: input.actorId,
        run_id: run.id,
        task_id: null,
        kind: "disagreement_report",
        version: 1,
        content_ref: null,
        digest,
        analysis_digest: digest,
        source_artifact_refs: refs,
        root_objective_id: String(run.payload.root_objective_id),
        inline_content: {
          contract: "disagreement-report-v1",
          method: "deterministic-structured-claim-comparison-v1",
          status: comparison.status,
          requires_verification: comparison.requiresVerification,
          recommended_action: comparison.recommendedAction,
          source_artifact_refs: refs,
          analyzed_artifact_count: artifacts.length,
          analyzed_claim_count: extraction.claims.length,
          comparable_pair_count: comparison.comparablePairCount,
          confidence_gap_threshold: threshold,
          findings: comparison.findings,
          compatible_subjects: comparison.compatibleSubjects,
          invalid_claims: extraction.invalidClaims,
          claim_contract: {
            container: "inline_content.claims[]",
            required: ["subject|key|topic"],
            supported_kinds: [...CLAIM_KINDS].sort(),
            optional: ["id", "value|position", "stance", "confidence", "evidence_refs", "exclusive_group", "relation", "tolerance"]
          }
        },
        provenance: {
          origin: "runtime_tool",
          trusted_instruction: false,
          source_refs: refs
        },
        created_at: timestamp
      }, "artifact");

      const verificationDebt = comparison.requiresVerification
        ? uniqueSorted([...stringArray(run.payload.verification_required_report_refs), reportId])
        : uniqueSorted(stringArray(run.payload.verification_required_report_refs));
      const runPayload = validateProtocolObject({
        ...run.payload,
        disagreement_report_refs: uniqueSorted([...stringArray(run.payload.disagreement_report_refs), reportId]),
        latest_disagreement_report_ref: reportId,
        disagreement_status: comparison.status,
        requires_verification: run.payload.requires_verification === true || comparison.requiresVerification,
        verification_required_report_refs: verificationDebt,
        disagreement_analyzed_at: timestamp,
        updated_at: timestamp
      }, "team_run");

      try {
        const mutation = this.gateway.store.atomicMutation({
          preconditions: [{ id: run.id, kind: "team_run", status: String(run.payload.status), updatedAt: run.updatedAt }],
          objects: [
            { kind: "artifact", payload: reportPayload },
            { kind: "team_run", payload: runPayload }
          ],
          events: []
        });
        const report = mutation.objects.find((object) => object.id === reportId);
        const updatedRun = mutation.objects.find((object) => object.id === run.id);
        if (!report || !updatedRun) throw new Error(`Disagreement analysis for ${run.id} committed without expected records`);
        this.emitAnalysis(report, input.actorId, updatedRun);
        return this.result(updatedRun, report);
      } catch (error) {
        if (error instanceof Error && error.message.includes("changed since it was read") && attempt < OPTIMISTIC_RETRY_LIMIT - 1) continue;
        throw error;
      }
    }

    throw new Error(`Team Run ${input.runId} disagreement analysis could not settle after optimistic retries`);
  }

  latest(runId: string): StoredObject | null {
    const run = this.requireRun(runId);
    const ref = typeof run.payload.latest_disagreement_report_ref === "string" ? run.payload.latest_disagreement_report_ref : null;
    if (!ref) return null;
    const report = this.gateway.store.getObject(ref);
    return this.isReportForRun(report, run) ? report : null;
  }

  list(runId: string): StoredObject[] {
    const run = this.requireRun(runId);
    return stringArray(run.payload.disagreement_report_refs)
      .map((ref) => this.gateway.store.getObject(ref))
      .filter((report): report is StoredObject => this.isReportForRun(report, run));
  }

  verificationDebt(runId: string): StoredObject[] {
    const run = this.requireRun(runId);
    return stringArray(run.payload.verification_required_report_refs)
      .map((ref) => this.gateway.store.getObject(ref))
      .filter((report): report is StoredObject => this.isReportForRun(report, run));
  }

  private extractClaims(artifacts: StoredObject[]): ExtractionResult {
    const claims: NormalizedClaim[] = [];
    const invalidClaims: Array<{ artifact_ref: string; claim_index: number; reason: string }> = [];

    for (const artifact of artifacts) {
      const rawClaims = objectArray(asObject(artifact.payload.inline_content).claims);
      if (rawClaims.length > MAX_CLAIMS_PER_ARTIFACT) {
        throw new BudgetError(
          "DISAGREEMENT_CLAIM_LIMIT",
          `Artifact ${artifact.id} exposes ${rawClaims.length} claims; maximum is ${MAX_CLAIMS_PER_ARTIFACT}`
        );
      }

      for (let index = 0; index < rawClaims.length; index += 1) {
        const raw = rawClaims[index]!;
        const subjectValue = raw.subject ?? raw.key ?? raw.topic;
        if (typeof subjectValue !== "string" || !subjectValue.trim()) {
          invalidClaims.push({ artifact_ref: artifact.id, claim_index: index, reason: "missing_subject" });
          continue;
        }
        const kindValue = typeof raw.kind === "string" ? raw.kind : "opinion";
        if (!CLAIM_KINDS.has(kindValue as ClaimKind)) {
          invalidClaims.push({ artifact_ref: artifact.id, claim_index: index, reason: `unsupported_kind:${kindValue}` });
          continue;
        }
        const stanceValue = typeof raw.stance === "string" ? raw.stance : null;
        if (stanceValue !== null && !STANCES.has(stanceValue as ClaimStance)) {
          invalidClaims.push({ artifact_ref: artifact.id, claim_index: index, reason: `unsupported_stance:${stanceValue}` });
          continue;
        }
        const relationValue = typeof raw.relation === "string" ? raw.relation : null;
        if (relationValue !== null && !RELATIONS.has(relationValue as ClaimRelation)) {
          invalidClaims.push({ artifact_ref: artifact.id, claim_index: index, reason: `unsupported_relation:${relationValue}` });
          continue;
        }
        if (raw.confidence !== undefined && finiteConfidence(raw.confidence) === null) {
          invalidClaims.push({ artifact_ref: artifact.id, claim_index: index, reason: "invalid_confidence" });
          continue;
        }
        if (raw.tolerance !== undefined && finiteTolerance(raw.tolerance) === null) {
          invalidClaims.push({ artifact_ref: artifact.id, claim_index: index, reason: "invalid_tolerance" });
          continue;
        }

        const hasValue = hasOwn(raw, "value") || hasOwn(raw, "position");
        const value = canonicalize(hasOwn(raw, "value") ? raw.value : hasOwn(raw, "position") ? raw.position : null);
        const localRef = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `claim-${index}`;
        claims.push({
          ref: `${artifact.id}#${localRef}`,
          artifactRef: artifact.id,
          subject: subjectValue.trim(),
          normalizedSubject: normalizeSubject(subjectValue),
          kind: kindValue as ClaimKind,
          hasValue,
          value,
          valueKey: canonicalJson(value),
          stance: stanceValue as ClaimStance | null,
          confidence: finiteConfidence(raw.confidence),
          evidenceRefs: uniqueSorted(stringArray(raw.evidence_refs)),
          exclusiveGroup: typeof raw.exclusive_group === "string" && raw.exclusive_group.trim() ? raw.exclusive_group.trim() : null,
          relation: relationValue as ClaimRelation | null,
          tolerance: finiteTolerance(raw.tolerance)
        });
      }
    }

    return { claims, invalidClaims };
  }

  private compare(claims: NormalizedClaim[], artifactCount: number, confidenceGapThreshold: number) {
    const findings: DisagreementFinding[] = [];
    const comparableSubjects = new Set<string>();
    const conflictedSubjects = new Set<string>();
    let comparablePairCount = 0;

    for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
      const left = claims[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
        const right = claims[rightIndex]!;
        if (left.artifactRef === right.artifactRef) continue;
        if (left.normalizedSubject !== right.normalizedSubject || left.kind !== right.kind) continue;
        comparablePairCount += 1;
        comparableSubjects.add(left.normalizedSubject);

        const artifactRefs = uniqueSorted([left.artifactRef, right.artifactRef]);
        const claimRefs = uniqueSorted([left.ref, right.ref]);
        let hardConflict = false;

        if (oppositeStance(left.stance, right.stance) && (!left.hasValue || !right.hasValue || left.valueKey === right.valueKey)) {
          findings.push(this.finding("contradiction", "high", left.subject, artifactRefs, claimRefs, [left.value, right.value], "opposed_stance_same_claim"));
          hardConflict = true;
        } else if ((left.kind === "fact" || left.kind === "constraint") && left.hasValue && right.hasValue && left.valueKey !== right.valueKey) {
          findings.push(this.finding(
            left.kind === "fact" ? "evidence_conflict" : "contradiction",
            "high",
            left.subject,
            artifactRefs,
            claimRefs,
            [left.value, right.value],
            left.kind === "fact" ? "same_fact_different_value" : "same_constraint_different_value"
          ));
          hardConflict = true;
        } else if (left.kind === "recommendation" && left.hasValue && right.hasValue && left.valueKey !== right.valueKey) {
          const explicitlyCompatible = left.relation === "compatible" || right.relation === "compatible";
          const sameExclusiveGroup = Boolean(left.exclusiveGroup && right.exclusiveGroup && left.exclusiveGroup === right.exclusiveGroup);
          const explicitlyExclusive = left.relation === "exclusive" && right.relation === "exclusive";
          if (!explicitlyCompatible && (sameExclusiveGroup || explicitlyExclusive)) {
            findings.push(this.finding("incompatible_recommendation", "medium", left.subject, artifactRefs, claimRefs, [left.value, right.value], "exclusive_recommendations_differ"));
            hardConflict = true;
          }
        } else if (left.kind === "estimate" && left.hasValue && right.hasValue && typeof left.value === "number" && typeof right.value === "number") {
          if (left.tolerance !== null || right.tolerance !== null) {
            const tolerance = Math.max(left.tolerance ?? 0, right.tolerance ?? 0);
            if (Math.abs(left.value - right.value) > tolerance) {
              findings.push(this.finding("evidence_conflict", "medium", left.subject, artifactRefs, claimRefs, [left.value, right.value], "estimate_gap_exceeds_declared_tolerance"));
              hardConflict = true;
            }
          }
        }

        if (hardConflict) {
          conflictedSubjects.add(left.normalizedSubject);
          continue;
        }

        if (left.valueKey === right.valueKey && left.confidence !== null && right.confidence !== null) {
          const delta = Math.abs(left.confidence - right.confidence);
          if (delta >= confidenceGapThreshold) {
            findings.push({
              ...this.finding("confidence_gap", delta >= 0.6 ? "medium" : "low", left.subject, artifactRefs, claimRefs, [left.value], "same_claim_material_confidence_gap"),
              confidence_delta: Number(delta.toFixed(6))
            });
          }
        }
      }
    }

    findings.sort((left, right) => left.finding_id.localeCompare(right.finding_id));
    const hardFindings = findings.filter((finding) => finding.kind !== "confidence_gap");
    const confidenceFindings = findings.filter((finding) => finding.kind === "confidence_gap");
    const status: DisagreementStatus = hardFindings.length > 0
      ? "conflict"
      : confidenceFindings.length > 0
        ? "confidence_gap"
        : artifactCount < 2 || comparablePairCount === 0
          ? "insufficient_evidence"
          : "compatible";

    const recommendedAction = status === "conflict"
      ? "verify"
      : status === "confidence_gap"
        ? "review_confidence"
        : status === "compatible"
          ? "synthesize"
          : "collect_more_evidence";

    return {
      findings,
      status,
      requiresVerification: hardFindings.length > 0,
      recommendedAction,
      comparablePairCount,
      compatibleSubjects: [...comparableSubjects].filter((subject) => !conflictedSubjects.has(subject)).sort()
    };
  }

  private finding(
    kind: DisagreementFindingKind,
    severity: "low" | "medium" | "high",
    subject: string,
    artifactRefs: string[],
    claimRefs: string[],
    values: CanonicalValue[],
    rationaleCode: string
  ): DisagreementFinding {
    const digest = createHash("sha256")
      .update(canonicalJson({ kind, subject: normalizeSubject(subject), artifactRefs, claimRefs, values, rationaleCode }))
      .digest("hex")
      .slice(0, 16);
    return {
      finding_id: `finding_${digest}`,
      kind,
      severity,
      subject,
      artifact_refs: artifactRefs,
      claim_refs: claimRefs,
      values,
      rationale_code: rationaleCode
    };
  }

  private analysisDigest(run: StoredObject, artifacts: StoredObject[], claims: NormalizedClaim[], threshold: number): string {
    const material = {
      contract: "disagreement-analysis-digest-v1",
      run_id: run.id,
      root_objective_id: String(run.payload.root_objective_id),
      confidence_gap_threshold: threshold,
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        digest: artifact.payload.digest ?? null,
        inline_content: artifact.payload.inline_content ?? null,
        provenance: artifact.payload.provenance ?? null
      })).sort((left, right) => left.id.localeCompare(right.id)),
      claims: claims.map((claim) => ({
        ref: claim.ref,
        artifact_ref: claim.artifactRef,
        subject: claim.normalizedSubject,
        kind: claim.kind,
        value: claim.value,
        stance: claim.stance,
        confidence: claim.confidence,
        evidence_refs: claim.evidenceRefs,
        exclusive_group: claim.exclusiveGroup,
        relation: claim.relation,
        tolerance: claim.tolerance
      })).sort((left, right) => `${left.artifact_ref}:${left.ref}`.localeCompare(`${right.artifact_ref}:${right.ref}`))
    };
    return createHash("sha256").update(canonicalJson(material)).digest("hex");
  }

  private emitAnalysis(report: StoredObject, actorId: string, run: StoredObject): void {
    const inline = asObject(report.payload.inline_content);
    this.gateway.emit({
      type: "disagreement.analyzed",
      actorId,
      workspaceId: String(run.payload.workspace_id),
      runId: run.id,
      correlationId: String(run.payload.root_objective_id),
      summary: `Disagreement analysis ${report.id}: ${String(inline.status ?? "unknown")}`,
      attentionState: inline.requires_verification === true ? "unread_result" : undefined,
      idempotencyKey: `disagreement:${report.id}:analyzed`
    });
    if (inline.requires_verification === true) {
      this.gateway.emit({
        type: "disagreement.verification_required",
        actorId,
        workspaceId: String(run.payload.workspace_id),
        runId: run.id,
        correlationId: String(run.payload.root_objective_id),
        summary: `Disagreement report ${report.id} requires later verifier review`,
        attentionState: "unread_result",
        idempotencyKey: `disagreement:${report.id}:verification-required`
      });
    }
  }

  private result(run: StoredObject, report: StoredObject): DisagreementAnalysisResult {
    const inline = asObject(report.payload.inline_content);
    return {
      run: this.teams.getRun(run.id) ?? run,
      report,
      status: String(inline.status) as DisagreementStatus,
      requiresVerification: inline.requires_verification === true,
      findings: Array.isArray(inline.findings) ? inline.findings as DisagreementFinding[] : []
    };
  }

  private requireCandidateArtifact(ref: string, run: StoredObject): StoredObject {
    const artifact = this.gateway.store.getObject(ref);
    if (!artifact || artifact.kind !== "artifact") throw new Error(`Candidate Artifact ${ref} not found`);
    if (artifact.payload.kind === "disagreement_report") throw new Error(`Disagreement report ${ref} cannot be analyzed as a candidate`);
    if (artifact.workspaceId !== run.workspaceId) throw new Error(`Candidate Artifact ${ref} is outside Team Run workspace ${String(run.workspaceId)}`);
    if (String(artifact.payload.run_id ?? "") !== run.id) throw new Error(`Candidate Artifact ${ref} is outside Team Run ${run.id}`);
    return artifact;
  }

  private isReportForRun(report: StoredObject | null, run: StoredObject): report is StoredObject {
    return Boolean(
      report?.kind === "artifact"
      && report.payload.kind === "disagreement_report"
      && report.workspaceId === run.workspaceId
      && String(report.payload.run_id ?? "") === run.id
    );
  }

  private assertActor(run: StoredObject, actorId: string): void {
    const leaderId = String(run.payload.leader_id ?? "");
    if (actorId === leaderId) {
      const leader = this.gateway.getBot(leaderId);
      if (!leader || leader.payload.status !== "active" || leader.workspaceId !== run.workspaceId) {
        throw new Error(`Team Run ${run.id} has no active same-workspace leader for disagreement analysis`);
      }
      return;
    }
    if (!actorId.startsWith("operator_")) {
      throw new Error(`Only Team Run leader ${leaderId} or an operator can analyze disagreement for ${run.id}`);
    }
  }

  private requireRun(runId: string): StoredObject {
    const run = this.teams.getRun(runId);
    if (!run) throw new Error(`Team Run ${runId} not found`);
    return run;
  }
}
