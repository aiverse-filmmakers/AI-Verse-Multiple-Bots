import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import { runStep, validateLock } from "../scripts/platform-smoke.mjs";

function validLock() {
  return {
    schema_version: 1,
    repositories: {
      os: { repository: "https://github.com/aiverse-filmmakers/AI-Verse-OS.git", commit: "a".repeat(40) },
      memory: { repository: "https://github.com/aiverse-filmmakers/AI-Verse-Memory.git", commit: "b".repeat(40) },
      brain: { repository: "https://github.com/aiverse-filmmakers/AI-Verse-Brain.git", commit: "c".repeat(40) },
      skills: { repository: "https://github.com/aiverse-filmmakers/AI-Verse-Skills.git", commit: "d".repeat(40) }
    }
  };
}

test("platform smoke lock requires exact immutable revisions for every external repo", () => {
  assert.equal(validateLock(validLock()).repositories.os.commit, "a".repeat(40));

  const missing = validLock();
  delete missing.repositories.memory;
  assert.throws(() => validateLock(missing), /missing repository 'memory'/);

  const floating = validLock();
  floating.repositories.brain.commit = "main";
  assert.throws(() => validateLock(floating), /exact 40-character commit SHA/);

  const foreign = validLock();
  foreign.repositories.skills.repository = "https://example.test/skills.git";
  assert.throws(() => validateLock(foreign), /explicit AI-Verse GitHub HTTPS URL/);
});

test("platform smoke runner propagates a failing child command", () => {
  assert.throws(
    () => runStep(
      "intentional harness failure",
      process.execPath,
      ["-e", "process.stderr.write('contract failed'); process.exit(7)"],
      { capture: true, quiet: true }
    ),
    (error) => {
      assert.match(String(error), /exit code 7/);
      assert.match(String(error), /contract failed/);
      return true;
    }
  );
});

test("platform smoke runner returns captured stdout from successful commands", () => {
  const output = runStep(
    "captured success",
    process.execPath,
    ["-e", "process.stdout.write('platform-ok')"],
    { capture: true, quiet: true }
  );
  assert.equal(output, "platform-ok");
});
