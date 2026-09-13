import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
    "dist/src/standalone-install.js",
    "dist/src/ai-verse-os-install.js",
    "dist/src/setup.js",
    "dist/src/template-catalog.js",
    "dist/src/production-health.js",
    "schemas/coordination-v1.schema.json",
    "templates/bot.yaml",
    "templates/room.yaml",
    "templates/starter-catalog.json",
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

  const setupModes = JSON.parse(run(binPath, ["setup", "modes"], { cwd: installDir }));
  assert.equal(setupModes.ok, true);
  assert.deepEqual(
    setupModes.setup_help.modes.map((item) => item.mode),
    ["standalone", "ai-verse-os"]
  );

  const templateList = JSON.parse(run(binPath, ["template", "list"], { cwd: installDir }));
  assert.equal(templateList.ok, true);
  assert.deepEqual(
    templateList.templates.map((item) => item.id),
    ["research-lead", "reviewer", "coordinator", "research-team", "delivery-team"]
  );

  const templateDbPath = join(installDir, "runtime", "template-smoke.db");
  const templatePlan = JSON.parse(run(
    binPath,
    ["template", "plan", "--id", "research-team", "--workspace", "ws_package", "--db", templateDbPath],
    { cwd: installDir }
  ));
  assert.equal(templatePlan.ok, true);
  assert.equal(templatePlan.plan.can_apply, true);
  assert.equal(templatePlan.plan.creates_team_run, false);
  assert.equal(templatePlan.plan.objects.length, 4);

  const templateApply = JSON.parse(run(
    binPath,
    ["template", "apply", "--id", "research-team", "--workspace", "ws_package", "--db", templateDbPath],
    { cwd: installDir }
  ));
  assert.equal(templateApply.ok, true);
  assert.equal(templateApply.application.status, "applied");
  assert.equal(templateApply.application.created_ids.length, 4);

  const templateApplyAgain = JSON.parse(run(
    binPath,
    ["template", "apply", "--id", "research-team", "--workspace", "ws_package", "--db", templateDbPath],
    { cwd: installDir }
  ));
  assert.equal(templateApplyAgain.ok, true);
  assert.equal(templateApplyAgain.application.status, "unchanged");
  assert.deepEqual(templateApplyAgain.application.created_ids, []);

  const setupStandaloneRoot = join(installDir, "setup-standalone-project");
  mkdirSync(setupStandaloneRoot, { recursive: true });
  const setupStandalone = JSON.parse(run(
    binPath,
    ["setup", "--mode", "standalone", "--root", setupStandaloneRoot, "--port", "0"],
    { cwd: installDir }
  ));
  assert.equal(setupStandalone.ok, true);
  assert.equal(setupStandalone.setup.mode, "standalone");
  assert.equal(setupStandalone.setup.status, "ready");
  assert.equal(setupStandalone.setup.selected_by, "explicit");
  assert.equal(existsSync(join(setupStandaloneRoot, ".ai-verse-bots", "config.json")), true);
  assert.equal(existsSync(join(setupStandaloneRoot, ".ai-verse-bots", "runtime", "coordination.db")), true);

  const standaloneStatus = JSON.parse(run(
    binPath,
    ["status", "--mode", "standalone", "--root", setupStandaloneRoot],
    { cwd: installDir }
  ));
  assert.equal(standaloneStatus.state, "ready");
  assert.equal(standaloneStatus.ready, true);

  const productionStandaloneDoctor = JSON.parse(run(
    binPath,
    ["doctor", "--mode", "standalone", "--root", setupStandaloneRoot],
    { cwd: installDir }
  ));
  assert.equal(productionStandaloneDoctor.provider, "ai-verse-multiple-bots/production-health-v1");
  assert.equal(productionStandaloneDoctor.state, "ready");
  assert.equal(productionStandaloneDoctor.ready, true);
  assert.equal(productionStandaloneDoctor.read_only, true);
  assert.deepEqual(
    productionStandaloneDoctor.checked_depths,
    ["structural", "attachment", "runtime", "dependency", "operational"]
  );

  const dbPath = join(installDir, "runtime", "install-smoke.db");
  const initOutput = run(binPath, ["init", "--db", dbPath], { cwd: installDir });
  const init = JSON.parse(initOutput);
  assert.equal(init.ok, true);
  assert.equal(resolve(init.db), resolve(dbPath));
  assert.equal(init.schemaVersion, "1");

  const doctorOutput = run(binPath, ["doctor", "--db", dbPath], { cwd: installDir });
  const doctor = JSON.parse(doctorOutput);
  assert.equal(doctor.ok, true);

  const standaloneRoot = join(installDir, "standalone-project");
  mkdirSync(standaloneRoot, { recursive: true });
  const standaloneInitOutput = run(
    binPath,
    ["standalone", "init", "--root", standaloneRoot, "--port", "0"],
    { cwd: installDir }
  );
  const standaloneInit = JSON.parse(standaloneInitOutput);
  assert.equal(standaloneInit.ok, true);
  assert.equal(standaloneInit.mode, "standalone");
  assert.equal(standaloneInit.installation.status, "initialized");
  assert.equal(existsSync(join(standaloneRoot, ".ai-verse-bots", "config.json")), true);
  assert.equal(existsSync(join(standaloneRoot, ".ai-verse-bots", "runtime", "coordination.db")), true);
  assert.equal(existsSync(join(standaloneRoot, "AI-VERSE.yaml")), false);
  assert.equal(existsSync(join(standaloneRoot, "operator")), false);
  assert.equal(existsSync(join(standaloneRoot, "workspaces")), false);

  const standaloneDoctorOutput = run(
    binPath,
    ["standalone", "doctor", "--root", standaloneRoot],
    { cwd: installDir }
  );
  const standaloneDoctor = JSON.parse(standaloneDoctorOutput);
  assert.equal(standaloneDoctor.provider, "ai-verse-multiple-bots/production-health-v1");
  assert.equal(standaloneDoctor.state, "ready");
  assert.equal(standaloneDoctor.ready, true);
  assert.equal(standaloneDoctor.mode, "standalone");
  assert.equal(standaloneDoctor.read_only, true);

  const osRoot = join(installDir, "ai-verse-os");
  mkdirSync(join(osRoot, "operator"), { recursive: true });
  mkdirSync(join(osRoot, "workspaces"), { recursive: true });
  mkdirSync(join(osRoot, "system", "extensions"), { recursive: true });
  writeFileSync(join(osRoot, "AI-VERSE.yaml"), 'schema_version: "2.0"\narchitecture: unified-workspace\n', "utf8");
  writeFileSync(join(osRoot, "AGENTS.md"), "# Runtime contract\nLoad .aiverse/extensions/registry.json when present.\n", "utf8");
  writeFileSync(join(osRoot, "system", "extensions", "README.md"), "# Local extensions\nRegistry: .aiverse/extensions/registry.json\n", "utf8");
  writeFileSync(join(osRoot, "operator", "sentinel.md"), "operator canonical state\n", "utf8");
  writeFileSync(join(osRoot, "workspaces", "sentinel.md"), "workspace canonical state\n", "utf8");
  const canonicalBefore = {
    manifest: readFileSync(join(osRoot, "AI-VERSE.yaml"), "utf8"),
    agents: readFileSync(join(osRoot, "AGENTS.md"), "utf8"),
    extensionContract: readFileSync(join(osRoot, "system", "extensions", "README.md"), "utf8"),
    operator: readFileSync(join(osRoot, "operator", "sentinel.md"), "utf8"),
    workspace: readFileSync(join(osRoot, "workspaces", "sentinel.md"), "utf8")
  };

  const osPlanOutput = run(binPath, ["os", "install-plan", "--root", osRoot], { cwd: installDir });
  const osPlan = JSON.parse(osPlanOutput);
  assert.equal(osPlan.ok, true);
  assert.equal(osPlan.install.can_install, true);

  const osInstallOutput = run(binPath, ["os", "install", "--root", osRoot], { cwd: installDir });
  const osInstall = JSON.parse(osInstallOutput);
  assert.equal(osInstall.ok, true);
  assert.equal(osInstall.install.status, "installed");
  assert.equal(osInstall.install.database_initialized, true);
  assert.equal(osInstall.install.registration_status, "registered");

  const enginePath = join(osRoot, ".aiverse", "extensions", "ai-verse-multiple-bots", "engine.mjs");
  const instructionsPath = join(osRoot, ".aiverse", "extensions", "ai-verse-multiple-bots", "INSTRUCTIONS.md");
  const registryPath = join(osRoot, ".aiverse", "extensions", "registry.json");
  const osDbPath = join(osRoot, "runtime", "ai-verse-bots", "coordination.db");
  assert.equal(existsSync(enginePath), true);
  assert.equal(existsSync(instructionsPath), true);
  assert.equal(existsSync(registryPath), true);
  assert.equal(existsSync(osDbPath), true);

  const registered = JSON.parse(readFileSync(registryPath, "utf8")).extensions["ai-verse-multiple-bots"];
  assert.equal(registered.source, "AI-Verse-Multiple-Bots");
  assert.equal(registered.version, "0.1.0-alpha.1");
  assert.equal(registered.engine, ".aiverse/extensions/ai-verse-multiple-bots/engine.mjs");

  assert.deepEqual({
    manifest: readFileSync(join(osRoot, "AI-VERSE.yaml"), "utf8"),
    agents: readFileSync(join(osRoot, "AGENTS.md"), "utf8"),
    extensionContract: readFileSync(join(osRoot, "system", "extensions", "README.md"), "utf8"),
    operator: readFileSync(join(osRoot, "operator", "sentinel.md"), "utf8"),
    workspace: readFileSync(join(osRoot, "workspaces", "sentinel.md"), "utf8")
  }, canonicalBefore);

  const engineUrl = pathToFileURL(enginePath).href;
  const engineSmoke = run(process.execPath, [
    "--input-type=module",
    "--eval",
    `const m=await import(${JSON.stringify(engineUrl)}); const s=await m.startGateway({port:0}); try { const r=await fetch('http://'+s.address.host+':'+s.address.port+'/health'); const b=await r.json(); if(!b.ok||b.schemaVersion!=='1') throw new Error('health failed'); console.log(JSON.stringify({ok:true,root:m.aiVerseOsRoot,db:s.db})); } finally { await s.service.close(); }`
  ], { cwd: installDir });
  const engineResult = JSON.parse(engineSmoke);
  assert.equal(engineResult.ok, true);
  assert.equal(resolve(engineResult.root), resolve(osRoot));
  assert.equal(resolve(engineResult.db), resolve(osDbPath));

  const osInstallAgain = JSON.parse(run(binPath, ["os", "install", "--root", osRoot], { cwd: installDir }));
  assert.equal(osInstallAgain.install.status, "unchanged");
  assert.equal(osInstallAgain.install.database_initialized, false);
  assert.equal(osInstallAgain.install.registration_status, "unchanged");

  const setupOs = JSON.parse(run(binPath, ["setup", "--root", osRoot], { cwd: installDir }));
  assert.equal(setupOs.ok, true);
  assert.equal(setupOs.setup.mode, "ai-verse-os");
  assert.equal(setupOs.setup.status, "ready");
  assert.equal(setupOs.setup.selected_by, "detected");
  assert.equal(setupOs.setup.changed, false);
  assert.equal(setupOs.setup.verification.ok, true);

  const osDoctor = JSON.parse(run(
    binPath,
    ["doctor", "--mode", "os", "--root", osRoot],
    { cwd: installDir }
  ));
  assert.equal(osDoctor.mode, "ai-verse-os");
  assert.equal(osDoctor.state, "ready");
  assert.equal(osDoctor.ready, true);
  assert.deepEqual(osDoctor.delegated_depths, ["system/composed"]);

  console.log(JSON.stringify({
    ok: true,
    package: `${record.name}@${record.version}`,
    tarball: record.filename,
    packed_files: files.size,
    command: "ai-verse-multiple-bots",
    install_smoke: "passed",
    standalone_install_smoke: "passed",
    ai_verse_os_install_smoke: "passed",
    ai_verse_os_engine_smoke: "passed",
    setup_onboarding_smoke: "passed",
    starter_template_smoke: "passed",
    production_doctor_smoke: "passed"
  }, null, 2));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
