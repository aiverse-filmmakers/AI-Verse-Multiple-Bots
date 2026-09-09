# Phase 1 Status - Runnable Coordination Core

**Updated:** 2026-09-09

**Phase:** 1

**Overall status:** in progress

This file is the implementation ledger for Phase 1. It records what is actually on `main`, what has been tested, and what remains before the Phase 1 completion milestone is claimed.

## Phase 1 completion milestone

Phase 1 is complete only when:

> Two persistent Bots can independently exist, talk asynchronously, delegate real work to each other, hand responsibility between each other, work together in a Room, and survive a Coordination Gateway restart without losing coordination state.

That milestone is **not yet claimed**. The direct Bot-to-Bot execution path is now working. Room/Thread collaboration, stronger safety enforcement, handoff atomicity, and a real external/model runtime adapter still remain.

## Implementation history

Architecture and initial core:

- `02caedf9abba45c2bfb0431d8eb0d8a171eff51e` - record canonical implementation roadmap
- `66edcb49ea1af973fea3c6c0d28cd6cc78811aec` - mark Phase 1 started in README
- `75df9011751bdb9245806eaeaba6ed3d8f14cd23` - first runnable coordination core on `main`
- `9603f7cdc4a78064d6f27ac5503376b13bc051f8` - expose network-facing Coordination Gateway API and SSE event stream
- `ac4e8ae653ed6ae0f898569f4c254d4779cf0ba0` - add typed delegation, capability leases and explicit handoff ownership transitions

Execution vertical slice:

- `608e9a8fde23c866b01fad981af433ba338fb5cd` - persistent execution queue
- `66b731ad4935dc73279726eb54247fb6e96f4176` - runtime adapter contract + deterministic adapter
- `09ae4560f08b1dea21a47db34920d2546dd872f8` - Bot runner execution lifecycle
- `02ea4707964b0d125a3ff81605ae6184f90c1e1d` - delegation automatically enqueues executable Tasks
- `10aec158f31c39bf799d653f7bcf6a3d53702583` - expose execution through localhost Gateway
- `afe72f55246e15d5d028ef2bfceed6fa3e680c56` - queued-target discovery for restart wake-up
- `be85bd837cca7bea5dd279c629581bd7204d4530` - event-driven execution supervisor
- `dd1721528ecd8dd5d38040dacf24e9e754d52a84` - wire supervisor into server lifecycle
- `6ef20efbc9e30f9a975d000fddca4fd4154f0e78` - preserve queued work when runtime adapter is unavailable
- `071546d26d4b7dbae85d2426de66a1015d4cace8` - wake queued work when a Bot becomes available

Testing/CI:

- `7c1b4914611054e10a4810af5ad8941247b433d8` - execution lifecycle + expired lease tests
- `66bd054982e062417bf8dce1925973f10e3188e3` - event-driven supervisor test
- `8e34fd0954d38f56a5ad8d5b8e45b16b5a9220cd` - add GitHub Actions CI
- `8b18133b0319549fd174e38b37f2bb727422de84` - fix CI lockfile-dependent npm-cache setup
- `b49fc3cea8817d1f1cbcc34646de89f6d4afec7a` - pin TypeScript 5.8.3

## Implemented and tested

### Repository/runtime skeleton

- Node.js / TypeScript project
- strict TypeScript configuration
- runtime exports
- CLI entrypoint
- dependency-light core
- GitHub Actions CI on `main` and pull requests

### SQLite coordination store

Current persistent substrate includes:

- generic typed protocol object storage
- Bot manifests
- Messages
- Tasks
- Handoffs
- capability/environment leases and other protocol objects
- Artifacts
- append-only coordination events
- asynchronous conversational delivery/mailbox queue
- persistent execution queue
- idempotency records
- per-Room sequence counters

The SQLite database is coordination-service state. It is not AI-Verse canonical domain truth.

### Event substrate

Implemented:

- global append sequence
- independent monotonic per-Room ordering
- workspace/run/task/Room/Thread correlation columns
- correlation, causation and trace IDs
- replay from sequence number
- idempotent event append
- in-process event subscription
- SSE event replay + live push

### Bot registry substrate

Implemented:

- protocol-aligned Bot validation
- create Bot
- get Bot
- list Bots
- workspace-indexed persistence
- runtime/execution/permission/coordination metadata persistence
- `bot.created` event

### Asynchronous conversational mailbox

Implemented delivery states:

```text
queued
accepted
delivered
processing
replied
expired
failed
canceled
```

Implemented:

- persistent queued delivery record
- target mailbox reads
- state update substrate
- restart persistence
- task-result notifications use the same normal Bot-to-Bot mailbox path

Conversational Messages are intentionally separate from executable Tasks. Message-driven autonomous action is not yet enabled by default.

### Delegation

Implemented:

- typed delegation input
- Task creation
- explicit child `owner_id`
- parent/creator remains recorded separately
- root objective preservation
- required constraints
- expected-output contract
- capability lease creation
- task-scoped tools/connections
- lease expiry
- hop/max-hop metadata
- persistent execution enqueue
- `task.assigned` event
- HTTP delegation endpoint

