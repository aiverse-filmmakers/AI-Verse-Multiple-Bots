# Phase 2 Status - Dynamic Multi-Agent Squads

**Updated:** 2026-09-09

**Phase:** 2

**Overall status:** IN PROGRESS

**Directional phase progress:** approximately 45%

This file is the implementation ledger for Phase 2. The canonical product roadmap remains `BUILD-MAP.md`.

## Phase 2 goal

A durable Bot decides whether one execution is sufficient or whether a bounded temporary squad is justified, creates run-scoped Workers when needed, coordinates them through explicit Tasks and leases, synthesizes/verifies their outputs, and cleans temporary state without polluting the durable Bot roster.

The package must remain host-neutral. Phase 2 coordination primitives may be embedded by AI-Verse OS, but must not depend on AI-Verse OS, Brain, Memory, Skills, Dashboard, Automations, or any specific host filesystem layout.

## Current verification

GitHub Actions run 127 on 2026-09-09 passed **74/74 tests**, with 0 failures, 0 canceled, and 0 skipped, at commit `daa9693d14114d01b2a97d6e3b830d7ea2ad735b`.

The eight Phase 2.4 acceptance tests pass alongside the previous 66-test suite.

## Slice 2.1 - Team Run object and lifecycle

**COMPLETE**

Implemented:

- canonical `team_run` protocol records
- active durable Bot leader requirement
- workspace equality enforcement
- topology contract matching Protocol v1.1
- normalized Team Run budget and `max_workers` validation
- explicit lifecycle state machine and terminal-state immutability
- completion blocked while Workers remain active
- atomic object + event mutation through the coordination store
- optimistic lifecycle preconditions
- run-scoped audit events and restart-persistent state
- terminal Team Run transitions refuse to strand live Worker Tasks outside execution cancellation

## Slice 2.2 - Temporary Worker identity and lifecycle

**COMPLETE**

Implemented:

- `worker_*` temporary identities separate from the durable Bot registry
- no default Room membership or long-term memory authority
- leader-only Worker creation/mutation
- durable Bot `can_create_workers` permission enforcement
- Team Run `max_workers` enforcement
- Worker budget cannot expand configured Team Run limits
- optional runtime/execution metadata without binding to one provider or OS
- Worker Task binding and explicit Worker state machine
- Worker cannot become ready/running without a bound Task
- Task must be assigned to and owned by the Worker in the same workspace
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
- Task ownership/assignment and Worker/Task/TeamRun workspace/run linkage validation
- capability and environment lease validation before execution
- Worker and Task budgets cannot expand Team Run authority
- successful Worker execution creates immutable `worker_generated` Artifacts
- Worker result returns to the durable leader without granting durable Room membership
- Worker/Task/queue lifecycle synchronization on completion, failure and cancellation
- Team Run cancellation aborts queued/running Worker Tasks

### Manager topology

- `TeamRunManager` prepares bounded Worker Tasks under one durable leader
- Worker identity exists before executable Task assignment
- Worker + capability lease + Task binding persist before `task.assigned`
- Worker capability requests cannot exceed leader grants
- inherited constraints/budget ceilings remain enforced
- input Artifacts must belong to the same workspace
- manager-created Worker results target the durable leader

### Squad controls established in 2.3

- aggregate Team Run token/cost/action usage checked before Artifact acceptance
- budget exhaustion fails over-budget work and moves the Team Run to `budget_exhausted`
- sibling active Worker Tasks cancel on Team Run budget exhaustion
- retry-safe stale Worker execution can recover after database restart
- manual/dead-letter recovery remains fail-safe

## Slice 2.4 - Bounded parallel fan-out

**COMPLETE**

Implemented:

### Fan-out scheduling

- host-neutral `TeamRunFanout` coordinator
- bounded parallel fan-out for `parallel_panel`, `dynamic_squad`, and `hybrid` Team Runs
- one active fan-out per Team Run at a time
- central concurrency ceiling from durable leader `max_parallel_workers`, Team Run `max_workers`, and optional per-call `maxConcurrency`
- `max_workers` and root Task-count ceilings enforced before executable work is created
- every Worker receives an independent Task, capability lease, runtime context, budget envelope, and output path
- fan-out Workers remain temporary principals and never enter the durable Bot registry

