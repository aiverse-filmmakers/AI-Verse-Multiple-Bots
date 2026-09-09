# Phase 2 Status - Dynamic Multi-Agent Squads

**Updated:** 2026-09-10

**Phase:** 2

**Overall status:** IN PROGRESS

**Directional phase progress:** approximately 93%

This file is the implementation ledger for Phase 2. The canonical product roadmap remains `BUILD-MAP.md`.

## Phase 2 goal

A durable Bot decides whether one execution is sufficient or whether a bounded temporary squad is justified, creates run-scoped Workers when needed, coordinates them through explicit Tasks and leases, verifies disagreements where required, produces one canonical final synthesis, and cleans temporary state without polluting the durable Bot roster.

The package remains host-neutral. Phase 2 coordination primitives may be embedded by AI-Verse OS, but do not depend on AI-Verse OS, Brain, Memory, Skills, Dashboard, Automations, or any specific host filesystem layout.

## Current verification

Phase 2.10 is complete on PR #26 after the audited PR-head package suite passed **147/147 tests** with 0 failures, 0 canceled, and 0 skipped.

The cleanup gate now covers terminal Worker expiry, transient authority and execution cleanup, stale discussion-setup reaping, restart recovery, unresolved-state blockers, and preservation of the canonical audit/provenance graph.

The next Phase 2 slice is 2.11 adaptive single-Bot-vs-squad decision policy.

## Slice status

1. Team Run object and lifecycle — **COMPLETE**
2. Temporary Worker identity and bounded lifecycle — **COMPLETE**
3. Worker execution + manager/supervisor topology — **COMPLETE**
4. Bounded parallel fan-out — **COMPLETE**
5. Direct handoff topology — **COMPLETE**
6. Bounded group/discussion topology — **COMPLETE**
7. Structured disagreement detection — **COMPLETE**
8. Bounded verifier/critic role — **COMPLETE**
9. Canonical synthesis — **COMPLETE**
10. Worker cleanup hardening — **COMPLETE**
11. Adaptive single-Bot-vs-squad decision policy — **NEXT**
12. Squad-wide budget/cancellation consolidation — remaining beyond the substantial controls already implemented

## Implemented foundation

### Team Run + temporary identity

- canonical `team_run` records with explicit lifecycle and root-objective lineage
- active durable Bot leader and workspace equality enforcement
- `worker_*` temporary identities separate from the durable Bot registry
- no default Worker Room membership or long-term memory authority
- leader-only Worker lifecycle control and `can_create_workers` enforcement
- Team Run `max_workers` and Worker budget-boundary enforcement
- Worker Task binding before ready/running execution states
- terminal Worker expiry with retained audit records
- restart-persistent Team Run and Worker state

### Worker execution + manager topology

- common execution-principal contract for durable Bots and temporary Workers
- Worker-aware event-driven execution through the common supervisor
- Worker runtime inheritance from the durable leader with run-scoped overrides
- capability/environment lease validation
- `worker_generated` Artifact provenance
- race-safe Worker + lease + Task preparation before execution wake-up
- leader authority cannot be expanded through Worker grants
- aggregate Team Run usage enforcement before Artifact acceptance
- cancellation and retry-safe stale execution recovery across restart

### Parallel fan-out

- host-neutral `TeamRunFanout` for `parallel_panel`, `dynamic_squad`, and `hybrid`
- central concurrency ceiling and scheduling-time Worker/Task limits
- reservation-safe Team Run token/cost/action allocation before parallel execution
- independent Worker Tasks, leases, contexts and Artifacts
- `all`, `first_success`, and bounded quorum joins
- partial failure preserves successful sibling Artifacts
- explicit/remainder cancellation
- durable activation/recovery and multi-Worker restart proof
- cross-process Team Run compare-and-swap hardening

### Direct handoff topology

