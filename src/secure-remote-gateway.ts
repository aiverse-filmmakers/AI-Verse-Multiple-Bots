import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { findAiVerseOsRoot } from "./ai-verse-os-registration.js";
import {
  DEFAULT_GATEWAY_TOKEN_ENV,
  GatewaySecurityError,
  resolveGatewayBearerAuth
} from "./gateway-security.js";
import { doctorProduction, type ProductionHealthMode } from "./production-health.js";
import {
  findStandaloneRoot,
  readStandaloneInstallation
} from "./standalone-install.js";
import { createGatewayServer } from "./server.js";

export const REMOTE_GATEWAY_PROVIDER = "tailscale-serve";
export const DEFAULT_REMOTE_HTTPS_PORT = 443;

export interface SecureRemoteGatewayOptions {
  mode?: string;
  root?: string;
  cwd?: string;
  authEnv?: string;
  httpsPort?: number;
  localPort?: number;
  tailscaleBin?: string;
  env?: Record<string, string | undefined>;
}

export interface SecureRemoteGatewayPlan {
  provider: typeof REMOTE_GATEWAY_PROVIDER;
  mode: ProductionHealthMode;
  root: string;
  database: string | null;
  local_host: "127.0.0.1";
  local_port: number;
  https_port: number;
  auth: {
    mode: "bearer";
    source: "env";
    env_name: string;
    configured: boolean;
  };
  transport: {
    provider_available: boolean;
    tailnet_connected: boolean;
    executable: string;
    tls_terminated_by: "tailscale-serve";
    exposure: "tailnet-only";
    direct_non_loopback_bind: false;
  };
  health_state: string;
  can_start: boolean;
  blocked_reasons: string[];
  mutates_transport_on_start_only: true;
}

export interface SecureRemoteGatewayRuntime {
  plan: SecureRemoteGatewayPlan;
  local: {
    host: string;
    port: number;
    url: string;
  };
  remote: {
    provider: typeof REMOTE_GATEWAY_PROVIDER;
    url: string;
    https_port: number;
    auth_env: string;
  };
  close(): Promise<void>;
}

export class SecureRemoteGatewayError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SecureRemoteGatewayError";
  }
}

function parseMode(input: string | undefined): ProductionHealthMode | null {
  if (input === undefined) return null;
  const value = input.trim().toLowerCase();
  if (value === "standalone") return "standalone";
  if (value === "os" || value === "ai-verse-os" || value === "aiverse-os") return "ai-verse-os";
  throw new SecureRemoteGatewayError(
    "INVALID_REMOTE_MODE",
    `Unsupported remote Gateway mode '${input}'. Use standalone or os.`
  );
}

function selectInstallation(options: SecureRemoteGatewayOptions): {
  mode: ProductionHealthMode;
  root: string;
} {
  const cwd = resolve(options.cwd ?? ".");
  const explicit = parseMode(options.mode);
  if (explicit) {
    if (options.root) return { mode: explicit, root: resolve(options.root) };
    if (explicit === "standalone") {
      return { mode: explicit, root: findStandaloneRoot(cwd) ?? cwd };
    }
    return { mode: explicit, root: findAiVerseOsRoot(cwd) ?? cwd };
  }

  const start = options.root ? resolve(options.root) : cwd;
  const standalone = findStandaloneRoot(start);
  const os = findAiVerseOsRoot(start);
  if (standalone && os) {
    throw new SecureRemoteGatewayError(
      "REMOTE_MODE_AMBIGUOUS",
      "Both standalone and AI-Verse OS installations are discoverable; pass --mode explicitly."
    );
  }
  if (standalone) return { mode: "standalone", root: standalone };
  if (os) return { mode: "ai-verse-os", root: os };
  throw new SecureRemoteGatewayError(
    "REMOTE_INSTALLATION_NOT_FOUND",
    "No configured Multiple Bots installation is discoverable. Run setup before remote serve."
  );
}

function validPort(value: number, label: string, allowZero: boolean): number {
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < min || value > 65535) {
    throw new SecureRemoteGatewayError(
      "INVALID_REMOTE_PORT",
      `${label} must be an integer between ${min} and 65535`
    );
  }
  return value;
}

function tailscaleProbe(bin: string, env: Record<string, string | undefined>): {
  available: boolean;
  connected: boolean;
} {
  const effectiveEnv = { ...process.env, ...env };
  const version = spawnSync(bin, ["version"], {
    encoding: "utf8",
    env: effectiveEnv,
    shell: false
  });
  if (version.status !== 0) return { available: false, connected: false };

  const status = spawnSync(bin, ["status", "--json"], {
    encoding: "utf8",
    env: effectiveEnv,
    shell: false
  });
  if (status.status !== 0) return { available: true, connected: false };
  try {
    const parsed = JSON.parse(String(status.stdout ?? "{}")) as Record<string, unknown>;
    return { available: true, connected: parsed.BackendState === "Running" };
  } catch {
    return { available: true, connected: false };
  }
}

function tokenConfigured(envName: string, env: Record<string, string | undefined>): boolean {
  try {
    resolveGatewayBearerAuth(envName, env);
    return true;
  } catch {
    return false;
  }
}

function configuredLocalPort(mode: ProductionHealthMode, root: string): number {
  if (mode === "standalone") {
    return readStandaloneInstallation(root).config.gateway.port;
  }
  return 8787;
}

