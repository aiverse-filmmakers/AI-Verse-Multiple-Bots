import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_SOURCE,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION,
  AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH,
  AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH,
  AI_VERSE_OS_EXTENSION_REGISTRY_PATH,
  AiVerseOsRegistrationError,
  planAiVerseOsUninstall,
  planAiVerseOsUpgrade,
  registerAiVerseOsExtension,
  uninstallAiVerseOsExtension,
  upgradeAiVerseOsExtension
} from "../src/ai-verse-os-registration.js";

function write(root: string, relative: string, content: string): void {
  const path = resolve(root, ...relative.split("/"));
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(resolve(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8" });
}

function fixture(): string {
  const root = `/tmp/ai-verse-lifecycle-${randomUUID()}`;
  mkdirSync(resolve(root, "operator"), { recursive: true });
  mkdirSync(resolve(root, "workspaces", "client-a", "knowledge"), { recursive: true });
  mkdirSync(resolve(root, "automations", "jobs"), { recursive: true });
  mkdirSync(resolve(root, "runtime", "ai-verse-bots"), { recursive: true });
  mkdirSync(resolve(root, "system", "capabilities"), { recursive: true });
  write(root, "AI-VERSE.yaml", 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  write(root, "AGENTS.md", `# Runtime\nLoad ${AI_VERSE_OS_EXTENSION_REGISTRY_PATH} when present.\n`);
  write(root, "system/extensions/README.md", `# Extensions\nRegistry: ${AI_VERSE_OS_EXTENSION_REGISTRY_PATH}\n`);
  write(root, AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH, "# installed instructions\n");
  write(root, AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH, "export {};\n");
  write(root, "operator/CURRENT.md", "OPERATOR_CANONICAL_SENTINEL\n");
  write(root, "workspaces/client-a/WORKSPACE.yaml", 'schema_version: "2.0"\nid: "client-a"\nstatus: "active"\n');
  write(root, "workspaces/client-a/knowledge/FACTS.md", "WORKSPACE_KNOWLEDGE_SENTINEL\n");
  write(root, "automations/jobs/daily.yaml", "AUTOMATION_SENTINEL\n");
  write(root, "system/capabilities/README.md", "SKILLS_SENTINEL\n");
  write(root, "runtime/ai-verse-bots/coordination.db", "COORDINATION_STATE_SENTINEL\n");
  return root;
}

function registry(root: string): any {
  return JSON.parse(readFileSync(resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8"));
}

function canonicalSnapshot(root: string): Record<string, string> {
  return Object.fromEntries([
    "AI-VERSE.yaml",
    "AGENTS.md",
    "operator/CURRENT.md",
    "workspaces/client-a/WORKSPACE.yaml",
    "workspaces/client-a/knowledge/FACTS.md",
    "automations/jobs/daily.yaml",
    "system/capabilities/README.md",
    "runtime/ai-verse-bots/coordination.db"
  ].map((path) => [path, readFileSync(resolve(root, ...path.split("/")), "utf8")]));
}

test("upgrade is an existing-owned-registration operation and preserves disabled state, unknown metadata, and canonical host state", () => {
  const root = fixture();
  try {
    write(root, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, JSON.stringify({
      schema_version: "1.0",
      operator_note: "preserve",
      extensions: {
        "other-extension": { id: "other-extension", installed: true, custom: "keep" },
        [AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID]: {
          id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
          supported: true,
          installed: true,
          enabled: false,
          version: "0.1.0-alpha.0",
          source: AI_VERSE_MULTIPLE_BOTS_EXTENSION_SOURCE,
          instructions: AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH,
          engine: AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH,
          adapters: [],
          operator_metadata: { keep: true }
        }
      }
    }, null, 2) + "\n");
    const before = canonicalSnapshot(root);
    const plan = planAiVerseOsUpgrade(root);
    assert.equal(plan.previous_version, "0.1.0-alpha.0");
    assert.equal(plan.current_entry.enabled, false);
    assert.equal(plan.next_entry.enabled, false);
    assert.deepEqual(plan.tracked_os_files_mutated, []);

    const result = upgradeAiVerseOsExtension(root);
    assert.equal(result.status, "updated");
    const afterRegistry = registry(root);
    assert.equal(afterRegistry.operator_note, "preserve");
    assert.deepEqual(afterRegistry.extensions["other-extension"], { id: "other-extension", installed: true, custom: "keep" });
    assert.equal(afterRegistry.extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID].version, AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION);
    assert.equal(afterRegistry.extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID].enabled, false);
    assert.deepEqual(afterRegistry.extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID].operator_metadata, { keep: true });
    assert.deepEqual(canonicalSnapshot(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("upgrade refuses missing or foreign same-key registrations instead of converting them", () => {
  const missing = fixture();
  try {
    assert.throws(
      () => planAiVerseOsUpgrade(missing),
      (error: unknown) => error instanceof AiVerseOsRegistrationError && error.code === "EXTENSION_NOT_REGISTERED"
    );
  } finally {
    rmSync(missing, { recursive: true, force: true });
  }

  const foreign = fixture();
  try {
    write(foreign, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, JSON.stringify({
      schema_version: "1.0",
      extensions: {
        [AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID]: {
          id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
          version: "99.0.0",
          source: "foreign-package",
          instructions: AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH,
          engine: AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH,
          adapters: []
        }
      }
    }, null, 2) + "\n");
    const before = readFileSync(resolve(foreign, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8");
    assert.throws(
      () => upgradeAiVerseOsExtension(foreign),
      (error: unknown) => error instanceof AiVerseOsRegistrationError && error.code === "EXTENSION_OWNERSHIP_MISMATCH"
    );
    assert.equal(readFileSync(resolve(foreign, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8"), before);
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
});

test("uninstall removes only the owned registry entry and known files while preserving unknown extension files, coordination state, and canonical OS state", () => {
  const root = fixture();
  try {
    write(root, ".aiverse/extensions/ai-verse-multiple-bots/operator-notes.txt", "PRESERVE_UNKNOWN_EXTENSION_FILE\n");
    write(root, ".aiverse/extensions/ai-verse-multiple-bots/adapters/local.mjs", "export {};\n");
    write(root, ".aiverse/shared-adapter.mjs", "PRESERVE_OUTSIDE_EXTENSION_ROOT\n");
    write(root, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, JSON.stringify({
      schema_version: "1.0",
      operator_note: "keep top level",
      extensions: {
        "other-extension": { id: "other-extension", installed: true, payload: { keep: true } },
        [AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID]: {
          id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
          supported: true,
          installed: true,
          enabled: true,
          version: AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION,
          source: AI_VERSE_MULTIPLE_BOTS_EXTENSION_SOURCE,
          instructions: AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH,
          engine: AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH,
          adapters: [
            ".aiverse/extensions/ai-verse-multiple-bots/adapters/local.mjs",
            ".aiverse/shared-adapter.mjs"
          ]
        }
      }
    }, null, 2) + "\n");

    const before = canonicalSnapshot(root);
    const plan = planAiVerseOsUninstall(root);
    assert.equal(plan.registered, true);
    assert.equal(plan.preserves_coordination_state, true);
    assert.equal(plan.preserves_canonical_host_state, true);
    assert.deepEqual(plan.tracked_os_files_mutated, []);
    assert.ok(plan.removable_files.includes(AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH));
    assert.ok(plan.removable_files.includes(AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH));
    assert.ok(plan.removable_files.includes(".aiverse/extensions/ai-verse-multiple-bots/adapters/local.mjs"));
    assert.deepEqual(plan.preserved_registered_paths, [".aiverse/shared-adapter.mjs"]);

    const result = uninstallAiVerseOsExtension(root);
    assert.equal(result.status, "unregistered");
    assert.equal(result.registry_entry_removed, true);
    assert.equal(result.residual_registered_paths.includes(".aiverse/shared-adapter.mjs"), true);

    const afterRegistry = registry(root);
    assert.equal(afterRegistry.operator_note, "keep top level");
    assert.deepEqual(afterRegistry.extensions["other-extension"], { id: "other-extension", installed: true, payload: { keep: true } });
    assert.equal(afterRegistry.extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID], undefined);

    assert.equal(existsSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH.split("/"))), false);
    assert.equal(existsSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH.split("/"))), false);
    assert.equal(existsSync(resolve(root, ".aiverse/extensions/ai-verse-multiple-bots/adapters/local.mjs")), false);
    assert.equal(readFileSync(resolve(root, ".aiverse/extensions/ai-verse-multiple-bots/operator-notes.txt"), "utf8"), "PRESERVE_UNKNOWN_EXTENSION_FILE\n");
    assert.equal(readFileSync(resolve(root, ".aiverse/shared-adapter.mjs"), "utf8"), "PRESERVE_OUTSIDE_EXTENSION_ROOT\n");
    assert.deepEqual(canonicalSnapshot(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uninstall is idempotent after unregister and never scavenges unregistered leftovers", () => {
  const root = fixture();
  try {
    registerAiVerseOsExtension(root);
    const first = uninstallAiVerseOsExtension(root);
    assert.equal(first.status, "unregistered");
    write(root, ".aiverse/extensions/ai-verse-multiple-bots/leftover.txt", "DO_NOT_SCAVENGE\n");

    const second = uninstallAiVerseOsExtension(root);
    assert.equal(second.status, "unchanged");
    assert.equal(second.registry_entry_removed, false);
    assert.deepEqual(second.removed_files, []);
    assert.equal(readFileSync(resolve(root, ".aiverse/extensions/ai-verse-multiple-bots/leftover.txt"), "utf8"), "DO_NOT_SCAVENGE\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uninstall rejects ownership mismatch and symlink traversal before registry mutation", () => {
  const foreign = fixture();
  try {
    write(foreign, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, JSON.stringify({
      schema_version: "1.0",
      extensions: {
        [AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID]: {
          id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
          version: "1",
          source: "foreign",
          instructions: AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH,
          engine: AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH,
          adapters: []
        }
      }
    }, null, 2) + "\n");
    const before = readFileSync(resolve(foreign, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8");
    assert.throws(
      () => uninstallAiVerseOsExtension(foreign),
      (error: unknown) => error instanceof AiVerseOsRegistrationError && error.code === "EXTENSION_OWNERSHIP_MISMATCH"
    );
    assert.equal(readFileSync(resolve(foreign, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8"), before);
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }

  const linked = fixture();
  const external = `/tmp/ai-verse-uninstall-external-${randomUUID()}.md`;
  try {
    registerAiVerseOsExtension(linked);
    writeFileSync(external, "EXTERNAL_MUST_SURVIVE\n", "utf8");
    const instructionPath = resolve(linked, ...AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH.split("/"));
    rmSync(instructionPath, { force: true });
    symlinkSync(external, instructionPath);
    const before = readFileSync(resolve(linked, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8");
    assert.throws(
      () => uninstallAiVerseOsExtension(linked),
      (error: unknown) => error instanceof AiVerseOsRegistrationError && error.code === "SYMLINK_PATH_REJECTED"
    );
    assert.equal(readFileSync(resolve(linked, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8"), before);
    assert.equal(readFileSync(external, "utf8"), "EXTERNAL_MUST_SURVIVE\n");
  } finally {
    rmSync(linked, { recursive: true, force: true });
    rmSync(external, { force: true });
  }
});

test("upgrade and uninstall respect the shared registry lock and do not steal another lifecycle operation", () => {
  const root = fixture();
  try {
    registerAiVerseOsExtension(root);
    write(root, AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH, '{"extension_id":"other-extension"}\n');
    const before = readFileSync(resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8");
    for (const action of [() => upgradeAiVerseOsExtension(root), () => uninstallAiVerseOsExtension(root)]) {
      assert.throws(
        action,
        (error: unknown) => error instanceof AiVerseOsRegistrationError && error.code === "EXTENSION_REGISTRY_BUSY"
      );
      assert.equal(readFileSync(resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8"), before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
