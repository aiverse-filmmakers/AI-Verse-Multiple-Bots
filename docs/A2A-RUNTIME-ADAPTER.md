# A2A Runtime Adapter

**Phase:** 4.1

**Status:** COMPLETE

## Purpose

Phase 4.1 adds a host-neutral runtime adapter for the stable Agent2Agent Protocol (A2A) v1.0.

The adapter lets a durable Multiple Bots Bot or a temporary Worker execute an already-authorized local Task through a remote A2A agent while Multiple Bots keeps ownership of the local coordination identity, Task, leases, cancellation state, Artifact publication, budgets and recovery bookkeeping.

This slice does not turn the remote A2A agent into canonical Multiple Bots state.

## Protocol baseline

Phase 4.1 targets the released A2A Protocol v1.0 specification:

- https://a2a-protocol.org/v1.0.0/specification/

The adapter supports the A2A JSON-RPC binding only.

Implemented operations:

- Agent Card discovery
- `SendMessage`
- `GetTask`
- `CancelTask`

Not implemented in this slice:

- streaming / `SendStreamingMessage`
- `SubscribeToTask`
- push notifications
- authenticated extended Agent Cards
- gRPC binding
- HTTP+JSON binding
- A2A protocol extensions

Those are not required to prove the first runtime interoperability slice.

## Runtime configuration

A Bot runtime may use:

```json
{
  "adapter": "a2a",
  "agent_card_url": "https://agent.example/.well-known/agent-card.json",
  "poll_interval_ms": 250
}
```

`agent_card_url` is required.

`poll_interval_ms` is optional and must be between 25 and 10000 milliseconds.

The adapter permits HTTP for local/development interoperability tests, but A2A production deployments are expected to use HTTPS according to the protocol security requirements.

## Agent Card discovery

Every execution performs a fresh Agent Card read.

The adapter does not persist or own an external agent registry.

The card must provide:

- non-empty agent name and version
- capabilities object
- non-empty default input/output modes
- at least one `JSONRPC` interface with `protocolVersion: "1.0"`

The first supported JSON-RPC v1.0 interface in the Agent Card's ordered `supportedInterfaces` list is selected.

The selected interface URL is used exactly for execution. Receipt metadata strips query/fragment data.

## Authentication boundary

Phase 4.1 intentionally does not implement remote authentication.

The adapter fails closed if:

- runtime configuration contains raw or indirect authentication fields
- the Agent Card declares non-empty `securityRequirements`
- the remote task enters `TASK_STATE_AUTH_REQUIRED`

This is not a missing feature hidden behind a permissive fallback. Remote machine/client identity and authentication are explicitly Phase 4.6.

No credential is forwarded through the Task envelope.

## Extension boundary

If the Agent Card declares any required A2A protocol extension, Phase 4.1 rejects the card.

The adapter does not claim extension support it does not implement.

Optional extensions are ignored.

## Input mode

The adapter prefers `application/json` when the remote Agent Card accepts it.

If JSON is unavailable but `text/plain` is accepted, the exact same structured execution envelope is JSON-serialized into a text part.

If neither input mode is supported, execution fails before `SendMessage`.

## Local authority remains local

The outbound execution envelope carries the minimum local execution contract needed by the remote runtime:

- local principal id and kind
- workspace id
- local Task id
- Team Run id when present
- root objective id
- objective
- required constraints
- expected output contract
- current capability lease id
- already-granted tools and connections
- destructive-action policy
- environment lease id when present
- runtime-only workspace projection
- runtime-only strategic intent
- explicit historical recall when already resolved
- explicit task-scoped Skill instructions when already resolved
- bounded input Artifacts

The envelope states the authority ordering explicitly.

The remote agent cannot expand local authority merely by returning metadata, an Artifact, or a status message.

Local Multiple Bots policy, Task constraints, leases, approvals and runner state remain authoritative.

## Identity mapping

A2A does not replace local identity.

The local execution principal remains either:

- durable Bot
- temporary Worker

The outbound A2A message records that identity as metadata and inside the structured envelope.

A temporary Worker is never promoted into a durable Bot because the remote runtime handled its Task.

The persisted local result records the local execution principal kind.

## Idempotency

The A2A message id is deterministic:

```text
aiverse:<local-task-id>
```

A2A v1.0 allows servers to use `messageId` to detect duplicate Send Message requests.

This gives Phase 4.1 a stable replay identity without inventing a second local remote-task database.

