import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { detectAiVerseOsCompatibility } from "./ai-verse-os-registration.js";
import { normalizeBudget, type BudgetEnvelope } from "./budget.js";
import { constraintsDigest, normalizeConstraints } from "./constraints.js";
import { ExecutionQueue } from "./execution-queue.js";
import { CoordinationGateway, type ApprovalRequirement } from "./gateway.js";
import { CoordinationStore } from "./store.js";
import type { CoordinationEvent, JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

export const AI_VERSE_BRAIN_OBJECTIVE_PROVIDER = "ai-verse-brain-objective-v1";
export const AI_VERSE_BRAIN_OBJECTIVE_SCHEMA = "1.0";
export const AI_VERSE_BRAIN_INGRESS_ACTOR = "ai-verse-brain-ingress";

const DIRECTION_OWNERSHIP_PATH = ".aiverse/direction/ownership.json";
const BRAIN_INSTALLATION_PATH = "operator/brain/installation.json";
const MAX_CONTROL_FILE_BYTES = 64 * 1024;
const MAX_BRAIN_OBJECT_BYTES = 128 * 1024;
const MAX_OBJECT_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 8192;
const MAX_LIST_ITEMS = 128;
const MAX_LIST_ITEM_LENGTH = 4096;
const EXECUTABLE_OBJECTIVE_STATES = new Set(["READY", "RUNNING"]);
const EXECUTABLE_INITIATIVE_STATES = new Set(["ACCEPTED", "ACTIVE"]);
const EXECUTABLE_INTENT_STATES = new Set(["CONFIRMED", "ACTIVE"]);
const ACTIVE_TASK_STATES = new Set(["created", "assigned", "accepted", "running", "waiting_input", "waiting_approval", "blocked"]);

export interface BrainObjectiveSourceRef extends JsonObject {
  ref: string;
  kind: "objective" | "initiative" | "intent";
  object_id: string;
  revision: number;
  source_digest: string;
  status: string;
}

export interface BrainObjectiveProjection extends JsonObject {
  schema_version: "1.0";
  provider: string;
  workspace_id: string;
  objective_id: string;
  objective_status: string;
  root_objective_id: string;
  intent_digest: string;
  projected_at: string;
  source: BrainObjectiveSourceRef;
  parent_source: BrainObjectiveSourceRef | null;
  data: JsonObject;
}

export interface BrainObjectiveSource {
  project(workspaceId: string, objectiveId: string): BrainObjectiveProjection;
}

export interface BrainObjectiveIngressInput {
  leaderId: string;
  workspaceId: string;
  objectiveId: string;
  reason?: string;
  tools?: string[];
  connections?: string[];
  budget?: BudgetEnvelope;
  maxHops?: number;
  deadlineAt?: string;
  leaseExpiresAt?: string;
  approval?: ApprovalRequirement;
}

export interface BrainObjectiveIngressResult {
  projection: BrainObjectiveProjection;
  task: StoredObject;
  lease: StoredObject;
  approval: StoredObject | null;
  created: boolean;
}

export class BrainObjectiveIngressError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BrainObjectiveIngressError";
  }
}

interface BrainObjectRecord {
  raw: string;
  value: JsonObject;
  source: BrainObjectiveSourceRef;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) result[key] = stableValue(source[key]);
    return result;
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestValue(value: unknown): string {
  return sha256(JSON.stringify(stableValue(value)));
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function assertSafeObjectId(value: string, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized === "." || normalized === ".." || normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0")) {
    throw new BrainObjectiveIngressError("INVALID_BRAIN_OBJECT_ID", `${label} must be a non-empty path-safe Brain object ID`);
  }
  if (normalized.length > MAX_OBJECT_ID_LENGTH) {
    throw new BrainObjectiveIngressError("INVALID_BRAIN_OBJECT_ID", `${label} exceeds ${MAX_OBJECT_ID_LENGTH} characters`);
  }
  return normalized;
}

function assertWorkspaceId(value: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(normalized)) {
    throw new BrainObjectiveIngressError("INVALID_WORKSPACE", `Invalid AI-Verse workspace ID '${normalized}'`);
  }
  return normalized;
}

