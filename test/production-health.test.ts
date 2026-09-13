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
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
  AI_VERSE_OS_EXTENSION_REGISTRY_PATH
} from "../src/ai-verse-os-registration.js";
import { installAiVerseOsExtension } from "../src/ai-verse-os-install.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import {
  doctorProduction,
  statusProduction
} from "../src/production-health.js";
import { initializeStandalone } from "../src/standalone-install.js";
import { CoordinationStore } from "../src/store.js";
import type { BotManifest } from "../src/types.js";

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
  const root = fixture("ai-verse-production-health-os");
  mkdirSync(resolve(root, "operator"), { recursive: true });
  mkdirSync(resolve(root, "workspaces"), { recursive: true });
  write(root, "AI-VERSE.yaml", 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  write(root, "AGENTS.md", "# Runtime contract\nLoad .aiverse/extensions/registry.json when present.\n");
  write(root, "system/extensions/README.md", "# Local extensions\nRegistry: .aiverse/extensions/registry.json\n");
  return root;
}

function bot(id: string, adapter: string, runtime: Record<string, unknown> = {}): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: id,
    kind: "durable",
    status: "active",
    role: {
      title: "Health Test Bot",
      mission: "Exercise production readiness checks."
    },
    runtime: { adapter, ...runtime },
    execution: {
      environment_policy: "shared_workspace",
      environment_ref: "host-default"
    },
    scope: {
      type: "workspace",
      workspace_id: "ws_health"
    },
    capabilities: {
      role_refs: [],
      skill_refs: [],
      operator_refs: [],
      tool_refs: []
    },
    permissions: {
      policy_ref: "default-bot",
      allowed_peers: [],
      can_create_workers: false,
      can_create_bots: false,
      can_handoff: true
    },
    coordination: {
      manager_id: null,
      default_mode: "direct",
      max_parallel_workers: 1,
      max_hops: 6
    }
  };
}

function addBot(dbPath: string, manifest: BotManifest): void {
  const store = new CoordinationStore(dbPath);
  try {
    store.putObject("bot", manifest);
  } finally {
    store.close();
  }
}

function tableNames(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => String(row.name));
  } finally {
    db.close();
  }
}

