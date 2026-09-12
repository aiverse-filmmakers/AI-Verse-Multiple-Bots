# Remote execution recovery contract

Status: Phase 4.8 implementation contract

This document defines retry, disconnect, reconnect, restart, and remote lease recovery semantics for remote runtimes in AI-Verse Multiple Bots.

It applies to A2A remote Tasks, external-managed durable Bot providers, remote Task capability leases, remote environment mappings, and Gateway restart recovery.

It does not change local Task ownership. The local coordination store and execution queue remain canonical.

## Core rule

Remote recovery may resume the same logical operation.

It may never silently create a second logical operation merely because the caller lost the response.

When the system cannot prove that replay is safe, it fails closed.

## Existing local recovery remains canonical

Phase 1 already provides durable local execution records, runner heartbeats, execution leases, stale execution detection, retry-safe requeue, dead-letter handling, and terminal reconciliation.

Phase 4.8 does not replace those mechanisms.

Instead it adds a durable remote recovery layer below runtime adapters so a requeued local Task can reconnect to the remote work it already started.

The flow is:

1. local execution lease becomes stale after process loss
2. local recovery decides whether the Task is retry-safe or must dead-letter
3. if requeued, the remote runtime reads its durable recovery checkpoint
4. the runtime resumes the same remote Task, returns a verified cached result, or safely replays only under an explicit exactly-once contract
5. the checkpoint is removed only after local Task/Artifact settlement succeeds

## Durable recovery journal

The Gateway creates a RemoteRecoveryStore in the same SQLite database used by the local runtime.

The recovery journal is internal operational state. It is not a protocol object and is never published as an Artifact.

A checkpoint is keyed by the local Task id and contains:

- runtime adapter id
- target kind and pinned target reference
- deterministic operation key
- recovery state
- remote Task/execution id when available
- remote context id when available
- minimum adapter resume metadata
- current remote lease grant when one exists
- a verified runtime result when one has already been received

Recovery identity is immutable.

A checkpoint cannot be reused with another adapter, another remote target, or another deterministic operation key.

## Recovery states

### submitting

The local caller was about to submit, or may have submitted, the remote operation but does not yet have a durable remote Task id.

This is the dangerous ambiguity window.

Replaying from this state requires an explicit remote exactly-once contract.

### remote_active

The remote side returned a durable remote Task id.

A2A recovery resumes with GetTask using that exact server-issued Task id.

It does not send a new Task-creation message.

### completed

The remote result was fully validated and cached locally, but local Task/Artifact settlement may not yet have committed.

A retry returns the cached result without contacting the remote provider.

The runtime checkpoint is removed only after the local coordination commit succeeds.

This closes the crash window between remote completion and local Artifact publication.

## Deterministic operation key

Each remote operation receives a deterministic SHA-256 operation key bound to:

- recovery contract version
- adapter id
- local Task id
- pinned remote target reference

Changing the remote target changes the operation key.

The operation key is recovery metadata, not an authority grant.

## A2A retry and reconnect

A2A v1.0 makes GetTask naturally idempotent, while SendMessage is only optionally idempotent. Reusing messageId may help a remote agent deduplicate, but the base protocol does not require it.

Therefore the adapter uses different rules for the two operations.

### Safe operations

The adapter may retry with bounded exponential backoff:

- GetTask
- CancelTask

Transient HTTP retry status codes are 408, 425, 429, 500, 502, 503, and 504.

Runtime retry controls:

- remote_retry_max_attempts: default 3, allowed 1 through 5
- remote_retry_base_delay_ms: default 100, allowed 25 through 5000

### SendMessage ambiguity

A disconnected SendMessage is never blindly repeated under the base A2A contract.

For safe replay the Agent Card must advertise:

https://github.com/aiverse-filmmakers/AI-Verse-Multiple-Bots/extensions/remote-task-recovery/v1

When that extension is present, the adapter sends a stable local Task id, stable A2A messageId, stable deterministic operation key, and the recovery extension URI.

The recovery extension contract requires the remote agent to treat repeated submission of the same operation key as one logical operation.

The remote agent must return the existing Task/result rather than start duplicate work.

If a submitting checkpoint exists and the remote agent does not advertise this extension, execution fails with an ambiguous-submission error.

That is intentional.

## A2A Task resume

Once a server-issued remote Task id exists, Gateway restart recovery uses GetTask for that exact id.

The adapter:

1. rediscovers and revalidates the Agent Card
2. revalidates the pinned remote machine/authentication path when configured
3. restores the durable remote Task id
4. restores or reacquires remote authority as allowed
5. polls GetTask
6. validates the final remote lease receipt when remote authority was granted
7. caches the verified result before returning it to the local runner

