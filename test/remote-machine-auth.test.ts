import assert from "node:assert/strict";
import test from "node:test";
import {
  HeaderRemoteHttpAuthenticator,
  RemoteHttpAccessBroker,
  RemoteHttpAuthenticatorRegistry,
  RemoteMachineAuthError,
  RemoteMachineIdentityRegistry,
  normalizeRemoteSecurityRequirements,
  parseRemoteAuthBinding,
  type RemoteAuthenticatedHttpResult,
  type RemoteAuthenticatorRequest,
  type RemoteCredentialResolver,
  type RemoteHttpAuthenticator
} from "../src/remote-machine-auth.js";

function assertCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof RemoteMachineAuthError && error.code === code;
}

test("remote machine registry pins HTTPS origin and peer identity without storing credentials", () => {
  const registry = new RemoteMachineIdentityRegistry();
  registry.register({
    id: "machine_research",
    origin: "https://agent.example",
    expected_peer_identity: { kind: "https_origin", value: "https://agent.example" }
  });
  assert.equal(registry.has("machine_research"), true);
  assert.deepEqual(registry.ids(), ["machine_research"]);
  assert.equal(registry.get("machine_research").origin, "https://agent.example");

  assert.throws(
    () => registry.register({
      id: "machine_research",
      origin: "https://agent.example",
      expected_peer_identity: { kind: "https_origin", value: "https://agent.example" }
    }),
    assertCode("REMOTE_MACHINE_ID_COLLISION")
  );

  assert.throws(
    () => registry.register({
      id: "machine_spoof",
      origin: "https://agent.example",
      expected_peer_identity: { kind: "spiffe_id", value: "spiffe://example/other" }
    }),
    assertCode("REMOTE_MACHINE_ORIGIN_CONFLICT")
  );

  assert.throws(
    () => new RemoteMachineIdentityRegistry([{
      id: "machine_http",
      origin: "http://agent.example",
      expected_peer_identity: { kind: "https_origin", value: "http://agent.example" }
    }]),
    assertCode("REMOTE_AUTH_HTTPS_REQUIRED")
  );
});

test("remote auth binding accepts opaque handles only and requires provider/credential pairing", () => {
  assert.deepEqual(parseRemoteAuthBinding({}), { machineRef: null, auth: null });
  assert.deepEqual(parseRemoteAuthBinding({
    remote_machine_ref: "machine_research"
  }), {
    machineRef: "machine_research",
    auth: null
  });
  assert.deepEqual(parseRemoteAuthBinding({
    remote_machine_ref: "machine_research",
    remote_auth_provider: "header-auth",
    remote_credential_ref: "secret://a2a/research"
  }), {
    machineRef: "machine_research",
    auth: {
      provider: "header-auth",
      credential_ref: "secret://a2a/research"
    }
  });

  assert.throws(
    () => parseRemoteAuthBinding({
      remote_machine_ref: "machine_research",
      remote_auth_provider: "header-auth"
    }),
    assertCode("REMOTE_AUTH_INCOMPLETE_BINDING")
  );
});

test("A2A security requirements normalize canonical v1 and compatibility shapes", () => {
  assert.deepEqual(normalizeRemoteSecurityRequirements([
    { schemes: { bearer: { list: ["scope:b", "scope:a", "scope:a"] } } },
    { apiKey: [] }
  ]), [
    { schemes: { bearer: ["scope:a", "scope:b"] } },
    { schemes: { apiKey: [] } }
  ]);

  assert.throws(
    () => normalizeRemoteSecurityRequirements([{ schemes: { bearer: "bad" } }]),
    assertCode("REMOTE_AUTH_INVALID_REQUIREMENTS")
  );
});

test("HTTPS-origin identity-only broker rejects cross-origin requests and redirects are disabled", async () => {
  const calls: any[] = [];
  const fetchImpl: typeof fetch = async (input: any, init?: any) => {
    calls.push({ input: String(input), init });
    return new Response("{}", { status: 200 });
  };
  const machines = new RemoteMachineIdentityRegistry([{
    id: "machine_research",
    origin: "https://agent.example",
    expected_peer_identity: { kind: "https_origin", value: "https://agent.example" }
  }]);
  const broker = new RemoteHttpAccessBroker(
    machines,
    new RemoteHttpAuthenticatorRegistry(),
    { fetchImpl }
  );

  const result = await broker.request({
    machineRef: "machine_research",
    url: "https://agent.example/card",
    method: "GET"
  });
  assert.equal(result.evidence.tls_verified, true);
  assert.equal(result.evidence.peer_identity.kind, "https_origin");
  assert.equal(result.evidence.peer_identity.value, "https://agent.example");
  assert.equal(result.evidence.client_authenticated, false);
  assert.equal(calls[0].init.redirect, "error");

  await assert.rejects(
    () => broker.request({
      machineRef: "machine_research",
      url: "https://evil.example/card",
      method: "GET"
    }),
    assertCode("REMOTE_AUTH_ORIGIN_MISMATCH")
  );
});

