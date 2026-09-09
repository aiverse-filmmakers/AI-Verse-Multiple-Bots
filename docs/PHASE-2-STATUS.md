# Phase 2 Status - Dynamic Multi-Agent Squads

**Updated:** 2026-09-09

**Phase:** 2

**Overall status:** IN PROGRESS

**Directional phase progress:** approximately 80%

This file is the implementation ledger for Phase 2. The canonical product roadmap remains `BUILD-MAP.md`.

## Phase 2 goal

A durable Bot decides whether one execution is sufficient or whether a bounded temporary squad is justified, creates run-scoped Workers when needed, coordinates them through explicit Tasks and leases, synthesizes/verifies their outputs, and cleans temporary state without polluting the durable Bot roster.

The package must remain host-neutral. Phase 2 coordination primitives may be embedded by AI-Verse OS, but must not depend on AI-Verse OS, Brain, Memory, Skills, Dashboard, Automations, or any specific host filesystem layout.

## Current verification

GitHub Actions run 180 on 2026-09-09 passed **118/118 tests**, with 0 failures, 0 canceled, and 0 skipped, at commit `ac785919a549c36ff882788cc6f362a9e4085120`.

The fourteen Phase 2.8 verifier/critic acceptance and hardening tests pass alongside all previous Phase 1 and Phase 2 coverage.

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

The eight tests prove:

1. Worker -> Worker moves queued ownership, preserves temporary identity, executes, settles, and returns final ownership to the durable leader without reviving the source Worker
2. Worker -> durable Bot keeps the Bot durable, enforces TeamRun scope, and persists aggregate usage; explicit `stay_with_target` retains the durable specialist as final owner
3. a run-scoped durable Bot cannot bypass aggregate Team Run budget
4. claimed execution fails closed without changing Worker, queue, or lease ownership
5. a target Worker must belong to the same Team Run
6. combined delegation/Handoff hop ceilings and recorded ownership-loop history stop runaway chains
7. canceling a handoff Team Run cancels durable-Bot-owned queued work and settles the Handoff
8. accepted Worker handoff survives database reopen, executes under the target Worker, settles, and returns final ownership to the durable leader

## Slice 2.6 - Bounded group/discussion topology

**COMPLETE**

Phase 2.6 reuses the existing Room, Thread, Message, Task, Worker, Artifact, event, lease, and Team Run primitives instead of creating a parallel chat substrate. Discussion is an explicitly bounded TeamRun coordination topology, not free-form agent chatter.

Implemented:

### Temporary discussion surface and topology gate

- host-neutral `TeamRunDiscussion` coordinator
- discussion allowed only for `group_room`, `dynamic_squad`, and `hybrid` Team Runs
- minimum two explicit speakers with deterministic speaker/round turn plans
- one temporary Room and Thread scoped to the Team Run
- durable leader remains the only durable Room member
- Workers are listed only as temporary participants and never enter the Bot registry or durable Room membership
- one open discussion/setup reservation per Team Run; a competing opener fails closed before creating another Worker set

### Bounded participant lifecycle

- one temporary Worker identity per discussion role is reused across rounds instead of creating one Worker per message
- successful discussion turns move Worker `running -> waiting`, not to a terminal state
- reusable discussion Workers keep `terminal_at: null` between turns
- ordinary Worker Tasks keep the existing terminal-on-completion behavior
- stale recovery recognizes completed discussion turns and restores the participant to `waiting`
- Workers become terminal only when the discussion itself completes, fails, or is canceled
- no terminal Worker is resurrected to continue a later round

### Explicit turn execution and authority

- each turn is a real Task with its own capability lease, budget, constraints, root objective, speaker identity, round, and turn index
- speaker tool/connection grants are persisted in discussion state and applied to the turn-scoped lease
- requested grants cannot expand the durable leader's authority
- Team Run `max_workers`, `max_messages`, `max_rounds`, and `max_tasks` bound the turn plan before work is scheduled
- scheduling uses Room and Team Run compare-and-swap preconditions so stale planners do not silently overwrite newer coordination state
- Workers cannot schedule side conversations or another speaker directly

### Candidate evidence and transcript lineage