- host-neutral `TeamRunHandoff` around the canonical Handoff object
- queued Worker -> Worker and Worker -> durable Bot ownership transfer
- no Worker promotion into the Bot registry
- source Worker terminalization after accepted transfer
- workspace/run/root-objective/constraint preservation
- capability and environment authority reissue
- pending Approval actor retargeting
- claimed/running execution fails closed
- mixed Bot/Worker hop and ownership-loop controls
- run-wide cancellation reaches durable-Bot-owned handed-off work
- default completion returns final ownership to the active durable Team Run leader without reviving terminated Workers
- explicit `stay_with_target` retains the accepted target
- accepted Worker handoff survives database reopen

### Bounded group/discussion topology

- host-neutral `TeamRunDiscussion` reuses canonical Room/Thread/Message/Task/Artifact/Worker primitives
- topology-gated to `group_room`, `dynamic_squad`, and `hybrid`
- durable leader remains the only durable Room member; Workers are temporary participants
- explicit speaker/round turn plan prevents uncontrolled all-to-all chatter
- one Worker identity per discussion role is reused across rounds
- successful turn lifecycle is `running -> waiting`; terminal only when discussion closes
- Team Run `max_workers`, `max_messages`, `max_rounds`, and `max_tasks` bound the discussion
- speaker capability grants become turn-scoped leases without expanding leader authority
- prior candidate Artifacts and bounded transcript context feed later turns
- candidate Artifacts remain same-workspace/same-TeamRun with actual Worker provenance
- Worker Room publication is restricted to the exact temporary discussion and the Worker's own scoped candidate Artifact
- deterministic kickoff/thread/turn records make restart reconciliation idempotent
- completed-but-unreconciled turns resume without duplicated completed work
- discussion-created setup Workers carry explicit lifecycle tags for precise stale-reservation cleanup; unrelated Workers are never inferred into that setup

### Structured disagreement detection

- deterministic `TeamRunDisagreementDetector` compares explicit structured claims rather than hidden reasoning
- accepted claim kinds: fact, constraint, recommendation, estimate, and opinion
- detects fact/value conflicts, constraint contradictions, opposed stances, explicit recommendation incompatibility, estimate gaps beyond tolerance, and material confidence gaps
- compatible alternatives remain compatible unless exclusivity is declared
- unstructured/non-comparable evidence returns `insufficient_evidence`
- every finding retains source Artifact and claim references
- deterministic immutable `disagreement_report` Artifacts with provenance and idempotent analysis
- same-workspace/same-TeamRun and bounded input enforcement
- hard conflicts create persistent verification debt through `verification_required_report_refs`
- later compatible subset analysis cannot silently clear earlier unresolved debt

### Verifier / critic role

- host-neutral `TeamRunVerifier` consumes explicit unresolved disagreement-report debt
- no-debt runs skip verifier creation by default
- one bounded temporary Verifier Worker can evaluate multiple pending reports in one Task
- verifier inherits root objective, constraints, environment policy and authority limits
- runtime output is untrusted until it satisfies `verifier-verdict-v1`
- every hard finding receives a structured resolved/unresolved/insufficient-evidence status
- resolved findings must cite scoped Artifact evidence
- cross-run evidence fails closed and cannot clear debt
- canonical immutable `verification_verdict` Artifacts preserve disagreement, candidate, evidence and runtime provenance
- only validated resolved report IDs are removed from verification debt
- all-debt-resolved success moves the Team Run toward synthesis; unresolved/failure/cancel preserves debt
- cancellation and completed-but-unreconciled verifier work are restart-safe and idempotent

## Slice 2.9 - Canonical synthesis

**COMPLETE**

Phase 2.9 makes the durable Team Run leader the final synthesizer rather than allocating another temporary Worker. Runtime synthesis output remains untrusted until the package validates it and creates one canonical final Artifact.

Implemented:

### Scheduling and authority

- host-neutral `TeamRunSynthesis`
- durable Team Run leader owns synthesis; no extra temporary Worker slot is consumed
- synthesis cannot schedule while unresolved verification debt, a live verifier Task, live Team Run Tasks, or active temporary Workers remain
- explicit/default source Artifact selection is bounded and same-workspace/same-TeamRun
- source-count validation happens before lifecycle mutation
- synthesis requires one remaining Team Run Task slot
- synthesis Task is a real run-scoped durable-leader Task with capability lease, inherited constraints, Team Run budget, cancellation, queue and recovery semantics
- synthesis tool/connection grants cannot expand durable leader authority

