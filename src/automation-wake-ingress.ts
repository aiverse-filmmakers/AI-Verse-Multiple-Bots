import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { AiVerseOsWorkspaceProjector } from "./ai-verse-os-workspace-projection.js";
import { normalizeBudget, type BudgetEnvelope } from "./budget.js";
import { constraintsDigest, normalizeConstraints } from "./constraints.js";
import { ExecutionQueue, type RecoveryPolicy } from "./execution-queue.js";
import type { ApprovalRequirement } from "./gateway.js";
import { CoordinationGateway } from "./gateway.js";
import { parseTaskMemoryRecallRequest } from "./memory-recall-runtime.js";
import type { HistoricalRecallRequest } from "./runtime.js";
import { parseTaskSkillRefs } from "./skills-capability-runtime.js";
import { CoordinationStore } from "./store.js";
import type { TeamRunTopology } from "./team-runs.js";
import type { CoordinationEvent, JsonObject, StoredObject } from "./types.js";
import { validateProtocolObject } from "./validator.js";

export const AI_VERSE_AUTOMATION_INVOCATION_PROVIDER = "ai-verse-os-automation-v1";
export const AI_VERSE_AUTOMATION_INGRESS_ACTOR = "ai-verse-automation-ingress";
export const AI_VERSE_AUTOMATION_SCHEMA = "1.0";
export const AI_VERSE_AUTOMATION_MAX_SOURCE_BYTES = 128 * 1024;

const ID_MAX = 256;
const SOURCE_PATH_MAX = 2048;
const HEX64 = /^[a-f0-9]{64}$/;
const VALID_TOPOLOGIES = new Set<TeamRunTopology>([
  "manager",
  "handoff",
  "parallel_panel",
  "group_room",
  "pipeline",
  "review",
  "dynamic_squad",
  "hybrid"
]);
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "canceled"]);

export type AutomationSourceKind = "job" | "trigger";

export interface AutomationInvocationSourceInput {
  automationId: string;
  invocationId: string;
  workspaceId: string;
  firedAt: string;
  source: {
    kind: AutomationSourceKind;
    path: string;
    digest: string;
  };
}

export interface AutomationInvocationSourceRef extends JsonObject {
  kind: AutomationSourceKind;
  ref: string;
  path: string;
  scope: "shared" | `workspace:${string}`;
  source_digest: string;
}

export interface AutomationInvocationProjection extends JsonObject {
  schema_version: "1.0";
  provider: string;
  automation_id: string;
  invocation_id: string;
  workspace_id: string;
  fired_at: string;
  projection_digest: string;
  source: AutomationInvocationSourceRef;
}

export interface AutomationInvocationSource {
  project(input: AutomationInvocationSourceInput): AutomationInvocationProjection;
}

export interface AutomationBotTarget extends JsonObject {
  kind: "bot";
  botId: string;
}

export interface AutomationTeamRunTarget extends JsonObject {
  kind: "team_run";
  leaderId: string;
  topology?: TeamRunTopology;
}

export interface AutomationWakeIngressInput extends AutomationInvocationSourceInput {
  target: AutomationBotTarget | AutomationTeamRunTarget;
  objective: string;
  reason?: string;
  requiredConstraints?: string[];
  expectedOutput?: JsonObject;
  memoryRecall?: HistoricalRecallRequest;
  skillRefs?: string[];
  tools?: string[];
  connections?: string[];
  budget?: BudgetEnvelope;
  maxHops?: number;
  deadlineAt?: string;
  leaseExpiresAt?: string;
  approval?: ApprovalRequirement;
  recoveryPolicy?: RecoveryPolicy;
  maxAttempts?: number;
}

export type AutomationWakeIngressResult =
  | {
      mode: "bot";
      projection: AutomationInvocationProjection;
      task: StoredObject;
      lease: StoredObject;
      approval: StoredObject | null;
      created: boolean;
    }
  | {
      mode: "team_run";
      projection: AutomationInvocationProjection;
      run: StoredObject;
      created: boolean;
    };

export class AutomationWakeIngressError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AutomationWakeIngressError";
  }
}

export interface AiVerseOsAutomationInvocationSourceOptions {
  maxSourceBytes?: number;
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = stableValue(source[key]);
    return out;
  }
  return value;
}

function digestValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AutomationWakeIngressError("AUTOMATION_INVALID_INPUT", `${label} must be a non-empty string`);
  const text = value.trim();
  if (text.length > ID_MAX || text.includes("\0") || /[\r\n]/.test(text)) {
    throw new AutomationWakeIngressError("AUTOMATION_INVALID_INPUT", `${label} is not a valid bounded identifier`);
  }
  return text;
}

function normalizedTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AutomationWakeIngressError("AUTOMATION_INVALID_INPUT", `${label} is required`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new AutomationWakeIngressError("AUTOMATION_INVALID_INPUT", `${label} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}

function normalizedSourcePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new AutomationWakeIngressError("AUTOMATION_INVALID_SOURCE", "automation source path is required");
  if (value.length > SOURCE_PATH_MAX || value.includes("\0") || value.includes("\\")) {
    throw new AutomationWakeIngressError("AUTOMATION_INVALID_SOURCE", "automation source path is invalid");
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new AutomationWakeIngressError("AUTOMATION_INVALID_SOURCE", "automation source path must be relative to AI-Verse OS");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new AutomationWakeIngressError("AUTOMATION_INVALID_SOURCE", "automation source path contains traversal or empty segments");
  }
  return segments.join("/");
}

function normalizedStringList(value: string[] | undefined, label: string, max = 64): string[] {
  const values = value ?? [];
  if (!Array.isArray(values)) throw new AutomationWakeIngressError("AUTOMATION_INVALID_INPUT", `${label} must be an array`);
  if (values.length > max) throw new AutomationWakeIngressError("AUTOMATION_INVALID_INPUT", `${label} exceeds ${max} items`);
  const out = values.map((item, index) => {
    if (typeof item !== "string" || !item.trim() || item.includes("\0")) {
      throw new AutomationWakeIngressError("AUTOMATION_INVALID_INPUT", `${label}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
  return [...new Set(out)].sort();
}

function normalizedApproval(value: ApprovalRequirement | undefined): ApprovalRequirement | undefined {
  if (!value) return undefined;
  return {
    required: value.required === true,
    reason: typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : undefined,
    action: Object.keys(asObject(value.action)).length > 0 ? asObject(value.action) : undefined
  };
}

function normalizeRecovery(value: RecoveryPolicy | undefined, maxAttempts: number | undefined): { recoveryPolicy: RecoveryPolicy; maxAttempts: number } {
  const recoveryPolicy = value === "retry_safe" ? "retry_safe" : "manual";
  const fallback = recoveryPolicy === "retry_safe" ? 3 : 1;
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20)) {
    throw new AutomationWakeIngressError("AUTOMATION_INVALID_INPUT", "maxAttempts must be an integer from 1 to 20");
  }
  return { recoveryPolicy, maxAttempts: maxAttempts ?? fallback };
}

function assertNoSymlinkPath(root: string, relativePath: string): string {
  const target = resolve(root, ...relativePath.split("/"));
  const base = realpathSync(root);
  const rel = target === base ? "" : target.slice(resolve(root).length + 1);
  let current = resolve(root);
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) throw new AutomationWakeIngressError("AUTOMATION_SOURCE_MISSING", `automation source is missing: ${relativePath}`);
    if (lstatSync(current).isSymbolicLink()) {
      throw new AutomationWakeIngressError("AUTOMATION_SOURCE_UNSAFE", `automation source path contains a symlink: ${relativePath}`);
    }
  }
  const realTarget = realpathSync(target);
  const physicalRel = realTarget === base ? "" : realTarget.startsWith(`${base}${sep}`) ? realTarget.slice(base.length + 1) : null;
  if (physicalRel === null) throw new AutomationWakeIngressError("AUTOMATION_SOURCE_UNSAFE", "automation source escapes the AI-Verse OS root");
  if (!lstatSync(realTarget).isFile()) throw new AutomationWakeIngressError("AUTOMATION_INVALID_SOURCE", "automation source must be a regular file");
  return realTarget;
}

function projectionDigestBase(projection: Omit<AutomationInvocationProjection, "projection_digest">): string {
  return digestValue(projection);
}

