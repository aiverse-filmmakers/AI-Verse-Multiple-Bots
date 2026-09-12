import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import test from "node:test";
import {
  A2AJsonRpcRuntimeAdapter,
  A2ARuntimeError
} from "../src/a2a-runtime.js";
import {
  REMOTE_RECOVERY_A2A_EXTENSION_URI,
  RemoteRecoveryStore,
  remoteOperationKey
} from "../src/remote-recovery.js";
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

function context(signal = new AbortController().signal): RuntimeExecutionContext {
  const runtime: JsonObject = {
    adapter: "a2a",
    agent_card_url: "https://agent.example/.well-known/agent-card.json",
    poll_interval_ms: 25,
    remote_retry_max_attempts: 3,
    remote_retry_base_delay_ms: 25
  };
  const bot = stored("bot_remote", "bot", "ws-a2a-recovery", {
    schema_version: "1.0",
    id: "bot_remote",
    name: "Remote teammate",
    kind: "durable",
    status: "active",
    role: { title: "Remote analyst", mission: "Complete delegated work." },
    runtime,
    execution: { environment_policy: "external_managed" },
    scope: { type: "workspace", workspace_id: "ws-a2a-recovery" },
    permissions: { policy_ref: "default-bot" },
    coordination: {}
  });
  return {
    principal: bot,
    principalKind: "bot",
    bot: bot as any,
    runtime,
    task: stored("task_local", "task", "ws-a2a-recovery", {
      schema_version: "1.0",
      id: "task_local",
      type: "task.delegate",
      workspace_id: "ws-a2a-recovery",
      created_by: "bot_leader",
      assignee_id: "bot_remote",
      owner_id: "bot_remote",
      root_objective_id: "root:a2a-recovery",
      objective: "Resume safely after disconnect.",
      required_constraints: [],
      expected_output: { contract: "analysis-v1" },
      input_artifact_refs: [],
      lease_id: "lease_a2a",
      environment_lease_id: null,
      deadline_at: null,
      budget: {},
      hop: 0,
      max_hops: 6,
      status: "running"
    }),
    capabilityLease: stored("lease_a2a", "capability_lease", "ws-a2a-recovery", {
      schema_version: "1.0",
      id: "lease_a2a",
      type: "capability_lease",
      principal: "bot_remote",
      issued_to: "bot_remote",
      workspace_id: "ws-a2a-recovery",
      task_id: "task_local",
      tools: [],
      connections: [],
      destructive_actions: "deny",
      expires_at: "2030-01-01T00:00:00Z"
    }),
    environmentLease: null,
    inputArtifacts: [],
    signal
  };
}

function card(recovery = true): JsonObject {
  return {
    name: "Recovery Agent",
    version: "1.0.0",
    supportedInterfaces: [{
      url: "https://agent.example/rpc",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0"
    }],
    capabilities: recovery
      ? { extensions: [{ uri: REMOTE_RECOVERY_A2A_EXTENSION_URI, required: false }] }
      : {},
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills: []
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function fixture() {
  const dbPath = `/tmp/a2a-remote-recovery-${randomUUID()}.db`;
  return { dbPath, recovery: new RemoteRecoveryStore(dbPath) };
}

function cleanup(dbPath: string): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

const targetRef = "https://agent.example/.well-known/agent-card.json";

test("A2A restart recovery resumes a known remote Task with GetTask and never re-sends SendMessage", async () => {
  const { dbPath, recovery } = fixture();
  try {
    const operationKey = remoteOperationKey("a2a", "task_local", targetRef);
    recovery.begin({
      localTaskId: "task_local",
      adapterId: "a2a",
      targetKind: "endpoint",
      targetRef,
      operationKey
    });
    recovery.markRemoteActive("task_local", "remote-task-7", {
      remoteContextId: "remote-context-3"
    });

    const methods: string[] = [];
    const fetchImpl: typeof fetch = async (_input: any, init?: any) => {
      if (String(init?.method ?? "GET") === "GET") return json(card(true));
      const body = JSON.parse(String(init?.body));
      methods.push(body.method);
      assert.equal(body.method, "GetTask");
      assert.equal(body.params.id, "remote-task-7");
      assert.equal(
        body.params.metadata[REMOTE_RECOVERY_A2A_EXTENSION_URI].operation_key,
        operationKey
      );
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          id: "remote-task-7",
          contextId: "remote-context-3",
          status: { state: "TASK_STATE_COMPLETED" },
          artifacts: [{
            artifactId: "remote-artifact-1",
            parts: [{ data: { resumed: true }, mediaType: "application/json" }]
          }]
        }
      });
    };

    const adapter = new A2AJsonRpcRuntimeAdapter({
      fetchImpl,
      sleepImpl: async () => undefined,
      recovery
    });
    const result = await adapter.execute(context());

    assert.deepEqual(methods, ["GetTask"]);
    assert.equal(result.output.remote_task_id, "remote-task-7");
    const artifacts = result.output.artifacts as JsonObject[];
    const firstArtifact = artifacts[0] as JsonObject;
    const parts = firstArtifact.parts as JsonObject[];
    const firstPart = parts[0] as JsonObject;
    const data = firstPart.data as JsonObject;
    assert.equal(data.resumed, true);
    assert.equal(recovery.get("task_local")?.state, "completed");

    await adapter.settle("task_local");
    assert.equal(recovery.get("task_local"), null);
  } finally {
    recovery.close();
    cleanup(dbPath);
  }
});