export function planSecureRemoteGateway(options: SecureRemoteGatewayOptions = {}): SecureRemoteGatewayPlan {
  const selection = selectInstallation(options);
  const env = options.env ?? process.env as Record<string, string | undefined>;
  const authEnv = options.authEnv ?? DEFAULT_GATEWAY_TOKEN_ENV;
  const httpsPort = validPort(options.httpsPort ?? DEFAULT_REMOTE_HTTPS_PORT, "Remote HTTPS port", false);
  const localPort = validPort(
    options.localPort ?? configuredLocalPort(selection.mode, selection.root),
    "Local Gateway port",
    true
  );
  const tailscaleBin = options.tailscaleBin ?? "tailscale";
  const health = doctorProduction({
    mode: selection.mode,
    root: selection.root,
    cwd: options.cwd ?? process.cwd(),
    env
  });
  const configured = tokenConfigured(authEnv, env);
  const provider = tailscaleProbe(tailscaleBin, env);
  const blocked: string[] = [];

  if (!health.ready) blocked.push(`component health state is '${health.state}', not ready`);
  if (!configured) {
    blocked.push(
      `bearer token is missing/invalid in ${authEnv}; configure at least 32 characters without storing it in project config`
    );
  }
  if (!provider.available) blocked.push(`Tailscale CLI is unavailable at '${tailscaleBin}'`);
  else if (!provider.connected) blocked.push("Tailscale is installed but the local daemon is not connected to a tailnet");

  return {
    provider: REMOTE_GATEWAY_PROVIDER,
    mode: selection.mode,
    root: selection.root,
    database: health.database,
    local_host: "127.0.0.1",
    local_port: localPort,
    https_port: httpsPort,
    auth: {
      mode: "bearer",
      source: "env",
      env_name: authEnv,
      configured
    },
    transport: {
      provider_available: provider.available,
      tailnet_connected: provider.connected,
      executable: tailscaleBin,
      tls_terminated_by: "tailscale-serve",
      exposure: "tailnet-only",
      direct_non_loopback_bind: false
    },
    health_state: health.state,
    can_start: blocked.length === 0,
    blocked_reasons: blocked,
    mutates_transport_on_start_only: true
  };
}

function remoteUrlFromOutput(output: string): string | null {
  const matches = output.match(/https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?/g) ?? [];
  return matches.length > 0 ? matches[0]! : null;
}

function waitForTailscaleServe(child: any): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    let settled = false;

    const settleFromOutput = (chunk: unknown) => {
      if (settled) return;
      output += String(chunk);
      const url = remoteUrlFromOutput(output);
      if (url) {
        settled = true;
        clearTimeout(timeout);
        resolvePromise(url.replace(/[),.;]+$/, ""));
      }
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPromise(new SecureRemoteGatewayError(
        "TAILSCALE_SERVE_NOT_READY",
        "Tailscale Serve did not publish a tailnet HTTPS URL"
      ));
    }, 15_000);

    child.stdout?.on("data", settleFromOutput);
    child.stderr?.on("data", settleFromOutput);
    child.once("error", (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(new SecureRemoteGatewayError(
        "TAILSCALE_SERVE_START_FAILED",
        error instanceof Error ? error.message : String(error)
      ));
    });
    child.once("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(new SecureRemoteGatewayError(
        "TAILSCALE_SERVE_EXITED",
        `Tailscale Serve exited before becoming ready (code ${String(code)})`
      ));
    });
  });
}

export async function startSecureRemoteGateway(
  options: SecureRemoteGatewayOptions = {}
): Promise<SecureRemoteGatewayRuntime> {
  const plan = planSecureRemoteGateway(options);
  if (!plan.can_start) {
    throw new SecureRemoteGatewayError(
      "REMOTE_GATEWAY_PREFLIGHT_FAILED",
      plan.blocked_reasons.join("; ")
    );
  }

  const env = options.env ?? process.env as Record<string, string | undefined>;
  const auth = resolveGatewayBearerAuth(plan.auth.env_name, env);
  const service = createGatewayServer({
    host: plan.local_host,
    port: plan.local_port,
    dbPath: plan.database ?? undefined,
    ...(plan.mode === "ai-verse-os"
      ? { aiVerseOsRoot: plan.root }
      : { standaloneRoot: plan.root }),
    inboundAuth: auth
  });

  const address = await service.listen();
  const target = `http://127.0.0.1:${address.port}`;
  const child = spawn(
    plan.transport.executable,
    ["serve", "--yes", `--https=${plan.https_port}`, target],
    {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    }
  );

  let remoteUrl: string;
  try {
    remoteUrl = await waitForTailscaleServe(child);
  } catch (error) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort cleanup of the explicitly started foreground transport.
    }
    await service.close().catch(() => undefined);
    throw error;
  }

  let closing = false;
  child.once("close", () => {
    if (closing) return;
    closing = true;
    void service.close().catch(() => undefined);
  });

  return {
    plan,
    local: {
      host: address.host,
      port: address.port,
      url: `http://${address.host}:${address.port}`
    },
    remote: {
      provider: REMOTE_GATEWAY_PROVIDER,
      url: remoteUrl,
      https_port: plan.https_port,
      auth_env: plan.auth.env_name
    },
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Foreground Tailscale claim is already gone.
      }
      await service.close();
    }
  };
}