function validateProjection(
  projection: AutomationInvocationProjection,
  expected: AutomationInvocationSourceInput
): AutomationInvocationProjection {
  if (projection.schema_version !== AI_VERSE_AUTOMATION_SCHEMA || !projection.provider) {
    throw new AutomationWakeIngressError("AUTOMATION_INVALID_PROJECTION", "automation source returned an invalid projection envelope");
  }
  if (projection.automation_id !== expected.automationId
    || projection.invocation_id !== expected.invocationId
    || projection.workspace_id !== expected.workspaceId
    || projection.fired_at !== expected.firedAt) {
    throw new AutomationWakeIngressError("AUTOMATION_INVALID_PROJECTION", "automation source projection does not match the invocation identity");
  }
  const source = asObject(projection.source) as AutomationInvocationSourceRef;
  if (source.kind !== expected.source.kind
    || source.path !== expected.source.path
    || source.source_digest !== expected.source.digest
    || (source.scope !== "shared" && source.scope !== `workspace:${expected.workspaceId}`)) {
    throw new AutomationWakeIngressError("AUTOMATION_INVALID_PROJECTION", "automation source projection binding does not match the invocation");
  }
  if (!HEX64.test(source.source_digest)) {
    throw new AutomationWakeIngressError("AUTOMATION_INVALID_PROJECTION", "automation source digest is invalid");
  }
  const { projection_digest: _ignored, ...base } = projection;
  if (projection.projection_digest !== projectionDigestBase(base)) {
    throw new AutomationWakeIngressError("AUTOMATION_INVALID_PROJECTION", "automation projection digest is invalid");
  }
  return projection;
}

export class AiVerseOsAutomationInvocationSource implements AutomationInvocationSource {
  readonly root: string;
  readonly projector: AiVerseOsWorkspaceProjector;
  readonly maxSourceBytes: number;

  constructor(rootInput: string, options: AiVerseOsAutomationInvocationSourceOptions = {}) {
    this.root = realpathSync(resolve(rootInput));
    this.projector = new AiVerseOsWorkspaceProjector(this.root);
    this.maxSourceBytes = Math.max(1024, Math.min(AI_VERSE_AUTOMATION_MAX_SOURCE_BYTES, options.maxSourceBytes ?? AI_VERSE_AUTOMATION_MAX_SOURCE_BYTES));
  }

  project(input: AutomationInvocationSourceInput): AutomationInvocationProjection {
    const automationId = boundedId(input.automationId, "automationId");
    const invocationId = boundedId(input.invocationId, "invocationId");
    const workspaceId = boundedId(input.workspaceId, "workspaceId");
    const firedAt = normalizedTimestamp(input.firedAt, "firedAt");
    const kind = input.source?.kind;
    if (kind !== "job" && kind !== "trigger") {
      throw new AutomationWakeIngressError("AUTOMATION_INVALID_SOURCE", "automation source kind must be job or trigger");
    }
    const sourcePath = normalizedSourcePath(input.source.path);
    const sourceDigest = typeof input.source.digest === "string" ? input.source.digest.trim() : "";
    if (!HEX64.test(sourceDigest)) throw new AutomationWakeIngressError("AUTOMATION_INVALID_SOURCE", "automation source digest must be 64 lowercase hex characters");

    const workspace = this.projector.project(workspaceId);
    const manifest = workspace.sources.find((item) => item.ref.endsWith("/WORKSPACE.yaml"));
    if (!manifest) throw new AutomationWakeIngressError("AUTOMATION_WORKSPACE_INVALID", "workspace projection did not expose its canonical manifest source");
    const workspaceRoot = dirname(manifest.ref).replace(/\\/g, "/");
    const workspacePrefix = `${workspaceRoot}/automations/`;
    const sharedPrefix = kind === "job" ? "automations/jobs/" : "automations/triggers/";
    const scope: AutomationInvocationSourceRef["scope"] = sourcePath.startsWith(workspacePrefix)
      ? `workspace:${workspaceId}`
      : sourcePath.startsWith(sharedPrefix)
        ? "shared"
        : (() => { throw new AutomationWakeIngressError("AUTOMATION_SOURCE_SCOPE_VIOLATION", `automation source ${sourcePath} is outside the allowed ${kind} or workspace automation roots`); })();

    const physical = assertNoSymlinkPath(this.root, sourcePath);
    const stat = lstatSync(physical);
    if (typeof stat.size === "number" && stat.size > this.maxSourceBytes) {
      throw new AutomationWakeIngressError("AUTOMATION_SOURCE_TOO_LARGE", `automation source exceeds ${this.maxSourceBytes} bytes`);
    }
    const text = readFileSync(physical, "utf8");
    if (byteLength(text) > this.maxSourceBytes) {
      throw new AutomationWakeIngressError("AUTOMATION_SOURCE_TOO_LARGE", `automation source exceeds ${this.maxSourceBytes} bytes`);
    }
    const currentDigest = sha256Text(text);
    if (currentDigest !== sourceDigest) {
      throw new AutomationWakeIngressError("AUTOMATION_SOURCE_CHANGED", "automation source digest no longer matches the fired invocation");
    }

    const base = {
      schema_version: AI_VERSE_AUTOMATION_SCHEMA as "1.0",
      provider: AI_VERSE_AUTOMATION_INVOCATION_PROVIDER,
      automation_id: automationId,
      invocation_id: invocationId,
      workspace_id: workspaceId,
      fired_at: firedAt,
      source: {
        kind,
        ref: `automation:${kind}:${automationId}`,
        path: sourcePath,
        scope,
        source_digest: currentDigest
      } as AutomationInvocationSourceRef
    };
    return { ...base, projection_digest: projectionDigestBase(base) };
  }
}

