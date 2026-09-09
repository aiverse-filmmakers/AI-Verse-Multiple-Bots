# Phase 1 Status - Runnable Coordination Core

**Updated:** 2026-09-09

**Phase:** 1

**Overall status:** in progress, approximately 96%

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
- reusable atomic multi-object/event/queue mutation primitive
- SSE event stream
- GitHub Actions CI

### Persistent Bot execution

Implemented lifecycle:

```text
Task assigned
  -> execution queued
  -> Bot wakes from event
  -> runner-owned queue claim
  -> Task running
  -> execution heartbeat
  -> runtime adapter
  -> budget/loop/progress checks
  -> ownership recheck
  -> Artifact + Task + queue finalization
  -> Handoff settlement when applicable
  -> creator/Room notified
```

Implemented safeguards:

- active Bot required
- assignee/owner match
- capability lease validation
- lease expiry enforcement
- environment lease lookup
- runtime availability checked before claim
- unique runner identity
- execution ownership lease
- continuous heartbeat
- stale runner loses write authority
- file-backed completion/failure/cancel finalization uses atomic Task/Artifact/queue transitions
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

A real external/model runtime adapter is intentionally still deferred until Bot registry rules are hardened.

### Delegation

Implemented:

- explicit assignee and owner
- root objective
- parent Task lineage
- inherited constraints
- immutable constraint digest
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
- persistent recovery policy and max-attempt metadata

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

### Handoff hardening

**Phase-1 gate complete.**

Implemented:

- Protocol v1.1 canonical `target_bot_id` and `task_id`
- source ownership/root/workspace/status checks before request
- one active Handoff per Task
- target-only acceptance
- target/operator rejection
- atomic SQLite mutation across Handoff, Task, leases, Approval retargeting, queue routing and audit events
- queue retarget only while execution is still queued
- claimed/running Task Handoff fails closed
- old capability lease revoked/superseded and new Task-scoped authority reissued to target
- target capability compatibility checks
- shared-workspace environment lease reissue
- isolated/external environment transfer fails closed pending adapter-specific secure transfer
- approval-gated Task remains outside execution queue after Handoff
- pending Approval actor moves to the new target
- immutable constraint digest verification
- stricter Handoff constraints preserved in the Task
- return policy contract: `stay_with_target`, `return_on_completion`, `return_on_block`, `explicit_only`
- automatic Handoff settlement on completion, failure and cancellation
- ownership returns to source on completion when configured
- runtime event subscribers receive committed Handoff event batches
- `POST /v1/handoffs/:id/reject`
- canonical JSON Schema/validator alignment

### Execution recovery hardening

**Phase-1 gate complete.**

Recovery is intentionally fail-safe:

```text
stale claimed/running execution
  -> Task already terminal? reconcile, never replay
  -> explicitly retry_safe and attempts remain? requeue
  -> otherwise dead-letter and require operator review
```

Implemented:

- unique runner IDs
- execution claim leases
- heartbeat timestamp and lease expiry
- periodic heartbeat from a running adapter
- runner-owned state transitions
- late/superseded runner receives `ExecutionOwnershipError`
- atomic file-backed Task/Artifact/queue completion
- atomic file-backed failure/cancel transitions
- startup stale-execution sweep
- periodic stale-execution sweep
- persistent `manual` / `retry_safe` recovery policy
- persistent `maxAttempts`
- replay-safe retry with attempt counting
- attempt-exhaustion dead-lettering
- manual/unknown side-effect work never auto-replays
- terminal Task stale-queue reconciliation
- visible blocked Task on dead-letter
- recovery provenance on the Task
- `execution.requeued`
- `execution.dead_letter`
- `execution.reconciled`
- `execution.retry_authorized`
- operator-only dead-letter retry
- `GET /v1/recovery/dead-letters`
- `POST /v1/tasks/:id/retry`
- `recoveryPolicy` and `maxAttempts` on HTTP delegation
- event-driven execution drain deferred one microtask so delegation metadata settles before claim
- slow live runtime proven to remain owned through heartbeat beyond its original short lease

## Current HTTP surface

Implemented main endpoints include:

- `GET /health`
- `GET /v1/bots`
- `POST /v1/bots`
- `POST /v1/messages`
- `GET /v1/mailbox/:id`
- `POST /v1/delegations`
- `POST /v1/tasks/:id/cancel`
- `POST /v1/tasks/:id/retry`
- `GET /v1/recovery/dead-letters`
- `GET /v1/approvals`
- `POST /v1/approvals/:id/approve`
- `POST /v1/approvals/:id/deny`
- `POST /v1/handoffs`
- `POST /v1/handoffs/:id/accept`
- `POST /v1/handoffs/:id/reject`
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

Latest verified GitHub Actions suite after Execution Recovery Hardening: **40/40 passing**.

Newly proven recovery behavior includes:

- stale `retry_safe` execution is requeued
- late old runner loses write authority after recovery
- replacement runner increments execution attempt number
- stale `manual` execution dead-letters rather than replaying
- retry-safe execution dead-letters when attempts are exhausted
- terminal Task with stale queue state is reconciled without replay
- only operator can retry dead-lettered work
- fresh heartbeat prevents stale recovery
- a genuinely slow runtime keeps its execution lease alive through continuous heartbeats
- HTTP delegation persists recovery policy and max attempts
- HTTP dead-letter inspection works
- HTTP Bot actor cannot authorize retry
- HTTP operator retry restores blocked work to `assigned`/`queued`

Previously proven behavior remains covered:

- Handoff atomicity and return policies
- child Task budget inheritance and anti-expansion
- root Task-count budget
- lineage ping-pong protection
- runtime usage over budget fails before Artifact publication
- repeated identical results eventually fail as no progress
- approval-required work cannot execute before approval
- operator approval/denial behavior
- strict Gateway routing
- Room replay
- cancellation and deadline enforcement
- delegation + capability leases
- mailbox persistence
- restart Task execution
- lease expiry failure
- Room/Thread work and replies
- append-only event ordering/idempotency
- event-driven Bot wake-up

Node's built-in `node:sqlite` still emits its experimental-feature warning on Node 22. This is acceptable for the current alpha but must be revisited before a stable runtime-support commitment.

## Remaining Phase 1 work

### A. Bot registry hardening - NEXT

- explicit activate/disable/archive transitions
- duplicate ID protection
- normalized workspace-local name/alias collision rules
- manager relationship validation
- peer relationship validation
- lifecycle transition safety while Bot owns active work

### B. First real runtime adapter

After registry rules are green:

- attach one real useful runtime behind the existing interface
- normalize runtime/tool receipts
- prove two persistent Bots collaborating end-to-end with the real adapter

### C. Final Phase-1 contract pass

- apply Room aggregate max-message/max-round envelopes
- release-level conformance tests
- final restart/cancel/handoff/approval/recovery acceptance scenario
- verify clean install/doctor prerequisites needed for Phase 5 packaging

## Immediate next implementation step

Build **Bot Registry Hardening**.

The registry must treat durable Bot identity as long-lived coordination state. Creating, disabling, reactivating or archiving a Bot must never silently overwrite another Bot, create ambiguous addressing, break workspace boundaries, introduce manager cycles, or strand active owned work.
