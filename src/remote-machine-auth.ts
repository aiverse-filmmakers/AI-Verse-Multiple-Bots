import type { JsonObject } from "./types.js";

export type RemotePeerIdentityKind =
  | "https_origin"
  | "tls_spki_sha256"
  | "tls_cert_sha256"
  | "spiffe_id"
  | "custom";

export interface RemotePeerIdentity {
  kind: RemotePeerIdentityKind;
  value: string;
}

export interface RemoteMachineIdentity {
  id: string;
  origin: string;
  expected_peer_identity: RemotePeerIdentity;
}

export interface RemoteAuthBinding {
  provider: string;
  credential_ref: string;
}

export interface RemoteSecurityRequirement {
  schemes: Record<string, string[]>;
}

export interface RemoteHttpRequest {
  machineRef: string;
  auth?: RemoteAuthBinding | null;
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  securitySchemes?: JsonObject;
  securityRequirements?: RemoteSecurityRequirement[];
  signal?: AbortSignal;
}

export interface RemoteAuthenticationEvidence {
  machine_id: string;
  origin: string;
  tls_verified: boolean;
  peer_identity: RemotePeerIdentity;
  client_authenticated: boolean;
  satisfied_schemes: string[];
  mechanism: string;
}

export interface RemoteAuthenticatedHttpResult {
  response: Response;
  evidence: RemoteAuthenticationEvidence;
}

export interface RemoteAuthenticatorRequest {
  machine: RemoteMachineIdentity;
  credentialRef: string | null;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  securitySchemes: JsonObject;
  securityRequirements: RemoteSecurityRequirement[];
  signal?: AbortSignal;
}

export interface RemoteHttpAuthenticator {
  readonly id: string;
  request(input: RemoteAuthenticatorRequest): Promise<RemoteAuthenticatedHttpResult>;
}

export interface RemoteCredentialMaterial {
  kind: "bearer" | "api_key";
  value: string;
}

export interface RemoteCredentialResolver {
  resolve(credentialRef: string): Promise<RemoteCredentialMaterial>;
}

