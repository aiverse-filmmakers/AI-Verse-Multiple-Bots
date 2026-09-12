import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import test from "node:test";
import {
  RemoteRecoveryStore,
  remoteOperationKey
} from "../src/remote-recovery.js";
import {
  RemoteLeaseBroker,
  RemoteLeaseProviderRegistry,
  type RemoteLeaseGrant,
  type RemoteLeaseGrantRequest,
  type RemoteLeaseProvider,
  type RemoteLeaseRevokeRequest
} from "../src/remote-leases.js";

const grant: RemoteLeaseGrant = {
  provider: "recovery-provider",
  remote_lease_id: "remote-lease-1",
  request_digest: "a".repeat(64),
  grant_fingerprint: "grant:v1",
  expires_at: "2030-01-01T00:00:00Z",
  granted_tools: ["web.search"],
  granted_connections: [],
  destructive_actions: "deny",
  environment: null
};

class RevokeProvider implements RemoteLeaseProvider {
  readonly id = "recovery-provider";
  revokeCalls: RemoteLeaseRevokeRequest[] = [];
  fail = false;

  async grant(_request: RemoteLeaseGrantRequest): Promise<RemoteLeaseGrant> {
    return grant;
  }

  async revoke(request: RemoteLeaseRevokeRequest): Promise<void> {
    this.revokeCalls.push(request);
    if (this.fail) throw new Error("provider unavailable");
  }
}

function fixture() {
  const dbPath = `/tmp/remote-recovery-${randomUUID()}.db`;
  const store = new RemoteRecoveryStore(dbPath);
  return { dbPath, store };
}

function cleanup(dbPath: string): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

test("remote recovery journal survives restart and preserves an exact remote Task handle", () => {
  const { dbPath, store } = fixture();
  try {
    const operationKey = remoteOperationKey("a2a", "task-1", "machine-1");
    store.begin({
      localTaskId: "task-1",
      adapterId: "a2a",
      targetKind: "machine",
      targetRef: "machine-1",
      operationKey,
      resume: { agent_card_url: "https://agent.example/card" },
      leaseGrant: grant
    });
    store.markRemoteActive("task-1", "remote-task-7", {
      remoteContextId: "remote-context-3",
      resume: { rpc_url: "https://agent.example/rpc" },
      leaseGrant: grant
    });
    store.close();

    const reopened = new RemoteRecoveryStore(dbPath);
    try {
      const checkpoint = reopened.get("task-1");
      assert.equal(checkpoint?.state, "remote_active");
      assert.equal(checkpoint?.remoteOperationId, "remote-task-7");
      assert.equal(checkpoint?.remoteContextId, "remote-context-3");
      assert.equal(checkpoint?.operationKey, operationKey);
      assert.equal(checkpoint?.leaseGrant?.remote_lease_id, "remote-lease-1");
      assert.equal(checkpoint?.resume.rpc_url, "https://agent.example/rpc");
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(dbPath);
  }
});

test("completed remote result is durably cached until local settlement clears it", () => {
  const { dbPath, store } = fixture();
  try {
    store.begin({
      localTaskId: "task-result",
      adapterId: "external-managed",
      targetKind: "managed_profile",
      targetRef: "provider::profile",
      operationKey: remoteOperationKey("external-managed", "task-result", "provider::profile")
    });
    store.complete("task-result", {
      summary: "Recovered result",
      artifactKind: "external_managed_task_result",
      output: { value: 42 },
      usage: { actions: 1 },
      receipts: [{ kind: "remote_recovery_test" }]
    }, { leaseGrant: grant });

    const checkpoint = store.get("task-result");
    assert.equal(checkpoint?.state, "completed");
    assert.equal(checkpoint?.result?.summary, "Recovered result");
    assert.equal(checkpoint?.result?.output.value, 42);

    store.clear("task-result");
    assert.equal(store.get("task-result"), null);
  } finally {
    store.close();
    cleanup(dbPath);
  }
});

test("one local Task cannot silently drift to another remote recovery identity", () => {
  const { dbPath, store } = fixture();
  try {
    store.begin({
      localTaskId: "task-drift",
      adapterId: "a2a",
      targetKind: "machine",
      targetRef: "machine-a",
      operationKey: remoteOperationKey("a2a", "task-drift", "machine-a")
    });
    assert.throws(() => store.begin({
      localTaskId: "task-drift",
      adapterId: "a2a",
      targetKind: "machine",
      targetRef: "machine-b",
      operationKey: remoteOperationKey("a2a", "task-drift", "machine-b")
    }), /identity drift/i);
  } finally {
    store.close();
    cleanup(dbPath);
  }
});

test("failed lease revocation remains durable and is reconciled later without duplicating identity", async () => {
  const { dbPath, store } = fixture();
  const provider = new RevokeProvider();
  const broker = new RemoteLeaseBroker(new RemoteLeaseProviderRegistry([provider]));
  try {
    const target = { kind: "machine" as const, ref: "machine-recovery" };
    const first = store.queueRevocation("task-revoke", target, grant);
    const duplicate = store.queueRevocation("task-revoke", target, grant);
    assert.equal(first.id, duplicate.id);
    assert.equal(store.listPendingRevocations().length, 1);

    provider.fail = true;
    const failed = await store.reconcileRevocations(broker);
    assert.deepEqual(failed, { attempted: 1, revoked: 0, failed: 1 });
    assert.equal(store.listPendingRevocations()[0]?.attempts, 1);
    assert.equal(store.listPendingRevocations()[0]?.lastErrorCode, "REMOTE_LEASE_REVOKE_FAILED");

    provider.fail = false;
    const recovered = await store.reconcileRevocations(broker);
    assert.deepEqual(recovered, { attempted: 1, revoked: 1, failed: 0 });
    assert.equal(store.listPendingRevocations().length, 0);
    assert.equal(provider.revokeCalls.length, 2);
  } finally {
    store.close();
    cleanup(dbPath);
  }
});

test("remote operation key is deterministic and target-bound", () => {
  assert.equal(
    remoteOperationKey("a2a", "task-key", "machine-a"),
    remoteOperationKey("a2a", "task-key", "machine-a")
  );
  assert.notEqual(
    remoteOperationKey("a2a", "task-key", "machine-a"),
    remoteOperationKey("a2a", "task-key", "machine-b")
  );
  assert.notEqual(
    remoteOperationKey("a2a", "task-key", "machine-a"),
    remoteOperationKey("external-managed", "task-key", "machine-a")
  );
});
