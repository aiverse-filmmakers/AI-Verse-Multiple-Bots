import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  SkillsCapabilityResolutionError,
  SkillsCapabilityRuntimeRegistry,
  parseTaskSkillRefs
} from "../src/skills-capability-runtime.js";
import {
  RuntimeRegistry,
  type ResolvedSkillCapability,
  type RuntimeAdapter,
  type RuntimeExecutionContext,
  type SkillsCapabilityProjection,
  type SkillsCapabilitySource
} from "../src/runtime.js";
import type { JsonObject, StoredObject } from "../src/types.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stored(id: string, kind: string, workspaceId: string, payload: JsonObject): StoredObject {
  return {
    id,
    kind: kind as any,
    workspaceId,
    status: typeof payload.status === "string" ? payload.status : null,
    payload,
    createdAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z"
  };
}

function capability(
  requestedRef: string,
  overrides: Partial<ResolvedSkillCapability> = {}
): ResolvedSkillCapability {
  const instructions = overrides.instructions ?? "SKILL_INSTRUCTION_SECRET_MARKER";
  return {
    requested_ref: requestedRef,
    id: overrides.id ?? (requestedRef.includes(":") ? requestedRef : `aiverse-skills:${requestedRef}`),
    name: overrides.name ?? "Deep Research",
    description: overrides.description ?? "Perform bounded evidence-first research.",
    provider: overrides.provider ?? "aiverse-skills",
    visibility: overrides.visibility ?? "shared",
    version: overrides.version ?? "1.0.0",
    generation_id: overrides.generation_id ?? "gen-1",
    path: overrides.path ?? "skills/deep-research",
    digest_algorithm: overrides.digest_algorithm ?? "aiverse-package-sha256-v1",
    digest: overrides.digest ?? "a".repeat(64),
    readiness: overrides.readiness ?? "UNVERIFIED",
    permission: overrides.permission ?? "unknown",
    approval: overrides.approval ?? "not_required",
    operators: overrides.operators ?? [],
    dependencies: overrides.dependencies ?? [],
    instructions,
    instruction_digest: overrides.instruction_digest ?? sha256(instructions)
  };
}

