# External Managed Bot Runtime

**Phase:** 4.5

**Status:** COMPLETE

## Purpose

Phase 4.5 adds a host-neutral runtime boundary for a durable Multiple Bots Bot whose execution identity already exists as a long-lived profile in another runtime.

The local Multiple Bots Bot remains canonical.

The external profile is an execution binding, not a second coordination identity.

This slice is deliberately provider-agnostic. A host injects an `ExternalManagedBotProvider` implementation that already knows how to reach and authenticate its managed runtime. Phase 4.5 does not add SSH, API-key, token, remote-machine or reconnect machinery.

## Canonical ownership

Multiple Bots continues to own:

- durable Bot identity and role metadata
- workspace scope
- Tasks and work ownership
- capability leases
- approvals
- budgets and deadlines
- cancellation
- Handoffs, Rooms and Team Runs
- local Artifact publication
- coordination events and recovery bookkeeping

The managed runtime owns only its own execution profile/session/runtime state.

Changing an external runtime profile does not silently create or replace the local teammate.

## Runtime id

```text
external-managed
```

Public adapter:

```text
ExternalManagedBotRuntimeAdapter
```

Artifact kind:

```text
external_managed_task_result
```

## Durable binding

An external managed Bot pins three runtime values:

```json
{
  "adapter": "external-managed",
  "provider": "provider-id",
  "managed_bot_ref": "opaque-persistent-profile-ref",
  "binding_fingerprint": "provider-defined-stable-binding-fingerprint"
}
```

Its execution policy must be:

```json
{
  "environment_policy": "external_managed"
}
```

The local Bot id remains the addressable teammate identity.

The external `managed_bot_ref` is opaque provider state.

The `binding_fingerprint` gives the provider a stable way to prove that the same intended persistent runtime identity/routing binding still exists.

## One external profile, one canonical Bot

The registry prevents one managed identity from backing multiple local Bots.

Across the entire local registry, both of these are unique:

- `provider + managed_bot_ref`
- `provider + binding_fingerprint`

This uniqueness is global rather than workspace-local because the external provider identity exists outside a single Multiple Bots workspace.

Archived bindings remain reserved. Archiving a teammate therefore cannot accidentally let a later Bot inherit that old runtime identity and coordination history.

## Provider injection

Phase 4.5 introduces:

```text
ExternalManagedBotProvider
ExternalManagedBotProviderRegistry
```

A provider implements:

```text
inspect()
execute()
cancel()
```

Providers are injected by the host.

The Bot manifest never contains transport credentials.

The default Gateway server accepts injected provider instances through:

```text
externalManagedProviders
```

This keeps the core package runtime-neutral and keeps remote authentication owned by the later remote-authentication slice.

## Authentication boundary

Phase 4.5 rejects inline remote transport/authentication fields, including:

- endpoint / URL / host / port
- API key fields
- bearer token fields
- Authorization
- arbitrary headers
- SSH
- WebSocket URL
- remote-machine selectors
- credential/secret references

These fail with:

```text
EXTERNAL_MANAGED_REMOTE_AUTH_OUT_OF_SCOPE
```

Remote-machine identity/authentication is Phase 4.6.

## Live identity inspection

Before every Task execution, the adapter asks the provider to inspect the pinned managed profile.

The provider must report:

```text
provider             = pinned provider
managed_bot_ref      = pinned ref
binding_fingerprint  = pinned fingerprint
availability         = ready
identity_mode        = persistent_profile
authority_mode       = exact_task_lease
output_mode          = visible_result_only
supports_cancel      = true
```

Any mismatch fails before delegated work.

This prevents a stale profile ref, replaced runtime identity, provider-default authority model or non-cancelable managed agent from silently impersonating the durable teammate.

## Binding drift

The binding fingerprint is checked twice:

1. before work through `inspect()`
2. after work in the provider execution result

If it changes between inspection and completion, the Task fails.

This closes the simple inspect/execute identity-drift window.

A changed intended profile must be explicitly rebound by the operator.

## Execution envelope

The provider receives:

```text
ai-verse-multiple-bots/external-managed-envelope-v1
```

The bounded envelope includes:

- local Bot id and principal kind
- workspace id
- local Task id
- Team Run id when present
- root objective
- required constraints
- expected output
- exact capability lease tools/connections
- destructive-action policy
- workspace projection
- strategic intent
- historical recall when explicitly resolved
- resolved Skills when explicitly resolved
- input Artifact data/provenance
- pinned external binding identity

The envelope is capped at 512 KiB.

Prompt/context data does not become an authority grant.

## Exact Task authority

Phase 4.5 requires exact tool and connection references.

Groups, wildcards and glob-like references fail closed.

Examples that are rejected include:

```text
*
group:research
github:*
github:re?d
```

The provider receives the exact allowed tools and connections separately from the envelope.

It must enforce that Task-scoped authority even if its persistent profile normally has broader tools or credentials.

## Post-run authority audit

Every provider result must explicitly report:

```text
observed_tools
observed_connections
```

The arrays are required even when empty.

Missing audit data fails with:

```text
EXTERNAL_MANAGED_AUDIT_REQUIRED
```

Any observed tool or connection outside the local Task lease fails with:

```text
EXTERNAL_MANAGED_AUTHORITY_VIOLATION
```

This is defense in depth: Multiple Bots does not trust provider-side narrowing alone.

## Idempotency

The provider request uses the deterministic idempotency key:

```text
aiverse:<local-task-id>
```

This establishes stable local retry identity without claiming exactly-once remote execution.

