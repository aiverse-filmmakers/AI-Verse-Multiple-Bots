# Phase 1 Status - Runnable Coordination Core

**Updated:** 2026-09-09

**Phase:** 1

**Overall status:** in progress, approximately 80%

This file is the implementation ledger for Phase 1. It records what is actually on `main`, what has been tested, and what remains before the Phase 1 completion milestone is claimed.

See `BUILD-MAP.md` for the full Phase 0-5 product roadmap.

## Phase 1 completion milestone

Phase 1 is complete only when:

> Two persistent Bots can independently exist, communicate asynchronously, delegate real work, transfer responsibility safely, collaborate in a Room/Thread, execute through a real runtime adapter, respect enforced policy/limits/approvals, recover from restart, and cancel/fail without losing coordination integrity.

That milestone is **not yet claimed**.

## What is working now

### Core runtime and persistence

- Node.js + TypeScript package
- localhost Coordination Gateway
- SQLite coordination state
- protocol objects
- persistent Bots
- persistent Messages/Tasks/Handoffs/Artifacts/leases
- conversational mailbox
- separate executable Task queue
- append-only events
- global and per-Room ordering
- idempotency
- restart persistence
- SSE event stream
- GitHub Actions CI

### Persistent Bot execution

Implemented lifecycle:

```text
Task assigned
  -> execution queued
  -> Bot wakes from event
  -> queue claim
  -> Task running
  -> runtime adapter
  -> Artifact published
  -> Task completed
  -> creator/Room notified
```

Implemented safeguards:

- active Bot required
- assignee/owner match
- capability lease validation
- lease expiry enforcement
- environment lease lookup
- runtime availability checked before claim
- canceled/failed execution cannot publish a normal completion Artifact

### Runtime adapter boundary

Implemented:

- provider-neutral adapter interface
- structured execution context
- structured result
- runtime registry
- deterministic reference adapter
- abort signal
- optional runtime cancellation hook
- execution deadline support

A real external/model runtime adapter is intentionally still deferred until the remaining safety controls are present.

### Delegation

Implemented:

- explicit assignee and owner
- root objective
- parent Task lineage
- inherited constraints
- hop/max-hop controls
- scoped capability lease
- tools/connections
- response target
- deadline field
- automatic execution enqueue
- Room-backed Task delegation

### Rooms and Threads

Implemented:

- Room creation/list/get
- workspace-scoped membership
- active Bot validation
- Room leaders
- aliases and `@mentions`
- visible unresolved/ambiguous mention failures
- Thread creation and Thread replies
- pass semantics
- bounded selective speaker scheduling
- active work owner/collaborators
- Room messages as canonical protocol objects/events
- mentioned Bot work becomes real Tasks
- Bot result Artifact publishes back into Room/Thread
- independent Room sequence
- Room/Thread replay storage
- `GET /v1/rooms/:id/events`

### Strict coordination policy

The installable localhost Gateway now enables strict coordination policy by default.

Enforced:

- registered Bot requirement
- active Bot requirement
- workspace boundary
- peer allowlists
- tool grants
- connection grants
- parent/root-objective lineage
- inherited constraints
- hop ceilings
- duplicate active Task prevention
- deadline validity

### Cancellation and deadlines

Implemented:

- persistent execution cancellation
- cancellation of queued, claimed, or running Task work
- abort signal delivered to runtime adapter
- optional adapter-specific cancellation hook
- explicit cancellation API: `POST /v1/tasks/:id/cancel`
- cancellation authorization for operator/creator/owner/assignee
- recursive parent -> child cancellation propagation
- runtime-vs-cancel race handling
- Task execution deadlines
- deadline-triggered adapter cancellation
- `task.deadline_exceeded`
- `task.canceled`
- canceled/deadline-exceeded Task produces no successful Artifact

### Handoff core

Implemented:

- Handoff object
- requested state
- target-only acceptance
- ownership changes only after target accepts
- `handoff.requested`
- `handoff.accepted`
- `ownership.changed`
- HTTP request/accept endpoints

This remains one of the main unfinished Phase 1 areas because the transition is not yet transactionally atomic across all related state.

## Current HTTP surface

Implemented main endpoints include:

- `GET /health`
- `GET /v1/bots`
- `POST /v1/bots`
- `POST /v1/messages`
- `GET /v1/mailbox/:id`
- `POST /v1/delegations`
- `POST /v1/tasks/:id/cancel`
- `POST /v1/handoffs`
- `POST /v1/handoffs/:id/accept`
- `GET /v1/execution/:id`
- `POST /v1/bots/:id/run-next`
- `GET /v1/rooms`
- `POST /v1/rooms`
- `GET /v1/rooms/:id`
- `GET /v1/rooms/:id/events`
- `POST /v1/rooms/:id/messages`
- `POST /v1/rooms/:id/threads`
- `POST /v1/rooms/:id/pass`
- `POST /v1/rooms/:id/work-owner`
- `GET /v1/events`
- `GET /v1/events/stream`

Default binding remains localhost-oriented.

## Test and CI status

Latest verified GitHub Actions suite after cancellation/deadline work: **16/16 passing**.

Newly proven behavior includes:

- strict Gateway rejects unregistered Bot routing
- Room replay API works
- explicit cancellation aborts running execution
- running cancellation produces no successful Artifact
- deadline expiry cancels execution and records evidence
- parent cancellation propagates to active child Tasks

Previously proven behavior remains covered:

- delegation + capability leases
- ownership semantics
- mailbox persistence
- restart Task execution
- lease expiry failure
- Room/Thread work and replies
- policy lineage/hop/workspace/peer/capability checks
- append-only event ordering/idempotency
- event-driven Bot wake-up

Node's built-in `node:sqlite` still emits its experimental-feature warning on Node 22. This is acceptable for the current alpha but must be revisited before a stable runtime-support commitment.

## Remaining Phase 1 work

### A. Safety II

Next main slice:

- token budget
- cost budget
- resource/action budget
- loop/ping-pong detection
- no-progress detection
- Room runtime turn/message ceilings
- approval interceptor
- explicit user escalation

### B. Handoff hardening

- transactional handoff + ownership + event update
- reject flow
- execution queue retargeting
- capability/environment lease intersection or transfer
- immutable constraint digest verification
- return-policy execution

### C. Execution recovery hardening

- stale claimed/running detection
- execution heartbeat/lease
- safe recovery policy
- retry rules
- dead-letter state
- multi-process runner ownership

Do not blindly retry unknown external side effects after a crash.

### D. Bot registry hardening

- disable/archive transitions
- alias/collision rules outside Rooms
- relationship validation

### E. First real runtime adapter

After Safety II and the critical handoff/recovery rules are green:

- attach one real useful runtime behind the existing interface
- record runtime/tool receipts
- prove two persistent Bots collaborating end-to-end with the real adapter

## Immediate next implementation step

Build **Safety II**, starting with bounded budgets and loop/no-progress detection, then approval interception and escalation.

This is the correct next step before connecting Hermes, OpenClaw, Codex, Claude Code, or another powerful runtime.