function boundedTeamRunBudget(value: BudgetEnvelope | undefined): BudgetEnvelope {
  const budget = normalizeBudget(value);
  for (const key of ["max_workers", "max_tasks", "max_actions", "wall_clock_seconds"] as const) {
    const item = budget[key];
    if (typeof item !== "number" || !Number.isFinite(item) || item < 1) {
      throw new AutomationWakeIngressError("AUTOMATION_BUDGET_REQUIRED", `automated Team Run requires a positive ${key} bound`);
    }
  }
  if (typeof budget.max_hops !== "number" || !Number.isFinite(budget.max_hops) || budget.max_hops < 0) {
    throw new AutomationWakeIngressError("AUTOMATION_BUDGET_REQUIRED", "automated Team Run requires a non-negative max_hops bound");
  }
  return budget;
}

export class AutomationWakeIngress {
  constructor(
    readonly store: CoordinationStore,
    readonly gateway: CoordinationGateway,
    readonly queue: ExecutionQueue,
    readonly source: AutomationInvocationSource
  ) {}

  ingest(raw: AutomationWakeIngressInput): AutomationWakeIngressResult {
    const sourceInput: AutomationInvocationSourceInput = {
      automationId: boundedId(raw.automationId, "automationId"),
      invocationId: boundedId(raw.invocationId, "invocationId"),
      workspaceId: boundedId(raw.workspaceId, "workspaceId"),
      firedAt: normalizedTimestamp(raw.firedAt, "firedAt"),
      source: {
        kind: raw.source?.kind,
        path: normalizedSourcePath(raw.source?.path),
        digest: typeof raw.source?.digest === "string" ? raw.source.digest.trim() : ""
      } as AutomationInvocationSourceInput["source"]
    };
    if ((sourceInput.source.kind !== "job" && sourceInput.source.kind !== "trigger") || !HEX64.test(sourceInput.source.digest)) {
      throw new AutomationWakeIngressError("AUTOMATION_INVALID_SOURCE", "automation source kind/digest is invalid");
    }

    const projection = validateProjection(this.source.project(sourceInput), sourceInput);
    const objective = typeof raw.objective === "string" ? raw.objective.trim() : "";
    if (!objective || objective.length > 8192 || objective.includes("\0")) {
      throw new AutomationWakeIngressError("AUTOMATION_INVALID_INPUT", "automation objective must be a non-empty bounded string");
    }
    const reason = typeof raw.reason === "string" && raw.reason.trim()
      ? raw.reason.trim()
      : `Execute automation ${projection.automation_id} invocation ${projection.invocation_id}`;
    if (reason.length > 4096 || reason.includes("\0")) throw new AutomationWakeIngressError("AUTOMATION_INVALID_INPUT", "automation reason is too large or invalid");

    const constraints = normalizeConstraints(raw.requiredConstraints ?? []);
    const tools = normalizedStringList(raw.tools, "tools");
    const connections = normalizedStringList(raw.connections, "connections");
    const skillRefs = parseTaskSkillRefs(raw.skillRefs, projection.workspace_id);
    const memoryRecall = parseTaskMemoryRecallRequest(raw.memoryRecall);
    const approval = normalizedApproval(raw.approval);
    const recovery = normalizeRecovery(raw.recoveryPolicy, raw.maxAttempts);
    const identityDigest = digestValue({
      provider: projection.provider,
      automation_id: projection.automation_id,
      invocation_id: projection.invocation_id,
      workspace_id: projection.workspace_id
    });
    const rootObjectiveId = `automation:${identityDigest}`;

    if (raw.target?.kind === "bot") {
      const targetId = boundedId(raw.target.botId, "target.botId");
      const budget = normalizeBudget(raw.budget);
      const requestContractDigest = digestValue({
        projection_digest: projection.projection_digest,
        target: { kind: "bot", id: targetId },
        objective,
        reason,
        required_constraints: constraints,
        expected_output: raw.expectedOutput ?? { contract: "automation-result-v1" },
        memory_recall: memoryRecall,
        skill_refs: skillRefs,
        tools,
        connections,
        budget,
        max_hops: raw.maxHops ?? null,
        deadline_at: raw.deadlineAt ?? null,
        lease_expires_at: raw.leaseExpiresAt ?? null,
        approval: approval ?? { required: false },
        recovery
      });
      return this.ingestBot({
        projection,
        identityDigest,
        requestContractDigest,
        rootObjectiveId,
        targetId,
        objective,
        reason,
        constraints,
        expectedOutput: raw.expectedOutput,
        memoryRecall,
        skillRefs,
        tools,
        connections,
        budget,
        maxHops: raw.maxHops,
        deadlineAt: raw.deadlineAt,
        leaseExpiresAt: raw.leaseExpiresAt,
        approval,
        recovery
      });
    }

    if (raw.target?.kind === "team_run") {
      if (approval?.required) {
        throw new AutomationWakeIngressError(
          "AUTOMATION_APPROVAL_REQUIRED",
          "automated Team Run start requires the owning AI-Verse OS automation layer to resolve its run-start approval before invoking Multiple Bots"
        );
      }
      if (memoryRecall) throw new AutomationWakeIngressError("AUTOMATION_INVALID_INPUT", "memoryRecall belongs to executable Tasks, not Team Run creation");
      const leaderId = boundedId(raw.target.leaderId, "target.leaderId");
      const topology = raw.target.topology ?? "dynamic_squad";
      if (!VALID_TOPOLOGIES.has(topology)) throw new AutomationWakeIngressError("AUTOMATION_INVALID_INPUT", `unsupported automated Team Run topology ${String(topology)}`);
      const budget = boundedTeamRunBudget(raw.budget);
      const requestContractDigest = digestValue({
        projection_digest: projection.projection_digest,
        target: { kind: "team_run", leader_id: leaderId, topology },
        objective,
        reason,
        required_constraints: constraints,
        skill_refs: skillRefs,
        required_tools: tools,
        required_connections: connections,
        budget
      });
      return this.ingestTeamRun({
        projection,
        identityDigest,
        requestContractDigest,
        rootObjectiveId,
        leaderId,
        topology,
        objective,
        reason,
        constraints,
        skillRefs,
        tools,
        connections,
        budget
      });
    }

    throw new AutomationWakeIngressError("AUTOMATION_INVALID_INPUT", "automation target kind must be bot or team_run");
  }

