import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import {
  A2AJsonRpcRuntimeAdapter,
  A2ARuntimeError
} from "../src/a2a-runtime.js";
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
    createdAt: "2026-09-12T18:00:00Z",
    updatedAt: "2026-09-12T18:00:00Z"
  };
}

function context(
  runtime: JsonObject = {
    adapter: "a2a",
    agent_card_url: "https://agent.example/.well-known/agent-card.json",
    poll_interval_ms: 25
  },
  principalKind: "bot" | "worker" = "bot",
  signal = new AbortController().signal
): RuntimeExecutionContext {
  const principal = principalKind === "bot"
    ? stored("bot_remote", "bot", "ws-a2a", {
        schema_version: "1.0",
        id: "bot_remote",
        name: "Remote teammate",
        kind: "durable",
        status: "active",
        role: { title: "Remote analyst", mission: "Complete delegated work." },
        runtime,
        execution: { environment_policy: "external_managed" },
        scope: { type: "workspace", workspace_id: "ws-a2a" },
        permissions: { policy_ref: "default-bot" },
        coordination: {}
      })
    : stored("worker_remote", "worker", "ws-a2a", {
        schema_version: "1.0",
        id: "worker_remote",
        type: "worker",
        kind: "temporary",
        run_id: "run_a2a",
        parent_owner_id: "bot_leader",
        workspace_id: "ws-a2a",
        role: { title: "Remote worker", objective: "Complete bounded remote work." },
        runtime,
        status: "ready"
      });

  return {
    principal,
    principalKind,
    ...(principalKind === "bot" ? { bot: principal as any } : {}),
    runtime,
    task: stored("task_local", "task", "ws-a2a", {
      schema_version: "1.0",
      id: "task_local",
      type: "task.delegate",
      workspace_id: "ws-a2a",
      created_by: "bot_leader",
      assignee_id: principal.id,
      owner_id: principal.id,
      root_objective_id: "root:a2a",
      objective: "Analyze the supplied evidence and return a concise result.",
      required_constraints: ["Do not widen authority"],
      expected_output: { contract: "analysis-v1" },
      input_artifact_refs: [],
      lease_id: "lease_a2a",
      environment_lease_id: null,
      deadline_at: null,
      budget: {},
      hop: 0,
      max_hops: 6,
      status: "running",
      ...(principalKind === "worker" ? { run_id: "run_a2a" } : {})
    }),
    capabilityLease: stored("lease_a2a", "capability_lease", "ws-a2a", {
      schema_version: "1.0",
      id: "lease_a2a",
      type: "capability_lease",
      principal: principal.id,
      issued_to: principal.id,
      workspace_id: "ws-a2a",
      task_id: "task_local",
      tools: [],
      connections: [],
      destructive_actions: "deny",
      expires_at: "2030-01-01T00:00:00Z"
    }),
    environmentLease: null,
    inputArtifacts: [
      stored("artifact_input", "artifact", "ws-a2a", {
        schema_version: "1.0",
        id: "artifact_input",
        type: "artifact",
        workspace_id: "ws-a2a",
        created_by: "bot_leader",
        kind: "evidence",
        version: 1,
        inline_content: { observation: "INPUT_EVIDENCE" },
        provenance: { origin: "operator", trusted_instruction: false }
      })
    ],
    workspaceProjection: {
      schema_version: "1.0",
      provider: "test-os",
      workspace_id: "ws-a2a",
      projection_digest: "a".repeat(64),
      projected_at: "2026-09-12T18:00:00Z",
      sources: [{ ref: "WORKSPACE.yaml", digest: "b".repeat(64) }],
      data: { current_state: "CURRENT_CONTEXT" }
    },
    strategicIntent: {
      schema_version: "1.0",
      provider: "test-brain",
      workspace_id: "ws-a2a",
      root_objective_id: "root:a2a",
      intent_digest: "c".repeat(64),
      data: { goal: "STRATEGIC_CONTEXT" }
    },
    historicalRecall: null,
    skillsCapabilityResolution: null,
    signal
  };
}

