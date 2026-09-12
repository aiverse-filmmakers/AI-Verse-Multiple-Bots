import assert from "node:assert/strict";
import test from "node:test";
import {
  RemoteLeaseBroker,
  RemoteLeaseError,
  RemoteLeaseProviderRegistry,
  type RemoteLeaseGrant,
  type RemoteLeaseGrantRequest,
  type RemoteLeaseProvider,
  type RemoteLeaseRevokeRequest
} from "../src/remote-leases.js";
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

function context(options: {
  tools?: string[];
  connections?: string[];
  destructiveActions?: string;
  environment?: boolean;
  capabilityPatch?: JsonObject;
  environmentPatch?: JsonObject;
  signal?: AbortSignal;
} = {}): RuntimeExecutionContext {
  const principal = stored("bot_remote-lease", "bot", "ws_remote-lease", {
    schema_version: "1.0",
    id: "bot_remote-lease",
    name: "Remote Lease Bot",
    kind: "durable",
    status: "active",
    role: { title: "Remote worker", mission: "Execute bounded remote work." },
    runtime: { adapter: "a2a" },
    execution: { environment_policy: "external_managed" },
    scope: { type: "workspace", workspace_id: "ws_remote-lease" },
    permissions: { policy_ref: "default-bot" },
    coordination: {}
  });
  const task = stored("task_remote-lease", "task", "ws_remote-lease", {
    schema_version: "1.0",
    id: "task_remote-lease",
    type: "task.delegate",
    created_by: "operator_local",
    assignee_id: principal.id,
    owner_id: principal.id,
    workspace_id: "ws_remote-lease",
    root_objective_id: "obj_remote-lease",
    reason: "Remote lease acceptance",
    objective: "Perform bounded remote work",
    required_constraints: [],
    expected_output: {},
    input_artifact_refs: [],
    lease_id: "lease_remote-lease",
    environment_lease_id: options.environment ? "envlease_remote-lease" : null,
    deadline_at: "2029-01-01T00:00:00Z",
    budget: {},
    hop: 0,
    max_hops: 6,
    status: "running"
  });
  const capabilityLease = stored("lease_remote-lease", "capability_lease", "ws_remote-lease", {
    schema_version: "1.0",
    id: "lease_remote-lease",
    type: "capability_lease",
    principal: "operator_local",
    issued_to: principal.id,
    workspace_id: "ws_remote-lease",
    task_id: task.id,
    tools: options.tools ?? ["web.search", "docs.read"],
    connections: options.connections ?? ["drive.read"],
    destructive_actions: options.destructiveActions ?? "deny",
    expires_at: "2029-06-01T00:00:00Z",
    ...(options.capabilityPatch ?? {})
  });
  const environmentLease = options.environment
    ? stored("envlease_remote-lease", "environment_lease", "ws_remote-lease", {
        schema_version: "1.0",
        id: "envlease_remote-lease",
        type: "environment_lease",
        issued_to: principal.id,
        workspace_id: "ws_remote-lease",
        task_id: task.id,
        environment_policy: "isolated_run",
        environment_ref: "env_local_trusted",
        expires_at: "2029-03-01T00:00:00Z",
        ...(options.environmentPatch ?? {})
      })
    : null;

  return {
    principal,
    principalKind: "bot",
    bot: principal as any,
    runtime: principal.payload.runtime as JsonObject,
    task,
    capabilityLease,
    environmentLease,
    inputArtifacts: [],
    historicalRecall: null,
    skillsCapabilityResolution: null,
    signal: options.signal ?? new AbortController().signal
  };
}

class FakeLeaseProvider implements RemoteLeaseProvider {
  readonly id = "fake-lease";
  grants: RemoteLeaseGrantRequest[] = [];
  revokes: RemoteLeaseRevokeRequest[] = [];
  patch: Partial<RemoteLeaseGrant> = {};
  hold = false;
  throwGrant = false;

  async grant(request: RemoteLeaseGrantRequest): Promise<RemoteLeaseGrant> {
    this.grants.push(request);
    if (this.throwGrant) throw new Error("SECRET_TOKEN=provider-secret https://internal.private");
    if (this.hold) return await new Promise<RemoteLeaseGrant>(() => {});
    return {
      provider: this.id,
      remote_lease_id: "remote-lease-1",
      request_digest: request.requestDigest,
      grant_fingerprint: "grant:v1",
      expires_at: request.expiresAt,
      granted_tools: [...request.allowedTools],
      granted_connections: [...request.allowedConnections],
      destructive_actions: request.destructiveActions,
      environment: request.environment
        ? {
            environment_policy: request.environment.environment_policy,
            remote_environment_ref: "remote-env-1"
          }
        : null,
      ...this.patch
    };
  }

  async revoke(request: RemoteLeaseRevokeRequest): Promise<void> {
    this.revokes.push(request);
  }
}

function broker(provider = new FakeLeaseProvider()): {
  provider: FakeLeaseProvider;
  broker: RemoteLeaseBroker;
} {
  return {
    provider,
    broker: new RemoteLeaseBroker(new RemoteLeaseProviderRegistry([provider]))
  };
}

function assertCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof RemoteLeaseError && error.code === code;
}

test("remote lease grant is task-bound, deterministic and no broader than local authority", async () => {
  const { provider, broker: remote } = broker();
  const grant = await remote.grant(
    "fake-lease",
    context(),
    { kind: "machine", ref: "machine_research" }
  );

  assert.equal(provider.grants.length, 1);
  const request = provider.grants[0]!;
  assert.equal(request.localTaskId, "task_remote-lease");
  assert.equal(request.principalId, "bot_remote-lease");
  assert.equal(request.workspaceId, "ws_remote-lease");
  assert.deepEqual(request.allowedTools, ["docs.read", "web.search"]);
  assert.deepEqual(request.allowedConnections, ["drive.read"]);
  assert.equal(request.target.kind, "machine");
  assert.equal(request.target.ref, "machine_research");
  assert.equal(request.environment, null);
  assert.match(request.requestDigest, /^[a-f0-9]{64}$/);

  assert.equal(grant.request_digest, request.requestDigest);
  assert.deepEqual(grant.granted_tools, ["docs.read", "web.search"]);
  assert.deepEqual(grant.granted_connections, ["drive.read"]);
  assert.equal(grant.environment, null);
  assert.equal(Date.parse(grant.expires_at), Date.parse("2029-01-01T00:00:00Z"));
});

test("remote provider may narrow authority but can never expand tools, connections, destructive policy or expiry", async () => {
  {
    const provider = new FakeLeaseProvider();
    provider.patch = { granted_tools: ["web.search"], granted_connections: [] };
    const remote = broker(provider).broker;
    const grant = await remote.grant("fake-lease", context(), { kind: "machine", ref: "machine" });
    assert.deepEqual(grant.granted_tools, ["web.search"]);
    assert.deepEqual(grant.granted_connections, []);
  }

  for (const [patch, code] of [
    [{ granted_tools: ["web.search", "admin.delete"] }, "REMOTE_LEASE_AUTHORITY_EXPANSION"],
    [{ granted_connections: ["drive.write"] }, "REMOTE_LEASE_AUTHORITY_EXPANSION"],
    [{ destructive_actions: "allow" }, "REMOTE_LEASE_AUTHORITY_EXPANSION"],
    [{ expires_at: "2029-01-01T00:00:01Z" }, "REMOTE_LEASE_EXPIRY_EXPANSION"]
  ] as const) {
    const provider = new FakeLeaseProvider();
    provider.patch = patch as any;
    await assert.rejects(
      () => broker(provider).broker.grant("fake-lease", context(), { kind: "machine", ref: "machine" }),
      assertCode(code)
    );
  }
});

test("remote lease binds a trusted local environment to one provider-issued remote environment", async () => {
  const { provider, broker: remote } = broker();
  const grant = await remote.grant(
    "fake-lease",
    context({ environment: true }),
    { kind: "machine", ref: "machine_research" }
  );

  const request = provider.grants[0]!;
  assert.equal(request.environment?.local_lease_id, "envlease_remote-lease");
  assert.equal(request.environment?.environment_policy, "isolated_run");
  assert.equal(request.environment?.local_environment_ref, "env_local_trusted");
  assert.equal(grant.environment?.environment_policy, "isolated_run");
  assert.equal(grant.environment?.remote_environment_ref, "remote-env-1");
  assert.equal(Date.parse(grant.expires_at), Date.parse("2029-01-01T00:00:00Z"));

  const audit = remote.verifyReceipt(grant, {
    remote_lease_id: grant.remote_lease_id,
    request_digest: grant.request_digest,
    grant_fingerprint: grant.grant_fingerprint,
    observed_tools: ["web.search"],
    observed_connections: ["drive.read"],
    environment_ref: "remote-env-1",
    state: "honored"
  });
  assert.equal(audit.environmentVerified, true);
  assert.equal(audit.observedToolCount, 1);
  assert.equal(audit.observedConnectionCount, 1);
});

test("remote environment authority cannot appear without a local environment lease or change policy/ref", async () => {
  {
    const provider = new FakeLeaseProvider();
    provider.patch = {
      environment: {
        environment_policy: "isolated_run",
        remote_environment_ref: "remote-env"
      }
    };
    await assert.rejects(
      () => broker(provider).broker.grant("fake-lease", context(), { kind: "machine", ref: "machine" }),
      assertCode("REMOTE_LEASE_ENVIRONMENT_EXPANSION")
    );
  }
  {
    const provider = new FakeLeaseProvider();
    provider.patch = {
      environment: {
        environment_policy: "shared_workspace",
        remote_environment_ref: "remote-env"
      }
    };
    await assert.rejects(
      () => broker(provider).broker.grant(
        "fake-lease",
        context({ environment: true }),
        { kind: "machine", ref: "machine" }
      ),
      assertCode("REMOTE_LEASE_ENVIRONMENT_MISMATCH")
    );
  }
});

