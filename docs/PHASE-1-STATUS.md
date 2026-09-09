# Phase 1 Status - Runnable Coordination Core

**Updated:** 2026-09-09

**Phase:** 1

**Overall status:** COMPLETE, 100%

This file is the implementation ledger for Phase 1. It records what is actually on `main` and the completion evidence for the Runnable Coordination Core.

See `BUILD-MAP.md` for the full Phase 0-5 product roadmap.

## Phase 1 completion milestone

The required milestone was:

> Two persistent Bots can independently exist, communicate asynchronously, delegate real work, transfer responsibility safely, collaborate in a Room/Thread, execute through a real runtime adapter, respect enforced policy/limits/approvals, recover from restart, and cancel/fail without losing coordination integrity.

**Milestone claimed and verified.**

GitHub Actions run 102 at commit `73706c40ddc6249a755655b889aff68240d016aa` passed **54/54 tests**, with 0 failures, 0 canceled, and 0 skipped.

## Completed Phase 1 capabilities

### Core runtime and persistence

- Node.js + TypeScript package
- localhost Coordination Gateway
- SQLite coordination state
- protocol objects
- persistent Bots, Messages, Tasks, Handoffs, Artifacts, Approvals and leases
- conversational mailbox
- separate executable Task queue
- append-only events
- global and per-Room ordering
- idempotency
- restart persistence
- reusable atomic multi-object/event/queue mutation primitive
- SSE event stream
- GitHub Actions CI

### Durable Bot registry

- immutable Bot IDs
- normalized collision-safe addressing
- workspace and operator registry namespaces
- role titles separated from identity addressing
- archived addresses remain reserved
- explicit active/disabled/archived lifecycle
- operator-only lifecycle transitions
- archived lifecycle is terminal
- live-work lifecycle guards
- manager scope, availability, dependency and cycle validation
- peer relationship validation
- safe forward peer declaration
- cross-scope peer rejection
- Room lifecycle integration for disabled/archived Bots
- HTTP address resolution and lifecycle controls

### Runtime adapter boundary

- provider-neutral runtime adapter contract
- structured invocation/result
- deterministic reference runtime
- zero-dependency OpenAI-compatible HTTP model runtime
- endpoint/model selected through Bot runtime configuration
- raw manifest credentials rejected
- environment-variable credential handles
- secret-safe runtime receipts
- normalized input/output token usage
- provider request/model/finish metadata
- abort signal and cancellation hook
- runtime deadline enforcement
- installable Gateway registers both reference and real model runtimes

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

Safeguards include:

- active Bot requirement
- assignee/owner checks
- capability lease validation and expiry
- environment lease lookup
- runtime availability check before claim
- unique runner identity
- execution ownership lease
- continuous heartbeat
- stale runner loses write authority
- atomic completion/failure/cancel finalization
- canceled/failed/over-budget/no-progress work cannot publish a successful Artifact

### Delegation and Artifact collaboration

- explicit assignee and owner
- root objective
- parent Task lineage
- inherited constraints
- immutable constraint digest
- hop/max-hop controls
- scoped capability lease
- tool/connection grants
- response target
- deadlines and inherited deadline clamp
- inherited budget envelope
- child cannot expand parent limits
- root Task-count ceiling
- loop/ping-pong guard before Task creation
- persistent recovery policy and max-attempt metadata
- validated same-workspace input Artifact refs
- Artifact A can become structured input to Bot B
- Artifact attachment is visible in the event stream

### Rooms and Threads

- Room creation/list/get
- workspace-scoped membership
- active Bot validation
- leaders
- registry-backed aliases and `@mentions`
- unresolved/ambiguous mention failures are visible
- Thread creation and replies
- pass semantics
- selective speaker scheduling
- active work owner/collaborators
- Room work becomes real Tasks
- Bot Artifact/result publishes back into Room/Thread
- independent Room event sequence
- Room/Thread replay
- durable turn correlation IDs
- aggregate `max_messages` enforcement across a complete turn
- aggregate `max_rounds` enforcement across a complete turn
- `room.round_scheduled`
- `room.budget_exhausted`

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
- root Task-count limit when configured
- Room message/round limits

### Cancellation and deadlines

- persistent execution cancellation
- cancellation of queued, claimed and running work
- abort signal delivered to runtime
- adapter-specific cancellation hook
- explicit cancellation API
- cancellation authorization
- recursive parent -> child cancellation propagation
- runtime-vs-cancel race handling
- Task deadlines
- deadline-triggered runtime cancellation
- canceled/deadline-exceeded Tasks produce no successful Artifact

### Budgets, loops and progress

- token limit
- cost limit
- action limit
- wall-clock limit
- root Task-count limit
- max-hop integration
- child budget cannot expand parent budget
- runtime usage checked before Artifact acceptance
- Task lineage loop detection
- Bot ping-pong detection
- stable result fingerprinting
- repeated-result/no-progress detection
- Room aggregate round/message limits

