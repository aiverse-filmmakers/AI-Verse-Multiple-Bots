# Phase 2 Status - Dynamic Multi-Agent Squads

**Updated:** 2026-09-09

**Phase:** 2

**Overall status:** IN PROGRESS

**Directional phase progress:** approximately 30%

This file is the implementation ledger for Phase 2. The canonical product roadmap remains `BUILD-MAP.md`.

## Phase 2 goal

A durable Bot decides whether one execution is sufficient or whether a bounded temporary squad is justified, creates run-scoped Workers when needed, coordinates them through explicit Tasks and leases, synthesizes/verifies their outputs, and cleans temporary state without polluting the durable Bot roster.

The package must remain host-neutral. Phase 2 coordination primitives may be embedded by AI-Verse OS, but must not depend on AI-Verse OS, Brain, Memory, Skills, Dashboard, Automations, or any specific host filesystem layout.

## Current verification

GitHub Actions run 116 on 2026-09-09 passed **66/66 tests**, with 0 failures, 0 canceled, and 0 skipped, at commit `c0399a9bcc6a78a917ec1942007f81290baa18e7`.

The six new Phase 2.3 acceptance tests pass alongside the previous 60-test suite.

## Slice 2.1 - Team Run object and lifecycle

**COMPLETE**

Implemented:

- canonical `team_run` protocol records
- active durable Bot leader requirement
- workspace equality enforcement
- topology contract matching Protocol v1.1
- normalized Team Run budget
- `max_workers` validation
- explicit state machine for created/planning/running/waiting/synthesis/verification/terminal states
- terminal-state immutability
- completion blocked while Workers remain active
- atomic object + event mutation through the existing coordination store
- optimistic/concurrent lifecycle preconditions
- run-scoped audit events carrying `run_id`
- restart-persistent Team Run state
- terminal Team Run transitions now refuse to strand live Worker Tasks outside execution cancellation

## Slice 2.2 - Temporary Worker identity and lifecycle

**COMPLETE**

Implemented:

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
- post-run Worker cleanup converts retained audit identities to `expired`
- Worker records and lifecycle events survive restart

The runtime validator remains aligned with the JSON Schema so a canonical Worker may exist in `created` state with `task_id: null` before its bounded Task is attached.

## Slice 2.3 - Worker execution + manager/supervisor topology

**COMPLETE**

Implemented:

### Execution principal boundary

- common execution-principal contract for durable Bots and temporary Workers
- `BotRunner` remains backward-compatible while delegating to a host-neutral `PrincipalRunner`
- Workers execute as their canonical `worker_*` identity
- no synthetic Bot manifest is created for a Worker
- Worker execution never registers or promotes the Worker in the durable Bot registry
- built-in deterministic and OpenAI-compatible runtimes consume the common principal contract
- Worker runtime configuration can inherit the durable leader runtime and apply run-scoped overrides

### Worker execution safety

- Worker-aware event-driven supervisor wake-up
- Task must be assigned to and owned by the Worker
- Worker, Task and Team Run workspace/run linkage is validated before runtime execution
- capability lease must be issued to the Worker, scoped to the Task, same-workspace and unexpired
- environment lease, when present, must match Worker/workspace/Task and remain unexpired
- Worker and Task budgets cannot expand Team Run authority
- successful Worker execution creates an immutable Artifact with `worker_generated` provenance
- Worker result returns to the durable leader without granting default durable Room membership
- Worker/Task/queue lifecycle remains synchronized on completion, failure and cancellation
- live Team Run cancellation aborts queued/running Worker Tasks through the existing execution cancellation path

### Manager topology

- `TeamRunManager` prepares bounded Worker Tasks under one durable leader
- Worker identity is created before executable Task assignment
- Worker + capability lease + Task binding persist before `task.assigned` is emitted
- this removes the assignment-before-binding race
- Worker capability requests cannot exceed the durable leader's tool/connection grants
- inherited constraints and budget ceilings remain enforced
- input Artifacts must belong to the same workspace
- manager-created Worker results target the durable leader

### Squad-level controls already active

- aggregate Team Run token/cost/action usage is checked before accepting a Worker Artifact
- aggregate budget exhaustion fails the over-budget Task and moves the Team Run to `budget_exhausted`
- sibling active Worker Tasks are canceled when the Team Run budget is exhausted
- retry-safe stale Worker execution can recover after database restart
- recovered Workers move back through the correct ready/running lifecycle
- manual/dead-letter recovery continues to use the Phase 1 fail-safe recovery boundary

## Phase 2.3 acceptance proof

The new tests prove:

1. manager topology executes a real temporary Worker Task and returns its Artifact to the durable leader
2. runtime context carries the Worker as the canonical principal and does not fabricate a Bot identity
3. managed Workers cannot expand leader tool authority
4. canceling a Team Run aborts a running Worker Task and publishes no successful Artifact
5. aggregate Team Run budget is enforced before a second over-budget Worker Artifact can be accepted
6. retry-safe stale Worker execution survives store reopen and completes on the next authorized attempt

**Verified suite:** 66 passed, 0 failed, 0 canceled, 0 skipped.

## Reusability boundary

Phase 2.3 remains package-owned and host-neutral:

```text
TeamRunManager / PrincipalRunner / ExecutionSupervisor
  -> CoordinationStore + ExecutionQueue
  -> RuntimeAdapter contract
  -> protocol validator
  -> package policy / budget / lease primitives
```

There is no import from AI-Verse OS, Brain, Memory, Skills, Dashboard, Automations, or any AI-Verse-specific filesystem/state format.

AI-Verse native integration remains Phase 3 and must arrive through adapters and explicit boundaries rather than becoming embedded inside squad orchestration.

## Next slice

### 2.4 - Parallel fan-out

Required next work:

1. bounded multi-Worker fan-out API under one Team Run
2. central concurrency ceiling and `max_workers` enforcement at scheduling time
3. atomic or reservation-safe aggregate Team Run budget accounting under concurrent completions
4. independent Worker context packets and Artifact outputs
5. `all`, `first_success`, and bounded quorum/join semantics where justified
6. partial failure handling without corrupting successful sibling results
7. cancellation fan-out across queued and running Workers
8. restart/recovery proof with more than one concurrent Worker
9. manager collection of Worker Artifacts for the later synthesis stage

After parallel fan-out, continue through direct handoff topology, selective group discussion, disagreement detection, verifier/critic, synthesis, adaptive collaboration gate, and final squad budget/cancellation hardening.
