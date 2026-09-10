import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { detectAiVerseMemoryInstallation } from "../src/ai-verse-memory-recall.js";

function write(root: string, relative: string, content: string): void {
  const path = resolve(root, ...relative.split("/"));
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(resolve(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8" });
}

function fixture(entry: Record<string, unknown> | null): string {
  const root = `/tmp/ai-verse-memory-registration-${randomUUID()}`;
  mkdirSync(resolve(root, "operator"), { recursive: true });
  mkdirSync(resolve(root, "workspaces/ws-alpha"), { recursive: true });
  write(root, "AI-VERSE.yaml", 'schema_version: "2.0"\narchitecture: unified-workspace\n');
  write(root, "AGENTS.md", "# Runtime\nLoad .aiverse/extensions/registry.json when present.\n");
  write(root, "system/extensions/README.md", "# Extensions\nRegistry: .aiverse/extensions/registry.json\n");
  write(root, "workspaces/ws-alpha/WORKSPACE.yaml", 'schema_version: "2.0"\nid: ws-alpha\nname: Alpha\n');
  write(root, "scripts/ai-verse-memory/memory.py", "# compatibility-gated entrypoint\n");
  write(root, "scripts/ai-verse-memory/memory_engine.py", 'VERSION = "0.2.0"\n');
  write(root, "scripts/ai-verse-memory/os_compat.py", "# compatibility\n");
  if (entry !== null) {
    write(root, ".aiverse/extensions/registry.json", `${JSON.stringify({
      schema_version: "1.0",
      extensions: { "ai-verse-memory": entry }
    }, null, 2)}\n`);
  }
  return root;
}

function registration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ai-verse-memory",
    supported: true,
    installed: true,
    enabled: true,
    version: "0.2.0",
    engine: "scripts/ai-verse-memory/memory.py",
    ...overrides
  };
}

test("Memory detection honors an explicit OS extension disable even when engine files remain installed", () => {
  const root = fixture(registration({ enabled: false }));
  try {
    const result = detectAiVerseMemoryInstallation(root);
    assert.equal(result.status, "incompatible");
    assert.match(result.reason, /explicitly disabled/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Memory detection fails closed when a present registry omits the Memory registration", () => {
  const root = fixture(registration());
  try {
    write(root, ".aiverse/extensions/registry.json", `${JSON.stringify({ schema_version: "1.0", extensions: {} }, null, 2)}\n`);
    const result = detectAiVerseMemoryInstallation(root);
    assert.equal(result.status, "incompatible");
    assert.match(result.reason, /does not register ai-verse-memory/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Memory detection rejects registry-to-engine version or path drift", () => {
  const wrongVersion = fixture(registration({ version: "0.1.9" }));
  const wrongEngine = fixture(registration({ engine: "scripts/other-memory.py" }));
  try {
    assert.equal(detectAiVerseMemoryInstallation(wrongVersion).status, "incompatible");
    assert.match(detectAiVerseMemoryInstallation(wrongVersion).reason, /version does not match/i);
    assert.equal(detectAiVerseMemoryInstallation(wrongEngine).status, "incompatible");
    assert.match(detectAiVerseMemoryInstallation(wrongEngine).reason, /unexpected engine path/i);
  } finally {
    rmSync(wrongVersion, { recursive: true, force: true });
    rmSync(wrongEngine, { recursive: true, force: true });
  }
});

test("Memory detection accepts the current enabled registry contract and preserves legacy no-registry fixtures", () => {
  const registered = fixture(registration());
  const legacyNoRegistry = fixture(null);
  try {
    assert.equal(detectAiVerseMemoryInstallation(registered).status, "compatible");
    assert.equal(detectAiVerseMemoryInstallation(legacyNoRegistry).status, "compatible");
  } finally {
    rmSync(registered, { recursive: true, force: true });
    rmSync(legacyNoRegistry, { recursive: true, force: true });
  }
});