- each successful turn creates a `worker_generated` candidate Artifact under the actual Worker identity
- successful candidate Artifact references are accumulated on the discussion and Team Run
- later turns receive prior candidate Artifacts as structured inputs
- a bounded recent transcript is included as non-authoritative discussion context
- candidate Artifacts must remain in both the same workspace and the same Team Run
- the durable leader receives the bounded candidate collection for later disagreement/synthesis stages

### Room publication isolation

- a `worker_*` may publish into a Room only when it is an explicit temporary participant of that exact temporary TeamRun discussion
- Worker, Room, and Artifact must share workspace and Team Run
- Worker can publish only its own candidate Artifact
- Worker publication from unrelated/durable Rooms or cross-run contexts fails closed
- Worker Room messages keep `worker_generated` provenance and are not trusted instructions

### Restart, idempotency, and shared-store hardening

- Team Run setup is reserved with an `updatedAt` compare-and-swap before temporary Workers are created
- deterministic kickoff Message, discussion Thread, and turn Message IDs make recovery replay idempotent
- discussion/open/turn/settlement/close events use idempotency keys
- turn settlement and discussion close use bounded optimistic retry
- completed-but-unreconciled turns resume from the next explicit turn after database reopen without duplicating completed Tasks
- assigned turns are re-enqueued idempotently on startup
- a stale setup reservation intentionally fails closed rather than silently forming a second squad; automatic reservation timeout/reaping is not claimed in this slice

### Cancellation and settlement

- leader/operator cancellation reaches the current queued/running discussion Task through the common runner
- failure/cancellation closes the bounded discussion instead of continuing with uncontrolled remaining speakers
- completion closes the temporary Room/Thread and terminalizes the temporary participant set
- successful candidate Artifacts remain available to the durable leader after closure

## Phase 2.6 acceptance proof

The eleven discussion tests prove:

1. a temporary discussion Room keeps Workers outside durable Room membership and the Bot registry
2. a successful discussion turn leaves its Worker reusable in `waiting` with no terminal timestamp
3. speaker tool/connection grants survive setup and reach the turn capability lease
4. temporary Worker Room publication fails closed across Team Run boundaries
5. an existing setup reservation blocks a second opener before any additional temporary Workers are created
6. two temporary participants are reused across two rounds and produce four ordered candidate Artifacts
7. later turns receive prior candidate Artifacts as structured inputs
8. `max_messages`, `max_rounds`, and `max_tasks` cap a requested discussion before work is scheduled
9. topologies that do not justify group deliberation fail closed
10. cancellation closes the active discussion and every temporary participant
11. database restart after a completed-but-unreconciled turn resumes at the next turn without duplicating completed work or Worker turn records

## Slice 2.7 - Structured disagreement detection

**COMPLETE**

Phase 2.7 introduces a deterministic comparison layer over explicit candidate Artifact claims. It does not inspect or request hidden model reasoning and does not make an additional model call mandatory merely to decide whether candidates disagree.

Implemented:

### Structured claim contract

- host-neutral `TeamRunDisagreementDetector`
- accepts declared claims under `inline_content.claims[]`
- supported claim kinds: `fact`, `constraint`, `recommendation`, `estimate`, and `opinion`
- normalizes subjects and canonicalizes values for deterministic comparison
- optional stance, confidence, evidence refs, exclusivity group, relation, and numeric tolerance metadata
- malformed/unsupported claim fields are recorded as invalid evidence rather than silently interpreted

### Conflict classification

- fact claims with incompatible values become high-severity evidence conflicts
- constraint claims with incompatible values become high-severity contradictions
- opposed support/oppose stances on the same declared claim become contradictions
- differing recommendations remain compatible unless exclusivity is explicitly declared
- estimates conflict only when their gap exceeds declared tolerance
- same conclusions with a material confidence delta become a confidence-gap finding without automatically forcing verifier work
- non-comparable/unstructured candidates resolve to `insufficient_evidence` instead of invented disagreement

### Report and provenance model

- every analysis creates or reuses an immutable `disagreement_report` Artifact
- findings retain source Artifact refs and claim refs
- report provenance references the analyzed source Artifacts
- deterministic analysis digest/report ID makes repeated identical input idempotent regardless of Artifact-ref order
- idempotent `disagreement.analyzed` event prevents duplicate replay noise
- latest/report-history refs persist on the Team Run and survive database reopen

### Scope, budget, and concurrency safety