Remote retry/disconnect/reconnect reconciliation remains Phase 4.8.

## Result contract

A successful provider result must contain:

- a non-empty managed execution id
- the same binding fingerprint
- a JSON object output
- explicit observed tool and connection arrays
- optional usage
- optional visible summary

The local adapter adds canonical execution metadata after the provider result, so provider output cannot spoof:

- local executing Bot id
- local principal kind
- managed execution id

Provider output is capped at 4 MiB.

## Usage and budgets

Provider usage maps into the existing Multiple Bots runtime usage contract:

- input tokens
- output tokens
- cost
- actions

Values must be non-negative and finite.

Existing Task/Team Run budget enforcement remains authoritative outside the provider.

## Cancellation

The provider contract requires cancellation support.

The local adapter:

- records the exact pinned provider/profile binding for the active Task
- issues at most one provider cancel request
- treats provider cancellation as best-effort cleanup
- never allows provider cancel failure to reverse local cancellation
- races provider inspection/execution against the local AbortSignal

Therefore local Task cancellation settles even if a provider ignores the AbortSignal completely.

The provider cancel request still receives:

- local Task id
- managed profile ref
- expected binding fingerprint

## Provider error boundary

Arbitrary provider exceptions are normalized into local runtime errors.

Raw provider error text is not copied into the Task failure path because it may contain:

- URLs
- machine identifiers
- authentication details
- tokens
- provider-internal state

Inspection and execution failures therefore use bounded local error codes rather than forwarding opaque provider exceptions.

## Rebinding a durable teammate

An intentional managed-profile migration must preserve local teammate identity.

Phase 4.5 adds an operator-controlled rebind path.

Rules:

1. the local Bot must not be archived
2. the Bot must be disabled first
3. it must own or be assigned no live Tasks
4. the new provider/ref/fingerprint must be valid
5. the new binding must not collide with another canonical Bot
6. the local Bot id/name/role/scope remain unchanged
7. the Bot stays disabled after rebind
8. normal operator activation is required afterward

Gateway method:

```text
rebindExternalManagedBot(...)
```

HTTP boundary:

```text
POST /v1/bots/:id/external-managed/rebind
```

Rebind emits:

```text
bot.runtime_rebound
```

This is a backend identity-safety operation, not a Phase 5 onboarding/UI flow.

## Durable Bot only

The Phase 4.5 `external-managed` adapter is deliberately restricted to durable Bots.

Temporary Workers continue to use the existing runtime adapters and Team Run model.

This prevents a long-lived managed external profile from being confused with a temporary Worker identity.

## Environment lease boundary

A non-null external environment lease is rejected in Phase 4.5.

Remote capability/environment lease semantics belong to Phase 4.7.

The managed provider receives the current local capability lease only.

## Provenance receipt

The bounded receipt records:

- adapter
- provider id
- local Task id
- local principal kind
- managed execution id
- binding verification state
- identity/authority/output contract modes
- cancellation support
- allowed tool/connection counts
- observed tool/connection counts
- idempotency contract
- remote-auth scope marker
- remote-environment-lease scope marker

It deliberately does not persist:

- managed profile ref
- binding fingerprint
- tool names
- connection names
- workspace projection content
- Brain context
- Memory recall content
- Skill instructions
- input Artifact content
- credentials

## Acceptance proof

The hardened implementation head `c88082c677e291baf359b37acb21316b2be2f0a5` passed GitHub Actions **CI run 421 (`34716643438`) with 355/355 tests**, **0 failures, 0 canceled and 0 skipped**.

Phase 4.5 acceptance coverage proves:

1. a durable local Bot executes through a host-injected managed provider
2. local Bot identity remains canonical
3. the provider receives deterministic local Task idempotency
4. live provider/profile/fingerprint identity is verified before execution
5. binding fingerprint is checked again after execution
6. provider contract drift fails closed
7. unavailable managed profiles fail closed
8. Task authority uses exact tool/connection references
9. wildcards/groups/globs are rejected
10. provider-observed authority is checked after execution
11. missing observed-authority audit arrays fail closed
12. output and usage are bounded/validated
13. persisted receipts exclude managed ref/fingerprint/context/tool/connection content
14. arbitrary provider error details are not copied into local failures
15. provider registration is explicit and duplicate-safe
16. one external profile/fingerprint cannot back multiple canonical Bots
17. binding uniqueness applies across workspaces
18. archived bindings remain reserved
19. operator rebind preserves the same local Bot identity
20. active/non-operator rebinds are rejected
21. rebind cannot steal another Bot's ref/fingerprint
22. rebind rechecks that no live work exists
23. external-managed manifest structure/policy is validated
24. temporary Workers cannot use the durable managed-profile adapter
25. remote environment leases remain rejected until Phase 4.7
26. cancellation targets the pinned profile at most once
27. provider cancel failure cannot reverse local cancellation
28. local cancellation settles even when a provider ignores AbortSignal
29. the Gateway registers the host-neutral `external-managed` runtime/provider registry
30. the operator rebind HTTP boundary works
31. the complete pre-existing Phase 0-4.4 suite remains green

## Non-goals

Phase 4.5 does not implement:

- remote-machine authentication or credential exchange
- SSH transport
- built-in provider API tokens
- remote capability/environment leases
- disconnect/reconnect reconciliation
- remote exactly-once execution
- generic retry reconciliation
- Telegram/Discord/channel bridges
- managed-team onboarding
- installer/template/doctor UX
- Phase 5 Dashboard behavior

Those remain with their canonical later roadmap slices.
