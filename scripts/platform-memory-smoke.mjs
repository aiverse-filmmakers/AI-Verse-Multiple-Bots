#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolve } from "node:path";
import process from "node:process";
import {
  AiVerseMemoryRecallSource,
  detectAiVerseMemoryInstallation
} from "../dist/src/ai-verse-memory-recall.js";

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const osRoot = flag("os-root");
const python = flag("python");
if (!osRoot || !python) {
  throw new Error("usage: platform-memory-smoke.mjs --os-root PATH --python PATH");
}

const root = resolve(osRoot);
const installation = detectAiVerseMemoryInstallation(root);
assert.equal(installation.status, "compatible", installation.reason);
assert.match(String(installation.providerVersion), /^0\.2\./);

const source = new AiVerseMemoryRecallSource(root, {
  pythonExecutable: resolve(python),
  timeoutMs: 15_000,
  maxResults: 5
});
const projection = await source.recall("alpha", {
  query: "alpha-only-platform-smoke-secret",
  limit: 5,
  include_history: false
});

assert.equal(projection.schema_version, "1.0");
assert.equal(projection.provider, "ai-verse-memory");
assert.equal(projection.workspace_id, "alpha");
assert.equal(projection.include_history, false);
assert.match(projection.query_digest, /^[a-f0-9]{64}$/);
assert.match(projection.recall_digest, /^[a-f0-9]{64}$/);

const target = projection.items.find((item) => item.content.includes("alpha-only-platform-smoke-secret"));
assert.ok(target, "Multiple Bots did not retrieve the real workspace Memory record");
assert.equal(target.scope, "workspace:alpha");
assert.equal(target.kind, "memory");
assert.equal(target.freshness, "historical");
assert.match(target.path, /^workspaces\/alpha\/memory\/atomic\/.+\.md$/);
assert.match(target.source_identity, /^sha256:[a-f0-9]{64}$/);
assert.match(target.source_version, /^sha256:[a-f0-9]{64}$/);
assert.match(target.digest, /^[a-f0-9]{64}$/);
assert.equal(
  projection.items.some((item) => item.scope === "workspace:beta" || item.content.includes("beta-only-platform-smoke-secret")),
  false,
  "real Memory bridge leaked beta workspace data into alpha recall"
);

console.log("Multiple Bots x real installed Memory engine recall: PASS");