### Canonical evidence boundary

- manager/fan-out/handoff/discussion outputs, candidate Artifacts, disagreement reports and resolved canonical verification verdicts may enter the source set
- raw verifier runtime output cannot bypass the canonical `verification_verdict`
- raw prior synthesis runtime drafts cannot become synthesis inputs
- foreign/cross-run source references fail closed before the Team Run enters synthesis
- poisoned final Artifact pointers fail closed instead of silently re-synthesizing

### Runtime output validation and final Artifact

- runtime output must satisfy `synthesis-final-v1`
- output citations must stay inside the explicitly selected source set
- confidence and unresolved-item fields are validated before canonical settlement
- canonical immutable `synthesis_final` Artifact preserves root objective, source Artifact refs, disagreement-report refs, verifier-verdict refs, raw synthesis draft and durable leader provenance
- final Artifact ID/digest is deterministic from canonical settlement material
- repeated reconciliation returns the existing canonical final rather than creating duplicates

### Concurrency, terminal state and recovery

- finalization rechecks verification debt and live work immediately before persistence
- late Worker creation blocks canonical finalization instead of being stranded behind a completed Team Run
- `final_artifact_ref` and Team Run `completed` status are committed atomically under Team Run compare-and-swap
- malformed or canceled synthesis creates no canonical final and leaves a nonterminal run retryable in `synthesizing`
- aggregate Team Run budget exhaustion remains terminal and cannot be overwritten by synthesis settlement
- completed-but-unreconciled synthesis survives database reopen and is reconciled by `ExecutionSupervisor`

## Phase 2.9 acceptance proof

The sixteen synthesis acceptance/hardening tests prove:

1. the durable leader creates one canonical final synthesis and completes the Team Run without another Worker
2. unresolved verification debt blocks synthesis before executable work is created
3. active temporary participation blocks final synthesis
4. cross-TeamRun source references fail before lifecycle mutation
5. canonical verifier verdicts are accepted while raw verifier runtime output is rejected
6. malformed synthesis runtime output creates no canonical final and leaves the run retryable
7. synthesis output cannot cite Artifacts outside its selected source set
8. Team Run `max_tasks` is enforced before a synthesis Task is created
9. active synthesis cancellation creates no final Artifact and leaves nonterminal state retryable
10. repeated settlement is idempotent and later scheduling returns the same final Artifact
11. completed-but-unreconciled synthesis survives database reopen and creates exactly one canonical final
12. aggregate Team Run budget exhaustion stays terminal and is never resurrected by synthesis settlement
13. default source collection includes completed Team Run Task output
14. source-count limits fail before synthesis lifecycle mutation
15. a poisoned final Artifact pointer fails closed instead of silently re-synthesizing
16. late Worker creation blocks canonical finalization until that work is closed, after which the same completed synthesis Task settles once

## Slice 2.10 - Worker cleanup hardening

**COMPLETE**

Phase 2.10 adds a host-neutral maintenance/recovery cleanup lifecycle without deleting canonical evidence. Execution settlement remains observable first; terminal cleanup happens later through explicit cleanup or supervisor maintenance/recovery.

Implemented:

### Terminal cleanup boundary

- public `TeamRunCleanup` coordinator
- cleanup only accepts terminal Team Runs and fails closed on inconsistent live Tasks or live Workers
- unresolved `requested`/`accepted` Handoffs block cleanup rather than being silently rewritten
- terminal temporary Workers are expired without deleting their Worker records
- durable Bots are never changed or promoted/demoted by cleanup
- cleanup is maintenance/recovery work, not an immediate side effect of Task settlement

### Transient authority and execution cleanup

- run Task capability leases are expired/revoked with cleanup audit metadata
- run-exclusive environment leases are revoked; environment leases still referenced by another Team Run are preserved
- residual queued/claimed/running/dead-letter execution records are canceled
- stale pending Approvals attached to already-terminal run Tasks are canceled while their audit objects remain
- actionable mailbox deliveries targeting run Workers are canceled while Message records remain
- queue/mailbox side effects are accumulated across optimistic retries so the persisted cleanup summary does not lose already-applied cleanup evidence

