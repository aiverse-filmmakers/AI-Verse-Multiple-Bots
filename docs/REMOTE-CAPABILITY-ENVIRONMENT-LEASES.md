# Remote Capability and Environment Leases

**Phase:** 4.7

**Status:** COMPLETE

## Purpose

Phase 4.7 makes remote execution authority enforceable instead of treating lease data in a prompt as a permission boundary.

The local Multiple Bots capability/environment leases remain canonical.

A host-injected remote lease provider may project that authority into a Task-scoped remote grant, but the remote grant can only be equal or narrower. A successful remote execution must return an auditable receipt proving the same grant was honored.

This slice integrates that generic lease boundary with:

- pinned remote A2A machines
- durable external-managed Bot profiles

Phase 4.7 deliberately does not add reconnect, retry, lease renewal or crash reconciliation. Those remain Phase 4.8.

## Ownership law

Multiple Bots continues to own:

- local Bot/Worker identity
- Task identity
- workspace scope
- capability lease
- environment lease
- approval state
- Task deadline
- budgets
- cancellation
- local Artifact publication

The remote lease provider owns only the translation of that already-granted local authority into a remote execution boundary.

Remote authentication from Phase 4.6 proves **who the remote peer is**.

Remote leases from Phase 4.7 prove **what that peer may use for this Task**.

Authentication never creates capability authority by itself.

## Public contracts

Phase 4.7 adds:

```text
RemoteLeaseTarget
RemoteEnvironmentProjection
RemoteLeaseGrantRequest
RemoteLeaseGrant
RemoteLeaseReceipt
RemoteLeaseRevokeRequest
RemoteLeaseProvider
RemoteLeaseProviderRegistry
RemoteLeaseBroker
RemoteLeaseAudit
RemoteLeaseError
```

A2A extension URI:

```text
https://github.com/aiverse-filmmakers/AI-Verse-Multiple-Bots/extensions/remote-task-lease/v1
```

## Local authority remains canonical

Before a remote grant is requested, the broker verifies the local capability lease:

- correct `capability_lease` object kind
- issued to the current execution principal
- scoped to the exact Task
- same workspace
- not revoked
- not expired
- exact tool references
- exact connection references
- supported destructive-action policy

The local environment lease, when present, is also verified:

- correct `environment_lease` kind
- issued to the current principal
- same workspace
- same Task when the lease is Task-specific
- active/not revoked
- valid environment policy
- trusted host-created `environment_ref`

Explicit null revocation markers remain active. A reissued lease containing `revoked_at: null` is not accidentally treated as revoked.

## Exact authority only

Remote capability projection accepts exact references only.

Groups, globs and wildcard-like references fail closed.

Examples rejected:

```text
*
group:research
github:*
drive:re?d
```

The remote provider therefore never receives an unresolved authority expression that it could interpret more broadly than Multiple Bots intended.

## Destructive-action ordering

The broker uses the restrictive ordering:

```text
deny < approval_required < allow
```

A remote provider may return an equal or more restrictive policy.

It may never return a less restrictive policy than the local capability lease.

## Effective expiry

The remote request expiry is bounded by the earliest of:

1. local capability lease expiry
2. local environment lease expiry, when present
3. Task deadline, when present

The remote provider may shorten that expiry.

It may never extend it.

A result arriving after the remote grant has expired is rejected even if its receipt otherwise matches.

## Deterministic Task binding

Every remote grant request is bound to:

- local Task id
- principal id
- principal kind
- workspace id
- remote target
- local capability lease id
- exact tools
- exact connections
- destructive-action policy
- effective expiry
- local environment projection when present

A stable canonical JSON representation is SHA-256 hashed into:

```text
request_digest
```

The remote grant must echo the exact digest.

A grant for another Task/request cannot be substituted.

## Provider identity

A host registers remote lease providers explicitly.

The provider has a stable id.

The returned grant must identify the same provider.

A mismatched provider fails with:

```text
REMOTE_LEASE_PROVIDER_MISMATCH
```

Provider registration is duplicate-safe.

## Provider error boundary

Remote lease providers may talk to:

- remote gateways
- orchestration systems
- cloud sandboxes
- container managers
- policy engines
- custom agent runtimes

Their arbitrary exceptions may contain secrets or internal endpoint details.

Unknown provider failures are normalized to bounded local errors and do not copy arbitrary provider text.

