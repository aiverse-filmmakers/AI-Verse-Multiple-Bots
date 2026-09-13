import { createHash } from "node:crypto";

export const DEFAULT_GATEWAY_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_GATEWAY_TOKEN_ENV = "AI_VERSE_GATEWAY_TOKEN";
export const MIN_GATEWAY_TOKEN_LENGTH = 32;

export interface GatewayInboundAuth {
  mode: "bearer";
  token: string;
  source: "env";
  env_name: string;
}

export class GatewaySecurityError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "GatewaySecurityError";
  }
}

export function isLoopbackHost(input: string): boolean {
  const host = input.trim().toLowerCase();
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((value) => value >= 0 && value <= 255) && octets[0] === 127;
}

export function assertLoopbackGatewayHost(host: string): string {
  const normalized = host.trim();
  if (!normalized) {
    throw new GatewaySecurityError("GATEWAY_HOST_REQUIRED", "Gateway host must be a non-empty loopback host");
  }
  if (!isLoopbackHost(normalized)) {
    throw new GatewaySecurityError(
      "DIRECT_REMOTE_BIND_FORBIDDEN",
      "Direct non-loopback HTTP binding is forbidden. Keep the Gateway on loopback and use the secure remote transport."
    );
  }
  return normalized;
}

function safeEnvName(input: string): string {
  const value = input.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new GatewaySecurityError("INVALID_GATEWAY_AUTH_ENV", "Gateway auth env name must be a valid environment variable name");
  }
  return value;
}

export function resolveGatewayBearerAuth(
  envNameInput = DEFAULT_GATEWAY_TOKEN_ENV,
  env: Record<string, string | undefined> = {}
): GatewayInboundAuth {
  const envName = safeEnvName(envNameInput);
  const token = env[envName];
  if (typeof token !== "string" || token.length < MIN_GATEWAY_TOKEN_LENGTH || token.length > 4096 || /[\0\r\n]/.test(token)) {
    throw new GatewaySecurityError(
      "GATEWAY_AUTH_TOKEN_REQUIRED",
      `Remote Gateway requires ${envName} to contain a non-empty bearer token of at least ${MIN_GATEWAY_TOKEN_LENGTH} characters`
    );
  }
  return {
    mode: "bearer",
    token,
    source: "env",
    env_name: envName
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeDigestEqual(left: string, right: string): boolean {
  const a = digest(left);
  const b = digest(right);
  let different = 0;
  for (let index = 0; index < a.length; index += 1) {
    different |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return different === 0;
}

export function authorizeGatewayRequest(header: unknown, auth: GatewayInboundAuth | undefined): boolean {
  if (!auth) return true;
  if (typeof header !== "string") return false;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match) return false;
  return constantTimeDigestEqual(match[1]!, auth.token);
}

export function gatewaySecurityHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "permissions-policy": "camera=(), microphone=(), geolocation=()"
  };
}
