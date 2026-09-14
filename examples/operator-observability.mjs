import { createGatewayServer } from "../dist/src/server.js";

const service = createGatewayServer({ dbPath: ":memory:", port: 0 });

function bot(id, role) {
  return {
    schema_version: "1.0",
    id,
    name: role,
    kind: "durable",
    status: "active",
    role: { title: role, mission: `Act as ${role}` },
    runtime: { adapter: "deterministic" },
    execution: { environment_policy: "shared_workspace" },
    scope: { type: "workspace", workspace_id: "example-workspace" },
    permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
    coordination: { default_mode: "direct" }
  };
}

service.gateway.createBot(bot("bot_requester", "Requester"));
service.gateway.createBot(bot("bot_worker", "Worker"));

const delegated = service.gateway.delegate({
  createdBy: "bot_requester",
  assigneeId: "bot_worker",
  workspaceId: "example-workspace",
  rootObjectiveId: "objective_release_example",
  objective: "Prepare a customer-facing release note",
  reason: "Demonstrate an approval-gated Task",
  approval: {
    required: true,
    reason: "External publication requires operator approval",
    action: {
      kind: "publish.external",
      summary: "Publish the release note"
    }
  }
});

if (!delegated.approval) throw new Error("Expected a pending Approval");

const address = await service.listen();
const base = `http://127.0.0.1:${address.port}`;

try {
  const attention = await (await fetch(
    base + "/v1/operator/attention?workspace=example-workspace"
  )).json();

  const decision = await (await fetch(
    base + `/v1/operator/approvals/${delegated.approval.id}/decision`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "example-workspace",
        actorId: "operator_release_example",
        decision: "approve"
      })
    }
  )).json();

  const observability = await (await fetch(
    base + "/v1/observability/snapshot?workspace=example-workspace"
  )).json();

  console.log(JSON.stringify({
    example: "operator-observability",
    attention_top: attention.items[0]?.state ?? null,
    decision: decision.decision,
    approval_status: decision.approval_status,
    observability_provider: observability.provider,
    observability_owns_truth: observability.observability_owns_truth,
    canonical_telemetry_owner: observability.canonical_telemetry_owner,
    canonical_cost_truth_owner: observability.canonical_cost_truth_owner,
    token_projection_interface: observability.token_projection_interface,
    runtime_usage_is_canonical_token_truth: observability.runtime_usage_is_canonical_token_truth
  }, null, 2));
} finally {
  await service.close();
}