function card(overrides: JsonObject = {}): JsonObject {
  return {
    name: "Remote A2A Agent",
    description: "Test agent",
    supportedInterfaces: [{
      url: "https://agent.example/rpc",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0"
    }],
    version: "2.4.0",
    capabilities: {},
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills: [{ id: "analysis", name: "Analysis", description: "Analyze", tags: ["analysis"] }],
    ...overrides
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("A2A v1 direct Message execution discovers Agent Card, preserves local identity, and returns bounded provenance", async () => {
  const requests: Array<{ url: string; method: string; headers: Headers; body: any }> = [];
  const fetchImpl: typeof fetch = async (input: any, init?: any) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, method, headers, body });
    if (method === "GET") return json(card());
    return json({
      jsonrpc: "2.0",
      id: "send:task_local",
      result: {
        message: {
          messageId: "remote-message-1",
          role: "ROLE_AGENT",
          parts: [{ text: "Remote analysis complete." }]
        }
      }
    });
  };

  const adapter = new A2AJsonRpcRuntimeAdapter({ fetchImpl });
  const result = await adapter.execute(context());

  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.url, "https://agent.example/.well-known/agent-card.json");
  assert.equal(requests[1]!.url, "https://agent.example/rpc");
  assert.equal(requests[1]!.headers.get("A2A-Version"), "1.0");
  assert.equal(requests[1]!.body.method, "SendMessage");
  assert.equal(requests[1]!.body.params.message.messageId, "aiverse:task_local");
  assert.equal(requests[1]!.body.params.configuration.returnImmediately, true);
  const envelope = requests[1]!.body.params.message.parts[0].data;
  assert.equal(envelope.execution_identity.principal_id, "bot_remote");
  assert.equal(envelope.execution_identity.principal_kind, "bot");
  assert.equal(envelope.execution_identity.workspace_id, "ws-a2a");
  assert.equal(envelope.task.id, "task_local");
  assert.deepEqual(envelope.authority.tools, []);
  assert.equal(envelope.workspace_projection.data.current_state, "CURRENT_CONTEXT");
  assert.equal(envelope.strategic_intent.data.goal, "STRATEGIC_CONTEXT");
  assert.equal(envelope.input_artifacts[0].inline_content.observation, "INPUT_EVIDENCE");

  assert.equal(result.artifactKind, "a2a_message_result");
  assert.equal(result.summary, "Remote analysis complete.");
  assert.equal(result.output.execution_principal_kind, "bot");
  assert.equal(result.receipts?.[0]?.kind, "a2a_execution");
  assert.equal(result.receipts?.[0]?.protocol_version, "1.0");
  assert.equal(result.receipts?.[0]?.endpoint, "https://agent.example/rpc");
  assert.equal(JSON.stringify(result.receipts).includes("CURRENT_CONTEXT"), false);
  assert.equal(result.usage?.actions, 2);
});

test("A2A Task execution polls GetTask to completion and preserves temporary Worker identity", async () => {
  let rpcCount = 0;
  const methods: string[] = [];
  const fetchImpl: typeof fetch = async (_input: any, init?: any) => {
    const method = String(init?.method ?? "GET");
    if (method === "GET") return json(card({ defaultInputModes: ["text/plain"] }));
    rpcCount += 1;
    const body = JSON.parse(String(init?.body));
    methods.push(body.method);
    if (body.method === "SendMessage") {
      const textEnvelope = JSON.parse(body.params.message.parts[0].text);
      assert.equal(textEnvelope.execution_identity.principal_id, "worker_remote");
      assert.equal(textEnvelope.execution_identity.principal_kind, "worker");
      return json({
        jsonrpc: "2.0",
        id: "send:task_local",
        result: {
          task: {
            id: "remote-task-7",
            contextId: "remote-context-3",
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
        id: "remote-task-7",
        contextId: "remote-context-3",
        status: { state: "TASK_STATE_COMPLETED" },
        artifacts: [{
          artifactId: "remote-artifact-1",
          name: "analysis",
          parts: [
            { data: { conclusion: "REMOTE_RESULT" }, mediaType: "application/json" },
            { text: "Verified remote result." }
          ]
        }]
      }
    });
  };

  const adapter = new A2AJsonRpcRuntimeAdapter({
    fetchImpl,
    sleepImpl: async () => undefined
  });
  const result = await adapter.execute(context(undefined, "worker"));

  assert.deepEqual(methods, ["SendMessage", "GetTask"]);
  assert.equal(rpcCount, 2);
  assert.equal(result.artifactKind, "a2a_task_result");
  assert.equal(result.summary, "Verified remote result.");
  assert.equal(result.output.remote_task_id, "remote-task-7");
  assert.equal(result.output.remote_context_id, "remote-context-3");
  assert.equal(result.output.execution_principal_kind, "worker");
  assert.equal(result.receipts?.[0]?.remote_artifact_count, 1);
  assert.equal(result.usage?.actions, 3);
});

test("A2A adapter fails closed for authentication, required extensions, and unsupported interfaces", async () => {
  for (const [variant, code] of [
    [{ securityRequirements: [{ bearer: [] }] }, "A2A_AUTH_BINDING_REQUIRED"],
    [{ capabilities: { extensions: [{ uri: "https://example/ext", required: true }] } }, "A2A_REQUIRED_EXTENSION_UNSUPPORTED"],
    [{ supportedInterfaces: [{ url: "https://agent.example/rest", protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }] }, "A2A_INTERFACE_UNSUPPORTED"],
    [{ supportedInterfaces: [{ url: "https://agent.example/rpc", protocolBinding: "JSONRPC", protocolVersion: "0.3" }] }, "A2A_INTERFACE_UNSUPPORTED"]
  ] as const) {
    const fetchImpl: typeof fetch = async () => json(card(variant as JsonObject));
    const adapter = new A2AJsonRpcRuntimeAdapter({ fetchImpl });
    await assert.rejects(
      () => adapter.execute(context()),
      (error: unknown) => error instanceof A2ARuntimeError && error.code === code
    );
  }

  const adapter = new A2AJsonRpcRuntimeAdapter({ fetchImpl: async () => json(card()) });
  for (const [field, value] of [
    ["api_key_env", "SECRET_ENV"],
    ["bearer_token", "SECRET_TOKEN"],
    ["authorization", "Bearer SECRET"],
    ["remote_headers", { authorization: "Bearer SECRET" }],
    ["cookie", "session=secret"],
    ["password", "secret"],
    ["client_secret", "secret"]
  ] as const) {
    await assert.rejects(
      () => adapter.execute(context({
        adapter: "a2a",
        agent_card_url: "https://agent.example/card",
        [field]: value
      })),
      (error: unknown) => error instanceof A2ARuntimeError && error.code === "A2A_INLINE_CREDENTIALS_FORBIDDEN"
    );
  }
});

test("A2A interrupted and failed remote states are never converted into successful local Artifacts", async () => {
  for (const [state, code] of [
    ["TASK_STATE_INPUT_REQUIRED", "A2A_INPUT_REQUIRED"],
    ["TASK_STATE_AUTH_REQUIRED", "A2A_AUTH_REQUIRED"],
    ["TASK_STATE_REJECTED", "A2A_REMOTE_REJECTED"],
    ["TASK_STATE_FAILED", "A2A_REMOTE_FAILED"],
    ["TASK_STATE_CANCELED", "A2A_REMOTE_CANCELED"]
  ] as const) {
    const fetchImpl: typeof fetch = async (_input: any, init?: any) => {
      if (String(init?.method ?? "GET") === "GET") return json(card());
      const body = JSON.parse(String(init?.body));
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          task: {
            id: "remote-terminal",
            status: {
              state,
              message: {
                messageId: "status-message",
                role: "ROLE_AGENT",
                parts: [{ text: `Remote state ${state}` }]
              }
            }
          }
        }
      });
    };
    const adapter = new A2AJsonRpcRuntimeAdapter({ fetchImpl });
    await assert.rejects(
      () => adapter.execute(context()),
      (error: unknown) => error instanceof A2ARuntimeError && error.code === code
    );
  }
});

