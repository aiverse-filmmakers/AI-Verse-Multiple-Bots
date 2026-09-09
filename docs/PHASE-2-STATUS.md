# Phase 2 Status - Dynamic Multi-Agent Squads

**Updated:** 2026-09-09

**Phase:** 2

**Overall status:** IN PROGRESS

**Directional phase progress:** approximately 55%

This file is the implementation ledger for Phase 2. The canonical product roadmap remains `BUILD-MAP.md`.

## Phase 2 goal

A durable Bot decides whether one execution is sufficient or whether a bounded temporary squad is justified, creates run-scoped Workers when needed, coordinates them through explicit Tasks and leases, synthesizes/verifies their outputs, and cleans temporary state without polluting the durable Bot roster.

The package must remain host-neutral. Phase 2 coordination primitives may be embedded by AI-Verse OS, but must not depend on AI-Verse OS, Brain, Memory, Skills, Dashboard, Automations, or any specific host filesystem layout.

## Current verification

GitHub Actions run 146 on 2026-09-09 passed **82/82 tests**, with 0 failures, 0 canceled, and 0 skipped, at commit `3cc9dcea454fc3441543e17bba57407aa93380bc`.

The eight Phase 2.5 acceptance tests pass alongside the previous 74-test suite.

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

- `CoordinationStore.atomicMutation` supports an optional `updatedAt` compare-and-swap precondition
- existing store callers remain backward-compatible
- fan-out creation compares the Team Run row it planned against before committing
- fan-out activation/settlement uses bounded CAS retry when another Gateway process changed the Team Run
- this prevents stale multi-process fan-out state from silently overwriting newer Team Run state

## Phase 2.4 acceptance proof

The tests prove:

1. three independent Workers execute simultaneously and all successful Artifacts are collected
2. scheduling rejects fan-outs above the central concurrency or Team Run Worker ceiling before creating work
3. aggregate consumptive budget is reserved before concurrent Workers become executable
4. `first_success` preserves the winning Artifact and cancels remaining running Workers
5. quorum settles after the required successes and cancels unnecessary remaining work
6. `all` join records partial failure without corrupting successful sibling Artifacts
7. explicit fan-out cancellation propagates to every queued/running Worker Task
8. two stale retry-safe parallel Workers recover after database reopen and satisfy the persisted join

## Slice 2.5 - Direct handoff topology

**COMPLETE**

Phase 2.5 deliberately reuses the canonical Protocol v1.1 `handoff` object rather than inventing a second TeamRun-specific transfer protocol. `TeamRunHandoff` adds bounded TeamRun principal rules around that canonical record.

Implemented:

### Mixed-principal ownership transfer

- host-neutral `TeamRunHandoff` coordinator
- direct queued Task transfer between temporary Workers
- direct queued Task transfer from a temporary Worker to a durable Bot
- durable Bots remain durable registry identities; Workers remain temporary `worker_*` identities
- target Workers are bound to transferred work without Bot registration or promotion
- source Worker participation terminates after accepted transfer rather than remaining a second live owner
- durable Bot targets are added to Team Run participant tracking without changing their registry lifecycle
- same workspace, Team Run, root objective, and Task lineage are preserved

### Immutable safety and authority

- current Task constraint digest is verified before transfer
- Handoff-required constraints may only tighten the Task contract
- capability authority is revoked/reissued to the new principal
- shared-workspace environment authority is transferred through a new scoped lease
- unsupported environment-transfer policies fail closed
- pending Approval actors retarget to the new owner without prematurely creating executable work
- only queued executable work may move; claimed/running execution fails closed
- queue retarget and protocol ownership mutation are atomic on the file-backed package database

### TeamRun-aware runner hardening

