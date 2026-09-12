import { createHash } from "node:crypto";
import type { JsonObject } from "./types.js";
import {
  RuntimeRegistry,
  type ResolvedSkillCapability,
  type RuntimeAdapter,
  type RuntimeExecutionContext,
  type RuntimeExecutionResult,
  type SkillsCapabilityProjection,
  type SkillsCapabilitySource
} from "./runtime.js";

export const MAX_TASK_SKILL_REFS = 12;
const SEGMENT = /^[a-z0-9][a-z0-9-]*$/;
const ALLOWED_PROVIDERS = new Set(["os", "aiverse-skills", "local"]);

export class SkillsCapabilityResolutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SkillsCapabilityResolutionError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validSkillRef(value: string): boolean {
  const parts = value.split(":");
  if (parts.length === 1) return SEGMENT.test(parts[0] ?? "");
  if (parts.length === 2) return ALLOWED_PROVIDERS.has(parts[0] ?? "") && SEGMENT.test(parts[1] ?? "");
  return parts.length === 3 && parts[0] === "workspace" && SEGMENT.test(parts[1] ?? "") && SEGMENT.test(parts[2] ?? "");
}

export function parseTaskSkillRefs(value: unknown, workspaceId?: string): string[] {
  if (value === undefined || value === null || value === false) return [];
  if (!Array.isArray(value)) {
    throw new SkillsCapabilityResolutionError("SKILLS_INVALID_REQUEST", "skill_refs must be an array of capability references");
  }
  if (value.length > MAX_TASK_SKILL_REFS) {
    throw new SkillsCapabilityResolutionError("SKILLS_INVALID_REQUEST", `skill_refs exceeds the maximum of ${MAX_TASK_SKILL_REFS}`);
  }
  const refs: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !item.trim() || item.includes("\0")) {
      throw new SkillsCapabilityResolutionError("SKILLS_INVALID_REQUEST", `skill_refs[${index}] must be a non-empty capability reference without NUL bytes`);
    }
    const ref = item.trim();
    if (ref.length > 256 || !validSkillRef(ref)) {
      throw new SkillsCapabilityResolutionError("SKILLS_INVALID_REQUEST", `Invalid capability reference '${ref}'`);
    }
    const parts = ref.split(":");
    if (workspaceId && parts[0] === "workspace" && parts[1] !== workspaceId) {
      throw new SkillsCapabilityResolutionError(
        "SKILLS_SCOPE_VIOLATION",
        `Capability reference ${ref} cannot widen Task workspace ${workspaceId}`
      );
    }
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs.sort();
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function expectedResolutionDigest(
  provider: string,
  workspaceId: string,
  requestDigest: string,
  capabilities: ResolvedSkillCapability[]
): string {
  return sha256(canonicalJson({
    provider,
    workspace_id: workspaceId,
    request_digest: requestDigest,
    capabilities: capabilities.map((item) => ({
      requested_ref: item.requested_ref,
      id: item.id,
      provider: item.provider,
      version: item.version,
      generation_id: item.generation_id,
      path: item.path,
      digest_algorithm: item.digest_algorithm,
      digest: item.digest,
      instruction_digest: item.instruction_digest
    }))
  }));
}

function assertPrincipalDeclaresSkills(context: RuntimeExecutionContext, refs: string[]): void {
  const declared = new Set(stringArray(asObject(context.principal.payload.capabilities).skill_refs));
  for (const ref of refs) {
    if (!declared.has(ref)) {
      throw new SkillsCapabilityResolutionError(
        "SKILLS_NOT_DECLARED",
        `${context.principalKind} ${context.principal.id} does not declare Task skill capability ${ref}`
      );
    }
  }
}

