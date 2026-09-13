import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.cwd());
const tempRoot = mkdtempSync(join(tmpdir(), "ai-verse-multiple-bots-pack-"));
const packDir = join(tempRoot, "pack");
const installDir = join(tempRoot, "install");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: process.env,
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        result.stdout,
        result.stderr
      ].filter(Boolean).join("\n")
    );
  }
  return result.stdout.trim();
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });

  const packedJson = run("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    packDir
  ]);
  const packed = JSON.parse(packedJson);
  assert.equal(Array.isArray(packed), true, "npm pack --json must return an array");
  assert.equal(packed.length, 1, "npm pack must produce exactly one package");

  const record = packed[0];
  assert.equal(record.name, "@ai-verse/multiple-bots");
  assert.equal(record.version, "0.1.0-alpha.1");
  const files = new Set((record.files ?? []).map((entry) => String(entry.path)));

  for (const required of [
    "package.json",
    "README.md",
    "dist/src/cli.js",
    "dist/src/server.js",
    "schemas/coordination-v1.schema.json",
    "templates/bot.yaml",
    "templates/room.yaml",
    "integrations/ai-verse-os/INSTRUCTIONS.md",
    "integrations/ai-verse-os/extension.json"
  ]) {
    assert.equal(files.has(required), true, `packed artifact is missing ${required}`);
  }

  for (const forbiddenPrefix of ["test/", "dist/test/", "runtime/"]) {
    assert.equal(
      [...files].some((path) => path.startsWith(forbiddenPrefix)),
      false,
      `packed artifact must not contain ${forbiddenPrefix}`
    );
  }

  const tarball = join(packDir, basename(String(record.filename)));
  assert.equal(existsSync(tarball), true, "npm pack did not create the tarball");

  writeFileSync(
    join(installDir, "package.json"),
    JSON.stringify({ name: "phase-5-1-install-smoke", private: true }, null, 2) + "\n",
    "utf8"
  );
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: installDir });

  const installedPackagePath = join(installDir, "node_modules", "@ai-verse", "multiple-bots", "package.json");
  const installed = JSON.parse(readFileSync(installedPackagePath, "utf8"));
  assert.deepEqual(installed.bin, { "ai-verse-multiple-bots": "dist/src/cli.js" });
  assert.equal(installed.scripts?.postinstall, undefined, "package must not mutate the host during npm install");

  const binName = process.platform === "win32" ? "ai-verse-multiple-bots.cmd" : "ai-verse-multiple-bots";
  const binPath = join(installDir, "node_modules", ".bin", binName);
  assert.equal(existsSync(binPath), true, "npm install did not expose the CLI bin");

  const dbPath = join(installDir, "runtime", "install-smoke.db");
  const initOutput = run(binPath, ["init", "--db", dbPath], { cwd: installDir });
  const init = JSON.parse(initOutput);
  assert.equal(init.ok, true);
  assert.equal(resolve(init.db), resolve(dbPath));
  assert.equal(typeof init.schemaVersion, "number");

  const doctorOutput = run(binPath, ["doctor", "--db", dbPath], { cwd: installDir });
  const doctor = JSON.parse(doctorOutput);
  assert.equal(doctor.ok, true);

  console.log(JSON.stringify({
    ok: true,
    package: `${record.name}@${record.version}`,
    tarball: record.filename,
    packed_files: files.size,
    command: "ai-verse-multiple-bots",
    install_smoke: "passed"
  }, null, 2));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