  private ingestBot(input: {
    projection: AutomationInvocationProjection;
    identityDigest: string;
    requestContractDigest: string;
    rootObjectiveId: string;
    targetId: string;
    objective: string;
    reason: string;
    constraints: string[];
    expectedOutput?: JsonObject;
    memoryRecall: HistoricalRecallRequest | null;
    skillRefs: string[];
    tools: string[];
    connections: string[];
    budget: BudgetEnvelope;
    maxHops?: number;
    deadlineAt?: string;
    leaseExpiresAt?: string;
    approval?: ApprovalRequirement;
    recovery: { recoveryPolicy: RecoveryPolicy; maxAttempts: number };
  }): AutomationWakeIngressResult {
    const suffix = input.identityDigest.slice(0, 32);
    const taskId = `task_automation_${suffix}`;
    const leaseId = `lease_automation_${suffix}`;
    const approvalId = `approval_automation_${suffix}`;
    const conflictingRun = this.store.getObject(`run_automation_${suffix}`);
    if (conflictingRun) {
      throw new AutomationWakeIngressError("AUTOMATION_INGRESS_CONFLICT", `automation invocation ${input.projection.invocation_id} already opened a Team Run`);
    }
    const existing = this.store.getObject(taskId);
    if (existing) return this.existingBot(existing, input.projection, input.requestContractDigest, leaseId, approvalId, input.recovery);

    const policy = this.gateway.policy;
    if (!policy) throw new AutomationWakeIngressError("AUTOMATION_POLICY_REQUIRED", "automation ingress requires CoordinationPolicy");
    const prepared = policy.prepareDelegation({
      createdBy: AI_VERSE_AUTOMATION_INGRESS_ACTOR,
      assigneeId: input.targetId,
      workspaceId: input.projection.workspace_id,
      rootObjectiveId: input.rootObjectiveId,
      objective: input.objective,
      requiredConstraints: input.constraints,
      tools: input.tools,
      connections: input.connections,
      skillRefs: input.skillRefs,
      maxHops: input.maxHops,
      deadlineAt: input.deadlineAt,
      budget: input.budget
    });

    const approvalRequired = input.approval?.required === true;
    const timestamp = new Date().toISOString();
    const lease = validateProtocolObject({
      schema_version: "1.0",
      id: leaseId,
      type: "capability_lease",
      principal: AI_VERSE_AUTOMATION_INGRESS_ACTOR,
      issued_to: input.targetId,
      workspace_id: input.projection.workspace_id,
      task_id: taskId,
      tools: input.tools,
      connections: input.connections,
      destructive_actions: approvalRequired ? "approval_required" : "deny",
      expires_at: input.leaseExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()
    }, "capability_lease");
    const task = validateProtocolObject({
      schema_version: "1.0",
      id: taskId,
      type: "task.delegate",
      created_by: AI_VERSE_AUTOMATION_INGRESS_ACTOR,
      assignee_id: input.targetId,
      owner_id: input.targetId,
      workspace_id: input.projection.workspace_id,
      root_objective_id: input.rootObjectiveId,
      parent_task_id: prepared.parentTaskId,
      reason: input.reason,
      objective: input.objective,
      required_constraints: normalizeConstraints(prepared.requiredConstraints),
      constraints_digest: constraintsDigest(prepared.requiredConstraints),
      expected_output: input.expectedOutput ?? { contract: "automation-result-v1" },
      input_artifact_refs: [],
      ...(input.memoryRecall ? { memory_recall: input.memoryRecall } : {}),
      ...(input.skillRefs.length > 0 ? { skill_refs: input.skillRefs } : {}),
      lease_id: leaseId,
      environment_lease_id: null,
      response_target: null,
      deadline_at: prepared.deadlineAt,
      budget: prepared.budget,
      approval_id: approvalRequired ? approvalId : null,
      hop: prepared.hop,
      max_hops: prepared.maxHops,
      recovery_policy: input.recovery.recoveryPolicy,
      max_attempts: input.recovery.maxAttempts,
      status: approvalRequired ? "waiting_approval" : "assigned",
      automation_ingress: this.ingressMetadata(input.projection, input.identityDigest, input.requestContractDigest, "bot")
    }, "task");

    const objects: Array<{ kind: "task" | "capability_lease" | "approval"; payload: JsonObject }> = [
      { kind: "capability_lease", payload: lease },
      { kind: "task", payload: task }
    ];
    const events: CoordinationEvent[] = [{
      schema_version: "1.0",
      id: `evt_automation_ingress_${suffix}`,
      type: "automation.invocation_ingressed",
      timestamp,
      actor_id: AI_VERSE_AUTOMATION_INGRESS_ACTOR,
      workspace_id: input.projection.workspace_id,
      task_id: taskId,
      correlation_id: input.rootObjectiveId,
      summary: `Automation ${input.projection.automation_id} woke durable Bot ${input.targetId}`
    }];
    let approval: JsonObject | null = null;
    if (approvalRequired) {
      const requestedAction = asObject(input.approval?.action);
      const approvalAction = {
        ...requestedAction,
        kind: typeof requestedAction.kind === "string" && requestedAction.kind ? requestedAction.kind : "task.execute",
        summary: typeof requestedAction.summary === "string" && requestedAction.summary
          ? requestedAction.summary
          : `Execute automated Task ${taskId}`,
        task_id: taskId
      };
      approval = validateProtocolObject({
        schema_version: "1.0",
        id: approvalId,
        type: "approval",
        workspace_id: input.projection.workspace_id,
        actor_id: input.targetId,
        task_id: taskId,
        requested_by: AI_VERSE_AUTOMATION_INGRESS_ACTOR,
        requested_at: timestamp,
        status: "pending",
        reason: input.approval?.reason ?? input.reason,
        action: approvalAction
      }, "approval");
      objects.push({ kind: "approval", payload: approval });
      events.push({
        schema_version: "1.0",
        id: `evt_automation_approval_${suffix}`,
        type: "approval.requested",
        timestamp,
        actor_id: AI_VERSE_AUTOMATION_INGRESS_ACTOR,
        workspace_id: input.projection.workspace_id,
        task_id: taskId,
        correlation_id: input.rootObjectiveId,
        summary: `Approval required before automated Task ${taskId}`
      });
    } else {
      events.push({
        schema_version: "1.0",
        id: `evt_automation_assigned_${suffix}`,
        type: "task.assigned",
        timestamp,
        actor_id: AI_VERSE_AUTOMATION_INGRESS_ACTOR,
        workspace_id: input.projection.workspace_id,
        task_id: taskId,
        correlation_id: input.rootObjectiveId,
        summary: `Assigned automated Task ${taskId} to ${input.targetId}`
      });
    }

    try {
      this.store.atomicMutation({
        preconditions: [{ id: input.targetId, kind: "bot", status: "active" }],
        objects,
        events
      });
    } catch (error) {
      const raced = this.store.getObject(taskId);
      if (!raced) throw error;
      return this.existingBot(raced, input.projection, input.requestContractDigest, leaseId, approvalId, input.recovery);
    }

    if (!approvalRequired) {
      this.queue.enqueueTask(taskId, input.targetId, input.projection.workspace_id, {
        recoveryPolicy: input.recovery.recoveryPolicy,
        maxAttempts: input.recovery.maxAttempts
      });
    }
    const storedTask = this.store.getObject(taskId);
    const storedLease = this.store.getObject(leaseId);
    const storedApproval = approvalRequired ? this.store.getObject(approvalId) : null;
    if (!storedTask || !storedLease) throw new AutomationWakeIngressError("AUTOMATION_PERSISTENCE_FAILED", "automation Bot wake did not persist its Task/lease");
    return { mode: "bot", projection: input.projection, task: storedTask, lease: storedLease, approval: storedApproval, created: true };
  }

