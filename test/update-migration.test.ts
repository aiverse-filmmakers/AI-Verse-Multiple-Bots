import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
  AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION,
  AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH,
  AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH,
  AI_VERSE_OS_EXTENSION_REGISTRY_PATH
} from "../src/ai-verse-os-registration.js";
import {
  installAiVerseOsExtension,
  expectedAiVerseOsEngine,
  expectedAiVerseOsInstructions
} from "../src/ai-verse-os-install.js";
import {
  AiVerseOsProductUpdateError,
  planAiVerseOsProductUpdate,
  updateAiVerseOsProduct
} from "../src/ai-verse-os-update.js";
import { doctorProduction } from "../src/production-health.js";
import {
  STANDALONE_INSTALL_RECEIPT_SCHEMA,
  readStandaloneReceipt,
  standaloneReceiptPath
} from "../src/standalone-receipt.js";
import { initializeStandalone } from "../src/standalone-install.js";
import {
  StandaloneUpdateError,
  planStandaloneUpdate,
  updateStandaloneInstallation
} from "../src/standalone-update.js";
import { planMultipleBotsUpdate, updateMultipleBots } from "../src/update.js";
import { versionOrder } from "../src/versioning.js";

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

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function osFixture(): string {
  const root = fixture("ai-verse-update-os");
  mkdirSync(resolve(root, "operator"), { recursive: true });
  mkdirSync(resolve(root, "workspaces"), { recursive: true });
  write(root, "AI-VERSE.yaml", 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  write(root, "AGENTS.md", "# Runtime contract\nLoad .aiverse/extensions/registry.json when present.\n");
  write(root, "system/extensions/README.md", "# Extensions\nRegistry: .aiverse/extensions/registry.json\n");
  write(root, "operator/SENTINEL.md", "OPERATOR_CANONICAL\n");
  write(root, "workspaces/SENTINEL.md", "WORKSPACE_CANONICAL\n");
  return root;
}

function registry(root: string): any {
  return JSON.parse(readFileSync(resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8"));
}

function writeRegistry(root: string, document: any): void {
  write(root, AI_VERSE_OS_EXTENSION_REGISTRY_PATH, JSON.stringify(document, null, 2) + "\n");
}

function makeOldOsInstall(root: string): {
  dbPath: string;
  oldInstructions: string;
  oldEngine: string;
} {
  const installed = installAiVerseOsExtension(root);
  const document = registry(root);
  const entry = document.extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID];
  entry.version = "0.1.0-alpha.0";
  entry.enabled = false;
  entry.operator_metadata = { keep: true };
  document.operator_note = "keep-top-level";
  writeRegistry(root, document);

  const oldInstructions = "# old installed instructions\n";
  const oldEngine = "export const oldEngine = true;\n";
  write(root, AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH, oldInstructions);
  write(root, AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH, oldEngine);

  return {
    dbPath: installed.coordination_db_path,
    oldInstructions,
    oldEngine
  };
}

function setSchemaVersion(dbPath: string, version: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(version);
  } finally {
    db.close();
  }
}

test("Phase 5.7 semantic version ordering understands prerelease updates and blocks downgrades deterministically", () => {
  assert.equal(versionOrder("0.1.0-alpha.0", "0.1.0-alpha.1"), "older");
  assert.equal(versionOrder("0.1.0-alpha.1", "0.1.0-alpha.1"), "same");
  assert.equal(versionOrder("0.1.0-alpha.2", "0.1.0-alpha.1"), "newer");
  assert.equal(versionOrder("0.1.0-alpha.9", "0.1.0-beta.1"), "older");
  assert.equal(versionOrder("0.1.0", "0.1.0-beta.9"), "newer");
});

test("Phase 5.7 new standalone installs carry a current version receipt and update is byte-stable", () => {
  const root = fixture("ai-verse-update-standalone-current");
  try {
    const installation = initializeStandalone(root, { port: 0 });
    assert.equal(installation.receiptStatus, "created");
    assert.equal(installation.componentVersion, AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION);
    assert.equal(existsSync(installation.receiptPath), true);

    const receipt = readStandaloneReceipt(installation.home);
    assert.equal(receipt?.schema_version, STANDALONE_INSTALL_RECEIPT_SCHEMA);
    assert.equal(receipt?.component_version, AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION);
    assert.equal(receipt?.coordination_schema, "1");

    const configBefore = readFileSync(installation.configPath, "utf8");
    const dbBefore = hashFile(installation.dbPath);
    const receiptBefore = readFileSync(installation.receiptPath, "utf8");

    const plan = planStandaloneUpdate(root);
    assert.equal(plan.installed_version_state, "same");
    assert.equal(plan.update_required, false);
    assert.equal(plan.migration_required, false);
    assert.equal(plan.can_update, true);

    const result = updateStandaloneInstallation(root);
    assert.equal(result.status, "unchanged");
    assert.equal(result.receipt_written, false);
    assert.equal(readFileSync(installation.configPath, "utf8"), configBefore);
    assert.equal(hashFile(installation.dbPath), dbBefore);
    assert.equal(readFileSync(installation.receiptPath, "utf8"), receiptBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.7 legacy standalone installation is adopted without rewriting config or coordination state", () => {
  const root = fixture("ai-verse-update-standalone-legacy");
  try {
    const installation = initializeStandalone(root, { port: 0 });
    rmSync(installation.receiptPath, { force: true });
    writeFileSync(resolve(installation.home, "operator-note.txt"), "PRESERVE\n", "utf8");
    const configBefore = readFileSync(installation.configPath, "utf8");
    const dbBefore = hashFile(installation.dbPath);

    const plan = planStandaloneUpdate(root);
    assert.equal(plan.installed_version, null);
    assert.equal(plan.installed_version_state, "legacy-unversioned");
    assert.equal(plan.update_required, true);
    assert.equal(plan.migration_required, false);
    assert.equal(plan.can_update, true);
    assert.deepEqual(plan.actions, ["adopt-legacy-installation-receipt"]);

    const result = updateStandaloneInstallation(root);
    assert.equal(result.status, "adopted");
    assert.equal(result.previous_version, null);
    assert.equal(result.receipt_written, true);
    assert.equal(readFileSync(installation.configPath, "utf8"), configBefore);
    assert.equal(hashFile(installation.dbPath), dbBefore);
    assert.equal(readFileSync(resolve(installation.home, "operator-note.txt"), "utf8"), "PRESERVE\n");
    assert.equal(readStandaloneReceipt(installation.home)?.component_version, AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION);

    const detected = planMultipleBotsUpdate({ cwd: root });
    assert.equal(detected.mode, "standalone");
    assert.equal(detected.selected_by, "detected");
    assert.equal(detected.update_required, false);
    assert.equal(updateMultipleBots({ cwd: root }).status, "unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.7 older standalone receipt updates metadata only and preserves unknown receipt fields", () => {
  const root = fixture("ai-verse-update-standalone-old");
  try {
    const installation = initializeStandalone(root, { port: 0 });
    writeFileSync(standaloneReceiptPath(installation.home), JSON.stringify({
      schema_version: STANDALONE_INSTALL_RECEIPT_SCHEMA,
      component_id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
      component_version: "0.1.0-alpha.0",
      coordination_schema: "1",
      mode: "standalone",
      operator_metadata: { keep: true }
    }, null, 2) + "\n", "utf8");
    const configBefore = readFileSync(installation.configPath, "utf8");
    const dbBefore = hashFile(installation.dbPath);

    const plan = planStandaloneUpdate(root);
    assert.equal(plan.installed_version_state, "older");
    assert.equal(plan.can_update, true);

    const result = updateStandaloneInstallation(root);
    assert.equal(result.status, "updated");
    assert.equal(result.previous_version, "0.1.0-alpha.0");
    const receipt = readStandaloneReceipt(installation.home)!;
    assert.equal(receipt.component_version, AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION);
    assert.deepEqual(receipt.operator_metadata, { keep: true });
    assert.equal(readFileSync(installation.configPath, "utf8"), configBefore);
    assert.equal(hashFile(installation.dbPath), dbBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.7 standalone downgrade and unknown schema fail closed without mutation", () => {
  const newer = fixture("ai-verse-update-standalone-newer");
  try {
    const installation = initializeStandalone(newer, { port: 0 });
    writeFileSync(standaloneReceiptPath(installation.home), JSON.stringify({
      schema_version: STANDALONE_INSTALL_RECEIPT_SCHEMA,
      component_id: AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID,
      component_version: "0.1.0-alpha.9",
      coordination_schema: "1",
      mode: "standalone"
    }, null, 2) + "\n", "utf8");
    const receiptBefore = readFileSync(standaloneReceiptPath(installation.home), "utf8");
    const dbBefore = hashFile(installation.dbPath);

    const plan = planStandaloneUpdate(newer);
    assert.equal(plan.installed_version_state, "newer");
    assert.equal(plan.can_update, false);
    assert.throws(
      () => updateStandaloneInstallation(newer),
      (error: unknown) => error instanceof StandaloneUpdateError && error.code === "DOWNGRADE_REQUIRES_ROLLBACK"
    );
    assert.equal(readFileSync(standaloneReceiptPath(installation.home), "utf8"), receiptBefore);
    assert.equal(hashFile(installation.dbPath), dbBefore);
  } finally {
    rmSync(newer, { recursive: true, force: true });
  }

  const migration = fixture("ai-verse-update-standalone-schema");
  try {
    const installation = initializeStandalone(migration, { port: 0 });
    setSchemaVersion(installation.dbPath, "0");
    const receiptBefore = readFileSync(standaloneReceiptPath(installation.home), "utf8");

    const plan = planStandaloneUpdate(migration);
    assert.equal(plan.migration_required, true);
    assert.equal(plan.migration_supported, false);
    assert.equal(plan.can_update, false);
    assert.throws(
      () => updateStandaloneInstallation(migration),
      (error: unknown) => error instanceof StandaloneUpdateError && error.code === "MIGRATION_REQUIRED"
    );
    assert.equal(readFileSync(standaloneReceiptPath(installation.home), "utf8"), receiptBefore);

    const health = doctorProduction({ mode: "standalone", root: migration });
    assert.equal(health.state, "migration-required");
    assert.equal(health.ready, false);
  } finally {
    rmSync(migration, { recursive: true, force: true });
  }
});

test("Phase 5.7 AI-Verse OS update replaces only owned payload, preserves disabled/unknown metadata, and never rewrites coordination state", () => {
  const root = osFixture();
  try {
    const old = makeOldOsInstall(root);
    const dbBefore = hashFile(old.dbPath);
    const operatorBefore = readFileSync(resolve(root, "operator", "SENTINEL.md"), "utf8");
    const workspaceBefore = readFileSync(resolve(root, "workspaces", "SENTINEL.md"), "utf8");

    const plan = planAiVerseOsProductUpdate(root);
    assert.equal(plan.current_version, "0.1.0-alpha.0");
    assert.equal(plan.current_version_state, "older");
    assert.equal(plan.enabled, false);
    assert.equal(plan.update_required, true);
    assert.equal(plan.migration_required, false);
    assert.equal(plan.can_update, true);
    assert.deepEqual(plan.files.map((item) => [item.path, item.state, item.action]), [
      [AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH, "outdated", "replace"],
      [AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH, "outdated", "replace"]
    ]);

    const result = updateAiVerseOsProduct(root);
    assert.equal(result.status, "updated");
    assert.equal(result.previous_version, "0.1.0-alpha.0");
    assert.equal(result.registration_status, "updated");
    assert.deepEqual(result.changed_files, [
      AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH,
      AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH
    ].sort());

    const document = registry(root);
    const entry = document.extensions[AI_VERSE_MULTIPLE_BOTS_EXTENSION_ID];
    assert.equal(entry.version, AI_VERSE_MULTIPLE_BOTS_EXTENSION_VERSION);
    assert.equal(entry.enabled, false);
    assert.deepEqual(entry.operator_metadata, { keep: true });
    assert.equal(document.operator_note, "keep-top-level");
    assert.equal(readFileSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH.split("/")), "utf8"), expectedAiVerseOsInstructions());
    assert.equal(readFileSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH.split("/")), "utf8"), expectedAiVerseOsEngine());
    assert.equal(hashFile(old.dbPath), dbBefore);
    assert.equal(readFileSync(resolve(root, "operator", "SENTINEL.md"), "utf8"), operatorBefore);
    assert.equal(readFileSync(resolve(root, "workspaces", "SENTINEL.md"), "utf8"), workspaceBefore);

    const final = planAiVerseOsProductUpdate(root);
    assert.equal(final.update_required, false);
    assert.equal(final.can_update, true);
    const health = doctorProduction({ mode: "os", root });
    assert.equal(health.state, "disabled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.7 AI-Verse OS update rolls package-owned files back when registry commit cannot complete", () => {
  const root = osFixture();
  try {
    const old = makeOldOsInstall(root);
    const registryBefore = readFileSync(resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8");
    const dbBefore = hashFile(old.dbPath);
    write(root, AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH, '{"extension_id":"other-installer"}\n');

    assert.throws(
      () => updateAiVerseOsProduct(root),
      (error: unknown) => error instanceof AiVerseOsProductUpdateError
    );

    assert.equal(readFileSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH.split("/")), "utf8"), old.oldInstructions);
    assert.equal(readFileSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH.split("/")), "utf8"), old.oldEngine);
    assert.equal(readFileSync(resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8"), registryBefore);
    assert.equal(hashFile(old.dbPath), dbBefore);
    assert.equal(readFileSync(resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_LOCK_PATH.split("/")), "utf8"), '{"extension_id":"other-installer"}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.7 AI-Verse OS update refuses unknown coordination schema before replacing files or registry", () => {
  const root = osFixture();
  try {
    const old = makeOldOsInstall(root);
    setSchemaVersion(old.dbPath, "0");
    const instructionsBefore = readFileSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH.split("/")), "utf8");
    const engineBefore = readFileSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH.split("/")), "utf8");
    const registryBefore = readFileSync(resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8");

    const plan = planAiVerseOsProductUpdate(root);
    assert.equal(plan.migration_required, true);
    assert.equal(plan.migration_supported, false);
    assert.equal(plan.can_update, false);

    assert.throws(
      () => updateAiVerseOsProduct(root),
      (error: unknown) => error instanceof AiVerseOsProductUpdateError && error.code === "MIGRATION_REQUIRED"
    );

    assert.equal(readFileSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_INSTRUCTIONS_PATH.split("/")), "utf8"), instructionsBefore);
    assert.equal(readFileSync(resolve(root, ...AI_VERSE_MULTIPLE_BOTS_ENGINE_PATH.split("/")), "utf8"), engineBefore);
    assert.equal(readFileSync(resolve(root, ...AI_VERSE_OS_EXTENSION_REGISTRY_PATH.split("/")), "utf8"), registryBefore);

    const health = doctorProduction({ mode: "os", root });
    assert.equal(health.state, "migration-required");
    assert.equal(health.ready, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