test("Phase 5.6 doctor reports setup-required without creating state when no installation exists", () => {
  const root = fixture("ai-verse-production-health-empty");
  try {
    const result = doctorProduction({ cwd: root });
    assert.equal(result.state, "setup-required");
    assert.equal(result.ready, false);
    assert.equal(result.read_only, true);
    assert.equal(result.mode, null);
    assert.deepEqual(result.checked_depths, ["structural", "attachment"]);
    assert.equal(result.delegated_depths.includes("system/composed"), true);
    assert.equal(existsSync(resolve(root, ".ai-verse-bots")), false);
    assert.equal(existsSync(resolve(root, ".aiverse")), false);

    const status = statusProduction({ cwd: root });
    assert.equal(status.state, "setup-required");
    assert.equal(status.ready, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.6 fresh standalone installation is ready and doctor does not materialize runtime tables", () => {
  const root = fixture("ai-verse-production-health-standalone");
  try {
    const installation = initializeStandalone(root, { port: 0 });
    const beforeTables = tableNames(installation.dbPath);
    assert.equal(beforeTables.includes("execution_queue"), false);

    const result = doctorProduction({
      mode: "standalone",
      root
    });

    assert.equal(result.mode, "standalone");
    assert.equal(result.state, "ready");
    assert.equal(result.ready, true);
    assert.equal(result.read_only, true);
    assert.deepEqual(result.checked_depths, ["structural", "attachment", "runtime", "dependency", "operational"]);
    assert.deepEqual(result.delegated_depths, []);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.checks.find((item) => item.id === "execution-queue-schema")?.status, "warning");
    assert.equal(result.checks.find((item) => item.id === "system-composed-readiness")?.status, "not_applicable");

    const afterTables = tableNames(installation.dbPath);
    assert.deepEqual(afterTables, beforeTables);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.6 active native Bot is truthfully unhealthy because the stock Gateway has no native adapter", () => {
  const root = fixture("ai-verse-production-health-native");
  try {
    const installation = initializeStandalone(root, { port: 0 });
    addBot(installation.dbPath, bot("bot_native_health", "native"));

    const result = doctorProduction({ mode: "standalone", root });
    assert.equal(result.state, "unhealthy");
    assert.equal(result.ready, false);
    const runtime = result.checks.find((item) => item.id === "runtime:bot_native_health");
    assert.equal(runtime?.status, "fail");
    assert.match(String(runtime?.summary), /does not register a 'native' execution adapter/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.6 deterministic active Bot is executable with no external runtime dependency", () => {
  const root = fixture("ai-verse-production-health-deterministic");
  try {
    const installation = initializeStandalone(root, { port: 0 });
    addBot(installation.dbPath, bot("bot_deterministic_health", "deterministic"));

    const result = doctorProduction({ mode: "standalone", root });
    assert.equal(result.state, "ready");
    assert.equal(result.ready, true);
    assert.equal(result.checks.find((item) => item.id === "runtime:bot_deterministic_health")?.status, "pass");
    assert.equal(result.checks.find((item) => item.id === "dependency-summary")?.status, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.6 configured OpenAI-compatible Bot remains ready with an explicit unprobed dependency warning", () => {
  const root = fixture("ai-verse-production-health-openai");
  try {
    const installation = initializeStandalone(root, { port: 0 });
    addBot(installation.dbPath, bot("bot_openai_health", "openai-compatible", {
      endpoint: "https://example.invalid/v1/chat/completions",
      model: "test-model",
      api_key_env: "AI_VERSE_TEST_API_KEY"
    }));

    const result = doctorProduction({
      mode: "standalone",
      root,
      env: {
        PATH: process.env.PATH,
        AI_VERSE_TEST_API_KEY: "opaque-test-secret"
      }
    });
    assert.equal(result.state, "ready");
    assert.equal(result.ready, true);
    const dependency = result.checks.find((item) => item.id === "dependency:bot_openai_health");
    assert.equal(dependency?.status, "warning");
    assert.equal((dependency?.details as any)?.live_probe_performed, false);

    const missingCredential = doctorProduction({
      mode: "standalone",
      root,
      env: { PATH: process.env.PATH }
    });
    assert.equal(missingCredential.state, "unhealthy");
    assert.equal(missingCredential.checks.find((item) => item.id === "dependency:bot_openai_health")?.status, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.6 unresolved dead-letter execution makes operational readiness unhealthy", () => {
  const root = fixture("ai-verse-production-health-dead-letter");
  try {
    const installation = initializeStandalone(root, { port: 0 });
    const queue = new ExecutionQueue(installation.dbPath);
    try {
      const record = queue.enqueueTask("task_health_dead_letter", "bot_missing_health", "ws_health");
      queue.updateState(record.id, "dead_letter", "intentional health test");
    } finally {
      queue.close();
    }

    const result = doctorProduction({ mode: "standalone", root });
    assert.equal(result.state, "unhealthy");
    assert.equal(result.ready, false);
    const operational = result.checks.find((item) => item.id === "coordination-operational-state");
    assert.equal(operational?.status, "fail");
    assert.equal((operational?.details as any)?.dead_letters, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.6 complete AI-Verse OS attachment is component-ready while system-composed readiness stays delegated", () => {
  const root = osFixture();
  try {
    installAiVerseOsExtension(root);
    const result = doctorProduction({ mode: "os", root });

    assert.equal(result.mode, "ai-verse-os");
    assert.equal(result.state, "ready");
    assert.equal(result.ready, true);
    assert.deepEqual(result.delegated_depths, ["system/composed"]);
    const attachment = result.checks.find((item) => item.id === "ai-verse-os-attachment");
    assert.equal(attachment?.status, "pass");
    const composed = result.checks.find((item) => item.id === "system-composed-readiness");
    assert.equal(composed?.status, "delegated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.6 explicitly disabled AI-Verse OS registration stays disabled rather than unhealthy or silently ready", () => {
  const root = osFixture();
  try {
    installAiVerseOsExtension(root);
    const registryPath = resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/"));
    const document = JSON.parse(readFileSync(registryPath, "utf8"));
    document.extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID].enabled = false;
    writeFileSync(registryPath, JSON.stringify(document, null, 2) + "\n", "utf8");

    const result = doctorProduction({ mode: "os", root });
    assert.equal(result.state, "disabled");
    assert.equal(result.ready, false);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.checks.find((item) => item.id === "ai-verse-os-attachment")?.status, "warning");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
