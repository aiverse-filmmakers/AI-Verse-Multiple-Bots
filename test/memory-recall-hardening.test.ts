import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  AiVerseMemoryRecallError,
  AiVerseMemoryRecallSource,
  detectAiVerseMemoryInstallation
} from "../src/ai-verse-memory-recall.js";

function write(root: string, relative: string, content: string): void {
  const path = resolve(root, ...relative.split("/"));
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(resolve(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8" });
}

function prefixedSha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function nativeHostFixture(withMemory = true): string {
  const root = `/tmp/ai-verse-memory-hardening-${randomUUID()}`;
  mkdirSync(resolve(root, "operator"), { recursive: true });
  mkdirSync(resolve(root, "workspaces/ws-alpha"), { recursive: true });
  write(root, "AI-VERSE.yaml", [
    'schema_version: "2.0"',
    "architecture: unified-workspace",
    "paths:",
    "  workspaces: workspaces/",
    ""
  ].join("\n"));
  write(root, "AGENTS.md", "# Runtime\nLoad .aiverse/extensions/registry.json when present.\n");
  write(root, "system/extensions/README.md", "# Extensions\nRegistry: .aiverse/extensions/registry.json\n");
  write(root, "workspaces/ws-alpha/WORKSPACE.yaml", [
    'schema_version: "2.0"',
    'id: "ws-alpha"',
    'name: "Memory Hardening Workspace"',
    'type: "project"',
    'status: "active"',
    'purpose: "Test strict Memory ownership boundaries."',
    'current_context: "context/CURRENT.md"',
    ""
  ].join("\n"));
  if (withMemory) {
    write(root, "scripts/ai-verse-memory/memory.py", "# compatibility-gated entrypoint\n");
    write(root, "scripts/ai-verse-memory/memory_engine.py", 'VERSION = "0.2.0"\n');
    write(root, "scripts/ai-verse-memory/os_compat.py", "# compatibility\n");
  }
  return root;
}

function forgedExecResponse(item: Record<string, unknown>) {
  return ((_: string, __: string[], ___: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    callback(null, JSON.stringify({
      provider: "ai-verse-memory",
      provider_version: "0.2.0",
      mode: "ai-verse-os-v2",
      workspace_id: "ws-alpha",
      items: [item]
    }), "");
  }) as any;
}

test("Memory recall rejects same-workspace files outside canonical Memory source roots even with forged matching provenance", async () => {
  const root = nativeHostFixture();
  const path = "workspaces/ws-alpha/private/secret.md";
  const content = "This file is inside the workspace but is not an authorized Memory recall source.\n";
  write(root, path, content);
  try {
    const source = new AiVerseMemoryRecallSource(root, {
      execFileImpl: forgedExecResponse({
        id: "forged-memory",
        kind: "memory",
        path,
        type: "fact",
        scope: "workspace:ws-alpha",
        status: "active",
        text: "forged secret",
        why: "",
        source_identity: prefixedSha256(`memory\nworkspace:ws-alpha\n${path}`),
        source_version: prefixedSha256(content),
        freshness: "historical",
        indexed_at: "2026-09-10T12:00:00+00:00"
      })
    });

    await assert.rejects(
      source.recall("ws-alpha", { query: "secret", limit: 1 }),
      (error: unknown) => error instanceof AiVerseMemoryRecallError
        && error.code === "MEMORY_SCOPE_VIOLATION"
        && /outside canonical/i.test(error.message)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Memory recall rejects a canonical path whose reported kind does not match path ownership", async () => {
  const root = nativeHostFixture();
  const path = "workspaces/ws-alpha/context/CURRENT.md";
  const content = "# Current\n\nCanonical current context.\n";
  write(root, path, content);
  try {
    const source = new AiVerseMemoryRecallSource(root, {
      execFileImpl: forgedExecResponse({
        id: "forged-kind",
        kind: "memory",
        path,
        type: "fact",
        scope: "workspace:ws-alpha",
        status: "active",
        text: "mislabelled context",
        why: "",
        source_identity: prefixedSha256(`memory\nworkspace:ws-alpha\n${path}`),
        source_version: prefixedSha256(content),
        freshness: "historical",
        indexed_at: "2026-09-10T12:00:00+00:00"
      })
    });

    await assert.rejects(
      source.recall("ws-alpha", { query: "context", limit: 1 }),
      (error: unknown) => error instanceof AiVerseMemoryRecallError
        && error.code === "MEMORY_PROVENANCE_INVALID"
        && /canonically/i.test(error.message)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Memory installation rejects a symlinked parent directory before any engine code can execute", { skip: process.platform === "win32" }, () => {
  const root = nativeHostFixture(false);
  const external = `/tmp/ai-verse-memory-hardening-external-${randomUUID()}`;
  mkdirSync(external, { recursive: true });
  write(external, "memory.py", "# external entrypoint\n");
  write(external, "memory_engine.py", 'VERSION = "0.2.0"\n');
  write(external, "os_compat.py", "# external compatibility\n");
  mkdirSync(resolve(root, "scripts"), { recursive: true });
  symlinkSync(external, resolve(root, "scripts/ai-verse-memory"), "dir");
  try {
    const installation = detectAiVerseMemoryInstallation(root);
    assert.equal(installation.status, "incompatible");
    assert.match(installation.reason, /symlink/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
