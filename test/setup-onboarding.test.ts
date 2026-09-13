import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
  AI_VERSE_OS_EXTENSION_REGISTRY_PATH
} from "../src/ai-verse-os-registration.js";
import { CoordinationGateway } from "../src/gateway.js";
import { initializeStandalone } from "../src/standalone-install.js";
import {
  MultipleBotsSetupError,
  setupModeHelp,
  setupMultipleBots
} from "../src/setup.js";
import { CoordinationStore } from "../src/store.js";

function fixture(prefix: string): string {
  const root = `/tmp/${prefix}-${randomUUID()}`;
  mkdirSync(root, { recursive: true });
  return root;
}

function write(root: string, relative: string, content: string): void {
  const path = resolve(root, ...relative.split("/"));
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(resolve(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function osFixture(): string {
  const root = fixture("ai-verse-setup-os");
  mkdirSync(resolve(root, "operator"), { recursive: true });
  mkdirSync(resolve(root, "workspaces"), { recursive: true });
  write(root, "AI-VERSE.yaml", 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  write(root, "AGENTS.md", "# Runtime contract\nLoad .aiverse/extensions/registry.json when present.\n");
  write(root, "system/extensions/README.md", "# Local extensions\nRegistry: .aiverse/extensions/registry.json\n");
  write(root, "operator/profile/PROFILE.md", "# Operator\ncanonical operator state\n");
  write(root, "workspaces/demo/WORKSPACE.yaml", 'schema_version: "2.0"\nid: demo\n');
  write(root, "workspaces/demo/context/CURRENT.md", "# Current\ncanonical workspace state\n");
  write(root, "skills/registry.yaml", 'schema_version: "1.0"\ncapabilities: {}\n');
  return root;
}

function canonicalSnapshot(root: string): Record<string, string> {
  const paths = [
    "AI-VERSE.yaml",
    "AGENTS.md",
    "system/extensions/README.md",
    "operator/profile/PROFILE.md",
    "workspaces/demo/WORKSPACE.yaml",
    "workspaces/demo/context/CURRENT.md",
    "skills/registry.yaml"
  ];
  return Object.fromEntries(paths.map((path) => [path, readFileSync(resolve(root, ...path.split("/")), "utf8")]));
}

function registry(root: string): any {
  return JSON.parse(readFileSync(resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8"));
}

test("Phase 5.4 fresh setup requires an explicit mode and does not guess standalone", () => {
  const root = fixture("ai-verse-setup-empty");
  try {
    assert.throws(
      () => setupMultipleBots({ cwd: root }),
      (error: unknown) => error instanceof MultipleBotsSetupError && error.code === "SETUP_MODE_REQUIRED"
    );
    assert.equal(existsSync(resolve(root, ".ai-verse-bots")), false);
    assert.equal(existsSync(resolve(root, ".aiverse")), false);

    const help = setupModeHelp();
    assert.deepEqual(help.modes.map((item) => item.mode), ["standalone", "ai-verse-os"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.4 standalone setup initializes, verifies, guides, and creates no implicit Bot", () => {
  const root = fixture("ai-verse-setup-standalone");
  try {
    const result = setupMultipleBots({
      mode: "standalone",
      root,
      host: "127.0.0.1",
      port: 0
    });
    assert.equal(result.mode, "standalone");
    assert.equal(result.selected_by, "explicit");
    assert.equal(result.status, "ready");
    assert.equal(result.ready, true);
    assert.equal(result.changed, true);
    assert.deepEqual(result.verification_depth, ["structural", "attachment"]);
    assert.equal((result.verification as any).ok, true);
    assert.equal(result.next_steps[0]?.id, "verify");
    assert.equal(result.next_steps[1]?.id, "start");
    assert.equal(result.next_steps[2]?.id, "starter-template");
    assert.match(result.next_steps[1]!.command, /standalone serve/);
    assert.match(result.next_steps[2]!.command, /template list/);
    assert.equal(result.setup_does_not_grant.includes("Brain authority"), true);

    const dbPath = String((result.setup as any).database);
    const store = new CoordinationStore(dbPath);
    const gateway = new CoordinationGateway(store);
    try {
      assert.deepEqual(gateway.listBots(), []);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.4 rerun auto-detects an existing standalone setup and is unchanged", () => {
  const root = fixture("ai-verse-setup-detect-standalone");
  try {
    const first = setupMultipleBots({ mode: "standalone", root, port: 0 });
    const nested = resolve(root, "project", "nested");
    mkdirSync(nested, { recursive: true });

    const second = setupMultipleBots({ cwd: nested });
    assert.equal(second.mode, "standalone");
    assert.equal(second.selected_by, "detected");
    assert.equal(second.root, root);
    assert.equal(second.ready, true);
    assert.equal(second.changed, false);
    assert.equal((second.setup as any).database, (first.setup as any).database);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.4 AI-Verse OS setup installs, verifies, preserves canonical host state, and creates no Bot", () => {
  const root = osFixture();
  try {
    const before = canonicalSnapshot(root);
    const result = setupMultipleBots({ mode: "os", root });
    assert.equal(result.mode, "ai-verse-os");
    assert.equal(result.selected_by, "explicit");
    assert.equal(result.status, "ready");
    assert.equal(result.ready, true);
    assert.equal(result.changed, true);
    assert.deepEqual(result.verification_depth, ["structural", "attachment"]);
    assert.deepEqual(result.verification, {
      ok: true,
      enabled: true,
      database_ok: true,
      schema_version: "1",
      registration_ok: true,
      files_current: true
    });
    assert.match(result.next_steps[1]!.command, /serve --os-root/);
    assert.deepEqual(canonicalSnapshot(root), before);

    const dbPath = String((result.setup as any).database);
    const store = new CoordinationStore(dbPath);
    const gateway = new CoordinationGateway(store);
    try {
      assert.deepEqual(gateway.listBots(), []);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.4 rerun auto-detects AI-Verse OS mode without rewriting setup", () => {
  const root = osFixture();
  try {
    setupMultipleBots({ mode: "os", root });
    const nested = resolve(root, "workspaces", "demo");
    const registryPath = resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/"));
    const registryBefore = readFileSync(registryPath, "utf8");

    const result = setupMultipleBots({ cwd: nested });
    assert.equal(result.mode, "ai-verse-os");
    assert.equal(result.selected_by, "detected");
    assert.equal(result.root, root);
    assert.equal(result.ready, true);
    assert.equal(result.changed, false);
    assert.equal(readFileSync(registryPath, "utf8"), registryBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.4 setup preserves an explicitly disabled OS extension instead of silently enabling it", () => {
  const root = osFixture();
  try {
    setupMultipleBots({ mode: "os", root });
    const doc = registry(root);
    doc.extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID].enabled = false;
    write(root, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, JSON.stringify(doc, null, 2) + "\n");

    const result = setupMultipleBots({ mode: "os", root });
    assert.equal(result.status, "disabled");
    assert.equal(result.ready, false);
    assert.equal((result.verification as any).enabled, false);
    assert.equal(registry(root).extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID].enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.4 setup rejects ambiguous detection and mode-inapplicable options", () => {
  const root = osFixture();
  try {
    initializeStandalone(root, { port: 0 });
    const nested = resolve(root, "workspaces", "demo");
    assert.throws(
      () => setupMultipleBots({ cwd: nested }),
      (error: unknown) => error instanceof MultipleBotsSetupError && error.code === "SETUP_MODE_AMBIGUOUS"
    );
    assert.throws(
      () => setupMultipleBots({ mode: "os", root, host: "127.0.0.1" }),
      (error: unknown) => error instanceof MultipleBotsSetupError && error.code === "SETUP_OPTION_NOT_APPLICABLE"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