test("local cancellation attempts A2A CancelTask after the remote task id is known", async () => {
  let remoteCreatedResolve!: () => void;
  const remoteCreated = new Promise<void>((resolve) => { remoteCreatedResolve = resolve; });
  const calls: string[] = [];
  const cancelBodies: any[] = [];

  const fetchImpl: typeof fetch = async (_input: any, init?: any) => {
    if (String(init?.method ?? "GET") === "GET") return json(card());
    const body = JSON.parse(String(init?.body));
    calls.push(body.method);
    if (body.method === "SendMessage") {
      remoteCreatedResolve();
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          task: {
            id: "remote-cancel-me",
            contextId: "ctx-cancel",
            status: { state: "TASK_STATE_WORKING" }
          }
        }
      });
    }
    if (body.method === "CancelTask") {
      cancelBodies.push(body);
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          id: "remote-cancel-me",
          contextId: "ctx-cancel",
          status: { state: "TASK_STATE_CANCELED" }
        }
      });
    }
    throw new Error(`Unexpected method ${body.method}`);
  };

  const adapter = new A2AJsonRpcRuntimeAdapter({
    fetchImpl,
    sleepImpl: async (_ms, signal) => await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    })
  });

  const running = adapter.execute(context());
  await remoteCreated;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await adapter.cancel("task_local");
  await assert.rejects(() => running, /canceled/i);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.includes("CancelTask"), true);
  assert.equal(cancelBodies.length >= 1, true);
  assert.equal(cancelBodies[0].params.id, "remote-cancel-me");
  assert.equal(cancelBodies[0].params.metadata.source, "ai-verse-multiple-bots");
});

test("A2A adapter validates JSON-RPC response identity instead of accepting mismatched responses", async () => {
  const fetchImpl: typeof fetch = async (_input: any, init?: any) => {
    if (String(init?.method ?? "GET") === "GET") return json(card());
    return json({
      jsonrpc: "2.0",
      id: "wrong-request-id",
      result: { message: { messageId: "x", role: "ROLE_AGENT", parts: [{ text: "bad" }] } }
    });
  };
  const adapter = new A2AJsonRpcRuntimeAdapter({ fetchImpl });
  await assert.rejects(
    () => adapter.execute(context()),
    (error: unknown) => error instanceof A2ARuntimeError && error.code === "A2A_INVALID_RESPONSE"
  );
});


test("Gateway registers the A2A adapter as a normal host-neutral runtime", async () => {
  const dbPath = `/tmp/a2a-runtime-server-${Date.now()}-${Math.random().toString(16).slice(2)}.db`;
  const service = createGatewayServer({ dbPath, port: 0 });
  await service.listen();
  await service.supervisor.waitForIdle();
  try {
    assert.equal(service.runtimes.has("a2a"), true);
    assert.equal(service.runtimes.get("a2a").id, "a2a");
  } finally {
    await service.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
  }
});