It does not claim exactly-once remote execution. Full disconnect/retry/reconnect semantics remain Phase 4.8.

## Task lifecycle

`SendMessage` uses:

```json
{
  "returnImmediately": true,
  "historyLength": 0
}
```

This allows Multiple Bots to learn the remote Task id early and preserve cancellation control.

When the remote returns a direct A2A Message, the adapter converts it directly into a local runtime result.

When the remote returns a Task:

- `SUBMITTED` / `WORKING` -> poll with `GetTask`
- `COMPLETED` -> publish a local runtime result
- `INPUT_REQUIRED` -> fail visibly with `A2A_INPUT_REQUIRED`
- `AUTH_REQUIRED` -> fail visibly with `A2A_AUTH_REQUIRED`
- `REJECTED` -> fail visibly
- `FAILED` -> fail visibly
- `CANCELED` -> fail as remote cancellation
- missing/invalid state -> fail closed

Phase 4.1 does not invent automatic multi-turn answers when a remote agent asks for human/client input.

## Cancellation

Once a remote Task id is known, local cancellation attempts A2A `CancelTask`.

Local cancellation continues even if the remote cancellation attempt fails.

This preserves the rule that a remote runtime cannot prevent the local owner from canceling its own coordination Task.

A2A cancellation is idempotent according to the protocol.

## Results and provenance

A successful direct Message produces local Artifact kind:

```text
a2a_message_result
```

A completed remote Task produces:

```text
a2a_task_result
```

The local output may contain returned A2A message parts or remote Task artifacts because they are the actual task result.

The persisted runtime receipt is bounded provenance only:

- adapter
- A2A protocol and version
- JSON-RPC binding
- remote agent name/version
- sanitized endpoint
- remote Task/context ids when present
- remote Artifact count
- request count
- local principal kind
- local Task id
- authentication support state

Workspace projection text, Brain context, Memory recall, Skill instructions, connection names and input Artifact content are not copied into the receipt.

## Network and payload limits

Phase 4.1 applies explicit ceilings:

- Agent Card: 256 KiB
- outbound A2A request: 512 KiB
- A2A response: 4 MiB

Malformed JSON, oversized payloads, mismatched JSON-RPC ids, missing results, invalid Task ids and invalid Artifact structures fail closed.

## Budget accounting

Each Agent Card fetch and A2A RPC request counts as one runtime `action`.

The existing Multiple Bots runner applies local Task and Team Run budget validation to the returned usage.

The A2A adapter does not fabricate token or monetary cost data when the remote agent does not provide a standardized A2A accounting field.

## Recovery boundary

Phase 4.1 preserves deterministic message identity and local queue ownership but does not claim complete crash/disconnect recovery across a remote A2A Task.

The following remain Phase 4.8:

- durable remote Task binding across process restart
- reconnect/resubscribe policy
- retry classification
- duplicate remote execution reconciliation
- interrupted network recovery

## Acceptance gate

Phase 4.1 is complete only when tests prove at minimum:

1. Agent Card discovery selects JSON-RPC A2A v1.0
2. deterministic local Task identity becomes the A2A message id
3. durable Bot identity remains the local execution identity
4. temporary Worker identity remains a Worker through remote execution
5. application/json and text/plain input modes work
6. direct Message responses become local runtime results
7. non-terminal remote Tasks poll through `GetTask`
8. completed remote Task Artifacts become local runtime results
9. input-required, auth-required, failed, rejected and canceled remote states do not become successful local Artifacts
10. authentication requirements fail closed because auth belongs to Phase 4.6
11. required A2A extensions fail closed
12. unsupported protocol binding/version fails closed
13. JSON-RPC response ids are validated
14. local cancellation attempts remote `CancelTask`
15. receipts preserve provenance without copying execution context
16. the Gateway registers `a2a` as a normal runtime adapter
17. the complete pre-existing Phase 0-3 and coordination suite remains green

**Verified gate:** GitHub Actions CI run 389 (`34710078152`) passed **294/294 tests**, with 0 failures, 0 canceled and 0 skipped, on exact implementation head `29f220ef8e6318bf5dfed835e8a0d966c0c51586`.

## Non-goals

Phase 4.1 does not:

- implement Hermes
- implement OpenClaw
- implement Codex/Claude Code process adapters
- define external managed Bot identity
- implement remote-machine identity/authentication
- implement remote capability/environment leases
- implement retry/disconnect/reconnect semantics
- run the final Phase 4 compatibility suite
- begin Phase 5
