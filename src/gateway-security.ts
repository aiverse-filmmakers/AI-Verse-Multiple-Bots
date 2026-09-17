import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export const DEFAULT_GATEWAY_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_GATEWAY_TOKEN_ENV = "AI_VERSE_GATEWAY_TOKEN";
export const MIN_GATEWAY_TOKEN_LENGTH = 32;

export interface GatewayOperatorSessionBinding {
  principal_id: string;
  source: "authenticated-session";
}

export interface GatewayInboundAuth {
  mode: "bearer";
  token: string;
  source: "env";
  env_name: string;
  operator_session?: GatewayOperatorSessionBinding;
}

export interface GatewayRequestAuthority {
  boundary: "local-host" | "bearer-transport";
  transport_authenticated: boolean;
  operator_authorized: boolean;
  operator_principal_id: string | null;
  authority_source: "trusted-local-host" | "transport-only" | "authenticated-session";
}

const requestAuthority = new AsyncLocalStorage<GatewayRequestAuthority>();

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

function safeOperatorPrincipalId(input: string): string {
  const value = input.trim();
  if (!/^operator_[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || value.length > 256) {
    throw new GatewaySecurityError(
      "INVALID_OPERATOR_PRINCIPAL",
      "Trusted operator session principal must be a bounded operator_* identifier"
    );
  }
  return value;
}

export function resolveGatewayBearerAuth(
  envNameInput = DEFAULT_GATEWAY_TOKEN_ENV,
  env: Record<string, string | undefined> = {}
): GatewayInboundAuth {
  const envName = safeEnvName(envNameInput);
  const token = env[envName];
  if (typeof token !== "string" || token.length < MIN_GATEWAY_TOKEN_LENGTH || token.length > 4096 || /\s/.test(token) || /[\0\r\n]/.test(token)) {
    throw new GatewaySecurityError(
      "GATEWAY_AUTH_TOKEN_REQUIRED",
      `Remote Gateway requires ${envName} to contain a whitespace-free bearer token of at least ${MIN_GATEWAY_TOKEN_LENGTH} characters`
    );
  }
  return Object.freeze({
    mode: "bearer",
    token,
    source: "env",
    env_name: envName
  });
}

/**
 * Explicitly bind a transport-authenticated Gateway session to trusted operator
 * authority. The ordinary bearer returned by resolveGatewayBearerAuth remains
 * transport-only; callers must opt in to this host/session binding.
 */
export function bindGatewayOperatorSession(
  auth: GatewayInboundAuth,
  principalId: string
): GatewayInboundAuth {
  if (auth.mode !== "bearer" || typeof auth.token !== "string" || auth.token.length < MIN_GATEWAY_TOKEN_LENGTH) {
    throw new GatewaySecurityError("INVALID_GATEWAY_AUTH", "Operator authority can only bind to a valid Gateway bearer session");
  }
  const principal = safeOperatorPrincipalId(principalId);
  return Object.freeze({
    ...auth,
    operator_session: Object.freeze({
      principal_id: principal,
      source: "authenticated-session" as const
    })
  });
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

function enterAuthority(authority: GatewayRequestAuthority): void {
  requestAuthority.enterWith(Object.freeze({ ...authority }));
}

/**
 * Transport authorization and domain authorization are deliberately separate.
 *
 * - loopback/no-bearer requests execute inside the trusted local-host boundary;
 * - a valid ordinary bearer proves transport access only;
 * - only an explicitly host-bound operator session carries operator authority.
 *
 * The request-scoped authority is overwritten for every inbound request before
 * routing, including invalid bearer attempts, so one request cannot inherit a
 * previous request's operator capability.
 */
export function authorizeGatewayRequest(header: unknown, auth: GatewayInboundAuth | undefined): boolean {
  if (!auth) {
    enterAuthority({
      boundary: "local-host",
      transport_authenticated: true,
      operator_authorized: true,
      operator_principal_id: null,
      authority_source: "trusted-local-host"
    });
    return true;
  }

  enterAuthority({
    boundary: "bearer-transport",
    transport_authenticated: false,
    operator_authorized: false,
    operator_principal_id: null,
    authority_source: "transport-only"
  });

  if (typeof header !== "string") return false;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match || !constantTimeDigestEqual(match[1]!, auth.token)) return false;

  const session = auth.operator_session;
  if (session) {
    enterAuthority({
      boundary: "bearer-transport",
      transport_authenticated: true,
      operator_authorized: true,
      operator_principal_id: safeOperatorPrincipalId(session.principal_id),
      authority_source: "authenticated-session"
    });
  } else {
    enterAuthority({
      boundary: "bearer-transport",
      transport_authenticated: true,
      operator_authorized: false,
      operator_principal_id: null,
      authority_source: "transport-only"
    });
  }
  return true;
}

export function currentGatewayRequestAuthority(): GatewayRequestAuthority | null {
  return requestAuthority.getStore() ?? null;
}

/**
 * Final domain-authority gate for operator/control mutations.
 *
 * actor_id values stored in canonical objects/events remain provenance. They are
 * not the authorization source. In-process callers have already crossed the
 * trusted host boundary; HTTP bearer callers must carry an explicit host-bound
 * operator session in the request authority context.
 */
export function assertGatewayOperatorMutationAllowed(actorId?: string): GatewayRequestAuthority {
  const claimedOperator = actorId === undefined ? null : safeOperatorPrincipalId(actorId);
  const authority = currentGatewayRequestAuthority();
  if (!authority) {
    return {
      boundary: "local-host",
      transport_authenticated: true,
      operator_authorized: true,
      operator_principal_id: null,
      authority_source: "trusted-local-host"
    };
  }
  if (!authority.operator_authorized) {
    throw new GatewaySecurityError(
      "OPERATOR_AUTHORITY_REQUIRED",
      "Gateway transport access does not grant operator/domain mutation authority. Bind an authenticated operator session before using this control.",
      403
    );
  }
  if (
    authority.boundary === "bearer-transport"
    && claimedOperator !== null
    && authority.operator_principal_id !== claimedOperator
  ) {
    throw new GatewaySecurityError(
      "OPERATOR_PRINCIPAL_MISMATCH",
      "Operator provenance must match the authenticated operator session principal.",
      403
    );
  }
  return authority;
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
