import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  AiVerseSkillsCapabilityResolutionError,
  AiVerseSkillsCapabilitySource
} from "../src/ai-verse-skills-capability-resolution.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function write(root: string, relative: string, content: string): void {
  const target = resolve(root, ...relative.split("/"));
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(resolve(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8" });
}

function hostFixture(): string {
  const root = `/tmp/ai-verse-skills-resolution-${randomUUID()}`;
  mkdirSync(resolve(root, "operator"), { recursive: true });
  mkdirSync(resolve(root, "workspaces", "ws-alpha", "skills", "deep-research"), { recursive: true });
  write(root, "AI-VERSE.yaml", 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  write(root, "AGENTS.md", "# Runtime\nLoad .aiverse/extensions/registry.json when present.\n");
  write(root, "system/extensions/README.md", "# Extensions\nRegistry: .aiverse/extensions/registry.json\n");
  write(root, "workspaces/ws-alpha/WORKSPACE.yaml", [
    'schema_version: "2.0"',
    'id: "ws-alpha"',
    'name: "Skills Workspace"',
    'type: "project"',
    'status: "active"',
    'purpose: "Test skill resolution."',
    ""
  ].join("\n"));
  write(root, "workspaces/ws-alpha/skills/deep-research/SKILL.md", "# Deep Research\n\nSKILL_RUNTIME_SECRET_MARKER\n");
  write(root, "scripts/capability-resolver-core.mjs", "export {};\n");
  return root;
}

function selectionBody(extra = ""): string {
  return `{
    id: "workspace:ws-alpha:deep-research",
    bare_id: "deep-research",
    name: "Deep Research",
    description: "Evidence-first research.",
    provider: "workspace:ws-alpha",
    visibility: "workspace:ws-alpha",
    version: "1.0.0",
    generation_id: "content-sha256:${DIGEST_A}",
    path: "deep-research",
    package_state: "valid",
    digest: { algorithm: "aiverse-package-sha256-v1", value: "${DIGEST_A}" },
    operators: [],
    dependencies: [],
    readiness: "UNVERIFIED",
    permission: "unknown",
    approval: "not_required",
    locator: { kind: "directory", package_path: packagePath }${extra}
  }`;
}

function validResolver(): string {
  return `
import path from "node:path";
export function packageDigestV1() { return "${DIGEST_A}"; }
export function selectCapability(options) {
  const packagePath = path.join(options.osRoot, "workspaces", "ws-alpha", "skills", "deep-research");
  return { status: "selected", selection: ${selectionBody()} };
}
`;
}

test("native adapter resolves through the OS-owned resolver and loads only selected SKILL.md instructions", async () => {
  const root = hostFixture();
  try {
    write(root, "scripts/capability-resolver.mjs", validResolver());
    const source = new AiVerseSkillsCapabilitySource(root);
    const result = await source.resolve("ws-alpha", ["deep-research"]);
    assert.equal(result.workspace_id, "ws-alpha");
    assert.equal(result.capabilities.length, 1);
    assert.equal(result.capabilities[0]?.id, "workspace:ws-alpha:deep-research");
    assert.equal(result.capabilities[0]?.provider, "workspace:ws-alpha");
    assert.match(String(result.capabilities[0]?.instructions), /SKILL_RUNTIME_SECRET_MARKER/);
    assert.match(String(result.capabilities[0]?.instruction_digest), /^[a-f0-9]{64}$/);
    assert.match(result.request_digest, /^[a-f0-9]{64}$/);
    assert.match(result.resolution_digest, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolver unavailability or degraded provider state fails explicitly", async () => {
  const root = hostFixture();
  try {
    write(root, "scripts/capability-resolver.mjs", `
export function packageDigestV1() { return "${DIGEST_A}"; }
export function selectCapability() {
  return { status: "unavailable", requested: "deep-research", reason: "provider degraded", providers: [{ provider: "aiverse-skills", state: "degraded" }] };
}
`);
    const source = new AiVerseSkillsCapabilitySource(root);
    await assert.rejects(
      () => source.resolve("ws-alpha", ["deep-research"]),
      (error: unknown) => error instanceof AiVerseSkillsCapabilityResolutionError
        && error.code === "SKILLS_UNAVAILABLE"
        && /provider degraded/i.test(error.message)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package mutation between selection and instruction load fails the second digest check", async () => {
  const root = hostFixture();
  try {
    write(root, "scripts/capability-resolver.mjs", `
import path from "node:path";
let calls = 0;
export function packageDigestV1() { calls += 1; return calls === 1 ? "${DIGEST_A}" : "${DIGEST_B}"; }
export function selectCapability(options) {
  const packagePath = path.join(options.osRoot, "workspaces", "ws-alpha", "skills", "deep-research");
  return { status: "selected", selection: ${selectionBody()} };
}
`);
    const source = new AiVerseSkillsCapabilitySource(root);
    await assert.rejects(
      () => source.resolve("ws-alpha", ["deep-research"]),
      (error: unknown) => error instanceof AiVerseSkillsCapabilityResolutionError
        && error.code === "SKILLS_INTEGRITY_FAILED"
        && /while instructions were being loaded/i.test(error.message)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace-visible resolver result cannot escape the requested Task workspace", async () => {
  const root = hostFixture();
  try {
    write(root, "scripts/capability-resolver.mjs", `
import path from "node:path";
export function packageDigestV1() { return "${DIGEST_A}"; }
export function selectCapability(options) {
  const packagePath = path.join(options.osRoot, "workspaces", "ws-alpha", "skills", "deep-research");
  const selection = ${selectionBody()};
  selection.provider = "workspace:ws-beta";
  selection.visibility = "workspace:ws-beta";
  selection.id = "workspace:ws-beta:deep-research";
  return { status: "selected", selection };
}
`);
    const source = new AiVerseSkillsCapabilitySource(root);
    await assert.rejects(
      () => source.resolve("ws-alpha", ["deep-research"]),
      (error: unknown) => error instanceof AiVerseSkillsCapabilityResolutionError
        && error.code === "SKILLS_SCOPE_VIOLATION"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed generation binding from resolver is rejected", async () => {
  const root = hostFixture();
  try {
    write(root, "scripts/capability-resolver.mjs", `
import path from "node:path";
export function packageDigestV1() { return "${DIGEST_A}"; }
export function selectCapability(options) {
  const packagePath = path.join(options.osRoot, "workspaces", "ws-alpha", "skills", "deep-research");
  const selection = ${selectionBody()};
  selection.generation_id = "";
  return { status: "selected", selection };
}
`);
    const source = new AiVerseSkillsCapabilitySource(root);
    await assert.rejects(
      () => source.resolve("ws-alpha", ["deep-research"]),
      (error: unknown) => error instanceof AiVerseSkillsCapabilityResolutionError
        && error.code === "SKILLS_INVALID_OUTPUT"
        && /generation_id/i.test(error.message)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("symlinked OS capability resolver path is rejected before execution", async () => {
  const root = hostFixture();
  const external = `/tmp/ai-verse-external-resolver-${randomUUID()}.mjs`;
  try {
    writeFileSync(external, validResolver(), { encoding: "utf8" });
    symlinkSync(external, resolve(root, "scripts", "capability-resolver.mjs"));
    const source = new AiVerseSkillsCapabilitySource(root);
    await assert.rejects(
      () => source.resolve("ws-alpha", ["deep-research"]),
      (error: unknown) => error instanceof AiVerseSkillsCapabilityResolutionError
        && error.code === "SKILLS_UNSAFE_RESOLVER"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { force: true });
  }
});