- all candidate Artifacts must belong to the same workspace and Team Run
- disagreement reports themselves cannot be fed back as candidate inputs
- Artifact and claim ceilings bound comparison work
- Team Run state persistence uses `updatedAt` compare-and-swap with bounded retry
- only the active durable Team Run leader or an operator may run analysis
- `latest()` and `list()` ignore cross-run/cross-workspace report refs even if persisted state is poisoned

### Verification-debt semantics

- hard conflicts set Team Run `requires_verification: true`
- hard-conflict report IDs are accumulated in `verification_required_report_refs`
- verification debt is monotonic in this slice: a later compatible/confidence-only subset cannot clear an earlier unresolved hard conflict
- a current compatible report can truthfully say that it does not itself require verification while the Team Run still records unresolved prior verification debt
- Phase 2.8 owns explicit resolution/removal of verified report refs and eventual clearing of the Team Run verification flag

## Phase 2.7 acceptance proof

The eleven disagreement tests prove:

1. same fact with incompatible values creates a high-severity evidence conflict and requires verification
2. different recommendations remain compatible unless explicitly mutually exclusive
3. opposed stances on the same declared claim are contradictions
4. a material confidence gap is surfaced without automatically forcing verifier work
5. estimate gaps conflict only beyond declared tolerance
6. unstructured/non-comparable candidates return insufficient evidence rather than hallucinating disagreement
7. candidate scope and bounded input ceilings fail closed before report creation
8. identical analysis is deterministic and idempotent
9. default candidate refs and disagreement report history survive database reopen
10. later compatible subset analysis cannot clear unresolved Team Run verification debt
11. report lookup/listing ignores disagreement reports belonging to another Team Run

**Verified suite:** 104 passed, 0 failed, 0 canceled, 0 skipped in GitHub Actions run 173.

## Slice 2.8 - Bounded verifier/critic role

**COMPLETE**

Phase 2.8 consumes the explicit verification debt produced by structured disagreement detection. It does not trust a model/runtime result to mutate Team Run verification state directly: runtime output is candidate evidence until the package validates report, finding, scope, and evidence lineage and creates a canonical verdict Artifact.

Implemented:

### Verification scheduling and bounded identity

- host-neutral `TeamRunVerifier`
- verifier work is scheduled only for report IDs present in `verification_required_report_refs`
- scheduling with no unresolved verification debt returns a no-op instead of creating unnecessary work
- one temporary `worker_*` verifier can evaluate a selected set of pending reports in one bounded Task
- verifier Worker remains outside the durable Bot registry and durable Room membership
- verifier creation obeys Team Run `max_workers`; verification is not exempt from the configured Worker budget
- only the active durable Team Run leader may schedule verifier work
- one active verifier Task per Team Run prevents duplicate live verification work

### Authority and execution inheritance

- verifier tool/connection grants cannot exceed durable leader authority
- verifier budget cannot expand the Team Run budget
- verifier execution policy inherits the durable leader execution contract by default
- execution overrides cannot switch the leader `environment_policy`
- capability lease remains Task-, Worker-, workspace-, and TeamRun-scoped
- verifier inputs are restricted to the disagreement reports and same-TeamRun source Artifacts

### Structured verdict contract

- runtime output must use `verifier-verdict-v1`
- every requested report must receive exactly one report verdict
- every hard disagreement finding must receive exactly one finding verdict
- supported report/finding outcomes are `resolved`, `unresolved`, and `insufficient_evidence`
- resolved findings must cite scoped Artifact evidence
- unknown/duplicate/omitted report or finding refs fail closed
- cross-workspace or cross-TeamRun resolution evidence fails closed
- malformed or contradictory runtime output becomes `verifier_failed` and cannot clear verification debt

### Canonical debt settlement

- validated runtime output is converted into an immutable canonical `verification_verdict` Artifact
- verdict Artifact retains disagreement-report, candidate/evidence, runtime-output, Task, Worker, workspace, and Team Run provenance
- only report IDs whose validated report outcome is `resolved` are removed from `verification_required_report_refs`
- unrelated unresolved report debt is preserved during partial verification
- `requires_verification` clears only when no unresolved verification-required report refs remain
- a fully resolved verifier cycle moves the Team Run to `synthesizing`
- unresolved, insufficient-evidence, verifier-failed, and canceled cycles keep the Team Run in `verifying`
- resolution bookkeeping persists `resolved_verification_report_refs`, verdict history, latest verdict, and last outcome

