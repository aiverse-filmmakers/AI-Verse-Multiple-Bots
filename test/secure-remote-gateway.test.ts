import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { request } from "node:http";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { installAiVerseOsExtension } from "../src/ai-verse-os-install.js";
import {
  DEFAULT_GATEWAY_TOKEN_ENV,
  GatewaySecurityError
} from "../src/gateway-security.js";
import {
  planSecureRemoteGateway,
  startSecureRemoteGateway
} from "../src/secure-remote-gateway.js";
import { createGatewayServer } from "../src/server.js";
import {
  StandaloneInstallError,
  initializeStandalone
} from "../src/standalone-install.js";

const TOKEN = "phase-5-8-test-token-abcdefghijklmnopqrstuvwxyz";

function fixture(prefix: string): string {
  const root = `/tmp/${prefix}-${randomUUID()}`;
  mkdirSync(root, { recursive: true });
  return root;
}

function fakeTailscale(root: string): string {
  const path = resolve(root, "tailscale-fake");
  writeFileSync(path, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("1.99.0-test");
  process.exit(0);
}
if (args[0] === "serve") {
  console.log("Available within your tailnet:");
  console.log("https://phase-5-8-test.example.ts.net");
  const timer = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
  process.on("SIGINT", () => { clearInterval(timer); process.exit(0); });
} else {
  process.exit(2);
}
`, { encoding: "utf8", mode: 0o755 });
  return path;
}

function osFixture(): string {
  const root = fixture("ai-verse-secure-remote-os");
  mkdirSync(resolve(root, "operator"), { recursive: true });
  mkdirSync(resolve(root, "workspaces"), { recursive: true });
  mkdirSync(resolve(root, "system", "extensions"), { recursive: true });
  writeFileSync(resolve(root, "AI-VERSE.yaml"), 'schema_version: "2.0"\narchitecture: unified-workspace\n', "utf8");
  writeFileSync(resolve(root, "AGENTS.md"), "# Runtime contract\nLoad .aiverse/extensions/registry.json when present.\n", "utf8");
  writeFileSync(resolve(root, "system", "extensions", "README.md"), "# Local extensions\nRegistry: .aiverse/extensions/registry.json\n", "utf8");
  return root;
}

function httpJson(
  port: number,
  path: string,
  token?: string
): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const req = request({
      host: "127.0.0.1",
      port,
      path,
      method: "GET",
      headers
    }, (res: any) => {
      const chunks: string[] = [];
      res.on("data", (chunk: unknown) => chunks.push(String(chunk)));
      res.on("end", () => {
        resolvePromise({
          status: Number(res.statusCode ?? 0),
          body: JSON.parse(chunks.join("") || "{}"),
          headers: res.headers ?? {}
        });
      });
    });
    req.on("error", rejectPromise);
    req.end();
  });
}

test("Phase 5.8 rejects direct non-loopback HTTP exposure and standalone non-loopback config", () => {
  assert.throws(
    () => createGatewayServer({ host: "0.0.0.0", port: 0, dbPath: ":memory:" }),
    (error: unknown) => error instanceof GatewaySecurityError
      && error.code === "DIRECT_REMOTE_BIND_FORBIDDEN"
  );

  const root = fixture("ai-verse-secure-remote-standalone-bind");
  try {
    assert.throws(
      () => initializeStandalone(root, { host: "0.0.0.0", port: 8787 }),
      (error: unknown) => error instanceof StandaloneInstallError
        && error.code === "DIRECT_REMOTE_BIND_FORBIDDEN"
    );
    assert.equal(existsSync(resolve(root, ".ai-verse-bots", "config.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.8 remote plan is read-only, secret-redacted, and fails closed without auth/provider", () => {
  const root = fixture("ai-verse-secure-remote-plan");
  try {
    initializeStandalone(root, { port: 0 });
    const tailscale = fakeTailscale(root);

    const missingAuth = planSecureRemoteGateway({
      mode: "standalone",
      root,
      localPort: 0,
      tailscaleBin: tailscale,
      env: { PATH: process.env.PATH }
    });
    assert.equal(missingAuth.transport.provider_available, true);
    assert.equal(missingAuth.auth.configured, false);
    assert.equal(missingAuth.can_start, false);
    assert.match(missingAuth.blocked_reasons.join(" "), /bearer token/i);

    const unavailable = planSecureRemoteGateway({
      mode: "standalone",
      root,
      localPort: 0,
      tailscaleBin: resolve(root, "missing-tailscale"),
      env: {
        PATH: process.env.PATH,
        [DEFAULT_GATEWAY_TOKEN_ENV]: TOKEN
      }
    });
    assert.equal(unavailable.auth.configured, true);
    assert.equal(unavailable.transport.provider_available, false);
    assert.equal(unavailable.can_start, false);

    const ready = planSecureRemoteGateway({
      mode: "standalone",
      root,
      localPort: 0,
      tailscaleBin: tailscale,
      env: {
        PATH: process.env.PATH,
        [DEFAULT_GATEWAY_TOKEN_ENV]: TOKEN
      }
    });
    assert.equal(ready.can_start, true);
    assert.equal(ready.local_host, "127.0.0.1");
    assert.equal(ready.transport.exposure, "tailnet-only");
    assert.equal(ready.transport.tls_terminated_by, "tailscale-serve");
    assert.equal(ready.transport.direct_non_loopback_bind, false);
    assert.equal(ready.auth.env_name, DEFAULT_GATEWAY_TOKEN_ENV);
    assert.equal(JSON.stringify(ready).includes(TOKEN), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.8 secure remote runtime requires bearer auth behind the loopback Tailscale transport", async () => {
  const root = fixture("ai-verse-secure-remote-runtime");
  try {
    initializeStandalone(root, { port: 0 });
    const tailscale = fakeTailscale(root);
    const runtime = await startSecureRemoteGateway({
      mode: "standalone",
      root,
      localPort: 0,
      tailscaleBin: tailscale,
      env: {
        PATH: process.env.PATH,
        [DEFAULT_GATEWAY_TOKEN_ENV]: TOKEN
      }
    });

    try {
      assert.equal(runtime.local.host, "127.0.0.1");
      assert.match(runtime.remote.url, /^https:\/\//);
      assert.equal(runtime.remote.provider, "tailscale-serve");
      assert.equal(runtime.remote.auth_env, DEFAULT_GATEWAY_TOKEN_ENV);
      assert.equal(JSON.stringify(runtime.remote).includes(TOKEN), false);

      const missing = await httpJson(runtime.local.port, "/health");
      assert.equal(missing.status, 401);
      assert.equal(missing.body.error, "UNAUTHORIZED");
      assert.match(String(missing.headers["www-authenticate"]), /Bearer/);

      const wrong = await httpJson(runtime.local.port, "/health", `${TOKEN}-wrong`);
      assert.equal(wrong.status, 401);

      const valid = await httpJson(runtime.local.port, "/health", TOKEN);
      assert.equal(valid.status, 200);
      assert.equal(valid.body.ok, true);
      assert.equal(valid.headers["x-content-type-options"], "nosniff");
      assert.equal(valid.headers["referrer-policy"], "no-referrer");
      assert.equal(valid.headers["cache-control"], "no-store");
    } finally {
      await runtime.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5.8 AI-Verse OS remote planning uses the same loopback/authenticated HTTPS boundary", () => {
  const root = osFixture();
  try {
    installAiVerseOsExtension(root);
    const tailscale = fakeTailscale(root);
    const plan = planSecureRemoteGateway({
      mode: "os",
      root,
      localPort: 0,
      tailscaleBin: tailscale,
      env: {
        PATH: process.env.PATH,
        [DEFAULT_GATEWAY_TOKEN_ENV]: TOKEN
      }
    });

    assert.equal(plan.mode, "ai-verse-os");
    assert.equal(plan.health_state, "ready");
    assert.equal(plan.can_start, true);
    assert.equal(plan.database, resolve(root, "runtime", "ai-verse-bots", "coordination.db"));
    assert.equal(plan.local_host, "127.0.0.1");
    assert.equal(plan.transport.exposure, "tailnet-only");
    assert.equal(JSON.stringify(plan).includes(TOKEN), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