test("strong peer identity requires an attesting transport instead of pretending normal fetch can verify it", async () => {
  const machines = new RemoteMachineIdentityRegistry([{
    id: "machine_spiffe",
    origin: "https://agent.example",
    expected_peer_identity: { kind: "spiffe_id", value: "spiffe://ai-verse/runtime/research" }
  }]);
  const broker = new RemoteHttpAccessBroker(machines, new RemoteHttpAuthenticatorRegistry(), {
    fetchImpl: async () => new Response("{}", { status: 200 })
  });

  await assert.rejects(
    () => broker.request({
      machineRef: "machine_spiffe",
      url: "https://agent.example/card",
      method: "GET"
    }),
    assertCode("REMOTE_AUTH_STRONG_IDENTITY_PROVIDER_REQUIRED")
  );
});

test("header authenticator never resolves or sends application credentials for public discovery", async () => {
  let resolverCalls = 0;
  const requests: Array<{ headers: Headers; redirect: string }> = [];
  const credentials: RemoteCredentialResolver = {
    async resolve() {
      resolverCalls += 1;
      return { kind: "bearer", value: "TOP_SECRET" };
    }
  };
  const authenticator = new HeaderRemoteHttpAuthenticator("header-auth", credentials, {
    fetchImpl: async (_input: any, init?: any) => {
      requests.push({
        headers: new Headers(init?.headers),
        redirect: String(init?.redirect)
      });
      return new Response("{}", { status: 200 });
    }
  });
  const broker = new RemoteHttpAccessBroker(
    new RemoteMachineIdentityRegistry([{
      id: "machine_research",
      origin: "https://agent.example",
      expected_peer_identity: { kind: "https_origin", value: "https://agent.example" }
    }]),
    new RemoteHttpAuthenticatorRegistry([authenticator])
  );

  await broker.request({
    machineRef: "machine_research",
    auth: { provider: "header-auth", credential_ref: "secret://research" },
    url: "https://agent.example/.well-known/agent-card.json",
    method: "GET",
    securitySchemes: {},
    securityRequirements: []
  });

  assert.equal(resolverCalls, 0);
  assert.equal(requests[0].headers.get("authorization"), null);
  assert.equal(requests[0].redirect, "error");
});

test("header authenticator satisfies declared Bearer authentication with an out-of-band credential handle", async () => {
  const requests: Array<{ headers: Headers; redirect: string }> = [];
  const credentials: RemoteCredentialResolver = {
    async resolve(ref) {
      assert.equal(ref, "secret://research");
      return { kind: "bearer", value: "BEARER_SECRET" };
    }
  };
  const authenticator = new HeaderRemoteHttpAuthenticator("header-auth", credentials, {
    fetchImpl: async (_input: any, init?: any) => {
      requests.push({ headers: new Headers(init?.headers), redirect: String(init?.redirect) });
      return new Response("{}", { status: 200 });
    }
  });
  const broker = new RemoteHttpAccessBroker(
    new RemoteMachineIdentityRegistry([{
      id: "machine_research",
      origin: "https://agent.example",
      expected_peer_identity: { kind: "https_origin", value: "https://agent.example" }
    }]),
    new RemoteHttpAuthenticatorRegistry([authenticator])
  );

  const result = await broker.request({
    machineRef: "machine_research",
    auth: { provider: "header-auth", credential_ref: "secret://research" },
    url: "https://agent.example/rpc",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          bearerFormat: "JWT"
        }
      }
    },
    securityRequirements: [{ schemes: { bearer: [] } }]
  });

  assert.equal(requests[0].headers.get("authorization"), "Bearer BEARER_SECRET");
  assert.equal(requests[0].redirect, "error");
  assert.equal(result.evidence.client_authenticated, true);
  assert.deepEqual(result.evidence.satisfied_schemes, ["bearer"]);
  assert.equal(result.evidence.mechanism, "http-bearer");
});

test("header authenticator supports header API keys but blocks protected header takeover", async () => {
  const credentials: RemoteCredentialResolver = {
    async resolve() {
      return { kind: "api_key", value: "API_SECRET" };
    }
  };
  let observed: Headers | null = null;
  const authenticator = new HeaderRemoteHttpAuthenticator("header-auth", credentials, {
    fetchImpl: async (_input: any, init?: any) => {
      observed = new Headers(init?.headers);
      return new Response("{}", { status: 200 });
    }
  });
  const broker = new RemoteHttpAccessBroker(
    new RemoteMachineIdentityRegistry([{
      id: "machine_research",
      origin: "https://agent.example",
      expected_peer_identity: { kind: "https_origin", value: "https://agent.example" }
    }]),
    new RemoteHttpAuthenticatorRegistry([authenticator])
  );

  await broker.request({
    machineRef: "machine_research",
    auth: { provider: "header-auth", credential_ref: "secret://api" },
    url: "https://agent.example/rpc",
    method: "POST",
    securitySchemes: {
      key: {
        apiKeySecurityScheme: {
          location: "header",
          name: "X-Agent-Key"
        }
      }
    },
    securityRequirements: [{ schemes: { key: [] } }]
  });
  assert.equal(observed!.get("x-agent-key"), "API_SECRET");

  await assert.rejects(
    () => broker.request({
      machineRef: "machine_research",
      auth: { provider: "header-auth", credential_ref: "secret://api" },
      url: "https://agent.example/rpc",
      method: "POST",
      securitySchemes: {
        key: {
          apiKeySecurityScheme: {
            location: "header",
            name: "Content-Type"
          }
        }
      },
      securityRequirements: [{ schemes: { key: [] } }]
    }),
    assertCode("REMOTE_AUTH_HEADER_FORBIDDEN")
  );
});

