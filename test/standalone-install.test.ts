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
import test from "node:test";
import { createGatewayServer } from "../src/server.js";
import {
  STANDALONE_CONFIG_FILE,
  STANDALONE_CONFIG_SCHEMA_VERSION,
  STANDALONE_COORDINATION_DB,
  STANDALONE_HOME_DIRECTORY,
  StandaloneInstallError,
  doctorStandalone,
  findStandaloneRoot,
  initializeStandalone,
  readStandaloneInstallation,
  standaloneGatewayOptions,
  standalonePaths
} from "../src/standalone-install.js";

function fixture(): string {
  const root = `/tmp/ai-verse-standalone-${randomUUID()}`;
  mkdirSync(root, { recursive: true });
  return root;
}

function getJson(host: string, port: number, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host, port, path, method: "GET" }, (res: any) => {
      const chunks: string[] = [];
      res.on("data", (chunk: unknown) => chunks.push(String(chunk)));
      res.on("end", () => {
        try {
          resolvePromise({
            status: Number(res.statusCode ?? 0),
            body: JSON.parse(chunks.join(""))
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("Phase 5.2 standalone init creates only .ai-verse-bots config and coordination runtime state", () => {
  const root = fixture();
  try {
    const result = initializeStandalone(root, { host: "127.0.0.1", port: 0 });
    assert.equal(result.status, "initialized");
    assert.equal(result.schemaVersion, "1");
    assert.equal(result.home, resolve(root, STANDALONE_HOME_DIRECTORY));
    assert.equal(result.dbPath, resolve(root, STANDALONE_HOME_DIRECTORY, "runtime", "coordination.db"));
    assert.equal(existsSync(result.configPath), true);
    assert.equal(existsSync(result.dbPath), true);

    const config = JSON.parse(readFileSync(result.configPath, "utf8"));
    assert.deepEqual(config, {
      schema_version: STANDALONE_CONFIG_SCHEMA_VERSION,
      mode: "standalone",
      storage: { coordination_db: STANDALONE_COORDINATION_DB },
      gateway: { host: "127.0.0.1", port: 0 }
    });

    for (const osOnlyPath of ["AI-VERSE.yaml", "operator", "workspaces", ".aiverse"]) {
      assert.equal(existsSync(resolve(root, osOnlyPath)), false, `standalone init must not create ${osOnlyPath}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.2 standalone init is byte-stable and preserves unrelated user files", () => {
  const root = fixture();
  try {
    const first = initializeStandalone(root, { port: 0 });
    const firstConfig = readFileSync(first.configPath, "utf8");
    const note = resolve(first.home, "operator-note.txt");
    writeFileSync(note, "keep me\n", "utf8");

    const second = initializeStandalone(root);
    assert.equal(second.status, "unchanged");
    assert.equal(readFileSync(second.configPath, "utf8"), firstConfig);
    assert.equal(readFileSync(note, "utf8"), "keep me\n");

    assert.throws(
      () => initializeStandalone(root, { port: 8787 }),
      (error: unknown) => error instanceof StandaloneInstallError && error.code === "STANDALONE_CONFIG_MISMATCH"
    );
    assert.equal(readFileSync(second.configPath, "utf8"), firstConfig);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.2 standalone root discovery works from descendants and config remains host-neutral", () => {
  const root = fixture();
  try {
    initializeStandalone(root, { port: 0 });
    const nested = resolve(root, "project", "src", "deep");
    mkdirSync(nested, { recursive: true });
    assert.equal(findStandaloneRoot(nested), root);

    const installation = readStandaloneInstallation(root);
    assert.equal(installation.config.mode, "standalone");
    assert.equal("ai_verse_os_root" in installation.config, false);
    assert.equal("workspace" in installation.config, false);
    assert.equal("operator" in installation.config, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.2 standalone config and internal state paths fail closed on malformed state or symlink traversal", () => {
  const malformed = fixture();
  try {
    const paths = standalonePaths(malformed);
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(paths.configPath, '{"schema_version":"9.0","mode":"standalone"}\n', "utf8");
    const before = readFileSync(paths.configPath, "utf8");
    assert.throws(
      () => initializeStandalone(malformed),
      (error: unknown) => error instanceof StandaloneInstallError
        && error.code === "UNSUPPORTED_STANDALONE_CONFIG_SCHEMA"
    );
    assert.equal(readFileSync(paths.configPath, "utf8"), before);
  } finally {
    rmSync(malformed, { recursive: true, force: true });
  }

  const symlinked = fixture();
  const external = fixture();
  try {
    const result = initializeStandalone(symlinked, { port: 0 });
    rmSync(resolve(result.home, "runtime"), { recursive: true, force: true });
    symlinkSync(external, resolve(result.home, "runtime"));
    assert.throws(
      () => readStandaloneInstallation(symlinked),
      (error: unknown) => error instanceof StandaloneInstallError
        && error.code === "UNSAFE_STANDALONE_PATH"
    );
  } finally {
    rmSync(symlinked, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("Phase 5.2 standalone doctor reports missing installs without creating them and validates healthy installs", () => {
  const root = fixture();
  try {
    const missing = doctorStandalone(root);
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "STANDALONE_INSTALL_NOT_FOUND");
    assert.equal(existsSync(resolve(root, STANDALONE_HOME_DIRECTORY)), false);

    initializeStandalone(root, { port: 0 });
    const healthy = doctorStandalone(root);
    assert.equal(healthy.ok, true);
    assert.equal(healthy.mode, "standalone");
    assert.equal(healthy.schemaVersion, "1");
    assert.deepEqual(healthy.checks, {
      home: true,
      config: true,
      database: true,
      coordination_schema: true,
      store_health: true
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.2 standalone gateway starts from standalone config with no AI-Verse OS attachment", async () => {
  const root = fixture();
  try {
    initializeStandalone(root, { host: "127.0.0.1", port: 0 });
    const options = standaloneGatewayOptions(root);
    assert.equal(options.host, "127.0.0.1");
    assert.equal(options.port, 0);

    const service = createGatewayServer({
      host: options.host,
      port: options.port,
      dbPath: options.dbPath
    });
    try {
      const address = await service.listen();
      const response = await getJson(address.host, address.port, "/health");
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.schemaVersion, "1");
      assert.equal(service.brainObjectiveSource, undefined);
      assert.equal(service.memoryRecallSource, undefined);
      assert.equal(service.skillsCapabilitySource, undefined);
      assert.equal(service.automationInvocationSource, undefined);
      assert.equal(service.osWriteCommandSink, undefined);
    } finally {
      await service.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
