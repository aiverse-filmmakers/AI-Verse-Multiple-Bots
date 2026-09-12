import { createHash } from "node:crypto";
import { CoordinationGateway } from "./gateway.js";
import {
  OsWriteCommandBoundary,
  type OsWriteCommandBoundaryResult
} from "./os-write-command.js";
import type { JsonObject, StoredObject } from "./types.js";

export const CANDIDATE_WRITEBACK_SCHEMA = "candidate-writeback-v1";
export const CANDIDATE_WRITEBACK_OPERATION = "candidate.route";
export const CANDIDATE_WRITEBACK_MAX_BYTES = 64 * 1024;
export const CANDIDATE_WRITEBACK_MAX_EVIDENCE_REFS = 24;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const DISALLOWED_SOURCE_KINDS = new Set(["os_write_command_receipt", "candidate_writeback"]);

export type CandidateWritebackKind = "knowledge" | "decision";

export interface CandidateWritebackInput {
  requestedBy: string;
  workspaceId: string;
  candidateKind: CandidateWritebackKind;
  sourceArtifactRef: string;
  title: string;
  summary: string;
  content: JsonObject;
  confidence?: number;
  evidenceArtifactRefs?: string[];
  taskId?: string;
  runId?: string;
  idempotencyKey: string;
  reason: string;
  createdAt: string;
}

export interface CandidateWritebackResult {
  candidateKind: CandidateWritebackKind;
  candidateDigest: string;
  sourceArtifactRef: string;
  evidenceArtifactRefs: string[];
  created: boolean;
  route: OsWriteCommandBoundaryResult;
}

