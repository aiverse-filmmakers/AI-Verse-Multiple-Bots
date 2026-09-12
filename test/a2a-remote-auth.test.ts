import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { A2AJsonRpcRuntimeAdapter, A2ARuntimeError } from "../src/a2a-runtime.js";
import {
  HeaderRemoteHttpAuthenticator,
  RemoteHttpAccessBroker,
  RemoteHttpAuthenticatorRegistry,
  RemoteMachineIdentityRegistry,
  type RemoteCredentialResolver,
  type RemoteHttpAuthenticator
} from "../src/remote-machine-auth.js";
import type { RuntimeExecutionContext } from "../src/runtime.js";
import { createGatewayServer } from "../src/server.js";
import type { JsonObject, StoredObject } from "../src/types.js";

function stored(id: string, kind: any, workspaceId: string, payload: JsonObject): StoredObject {
  return {
    id,
    kind,
    workspaceId,
    status: typeof payload.status === "string" ? payload.status : null,
    payload,
    createdAt: "2026-09-12T21:00:00Z",
    updatedAt: "2026-09-12T21:00:00Z"
  };
}

function context(runtime: JsonObject): RuntimeExecutionContext {
  const bot = stored("bot_remote-auth", "bot", "ws-remote-auth", {
    schema_version: "1.0",
    id: "bot_remote-auth",
    name: "Authenticated Remote",
    kind: "durable",
    status: "active",
    role: { title: "Remote analyst", mission: "Execute authenticated remote work." },
    runtime,
    execution: { environment_policy: "external_managed" },
    scope: { type: "workspace", workspace_id: "ws-remote-auth" },
    permissions: { policy_ref: "default-bot" },
    coordination: {}
  });
  return {
    principal: bot,
    principalKind: "bot",
    bot: bot as any,
    runtime,
    task: stored("task_remote-auth", "task", "ws-remote-auth", {
      schema_version: "1.0",
      id: "task_remote-auth",
      type: "task.delegate",
      workspace_id: "ws-remote-auth",
      created_by: "bot_leader",
      assignee_id: bot.id,
      owner_id: bot.id,
      root_objective_id: "obj_remote-auth",
      objective: "Run authenticated remote analysis.",
      reason: "Phase 4.6 acceptance",
      required_constraints: ["Keep local authority canonical"],
      expected_output: { contract: "analysis-v1" },
      input_artifact_refs: [],
      lease_id: "lease_remote-auth",
      environment_lease_id: null,
      deadline_at: null,
      budget: {},
      hop: 0,
      max_hops: 6,
      status: "running"
    }),
    capabilityLease: stored("lease_remote-auth", "capability_lease", "ws-remote-auth", {
      schema_version: "1.0",
      id: "lease_remote-auth",
      type: "capability_lease",
      principal: bot.id,
      issued_to: bot.id,
      workspace_id: "ws-remote-auth",
      task_id: "task_remote-auth",
      tools: [],
      connections: [],
      destructive_actions: "deny",
      expires_at: "2030-01-01T00:00:00Z"
    }),
    environmentLease: null,
    inputArtifacts: [],
    historicalRecall: null,
    skillsCapabilityResolution: null,
    signal: new AbortController().signal
  };
}

