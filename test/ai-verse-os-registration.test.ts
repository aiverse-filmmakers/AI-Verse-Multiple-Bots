import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";
import {
  AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_ROOT,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION,
  AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH,
  AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH,
  AI_VERSE_OS_EXTENSION_REGISTRY_PATH,
  AI_VERSE_OS_HOST_ID,
  AI_VERSE_OS_SUPPORTED_ARCHITECTURE,
  AI_VERSE_OS_SUPPORTED_SCHEMA_MAJOR,
  AiVerseOsRegistrationError,
  detectAiVerseOsCompatibility,
  findAiVerseOsRoot,
  planAiVerseOsRegistration,
  registerAiVerseOsExtension,
  validateAiVerseOsRelativePath
} from "../src/ai-verse-os-registration.js";

function write(root: string, relative: string, content: string): void {
  const path = resolve(root, ...relative.split("/"));
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(resolve(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8" });
}

function fixture(options: { hook?: boolean; extensionFiles?: boolean } = {}): string {
  const root = `/tmp/ai-verse-os-registration-${randomUUID()}`;
  mkdirSync(root, { recursive: true });
  mkdirSync(resolve(root, "operator"), { recursive: true });
  mkdirSync(resolve(root, "workspaces"), { recursive: true });
  write(root, "AI-VERSE.yaml", 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  write(root, "AGENTS.md", options.hook === false
    ? "# Runtime contract without local extension support\n"
    : `# Runtime contract\nLoad ${AI_VERSE_OS_EXTENSION_REGISTRY_PATH} when present.\n`);
  write(root, "system/extensions/README.md", `# Local extensions\nRegistry: ${AI_VERSE_OS_EXTENSION_REGISTRY_PATH}\n`);
  if (options.extensionFiles !== false) {
    write(root, AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH, "# Multiple Bots host instructions\n");
    write(root, AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH, "export {};\n");
  }
  return root;
}

function registryPath(root: string): string {
  return resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/"));
}

function readRegistry(root: string): any {
  return JSON.parse(readFileSync(registryPath(root), "utf8"));
}

test("AI-Verse OS v2 compatibility detection requires the stable local extension hook and discovers the root from descendants", () => {
  const root = fixture();
  try {
    const compatibility = detectAiVerseOsCompatibility(root);
    assert.equal(compatibility.status, "compatible");
    assert.equal(compatibility.schema_version, "2.0");
    assert.equal(compatibility.architecture, "unified-workspace");
    const nested = resolve(root, "workspaces", "client-a", "context");
    mkdirSync(nested, { recursive: true });
    assert.equal(findAiVerseOsRoot(nested), root);

    const unsupported = fixture({ hook: false });
    try {
      const missingHook = detectAiVerseOsCompatibility(unsupported);
      assert.equal(missingHook.status, "incompatible");
      assert.match(missingHook.reason, /runtime hook/i);
    } finally {
      rmSync(unsupported, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OS compatibility fails closed for absent, malformed, unsupported, or incomplete AI-Verse hosts", () => {
  const noOs = `/tmp/no-ai-verse-os-${randomUUID()}`;
  mkdirSync(noOs, { recursive: true });
  try {
    assert.equal(detectAiVerseOsCompatibility(noOs).status, "no-os");
  } finally {
    rmSync(noOs, { recursive: true, force: true });
  }

  const malformed = fixture();
  try {
    write(malformed, "AI-VERSE.yaml", "schema_version: banana\narchitecture: unified-workspace\n");
    const result = detectAiVerseOsCompatibility(malformed);
    assert.equal(result.status, "incompatible");
    assert.match(result.reason, /malformed/i);
  } finally {
    rmSync(malformed, { recursive: true, force: true });
  }

  const oldMajor = fixture();
  try {
    write(oldMajor, "AI-VERSE.yaml", 'schema_version: "1.0"\narchitecture: unified-workspace\n');
    const result = detectAiVerseOsCompatibility(oldMajor);
    assert.equal(result.status, "incompatible");
    assert.match(result.reason, /schema major 2/i);
  } finally {
    rmSync(oldMajor, { recursive: true, force: true });
  }

  const missingWorkspace = fixture();
  try {
    rmSync(resolve(missingWorkspace, "workspaces"), { recursive: true, force: true });
    const result = detectAiVerseOsCompatibility(missingWorkspace);
    assert.equal(result.status, "incompatible");
    assert.match(result.reason, /workspaces/i);
  } finally {
    rmSync(missingWorkspace, { recursive: true, force: true });
  }
});

test("registration preserves unknown registry content and a user-disabled state while updating only Multiple Bots", () => {
  const root = fixture();
  try {
    write(root, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, JSON.stringify({
      schema_version: "1.0",
      operator_note: "preserve me",
      extensions: {
        "other-extension": {
          id: "other-extension",
          installed: true,
          custom: { untouched: true }
        },
        [AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID]: {
          id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
          supported: true,
          installed: true,
          enabled: false,
          version: "0.0.1",
          source: "old-source",
          instructions: AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH,
          engine: AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH,
          adapters: [],
          operator_metadata: { keep: "yes" }
        }
      }
    }, null, 2) + "\n");

    const beforePlan = planAiVerseOsRegistration(root);
    assert.equal(beforePlan.requires_write, true);
    assert.deepEqual(beforePlan.tracked_os_files_mutated, []);
    assert.equal(beforePlan.next_entry.enabled, false);

    const result = registerAiVerseOsExtension(root);
    assert.equal(result.status, "updated");
    const registry = readRegistry(root);
    assert.equal(registry.operator_note, "preserve me");
    assert.deepEqual(registry.extensions["other-extension"], {
      id: "other-extension",
      installed: true,
      custom: { untouched: true }
    });
    const entry = registry.extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID];
    assert.equal(entry.enabled, false);
    assert.equal(entry.version, AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION);
    assert.deepEqual(entry.operator_metadata, { keep: "yes" });
    assert.equal(entry.instructions, AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH);
    assert.equal(entry.engine, AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registration is byte-stable on reinstall when the canonical entry is already current", () => {
  const root = fixture();
  try {
    const first = registerAiVerseOsExtension(root);
    assert.equal(first.status, "registered");
    const firstText = readFileSync(registryPath(root), "utf8");
    const second = registerAiVerseOsExtension(root);
    const secondText = readFileSync(registryPath(root), "utf8");
    assert.equal(second.status, "unchanged");
    assert.equal(second.requires_write, false);
    assert.equal(secondText, firstText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registration verifies installed files before writing and leaves the registry untouched on missing extension files", () => {
  const root = fixture({ extensionFiles: false });
  try {
    write(root, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, JSON.stringify({ schema_version: "1.0", extensions: {}, sentinel: "unchanged" }, null, 2) + "\n");
    const before = readFileSync(registryPath(root), "utf8");
    assert.throws(
      () => registerAiVerseOsExtension(root),
      (error: unknown) => error instanceof AiVerseOsRegistrationError && error.code === "MISSING_EXTENSION_FILE"
    );
    assert.equal(readFileSync(registryPath(root), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extension paths reject absolute paths, traversal, empty segments, and symlinked installed files", () => {
  for (const unsafe of ["../outside", "a/../outside", "/tmp/outside", "C:\\outside\\file", "a//b"]) {
    assert.throws(
      () => validateAiVerseOsRelativePath(unsafe),
      (error: unknown) => error instanceof AiVerseOsRegistrationError && error.code === "INVALID_EXTENSION_PATH"
    );
  }
  assert.equal(validateAiVerseOsRelativePath(".aiverse/extensions/example/file.md"), ".aiverse/extensions/example/file.md");

  const root = fixture();
  const external = `/tmp/ai-verse-registration-external-${randomUUID()}.md`;
  try {
    writeFileSync(external, "external\n", { encoding: "utf8" });
    rmSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH.split("/")), { force: true });
    symlinkSync(external, resolve(root, ...AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH.split("/")));
    assert.throws(
      () => registerAiVerseOsExtension(root),
      (error: unknown) => error instanceof AiVerseOsRegistrationError && error.code === "SYMLINK_PATH_REJECTED"
    );
    assert.throws(() => readFileSync(registryPath(root), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { force: true });
  }
});

test("registration refuses malformed registries and never replaces unknown incompatible state", () => {
  const root = fixture();
  try {
    write(root, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, '{"schema_version":"9.0","extensions":{"foreign":{"keep":true}}}\n');
    const before = readFileSync(registryPath(root), "utf8");
    assert.throws(
      () => registerAiVerseOsExtension(root),
      (error: unknown) => error instanceof AiVerseOsRegistrationError && error.code === "UNSUPPORTED_EXTENSION_REGISTRY_SCHEMA"
    );
    assert.equal(readFileSync(registryPath(root), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent extension registry mutation fails closed while another installer owns the registry lock", () => {
  const root = fixture();
  try {
    write(root, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, JSON.stringify({
      schema_version: "1.0",
      extensions: { "other-extension": { id: "other-extension", installed: true } },
      sentinel: "preserve"
    }, null, 2) + "\n");
    write(root, AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH, '{"extension_id":"other-extension"}\n');
    const before = readFileSync(registryPath(root), "utf8");
    assert.throws(
      () => registerAiVerseOsExtension(root),
      (error: unknown) => error instanceof AiVerseOsRegistrationError && error.code === "EXTENSION_REGISTRY_BUSY"
    );
    assert.equal(readFileSync(registryPath(root), "utf8"), before);
    assert.equal(readFileSync(resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH.split("/")), "utf8"), '{"extension_id":"other-extension"}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Multiple Bots registration metadata stays aligned with package and AI-Verse OS contract constants", () => {
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(resolve("integrations", "ai-verse-os", "extension.json"), "utf8"));
  assert.equal(AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION, packageJson.version);
  assert.equal(manifest.id, AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID);
  assert.equal(manifest.package_version, packageJson.version);
  assert.equal(manifest.host, AI_VERSE_OS_HOST_ID);
  assert.equal(manifest.supported_host_schema_major, AI_VERSE_OS_SUPPORTED_SCHEMA_MAJOR);
  assert.equal(manifest.supported_host_architecture, AI_VERSE_OS_SUPPORTED_ARCHITECTURE);
  assert.equal(manifest.registry_path, AI_VERSE_OS_EXTENSION_REGISTRY_PATH);
  assert.equal(manifest.registry_lock_path, AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH);
  assert.equal(manifest.installation_root, AI_VERSE_MULTIPLE_BOTS_EXTENSION_ROOT);
  assert.equal(manifest.instructions, AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH);
  assert.equal(manifest.engine, AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH);
  assert.deepEqual(manifest.tracked_os_files_mutated, []);
  assert.equal(manifest.registration_grants_permissions, false);
  assert.equal(manifest.registration_asserts_health, false);
  assert.equal(manifest.owns_os_canonical_state, false);
});
