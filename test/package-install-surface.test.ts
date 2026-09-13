import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";

const root = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const cli = readFileSync(resolve(root, "src/cli.ts"), "utf8");

test("Phase 5.1 package exposes one stable install command without install-time host mutation", () => {
  assert.equal(pkg.name, "@ai-verse/multiple-bots");
  assert.equal(pkg.private, false);
  assert.deepEqual(pkg.bin, {
    "ai-verse-multiple-bots": "dist/src/cli.js"
  });
  assert.equal(pkg.scripts?.postinstall, undefined);
  assert.equal(pkg.scripts?.install, undefined);
  assert.equal(pkg.scripts?.preinstall, undefined);
  assert.equal(pkg.publishConfig?.access, "public");
  assert.match(cli, /^#!\/usr\/bin\/env node/);
});

test("Phase 5.1 package ships runtime code and required static integration assets but not tests or runtime state", () => {
  assert.deepEqual(pkg.files, [
    "dist/src",
    "schemas",
    "templates",
    "integrations"
  ]);
  assert.equal(pkg.files.includes("test"), false);
  assert.equal(pkg.files.includes("runtime"), false);
  assert.equal(pkg.files.includes("dist/test"), false);
});

test("Phase 5.1 package acceptance has an explicit real pack/install smoke command", () => {
  assert.equal(pkg.scripts?.["pack:check"], "npm run build && node scripts/verify-package.mjs");
  assert.equal(pkg.scripts?.prepack, "npm run build");
});