- public `PrincipalRunner` validates active Team Run scope for durable Bot-owned run Tasks immediately before runtime execution
- run-scoped execution requires an active same-workspace durable Team Run leader
- run-scoped durable Bots cannot execute after the Team Run leaves an executable state
- run-scoped durable Bot results count toward the same aggregate Team Run token/cost/action budget as Worker results
- aggregate usage is persisted with bounded compare-and-swap retry
- over-budget durable Bot output is rejected before successful Artifact acceptance
- Handoff settlement applies when the execution target is a Worker as well as when it is a Bot
- canonical `return_on_completion` is normalized before claim so execution stays with the accepted target and final ownership returns to the active durable Team Run leader
- that pre-execution return-policy normalization uses bounded compare-and-swap retry, so benign concurrent Team Run updates do not strand queued work
- explicit `stay_with_target` continues to retain final target ownership
- a terminated source Worker is never revived or made final owner during completion settlement
- if the durable leader becomes unavailable at final settlement, ownership safely remains with the completed target and a visible return-skipped event is recorded
- Artifact provenance continues to record the actual producing principal even when final ownership returns to the leader

### Chain controls and cancellation

- Handoff transitions obey the Task/TeamRun hop ceiling across mixed Bot/Worker ownership
- repeated ownership cycles are bounded by recorded Handoff history instead of permitting indefinite ping-pong
- run-wide cancellation reaches queued TeamRun work even after ownership moved to a durable Bot
- accepted Handoffs settle when transferred work completes, fails, or is canceled
- no Room/group discussion is required for direct topology

### Restart and storage proof

- accepted Worker-to-Worker ownership survives a file-backed SQLite close/reopen cycle
- reopened execution queue still targets the accepted Worker
- transferred lease remains scoped to the accepted Worker and Task
- target Worker executes after restart and produces the Artifact under its own temporary identity
- default final Task ownership returns to the active durable Team Run leader after restart settlement
- the terminated source Worker remains terminal throughout settlement

## Phase 2.5 acceptance proof

The eight new tests prove:

1. Worker -> Worker moves queued ownership, preserves temporary identity, executes, settles, and returns final ownership to the durable leader without reviving the source Worker
2. Worker -> durable Bot keeps the Bot durable, enforces TeamRun scope, and persists aggregate usage; explicit `stay_with_target` retains the durable specialist as final owner
3. a run-scoped durable Bot cannot bypass aggregate Team Run budget
4. claimed execution fails closed without changing Worker, queue, or lease ownership
5. a target Worker must belong to the same Team Run
6. combined delegation/Handoff hop ceilings and recorded ownership-loop history stop runaway chains
7. canceling a handoff Team Run cancels durable-Bot-owned queued work and settles the Handoff
8. accepted Worker handoff survives database reopen, executes under the target Worker, settles, and returns final ownership to the durable leader

**Verified suite:** 82 passed, 0 failed, 0 canceled, 0 skipped in GitHub Actions run 146.

## Reusability boundary

Phase 2.5 remains package-owned and host-neutral:

```text
TeamRunManager / TeamRunFanout / TeamRunHandoff / PrincipalRunner / ExecutionSupervisor
  -> CoordinationStore + ExecutionQueue
  -> RuntimeAdapter contract
  -> canonical Handoff / TeamRun / Worker / Task protocol objects
  -> package policy / budget / lease / cancellation primitives
```

There is no import from AI-Verse OS, Brain, Memory, Skills, Dashboard, Automations, or any AI-Verse-specific filesystem/state format.

AI-Verse native integration remains Phase 3 and must arrive through adapters and explicit boundaries rather than becoming embedded inside squad orchestration.

## Next slice

### 2.6 - Group/discussion topology where justified

Required next work:

1. define when a Team Run is allowed to open a temporary discussion surface rather than using manager, fan-out, or direct handoff
2. keep temporary Worker participation separate from durable Room membership
3. choose a bounded discussion object/turn contract that reuses existing Room/Thread/event primitives where possible instead of creating a parallel messaging substrate
4. enforce explicit speaker selection, `max_messages`, `max_rounds`, Team Run budgets, and cancellation
5. preserve workspace, run, root-objective, constraint, and Artifact lineage through every discussion turn
6. prevent free-form all-to-all chatter and Worker ping-pong
7. allow the durable leader to collect discussion outputs as structured candidate Artifacts for later disagreement/synthesis stages
8. define completion/settlement semantics that do not leave temporary Workers active after the discussion closes
9. prove restart/recovery without silently rescheduling completed discussion turns
10. add acceptance tests showing discussion is used only where topology requires it

After selective group discussion, continue through disagreement detection, verifier/critic, synthesis, Worker cleanup hardening, adaptive collaboration gate, and final squad budget/cancellation controls.