function projection(
  workspaceId: string,
  refs: string[],
  capabilities = refs.map((ref) => capability(ref)),
  overrides: Partial<SkillsCapabilityProjection> = {}
): SkillsCapabilityProjection {
  const requestDigest = sha256(canonicalJson({ workspace_id: workspaceId, skill_refs: refs }));
  const provider = overrides.provider ?? "test-skills-source";
  const resolutionDigest = sha256(canonicalJson({
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
  return {
    schema_version: "1.0",
    provider,
    workspace_id: workspaceId,
    request_digest: overrides.request_digest ?? requestDigest,
    resolution_digest: overrides.resolution_digest ?? resolutionDigest,
    resolved_at: "2026-09-10T12:00:00.000Z",
    capabilities,
    ...overrides
  };
}

function context(
  skillRefs: string[] = [],
  declaredRefs: string[] = skillRefs,
  workspaceId = "ws-alpha"
): RuntimeExecutionContext {
  const bot = stored("bot_skills", "bot", workspaceId, {
    schema_version: "1.0",
    id: "bot_skills",
    name: "Skills Bot",
    kind: "durable",
    status: "active",
    role: { title: "Researcher", mission: "Use only declared methods." },
    capabilities: { skill_refs: declaredRefs },
    runtime: { adapter: "capture" }
  });
  return {
    principal: bot,
    principalKind: "bot",
    bot: bot as any,
    runtime: {},
    task: stored("task_skills", "task", workspaceId, {
      schema_version: "1.0",
      id: "task_skills",
      type: "task.delegate",
      workspace_id: workspaceId,
      root_objective_id: "root_skills",
      objective: "Research with the requested method",
      required_constraints: [],
      ...(skillRefs.length ? { skill_refs: skillRefs } : {})
    }),
    capabilityLease: stored("lease_skills", "capability_lease", workspaceId, {
      id: "lease_skills",
      tools: ["safe.tool"],
      connections: [],
      destructive_actions: "deny"
    }),
    environmentLease: null,
    inputArtifacts: [],
    signal: new AbortController().signal
  };
}

class FakeSource implements SkillsCapabilitySource {
  calls: Array<{ workspaceId: string; refs: string[] }> = [];
  constructor(readonly result: SkillsCapabilityProjection) {}
  async resolve(workspaceId: string, refs: string[]): Promise<SkillsCapabilityProjection> {
    this.calls.push({ workspaceId, refs: [...refs] });
    return this.result;
  }
}

class CaptureRuntime implements RuntimeAdapter {
  readonly id = "capture";
  contexts: RuntimeExecutionContext[] = [];
  async execute(ctx: RuntimeExecutionContext): Promise<any> {
    this.contexts.push(ctx);
    return {
      summary: "captured",
      artifactKind: "capture",
      output: { ok: true },
      usage: { actions: 1 },
      receipts: [{ kind: "inner" }]
    };
  }
}

test("Task skill references are explicit, bounded, deduplicated, and cannot widen workspace scope", () => {
  assert.deepEqual(parseTaskSkillRefs(undefined, "ws-alpha"), []);
  assert.deepEqual(
    parseTaskSkillRefs(["deep-research", "deep-research", "aiverse-skills:verify"], "ws-alpha"),
    ["aiverse-skills:verify", "deep-research"]
  );
  assert.deepEqual(
    parseTaskSkillRefs(["workspace:ws-alpha:brand-review"], "ws-alpha"),
    ["workspace:ws-alpha:brand-review"]
  );
  assert.throws(
    () => parseTaskSkillRefs(["workspace:ws-beta:brand-review"], "ws-alpha"),
    (error: unknown) => error instanceof SkillsCapabilityResolutionError && error.code === "SKILLS_SCOPE_VIOLATION"
  );
  assert.throws(() => parseTaskSkillRefs(new Array(13).fill("deep-research"), "ws-alpha"), /maximum of 12/i);
  assert.throws(() => parseTaskSkillRefs(["bad/ref"], "ws-alpha"), /Invalid capability reference/i);
});

test("ordinary Task with no skill references invokes no capability source", async () => {
  const inner = new CaptureRuntime();
  const source = new FakeSource(projection("ws-alpha", ["deep-research"]));
  const registry = new SkillsCapabilityRuntimeRegistry(new RuntimeRegistry().register(inner), source);
  const result = await registry.get("capture").execute(context());
  assert.equal(result.summary, "captured");
  assert.equal(source.calls.length, 0);
  assert.equal(inner.contexts[0]?.skillsCapabilityResolution, undefined);
});

test("resolved skill instructions reach runtime but receipts persist only bounded provenance", async () => {
  const refs = ["deep-research"];
  const inner = new CaptureRuntime();
  const source = new FakeSource(projection("ws-alpha", refs));
  const registry = new SkillsCapabilityRuntimeRegistry(new RuntimeRegistry().register(inner), source);
  const ctx = context(refs);
  const leaseBefore = JSON.stringify(ctx.capabilityLease.payload);
  const result = await registry.get("capture").execute(ctx);

  assert.deepEqual(source.calls, [{ workspaceId: "ws-alpha", refs }]);
  assert.equal(inner.contexts[0]?.skillsCapabilityResolution?.capabilities[0]?.instructions, "SKILL_INSTRUCTION_SECRET_MARKER");
  assert.equal(JSON.stringify(ctx.capabilityLease.payload), leaseBefore);
  assert.deepEqual(ctx.capabilityLease.payload.tools, ["safe.tool"]);
  assert.deepEqual(ctx.capabilityLease.payload.connections, []);

  const receiptText = JSON.stringify(result.receipts);
  assert.match(receiptText, /skills_capability_resolution/);
  assert.match(receiptText, /instruction_digest/);
  assert.equal(receiptText.includes("SKILL_INSTRUCTION_SECRET_MARKER"), false);
  assert.equal(receiptText.includes('"permission":"unknown"'), false);
  assert.equal(receiptText.includes('"approval":"not_required"'), false);
});

test("execution fails before resolution when Task skill was not declared by the current principal", async () => {
  const refs = ["deep-research"];
  const inner = new CaptureRuntime();
  const source = new FakeSource(projection("ws-alpha", refs));
  const registry = new SkillsCapabilityRuntimeRegistry(new RuntimeRegistry().register(inner), source);
  await assert.rejects(
    () => registry.get("capture").execute(context(refs, [])),
    (error: unknown) => error instanceof SkillsCapabilityResolutionError && error.code === "SKILLS_NOT_DECLARED"
  );
  assert.equal(source.calls.length, 0);
  assert.equal(inner.contexts.length, 0);
});

test("explicit skill Task fails closed when no capability source is configured", async () => {
  const refs = ["deep-research"];
  const inner = new CaptureRuntime();
  const registry = new SkillsCapabilityRuntimeRegistry(new RuntimeRegistry().register(inner));
  await assert.rejects(
    () => registry.get("capture").execute(context(refs)),
    (error: unknown) => error instanceof SkillsCapabilityResolutionError && error.code === "SKILLS_UNAVAILABLE"
  );
  assert.equal(inner.contexts.length, 0);
});

test("cross-workspace capability projection fails before the model runtime executes", async () => {
  const refs = ["deep-research"];
  const inner = new CaptureRuntime();
  const badCapability = capability("deep-research", { visibility: "workspace:ws-beta" });
  const source = new FakeSource(projection("ws-alpha", refs, [badCapability]));
  const registry = new SkillsCapabilityRuntimeRegistry(new RuntimeRegistry().register(inner), source);
  await assert.rejects(
    () => registry.get("capture").execute(context(refs)),
    (error: unknown) => error instanceof SkillsCapabilityResolutionError && error.code === "SKILLS_SCOPE_VIOLATION"
  );
  assert.equal(inner.contexts.length, 0);
});

test("forged resolution digest fails closed before runtime", async () => {
  const refs = ["deep-research"];
  const inner = new CaptureRuntime();
  const source = new FakeSource(projection("ws-alpha", refs, undefined, { resolution_digest: "forged" }));
  const registry = new SkillsCapabilityRuntimeRegistry(new RuntimeRegistry().register(inner), source);
  await assert.rejects(
    () => registry.get("capture").execute(context(refs)),
    /resolution digest does not match/i
  );
  assert.equal(inner.contexts.length, 0);
});

test("qualified request cannot be rebound to a different canonical capability", async () => {
  const refs = ["aiverse-skills:deep-research"];
  const inner = new CaptureRuntime();
  const rebound = capability(refs[0]!, { id: "local:deep-research", provider: "local" });
  const source = new FakeSource(projection("ws-alpha", refs, [rebound]));
  const registry = new SkillsCapabilityRuntimeRegistry(new RuntimeRegistry().register(inner), source);
  await assert.rejects(
    () => registry.get("capture").execute(context(refs)),
    /resolved to a different capability/i
  );
  assert.equal(inner.contexts.length, 0);
});