export class RemoteMachineAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteMachineAuthError";
  }
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function safeString(value: unknown, label: string, max = 1024): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RemoteMachineAuthError("REMOTE_AUTH_INVALID_CONFIG", `${label} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > max || /[\0\r\n]/.test(result)) {
    throw new RemoteMachineAuthError("REMOTE_AUTH_INVALID_CONFIG", `${label} is invalid or too long`);
  }
  return result;
}

function exactHttpsOrigin(value: unknown, label: string): string {
  const text = safeString(value, label, 2048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RemoteMachineAuthError("REMOTE_AUTH_INVALID_ORIGIN", `${label} must be a valid HTTPS origin`);
  }
  if (url.protocol !== "https:") {
    throw new RemoteMachineAuthError("REMOTE_AUTH_HTTPS_REQUIRED", `${label} must use HTTPS`);
  }
  if (url.username || url.password) {
    throw new RemoteMachineAuthError("REMOTE_AUTH_CREDENTIALS_FORBIDDEN", `${label} must not embed credentials`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new RemoteMachineAuthError("REMOTE_AUTH_INVALID_ORIGIN", `${label} must be an origin without path, query or fragment`);
  }
  return url.origin;
}

function requestUrl(value: unknown, expectedOrigin: string): string {
  const text = safeString(value, "remote request url", 4096);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RemoteMachineAuthError("REMOTE_AUTH_INVALID_URL", "Remote request URL is invalid");
  }
  if (url.protocol !== "https:") {
    throw new RemoteMachineAuthError("REMOTE_AUTH_HTTPS_REQUIRED", "Authenticated remote requests must use HTTPS");
  }
  if (url.username || url.password) {
    throw new RemoteMachineAuthError("REMOTE_AUTH_CREDENTIALS_FORBIDDEN", "Remote request URLs must not embed credentials");
  }
  if (url.origin !== expectedOrigin) {
    throw new RemoteMachineAuthError(
      "REMOTE_AUTH_ORIGIN_MISMATCH",
      `Remote request origin ${url.origin} does not match pinned machine origin ${expectedOrigin}`
    );
  }
  return url.toString();
}

function safePeerIdentity(identity: RemotePeerIdentity, label: string): RemotePeerIdentity {
  const kind = safeString(identity?.kind, `${label}.kind`, 64) as RemotePeerIdentityKind;
  if (!["https_origin", "tls_spki_sha256", "tls_cert_sha256", "spiffe_id", "custom"].includes(kind)) {
    throw new RemoteMachineAuthError("REMOTE_AUTH_INVALID_IDENTITY", `${label}.kind is unsupported`);
  }
  const value = safeString(identity?.value, `${label}.value`, 2048);
  if (kind === "https_origin") {
    return { kind, value: exactHttpsOrigin(value, `${label}.value`) };
  }
  return { kind, value };
}

function requirementScopes(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === "string")) return null;
    return [...new Set(value.map(String))].sort();
  }
  const object = asObject(value);
  if (object && Array.isArray(object.list) && object.list.every((entry) => typeof entry === "string")) {
    return [...new Set(object.list.map(String))].sort();
  }
  return null;
}

export function normalizeRemoteSecurityRequirements(value: unknown): RemoteSecurityRequirement[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RemoteMachineAuthError("REMOTE_AUTH_INVALID_REQUIREMENTS", "securityRequirements must be an array");
  }
  const requirements: RemoteSecurityRequirement[] = [];
  for (const raw of value) {
    const object = asObject(raw);
    if (!object) throw new RemoteMachineAuthError("REMOTE_AUTH_INVALID_REQUIREMENTS", "securityRequirements entries must be objects");
    const schemesObject = asObject(object.schemes) ?? object;
    const schemes: Record<string, string[]> = {};
    for (const [name, scopesValue] of Object.entries(schemesObject)) {
      if (name === "schemes" && schemesObject === object) continue;
      const normalizedName = safeString(name, "security scheme name", 256);
      const scopes = requirementScopes(scopesValue);
      if (scopes === null) {
        throw new RemoteMachineAuthError(
          "REMOTE_AUTH_INVALID_REQUIREMENTS",
          `Security requirement ${normalizedName} must declare an array of scopes`
        );
      }
      schemes[normalizedName] = scopes;
    }
    if (Object.keys(schemes).length === 0) {
      throw new RemoteMachineAuthError("REMOTE_AUTH_INVALID_REQUIREMENTS", "Security requirement cannot be empty");
    }
    requirements.push({ schemes });
  }
  return requirements;
}

function validateSecuritySchemeReferences(
  securitySchemes: JsonObject,
  requirements: RemoteSecurityRequirement[]
): void {
  for (const requirement of requirements) {
    for (const schemeName of Object.keys(requirement.schemes)) {
      if (!asObject(securitySchemes[schemeName])) {
        throw new RemoteMachineAuthError(
          "REMOTE_AUTH_UNKNOWN_SCHEME",
          `Security requirement references undeclared scheme ${schemeName}`
        );
      }
    }
  }
}

function satisfiesRequirement(evidence: RemoteAuthenticationEvidence, requirements: RemoteSecurityRequirement[]): boolean {
  if (requirements.length === 0) return true;
  const satisfied = new Set(evidence.satisfied_schemes);
  return requirements.some((requirement) => Object.keys(requirement.schemes).every((name) => satisfied.has(name)));
}

export class RemoteMachineIdentityRegistry {
  private readonly machines = new Map<string, RemoteMachineIdentity>();

  constructor(machines: RemoteMachineIdentity[] = []) {
    for (const machine of machines) this.register(machine);
  }

  register(machine: RemoteMachineIdentity): this {
    const id = safeString(machine.id, "remote machine id", 256);
    if (this.machines.has(id)) {
      throw new RemoteMachineAuthError("REMOTE_MACHINE_ID_COLLISION", `Remote machine ${id} is already registered`);
    }
    const origin = exactHttpsOrigin(machine.origin, `remote machine ${id} origin`);
    const expectedPeerIdentity = safePeerIdentity(machine.expected_peer_identity, `remote machine ${id} expected_peer_identity`);
    for (const existing of this.machines.values()) {
      if (existing.origin === origin && (
        existing.expected_peer_identity.kind !== expectedPeerIdentity.kind
        || existing.expected_peer_identity.value !== expectedPeerIdentity.value
      )) {
        throw new RemoteMachineAuthError(
          "REMOTE_MACHINE_ORIGIN_CONFLICT",
          `Remote origin ${origin} is already pinned to a different peer identity`
        );
      }
    }
    this.machines.set(id, {
      id,
      origin,
      expected_peer_identity: expectedPeerIdentity
    });
    return this;
  }

  get(id: string): RemoteMachineIdentity {
    const machine = this.machines.get(id);
    if (!machine) throw new RemoteMachineAuthError("REMOTE_MACHINE_NOT_REGISTERED", `Remote machine ${id} is not registered`);
    return machine;
  }

  has(id: string): boolean {
    return this.machines.has(id);
  }

  ids(): string[] {
    return [...this.machines.keys()].sort();
  }
}

export class RemoteHttpAuthenticatorRegistry {
  private readonly authenticators = new Map<string, RemoteHttpAuthenticator>();

  constructor(authenticators: RemoteHttpAuthenticator[] = []) {
    for (const authenticator of authenticators) this.register(authenticator);
  }

  register(authenticator: RemoteHttpAuthenticator): this {
    const id = safeString(authenticator.id, "remote authenticator id", 256);
    if (this.authenticators.has(id)) {
      throw new RemoteMachineAuthError("REMOTE_AUTH_PROVIDER_COLLISION", `Remote authenticator ${id} is already registered`);
    }
    this.authenticators.set(id, authenticator);
    return this;
  }

  get(id: string): RemoteHttpAuthenticator {
    const authenticator = this.authenticators.get(id);
    if (!authenticator) {
      throw new RemoteMachineAuthError("REMOTE_AUTH_PROVIDER_NOT_REGISTERED", `Remote authenticator ${id} is not registered`);
    }
    return authenticator;
  }

  has(id: string): boolean {
    return this.authenticators.has(id);
  }

  ids(): string[] {
    return [...this.authenticators.keys()].sort();
  }
}

export interface RemoteHttpAccessBrokerOptions {
  fetchImpl?: typeof fetch;
}

export class RemoteHttpAccessBroker {
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly machines: RemoteMachineIdentityRegistry = new RemoteMachineIdentityRegistry(),
    readonly authenticators: RemoteHttpAuthenticatorRegistry = new RemoteHttpAuthenticatorRegistry(),
    options: RemoteHttpAccessBrokerOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(input: RemoteHttpRequest): Promise<RemoteAuthenticatedHttpResult> {
    const machine = this.machines.get(safeString(input.machineRef, "machineRef", 256));
    const url = requestUrl(input.url, machine.origin);
    const method = safeString(input.method, "remote request method", 16).toUpperCase();
    const requirements = input.securityRequirements ?? [];
    const securitySchemes = input.securitySchemes ?? {};
    validateSecuritySchemeReferences(securitySchemes, requirements);

    let result: RemoteAuthenticatedHttpResult;
    if (input.auth) {
      const providerId = safeString(input.auth.provider, "remote auth provider", 256);
      const credentialRef = safeString(input.auth.credential_ref, "remote credential_ref", 1024);
      const authenticator = this.authenticators.get(providerId);
      result = await authenticator.request({
        machine,
        credentialRef,
        url,
        method,
        headers: input.headers ?? {},
        ...(input.body !== undefined ? { body: input.body } : {}),
        securitySchemes,
        securityRequirements: requirements,
        ...(input.signal ? { signal: input.signal } : {})
      });
    } else if (requirements.length > 0) {
      throw new RemoteMachineAuthError(
        "REMOTE_AUTH_BINDING_REQUIRED",
        `Remote machine ${machine.id} requires authentication but no auth binding was supplied`
      );
    } else {
      if (machine.expected_peer_identity.kind !== "https_origin") {
        throw new RemoteMachineAuthError(
          "REMOTE_AUTH_STRONG_IDENTITY_PROVIDER_REQUIRED",
          `Remote machine ${machine.id} requires a transport authenticator capable of attesting ${machine.expected_peer_identity.kind}`
        );
      }
      const response = await this.fetchImpl(url, {
        method,
        headers: input.headers ?? {},
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        redirect: "error"
      });
      result = {
        response,
        evidence: {
          machine_id: machine.id,
          origin: machine.origin,
          tls_verified: true,
          peer_identity: { kind: "https_origin", value: machine.origin },
          client_authenticated: false,
          satisfied_schemes: [],
          mechanism: "https-ca"
        }
      };
    }

    this.assertEvidence(machine, result.evidence, requirements);
    return result;
  }

  private assertEvidence(
    machine: RemoteMachineIdentity,
    evidence: RemoteAuthenticationEvidence,
    requirements: RemoteSecurityRequirement[]
  ): void {
    if (evidence.machine_id !== machine.id) {
      throw new RemoteMachineAuthError("REMOTE_AUTH_MACHINE_MISMATCH", "Remote authentication evidence identifies a different machine");
    }
    if (evidence.origin !== machine.origin) {
      throw new RemoteMachineAuthError("REMOTE_AUTH_ORIGIN_MISMATCH", "Remote authentication evidence identifies a different origin");
    }
    if (evidence.tls_verified !== true) {
      throw new RemoteMachineAuthError("REMOTE_AUTH_TLS_UNVERIFIED", "Remote authenticated transport did not verify TLS server identity");
    }
    const peer = safePeerIdentity(evidence.peer_identity, "remote authentication evidence peer_identity");
    if (
      peer.kind !== machine.expected_peer_identity.kind
      || peer.value !== machine.expected_peer_identity.value
    ) {
      throw new RemoteMachineAuthError(
        "REMOTE_AUTH_PEER_IDENTITY_MISMATCH",
        `Remote peer identity does not match the pinned identity for ${machine.id}`
      );
    }
    if (requirements.length > 0 && evidence.client_authenticated !== true) {
      throw new RemoteMachineAuthError("REMOTE_AUTH_CLIENT_UNVERIFIED", "Remote authentication provider did not prove client authentication");
    }
    if (!satisfiesRequirement(evidence, requirements)) {
      throw new RemoteMachineAuthError(
        "REMOTE_AUTH_REQUIREMENT_UNSATISFIED",
        "Remote authentication evidence does not satisfy any declared security requirement"
      );
    }
  }
}

function schemeObject(securitySchemes: JsonObject, name: string): JsonObject {
  const scheme = asObject(securitySchemes[name]);
  if (!scheme) throw new RemoteMachineAuthError("REMOTE_AUTH_UNKNOWN_SCHEME", `Security scheme ${name} is not declared`);
  return scheme;
}

function selectHeaderScheme(
  securitySchemes: JsonObject,
  requirements: RemoteSecurityRequirement[],
  material: RemoteCredentialMaterial
): { name: string; headerName: string; headerValue: string; mechanism: string } | null {
  for (const requirement of requirements) {
    const names = Object.keys(requirement.schemes);
    if (names.length !== 1) continue;
    const name = names[0]!;
    const scheme = schemeObject(securitySchemes, name);

    const http = asObject(scheme.httpAuthSecurityScheme) ?? asObject(scheme.http_auth_security_scheme);
    if (material.kind === "bearer" && http && typeof http.scheme === "string" && http.scheme.toLowerCase() === "bearer") {
      return {
        name,
        headerName: "authorization",
        headerValue: `Bearer ${material.value}`,
        mechanism: "http-bearer"
      };
    }

    const apiKey = asObject(scheme.apiKeySecurityScheme) ?? asObject(scheme.api_key_security_scheme);
    if (material.kind === "api_key" && apiKey) {
      const location = typeof apiKey.location === "string" ? apiKey.location.toLowerCase() : "";
      const headerName = typeof apiKey.name === "string" ? apiKey.name.trim().toLowerCase() : "";
      if (location !== "header" || !headerName) continue;
      if ([
        "authorization",
        "host",
        "content-length",
        "content-type",
        "accept",
        "a2a-version",
        "cookie",
        "set-cookie"
      ].includes(headerName)) {
        throw new RemoteMachineAuthError(
          "REMOTE_AUTH_HEADER_FORBIDDEN",
          `API-key scheme ${name} attempts to control protected header ${headerName}`
        );
      }
      return {
        name,
        headerName,
        headerValue: material.value,
        mechanism: "api-key-header"
      };
    }
  }
  return null;
}

export interface HeaderRemoteHttpAuthenticatorOptions {
  fetchImpl?: typeof fetch;
}

export class HeaderRemoteHttpAuthenticator implements RemoteHttpAuthenticator {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    id: string,
    private readonly credentials: RemoteCredentialResolver,
    options: HeaderRemoteHttpAuthenticatorOptions = {}
  ) {
    this.id = safeString(id, "remote authenticator id", 256);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(input: RemoteAuthenticatorRequest): Promise<RemoteAuthenticatedHttpResult> {
    const headers = new Headers(input.headers);
    if (input.securityRequirements.length === 0) {
      const response = await this.fetchImpl(input.url, {
        method: input.method,
        headers,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        redirect: "error"
      });
      return {
        response,
        evidence: {
          machine_id: input.machine.id,
          origin: input.machine.origin,
          tls_verified: true,
          peer_identity: { kind: "https_origin", value: input.machine.origin },
          client_authenticated: false,
          satisfied_schemes: [],
          mechanism: "https-ca"
        }
      };
    }

    if (!input.credentialRef) {
      throw new RemoteMachineAuthError("REMOTE_AUTH_BINDING_REQUIRED", "Authenticated request is missing a credential reference");
    }
    const material = await this.credentials.resolve(input.credentialRef);
    const value = safeString(material?.value, "resolved remote credential", 16 * 1024);
    if (material.kind !== "bearer" && material.kind !== "api_key") {
      throw new RemoteMachineAuthError("REMOTE_AUTH_CREDENTIAL_UNSUPPORTED", "Resolved remote credential kind is unsupported");
    }
    const selection = selectHeaderScheme(
      input.securitySchemes,
      input.securityRequirements,
      { kind: material.kind, value }
    );
    if (!selection) {
      throw new RemoteMachineAuthError(
        "REMOTE_AUTH_SCHEME_UNSUPPORTED",
        "Header authenticator cannot satisfy any declared remote security requirement"
      );
    }

    if (headers.has(selection.headerName)) {
      throw new RemoteMachineAuthError(
        "REMOTE_AUTH_HEADER_COLLISION",
        `Base request already defines authentication header ${selection.headerName}`
      );
    }
    headers.set(selection.headerName, selection.headerValue);

    const response = await this.fetchImpl(input.url, {
      method: input.method,
      headers,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      redirect: "error"
    });
    return {
      response,
      evidence: {
        machine_id: input.machine.id,
        origin: input.machine.origin,
        tls_verified: true,
        peer_identity: { kind: "https_origin", value: input.machine.origin },
        client_authenticated: true,
        satisfied_schemes: [selection.name],
        mechanism: selection.mechanism
      }
    };
  }
}

export function parseRemoteAuthBinding(runtime: JsonObject): {
  machineRef: string | null;
  auth: RemoteAuthBinding | null;
} {
  const machineRaw = runtime.remote_machine_ref;
  const providerRaw = runtime.remote_auth_provider;
  const credentialRaw = runtime.remote_credential_ref;

  const any = machineRaw !== undefined || providerRaw !== undefined || credentialRaw !== undefined;
  if (!any) return { machineRef: null, auth: null };

  const machineRef = safeString(machineRaw, "runtime.remote_machine_ref", 256);
  const hasProvider = providerRaw !== undefined && providerRaw !== null;
  const hasCredential = credentialRaw !== undefined && credentialRaw !== null;
  if (hasProvider !== hasCredential) {
    throw new RemoteMachineAuthError(
      "REMOTE_AUTH_INCOMPLETE_BINDING",
      "runtime.remote_auth_provider and runtime.remote_credential_ref must be supplied together"
    );
  }

  return {
    machineRef,
    auth: hasProvider
      ? {
          provider: safeString(providerRaw, "runtime.remote_auth_provider", 256),
          credential_ref: safeString(credentialRaw, "runtime.remote_credential_ref", 1024)
        }
      : null
  };
}