export class CandidateWritebackError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CandidateWritebackError";
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CandidateWritebackError("CANDIDATE_INVALID_INPUT", `${label} must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > max || text.includes("\0")) {
    throw new CandidateWritebackError("CANDIDATE_INVALID_INPUT", `${label} is invalid or oversized`);
  }
  return text;
}

function validateJson(value: unknown, label: string, depth = 0, state = { keys: 0 }): void {
  if (depth > 8) throw new CandidateWritebackError("CANDIDATE_INVALID_INPUT", `${label} exceeds maximum nesting depth`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CandidateWritebackError("CANDIDATE_INVALID_INPUT", `${label} contains a non-finite number`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > 16_384 || value.includes("\0")) {
      throw new CandidateWritebackError("CANDIDATE_INVALID_INPUT", `${label} contains an invalid or oversized string`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new CandidateWritebackError("CANDIDATE_INVALID_INPUT", `${label} exceeds 256 array items`);
    value.forEach((item, index) => validateJson(item, `${label}[${index}]`, depth + 1, state));
    return;
  }
  if (typeof value !== "object" || value === null) {
    throw new CandidateWritebackError("CANDIDATE_INVALID_INPUT", `${label} contains an unsupported value`);
  }
  const keys = Object.keys(value as Record<string, unknown>);
  state.keys += keys.length;
  if (state.keys > 256) throw new CandidateWritebackError("CANDIDATE_INVALID_INPUT", `${label} exceeds 256 total object keys`);
  for (const key of keys) {
    if (!key || key.length > 256 || key.includes("\0")) {
      throw new CandidateWritebackError("CANDIDATE_INVALID_INPUT", `${label} contains an invalid object key`);
    }
    validateJson((value as Record<string, unknown>)[key], `${label}.${key}`, depth + 1, state);
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

/**
 * Phase 3.8 candidate write-back boundary.
 *
 * Multiple Bots may nominate bounded knowledge or decision candidates, but it
 * never writes canonical OS state directly. Candidate content is handed to the
 * existing owner-controlled OS write-command queue. Locally, the existing
 * os_write_command_receipt persists only parameter/provenance digests.
 */
export class CandidateWritebackRouter {
  constructor(
    readonly gateway: CoordinationGateway,
    readonly osWrites: OsWriteCommandBoundary
  ) {}

  async route(input: CandidateWritebackInput): Promise<CandidateWritebackResult> {
    const workspaceId = boundedString(input.workspaceId, "workspaceId", 128);
    const candidateKind = this.kind(input.candidateKind);
    const sourceArtifactRef = boundedString(input.sourceArtifactRef, "sourceArtifactRef", 256);
    const title = boundedString(input.title, "title", 256);
    const summary = boundedString(input.summary, "summary", 4096);
    const idempotencyKey = boundedString(input.idempotencyKey, "idempotencyKey", 180);
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new CandidateWritebackError("CANDIDATE_INVALID_INPUT", "idempotencyKey is invalid");
    }
    if (!input.content || typeof input.content !== "object" || Array.isArray(input.content) || Object.keys(input.content).length === 0) {
      throw new CandidateWritebackError("CANDIDATE_INVALID_INPUT", "content must be a non-empty object");
    }
    validateJson(input.content, "content");

    const confidence = input.confidence === undefined ? null : Number(input.confidence);
    if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new CandidateWritebackError("CANDIDATE_INVALID_INPUT", "confidence must be between 0 and 1");
    }

    const source = this.requireSourceArtifact(sourceArtifactRef, workspaceId);
    const evidenceArtifactRefs = uniqueSorted(input.evidenceArtifactRefs ?? []).filter((ref) => ref !== sourceArtifactRef);
    if (evidenceArtifactRefs.length > CANDIDATE_WRITEBACK_MAX_EVIDENCE_REFS) {
      throw new CandidateWritebackError(
        "CANDIDATE_INVALID_INPUT",
        `evidenceArtifactRefs exceeds ${CANDIDATE_WRITEBACK_MAX_EVIDENCE_REFS} items`
      );
    }
    for (const ref of evidenceArtifactRefs) this.requireArtifact(ref, workspaceId, "evidence");

    const sourceTaskId = typeof source.payload.task_id === "string" ? source.payload.task_id : undefined;
    const sourceRunId = typeof source.payload.run_id === "string" ? source.payload.run_id : undefined;
    if (input.taskId && sourceTaskId && input.taskId !== sourceTaskId) {
      throw new CandidateWritebackError("CANDIDATE_PROVENANCE_INVALID", "taskId conflicts with the source Artifact");
    }
    if (input.runId && sourceRunId && input.runId !== sourceRunId) {
      throw new CandidateWritebackError("CANDIDATE_PROVENANCE_INVALID", "runId conflicts with the source Artifact");
    }
    const taskId = input.taskId ?? sourceTaskId;
    const runId = input.runId ?? sourceRunId;

    const content = stableValue(input.content) as JsonObject;
    const candidateBase: JsonObject = {
      schema_version: "1.0",
      contract: CANDIDATE_WRITEBACK_SCHEMA,
      candidate_kind: candidateKind,
      title,
      summary,
      content,
      content_digest: digest(content),
      confidence,
      source_artifact_ref: sourceArtifactRef,
      evidence_artifact_refs: evidenceArtifactRefs,
      source_task_id: taskId ?? null,
      source_run_id: runId ?? null,
      canonical_effect_requested: false,
      owner_action: "evaluate_for_promotion"
    };
    const candidateDigest = digest(candidateBase);
    const parameters: JsonObject = {
      ...candidateBase,
      candidate_digest: candidateDigest
    };
    if (byteLength(JSON.stringify(parameters)) > CANDIDATE_WRITEBACK_MAX_BYTES) {
      throw new CandidateWritebackError(
        "CANDIDATE_INVALID_INPUT",
        `candidate parameters exceed ${CANDIDATE_WRITEBACK_MAX_BYTES} bytes`
      );
    }

    const route = await this.osWrites.request({
      requestedBy: input.requestedBy,
      scope: `workspace:${workspaceId}`,
      operation: CANDIDATE_WRITEBACK_OPERATION,
      parameters,
      idempotencyKey: `candidate:${candidateKind}:${idempotencyKey}`,
      reason: input.reason,
      createdAt: input.createdAt,
      provenance: {
        taskId,
        runId,
        artifactRefs: uniqueSorted([sourceArtifactRef, ...evidenceArtifactRefs])
      }
    });

    this.gateway.emit({
      type: "candidate.writeback_queued",
      actorId: input.requestedBy,
      workspaceId,
      runId: runId ?? null,
      taskId: taskId ?? null,
      correlationId: route.request.request_id,
      summary: `Queued ${candidateKind} candidate ${candidateDigest.slice(0, 12)} for OS owner evaluation; no canonical effect claimed`,
      idempotencyKey: `candidate-writeback:${route.request.request_id}`
    });

    return {
      candidateKind,
      candidateDigest,
      sourceArtifactRef,
      evidenceArtifactRefs,
      created: route.created,
      route
    };
  }

  private kind(value: unknown): CandidateWritebackKind {
    if (value === "knowledge" || value === "decision") return value;
    throw new CandidateWritebackError("CANDIDATE_INVALID_KIND", "candidateKind must be knowledge or decision");
  }

  private requireSourceArtifact(ref: string, workspaceId: string): StoredObject {
    const artifact = this.requireArtifact(ref, workspaceId, "source");
    if (DISALLOWED_SOURCE_KINDS.has(String(artifact.payload.kind))) {
      throw new CandidateWritebackError(
        "CANDIDATE_PROVENANCE_INVALID",
        `source Artifact ${ref} cannot itself be a write receipt or candidate write-back`
      );
    }
    return artifact;
  }

  private requireArtifact(ref: string, workspaceId: string, role: "source" | "evidence"): StoredObject {
    const artifact = this.gateway.store.getObject(ref);
    if (!artifact || artifact.kind !== "artifact") {
      throw new CandidateWritebackError("CANDIDATE_PROVENANCE_INVALID", `${role} Artifact ${ref} not found`);
    }
    if (artifact.workspaceId !== workspaceId) {
      throw new CandidateWritebackError(
        "CANDIDATE_SCOPE_DENIED",
        `${role} Artifact ${ref} is outside workspace ${workspaceId}`
      );
    }
    return artifact;
  }
}