## Capability narrowing

A provider receives:

```text
allowedTools
allowedConnections
destructiveActions
```

It returns:

```text
granted_tools
granted_connections
destructive_actions
```

The grant may narrow authority.

Example:

```text
local tools:
- docs.read
- web.search

remote grant:
- web.search
```

is valid.

A remote grant containing an authority absent from the local lease fails before execution.

## Environment mapping

When a local environment lease exists, the lease provider receives a trusted host-side projection:

```json
{
  "local_lease_id": "envlease_...",
  "environment_policy": "isolated_run",
  "local_environment_ref": "trusted-host-ref",
  "expires_at": "..."
}
```

The provider maps that to an opaque remote execution environment:

```json
{
  "environment_policy": "isolated_run",
  "remote_environment_ref": "provider-owned-ref"
}
```

The policy must remain identical.

A remote environment cannot appear when no local environment lease exists.

The model never invents either environment reference.

## Environment policies

The remote lease broker understands the existing Multiple Bots policies:

```text
shared_workspace
isolated_bot
isolated_run
external_managed
```

Phase 4.7 only binds the policy/reference into remote execution.

It does not add environment preview/takeover UI.

## Remote grant transport projection

The execution runtime receives only the remote enforcement grant:

- remote lease id
- request digest
- grant fingerprint
- expiry
- granted tools
- granted connections
- destructive-action policy
- mapped remote environment, when present

The trusted local `environment_ref` does not travel to the remote agent.

## Execution envelope alignment

When a remote provider narrows authority, the normal execution envelope is rewritten to show the **effective remote grant**, not the broader local parent lease.

This prevents contradictory instructions such as:

- extension says `web.search` only
- prompt envelope says `web.search + admin.delete`

The effective envelope and enforcement grant therefore agree.

## Required execution receipt

A successful remote execution using a remote grant must return:

```text
remote_lease_id
request_digest
grant_fingerprint
observed_tools
observed_connections
environment_ref
state = honored
```

The broker verifies:

- exact remote lease id
- exact request digest
- exact grant fingerprint
- `state=honored`
- observed tools are a subset of granted tools
- observed connections are a subset of granted connections
- exact remote environment ref when an environment was granted
- no environment appears when none was granted
- grant is still unexpired at completion

Missing audit arrays fail closed even when no tools/connections were used.

## Persisted provenance

Remote execution receipts intentionally persist only bounded verification state such as:

- lease provider id
- remote lease verified
- remote lease expiry
- granted tool count
- granted connection count
- observed tool count
- observed connection count
- environment verified

They deliberately do not persist:

- remote lease id
- request digest
- grant fingerprint
- tool names
- connection names
- remote environment ref
- local environment ref
- credentials
- copied workspace/Brain/Memory/Skill content

## A2A integration

Pinned A2A remote execution now requires a remote lease when meaningful Task authority exists.

Meaningful authority means any of:

- one or more tools
- one or more connections
- destructive action policy above `deny`
- an environment lease

Meaningful A2A authority cannot be projected to an unpinned URL.

It requires the Phase 4.6 `remote_machine_ref` boundary first.

This prevents capability authority from being attached to an endpoint whose remote machine identity has not been pinned.

## A2A lease provider

Lease-aware A2A runtime configuration uses:

```json
{
  "adapter": "a2a",
  "agent_card_url": "https://agent.example/.well-known/agent-card.json",
  "remote_machine_ref": "machine_research",
  "remote_lease_provider": "lease-provider"
}
```

If meaningful authority exists and `remote_lease_provider` is absent, execution fails before remote work.

## A2A extension negotiation

A lease-aware remote Agent Card must advertise:

```text
https://github.com/aiverse-filmmakers/AI-Verse-Multiple-Bots/extensions/remote-task-lease/v1
```

under A2A capabilities/extensions.

If the Task needs a remote lease and the Agent Card does not advertise the extension, execution fails.

The extension is activated through:

```text
A2A-Extensions
```

and the structured grant is carried in namespaced message/request metadata.

The final Message or completed Task must return its lease receipt in the same namespaced metadata location.

## A2A cancellation

When a leased A2A Task is canceled:

- local cancellation remains authoritative
- the adapter best-effort sends `CancelTask`
- cancellation metadata identifies the exact remote grant
- the exact remote lease is revoked at most once