function card(interfaceUrl = "https://agent.example/rpc"): JsonObject {
  return {
    name: "Authenticated A2A Agent",
    description: "Test authenticated agent",
    supportedInterfaces: [{
      url: interfaceUrl,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0"
    }],
    version: "1.0.0",
    capabilities: {},
    securitySchemes: {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: "Bearer",
          bearerFormat: "JWT"
        }
      }
    },
    securityRequirements: [{
      schemes: {
        bearer: { list: [] }
      }
    }],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [{ id: "analysis", name: "Analysis", description: "Analyze", tags: ["analysis"] }]
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test("A2A remote-machine auth verifies discovery identity and sends bearer only on authenticated RPC", async () => {
  let resolverCalls = 0;
  const requests: Array<{ url: string; method: string; authorization: string | null; redirect: string }> = [];
  const credentials: RemoteCredentialResolver = {
    async resolve(ref) {
      resolverCalls += 1;
      assert.equal(ref, "secret://a2a/research");
      return { kind: "bearer", value: "SUPER_SECRET_BEARER" };
    }
  };
  const transportFetch: typeof fetch = async (input: any, init?: any) => {
    const headers = new Headers(init?.headers);
    const url = String(input);
    const method = String(init?.method ?? "GET");
    requests.push({
      url,
      method,
      authorization: headers.get("authorization"),
      redirect: String(init?.redirect)
    });
    if (method === "GET") return json(card());
    const body = JSON.parse(String(init?.body));
    return json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        message: {
          messageId: "remote-auth-message",
          role: "ROLE_AGENT",
          parts: [{ text: "Authenticated remote result." }]
        }
      }
    });
  };

  const machines = new RemoteMachineIdentityRegistry([{
    id: "machine_research",
    origin: "https://agent.example",
    expected_peer_identity: { kind: "https_origin", value: "https://agent.example" }
  }]);
  const headerAuth = new HeaderRemoteHttpAuthenticator("header-auth", credentials, {
    fetchImpl: transportFetch
  });
  const remoteAccess = new RemoteHttpAccessBroker(
    machines,
    new RemoteHttpAuthenticatorRegistry([headerAuth])
  );
  const adapter = new A2AJsonRpcRuntimeAdapter({ remoteAccess });

  const result = await adapter.execute(context({
    adapter: "a2a",
    agent_card_url: "https://agent.example/.well-known/agent-card.json",
    remote_machine_ref: "machine_research",
    remote_auth_provider: "header-auth",
    remote_credential_ref: "secret://a2a/research"
  }));

  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.method, "GET");
  assert.equal(requests[0]!.authorization, null);
  assert.equal(requests[0]!.redirect, "error");
  assert.equal(requests[1]!.method, "POST");
  assert.equal(requests[1]!.authorization, "Bearer SUPER_SECRET_BEARER");
  assert.equal(requests[1]!.redirect, "error");
  assert.equal(resolverCalls, 1);

  assert.equal(result.summary, "Authenticated remote result.");
  const receipt = result.receipts?.[0] as JsonObject;
  assert.equal(receipt.authentication, "verified");
  assert.equal(receipt.remote_machine_ref, "machine_research");
  assert.equal(receipt.authentication_mechanism, "http-bearer");
  assert.equal(receipt.peer_identity_kind, "https_origin");
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes("SUPER_SECRET_BEARER"), false);
  assert.equal(serialized.includes("secret://a2a/research"), false);
});

test("authenticated A2A Agent Card cannot redirect credentials to another origin", async () => {
  let resolverCalls = 0;
  let postCalls = 0;
  const credentials: RemoteCredentialResolver = {
    async resolve() {
      resolverCalls += 1;
      return { kind: "bearer", value: "DO_NOT_LEAK" };
    }
  };
  const headerAuth = new HeaderRemoteHttpAuthenticator("header-auth", credentials, {
    fetchImpl: async (_input: any, init?: any) => {
      if (String(init?.method ?? "GET") === "GET") return json(card("https://evil.example/rpc"));
      postCalls += 1;
      throw new Error("credential should never reach evil origin");
    }
  });
  const adapter = new A2AJsonRpcRuntimeAdapter({
    remoteAccess: new RemoteHttpAccessBroker(
      new RemoteMachineIdentityRegistry([{
        id: "machine_research",
        origin: "https://agent.example",
        expected_peer_identity: { kind: "https_origin", value: "https://agent.example" }
      }]),
      new RemoteHttpAuthenticatorRegistry([headerAuth])
    )
  });

  await assert.rejects(
    () => adapter.execute(context({
      adapter: "a2a",
      agent_card_url: "https://agent.example/.well-known/agent-card.json",
      remote_machine_ref: "machine_research",
      remote_auth_provider: "header-auth",
      remote_credential_ref: "secret://a2a/research"
    })),
    (error: unknown) => error instanceof A2ARuntimeError && error.code === "REMOTE_AUTH_ORIGIN_MISMATCH"
  );

  assert.equal(resolverCalls, 0);
  assert.equal(postCalls, 0);
});