  private existingBot(
    task: StoredObject,
    projection: AutomationInvocationProjection,
    requestContractDigest: string,
    leaseId: string,
    approvalId: string,
    recovery: { recoveryPolicy: RecoveryPolicy; maxAttempts: number }
  ): AutomationWakeIngressResult {
    if (task.kind !== "task") throw new AutomationWakeIngressError("AUTOMATION_INGRESS_CONFLICT", `automation invocation identity already belongs to ${task.kind}`);
    const ingress = asObject(task.payload.automation_ingress);
    if (ingress.request_contract_digest !== requestContractDigest
      || ingress.projection_digest !== projection.projection_digest
      || ingress.automation_id !== projection.automation_id
      || ingress.invocation_id !== projection.invocation_id) {
      throw new AutomationWakeIngressError("AUTOMATION_INGRESS_CONFLICT", `automation invocation ${projection.invocation_id} was already ingressed with a different contract`);
    }
    const lease = this.store.getObject(leaseId);
    if (!lease || lease.kind !== "capability_lease") throw new AutomationWakeIngressError("AUTOMATION_PERSISTENCE_FAILED", "existing automated Task is missing its capability lease");
    const approvalExpected = typeof task.payload.approval_id === "string";
    const approval = approvalExpected ? this.store.getObject(approvalId) : null;
    if (approvalExpected && (!approval || approval.kind !== "approval")) {
      throw new AutomationWakeIngressError("AUTOMATION_PERSISTENCE_FAILED", "existing automated Task is missing its Approval");
    }
    if (task.payload.status === "assigned" && !this.queue.getByItem(task.id)) {
      this.queue.enqueueTask(task.id, String(task.payload.assignee_id), projection.workspace_id, {
        recoveryPolicy: recovery.recoveryPolicy,
        maxAttempts: recovery.maxAttempts
      });
    }
    return { mode: "bot", projection, task, lease, approval, created: false };
  }

