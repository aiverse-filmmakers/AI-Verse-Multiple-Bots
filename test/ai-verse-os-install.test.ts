import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { request } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_SOURCE,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION,
  AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH,
  AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH,
  AI_VERSE_OS_EXTENSION_REGISTRY_PATH,
  AiVerseOsRegistrationError
} from "../src/ai-verse-os-registration.js";
import {
  AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH,
  AiVerseOsInstallError,
  installAiVerseOsExtension,
  planAiVerseOsInstall
} from "../src/ai-verse-os-install.js";

function write(root: string, relative: string, content: string): void {
  const path = resolve(root, ...relative.split("/"));
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(resolve(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function fixture(): string {
  const root = `/tmp/ai-verse-os-install-${randomUUID()}`;
  mkdirSync(root, { recursive: true });
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

function getJson(host: string, port: number, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host, port, path, method: "GET" }, (res: any) => {
      const chunks: string[] = [];
      res.on("data", (chunk: unknown) => chunks.push(String(chunk)));
      res.on("end", () => {
        try {
          resolvePromise({ status: Number(res.statusCode ?? 0), body: JSON.parse(chunks.join("")) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("Phase 5.3 OS install materializes only extension-owned files plus runtime state and registers safely", () => {
  const root = fixture();
  try {
    const before = canonicalSnapshot(root);
    const plan = planAiVerseOsInstall(root);
    assert.equal(plan.can_install, true);
    assert.equal(plan.database_state, "missing");
    assert.deepEqual(plan.files.map((item) => [item.path, item.state, item.action]), [
      [AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH, "missing", "create"],
      [AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH, "missing", "create"]
    ]);
    assert.deepEqual(plan.tracked_os_files_mutated, []);

    const result = installAiVerseOsExtension(root);
    assert.equal(result.status, "installed");
    assert.equal(result.database_initialized, true);
    assert.equal(result.schema_version, "1");
    assert.equal(result.registration_status, "registered");
    assert.deepEqual(result.materialized_files, [
      AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH,
      AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH
    ].sort());

    assert.equal(existsSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH.split("/"))), true);
    assert.equal(existsSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH.split("/"))), true);
    assert.equal(existsSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH.split("/"))), true);

    const entry = registry(root).extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID];
    assert.equal(entry.id, AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID);
    assert.equal(entry.source, AI_VERSE_MULTIPLE_BOTS_EXTENSION_SOURCE);
    assert.equal(entry.version, AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION);
    assert.equal(entry.supported, true);
    assert.equal(entry.installed, true);
    assert.equal(entry.enabled, true);
    assert.equal(entry.instructions, AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH);
    assert.equal(entry.engine, AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH);
    assert.deepEqual(entry.adapters, []);

    assert.deepEqual(canonicalSnapshot(root), before);
    assert.equal(existsSync(resolve(root, "agents", "registry.yaml")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.3 OS install is idempotent and does not rewrite current payload or registry", () => {
  const root = fixture();
  try {
    const first = installAiVerseOsExtension(root);
    const instructionsBefore = readFileSync(first.instructions_path, "utf8");
    const engineBefore = readFileSync(first.engine_path, "utf8");
    const registryPath = resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/"));
    const registryBefore = readFileSync(registryPath, "utf8");

    const second = installAiVerseOsExtension(root);
    assert.equal(second.status, "unchanged");
    assert.equal(second.database_initialized, false);
    assert.equal(second.registration_status, "unchanged");
    assert.deepEqual(second.materialized_files, []);
    assert.equal(readFileSync(second.instructions_path, "utf8"), instructionsBefore);
    assert.equal(readFileSync(second.engine_path, "utf8"), engineBefore);
    assert.equal(readFileSync(registryPath, "utf8"), registryBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.3 reinstall preserves an owned disabled state and registered adapter list", () => {
  const root = fixture();
  try {
    installAiVerseOsExtension(root);
    const adapter = ".aiverse/extensions/ai-verse-multiple-bots/custom-adapter.md";
    write(root, adapter, "# locally registered adapter\n");

    const doc = registry(root);
    doc.extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID].enabled = false;
    doc.extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID].adapters = [adapter];
    write(root, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, JSON.stringify(doc, null, 2) + "\n");

    const result = installAiVerseOsExtension(root);
    assert.equal(result.status, "unchanged");
    assert.equal(result.registration_status, "unchanged");
    assert.deepEqual(result.materialized_files, []);

    const entry = registry(root).extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID];
    assert.equal(entry.enabled, false);
    assert.deepEqual(entry.adapters, [adapter]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.3 registry-lock failure rolls back only files created by that install attempt", () => {
  const root = fixture();
  try {
    write(root, AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH, '{"extension_id":"other-installer"}\n');

    assert.throws(
      () => installAiVerseOsExtension(root),
      (error: unknown) => error instanceof AiVerseOsRegistrationError && error.code === "EXTENSION_REGISTRY_BUSY"
    );

    assert.equal(existsSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH.split("/"))), false);
    assert.equal(existsSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH.split("/"))), false);
    assert.equal(existsSync(resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/"))), false);
    assert.equal(existsSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH.split("/"))), true);
    assert.equal(readFileSync(resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH.split("/")), "utf8"), '{"extension_id":"other-installer"}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.3 refuses conflicting unregistered extension files without claiming ownership", () => {
  const root = fixture();
  try {
    const before = canonicalSnapshot(root);
    write(root, AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH, "export const owner = 'someone-else';\n");

    const plan = planAiVerseOsInstall(root);
    assert.equal(plan.can_install, false);
    assert.deepEqual(plan.conflicts, [AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH]);

    assert.throws(
      () => installAiVerseOsExtension(root),
      (error: unknown) => error instanceof AiVerseOsInstallError && error.code === "EXTENSION_FILE_CONFLICT"
    );
    assert.equal(existsSync(resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/"))), false);
    assert.deepEqual(canonicalSnapshot(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.3 refuses a foreign same-key registration before materializing files", () => {
  const root = fixture();
  try {
    write(root, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, JSON.stringify({
      schema_version: "1.0",
      extensions: {
        [AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID]: {
          id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
          source: "foreign-package",
          installed: true,
          supported: true,
          enabled: true,
          version: "9.9.9",
          instructions: "foreign/INSTRUCTIONS.md",
          engine: "foreign/engine.mjs",
          adapters: []
        }
      }
    }, null, 2) + "\n");
    const registryPath = resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/"));
    const registryBefore = readFileSync(registryPath, "utf8");

    assert.throws(
      () => planAiVerseOsInstall(root),
      (error: unknown) => error instanceof AiVerseOsInstallError && error.code === "EXTENSION_OWNERSHIP_MISMATCH"
    );
    assert.equal(existsSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH.split("/"))), false);
    assert.equal(readFileSync(registryPath, "utf8"), registryBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.3 fails closed on symlinked extension or runtime path chains", () => {
  const extensionRoot = fixture();
  const externalExtension = `/tmp/ai-verse-os-install-external-${randomUUID()}`;
  mkdirSync(externalExtension, { recursive: true });
  try {
    mkdirSync(resolve(extensionRoot, ".aiverse", "extensions"), { recursive: true });
    symlinkSync(externalExtension, resolve(extensionRoot, ".aiverse", "extensions", AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID));
    assert.throws(
      () => planAiVerseOsInstall(extensionRoot),
      (error: unknown) => error instanceof AiVerseOsInstallError && error.code === "SYMLINK_PATH_REJECTED"
    );
  } finally {
    rmSync(extensionRoot, { recursive: true, force: true });
    rmSync(externalExtension, { recursive: true, force: true });
  }

  const runtimeRoot = fixture();
  const externalRuntime = `/tmp/ai-verse-os-runtime-external-${randomUUID()}`;
  mkdirSync(externalRuntime, { recursive: true });
  try {
    mkdirSync(resolve(runtimeRoot, "runtime"), { recursive: true });
    symlinkSync(externalRuntime, resolve(runtimeRoot, "runtime", "ai-verse-bots"));
    assert.throws(
      () => planAiVerseOsInstall(runtimeRoot),
      (error: unknown) => error instanceof AiVerseOsInstallError && error.code === "SYMLINK_PATH_REJECTED"
    );
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
    rmSync(externalRuntime, { recursive: true, force: true });
  }
});

test("Phase 5.3 materialized engine imports the installed package and starts a native OS Gateway", async () => {
  const root = fixture();
  try {
    const result = installAiVerseOsExtension(root);
    const engine: any = await import(pathToFileURL(result.engine_path).href);
    assert.equal(engine.aiVerseOsRoot, root);
    assert.equal(engine.packageVersion, AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION);

    const started = await engine.startGateway({ port: 0 });
    try {
      assert.equal(started.root, root);
      assert.equal(started.db, resolve(root, ...AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH.split("/")));
      assert.notEqual(started.service.brainObjectiveSource, undefined);
      assert.notEqual(started.service.memoryRecallSource, undefined);
      assert.notEqual(started.service.skillsCapabilitySource, undefined);
      assert.notEqual(started.service.automationInvocationSource, undefined);

      const response = await getJson(started.address.host, started.address.port, "/health");
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.schemaVersion, "1");
    } finally {
      await started.service.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("materialized OS engine can run one bounded temporary Worker without starting a sidecar or creating a Bot", async () => {
  const root = fixture();
  try {
    write(root, "AI-VERSE.yaml",
      'schema_version: "2.0"\narchitecture: unified-workspace\npaths:\n  workspaces: workspaces\n'
    );
    write(root, "workspaces/demo/WORKSPACE.yaml",
      'schema_version: "2.0"\nid: demo\nname: Demo\ntype: project\nstatus: active\npurpose: Temporary Worker extension acceptance.\ndomains: []\nowners: []\nsuccess_criteria: []\ncanonical_sources: []\nconnections: []\n'
    );
    const result = installAiVerseOsExtension(root);
    const engine: any = await import(pathToFileURL(result.engine_path).href);
    assert.equal(typeof engine.runScopedTemporaryWorker, "function");

    const outcome = await engine.runScopedTemporaryWorker({
      leaderId: "runtime_gateway",
      workspaceId: "demo",
      rootObjectiveId: "obj_materialized_temp_worker",
      objective: "Perform one bounded internal review and return the result.",
      roleTitle: "Temporary Reviewer",
      reason: "The current task benefits from isolated specialist review.",
      runtimeLeader: {
        runtime: { adapter: "deterministic" },
        allowedTools: [],
        allowedConnections: [],
        skillRefs: []
      },
      runBudget: {
        max_workers: 1,
        max_tasks: 1,
        max_actions: 2,
        token_limit: 1000,
        wall_clock_seconds: 60
      },
      workerBudget: {
        max_actions: 1,
        token_limit: 500,
        wall_clock_seconds: 30
      }
    });

    assert.equal(outcome.execution_status, "completed");
    assert.equal(outcome.run.payload.status, "completed");
    assert.equal(outcome.run.payload.leader_kind, "runtime");
    assert.equal(outcome.worker.payload.kind, "temporary");
    assert.equal(outcome.worker.payload.status, "expired");
    assert.equal(outcome.lease.payload.destructive_actions, "deny");
    assert.equal(typeof outcome.lease.payload.cleanup_revoked_at, "string");
    assert.ok(outcome.artifact);
    assert.ok(outcome.cleanup.summary.worker_ids_expired.includes(outcome.worker.id));

    const store = new (await import("../src/store.js")).CoordinationStore(
      resolve(root, ...AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH.split("/"))
    );
    try {
      assert.equal(store.listObjects("bot").length, 0);
      assert.equal(store.getObject("runtime_gateway"), null);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("materialized OS engine creates a canonical durable Bot through the existing registry owner", async () => {
  const root = fixture();
  try {
    const result = installAiVerseOsExtension(root);
    const engine: any = await import(pathToFileURL(result.engine_path).href);
    assert.equal(typeof engine.createDurableBot, "function");

    const created = await engine.createDurableBot({
      schema_version: "1.0",
      id: "bot_durable-reviewer",
      name: "Durable Reviewer",
      kind: "durable",
      status: "active",
      role: {
        title: "Delivery Reviewer",
        mission: "Review recurring delivery work within the assigned workspace."
      },
      runtime: { adapter: "deterministic" },
      execution: { environment_policy: "shared_workspace" },
      scope: { type: "workspace", workspace_id: "demo" },
      capabilities: { skill_refs: [] },
      permissions: {
        policy_ref: "default-bot",
        allowed_peers: [],
        allowed_tools: [],
        allowed_connections: [],
        can_create_workers: false
      },
      coordination: { default_mode: "direct", max_parallel_workers: 0, max_hops: 0 }
    });

    assert.equal(created.state, "created");
    assert.equal(created.bot.id, "bot_durable-reviewer");
    assert.equal(created.bot.kind, "bot");
    assert.equal(created.bot.workspace_id, "demo");
    assert.equal(created.bot.payload.kind, "durable");
    assert.equal(created.bot.payload.status, "active");

    const replay = await engine.createDurableBot(created.bot.payload);
    assert.equal(replay.state, "existing");
    assert.equal(replay.bot.id, "bot_durable-reviewer");

    await assert.rejects(
      () => engine.createDurableBot({
        ...created.bot.payload,
        role: { ...created.bot.payload.role, mission: "Changed mission under the same durable identity." }
      }),
      /already exists with different canonical state/
    );

    const store = new (await import("../src/store.js")).CoordinationStore(
      resolve(root, ...AI_VERSE_MULTIPLE_BOTS_COORDINATION_DB_PATH.split("/"))
    );
    try {
      const bot = store.getObject("bot_durable-reviewer");
      assert.equal(bot?.kind, "bot");
      assert.equal(bot?.payload.kind, "durable");
      assert.equal(bot?.payload.scope?.workspace_id, "demo");
      assert.equal(store.listObjects("worker", "demo").length, 0);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