### Temporary coordination surfaces and evidence preservation

- temporary Team Run Rooms and their Threads are closed
- Room/Thread/Message/Task/Handoff/Approval/Worker/event records remain available for audit
- canonical Artifacts and provenance edges are retained, including final synthesis, disagreement and verifier evidence
- cleanup persists a structured summary and emits idempotent audit events

### Stale discussion setup reaping

- discussion setup reserves a Team Run opening before Worker creation
- only Workers explicitly tagged by `TeamRunDiscussion` with that opening ID are eligible for deterministic stale setup reaping
- unrelated Workers created during the same reservation are not tagged or reaped
- task-bound/active or ambiguous legacy setup state blocks fail closed
- stale reservation cleanup releases Worker capacity without deleting evidence
- fresh reservations are left untouched

### Restart and idempotency

- `ExecutionSupervisor` reaps stale discussion openings and recovers terminal Team Run cleanup on startup/recovery sweeps
- repeated cleanup returns an already-clean result and reuses idempotent audit keys
- file-backed restart tests prove terminal cleanup and stale setup reaping resume safely

## Phase 2.10 acceptance proof

The cleanup acceptance/hardening tests prove:

1. terminal Worker identity, capability authority and residual execution are cleaned while Artifacts and the durable leader remain intact
2. run-exclusive environment leases are revoked while shared environment leases remain usable by other Team Runs
3. temporary Rooms/Threads close while Messages and Artifacts remain auditable
4. cleanup is idempotent and emits one canonical completion event
5. nonterminal Team Runs cannot be cleaned
6. inconsistent terminal state with live Workers blocks visibly
7. stale explicitly tagged discussion setup is reaped, unrelated Workers survive, and Worker capacity is released
8. fresh setup reservations are not reaped
9. task-bound stale setup participants block reaping instead of losing live work
10. supervisor restart recovers terminal cleanup and stale setup state
11. unresolved Handoffs block cleanup
12. stale pending Approvals become non-actionable without deleting their audit record
13. Worker-target mailbox deliveries are canceled while their Messages are preserved

**Verified package suite:** 147 passed, 0 failed, 0 canceled, 0 skipped on the final audited PR-head gate.

## Reusability boundary

Phase 2 remains package-owned and host-neutral:

```text
TeamRunManager / TeamRunFanout / TeamRunHandoff / TeamRunDiscussion
TeamRunDisagreementDetector / TeamRunVerifier / TeamRunSynthesis / TeamRunCleanup
PrincipalRunner / ExecutionSupervisor
  -> CoordinationStore + ExecutionQueue
  -> RuntimeAdapter contract
  -> canonical TeamRun / Worker / Task / Handoff / Room / Thread / Message / Artifact protocol objects
  -> package policy / budget / lease / cancellation / recovery primitives
```

There is no dependency on AI-Verse OS, Brain, Memory, Skills, Dashboard, Automations, or any AI-Verse-specific filesystem/state format.

AI-Verse native integration remains Phase 3 and must arrive through adapters and explicit boundaries rather than becoming embedded inside squad orchestration.

## Next slice

### 2.11 - Adaptive single-Bot-vs-squad decision policy

Required next work:

1. define an explicit, inspectable decision contract for when a durable Bot should stay single vs open a Team Run
2. base the decision on work shape, uncertainty, independence, verification need, cost/latency budget, and available authority rather than vague model preference
3. choose only among already-supported bounded topologies and fail closed to a simpler path when requirements are not met
4. preserve root objective, workspace, immutable constraints, budget and approval boundaries through the decision
5. prevent repeated squad creation or decision loops for the same objective
6. record why collaboration was or was not justified without storing hidden chain-of-thought
7. make the policy deterministic/idempotent where inputs are equivalent and restart-safe where state is persisted
8. add acceptance coverage proving simple work remains single and genuinely parallel/verification-heavy work selects the minimum justified squad shape

After 2.11, finish Phase 2 with squad-wide budget/cancellation consolidation.