### Runtime adapter contract

Implemented:

- runtime-neutral adapter interface
- typed execution context
- typed structured result
- adapter registry
- cancellation hook in interface
- deterministic test adapter
- adapter availability is checked before work is claimed

The deterministic adapter exists to validate orchestration semantics without coupling tests to a model provider.

### Persistent Task execution

Implemented lifecycle:

```text
Task assigned
  -> execution queued
  -> Bot wake-up
  -> atomic queue claim
  -> Task running
  -> runtime adapter
  -> Artifact published
  -> Task completed
  -> execution completed
  -> creator notified
```

Implemented enforcement:

- Bot must exist and be active
- assignee/owner match
- executable Task status
- capability lease exists
- lease issued to correct Bot
- lease scoped to correct Task
- lease expiry checked before execution
- optional environment lease lookup
- failures create `task.failed` and no successful Artifact

### Event-driven execution supervisor

Implemented:

- no polling loop
- wakes on `task.assigned`
- serial drain per Bot
- avoids duplicate in-process runners for the same Bot
- skips unavailable runtime adapters without consuming work
- startup scan for queued targets
- `bot.created` retrigger for work queued before the Bot became available
- graceful wait-for-idle on shutdown

### Restart behavior

Proven by test:

- Bot/Task/lease/execution queue survive SQLite close/reopen
- queued delegated work can be claimed and completed after reopen
- result Artifact and completion events are preserved

Important remaining hardening:

- a process crash after execution reaches `running` cannot yet be blindly retried because an external runtime may already have caused side effects
- stale claimed/running recovery needs an explicit lease/heartbeat/resume policy rather than unsafe automatic retry
- multi-process runner ownership still needs hardening

### Handoff

Implemented:

- explicit handoff object
- requested state
- target-owner validation
- rejection of acceptance by unrelated actors
- accepted state
- work-item ownership mutation only after acceptance
- `handoff.requested`
- `handoff.accepted`
- `ownership.changed`
- HTTP request/accept endpoints

Still required:

- transactionally atomic handoff state + ownership + event transition
- reject flow
- return policy execution
- capability/environment lease intersection/transfer
- execution-queue retargeting where appropriate
- adapter failure rollback

### Network-facing Coordination Gateway

Implemented:

- `GET /health`
- `GET /v1/bots`
- `POST /v1/bots`
- `POST /v1/messages`
- `GET /v1/mailbox/:id`
- `POST /v1/delegations`
- `POST /v1/handoffs`
- `POST /v1/handoffs/:id/accept`
- `GET /v1/execution/:id`
- `POST /v1/bots/:id/run-next`
- `GET /v1/events`
- `GET /v1/events/stream` via Server-Sent Events

Default binding remains localhost-oriented.

## Test and CI status

GitHub Actions run `34325360530` completed successfully on Node.js 22.23.2.

Current complete suite: **9/9 passing**.

Covered behavior:

1. delegation creates capability lease + child-owned Task
2. handoff changes ownership only after target acceptance
3. persistent Bots + conversational mailbox survive store reopen
4. delegated Task survives restart, executes, publishes Artifact, and notifies creator
5. expired capability lease blocks execution and produces no Artifact
6. HTTP health/Bot/message/mailbox/event APIs
7. append-only ordered event storage + idempotency
8. independent per-Room ordering
9. supervisor wakes assigned Bot from `task.assigned` without polling

Node's built-in `node:sqlite` still reports its experimental-feature warning on Node 22. This is currently accepted for the alpha implementation and should be revisited before a stable release/runtime-support commitment.

## Remaining Phase 1 work

### Bot Registry hardening

- disable/archive transitions
- alias/mention registry
- peer permission enforcement
- workspace boundary enforcement on every command
- duplicate/collision policy
- Bot relationship validation

### Rooms and Threads

This is the **next main implementation slice**.

Required:

- Room creation/membership API
- canonical Room Messages
- Thread creation/replies
- `@mention` alias resolution
- ambiguous/unresolved mention behavior
- pass semantics
- selective speaker scheduling
- explicit active work owner in Room
- bounded rounds/messages
- Room-to-Task delegation path

### Safety substrate

After the Room core:

- enforce hop limits
- Worker limits
- round/message limits
- token/cost budgets
- wall-clock deadlines
- loop/cycle detection
- no-progress detection
- cancellation propagation
- approval interceptor
- user escalation

### Real runtime adapter

Do **not** make a powerful external model/runtime the coordination foundation.

After safety enforcement is in place, add one real adapter behind the already-tested runtime interface. Candidates include a local CLI/process runtime, Hermes, OpenClaw, Codex/Claude Code, or another host-selected runtime.

## Immediate next implementation step

Build the **Room + Thread coordination core** on top of the now-green execution substrate:

```text
Room
  -> canonical members
  -> canonical event/message ordering
  -> mention resolution
  -> Thread branch
  -> explicit work owner
  -> bounded speaker policy
  -> Bot pass
  -> optional Task delegation
```

The Room engine must remain backend-owned and event-driven. Dashboard/Desktop/Telegram/etc. are clients of the same Room contract, never alternate orchestration owners.
