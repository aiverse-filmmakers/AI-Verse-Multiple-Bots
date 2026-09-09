# Phase 1 Status - Runnable Coordination Core

**Updated:** 2026-09-09

**Phase:** 1

**Overall status:** in progress

This file is the implementation ledger for Phase 1. It records what is actually on `main`, what has been tested, and what remains before the Phase 1 completion milestone is claimed.

## Phase 1 completion milestone

Phase 1 is complete only when:

> Two persistent Bots can independently exist, talk asynchronously, delegate real work to each other, hand responsibility between each other, work together in a Room, and survive a Coordination Gateway restart without losing coordination state.

That milestone is **not yet claimed**.

## Commits in this implementation start

- `02caedf9abba45c2bfb0431d8eb0d8a171eff51e` - record canonical implementation roadmap
- `66edcb49ea1af973fea3c6c0d28cd6cc78811aec` - mark Phase 1 started in README
- `75df9011751bdb9245806eaeaba6ed3d8f14cd23` - first runnable coordination core on `main`
- `9603f7cdc4a78064d6f27ac5503376b13bc051f8` - expose network-facing Coordination Gateway API and SSE event stream
- `ac4e8ae653ed6ae0f898569f4c254d4779cf0ba0` - add typed delegation, capability leases and explicit handoff ownership transitions

## Implemented and tested

### Repository/runtime skeleton

- Node.js / TypeScript project
- `package.json`
- strict TypeScript configuration
- runtime exports
- CLI entrypoint
- dependency-light core

### SQLite coordination store

Current persistent substrate includes:

- generic typed protocol object storage
- Bot manifests
- Messages
- Tasks
- Handoffs
- leases and other protocol objects through the normalized object store
- append-only coordination events
- asynchronous delivery/mailbox queue
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

### Asynchronous Bot mailbox substrate

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

Bot activation/runner consumption of queued mailbox work is not implemented yet.

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
- `task.assigned` event
- HTTP delegation endpoint

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

Atomic transaction hardening across handoff state + work-item ownership + events is still required.

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
- `GET /v1/events`
- `GET /v1/events/stream` via Server-Sent Events

Default binding is localhost-oriented.

## Test status

The current local implementation test suite passed **6/6 tests** before the latest code was committed.

Covered behavior:

1. append-only ordered event storage + idempotency
2. independent per-Room ordering
3. Bot/mailbox persistence across database reopen
4. HTTP health/Bot/message/mailbox/event APIs
5. delegation creates child Task + capability lease with explicit ownership
6. handoff changes ownership only after target acceptance

The test environment used Node.js 22.16.0. Node's built-in `node:sqlite` module emits an experimental-feature warning on that runtime.

## Not implemented yet

### Slice 4 hardening - Bot Registry

- disable/archive transitions
- alias/mention registry
- peer permission enforcement
- workspace boundary enforcement on every command
- duplicate/collision policy
- Bot relationship validation

### Slice 5 - Local Runtime Adapter

Not started.

Required next:

- runtime adapter interface
- invocation contract
- context packet
- structured result
- cancellation
- timeout
- runtime/tool receipts
- one deterministic fake adapter for tests
- one useful local process/model adapter after the contract is stable

### Slice 6 - Mailbox execution

Partially implemented.

Still required:

- delivery claiming
- accepted/delivered/processing transitions
- worker wake-up
- retry rules
- delivery expiry
- completion/reply linkage
- dead-letter/failure handling
- multi-process safety

### Slice 8 handoff hardening

Still required:

- transactionally atomic ownership transfer
- reject flow
- return policy execution
- lease transfer/intersection
- immutable constraint digest verification
- adapter failure rollback

### Slice 9 - Rooms and Threads

Protocol/storage foundations exist, but orchestration is not implemented.

Still required:

- Room creation/membership API
- canonical Room Messages
- `@mention` resolution
- Thread creation/replies
- pass semantics
- selective speaker scheduler
- unresolved mention behavior
- explicit active work owner in Room
- bounded rounds/messages

### Slice 10 - Safety substrate

Not implemented as enforcement yet.

Still required:

- hop limits
- Worker limits
- round/message limits
- token/cost budgets
- wall-clock deadlines
- loop/cycle detection
- no-progress detection
- cancellation propagation
- approval interceptor
- user escalation

## Immediate next implementation step

Build **Slice 5 + Slice 6 together as one vertical execution path**:

```text
queued Message/Task
     -> mailbox claim
     -> Runtime Adapter
     -> scoped Context Packet
     -> execution
     -> Artifact / structured result
     -> delivery/task completion
     -> events
```

Use a deterministic fake runtime first so the coordination semantics can be proven independently of any specific model provider.

After that works reliably across restart, begin Rooms/Threads and then the safety enforcement layer.
