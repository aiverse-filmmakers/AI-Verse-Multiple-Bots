import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import process from "node:process";
import test from "node:test";
import { createGatewayServer } from "../src/server.js";
import type { BotManifest, JsonObject } from "../src/types.js";

function httpJson(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json" } }, (res: any) => {
      const chunks: string[] = [];
      res.on("data", (chunk: unknown) => chunks.push(String(chunk)));
      res.on("end", () => resolve({ status: Number(res.statusCode), body: JSON.parse(chunks.join("") || "{}") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function settleSupervisor(service: ReturnType<typeof createGatewayServer>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await service.supervisor.waitForIdle();
}

function modelBot(
  id: string,
  name: string,
  endpoint: string,
  peers: string[] = ["*"]
): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name,
    kind: "durable",
    status: "active",
    role: {
      title: name,
      mission: id === "bot_model-analyst"
        ? "Produce a concise evidence-focused first pass."
        : "Review upstream work and return a clear verification result."
    },
    runtime: {
      adapter: "openai-compatible",
      endpoint,
      model: "mock-model-v1",
      api_key_env: "AI_VERSE_MODEL_RUNTIME_TEST_KEY",
      temperature: 0,
      max_tokens: 256
    },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "ws_model" },
    permissions: { policy_ref: "default-bot", allowed_peers: peers },
    coordination: { default_mode: "direct" }
  };
}

test("installable Gateway runs two durable Bots through real HTTP model calls and passes Artifact A into Bot B", async () => {
  const requests: Array<{ authorization: string | null; body: any }> = [];
  const modelServer = createServer(async (req: any, res: any) => {
    const chunks: string[] = [];
    for await (const chunk of req) chunks.push(String(chunk));
    const body = JSON.parse(chunks.join("") || "{}") as any;
    requests.push({ authorization: req.headers?.authorization ?? null, body });

    const userContent = String(body.messages?.[1]?.content ?? "{}");
    const taskInput = JSON.parse(userContent) as any;
    const objective = String(taskInput.objective ?? "");
    let answer = "UNEXPECTED_OBJECTIVE";
    if (objective.includes("first-pass analysis")) {
      answer = "ANALYST_RESULT: revenue grew 20 percent and should be independently reviewed.";
    } else if (objective.includes("Review the analyst Artifact")) {
      const upstream = taskInput.input_artifacts?.[0]?.inline_content?.text;
      assert.match(String(upstream), /ANALYST_RESULT/);
      answer = "REVIEW_RESULT: verified the upstream Artifact and preserved its core conclusion.";
    }

    const payload = {
      id: `mock_req_${requests.length}`,
      model: "mock-model-v1",
      choices: [{ message: { role: "assistant", content: answer }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 }
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });

  const modelAddress = await new Promise<{ port: number }>((resolve, reject) => {
    modelServer.once("error", reject);
    modelServer.listen(0, "127.0.0.1", () => {
      const value = modelServer.address();
      resolve({ port: typeof value === "object" && value ? value.port : 0 });
    });
  });

  const oldKey = process.env.AI_VERSE_MODEL_RUNTIME_TEST_KEY;
  process.env.AI_VERSE_MODEL_RUNTIME_TEST_KEY = "test-secret-never-persist";
  const dbPath = `/tmp/ai-verse-model-runtime-${randomUUID()}.db`;
  const service = createGatewayServer({ dbPath, port: 0 });
  const gatewayAddress = await service.listen();
  const endpoint = `http://127.0.0.1:${modelAddress.port}/v1/chat/completions?provider_route=local-test`;

  try {
    const analystCreate = await httpJson(gatewayAddress.port, "POST", "/v1/bots", modelBot(
      "bot_model-analyst",
      "Model Analyst",
      endpoint,
      ["bot_model-reviewer"]
    ));
    const reviewerCreate = await httpJson(gatewayAddress.port, "POST", "/v1/bots", modelBot(
      "bot_model-reviewer",
      "Model Reviewer",
      endpoint
    ));
    assert.equal(analystCreate.status, 201);
    assert.equal(reviewerCreate.status, 201);

    const first = await httpJson(gatewayAddress.port, "POST", "/v1/delegations", {
      createdBy: "operator_local",
      assigneeId: "bot_model-analyst",
      workspaceId: "ws_model",
      rootObjectiveId: "obj_model_collab",
      objective: "Produce a first-pass analysis of the supplied business claim.",
      reason: "Analyst owns the first pass",
      requiredConstraints: ["Do not publish externally"],
      recoveryPolicy: "retry_safe",
      maxAttempts: 2
    });
    assert.equal(first.status, 201);
    await settleSupervisor(service);

    const firstTask = service.store.getObject(first.body.task.id);
    assert.equal(firstTask?.payload.status, "completed");
    const firstArtifactId = (firstTask?.payload.output_artifact_refs as string[])[0] as string;
    const firstArtifact = service.store.getObject(firstArtifactId);
    assert.ok(firstArtifact);
    assert.match(String((firstArtifact?.payload.inline_content as any)?.text), /ANALYST_RESULT/);
    assert.equal((firstArtifact?.payload.usage as any)?.input_tokens, 12);
    assert.equal((firstArtifact?.payload.usage as any)?.output_tokens, 7);
    const firstReceipts = firstArtifact?.payload.runtime_receipts as any[];
    assert.equal(firstReceipts[0]?.adapter, "openai-compatible");
    assert.equal(firstReceipts[0]?.protocol, "openai-compatible-chat-completions");
    assert.equal(firstReceipts[0]?.credential_source, "environment_handle");
    assert.equal(String(firstReceipts[0]?.endpoint).includes("provider_route"), false);

    const second = await httpJson(gatewayAddress.port, "POST", "/v1/delegations", {
      createdBy: "bot_model-analyst",
      assigneeId: "bot_model-reviewer",
      workspaceId: "ws_model",
      rootObjectiveId: "obj_model_collab",
      parentTaskId: first.body.task.id,
      objective: "Review the analyst Artifact, verify its conclusion, and return a concise review.",
      reason: "Independent review materially improves confidence",
      requiredConstraints: ["Do not publish externally"],
      inputArtifactRefs: [firstArtifactId],
      recoveryPolicy: "retry_safe",
      maxAttempts: 2
    });
    assert.equal(second.status, 201);
    assert.deepEqual(second.body.task.payload.input_artifact_refs, [firstArtifactId]);
    await settleSupervisor(service);

    const secondTask = service.store.getObject(second.body.task.id);
    assert.equal(secondTask?.payload.status, "completed");
    const secondArtifactId = (secondTask?.payload.output_artifact_refs as string[])[0] as string;
    const secondArtifact = service.store.getObject(secondArtifactId);
    assert.match(String((secondArtifact?.payload.inline_content as any)?.text), /REVIEW_RESULT/);
    assert.deepEqual((secondArtifact?.payload.provenance as any)?.source_refs, [firstArtifactId]);

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.authorization, "Bearer test-secret-never-persist");
    assert.equal(requests[1]?.authorization, "Bearer test-secret-never-persist");
    assert.match(String(requests[1]?.body.messages?.[1]?.content), /ANALYST_RESULT/);

    const persisted = JSON.stringify({
      tasks: service.store.listObjects("task", "ws_model"),
      artifacts: service.store.listObjects("artifact", "ws_model"),
      events: service.store.listEventsAfter(0, 1000)
    });
    assert.equal(persisted.includes("test-secret-never-persist"), false);

    const analystMailbox = service.store.listMailbox("bot_model-analyst");
    assert.ok(analystMailbox.length >= 1);
    const completionMessage = service.store.getObject(analystMailbox[analystMailbox.length - 1]?.messageId as string);
    assert.match(String((completionMessage?.payload.content as any[])?.[0]?.text), /completed/i);

    const eventTypes = service.store.listEventsAfter(0, 1000).map((entry) => entry.event.type);
    assert.ok(eventTypes.includes("task.inputs_attached"));
    assert.ok(eventTypes.includes("artifact.published"));
    assert.ok(eventTypes.includes("task.completed"));
  } finally {
    await service.close();
    await new Promise<void>((resolve, reject) => modelServer.close((error: Error | undefined) => error ? reject(error) : resolve()));
    if (oldKey === undefined) delete process.env.AI_VERSE_MODEL_RUNTIME_TEST_KEY;
    else process.env.AI_VERSE_MODEL_RUNTIME_TEST_KEY = oldKey;
  }
});

test("raw model credentials in a Bot manifest fail before network execution and produce no Artifact", async () => {
  let requests = 0;
  const modelServer = createServer((_req: any, res: any) => {
    requests += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "should not be reached" }));
  });
  const modelAddress = await new Promise<{ port: number }>((resolve, reject) => {
    modelServer.once("error", reject);
    modelServer.listen(0, "127.0.0.1", () => {
      const value = modelServer.address();
      resolve({ port: typeof value === "object" && value ? value.port : 0 });
    });
  });

  const service = createGatewayServer({ dbPath: `/tmp/ai-verse-model-secret-${randomUUID()}.db`, port: 0 });
  await service.listen();
  try {
    service.gateway.createBot({
      ...modelBot("bot_raw-secret", "Raw Secret Bot", `http://127.0.0.1:${modelAddress.port}/v1/chat/completions`),
      runtime: {
        adapter: "openai-compatible",
        endpoint: `http://127.0.0.1:${modelAddress.port}/v1/chat/completions`,
        model: "mock-model-v1",
        api_key: "must-never-be-accepted"
      }
    });
    const delegated = service.gateway.delegate({
      createdBy: "operator_local",
      assigneeId: "bot_raw-secret",
      workspaceId: "ws_model",
      rootObjectiveId: "obj_raw_secret",
      objective: "This must fail before HTTP",
      reason: "Security regression"
    });
    await service.runner.runNext("bot_raw-secret");
    const task = service.store.getObject(delegated.task.id);
    assert.equal(task?.payload.status, "failed");
    assert.equal(service.store.listObjects("artifact", "ws_model").length, 0);
    assert.equal(requests, 0);
  } finally {
    await service.close();
    await new Promise<void>((resolve, reject) => modelServer.close((error: Error | undefined) => error ? reject(error) : resolve()));
  }
});