test("revoked or broad local leases fail before a remote provider is called", async () => {
  for (const ctx of [
    context({ capabilityPatch: { termination_revoked_at: "2026-09-13T00:01:00Z" } }),
    context({ tools: ["*"] }),
    context({ connections: ["group:all"] }),
    context({ environment: true, environmentPatch: { cleanup_revoked_at: "2026-09-13T00:01:00Z" } })
  ]) {
    const { provider, broker: remote } = broker();
    await assert.rejects(
      () => remote.grant("fake-lease", ctx, { kind: "machine", ref: "machine" }),
      (error: unknown) => error instanceof RemoteLeaseError
    );
    assert.equal(provider.grants.length, 0);
  }
});

test("grant request digest and receipt identity must match exactly", async () => {
  {
    const provider = new FakeLeaseProvider();
    provider.patch = { request_digest: "0".repeat(64) };
    await assert.rejects(
      () => broker(provider).broker.grant("fake-lease", context(), { kind: "machine", ref: "machine" }),
      assertCode("REMOTE_LEASE_BINDING_MISMATCH")
    );
  }

  const { broker: remote } = broker();
  const grant = await remote.grant("fake-lease", context(), { kind: "machine", ref: "machine" });
  for (const receipt of [
    null,
    {
      remote_lease_id: "other",
      request_digest: grant.request_digest,
      grant_fingerprint: grant.grant_fingerprint,
      observed_tools: [],
      observed_connections: [],
      state: "honored"
    },
    {
      remote_lease_id: grant.remote_lease_id,
      request_digest: grant.request_digest,
      grant_fingerprint: grant.grant_fingerprint,
      observed_tools: ["admin.delete"],
      observed_connections: [],
      state: "honored"
    }
  ]) {
    assert.throws(
      () => remote.verifyReceipt(grant, receipt),
      (error: unknown) => error instanceof RemoteLeaseError
    );
  }
});

test("transport projection contains enforcement data while persisted receipt projection is bounded", async () => {
  const { broker: remote } = broker();
  const grant = await remote.grant(
    "fake-lease",
    context({ environment: true }),
    { kind: "machine", ref: "machine" }
  );
  const transport = remote.transportProjection(grant);
  assert.deepEqual(transport.granted_tools, ["docs.read", "web.search"]);
  assert.equal((transport.environment as JsonObject).remote_environment_ref, "remote-env-1");

  const audit = remote.verifyReceipt(grant, {
    remote_lease_id: grant.remote_lease_id,
    request_digest: grant.request_digest,
    grant_fingerprint: grant.grant_fingerprint,
    observed_tools: [],
    observed_connections: [],
    environment_ref: "remote-env-1",
    state: "honored"
  });
  const receipt = remote.receiptProjection(grant, audit);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes("web.search"), false);
  assert.equal(serialized.includes("drive.read"), false);
  assert.equal(serialized.includes("remote-env-1"), false);
  assert.equal(serialized.includes(grant.remote_lease_id), false);
  assert.equal(receipt.remote_lease_verified, true);
  assert.equal(receipt.environment_verified, true);
});

test("provider grant failures are sanitized and cancellation does not depend on provider AbortSignal compliance", async () => {
  {
    const provider = new FakeLeaseProvider();
    provider.throwGrant = true;
    await assert.rejects(
      () => broker(provider).broker.grant("fake-lease", context(), { kind: "machine", ref: "machine" }),
      (error: unknown) => error instanceof RemoteLeaseError
        && error.code === "REMOTE_LEASE_PROVIDER_FAILED"
        && !error.message.includes("SECRET_TOKEN")
        && !error.message.includes("internal.private")
    );
  }

  {
    const provider = new FakeLeaseProvider();
    provider.hold = true;
    const controller = new AbortController();
    const running = broker(provider).broker.grant(
      "fake-lease",
      context({ signal: controller.signal }),
      { kind: "machine", ref: "machine" }
    );
    while (provider.grants.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("local lease cancel"));
    const outcome = await Promise.race([
      running.then(
        () => "resolved",
        (error) => error instanceof Error ? error.message : String(error)
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 100))
    ]);
    assert.equal(outcome, "local lease cancel");
  }
});

test("remote lease provider registry is explicit and duplicate-safe", () => {
  const provider = new FakeLeaseProvider();
  const registry = new RemoteLeaseProviderRegistry([provider]);
  assert.equal(registry.has("fake-lease"), true);
  assert.deepEqual(registry.ids(), ["fake-lease"]);
  assert.throws(() => registry.register(provider), assertCode("REMOTE_LEASE_PROVIDER_COLLISION"));
  assert.throws(() => registry.get("missing"), assertCode("REMOTE_LEASE_PROVIDER_NOT_REGISTERED"));
});

test("remote lease revoke targets the exact grant and target", async () => {
  const { provider, broker: remote } = broker();
  const target = { kind: "managed_profile" as const, ref: "provider::profile" };
  const grant = await remote.grant("fake-lease", context(), target);
  await remote.revoke(grant, "task_remote-lease", target);
  assert.deepEqual(provider.revokes, [{
    localTaskId: "task_remote-lease",
    target,
    remoteLeaseId: "remote-lease-1",
    grantFingerprint: "grant:v1"
  }]);
});
