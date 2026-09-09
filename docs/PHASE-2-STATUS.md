# Phase 2 Status - Dynamic Multi-Agent Squads

**Updated:** 2026-09-09

**Phase:** 2

**Overall status:** IN PROGRESS

This file is the implementation ledger for Phase 2. The canonical product roadmap remains `BUILD-MAP.md`.

## Phase 2 goal

A durable Bot decides whether one execution is sufficient or whether a bounded temporary squad is justified, creates run-scoped Workers when needed, coordinates them through explicit Tasks and leases, synthesizes/verifies their outputs, and cleans temporary state without polluting the durable Bot roster.

The package must remain host-neutral. Phase 2 coordination primitives may be embedded by AI-Verse OS, but must not depend on AI-Verse OS, Brain, Memory, Skills, Dashboard, Automations, or any specific host filesystem layout.

## Current verification

GitHub Actions run 109 on 2026-09-09 passed **60/60 tests**, with 0 failures, 0 canceled, and 0 skipped, at commit `bf745457ccb37922ae2d8873eb0dc908631b089f`.

## Slice 2.1 - Team Run object and lifecycle

**COMPLETE**

Added `TeamRunCoordinator` with:

- canonical `team_run` protocol records
- active durable Bot leader requirement
- workspace equality enforcement
- topology contract matching Protocol v1.1
- normalized Team Run budget
- `max_workers` validation
- explicit state machine for created/planning/running/waiting/synthesis/verification/terminal states
- terminal-state immutability
- completion blocked while Workers remain active
- cancellation/failure/budget exhaustion cascade to active Workers
- atomic object + event mutation through the existing coordination store
- optimistic/concurrent lifecycle preconditions
- run-scoped audit events carrying `run_id`
- restart-persistent Team Run state

## Slice 2.2 - Temporary Worker identity and lifecycle

**COMPLETE**

Added:

- `worker_*` temporary identities separate from the durable Bot registry
- no default Room membership
- no default long-term memory authority
- leader-only Worker creation/mutation
- durable Bot `can_create_workers` permission enforcement
- Team Run `max_workers` enforcement
- Worker budget cannot expand configured Team Run limits
- optional runtime/execution metadata without binding to one provider or OS
- Worker Task binding
- Worker cannot become ready/running without a bound Task
- Task must be assigned to and owned by the Worker in the same workspace
- explicit Worker state machine
- terminal Team Run prevents new Worker creation
- run cancellation/failure/budget exhaustion cancels active Workers
- post-run Worker cleanup converts retained audit identities to `expired`
- Worker records and lifecycle events survive restart

The runtime validator was aligned with the existing JSON Schema so a canonical Worker may exist in `created` state with `task_id: null` before its bounded Task is attached.

## Reusability boundary

The new coordinator depends only on package-owned primitives:

```text
TeamRunCoordinator
  -> CoordinationStore
  -> protocol validator
  -> package budget + ID primitives
```

It has no AI-Verse-specific import or canonical-state dependency.

This is intentional. AI-Verse native integration remains Phase 3 and must arrive through adapters/boundaries rather than being embedded into Phase 2 orchestration.

## Tests added in this slice

The new Phase 2 test file covers:

1. active durable leader and workspace enforcement
2. run-scoped Worker identity and `max_workers`
3. Worker Task binding before activation
4. Worker lifecycle transitions
5. Team Run completion guard
6. cancellation cascade
7. terminal cleanup to `expired`
8. leader-only mutation
9. `can_create_workers` denial
10. restart persistence and run-scoped event audit

All six Phase 2 test cases passed inside the full 60-test repository suite.

## Not claimed yet

This slice does **not** claim that temporary Workers execute through the existing supervisor yet.

The current Phase 1 `ExecutionSupervisor` deliberately resolves executable targets through the durable Bot registry. Phase 2 must extend execution dispatch so a Worker resolves its runtime, capability lease, environment lease, budget and cancellation from its Team Run/Task without pretending the Worker is a durable Bot.

## Next slice

### 2.3 - Worker execution + manager/supervisor topology

Required next work:

1. Worker runtime resolution contract
2. Worker-aware execution dispatch without Bot-registry promotion
3. Task/lease/environment validation for Worker execution
4. Team Run cancellation propagation into queued/running Worker Tasks
5. manager/supervisor topology
6. bounded parallel execution hooks
7. aggregate Team Run budget accounting
8. event-driven Worker wake-up
9. restart/recovery coverage for executing Workers

After that, continue through parallel fan-out, direct handoff topology, selective group discussion, disagreement detection, verifier/critic, synthesis, adaptive collaboration gate, and full squad budget/cancellation controls.
