import assert from "node:assert/strict";
import test from "node:test";
import { A2AJsonRpcRuntimeAdapter, A2ARuntimeError } from "../src/a2a-runtime.js";
import {
  REMOTE_LEASE_A2A_EXTENSION_URI,
  RemoteLeaseBroker,
  RemoteLeaseProviderRegistry,
  type RemoteLeaseGrantRequest,
  type RemoteLeaseProvider,
  type RemoteLeaseRevokeRequest
} from "../src/remote-leases.js";
import {
  RemoteHttpAccessBroker,
  RemoteMachineIdentityRegistry
} from "../src/remote-machine-auth.js";
import type { RuntimeExecutionContext } from "../src/runtime.js";
import type { JsonObject, StoredObject } from "../src/types.js";

function stored(id: string, kind: any, workspaceId: string, payload: JsonObject): StoredObject {
  return {
    id,
    kind,
    workspaceId,
    status: typeof payload.status === "string" ? payload.status : null,
    payload,
    createdAt: "2026-09-13T00:00:00Z",
    updatedAt: "2026-09-13T00:00:00Z"
  };
}

function runtimeContext(options: {
  environment?: boolean;
  signal?: AbortSignal;
  runtimePatch?: JsonObject;
} = {}): RuntimeExecutionContext {
  const runtime: JsonObject = {
    adapter: "a2a",
    agent_card_url: "https://agent.example/.well-known/agent-card.json",
    remote_machine_ref: "machine_research",
    remote_lease_provider: "lease-provider",
    poll_interval_ms: 25,
    ...(options.runtimePatch ?? {})
  };
  const bot = stored("bot_a2a-lease", "bot", "ws_a2a-lease", {
    schema_version: "1.0",
    id: "bot_a2a-lease",
    name: "Remote A2A Lease Bot",
    kind: "durable",
    status: "active",
    role: { title: "Remote analyst", mission: "Use only leased remote authority." },
    runtime,
    execution: { environment_policy: "external_managed" },
    scope: { type: "workspace", workspace_id: "ws_a2a-lease" },
    permissions: { policy_ref: "default-bot" },
    coordination: {}
  });
  const task = stored("task_a2a-lease", "task", "ws_a2a-lease", {
    schema_version: "1.0",
    id: "task_a2a-lease",
    type: "task.delegate",
    workspace_id: "ws_a2a-lease",
    created_by: "bot_leader",
    assignee_id: bot.id,
    owner_id: bot.id,
    root_objective_id: "obj_a2a-lease",
    objective: "Use bounded remote authority.",
    reason: "Phase 4.7 acceptance",
    required_constraints: ["Do not widen authority"],
    expected_output: { contract: "analysis-v1" },
    input_artifact_refs: [],
    lease_id: "lease_a2a-lease",
    environment_lease_id: options.environment ? "envlease_a2a-lease" : null,
    deadline_at: "2029-01-01T00:00:00Z",
    budget: {},
    hop: 0,
    max_hops: 6,
    status: "running"
  });
  const environmentLease = options.environment
    ? stored("envlease_a2a-lease", "environment_lease", "ws_a2a-lease", {
        schema_version: "1.0",
        id: "envlease_a2a-lease",
        type: "environment_lease",
        issued_to: bot.id,
        workspace_id: "ws_a2a-lease",
        task_id: task.id,
        environment_policy: "isolated_run",
        environment_ref: "env_local_a2a",
        expires_at: "2029-01-01T00:00:00Z"
      })
    : null;

  return {
    principal: bot,
    principalKind: "bot",
    bot: bot as any,
    runtime,
    task,
    capabilityLease: stored("lease_a2a-lease", "capability_lease", "ws_a2a-lease", {
      schema_version: "1.0",
      id: "lease_a2a-lease",
      type: "capability_lease",
      principal: "bot_leader",
      issued_to: bot.id,
      workspace_id: "ws_a2a-lease",
      task_id: task.id,
      tools: ["docs.read", "web.search"],
      connections: ["drive.read"],
      destructive_actions: "deny",
      expires_at: "2029-01-01T00:00:00Z"
    }),
    environmentLease,
    inputArtifacts: [],
    historicalRecall: null,
    skillsCapabilityResolution: null,
    signal: options.signal ?? new AbortController().signal
  };
}