A failed remote revoke cannot reverse local cancellation.

Retrying failed revocation/reconciliation after disconnect belongs to Phase 4.8.

## A2A authority-neutral compatibility

A2A execution with no meaningful capability/environment authority can still use the existing authority-neutral path.

Once meaningful authority is present, the stronger pinned-machine + remote-lease contract is mandatory.

## External managed Bot integration

Phase 4.5 intentionally deferred external environment leases.

Phase 4.7 completes that path.

An external-managed Bot with an environment lease must declare:

```text
runtime.remote_lease_provider
```

The existing managed profile is used as the remote lease target.

The generic lease broker may narrow:

- tools
- connections
- destructive actions
- expiry

and may map the local environment lease to a provider-owned remote environment.

The managed provider receives only this effective grant.

## External managed double audit

External-managed providers already reported top-level observed tool/connection use in Phase 4.5.

When a Phase 4.7 remote lease is active:

1. the existing top-level authority audit must fit the remote grant
2. the remote lease receipt must fit the remote grant
3. both audits must agree exactly

Contradictory provider evidence fails closed.

## Gateway integration

The Gateway accepts host-injected:

```text
remoteLeaseProviders
```

and exposes:

```text
remoteLeaseProviders
remoteLeases
```

The same broker instance is injected into:

- A2A runtime
- external-managed runtime

There is intentionally no public provider/onboarding UI in this slice.

## Revocation and process failure boundary

Normal completion and cancellation best-effort revoke the exact remote grant.

The hard safety boundary is still:

- local Task state
- local lease expiry
- remote grant expiry
- local terminal-result fencing

Phase 4.7 does not persist/reconcile a remote grant across a process crash.

If the process disappears after a grant is created, the remote grant must expire according to its bounded expiry.

Reconnection, retry, lease re-acquisition and failed-revocation reconciliation are Phase 4.8 responsibilities.

## Acceptance proof

The hardened implementation head `736fe5103a3e7224c202923e7d7240a3b97d53ad` passed GitHub Actions **CI run 456 (`34719783568`) with 397/397 tests**, **0 failures, 0 canceled and 0 skipped**.

Phase 4.7 acceptance coverage proves:

1. local capability/environment leases remain the parent authority
2. remote grant requests are Task/principal/workspace/target bound
3. request digests are deterministic
4. revoked/expired local leases fail before provider execution
5. null revocation markers on reissued active leases remain valid
6. exact references are required
7. wildcard/group/glob authority fails closed
8. providers can narrow tools/connections
9. providers cannot widen tools/connections
10. destructive-action policy cannot widen
11. expiry cannot extend past local authority/deadline
12. results after remote grant expiry fail
13. provider identity must match
14. local environment refs map to provider-owned remote environment refs
15. remote environment policy cannot change
16. environment authority cannot appear without a local environment lease
17. receipt identity must match the exact grant
18. observed authority must stay inside the remote grant
19. persisted lease provenance omits authority/environment identities
20. provider failure text is sanitized
21. grant cancellation does not depend on provider AbortSignal compliance
22. A2A meaningful authority requires a pinned remote machine
23. A2A meaningful authority requires a lease provider
24. A2A lease execution requires Agent Card extension support
25. A2A execution envelope reflects narrowed remote authority
26. A2A grant metadata is namespaced and extension-activated
27. direct Message results require a matching lease receipt
28. completed remote Tasks require a matching lease receipt
29. missing/expanded A2A receipts cannot become local success
30. A2A remote environment identity is verified
31. A2A cancellation revokes the exact remote grant
32. external-managed environment leases use the same generic broker
33. external-managed provider sees only narrowed effective authority
34. external-managed environment mapping is verified
35. bad external-managed lease receipts fail closed
36. contradictory external-managed authority audits fail closed
37. Gateway host injection exposes the lease provider registry/broker
38. all pre-existing Phase 0-4.6 behavior remains green

## Non-goals

Phase 4.7 does not implement:

- retry after remote disconnect
- reconnect/resume
- remote lease renewal
- remote lease re-acquisition after restart
- failed revocation reconciliation
- exactly-once remote execution claims
- durable remote-session recovery
- remote environment preview/takeover UI
- secret persistence
- setup/onboarding UI
- Dashboard controls
- Telegram/Discord/channel bridges
- installer/product packaging

Those remain with Phase 4.8 or Phase 5.