### Reservation-safe squad budgets

- Team Run token, cost, and action capacity is reserved across the full fan-out before Workers become executable
- explicit per-Worker reservations cannot collectively exceed Team Run remaining capacity
- unspecified Worker reservations are boundedly divided across remaining Team Run capacity
- concurrent Workers cannot each independently consume the entire Team Run allowance
- successful Task usage remains the canonical consumed-usage source

### Durable activation and restart safety

- two-stage fan-out lifecycle: `preparing` -> `running`
- protocol records persist before execution wake-up
- queue insertion is idempotent
- startup recovery finishes a partially prepared fan-out before normal queue draining
- stale retry-safe Workers recover independently after a database reopen
- persisted join state is reconciled after recovery

### Join semantics

- `all` join waits for every Worker and preserves all successful Artifacts even if siblings fail
- `first_success` settles on the first successful Worker and can cancel the unnecessary remainder
- bounded quorum join settles when the configured success threshold is reached
- impossible quorum resolves as failed rather than hanging indefinitely
- join state records successful, failed, canceled, and pending Task IDs plus collected Artifact references

### Cancellation and Artifact collection

- explicit fan-out cancellation propagates across queued and running Worker Tasks
- first-success/quorum cancellation only targets unnecessary nonterminal siblings
- successful sibling Artifacts survive partial failure and cancellation of unrelated Workers
- durable leader can collect fan-out Artifacts for the later synthesis stage

### Cross-process concurrency hardening

- `CoordinationStore.atomicMutation` now supports an optional `updatedAt` compare-and-swap precondition
- existing store callers remain backward-compatible
- fan-out creation compares the Team Run row it planned against before committing
- fan-out activation/settlement uses bounded CAS retry when another Gateway process changed the Team Run
- this prevents stale multi-process fan-out state from silently overwriting newer Team Run state

## Phase 2.4 acceptance proof

The new tests prove:

1. three independent Workers execute simultaneously and all successful Artifacts are collected
2. scheduling rejects fan-outs above the central concurrency or Team Run Worker ceiling before creating work
3. aggregate consumptive budget is reserved before concurrent Workers become executable
4. `first_success` preserves the winning Artifact and cancels remaining running Workers
5. quorum settles after the required successes and cancels unnecessary remaining work
6. `all` join records partial failure without corrupting successful sibling Artifacts
7. explicit fan-out cancellation propagates to every queued/running Worker Task
8. two stale retry-safe parallel Workers recover after database reopen and satisfy the persisted join

**Verified suite:** 74 passed, 0 failed, 0 canceled, 0 skipped.

## Reusability boundary

Phase 2.4 remains package-owned and host-neutral:

```text
TeamRunManager / TeamRunFanout / PrincipalRunner / ExecutionSupervisor
  -> CoordinationStore + ExecutionQueue
  -> RuntimeAdapter contract
  -> protocol validator
  -> package policy / budget / lease primitives
```

There is no import from AI-Verse OS, Brain, Memory, Skills, Dashboard, Automations, or any AI-Verse-specific filesystem/state format.

AI-Verse native integration remains Phase 3 and must arrive through adapters and explicit boundaries rather than becoming embedded inside squad orchestration.

## Next slice

### 2.5 - Direct handoff topology

Required next work:

1. TeamRun-level direct handoff topology distinct from the Phase 1 durable-Bot Task handoff primitive
2. explicit source/target principal rules for durable leader, temporary Worker, and durable Bot where topology permits
3. ownership transfer that never silently promotes a Worker or bypasses the durable Bot registry
4. same-workspace/run/root-objective and immutable-constraint preservation
5. capability/environment authority reissue or fail-closed behavior at each ownership boundary
6. queue ownership transfer only when execution is safely movable
7. return-to-leader and stay-with-target completion semantics for TeamRun work
8. cancellation/failure propagation across a handoff chain
9. hop/loop bounds across mixed Bot/Worker principals
10. restart/recovery proof for a handed-off TeamRun Task
11. Artifact lineage proving which principal produced each result
12. acceptance tests demonstrating direct handoff without Room/group discussion

After direct handoff topology, continue through selective group discussion, disagreement detection, verifier/critic, synthesis, Worker cleanup hardening, adaptive collaboration gate, and final squad budget/cancellation controls.