function card(withLeaseExtension = true): JsonObject {
  return {
    name: "Lease-aware A2A Agent",
    version: "1.0.0",
    supportedInterfaces: [{
      url: "https://agent.example/rpc",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0"
    }],
    capabilities: {
      extensions: withLeaseExtension
        ? [{ uri: REMOTE_LEASE_A2A_EXTENSION_URI, description: "AI-Verse remote Task lease" }]
        : []
    },
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

class LeaseProvider implements RemoteLeaseProvider {
  readonly id = "lease-provider";
  grants: RemoteLeaseGrantRequest[] = [];
  revokes: RemoteLeaseRevokeRequest[] = [];

  async grant(request: RemoteLeaseGrantRequest) {
    this.grants.push(request);
    return {
      provider: this.id,
      remote_lease_id: "remote-a2a-lease",
      request_digest: request.requestDigest,
      grant_fingerprint: "a2a-grant:v1",
      expires_at: request.expiresAt,
      granted_tools: ["web.search"],
      granted_connections: ["drive.read"],
      destructive_actions: "deny",
      environment: request.environment
        ? {
            environment_policy: request.environment.environment_policy,
            remote_environment_ref: "remote-a2a-env"
          }
        : null
    };
  }

  async revoke(request: RemoteLeaseRevokeRequest): Promise<void> {
    this.revokes.push(request);
  }
}

function setup(
  fetchImpl: typeof fetch,
  provider = new LeaseProvider()
): {
  adapter: A2AJsonRpcRuntimeAdapter;
  provider: LeaseProvider;
} {
  const remoteAccess = new RemoteHttpAccessBroker(
    new RemoteMachineIdentityRegistry([{
      id: "machine_research",
      origin: "https://agent.example",
      expected_peer_identity: { kind: "https_origin", value: "https://agent.example" }
    }]),
    undefined,
    { fetchImpl }
  );
  const remoteLeases = new RemoteLeaseBroker(new RemoteLeaseProviderRegistry([provider]));
  return {
    provider,
    adapter: new A2AJsonRpcRuntimeAdapter({ remoteAccess, remoteLeases })
  };
}

test("A2A remote lease extension narrows authority, carries the grant, verifies the receipt and revokes after completion", async () => {
  const requests: any[] = [];
  let transportGrant: any = null;
  const fetchImpl: typeof fetch = async (_input: any, init?: any) => {
    const method = String(init?.method ?? "GET");
    if (method === "GET") return json(card(true));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("A2A-Extensions"), REMOTE_LEASE_A2A_EXTENSION_URI);
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    assert.equal(body.method, "SendMessage");
    assert.deepEqual(body.params.message.extensions, [REMOTE_LEASE_A2A_EXTENSION_URI]);
    transportGrant = body.params.message.metadata[REMOTE_LEASE_A2A_EXTENSION_URI];
    assert.deepEqual(transportGrant.granted_tools, ["web.search"]);
    assert.deepEqual(transportGrant.granted_connections, ["drive.read"]);
    return json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        message: {
          messageId: "remote-message-lease",
          role: "ROLE_AGENT",
          parts: [{ text: "Lease-aware result." }],
          metadata: {
            [REMOTE_LEASE_A2A_EXTENSION_URI]: {
              remote_lease_id: transportGrant.remote_lease_id,
              request_digest: transportGrant.request_digest,
              grant_fingerprint: transportGrant.grant_fingerprint,
              observed_tools: ["web.search"],
              observed_connections: ["drive.read"],
              state: "honored"
            }
          }
        }
      }
    });
  };

  const { adapter, provider } = setup(fetchImpl);
  const result = await adapter.execute(runtimeContext());

  assert.equal(provider.grants.length, 1);
  assert.deepEqual(provider.grants[0]!.allowedTools, ["docs.read", "web.search"]);
  assert.equal(result.summary, "Lease-aware result.");
  assert.equal(result.receipts?.[0]?.remote_lease_verified, true);
  assert.equal(result.receipts?.[0]?.granted_tool_count, 1);
  assert.equal(result.receipts?.[0]?.observed_tool_count, 1);
  assert.equal(result.receipts?.[0]?.environment_verified, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(provider.revokes.length, 1);
  assert.equal(provider.revokes[0]!.remoteLeaseId, "remote-a2a-lease");

  const serialized = JSON.stringify(result.receipts);
  assert.equal(serialized.includes("remote-a2a-lease"), false);
  assert.equal(serialized.includes("web.search"), false);
  assert.equal(serialized.includes("drive.read"), false);
});

test("A2A remote environment lease is bound to the provider-issued environment and verified on task completion", async () => {
  let grantProjection: any = null;
  let sent = false;
  const fetchImpl: typeof fetch = async (_input: any, init?: any) => {
    if (String(init?.method ?? "GET") === "GET") return json(card(true));
    const body = JSON.parse(String(init?.body));
    if (body.method === "SendMessage") {
      sent = true;
      grantProjection = body.params.message.metadata[REMOTE_LEASE_A2A_EXTENSION_URI];
      assert.equal(grantProjection.environment.environment_policy, "isolated_run");
      assert.equal(grantProjection.environment.remote_environment_ref, "remote-a2a-env");
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          task: {
            id: "remote-task-lease",
            contextId: "ctx-lease",
            status: { state: "TASK_STATE_WORKING" }
          }
        }
      });
    }
    assert.equal(body.method, "GetTask");
    return json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        id: "remote-task-lease",
        contextId: "ctx-lease",
        status: { state: "TASK_STATE_COMPLETED" },
        artifacts: [{
          artifactId: "artifact-lease",
          parts: [{ text: "Environment-bound result." }]
        }],
        metadata: {
          [REMOTE_LEASE_A2A_EXTENSION_URI]: {
            remote_lease_id: grantProjection.remote_lease_id,
            request_digest: grantProjection.request_digest,
            grant_fingerprint: grantProjection.grant_fingerprint,
            observed_tools: [],
            observed_connections: [],
            environment_ref: "remote-a2a-env",
            state: "honored"
          }
        }
      }
    });
  };

  const { adapter, provider } = setup(fetchImpl);
  const result = await adapter.execute(runtimeContext({ environment: true }));

  assert.equal(sent, true);
  assert.equal(provider.grants[0]!.environment?.local_environment_ref, "env_local_a2a");
  assert.equal(result.receipts?.[0]?.remote_lease_verified, true);
  assert.equal(result.receipts?.[0]?.environment_verified, true);
});