  private ingestTeamRun(input: {
    projection: AutomationInvocationProjection;
    identityDigest: string;
    requestContractDigest: string;
    rootObjectiveId: string;
    leaderId: string;
    topology: TeamRunTopology;
    objective: string;
    reason: string;
    constraints: string[];
    skillRefs: string[];
    tools: string[];
    connections: string[];
    budget: BudgetEnvelope;
  }): AutomationWakeIngressResult {
    const suffix = input.identityDigest.slice(0, 32);
    const runId = `run_automation_${suffix}`;
    const conflictingTask = this.store.getObject(`task_automation_${suffix}`);
    if (conflictingTask) {
      throw new AutomationWakeIngressError("AUTOMATION_INGRESS_CONFLICT", `automation invocation ${input.projection.invocation_id} already woke a durable Bot`);
    }
    const existing = this.store.getObject(runId);
    if (existing) return this.existingTeamRun(existing, input.projection, input.requestContractDigest);

    const policy = this.gateway.policy;
    if (!policy) throw new AutomationWakeIngressError("AUTOMATION_POLICY_REQUIRED", "automation ingress requires CoordinationPolicy");
    policy.prepareDelegation({
      createdBy: AI_VERSE_AUTOMATION_INGRESS_ACTOR,
      assigneeId: input.leaderId,
      workspaceId: input.projection.workspace_id,
      rootObjectiveId: input.rootObjectiveId,
      objective: input.objective,
      requiredConstraints: input.constraints,
      tools: input.tools,
      connections: input.connections,
      skillRefs: input.skillRefs,
      maxHops: Number(input.budget.max_hops),
      budget: input.budget
    });
    const leader = this.gateway.getBot(input.leaderId);
    if (!leader || leader.payload.status !== "active" || leader.workspaceId !== input.projection.workspace_id) {
      throw new AutomationWakeIngressError("AUTOMATION_TARGET_UNAVAILABLE", `Team Run leader ${input.leaderId} is not active in workspace ${input.projection.workspace_id}`);
    }
    if (asObject(leader.payload.permissions).can_create_workers === false) {
      throw new AutomationWakeIngressError("AUTOMATION_TARGET_UNAVAILABLE", `Team Run leader ${input.leaderId} cannot create temporary Workers`);
    }

    const timestamp = new Date().toISOString();
    const run = validateProtocolObject({
      schema_version: "1.0",
      id: runId,
      type: "team_run",
      workspace_id: input.projection.workspace_id,
      root_objective_id: input.rootObjectiveId,
      objective: input.objective,
      leader_id: input.leaderId,
      participant_ids: [input.leaderId],
      topology: input.topology,
      status: "created",
      budget: input.budget,
      required_constraints: input.constraints,
      constraints_digest: constraintsDigest(input.constraints),
      required_tools: input.tools,
      required_connections: input.connections,
      ...(input.skillRefs.length > 0 ? { required_skill_refs: input.skillRefs } : {}),
      automation_reason: input.reason,
      automation_ingress: this.ingressMetadata(input.projection, input.identityDigest, input.requestContractDigest, "team_run"),
      created_at: timestamp,
      updated_at: timestamp
    }, "team_run");
    const events: CoordinationEvent[] = [{
      schema_version: "1.0",
      id: `evt_automation_ingress_${suffix}`,
      type: "automation.invocation_ingressed",
      timestamp,
      actor_id: AI_VERSE_AUTOMATION_INGRESS_ACTOR,
      workspace_id: input.projection.workspace_id,
      run_id: runId,
      correlation_id: input.rootObjectiveId,
      summary: `Automation ${input.projection.automation_id} opened bounded Team Run ${runId}`
    }, {
      schema_version: "1.0",
      id: `evt_automation_run_created_${suffix}`,
      type: "team_run.created",
      timestamp,
      actor_id: input.leaderId,
      workspace_id: input.projection.workspace_id,
      run_id: runId,
      correlation_id: input.rootObjectiveId,
      causation_id: `evt_automation_ingress_${suffix}`,
      summary: `Created automated Team Run ${runId} with leader ${input.leaderId}`
    }];

    try {
      this.store.atomicMutation({
        preconditions: [{ id: input.leaderId, kind: "bot", status: "active" }],
        objects: [{ kind: "team_run", payload: run }],
        events
      });
    } catch (error) {
      const raced = this.store.getObject(runId);
      if (!raced) throw error;
      return this.existingTeamRun(raced, input.projection, input.requestContractDigest);
    }

    const stored = this.store.getObject(runId);
    if (!stored) throw new AutomationWakeIngressError("AUTOMATION_PERSISTENCE_FAILED", "automation Team Run start did not persist its run");
    return { mode: "team_run", projection: input.projection, run: stored, created: true };
  }