test("custom authenticator can prove SPIFFE/mTLS-style peer identity and satisfy AND security requirements", async () => {
  const authenticator: RemoteHttpAuthenticator = {
    id: "spiffe-mtls",
    async request(input: RemoteAuthenticatorRequest): Promise<RemoteAuthenticatedHttpResult> {
      assert.equal(input.credentialRef, "workload://research");
      return {
        response: new Response("{}", { status: 200 }),
        evidence: {
          machine_id: input.machine.id,
          origin: input.machine.origin,
          tls_verified: true,
          peer_identity: {
            kind: "spiffe_id",
            value: "spiffe://ai-verse/runtime/research"
          },
          client_authenticated: true,
          satisfied_schemes: ["mtls", "oauth"],
          mechanism: "spiffe-x509+oauth2-mtls"
        }
      };
    }
  };

  const broker = new RemoteHttpAccessBroker(
    new RemoteMachineIdentityRegistry([{
      id: "machine_spiffe",
      origin: "https://agent.example",
      expected_peer_identity: {
        kind: "spiffe_id",
        value: "spiffe://ai-verse/runtime/research"
      }
    }]),
    new RemoteHttpAuthenticatorRegistry([authenticator])
  );

  const result = await broker.request({
    machineRef: "machine_spiffe",
    auth: { provider: "spiffe-mtls", credential_ref: "workload://research" },
    url: "https://agent.example/rpc",
    method: "POST",
    securitySchemes: {
      mtls: { mtlsSecurityScheme: {} },
      oauth: { oauth2SecurityScheme: { flows: {} } }
    },
    securityRequirements: [{
      schemes: {
        mtls: [],
        oauth: ["agent.execute"]
      }
    }]
  });
  assert.equal(result.evidence.peer_identity.kind, "spiffe_id");
  assert.equal(result.evidence.mechanism, "spiffe-x509+oauth2-mtls");
});

test("broker rejects spoofed peer identity, unverified TLS, unauthenticated client, and incomplete security proof", async () => {
  const cases: Array<{
    evidence: Partial<RemoteAuthenticatedHttpResult["evidence"]>;
    code: string;
  }> = [
    {
      evidence: { peer_identity: { kind: "https_origin", value: "https://evil.example" } },
      code: "REMOTE_AUTH_PEER_IDENTITY_MISMATCH"
    },
    {
      evidence: { tls_verified: false },
      code: "REMOTE_AUTH_TLS_UNVERIFIED"
    },
    {
      evidence: { client_authenticated: false },
      code: "REMOTE_AUTH_CLIENT_UNVERIFIED"
    },
    {
      evidence: { satisfied_schemes: [] },
      code: "REMOTE_AUTH_REQUIREMENT_UNSATISFIED"
    }
  ];

  for (const item of cases) {
    const authenticator: RemoteHttpAuthenticator = {
      id: "custom",
      async request(input) {
        return {
          response: new Response("{}", { status: 200 }),
          evidence: {
            machine_id: input.machine.id,
            origin: input.machine.origin,
            tls_verified: true,
            peer_identity: { kind: "https_origin", value: input.machine.origin },
            client_authenticated: true,
            satisfied_schemes: ["bearer"],
            mechanism: "custom",
            ...item.evidence
          }
        };
      }
    };
    const broker = new RemoteHttpAccessBroker(
      new RemoteMachineIdentityRegistry([{
        id: "machine_research",
        origin: "https://agent.example",
        expected_peer_identity: { kind: "https_origin", value: "https://agent.example" }
      }]),
      new RemoteHttpAuthenticatorRegistry([authenticator])
    );

    await assert.rejects(
      () => broker.request({
        machineRef: "machine_research",
        auth: { provider: "custom", credential_ref: "secret://research" },
        url: "https://agent.example/rpc",
        method: "POST",
        securitySchemes: {
          bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } }
        },
        securityRequirements: [{ schemes: { bearer: [] } }]
      }),
      assertCode(item.code)
    );
  }
});

test("authenticator registry is explicit and duplicate-safe", () => {
  const provider: RemoteHttpAuthenticator = {
    id: "custom",
    async request() {
      throw new Error("unused");
    }
  };
  const registry = new RemoteHttpAuthenticatorRegistry([provider]);
  assert.equal(registry.has("custom"), true);
  assert.deepEqual(registry.ids(), ["custom"]);
  assert.throws(() => registry.register(provider), assertCode("REMOTE_AUTH_PROVIDER_COLLISION"));
  assert.throws(() => registry.get("missing"), assertCode("REMOTE_AUTH_PROVIDER_NOT_REGISTERED"));
});