test("A2A meaningful authority on a pinned remote machine requires both a lease provider and extension support", async () => {
  const remoteAccess = new RemoteHttpAccessBroker(
    new RemoteMachineIdentityRegistry([{
      id: "machine_research",
      origin: "https://agent.example",
      expected_peer_identity: { kind: "https_origin", value: "https://agent.example" }
    }]),
    undefined,
    { fetchImpl: async () => json(card(true)) }
  );

  await assert.rejects(
    () => new A2AJsonRpcRuntimeAdapter({ remoteAccess }).execute(runtimeContext({
      runtimePatch: { remote_lease_provider: undefined }
    })),
    (error: unknown) => error instanceof A2ARuntimeError && error.code === "A2A_REMOTE_LEASE_PROVIDER_REQUIRED"
  );

  const { adapter } = setup(async (_input: any, init?: any) => {
    if (String(init?.method ?? "GET") === "GET") return json(card(false));
    throw new Error("execution must not start");
  });
  await assert.rejects(
    () => adapter.execute(runtimeContext()),
    (error: unknown) => error instanceof A2ARuntimeError && error.code === "A2A_REMOTE_LEASE_EXTENSION_REQUIRED"
  );
});

test("A2A missing or expanded remote lease receipt cannot become a successful local Artifact", async () => {
  for (const variant of ["missing", "expanded"] as const) {
    let grantProjection: any = null;
    const fetchImpl: typeof fetch = async (_input: any, init?: any) => {
      if (String(init?.method ?? "GET") === "GET") return json(card(true));
      const body = JSON.parse(String(init?.body));
      grantProjection = body.params.message.metadata[REMOTE_LEASE_A2A_EXTENSION_URI];
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          message: {
            messageId: "remote-message-bad-lease",
            role: "ROLE_AGENT",
            parts: [{ text: "Must not publish." }],
            ...(variant === "missing" ? {} : {
              metadata: {
                [REMOTE_LEASE_A2A_EXTENSION_URI]: {
                  remote_lease_id: grantProjection.remote_lease_id,
                  request_digest: grantProjection.request_digest,
                  grant_fingerprint: grantProjection.grant_fingerprint,
                  observed_tools: ["admin.delete"],
                  observed_connections: [],
                  state: "honored"
                }
              }
            })
          }
        }
      });
    };
    const { adapter } = setup(fetchImpl);
    await assert.rejects(
      () => adapter.execute(runtimeContext()),
      (error: unknown) => error instanceof A2ARuntimeError
        && error.code === (variant === "missing"
          ? "REMOTE_LEASE_RECEIPT_REQUIRED"
          : "REMOTE_LEASE_AUTHORITY_EXPANSION")
    );
  }
});

test("A2A cancellation revokes the exact remote lease without waiting for remote completion", async () => {
  let grantProjection: any = null;
  let remoteCreatedResolve!: () => void;
  const remoteCreated = new Promise<void>((resolve) => { remoteCreatedResolve = resolve; });
  const controller = new AbortController();

  const fetchImpl: typeof fetch = async (_input: any, init?: any) => {
    if (String(init?.method ?? "GET") === "GET") return json(card(true));
    const body = JSON.parse(String(init?.body));
    if (body.method === "SendMessage") {
      grantProjection = body.params.message.metadata[REMOTE_LEASE_A2A_EXTENSION_URI];
      remoteCreatedResolve();
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          task: {
            id: "remote-cancel-lease",
            status: { state: "TASK_STATE_WORKING" }
          }
        }
      });
    }
    if (body.method === "CancelTask") {
      assert.equal(
        body.params.metadata[REMOTE_LEASE_A2A_EXTENSION_URI].remote_lease_id,
        grantProjection.remote_lease_id
      );
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          id: "remote-cancel-lease",
          status: { state: "TASK_STATE_CANCELED" }
        }
      });
    }
    throw new Error(`Unexpected method ${body.method}`);
  };

  const { adapter, provider } = setup(fetchImpl);
  const running = adapter.execute(runtimeContext({ signal: controller.signal }));
  await remoteCreated;
  controller.abort(new Error("operator canceled remote lease task"));
  await adapter.cancel("task_a2a-lease");
  await assert.rejects(() => running, /operator canceled/i);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(provider.revokes.length, 1);
  assert.equal(provider.revokes[0]!.remoteLeaseId, "remote-a2a-lease");
});
