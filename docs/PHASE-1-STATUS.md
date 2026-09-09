# Phase 1 Status - Runnable Coordination Core

**Updated:** 2026-09-09

**Phase:** 1

**Overall status:** in progress, approximately 88%

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
- persistent Messages/Tasks/Handoffs/Artifacts/Approvals/leases
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
  -> budget/loop/progress checks
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
- canceled/failed/over-budget/no-progress execution cannot publish a normal completion Artifact

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
- usage reporting for input/output tokens, cost and actions
- runtime receipt surface

A real external/model runtime adapter is intentionally still deferred until handoff and crash-recovery rules are hardened.

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
- deadline field and inherited deadline clamp
- inherited budget envelope
- child cannot expand parent token/cost/action/task/hop limits
- automatic execution enqueue for immediately executable work
- Room-backed Task delegation
- loop/ping-pong guard before Task creation

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

The installable localhost Gateway enables strict coordination policy by default.

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
- Task-count ceiling per root objective when configured

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

### Safety II: budgets, loops and progress

Implemented:

- first-class inherited budget envelope
- token limit
- cost limit
- action limit
- wall-clock limit
- root Task-count limit
- max-hop budget integration
- child budget cannot expand parent budget
- runtime usage checked before successful Artifact acceptance
- `task.budget_exceeded`
- Task lineage loop detection
- Bot A -> Bot B -> Bot A -> Bot B ping-pong detection
- stable result fingerprinting
- repeated-result/no-progress detection
- `task.no_progress`

### Approval boundary

Implemented first-class approval gating:

```text
Task prepared
  -> approval pending
  -> Task waiting_approval
  -> NOT in execution queue

operator approves
  -> approval approved
  -> Task assigned
  -> execution queued

operator denies
  -> approval denied
  -> Task canceled
  -> no successful Artifact
```

Implemented:

- Approval protocol object
- approval action summary
- pending/approved/denied lifecycle
- approval-required capability lease marker
- only operator identities can decide an Approval
- non-operator approval attempts fail
- approval-required Task does not enter execution queue before approval
- deny path cancels Task
- `approval.requested`
- `approval.approved`
- `approval.denied`
- `GET /v1/approvals`
- `POST /v1/approvals/:id/approve`
- `POST /v1/approvals/:id/deny`
- `needs_approval` attention event

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

This is now the immediate next main Phase 1 area. The current implementation predates the final protocol-v1.1 handoff field naming and does not yet perform one atomic transaction across handoff state, ownership, leases, queue state and events.

## Current HTTP surface

Implemented main endpoints include:

- `GET /health`
- `GET /v1/bots`
- `POST /v1/bots`
- `POST /v1/messages`
- `GET /v1/mailbox/:id`
- `POST /v1/delegations`
- `POST /v1/tasks/:id/cancel`
- `GET /v1/approvals`
- `POST /v1/approvals/:id/approve`
- `POST /v1/approvals/:id/deny`
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

Latest verified GitHub Actions suite after Safety II and Approval work: **23/23 passing**.

Newly proven behavior includes:

- child Task budget inheritance and anti-expansion
- root Task-count budget
- lineage ping-pong protection
- runtime usage over budget fails before Artifact publication
- repeated identical results eventually fail as no progress
- approval-required work cannot execute before approval
- Bot cannot approve its own approval gate
- operator approval releases the Task to execution
- denied approval cancels the Task and produces no Artifact
- HTTP approval queue and decision path

Previously proven behavior remains covered:

- strict Gateway routing
- Room replay
- cancellation and deadline enforcement
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

### A. Handoff hardening - NEXT

- align runtime implementation with Protocol v1.1 handoff fields
- transactional handoff + ownership + event update
- reject flow
- execution queue retargeting
- capability lease intersection/reissue
- environment lease transfer safety
- immutable constraint digest verification
- return-policy execution

### B. Execution recovery hardening

- stale claimed/running detection
- execution heartbeat/lease
- safe recovery policy
- retry rules
- dead-letter state
- multi-process runner ownership

Do not blindly retry unknown external side effects after a crash.

### C. Bot registry hardening

- disable/archive transitions
- alias/collision rules outside Rooms
- relationship validation

### D. First real runtime adapter

After handoff/recovery rules are green:

- attach one real useful runtime behind the existing interface
- normalize runtime/tool receipts
- prove two persistent Bots collaborating end-to-end with the real adapter

### E. Final Phase-1 contract pass

- sync the JSON Schema with all Safety II runtime budget fields
- complete Handoff schema/implementation alignment
- apply Room aggregate max-message/max-round envelopes
- conformance tests across canonical JSON Schema and runtime validator
- final restart/cancel/handoff/approval acceptance scenario

## Immediate next implementation step

Build **Handoff Hardening**.

The safe target is an atomic ownership transfer where the target accepts responsibility, inherited constraints are verified, authority is narrowed rather than expanded, queued execution is retargeted consistently, and partial failure cannot leave the Handoff, Task, lease or queue disagreeing about who owns the work.