function validateProjection(
  projection: SkillsCapabilityProjection,
  workspaceId: string,
  requestedRefs: string[]
): SkillsCapabilityProjection {
  if (projection.schema_version !== "1.0" || !projection.provider || projection.workspace_id !== workspaceId) {
    throw new SkillsCapabilityResolutionError("SKILLS_INVALID_OUTPUT", "Capability source returned an invalid workspace projection");
  }
  if (!Array.isArray(projection.capabilities) || projection.capabilities.length !== requestedRefs.length) {
    throw new SkillsCapabilityResolutionError("SKILLS_INVALID_OUTPUT", "Capability source did not resolve every requested skill exactly once");
  }
  const seen = new Set<string>();
  for (const capability of projection.capabilities) {
    for (const [label, value] of [
      ["id", capability.id],
      ["provider", capability.provider],
      ["version", capability.version],
      ["generation_id", capability.generation_id],
      ["path", capability.path],
      ["digest_algorithm", capability.digest_algorithm],
      ["digest", capability.digest]
    ] as const) {
      if (typeof value !== "string" || !value.trim()) {
        throw new SkillsCapabilityResolutionError("SKILLS_INVALID_OUTPUT", `Resolved capability ${capability.requested_ref} has invalid ${label}`);
      }
    }
    if (!requestedRefs.includes(capability.requested_ref) || seen.has(capability.requested_ref)) {
      throw new SkillsCapabilityResolutionError("SKILLS_INVALID_OUTPUT", "Capability source returned an unexpected or duplicate requested_ref");
    }
    seen.add(capability.requested_ref);
    if (capability.requested_ref.includes(":") && capability.id !== capability.requested_ref) {
      throw new SkillsCapabilityResolutionError(
        "SKILLS_INVALID_OUTPUT",
        `Qualified capability request ${capability.requested_ref} resolved to a different capability ${capability.id}`
      );
    }
    if (capability.visibility.startsWith("workspace:") && capability.visibility !== `workspace:${workspaceId}`) {
      throw new SkillsCapabilityResolutionError("SKILLS_SCOPE_VIOLATION", `Resolved capability ${capability.id} escaped Task workspace ${workspaceId}`);
    }
    if (!capability.instructions || !capability.instruction_digest || capability.instruction_digest !== sha256(capability.instructions)) {
      throw new SkillsCapabilityResolutionError("SKILLS_INVALID_OUTPUT", `Resolved capability ${capability.id} has invalid instruction integrity`);
    }
  }
  const expectedRequestDigest = sha256(canonicalJson({ workspace_id: workspaceId, skill_refs: requestedRefs }));
  if (projection.request_digest !== expectedRequestDigest) {
    throw new SkillsCapabilityResolutionError("SKILLS_INVALID_OUTPUT", "Capability source request digest does not match the Task request");
  }
  const expectedDigest = expectedResolutionDigest(
    projection.provider,
    workspaceId,
    projection.request_digest,
    projection.capabilities
  );
  if (projection.resolution_digest !== expectedDigest) {
    throw new SkillsCapabilityResolutionError("SKILLS_INVALID_OUTPUT", "Capability source resolution digest does not match the resolved capability set");
  }
  return projection;
}

export class SkillsCapabilityRuntimeRegistry extends RuntimeRegistry {
  private readonly wrapped = new Map<string, RuntimeAdapter>();

  constructor(readonly base: RuntimeRegistry, readonly source?: SkillsCapabilitySource) {
    super();
  }

  override register(adapter: RuntimeAdapter): this {
    this.base.register(adapter);
    return this;
  }

  override has(id: string): boolean {
    return this.base.has(id);
  }

  override get(id: string): RuntimeAdapter {
    const existing = this.wrapped.get(id);
    if (existing) return existing;
    const inner = this.base.get(id);
    const source = this.source;
    const wrapped: RuntimeAdapter = {
      id: inner.id,
      async execute(context: RuntimeExecutionContext): Promise<RuntimeExecutionResult> {
        const workspaceId = context.task.workspaceId;
        const refs = parseTaskSkillRefs(context.task.payload.skill_refs, workspaceId ?? undefined);
        if (refs.length === 0) return inner.execute(context);
        if (!workspaceId || context.principal.workspaceId !== workspaceId) {
          throw new SkillsCapabilityResolutionError(
            "SKILLS_SCOPE_VIOLATION",
            `Skill resolution requires Task ${context.task.id} and ${context.principal.id} to share one explicit workspace`
          );
        }
        assertPrincipalDeclaresSkills(context, refs);
        if (!source) {
          throw new SkillsCapabilityResolutionError(
            "SKILLS_UNAVAILABLE",
            "Task requires skill capabilities but no host capability-resolution source is configured"
          );
        }
        const projection = validateProjection(await source.resolve(workspaceId, refs), workspaceId, refs);
        const result = await inner.execute({ ...context, skillsCapabilityResolution: projection });
        const receipt: JsonObject = {
          kind: "skills_capability_resolution",
          provider: projection.provider,
          schema_version: projection.schema_version,
          workspace_id: projection.workspace_id,
          request_digest: projection.request_digest,
          resolution_digest: projection.resolution_digest,
          capabilities: projection.capabilities.map((capability: ResolvedSkillCapability) => ({
            requested_ref: capability.requested_ref,
            id: capability.id,
            provider: capability.provider,
            version: capability.version,
            generation_id: capability.generation_id,
            path: capability.path,
            digest_algorithm: capability.digest_algorithm,
            digest: capability.digest,
            instruction_digest: capability.instruction_digest
          }))
        };
        return { ...result, receipts: [...(result.receipts ?? []), receipt] };
      },
      ...(inner.cancel ? { cancel: (taskId: string) => inner.cancel!(taskId) } : {}),
      ...(inner.settle ? { settle: (taskId: string) => inner.settle!(taskId) } : {})
    };
    this.wrapped.set(id, wrapped);
    return wrapped;
  }
}
