#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const LOCK_PATH = resolve(REPO_ROOT, "scripts", "platform-smoke.lock.json");
const REQUIRED_REPOS = ["os", "memory", "brain", "skills"];
const SHA256_RE = /^[a-f0-9]{40}$/;

export function validateLock(lock) {
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) {
    throw new Error("platform smoke lock must be a JSON object");
  }
  if (lock.schema_version !== 1) {
    throw new Error(`unsupported platform smoke lock schema: ${String(lock.schema_version)}`);
  }
  if (!lock.repositories || typeof lock.repositories !== "object" || Array.isArray(lock.repositories)) {
    throw new Error("platform smoke lock is missing repositories");
  }

  for (const key of REQUIRED_REPOS) {
    const entry = lock.repositories[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`platform smoke lock is missing repository '${key}'`);
    }
    if (typeof entry.repository !== "string" || !/^https:\/\/github\.com\/aiverse-filmmakers\/AI-Verse-[A-Za-z-]+\.git$/.test(entry.repository)) {
      throw new Error(`platform smoke lock repository '${key}' must use an explicit AI-Verse GitHub HTTPS URL`);
    }
    if (typeof entry.commit !== "string" || !SHA256_RE.test(entry.commit)) {
      throw new Error(`platform smoke lock repository '${key}' must use an exact 40-character commit SHA`);
    }
  }
  return lock;
}

export function runStep(name, command, args = [], options = {}) {
  const capture = options.capture === true;
  if (!options.quiet) console.log(`\n==> ${name}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    input: options.input,
    stdio: capture ? [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] : "inherit"
  });

  if (result.error) {
    throw new Error(`${name} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = capture
      ? `\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`
      : "";
    throw new Error(`${name} failed with exit code ${String(result.status)}${detail}`);
  }
  return capture ? String(result.stdout ?? "") : "";
}

export function findPython() {
  const candidates = [process.env.PYTHON, "python3", "python"].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error("Python 3 is required for the platform smoke. Set PYTHON to an explicit interpreter if needed.");
}

function parseArgs(argv) {
  let workspace = null;
  let keep = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") {
      keep = true;
    } else if (arg === "--workspace") {
      workspace = argv[index + 1] ? resolve(argv[++index]) : null;
      if (!workspace) throw new Error("--workspace requires a path");
    } else {
      throw new Error(`unknown platform smoke argument: ${arg}`);
    }
  }
  return { workspace, keep };
}

function venvPython(venvRoot) {
  return process.platform === "win32"
    ? resolve(venvRoot, "Scripts", "python.exe")
    : resolve(venvRoot, "bin", "python");
}

function clonePinned(lock, key, reposRoot) {
  const entry = lock.repositories[key];
  const target = resolve(reposRoot, key);
  runStep(`Clone ${key}`, "git", ["clone", "--quiet", entry.repository, target]);
  runStep(`Checkout ${key} ${entry.commit.slice(0, 12)}`, "git", ["-C", target, "checkout", "--quiet", "--detach", entry.commit]);
  const actual = runStep(`Verify ${key} revision`, "git", ["-C", target, "rev-parse", "HEAD"], { capture: true, quiet: true }).trim();
  if (actual !== entry.commit) throw new Error(`${key} revision mismatch: expected ${entry.commit}, got ${actual}`);
  return target;
}

function selectedMultipleBotsTests() {
  return [
    resolve(REPO_ROOT, "dist", "test", "ai-verse-os-registration.test.js"),
    resolve(REPO_ROOT, "dist", "test", "brain-objective-ingress-contract.test.js"),
    resolve(REPO_ROOT, "dist", "test", "brain-objective-worker.test.js"),
    resolve(REPO_ROOT, "dist", "test", "worker-execution.test.js"),
    resolve(REPO_ROOT, "dist", "test", "safety-ii.test.js")
  ];
}

export function loadLock(path = LOCK_PATH) {
  return validateLock(JSON.parse(readFileSync(path, "utf8")));
}

export function main(argv = process.argv.slice(2)) {
  const { workspace, keep } = parseArgs(argv);
  const lock = loadLock();
  const python = findPython();
  const temporary = workspace === null;
  const workRoot = workspace ?? mkdtempSync(join(tmpdir(), "ai-verse-platform-smoke-"));
  const reposRoot = resolve(workRoot, "repos");
  const venvRoot = resolve(workRoot, "venv");

  mkdirSync(reposRoot, { recursive: true });
  console.log(`AI-Verse platform smoke workspace: ${workRoot}`);

  try {
    const roots = {};
    for (const key of REQUIRED_REPOS) roots[key] = clonePinned(lock, key, reposRoot);

    runStep("Create isolated Python environment", python, ["-m", "venv", venvRoot]);
    const isolatedPython = venvPython(venvRoot);
    if (!existsSync(isolatedPython)) throw new Error(`isolated Python interpreter missing at ${isolatedPython}`);

    runStep("Install audited Brain revision into isolated environment", isolatedPython, ["-m", "pip", "install", "--disable-pip-version-check", "--quiet", "-e", roots.brain]);

    runStep(
      "Multiple Bots critical coordination contracts",
      process.execPath,
      ["--test", ...selectedMultipleBotsTests()],
      { cwd: REPO_ROOT }
    );

    runStep(
      "Five-repo composed runtime acceptance",
      isolatedPython,
      [
        resolve(REPO_ROOT, "scripts", "platform-smoke-acceptance.py"),
        "--os-root", roots.os,
        "--memory-root", roots.memory,
        "--brain-root", roots.brain,
        "--skills-root", roots.skills,
        "--multiple-bots-root", REPO_ROOT,
        "--work-root", workRoot
      ],
      { cwd: REPO_ROOT }
    );

    console.log("\nAI-Verse platform-wide smoke: PASS");
    for (const key of REQUIRED_REPOS) {
      console.log(`  ${key}: ${lock.repositories[key].commit}`);
    }
    console.log(`  multiple-bots: working tree under test`);
    return 0;
  } finally {
    if (temporary && !keep) {
      rmSync(workRoot, { recursive: true, force: true });
    } else {
      console.log(`Platform smoke workspace preserved at: ${workRoot}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`\nAI-Verse platform-wide smoke: FAIL\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