### Cancellation, idempotency, and recovery

- leader/operator cancellation uses the common runner cancellation path
- cancellation creates a canonical canceled verdict and preserves unresolved debt
- failed verifier execution preserves unresolved debt
- verdict IDs are deterministic from canonical settlement material, making repeated reconciliation idempotent
- an already settled verifier Task returns its existing canonical verdict rather than creating a duplicate
- `ExecutionSupervisor` reconciles verifier Tasks after execution and recovery
- startup recovery re-enqueues assigned verifier work idempotently and settles completed-but-unreconciled Tasks
- completed verifier work survives database reopen and settles without duplicate verdict Artifacts
- Team Run settlement uses `updatedAt` compare-and-swap with bounded retry

## Phase 2.8 acceptance proof

The fourteen verifier/critic acceptance and hardening tests prove:

1. resolved verifier work clears exactly its resolved debt, creates a canonical verdict, and moves a debt-free run to `synthesizing`
2. unresolved verifier work preserves debt and keeps the Team Run `verifying`
3. insufficient evidence preserves debt
4. scheduling is skipped when no disagreement report requires verification
5. malformed completed verifier output becomes `verifier_failed` and cannot clear debt
6. one verifier Task can resolve one report while preserving unrelated unresolved report debt
7. verifier capability grants cannot expand durable leader tool authority
8. canceling active verifier work preserves debt and records a canonical canceled verdict
9. reconciling the same completed verifier Task is idempotent
10. completed-but-unreconciled verifier work settles after database reopen without duplicate verdicts
11. cross-TeamRun resolution evidence fails closed and cannot clear verification debt
12. exhausted Team Run Worker capacity blocks verifier scheduling before verifier records are created
13. verifier Worker execution policy inherits the durable leader execution policy by default
14. verifier execution override cannot change the durable leader environment policy

**Verified suite:** 118 passed, 0 failed, 0 canceled, 0 skipped in GitHub Actions run 180.

## Reusability boundary

Phase 2 remains package-owned and host-neutral:

```text
TeamRunManager / TeamRunFanout / TeamRunHandoff / TeamRunDiscussion / TeamRunDisagreementDetector / TeamRunVerifier / PrincipalRunner / ExecutionSupervisor
  -> CoordinationStore + ExecutionQueue
  -> RuntimeAdapter contract
  -> canonical TeamRun / Worker / Task / Handoff / Room / Thread / Message / Artifact protocol objects
  -> package policy / budget / lease / cancellation / recovery primitives
```

There is no import from AI-Verse OS, Brain, Memory, Skills, Dashboard, Automations, or any AI-Verse-specific filesystem/state format.

AI-Verse native integration remains Phase 3 and must arrive through adapters and explicit boundaries rather than becoming embedded inside squad orchestration.

## Next slice

### 2.9 - Synthesis

Required next work:

1. collect bounded candidate Artifacts from manager, fan-out, handoff, and discussion topologies without inventing a second result store
2. consume canonical `verification_verdict` Artifacts when verification debt existed and refuse final synthesis while unresolved required verification debt remains
3. preserve root-objective, workspace, Team Run, source Artifact, disagreement-report, verifier-verdict, constraint, and producing-principal provenance
4. let the durable Team Run leader produce one canonical synthesized result Artifact from explicit bounded inputs
5. keep candidate disagreement visible rather than silently averaging or erasing unresolved differences
6. define deterministic synthesis input ordering and bounded input ceilings
7. prevent synthesis from expanding leader/TeamRun tool, connection, execution, budget, or workspace authority
8. make synthesis idempotent and restart-safe so completed-but-unreconciled leader work does not duplicate final Artifacts
9. support cancellation/failure without corrupting successful candidate or verifier Artifacts
10. define Team Run transition from `synthesizing` to `completed` only after the canonical synthesis Artifact is durably persisted and no required verification debt remains
11. add acceptance coverage for verified synthesis, no-verifier-needed synthesis, unresolved-debt refusal, partial candidate failure, idempotency, cancellation, and database-reopen recovery

After synthesis, continue through Worker cleanup hardening, adaptive single-Bot-vs-squad policy, and final squad budget/cancellation consolidation.