test("HTTP delegation rejects cross-workspace input Artifacts before creating executable work", async () => {
  const service = createGatewayServer({ dbPath: `/tmp/ai-verse-artifact-scope-${randomUUID()}.db`, port: 0 });
  const address = await service.listen();
  try {
    service.gateway.createBot(modelBot("bot_scope-target", "Scope Target", "http://127.0.0.1:1/v1/chat/completions"));
    const artifact = service.gateway.record("artifact", {
      schema_version: "1.0",
      id: "art_other_workspace",
      type: "artifact",
      workspace_id: "ws_other",
      created_by: "operator_local",
      task_id: null,
      kind: "external_note",
      version: 1,
      content_ref: null,
      inline_content: { text: "other workspace data" },
      provenance: { origin: "operator_input", trusted_instruction: false, source_refs: [] }
    } as JsonObject);

    const response = await httpJson(address.port, "POST", "/v1/delegations", {
      createdBy: "operator_local",
      assigneeId: "bot_scope-target",
      workspaceId: "ws_model",
      rootObjectiveId: "obj_cross_artifact",
      objective: "Do not accept cross-workspace input",
      reason: "Workspace isolation test",
      inputArtifactRefs: [artifact.id]
    });
    assert.equal(response.status, 400);
    assert.match(String(response.body.message), /outside workspace/);
    assert.equal(
      service.store.listObjects("task", "ws_model").some((task) => task.payload.root_objective_id === "obj_cross_artifact"),
      false
    );
  } finally {
    await service.close();
  }
});