function inside(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

function assertDirectory(path: string, root: string, label: string): void {
  if (!inside(path, root)) throw new BrainObjectiveIngressError("PATH_ESCAPE", `${label} resolves outside the AI-Verse OS root`);
  if (!existsSync(path)) throw new BrainObjectiveIngressError("BRAIN_STATE_MISSING", `${label} is missing`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new BrainObjectiveIngressError("BRAIN_STATE_SYMLINK", `${label} must not be a symlink`);
  if (!stat.isDirectory()) throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", `${label} must be a directory`);
}

function readBoundedJson(path: string, root: string, label: string, maxBytes: number): { raw: string; value: JsonObject } {
  if (!inside(path, root)) throw new BrainObjectiveIngressError("PATH_ESCAPE", `${label} resolves outside the AI-Verse OS root`);
  if (!existsSync(path)) throw new BrainObjectiveIngressError("BRAIN_STATE_MISSING", `${label} is missing`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new BrainObjectiveIngressError("BRAIN_STATE_SYMLINK", `${label} must not be a symlink`);
  if (!stat.isFile()) throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", `${label} must be a regular file`);
  const raw = readFileSync(path, "utf8");
  if (byteLength(raw) > maxBytes) throw new BrainObjectiveIngressError("BRAIN_STATE_TOO_LARGE", `${label} exceeds ${maxBytes} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", `${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const value = asObject(parsed);
  if (!value) throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", `${label} must contain a JSON object`);
  return { raw, value };
}

function requireText(value: unknown, label: string, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || !value.trim()) throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", `${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new BrainObjectiveIngressError("BRAIN_STATE_TOO_LARGE", `${label} exceeds ${maxLength} characters`);
  return normalized;
}

function optionalText(value: unknown, label: string, maxLength = MAX_TEXT_LENGTH): string | null {
  if (value === undefined || value === null) return null;
  return requireText(value, label, maxLength);
}

function boundedStringArray(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", `${label} must be an array`);
  if (value.length > MAX_LIST_ITEMS) throw new BrainObjectiveIngressError("BRAIN_STATE_TOO_LARGE", `${label} exceeds ${MAX_LIST_ITEMS} items`);
  return value.map((item, index) => requireText(item, `${label}[${index}]`, MAX_LIST_ITEM_LENGTH));
}

function parseBrainExtensionRegistration(manifest: string): { supported: boolean; enabled: boolean } {
  const lines = manifest.split(/\r?\n/);
  let extensionsIndex = -1;
  let extensionsIndent = -1;
  let brainIndex = -1;
  let brainIndent = -1;
  let extensionsCount = 0;
  let brainCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (stripped === "extensions:") {
      if (indent !== 0) continue;
      extensionsCount += 1;
      extensionsIndex = i;
      extensionsIndent = indent;
    }
  }
  if (extensionsCount !== 1 || extensionsIndex < 0) {
    throw new BrainObjectiveIngressError("BRAIN_REGISTRATION_INVALID", "AI-VERSE.yaml must contain exactly one top-level extensions block");
  }

  for (let i = extensionsIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= extensionsIndent) break;
    if (/^brain:\s*(?:#.*)?$/.test(stripped)) {
      brainCount += 1;
      brainIndex = i;
      brainIndent = indent;
    }
  }
  if (brainCount !== 1 || brainIndex < 0) {
    throw new BrainObjectiveIngressError("BRAIN_REGISTRATION_INVALID", "AI-VERSE.yaml must explicitly register extensions.brain exactly once");
  }

  const settings: Record<string, string> = {};
  for (let i = brainIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= brainIndent) break;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*([^#\r\n]+?)\s*$/.exec(stripped);
    if (!match) continue;
    if (settings[match[1]!] !== undefined) throw new BrainObjectiveIngressError("BRAIN_REGISTRATION_INVALID", `Duplicate extensions.brain.${match[1]} setting`);
    settings[match[1]!] = String(match[2]!).trim().replace(/^['"]|['"]$/g, "").toLowerCase();
  }

  return { supported: settings.supported === "true", enabled: settings.enabled === "true" };
}

function brainKindDirectory(kind: BrainObjectiveSourceRef["kind"]): string {
  if (kind === "objective") return "objectives";
  if (kind === "initiative") return "initiatives";
  return "intent";
}

function parentRef(value: string): { kind: "initiative" | "intent"; id: string } {
  const normalized = value.startsWith("brain:") ? value.slice(6) : value;
  const separator = normalized.indexOf(":");
  if (separator < 1) throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", "objective.payload.serves_ref must identify initiative:<id> or intent:<id>");
  const kind = normalized.slice(0, separator);
  const id = assertSafeObjectId(normalized.slice(separator + 1), "objective.payload.serves_ref object ID");
  if (kind !== "initiative" && kind !== "intent") {
    throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", "objective.payload.serves_ref must identify initiative:<id> or intent:<id>");
  }
  return { kind, id };
}

function criteriaProjection(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.length === 0) throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", "objective.payload.criteria must be a non-empty array");
  if (value.length > 64) throw new BrainObjectiveIngressError("BRAIN_STATE_TOO_LARGE", "objective.payload.criteria exceeds 64 items");
  return value.map((item, index) => {
    const criterion = asObject(item);
    if (!criterion) throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", `objective.payload.criteria[${index}] must be an object`);
    return {
      id: requireText(criterion.id, `objective.payload.criteria[${index}].id`, 256),
      statement: requireText(criterion.statement, `objective.payload.criteria[${index}].statement`, MAX_LIST_ITEM_LENGTH),
      required_evidence: optionalText(criterion.required_evidence, `objective.payload.criteria[${index}].required_evidence`, MAX_LIST_ITEM_LENGTH),
      status: typeof criterion.status === "string" ? criterion.status : "unverified"
    };
  });
}

export function brainRootObjectiveId(objectiveId: string, intentDigest: string): string {
  const id = assertSafeObjectId(objectiveId, "objectiveId");
  if (!/^[a-f0-9]{64}$/.test(intentDigest)) throw new BrainObjectiveIngressError("INVALID_INTENT_DIGEST", "intentDigest must be a SHA-256 hex digest");
  return `brain:objective:${encodeURIComponent(id)}@sha256:${intentDigest}`;
}

export function parseBrainRootObjectiveId(rootObjectiveId: string): { objectiveId: string; intentDigest: string } | null {
  const prefix = "brain:objective:";
  if (!rootObjectiveId.startsWith(prefix)) return null;
  const body = rootObjectiveId.slice(prefix.length);
  const marker = "@sha256:";
  const split = body.lastIndexOf(marker);
  if (split < 1) throw new BrainObjectiveIngressError("INVALID_BRAIN_ROOT_OBJECTIVE", `Malformed Brain root objective '${rootObjectiveId}'`);
  let objectiveId: string;
  try {
    objectiveId = decodeURIComponent(body.slice(0, split));
  } catch {
    throw new BrainObjectiveIngressError("INVALID_BRAIN_ROOT_OBJECTIVE", `Malformed encoded Brain objective ID in '${rootObjectiveId}'`);
  }
  assertSafeObjectId(objectiveId, "Brain root objective object ID");
  const intentDigest = body.slice(split + marker.length);
  if (!/^[a-f0-9]{64}$/.test(intentDigest)) throw new BrainObjectiveIngressError("INVALID_BRAIN_ROOT_OBJECTIVE", `Malformed Brain intent digest in '${rootObjectiveId}'`);
  return { objectiveId, intentDigest };
}

export function assertBrainProjectionExecutable(projection: BrainObjectiveProjection, expectedIntentDigest?: string, ingress = false): void {
  if (projection.provider !== AI_VERSE_BRAIN_OBJECTIVE_PROVIDER || projection.schema_version !== AI_VERSE_BRAIN_OBJECTIVE_SCHEMA) {
    throw new BrainObjectiveIngressError("BRAIN_PROVIDER_MISMATCH", "Unsupported Brain objective projection provider/schema");
  }
  if (expectedIntentDigest && projection.intent_digest !== expectedIntentDigest) {
    throw new BrainObjectiveIngressError("BRAIN_INTENT_STALE", `Brain objective ${projection.objective_id} changed after coordination ingress`);
  }
  if (ingress) {
    if (projection.objective_status !== "READY") {
      throw new BrainObjectiveIngressError("BRAIN_OBJECTIVE_NOT_READY", `Brain objective ${projection.objective_id} is ${projection.objective_status}; only READY objectives may enter coordination`);
    }
  } else if (!EXECUTABLE_OBJECTIVE_STATES.has(projection.objective_status)) {
    throw new BrainObjectiveIngressError("BRAIN_OBJECTIVE_NOT_EXECUTABLE", `Brain objective ${projection.objective_id} is no longer executable from status ${projection.objective_status}`);
  }
  const parent = projection.parent_source;
  if (parent?.kind === "initiative" && !EXECUTABLE_INITIATIVE_STATES.has(parent.status)) {
    throw new BrainObjectiveIngressError("BRAIN_PARENT_NOT_EXECUTABLE", `Brain initiative ${parent.object_id} is ${parent.status}`);
  }
  if (parent?.kind === "intent" && !EXECUTABLE_INTENT_STATES.has(parent.status)) {
    throw new BrainObjectiveIngressError("BRAIN_PARENT_NOT_EXECUTABLE", `Brain intent ${parent.object_id} is ${parent.status}`);
  }
}

export class AiVerseBrainObjectiveSource implements BrainObjectiveSource {
  readonly root: string;

  constructor(rootInput: string) {
    this.root = resolve(rootInput);
    const compatibility = detectAiVerseOsCompatibility(this.root);
    if (compatibility.status !== "compatible") {
      throw new BrainObjectiveIngressError("INCOMPATIBLE_AI_VERSE_OS", `Brain objective source requires compatible AI-Verse OS v2: ${compatibility.reason}`);
    }
  }

  project(workspaceIdInput: string, objectiveIdInput: string): BrainObjectiveProjection {
    const workspaceId = assertWorkspaceId(workspaceIdInput);
    const objectiveId = assertSafeObjectId(objectiveIdInput, "objectiveId");
    this.assertBrainRegistration();
    this.assertBrainInstallation();
    this.assertBrainDirectionOwnership(workspaceId);

    const workspaceRoot = resolve(this.root, "workspaces", workspaceId);
    assertDirectory(resolve(this.root, "workspaces"), this.root, "workspaces/");
    assertDirectory(workspaceRoot, this.root, `workspaces/${workspaceId}/`);
    assertDirectory(resolve(workspaceRoot, "brain"), this.root, `workspaces/${workspaceId}/brain/`);
    const objective = this.readBrainObject(workspaceId, "objective", objectiveId);
    const payload = asObject(objective.value.payload);
    if (!payload) throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", `Brain objective ${objectiveId} payload must be an object`);

    const outcome = requireText(payload.outcome, "objective.payload.outcome");
    const serves = parentRef(requireText(payload.serves_ref, "objective.payload.serves_ref", 512));
    const parent = this.readBrainObject(workspaceId, serves.kind, serves.id);
    const parentPayload = asObject(parent.value.payload);
    if (!parentPayload) throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", `Brain ${serves.kind} ${serves.id} payload must be an object`);

    let parentData: JsonObject;
    if (serves.kind === "initiative") {
      parentData = {
        kind: "initiative",
        ref: `brain:initiative:${serves.id}`,
        outcome: requireText(parentPayload.outcome, "initiative.payload.outcome"),
        hypothesis: requireText(parentPayload.hypothesis, "initiative.payload.hypothesis"),
        next_action: optionalText(parentPayload.next_action, "initiative.payload.next_action")
      };
    } else {
      const subtype = requireText(parentPayload.subtype, "intent.payload.subtype", 128);
      if (!["desired_state", "goal", "success_definition"].includes(subtype)) {
        throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", `Brain intent ${serves.id} subtype '${subtype}' cannot serve as an executable strategic parent`);
      }
      parentData = {
        kind: "intent",
        ref: `brain:intent:${serves.id}`,
        subtype,
        statement: requireText(parentPayload.statement, "intent.payload.statement")
      };
    }

    const criteria = criteriaProjection(payload.criteria);
    const constraints = boundedStringArray(payload.constraints, "objective.payload.constraints");
    const boundaries = boundedStringArray(payload.boundaries, "objective.payload.boundaries");
    const stopConditions = boundedStringArray(payload.stop_conditions, "objective.payload.stop_conditions");
    const dependencies = boundedStringArray(payload.dependencies, "objective.payload.dependencies");
    const risks = boundedStringArray(payload.risks, "objective.payload.risks");
    const brainBudget = asObject(payload.budget) ?? {};
    const maxAttempts = brainBudget.max_attempts;
    if (maxAttempts !== undefined && (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1)) {
      throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", "objective.payload.budget.max_attempts must be an integer >= 1 when present");
    }
    const data: JsonObject = {
      objective: outcome,
      problem: optionalText(payload.problem, "objective.payload.problem"),
      desired_state: optionalText(payload.desired_state, "objective.payload.desired_state"),
      criteria,
      verification_level: typeof payload.verification_level === "string" ? payload.verification_level : null,
      constraints,
      boundaries,
      stop_conditions: stopConditions,
      dependencies,
      risks,
      brain_budget: maxAttempts === undefined ? {} : { max_attempts: maxAttempts },
      serves_ref: `${serves.kind}:${serves.id}`,
      parent: parentData
    };
    const intentDigest = digestValue({
      objective_id: objectiveId,
      data
    });

    return {
      schema_version: AI_VERSE_BRAIN_OBJECTIVE_SCHEMA,
      provider: AI_VERSE_BRAIN_OBJECTIVE_PROVIDER,
      workspace_id: workspaceId,
      objective_id: objectiveId,
      objective_status: objective.source.status,
      root_objective_id: brainRootObjectiveId(objectiveId, intentDigest),
      intent_digest: intentDigest,
      projected_at: new Date().toISOString(),
      source: objective.source,
      parent_source: parent.source,
      data
    };
  }

  private assertBrainRegistration(): void {
    const manifestPath = resolve(this.root, "AI-VERSE.yaml");
    if (!existsSync(manifestPath) || lstatSync(manifestPath).isSymbolicLink()) {
      throw new BrainObjectiveIngressError("BRAIN_REGISTRATION_INVALID", "AI-VERSE.yaml must be a regular non-symlink file");
    }
    const manifest = readFileSync(manifestPath, "utf8");
    if (byteLength(manifest) > MAX_CONTROL_FILE_BYTES) throw new BrainObjectiveIngressError("BRAIN_STATE_TOO_LARGE", "AI-VERSE.yaml exceeds Brain ingress control-file limit");
    const registration = parseBrainExtensionRegistration(manifest);
    if (!registration.supported || !registration.enabled) {
      throw new BrainObjectiveIngressError("BRAIN_REGISTRATION_DISABLED", "AI-Verse Brain must be explicitly supported and enabled before its objectives may enter coordination");
    }
  }

  private assertBrainInstallation(): void {
    assertDirectory(resolve(this.root, "operator"), this.root, "operator/");
    assertDirectory(resolve(this.root, "operator", "brain"), this.root, "operator/brain/");
    const marker = readBoundedJson(resolve(this.root, ...BRAIN_INSTALLATION_PATH.split("/")), this.root, BRAIN_INSTALLATION_PATH, MAX_CONTROL_FILE_BYTES).value;
    if (marker.schema_version !== "1.0" || typeof marker.state_schema_version !== "string" || !/^1(?:\.|$)/.test(marker.state_schema_version)) {
      throw new BrainObjectiveIngressError("BRAIN_INSTALLATION_INVALID", "Brain installation marker has an unsupported schema/state schema");
    }
    if (marker.mode !== "ai-verse-os-v2" || typeof marker.installation_id !== "string" || !marker.installation_id.trim()) {
      throw new BrainObjectiveIngressError("BRAIN_INSTALLATION_INVALID", "Brain installation marker is not a valid AI-Verse OS v2 installation");
    }
  }

  private assertBrainDirectionOwnership(workspaceId: string): void {
    const markerPath = resolve(this.root, ...DIRECTION_OWNERSHIP_PATH.split("/"));
    const marker = readBoundedJson(markerPath, this.root, DIRECTION_OWNERSHIP_PATH, MAX_CONTROL_FILE_BYTES).value;
    if (marker.schema_version !== 1 || !asObject(marker.scopes)) {
      throw new BrainObjectiveIngressError("DIRECTION_OWNERSHIP_INVALID", "AI-Verse direction ownership registry is malformed or unsupported");
    }
    const scopes = asObject(marker.scopes)!;
    const record = asObject(scopes[`workspace:${workspaceId}`]);
    if (!record || record.owner !== "brain") {
      throw new BrainObjectiveIngressError("BRAIN_NOT_DIRECTION_OWNER", `Strategic direction for workspace:${workspaceId} is not explicitly owned by Brain`);
    }
  }

  private readBrainObject(workspaceId: string, kind: BrainObjectiveSourceRef["kind"], objectIdInput: string): BrainObjectRecord {
    const objectId = assertSafeObjectId(objectIdInput, `${kind} object ID`);
    const workspaceRoot = resolve(this.root, "workspaces", workspaceId);
    const brainRoot = resolve(workspaceRoot, "brain");
    const kindDir = resolve(brainRoot, brainKindDirectory(kind));
    assertDirectory(kindDir, this.root, `workspaces/${workspaceId}/brain/${brainKindDirectory(kind)}/`);
    const relative = `workspaces/${workspaceId}/brain/${brainKindDirectory(kind)}/${objectId}.json`;
    const { raw, value } = readBoundedJson(resolve(kindDir, `${objectId}.json`), this.root, relative, MAX_BRAIN_OBJECT_BYTES);
    if (value.schema_version !== "1.0" || value.id !== objectId || value.kind !== kind || value.scope !== `workspace:${workspaceId}`) {
      throw new BrainObjectiveIngressError("BRAIN_STATE_SCOPE_MISMATCH", `${relative} does not match its requested Brain identity/scope`);
    }
    const revision = Number(value.revision);
    if (!Number.isInteger(revision) || revision < 1) throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", `${relative} has an invalid revision`);
    const status = requireText(value.status, `${relative}.status`, 128);
    if (!asObject(value.payload)) throw new BrainObjectiveIngressError("BRAIN_STATE_INVALID", `${relative}.payload must be an object`);
    if (value.superseded_by !== undefined && value.superseded_by !== null) {
      throw new BrainObjectiveIngressError("BRAIN_STATE_SUPERSEDED", `${relative} is superseded and cannot drive new coordination`);
    }
    return {
      raw,
      value,
      source: {
        ref: `brain:${kind}:${objectId}`,
        kind,
        object_id: objectId,
        revision,
        source_digest: sha256(raw),
        status
      }
    };
  }
}

export class BrainObjectiveIngress {
  constructor(
    readonly store: CoordinationStore,
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue,
    readonly source: BrainObjectiveSource
  ) {}

  ingest(input: BrainObjectiveIngressInput): BrainObjectiveIngressResult {
    const projection = this.source.project(input.workspaceId, input.objectiveId);
    assertBrainProjectionExecutable(projection, undefined, true);
    if (projection.workspace_id !== input.workspaceId) {
      throw new BrainObjectiveIngressError("WORKSPACE_MISMATCH", `Brain source returned workspace ${projection.workspace_id}, expected ${input.workspaceId}`);
    }
    const policy = this.gateway.policy;
    if (!policy) throw new BrainObjectiveIngressError("POLICY_REQUIRED", "Brain objective ingress requires CoordinationPolicy");

    const requiredConstraints = normalizeConstraints([
      ...((projection.data.constraints as unknown[]) ?? []).map((value) => `Brain constraint: ${String(value)}`),
      ...((projection.data.boundaries as unknown[]) ?? []).map((value) => `Brain boundary: ${String(value)}`),
      ...((projection.data.stop_conditions as unknown[]) ?? []).map((value) => `Brain stop condition: ${String(value)}`)
    ]);
    const objective = requireText(projection.data.objective, "projected Brain objective");
    const tools = [...new Set((input.tools ?? []).map(String).map((value) => value.trim()).filter(Boolean))].sort();
    const connections = [...new Set((input.connections ?? []).map(String).map((value) => value.trim()).filter(Boolean))].sort();
    const budget = normalizeBudget(input.budget);
    const rootObjectiveId = projection.root_objective_id;
    const ingressDigest = digestValue({
      provider: projection.provider,
      workspace_id: input.workspaceId,
      root_objective_id: rootObjectiveId
    });
    const taskId = `task_brain_ingress_${ingressDigest.slice(0, 32)}`;
    const leaseId = `lease_brain_ingress_${ingressDigest.slice(0, 32)}`;
    const approvalId = `approval_brain_ingress_${ingressDigest.slice(0, 32)}`;

    const existing = this.store.getObject(taskId);
    if (existing) return this.existingResult(existing, projection, input, leaseId, approvalId, tools, connections, budget, requiredConstraints);

    const prepared = policy.prepareDelegation({
      createdBy: AI_VERSE_BRAIN_INGRESS_ACTOR,
      assigneeId: input.leaderId,
      workspaceId: input.workspaceId,
      rootObjectiveId,
      objective,
      requiredConstraints,
      tools,
      connections,
      maxHops: input.maxHops,
      deadlineAt: input.deadlineAt,
      budget
    });
    const approvalRequired = input.approval?.required === true;
    const timestamp = new Date().toISOString();
    const lease = validateProtocolObject({
      schema_version: "1.0",
      id: leaseId,
      type: "capability_lease",
      principal: AI_VERSE_BRAIN_INGRESS_ACTOR,
      issued_to: input.leaderId,
      workspace_id: input.workspaceId,
      task_id: taskId,
      tools,
      connections,
      destructive_actions: approvalRequired ? "approval_required" : "deny",
      expires_at: input.leaseExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()
    }, "capability_lease");
    const task = validateProtocolObject({
      schema_version: "1.0",
      id: taskId,
      type: "task.delegate",
      created_by: AI_VERSE_BRAIN_INGRESS_ACTOR,
      assignee_id: input.leaderId,
      owner_id: input.leaderId,
      workspace_id: input.workspaceId,
      root_objective_id: rootObjectiveId,
      parent_task_id: prepared.parentTaskId,
      reason: input.reason?.trim() || "Execute the current AI-Verse Brain objective through the coordination boundary",
      objective,
      required_constraints: requiredConstraints,
      constraints_digest: constraintsDigest(requiredConstraints),
      expected_output: {
        contract: "brain-objective-result-v1",
        verification_level: projection.data.verification_level ?? null,
        criteria_digest: digestValue(projection.data.criteria ?? []),
        strategic_intent_runtime_required: true
      },
      input_artifact_refs: [],
      lease_id: leaseId,
      environment_lease_id: null,
      response_target: null,
      deadline_at: prepared.deadlineAt,
      budget: prepared.budget,
      approval_id: approvalRequired ? approvalId : null,
      hop: prepared.hop,
      max_hops: prepared.maxHops,
      status: approvalRequired ? "waiting_approval" : "assigned",
      brain_ingress: {
        provider: projection.provider,
        ingress_digest: ingressDigest,
        source_ref: projection.source.ref,
        source_revision: projection.source.revision,
        source_digest: projection.source.source_digest,
        intent_digest: projection.intent_digest,
        parent_ref: projection.parent_source?.ref ?? null,
        parent_revision: projection.parent_source?.revision ?? null,
        parent_source_digest: projection.parent_source?.source_digest ?? null
      }
    }, "task");

    const objects: Array<{ kind: "task" | "capability_lease" | "approval"; payload: JsonObject }> = [
      { kind: "capability_lease", payload: lease },
      { kind: "task", payload: task }
    ];
    const events: CoordinationEvent[] = [{
      schema_version: "1.0",
      id: `evt_brain_ingress_${ingressDigest.slice(0, 32)}`,
      type: "brain.objective_ingressed",
      timestamp,
      actor_id: AI_VERSE_BRAIN_INGRESS_ACTOR,
      workspace_id: input.workspaceId,
      task_id: taskId,
      correlation_id: rootObjectiveId,
      summary: `Ingested Brain objective ${projection.objective_id} for durable leader ${input.leaderId}`
    }];
    let approval: JsonObject | null = null;
    if (approvalRequired) {
      const requestedAction = asObject(input.approval?.action) ?? {};
      const action: JsonObject = {
        ...requestedAction,
        kind: typeof requestedAction.kind === "string" && requestedAction.kind ? requestedAction.kind : "task.execute",
        summary: typeof requestedAction.summary === "string" && requestedAction.summary ? requestedAction.summary : `Execute Brain objective ${projection.objective_id}`,
        task_id: taskId
      };
      approval = validateProtocolObject({
        schema_version: "1.0",
        id: approvalId,
        type: "approval",
        workspace_id: input.workspaceId,
        actor_id: input.leaderId,
        task_id: taskId,
        requested_by: AI_VERSE_BRAIN_INGRESS_ACTOR,
        requested_at: timestamp,
        status: "pending",
        reason: input.approval?.reason ?? input.reason ?? "Brain objective execution requires explicit approval",
        action
      }, "approval");
      objects.push({ kind: "approval", payload: approval });
      events.push({
        schema_version: "1.0",
        id: `evt_brain_ingress_approval_${ingressDigest.slice(0, 32)}`,
        type: "approval.requested",
        timestamp,
        actor_id: AI_VERSE_BRAIN_INGRESS_ACTOR,
        workspace_id: input.workspaceId,
        task_id: taskId,
        correlation_id: rootObjectiveId,
        summary: `Approval required before ${input.leaderId} can execute Brain objective ${projection.objective_id}`
      });
    } else {
      events.push({
        schema_version: "1.0",
        id: `evt_brain_ingress_assigned_${ingressDigest.slice(0, 32)}`,
        type: "task.assigned",
        timestamp,
        actor_id: AI_VERSE_BRAIN_INGRESS_ACTOR,
        workspace_id: input.workspaceId,
        task_id: taskId,
        correlation_id: rootObjectiveId,
        summary: `Assigned Brain objective ${projection.objective_id} to ${input.leaderId}`
      });
    }

    try {
      this.store.atomicMutation({
        preconditions: [{ id: input.leaderId, kind: "bot", status: "active" }],
        objects,
        events
      });
    } catch (error) {
      const raced = this.store.getObject(taskId);
      if (!raced) throw error;
      return this.existingResult(raced, projection, input, leaseId, approvalId, tools, connections, budget, requiredConstraints);
    }

    if (!approvalRequired) this.queue.enqueueTask(taskId, input.leaderId, input.workspaceId);
    const storedTask = this.store.getObject(taskId);
    const storedLease = this.store.getObject(leaseId);
    const storedApproval = approvalRequired ? this.store.getObject(approvalId) : null;
    if (!storedTask || !storedLease) throw new BrainObjectiveIngressError("INGRESS_PERSISTENCE_FAILED", "Brain objective ingress did not persist its Task/lease");
    return { projection, task: storedTask, lease: storedLease, approval: storedApproval, created: true };
  }

  private existingResult(
    task: StoredObject,
    projection: BrainObjectiveProjection,
    input: BrainObjectiveIngressInput,
    leaseId: string,
    approvalId: string,
    tools: string[],
    connections: string[],
    budget: BudgetEnvelope,
    requiredConstraints: string[]
  ): BrainObjectiveIngressResult {
    if (task.kind !== "task") throw new BrainObjectiveIngressError("INGRESS_ID_COLLISION", `${task.id} already exists and is not a Task`);
    const ingress = asObject(task.payload.brain_ingress);
    if (!ingress || ingress.provider !== projection.provider || ingress.intent_digest !== projection.intent_digest) {
      throw new BrainObjectiveIngressError("INGRESS_ID_COLLISION", `${task.id} does not match the requested Brain ingress contract`);
    }
    if (task.workspaceId !== input.workspaceId || task.payload.root_objective_id !== projection.root_objective_id || task.payload.assignee_id !== input.leaderId) {
      throw new BrainObjectiveIngressError("BRAIN_INGRESS_CONFLICT", `Brain objective ${projection.objective_id} is already bound to a different coordination contract`);
    }
    const lease = this.store.getObject(leaseId);
    if (!lease || lease.kind !== "capability_lease") throw new BrainObjectiveIngressError("INGRESS_PERSISTENCE_FAILED", `Brain ingress lease ${leaseId} is missing`);
    const expectedBudget = normalizeBudget(task.payload.budget);
    const storedTools = Array.isArray(lease.payload.tools) ? lease.payload.tools.map(String).sort() : [];
    const storedConnections = Array.isArray(lease.payload.connections) ? lease.payload.connections.map(String).sort() : [];
    const storedConstraints = Array.isArray(task.payload.required_constraints) ? task.payload.required_constraints.map(String).sort() : [];
    if (JSON.stringify(expectedBudget) !== JSON.stringify(budget)
      || JSON.stringify(storedTools) !== JSON.stringify(tools)
      || JSON.stringify(storedConnections) !== JSON.stringify(connections)
      || JSON.stringify(storedConstraints) !== JSON.stringify([...requiredConstraints].sort())) {
      throw new BrainObjectiveIngressError("BRAIN_INGRESS_CONFLICT", `Brain objective ${projection.objective_id} was already ingressed with different authority, constraints, or budget`);
    }
    const approvalRequired = input.approval?.required === true;
    if (Boolean(task.payload.approval_id) !== approvalRequired) {
      throw new BrainObjectiveIngressError("BRAIN_INGRESS_CONFLICT", `Brain objective ${projection.objective_id} was already ingressed with a different approval contract`);
    }
    const approval = approvalRequired ? this.store.getObject(approvalId) : null;
    if (approvalRequired && (!approval || approval.kind !== "approval")) throw new BrainObjectiveIngressError("INGRESS_PERSISTENCE_FAILED", `Brain ingress approval ${approvalId} is missing`);

    if (task.payload.status === "assigned") {
      const queued = this.queue.getByItem(task.id);
      if (!queued) this.queue.enqueueTask(task.id, input.leaderId, input.workspaceId);
      else if (!ACTIVE_TASK_STATES.has(String(task.payload.status)) || !["queued", "claimed", "running", "completed", "failed", "canceled", "dead_letter"].includes(queued.state)) {
        throw new BrainObjectiveIngressError("INGRESS_QUEUE_INCONSISTENT", `Brain ingress Task ${task.id} has inconsistent execution state`);
      }
    }
    return { projection, task, lease, approval, created: false };
  }
}