### Approval boundary

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

- first-class Approval object
- pending/approved/denied lifecycle
- approval-required capability marker
- operator-only decisions
- approval-required Task stays outside execution until approved
- denial cancels the Task
- approval attention events
- HTTP list/approve/deny controls

### Handoff hardening

- Protocol v1.1 canonical Handoff fields
- source ownership/root/workspace/status checks
- one active Handoff per Task
- target-only acceptance
- target/operator rejection
- atomic Handoff + Task + lease + Approval + queue + event mutation
- queued execution retargeting
- claimed/running Handoff fails closed
- capability authority reissued to target
- target capability compatibility checks
- shared-workspace environment lease reissue
- isolated/external environment transfer fails closed pending a secure adapter
- pending Approval actor retargets with the Handoff
- immutable constraint verification
- return policies: `stay_with_target`, `return_on_completion`, `return_on_block`, `explicit_only`
- automatic Handoff settlement
- ownership return on completion where configured
- lifecycle and ownership audit events
- HTTP request/accept/reject endpoints

### Execution recovery hardening

Recovery remains deliberately fail-safe:

```text
stale claimed/running execution
  -> Task already terminal? reconcile, never replay
  -> explicitly retry_safe and attempts remain? requeue
  -> otherwise dead-letter and require operator review
```

Implemented:

- runner IDs and execution claim leases
- heartbeat and lease expiry
- ownership-checked transitions
- late runner write rejection
- startup and periodic stale execution sweep
- `manual` and `retry_safe` policies
- persistent max attempts
- retry-safe replay only while attempts remain
- attempt-exhaustion dead-lettering
- terminal Task reconciliation without replay
- blocked dead-letter state with provenance
- operator-only retry
- HTTP dead-letter inspection/retry

## Phase 1 release-level conformance proof

The final combined acceptance scenario uses one file-backed coordination database and deliberately closes and recreates the Gateway mid-workflow.

It proves together:

1. two durable Bots survive the restart
2. a queued Bot-to-Bot mailbox message survives the restart
3. Room and Thread state survive the restart
4. approval-gated work remains non-executable before approval
5. a requested Handoff survives the restart
6. Handoff acceptance after restart changes responsibility and reissues authority
7. the pending Approval actor moves to the new owner
8. operator approval starts real model-backed execution
9. OpenAI-compatible runtime usage/receipts normalize correctly
10. Handoff settlement returns ownership according to policy
11. Room/Thread collaboration still works after restart
12. aggregate Room round limits stop further scheduling
13. denied work is canceled and produces no Artifact
14. required audit events remain present
15. raw runtime secrets are not persisted into Bots/Tasks/Artifacts/events
16. `doctor()` remains healthy after the restart

## Test and CI status

**Latest verified suite: 54/54 passing.**

Coverage includes:

- Bot registry collisions, lifecycle, relationships and address resolution
- approval gating and denial
- explicit cancellation and deadlines
- parent/child cancellation
- delegation and capability leases
- Handoff atomicity, authority reissue and return policies
- persistent mailbox and restart behavior
- real HTTP model execution
- two-Bot Artifact A -> Bot B collaboration
- raw model credential rejection
- cross-workspace Artifact rejection
- strict policy enforcement
- execution heartbeat and stale recovery
- retry-safe and manual recovery paths
- dead-letter retry authorization
- Room/Thread scheduling and replies
- Room `max_messages` and `max_rounds`
- full Phase 1 restart conformance scenario
- budget inheritance and anti-expansion
- loop/ping-pong/no-progress guards
- append-only event ordering/idempotency
- event-driven Bot wake-up

Node's built-in `node:sqlite` still emits its experimental-feature warning on Node 22. This is acceptable for the current alpha and remains a runtime-support decision to revisit before a stable release commitment.

## Current HTTP surface

Implemented main endpoints include:

- `GET /health`
- `GET /v1/bots`
- `POST /v1/bots`
- `GET /v1/bots/resolve`
- `GET /v1/bots/:id`
- `POST /v1/bots/:id/activate`
- `POST /v1/bots/:id/disable`
- `POST /v1/bots/:id/archive`
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

## Remaining Phase 1 work

**None.**

Phase 1 is closed. New orchestration features should not be backfilled into Phase 1 unless they are fixes for a Phase 1 contract regression.

## Next implementation phase

**Phase 2 - Dynamic Multi-Agent Squads.**

The next architectural gate is for one durable Bot to decide when the smallest sufficient topology is a temporary squad, create bounded Workers, coordinate parallel/supervised work, synthesize/verifiy results, enforce squad budgets/cancellation, and clean up temporary Worker state without turning Workers into durable Bot identities.