  private existingTeamRun(
    run: StoredObject,
    projection: AutomationInvocationProjection,
    requestContractDigest: string
  ): AutomationWakeIngressResult {
    if (run.kind !== "team_run") throw new AutomationWakeIngressError("AUTOMATION_INGRESS_CONFLICT", `automation invocation identity already belongs to ${run.kind}`);
    const ingress = asObject(run.payload.automation_ingress);
    if (ingress.request_contract_digest !== requestContractDigest
      || ingress.projection_digest !== projection.projection_digest
      || ingress.automation_id !== projection.automation_id
      || ingress.invocation_id !== projection.invocation_id) {
      throw new AutomationWakeIngressError("AUTOMATION_INGRESS_CONFLICT", `automation invocation ${projection.invocation_id} was already ingressed with a different Team Run contract`);
    }
    return { mode: "team_run", projection, run, created: false };
  }

  private ingressMetadata(
    projection: AutomationInvocationProjection,
    identityDigest: string,
    requestContractDigest: string,
    targetKind: "bot" | "team_run"
  ): JsonObject {
    return {
      provider: projection.provider,
      schema_version: projection.schema_version,
      automation_id: projection.automation_id,
      invocation_id: projection.invocation_id,
      fired_at: projection.fired_at,
      source_kind: projection.source.kind,
      source_ref: projection.source.ref,
      source_path: projection.source.path,
      source_scope: projection.source.scope,
      source_digest: projection.source.source_digest,
      projection_digest: projection.projection_digest,
      identity_digest: identityDigest,
      request_contract_digest: requestContractDigest,
      target_kind: targetKind
    };
  }
}