test("A2A authenticated execution requires complete remote machine and auth bindings", async () => {
  const fetchImpl: typeof fetch = async () => json(card());
  const adapterWithoutBroker = new A2AJsonRpcRuntimeAdapter({ fetchImpl });

  await assert.rejects(
    () => adapterWithoutBroker.execute(context({
      adapter: "a2a",
      agent_card_url: "https://agent.example/.well-known/agent-card.json",
      remote_machine_ref: "machine_research"
    })),
    (error: unknown) => error instanceof A2ARuntimeError && error.code === "A2A_REMOTE_AUTH_BROKER_REQUIRED"
  );

  const remoteAccess = new RemoteHttpAccessBroker(
    new RemoteMachineIdentityRegistry([{
      id: "machine_research",
      origin: "https://agent.example",
      expected_peer_identity: { kind: "https_origin", value: "https://agent.example" }
    }]),
    new RemoteHttpAuthenticatorRegistry(),
    { fetchImpl }
  );
  const adapter = new A2AJsonRpcRuntimeAdapter({ remoteAccess });

  await assert.rejects(
    () => adapter.execute(context({
      adapter: "a2a",
      agent_card_url: "https://agent.example/.well-known/agent-card.json",
      remote_machine_ref: "machine_research"
    })),
    (error: unknown) => error instanceof A2ARuntimeError && error.code === "A2A_AUTH_BINDING_REQUIRED"
  );
});

test("A2A remote auth rejects undeclared security schemes instead of guessing credentials", async () => {
  const credentials: RemoteCredentialResolver = {
    async resolve() {
      return { kind: "bearer", value: "SECRET" };
    }
  };
  const headerAuth = new HeaderRemoteHttpAuthenticator("header-auth", credentials, {
    fetchImpl: async (_input: any, init?: any) => {
      if (String(init?.method ?? "GET") === "GET") {
        return json({
          ...card(),
          securitySchemes: {},
          securityRequirements: [{ schemes: { missing: { list: [] } } }]
        });
      }
      throw new Error("RPC must not execute");
    }
  });
  const adapter = new A2AJsonRpcRuntimeAdapter({
    remoteAccess: new RemoteHttpAccessBroker(
      new RemoteMachineIdentityRegistry([{
        id: "machine_research",
        origin: "https://agent.example",
        expected_peer_identity: { kind: "https_origin", value: "https://agent.example" }
      }]),
      new RemoteHttpAuthenticatorRegistry([headerAuth])
    )
  });

  await assert.rejects(
    () => adapter.execute(context({
      adapter: "a2a",
      agent_card_url: "https://agent.example/.well-known/agent-card.json",
      remote_machine_ref: "machine_research",
      remote_auth_provider: "header-auth",
      remote_credential_ref: "secret://a2a/research"
    })),
    (error: unknown) => error instanceof A2ARuntimeError && error.code === "REMOTE_AUTH_UNKNOWN_SCHEME"
  );
});

test("Gateway exposes remote machine/auth registries while keeping providers host-injected", async () => {
  const dbPath = `/tmp/a2a-remote-auth-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
  const fakeAuthenticator: RemoteHttpAuthenticator = {
    id: "host-auth",
    async request() {
      throw new Error("not used");
    }
  };
  const service = createGatewayServer({
    dbPath,
    port: 0,
    remoteMachines: [{
      id: "machine_research",
      origin: "https://agent.example",
      expected_peer_identity: { kind: "https_origin", value: "https://agent.example" }
    }],
    remoteAuthenticators: [fakeAuthenticator]
  });
  await service.listen();
  await service.supervisor.waitForIdle();
  try {
    assert.equal(service.remoteMachines.has("machine_research"), true);
    assert.equal(service.remoteAuthenticators.has("host-auth"), true);
    assert.ok(service.remoteAccess);
    assert.equal(service.runtimes.has("a2a"), true);
  } finally {
    await service.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  }
});