No new Task is created during this resume path.

## External-managed provider recovery

External-managed providers already receive a stable idempotency key in the form aiverse:<local-task-id>.

Phase 4.8 adds an explicit provider declaration:

idempotency_mode: exact_task_key

This declaration means repeated execute calls with the same local Task id/idempotency key refer to one logical provider execution and cannot duplicate side effects.

A provider that declares exact_task_key may receive bounded retries after a transient execution failure.

A provider that omits the field or declares best_effort receives only one execution attempt.

If a durable submitting checkpoint is recovered after restart, automatic replay is allowed only for an exact_task_key provider.

Otherwise the adapter fails closed with an ambiguous-submission error.

Inspection is read-only and may be retried independently.

## Cancellation after restart

Remote cancellation is no longer dependent only on an in-memory active-execution map.

The recovery journal preserves enough non-secret routing metadata to reconnect cancellation after a Gateway restart.

A2A cancellation can restore the remote Task id, selected A2A interface, protocol version, tenant, pinned machine reference, opaque auth binding reference, and negotiated recovery/lease extensions.

External-managed cancellation can restore the provider id, managed Bot reference, and expected binding fingerprint.

Local cancellation remains authoritative even if the remote provider cannot be reached.

## Stale execution and dead-letter behavior

If local stale-execution recovery decides that a Task is not replay-safe and sends it to the dead letter queue, the supervisor also asks the runtime adapter to cancel any durable remote recovery state for that Task.

Remote cancellation failure does not reverse local dead-letter recovery.

Remote lease revocation remains durable through the revocation queue.

## Recovered lease validation

A remote lease restored from the journal is not trusted merely because it was once valid.

Before reuse it is checked against current canonical local state:

- provider must still be registered
- local capability lease must still be active
- local environment lease must still be active when required
- local Task deadline must still permit execution
- recovered tools must remain a subset of current tools
- recovered connections must remain a subset of current connections
- destructive-action policy cannot become wider
- environment authority cannot appear when the local environment lease disappeared
- environment policy must still match
- recovered remote lease must still be active
- recovered expiry cannot exceed current local effective expiry

## Lease reacquisition and renewal

If a recovered remote lease has expired, a new grant may be acquired only when the remote execution has safe recovery semantics.

A replacement grant must preserve the exact effective tool set, connection set, destructive-action policy, environment policy, and remote environment reference.

It may change the remote lease id, grant fingerprint, request binding, and expiry.

The replacement expiry must extend beyond the previous grant expiry while still remaining inside current local canonical authority.

For long-running A2A Tasks that advertise the recovery extension, the adapter can reacquire a replacement before expiry.

Runtime control:

- remote_lease_renewal_margin_ms: default 5000, allowed 250 through 60000

The new grant is sent on the recovery-aware GetTask path. The previous grant is then revoked.

A provider cannot use renewal to swap environments or widen authority.

## Durable failed-revocation reconciliation

Before a recovery-aware runtime attempts a remote lease revoke, it creates a deterministic durable revocation record.

If revoke succeeds, the record is removed.

If revoke fails, the record remains, attempt count is incremented, and only a normalized error code is retained.

The Gateway reconciles pending revocations on startup, every five seconds while running, and once during orderly shutdown.

Duplicate queueing of the same revoke produces one durable record.

This closes the Phase 4.7 gap where a failed best-effort revoke could be forgotten after process loss.

## Secret and provenance boundaries

The recovery journal may contain operational identifiers and opaque credential references needed to reconnect.

It must not contain raw secrets.

Raw credentials remain owned by the host-injected authentication/provider layer.

Recovery state is never copied into normal Task Artifacts.

Public runtime receipts continue to use bounded provenance and do not expose granted tool names, granted connection names, managed profile refs, binding fingerprints, raw recovery routing data, or raw credentials.

The SQLite coordination database therefore remains trusted local operational storage and must be protected accordingly.

## Exactly-once claim boundary

Phase 4.8 does not claim that every arbitrary remote system is exactly once.

It guarantees something narrower and enforceable:

- known remote Task ids are resumed, not recreated
- completed verified results are replayed locally from cache
- ambiguous remote submissions are replayed only when the remote endpoint explicitly promises exact-key semantics
- otherwise the system fails closed

This means AI-Verse Multiple Bots does not trade duplicate side effects for convenience.

## Still out of scope

Phase 4.8 does not add Dashboard or environment takeover UI, Telegram/Discord bridges, installer/onboarding work, arbitrary provider failover, cross-provider migration of a live remote Task, relaxed authority after lease expiry, automatic operator approval for unsafe replay, or persistent provider secrets in the recovery database.