test("A2A ambiguous SendMessage after restart fails closed when peer has no recovery extension", async () => {
  const { dbPath, recovery } = fixture();
  try {
    recovery.begin({
      localTaskId: "task_local",
      adapterId: "a2a",
      targetKind: "endpoint",
      targetRef,
      operationKey: remoteOperationKey("a2a", "task_local", targetRef)
    });
    let postCalls = 0;
    const fetchImpl: typeof fetch = async (_input: any, init?: any) => {
      if (String(init?.method ?? "GET") === "GET") return json(card(false));
      postCalls += 1;
      throw new Error("SendMessage must not be replayed");
    };
    const adapter = new A2AJsonRpcRuntimeAdapter({ fetchImpl, recovery });

    await assert.rejects(
      () => adapter.execute(context()),
      (error: unknown) => error instanceof A2ARuntimeError
        && error.code === "A2A_AMBIGUOUS_SUBMISSION"
    );
    assert.equal(postCalls, 0);
    assert.equal(recovery.get("task_local")?.state, "submitting");
  } finally {
    recovery.close();
    cleanup(dbPath);
  }
});

test("A2A negotiated recovery retries transient SendMessage with one stable logical operation", async () => {
  const { dbPath, recovery } = fixture();
  try {
    const sentMessageIds: string[] = [];
    const sentOperationKeys: string[] = [];
    let sends = 0;
    const fetchImpl: typeof fetch = async (_input: any, init?: any) => {
      if (String(init?.method ?? "GET") === "GET") return json(card(true));
      const body = JSON.parse(String(init?.body));
      assert.equal(body.method, "SendMessage");
      sends += 1;
      sentMessageIds.push(body.params.message.messageId);
      sentOperationKeys.push(
        body.params.message.metadata[REMOTE_RECOVERY_A2A_EXTENSION_URI].operation_key
      );
      assert.match(
        String(new Headers(init?.headers).get("A2A-Extensions")),
        /remote-task-recovery/
      );
      if (sends === 1) return json({ error: "temporary" }, 503);
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          message: {
            messageId: "remote-message-recovered",
            role: "ROLE_AGENT",
            parts: [{ text: "Recovered exactly once." }]
          }
        }
      });
    };

    const adapter = new A2AJsonRpcRuntimeAdapter({
      fetchImpl,
      sleepImpl: async () => undefined,
      recovery
    });
    const first = await adapter.execute(context());

    assert.equal(sends, 2);
    assert.deepEqual(sentMessageIds, ["aiverse:task_local", "aiverse:task_local"]);
    assert.equal(new Set(sentOperationKeys).size, 1);
    assert.equal(first.summary, "Recovered exactly once.");
    assert.equal(recovery.get("task_local")?.state, "completed");

    const noNetwork: typeof fetch = async () => {
      throw new Error("cached recovery result must avoid network replay");
    };
    const replacement = new A2AJsonRpcRuntimeAdapter({ fetchImpl: noNetwork, recovery });
    const cached = await replacement.execute(context());
    assert.equal(cached.summary, first.summary);
  } finally {
    recovery.close();
    cleanup(dbPath);
  }
});

test("A2A cancellation can reconnect from a durable remote Task checkpoint after restart", async () => {
  const { dbPath, recovery } = fixture();
  try {
    const operationKey = remoteOperationKey("a2a", "task_local", targetRef);
    recovery.begin({
      localTaskId: "task_local",
      adapterId: "a2a",
      targetKind: "endpoint",
      targetRef,
      operationKey,
      resume: {
        interface: {
          request_url: "https://agent.example/rpc",
          receipt_url: "https://agent.example/rpc",
          protocol_version: "1.0",
          tenant: null,
          remote_machine_ref: null,
          remote_auth: null,
          security_schemes: {},
          security_requirements: [],
          authentication_mechanism: null,
          peer_identity_kind: null,
          remote_lease_extension_supported: false,
          remote_recovery_extension_supported: true
        }
      }
    });
    recovery.markRemoteActive("task_local", "remote-task-cancel", {
      resume: recovery.get("task_local")!.resume
    });

    const methods: string[] = [];
    const fetchImpl: typeof fetch = async (_input: any, init?: any) => {
      const body = JSON.parse(String(init?.body));
      methods.push(body.method);
      assert.equal(body.method, "CancelTask");
      assert.equal(body.params.id, "remote-task-cancel");
      assert.equal(
        body.params.metadata[REMOTE_RECOVERY_A2A_EXTENSION_URI].operation_key,
        operationKey
      );
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          id: "remote-task-cancel",
          status: { state: "TASK_STATE_CANCELED" }
        }
      });
    };

    const adapter = new A2AJsonRpcRuntimeAdapter({
      fetchImpl,
      sleepImpl: async () => undefined,
      recovery
    });
    await adapter.cancel("task_local");

    assert.deepEqual(methods, ["CancelTask"]);
    assert.equal(recovery.get("task_local"), null);
  } finally {
    recovery.close();
    cleanup(dbPath);
  }
});
