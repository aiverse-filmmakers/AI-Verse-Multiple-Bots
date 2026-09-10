import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import process from "node:process";
import { detectAiVerseOsCompatibility } from "./ai-verse-os-registration.js";
import { parseTaskSkillRefs } from "./skills-capability-runtime.js";
import type {
  ResolvedSkillCapability,
  SkillsCapabilityProjection,
  SkillsCapabilitySource
} from "./runtime.js";

export const AI_VERSE_CAPABILITY_RESOLVER_PROVIDER = "ai-verse-os-capability-resolver-v1";
export const AI_VERSE_CAPABILITY_RESOLVER_PATH = "scripts/capability-resolver.mjs";
export const AI_VERSE_CAPABILITY_RESOLVER_CORE_PATH = "scripts/capability-resolver-core.mjs";
export const AI_VERSE_CAPABILITY_PROVIDER_CONTRACT = "aiverse-capability-provider-v1";
export const AI_VERSE_PACKAGE_DIGEST_ALGORITHM = "aiverse-package-sha256-v1";
export const AI_VERSE_SKILLS_MAX_INSTRUCTION_CHARS = 32_000;
export const AI_VERSE_SKILLS_MAX_TOTAL_INSTRUCTION_CHARS = 96_000;
export const AI_VERSE_SKILLS_DEFAULT_TIMEOUT_MS = 10_000;
export const AI_VERSE_SKILLS_MAX_BUFFER_BYTES = 1024 * 1024;

const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

const RESOLVER_BRIDGE = String.raw`
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const resolverPath = process.argv[1];
const osRoot = process.argv[2];
const workspaceId = process.argv[3];
const refs = JSON.parse(process.argv[4]);
const module = await import(pathToFileURL(resolverPath).href);
if (typeof module.selectCapability !== "function" || typeof module.packageDigestV1 !== "function") {
  throw new Error("[RESOLVER_CONTRACT_INVALID] AI-Verse OS capability resolver does not expose selectCapability + packageDigestV1");
}
const capabilities = [];
for (const requestedRef of refs) {
  const result = module.selectCapability({
    osRoot,
    scope: `workspace:${workspaceId}`,
    query: requestedRef,
    limit: 200
  });
  if (!result || result.status !== "selected" || !result.selection) {
    const reason = result && typeof result.reason === "string" ? result.reason : "capability unavailable";
    throw new Error(`[CAPABILITY_UNAVAILABLE] ${requestedRef}: ${reason}`);
  }
  const selection = result.selection;
  const packagePath = selection.locator && selection.locator.package_path;
  if (typeof packagePath !== "string" || !packagePath) {
    throw new Error(`[RESOLVER_CONTRACT_INVALID] ${requestedRef} has no package locator`);
  }
  if (!selection.digest || selection.digest.algorithm !== "aiverse-package-sha256-v1" || typeof selection.digest.value !== "string") {
    throw new Error(`[RESOLVER_CONTRACT_INVALID] ${requestedRef} has unsupported package digest`);
  }
  const actualDigest = module.packageDigestV1(packagePath);
  if (actualDigest !== selection.digest.value) {
    throw new Error(`[PACKAGE_INTEGRITY_FAILED] ${requestedRef} package digest changed before instruction load`);
  }
  const skillPath = path.join(packagePath, "SKILL.md");
  const realPackage = fs.realpathSync(packagePath);
  const realSkill = fs.realpathSync(skillPath);
  const rel = path.relative(realPackage, realSkill);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !fs.statSync(realSkill).isFile()) {
    throw new Error(`[PACKAGE_INTEGRITY_FAILED] ${requestedRef} SKILL.md escapes its selected package`);
  }
  capabilities.push({
    requested_ref: requestedRef,
    id: selection.id,
    name: selection.name,
    description: selection.description,
    provider: selection.provider,
    visibility: selection.visibility,
    version: selection.version,
    generation_id: selection.generation_id,
    path: selection.path,
    digest_algorithm: selection.digest.algorithm,
    digest: selection.digest.value,
    readiness: selection.readiness,
    permission: selection.permission,
    approval: selection.approval,
    operators: Array.isArray(selection.operators) ? selection.operators : [],
    dependencies: Array.isArray(selection.dependencies) ? selection.dependencies : [],
    instructions: fs.readFileSync(realSkill, "utf8")
  });
}
process.stdout.write(JSON.stringify({
  contract: "aiverse-capability-provider-v1",
  workspace_id: workspaceId,
  capabilities
}));
`;

export interface AiVerseSkillsCapabilityResolutionOptions {
  timeoutMs?: number;
  maxInstructionChars?: number;
  maxTotalInstructionChars?: number;
  execFileImpl?: typeof execFile;
  now?: () => Date;
}

export class AiVerseSkillsCapabilityResolutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AiVerseSkillsCapabilityResolutionError";
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

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requiredString(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AiVerseSkillsCapabilityResolutionError("SKILLS_INVALID_OUTPUT", `${label} must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new AiVerseSkillsCapabilityResolutionError("SKILLS_OUTPUT_TOO_LARGE", `${label} exceeds ${max} characters`);
  }
  return text;
}

function inside(path: string, root: string): boolean {
  const candidate = resolve(path);
  const base = resolve(root);
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

function assertRegularFileInsideRoot(root: string, relativePath: string, label: string): string {
  const base = resolve(root);
  const candidate = resolve(base, ...relativePath.split("/"));
  if (candidate === base || !inside(candidate, base)) {
    throw new AiVerseSkillsCapabilityResolutionError("SKILLS_UNSAFE_RESOLVER", `${label} escapes the AI-Verse OS root`);
  }
  const suffix = candidate.slice(base.length + 1);
  let current = base;
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) {
      throw new AiVerseSkillsCapabilityResolutionError("SKILLS_UNAVAILABLE", `${label} is missing: ${relativePath}`);
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw new AiVerseSkillsCapabilityResolutionError("SKILLS_UNSAFE_RESOLVER", `${label} path must not contain symlinks`);
    }
  }
  if (!lstatSync(candidate).isFile()) {
    throw new AiVerseSkillsCapabilityResolutionError("SKILLS_UNSAFE_RESOLVER", `${label} must be a regular file`);
  }
  const realRoot = realpathSync(base);
  const realFile = realpathSync(candidate);
  if (!inside(realFile, realRoot)) {
    throw new AiVerseSkillsCapabilityResolutionError("SKILLS_UNSAFE_RESOLVER", `${label} resolves outside the AI-Verse OS root`);
  }
  return candidate;
}

function runExecFile(
  execFileImpl: typeof execFile,
  args: string[],
  root: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFileImpl(
      process.execPath,
      args,
      {
        cwd: root,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: AI_VERSE_SKILLS_MAX_BUFFER_BYTES,
        windowsHide: true,
        shell: false
      },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          (error as any).stderr = String(stderr ?? "");
          rejectPromise(error);
          return;
        }
        resolvePromise({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    );
  });
}

export class AiVerseSkillsCapabilitySource implements SkillsCapabilitySource {
  readonly provider = AI_VERSE_CAPABILITY_RESOLVER_PROVIDER;
  readonly root: string;
  private readonly timeoutMs: number;
  private readonly maxInstructionChars: number;
  private readonly maxTotalInstructionChars: number;
  private readonly execFileImpl: typeof execFile;
  private readonly now: () => Date;

  constructor(rootInput: string, options: AiVerseSkillsCapabilityResolutionOptions = {}) {
    this.root = resolve(rootInput);
    this.timeoutMs = Math.max(1_000, Math.min(60_000, Math.floor(options.timeoutMs ?? AI_VERSE_SKILLS_DEFAULT_TIMEOUT_MS)));
    this.maxInstructionChars = Math.max(256, Math.min(AI_VERSE_SKILLS_MAX_INSTRUCTION_CHARS, options.maxInstructionChars ?? AI_VERSE_SKILLS_MAX_INSTRUCTION_CHARS));
    this.maxTotalInstructionChars = Math.max(this.maxInstructionChars, Math.min(AI_VERSE_SKILLS_MAX_TOTAL_INSTRUCTION_CHARS, options.maxTotalInstructionChars ?? AI_VERSE_SKILLS_MAX_TOTAL_INSTRUCTION_CHARS));
    this.execFileImpl = options.execFileImpl ?? execFile;
    this.now = options.now ?? (() => new Date());
  }

  async resolve(workspaceId: string, requested: string[]): Promise<SkillsCapabilityProjection> {
    if (!WORKSPACE_ID.test(workspaceId)) {
      throw new AiVerseSkillsCapabilityResolutionError("SKILLS_INVALID_WORKSPACE", `Invalid AI-Verse workspace ID '${workspaceId}'`);
    }
    const refs = parseTaskSkillRefs(requested, workspaceId);
    if (refs.length === 0) {
      throw new AiVerseSkillsCapabilityResolutionError("SKILLS_INVALID_REQUEST", "Capability resolution requires at least one skill reference");
    }
    const compatibility = detectAiVerseOsCompatibility(this.root);
    if (compatibility.status !== "compatible") {
      throw new AiVerseSkillsCapabilityResolutionError("SKILLS_UNAVAILABLE", compatibility.reason);
    }
    const resolverPath = assertRegularFileInsideRoot(this.root, AI_VERSE_CAPABILITY_RESOLVER_PATH, "AI-Verse OS capability resolver");
    assertRegularFileInsideRoot(this.root, AI_VERSE_CAPABILITY_RESOLVER_CORE_PATH, "AI-Verse OS capability resolver core");
    let stdout = "";
    try {
      ({ stdout } = await runExecFile(
        this.execFileImpl,
        ["--input-type=module", "--eval", RESOLVER_BRIDGE, resolverPath, this.root, workspaceId, JSON.stringify(refs)],
        this.root,
        this.timeoutMs
      ));
    } catch (error) {
      const stderr = String((error as any)?.stderr ?? "").replace(/\s+/g, " ").trim().slice(0, 1000);
      const detail = stderr || (error instanceof Error ? error.message : String(error));
      const code = detail.includes("[CAPABILITY_UNAVAILABLE]")
        ? "SKILLS_UNAVAILABLE"
        : detail.includes("[PACKAGE_INTEGRITY_FAILED]")
          ? "SKILLS_INTEGRITY_FAILED"
          : detail.includes("[RESOLVER_CONTRACT_INVALID]")
            ? "SKILLS_RESOLVER_INCOMPATIBLE"
            : ((error as any)?.killed === true || (error as any)?.signal === "SIGTERM")
              ? "SKILLS_RESOLVER_TIMEOUT"
              : "SKILLS_RESOLVER_FAILED";
      throw new AiVerseSkillsCapabilityResolutionError(code, `AI-Verse OS capability resolution failed: ${detail}`);
    }

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(stdout);
      const object = asObject(parsed);
      if (!object) throw new Error("response is not an object");
      payload = object;
    } catch (error) {
      throw new AiVerseSkillsCapabilityResolutionError("SKILLS_INVALID_OUTPUT", `Capability resolver returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (payload.contract !== AI_VERSE_CAPABILITY_PROVIDER_CONTRACT || payload.workspace_id !== workspaceId || !Array.isArray(payload.capabilities)) {
      throw new AiVerseSkillsCapabilityResolutionError("SKILLS_INVALID_OUTPUT", "Capability resolver returned an invalid provider contract envelope");
    }
    if (payload.capabilities.length !== refs.length) {
      throw new AiVerseSkillsCapabilityResolutionError("SKILLS_INVALID_OUTPUT", "Capability resolver did not resolve every requested skill exactly once");
    }

    const capabilities: ResolvedSkillCapability[] = [];
    let totalInstructions = 0;
    for (const [index, raw] of payload.capabilities.entries()) {
      const item = asObject(raw);
      if (!item) throw new AiVerseSkillsCapabilityResolutionError("SKILLS_INVALID_OUTPUT", `Resolved capability ${index} must be an object`);
      const requestedRef = requiredString(item.requested_ref, `capabilities[${index}].requested_ref`, 256);
      if (requestedRef !== refs[index]) {
        throw new AiVerseSkillsCapabilityResolutionError("SKILLS_INVALID_OUTPUT", `Capability resolution order/binding changed for ${requestedRef}`);
      }
      const id = requiredString(item.id, `capability ${requestedRef}.id`, 256);
      const provider = requiredString(item.provider, `capability ${id}.provider`, 256);
      const visibility = requiredString(item.visibility, `capability ${id}.visibility`, 256);
      if (visibility.startsWith("workspace:") && visibility !== `workspace:${workspaceId}`) {
        throw new AiVerseSkillsCapabilityResolutionError("SKILLS_SCOPE_VIOLATION", `Capability ${id} escaped Task workspace ${workspaceId}`);
      }
      const digestAlgorithm = requiredString(item.digest_algorithm, `capability ${id}.digest_algorithm`, 128);
      const digest = requiredString(item.digest, `capability ${id}.digest`, 128);
      if (digestAlgorithm !== AI_VERSE_PACKAGE_DIGEST_ALGORITHM || !SHA256.test(digest)) {
        throw new AiVerseSkillsCapabilityResolutionError("SKILLS_INVALID_OUTPUT", `Capability ${id} has invalid package digest binding`);
      }
      const instructions = requiredString(item.instructions, `capability ${id}.instructions`, this.maxInstructionChars);
      totalInstructions += instructions.length;
      if (totalInstructions > this.maxTotalInstructionChars) {
        throw new AiVerseSkillsCapabilityResolutionError("SKILLS_OUTPUT_TOO_LARGE", `Resolved skill instructions exceed ${this.maxTotalInstructionChars} total characters`);
      }
      const operators = Array.isArray(item.operators) ? item.operators.map(String) : [];
      const dependencies = Array.isArray(item.dependencies) ? item.dependencies.map(String) : [];
      capabilities.push({
        requested_ref: requestedRef,
        id,
        name: requiredString(item.name, `capability ${id}.name`, 512),
        description: requiredString(item.description, `capability ${id}.description`, 4096),
        provider,
        visibility,
        version: requiredString(item.version, `capability ${id}.version`, 256),
        generation_id: requiredString(item.generation_id, `capability ${id}.generation_id`, 512),
        path: requiredString(item.path, `capability ${id}.path`, 1024),
        digest_algorithm: digestAlgorithm,
        digest,
        readiness: requiredString(item.readiness, `capability ${id}.readiness`, 64),
        permission: requiredString(item.permission, `capability ${id}.permission`, 64),
        approval: requiredString(item.approval, `capability ${id}.approval`, 64),
        operators,
        dependencies,
        instructions,
        instruction_digest: sha256(instructions)
      });
    }

    const requestDigest = sha256(canonicalJson({ workspace_id: workspaceId, skill_refs: refs }));
    const resolutionDigest = sha256(canonicalJson({
      provider: this.provider,
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
      provider: this.provider,
      workspace_id: workspaceId,
      request_digest: requestDigest,
      resolution_digest: resolutionDigest,
      resolved_at: this.now().toISOString(),
      capabilities
    };
  }
}
