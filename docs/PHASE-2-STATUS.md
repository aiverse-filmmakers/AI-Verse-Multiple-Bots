# Phase 2 Status - Dynamic Multi-Agent Squads

**Updated:** 2026-09-10

**Phase:** 2

**Overall status:** COMPLETE

**Directional phase progress:** 100%

This file is the implementation ledger for Phase 2. The canonical product roadmap remains `BUILD-MAP.md`.

## Phase 2 goal

A durable Bot decides whether one execution is sufficient or whether a bounded temporary squad is justified, creates run-scoped Workers when needed, coordinates them through explicit Tasks and leases, verifies disagreements where required, produces one canonical final synthesis, and cleans temporary state without polluting the durable Bot roster.

The package remains host-neutral. Phase 2 coordination primitives may be embedded by AI-Verse OS, but do not depend on AI-Verse OS, Brain, Memory, Skills, Dashboard, Automations, or any specific host filesystem layout.

## Completion verification

Phase 2 is complete on PR #28 after the hardened PR-head package suite passed **174/174 tests** with **0 failures, 0 canceled, and 0 skipped** on GitHub Actions run 243.

The final gate proves that every supported squad topology now shares one run-wide budget and termination contract. A Team Run cannot evade limits by switching between Workers and durable Bots, by entering fan-out/discussion/verifier/synthesis stages, or by surviving a process restart. Cancellation and budget exhaustion fence the run before cleanup, stop executable work, revoke run-exclusive authority, preserve shared external authority only when another run still references it, and retain canonical Artifacts/audit evidence.

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
11. Adaptive single-Bot-vs-squad decision policy — **COMPLETE**
12. Squad-wide budget/cancellation consolidation — **COMPLETE**

## Implemented Phase 2 foundation

### Team Run + temporary identity

- canonical `team_run` records with explicit lifecycle and root-objective lineage
- active durable Bot leader and same-workspace enforcement
- `worker_*` temporary identities remain separate from the durable Bot registry
- no default Worker Room membership or long-term memory authority
- leader-only Worker lifecycle control and `can_create_workers` enforcement
- Worker Task binding before execution
- bounded Worker identity creation with retained terminal audit records
- restart-persistent Team Run and Worker state

### Execution + manager topology

- common execution-principal contract for durable Bots and temporary Workers
- event-driven Worker execution through the common supervisor
- Worker runtime inheritance from the durable leader with bounded run-scoped overrides
- capability/environment lease validation
- actual producing-principal Artifact provenance
- race-safe Worker + lease + Task preparation
- no Worker grant can expand durable leader authority
- aggregate Team Run usage enforcement before successful Artifact acceptance
- cancellation, deadlines and retry-safe stale execution recovery

### Parallel fan-out

- host-neutral `TeamRunFanout` for `parallel_panel`, `dynamic_squad`, and `hybrid`
- central concurrency ceiling and scheduling-time Worker/Task limits
- reservation-safe token/cost/action allocation before parallel execution
- independent Worker Tasks, leases, contexts and Artifacts
- `all`, `first_success`, and bounded quorum joins
- partial failure preserves successful sibling Artifacts
- explicit/remainder cancellation
- durable activation/recovery and multi-Worker restart proof
- compare-and-swap hardening for cross-process Team Run state

### Direct handoff

- host-neutral `TeamRunHandoff` built around the canonical Handoff object
- queued Worker -> Worker and Worker -> durable Bot ownership transfer
- no Worker promotion into the durable Bot registry
- source Worker terminalization after accepted transfer
- workspace/run/root-objective/immutable-constraint preservation
- capability/environment authority reissue
- pending Approval actor retargeting
- claimed/running execution fails closed
- mixed-principal hop and ownership-loop controls
- accepted handoffs survive database reopen
- completion can return final ownership to the active durable Team Run leader or explicitly stay with the accepted target

### Bounded discussion

- host-neutral `TeamRunDiscussion` reuses canonical Room/Thread/Message/Task/Artifact/Worker primitives
- topology-gated to `group_room`, `dynamic_squad`, and `hybrid`
- durable leader is the only durable Room member; Workers are temporary participants
- explicit speaker/round turn plans prevent uncontrolled all-to-all chatter
- one Worker identity per discussion role is reused across rounds without terminal resurrection
- `max_workers`, `max_messages`, `max_rounds`, and `max_tasks` bound discussion before execution
- speaker grants become turn-scoped leases without expanding leader authority
- prior candidate Artifacts feed later turns with scoped provenance
- Worker Room publication is restricted to the exact temporary discussion and the Worker's own candidate Artifact
- deterministic setup/thread/message records make reconciliation replay-safe
- completed-but-unreconciled turns resume without duplicate completed work

### Structured disagreement detection

- deterministic `TeamRunDisagreementDetector` compares explicit structured claims rather than hidden reasoning
- accepted claim kinds: fact, constraint, recommendation, estimate, opinion
- material contradiction, incompatibility, tolerance and confidence-gap detection
- compatible alternatives remain compatible unless exclusivity is declared
- unstructured/non-comparable evidence returns `insufficient_evidence`
- every finding retains source Artifact and claim references
- deterministic immutable `disagreement_report` Artifacts
- same-workspace/same-TeamRun and bounded input enforcement
- hard conflicts create persistent verification debt that later compatible subsets cannot silently clear

### Verifier / critic

- host-neutral `TeamRunVerifier` consumes explicit unresolved disagreement-report debt
- no-debt runs skip verifier creation by default
- bounded temporary verifier can evaluate selected pending reports
- verifier inherits root objective, constraints, environment policy and authority boundaries
- runtime output is untrusted until it satisfies `verifier-verdict-v1`
- cross-run evidence fails closed
- canonical immutable `verification_verdict` Artifacts retain candidate, disagreement, evidence and runtime provenance
- only validated resolved report IDs clear verification debt
- cancellation/failure preserves unresolved debt
- completed-but-unreconciled verifier work is restart-safe and idempotent

### Canonical synthesis

- host-neutral `TeamRunSynthesis`
- durable Team Run leader performs final synthesis rather than allocating another temporary Worker
- unresolved verification debt or live temporary work blocks finalization
- bounded same-run source selection includes canonical candidate/disagreement/verifier evidence
- raw verifier runtime output cannot bypass canonical verdicts
- runtime synthesis output is untrusted until it satisfies `synthesis-final-v1`
- canonical immutable `synthesis_final` Artifact preserves source/evidence lineage and durable leader provenance
- deterministic final identity makes repeated reconciliation idempotent
- `final_artifact_ref` and Team Run completion settle atomically
- aggregate budget exhaustion remains terminal and cannot be overwritten by synthesis settlement
- completed-but-unreconciled synthesis survives database reopen

### Worker cleanup hardening

- host-neutral `TeamRunCleanup` performs post-run temporary-state cleanup without deleting evidence
- cleanup refuses inconsistent nonterminal/live state
- terminal temporary Workers expire while durable Bots remain unchanged
- run-scoped capability leases and run-exclusive environment leases are revoked
- environment leases still referenced outside the run are preserved
- residual execution records and stale pending approvals become non-actionable
- temporary Team Run Rooms/Threads close while Messages, Tasks, Handoffs, Approvals, Workers, events and Artifacts remain auditable
- stale discussion-opening reservations are reaped only through explicit lifecycle tags
- cleanup summaries and recovery are idempotent across restart

### Adaptive single-Bot-vs-squad policy

- host-neutral `TeamRunDecisionPolicy`
- simple linear work stays with one durable Bot
- structured signals select only already-supported bounded topologies
- Worker, Task, concurrency, message, round, verifier and handoff-hop capacity are checked before squad creation
- required verification reserves separate lifetime Worker capacity
- tool/connection authority cannot exceed durable leader permissions
- root objective, workspace, immutable constraints, approval requirement and effective budget carry into the selected run
- deterministic decision Artifact and Team Run IDs make equivalent requests idempotent
- compatible existing runs are reused; duplicate runs for one root objective fail closed
- decision Artifact and audit event settle atomically

## Slice 2.12 - Squad-wide budget/cancellation consolidation

**COMPLETE**

Phase 2.12 adds one canonical host-neutral Team Run control plane above topology-specific scheduling.

Implemented:

- public `TeamRunControl` used by the guarded runner and supervisor
- aggregate run budget snapshots across completed runtime usage, Tasks, Workers, discussion messages/rounds and observed handoff depth
- token, cost, action, Task, Worker, hop, message and round ceiling checks
- one absolute Team Run wall-clock deadline derived from run creation, propagated as a tighter Task execution deadline
- queued work is guarded before runtime claim/execution
- already-running work is aborted when the absolute run deadline elapses
- Team Run leader has explicit hierarchical cancellation authority over any same-run Task, including participant-owned durable-Bot/Worker work
- terminal cancellation/budget-exhaustion fence is persisted before draining executable work
- pending Approvals and active Handoffs become non-actionable
- capability leases are revoked and expired
- run-exclusive environment leases are revoked; leases genuinely shared outside the run are preserved
- temporary Room/Thread surfaces are closed
- active fan-out/verifier/synthesis pointers and discussion-opening reservations are cleared
- termination summary is durable, union-preserving and idempotent across retries
- terminal runs cannot be retried from dead letter or resurrected by later topology reconciliation
- supervisor startup performs termination recovery before topology recovery or queue draining
- restart recovery closes residual temporary surfaces, including orphan open Threads
- canonical Artifacts/provenance remain untouched

## Phase 2.12 acceptance proof

The final control-plane tests prove:

1. canonical Team Run cancellation fences and drains mixed-principal work while preserving a stable audit summary
2. run-exclusive environment authority is revoked while an environment genuinely shared outside the run is preserved
3. the durable Team Run leader can abort an already-running participant-owned Task hierarchically
4. an expired absolute Team Run wall-clock budget stops queued work before runtime execution
5. the absolute Team Run deadline aborts already-running work and settles the run as `budget_exhausted`
6. aggregate runtime budget exhaustion uses the same canonical terminal cascade
7. terminal Team Run residue survives database reopen, is recovered before execution, closes an orphan Thread, and preserves prior cancellation evidence through later cleanup

**Final verified Phase 2 package suite:** **174 passed, 0 failed, 0 canceled, 0 skipped** on GitHub Actions run 243 before the documentation-only closure commit.

## Reusability boundary

Phase 2 remains package-owned and host-neutral:

```text
TeamRunManager / TeamRunFanout / TeamRunHandoff / TeamRunDiscussion
TeamRunDisagreementDetector / TeamRunVerifier / TeamRunSynthesis / TeamRunCleanup
TeamRunDecisionPolicy / TeamRunControl
PrincipalRunner / ExecutionSupervisor
  -> CoordinationStore + ExecutionQueue
  -> RuntimeAdapter contract
  -> canonical TeamRun / Worker / Task / Handoff / Room / Thread / Message / Artifact protocol objects
  -> package policy / budget / lease / cancellation / recovery primitives
```

There is no dependency on AI-Verse OS, Brain, Memory, Skills, Dashboard, Automations, or any AI-Verse-specific filesystem/state format.

## Phase 2 completion gate

**PASSED.**

A durable Bot can stay single or select the minimum justified bounded squad, coordinate real temporary Workers through manager/fan-out/handoff/discussion paths, detect and verify material disagreements, synthesize one canonical final result, enforce shared run-wide budgets/cancellation, recover from interruption, and clean temporary authority/state without polluting durable identity or deleting audit evidence.

## Next phase

**Phase 3 - AI-Verse Native Integration.**

Phase 3 must integrate this now-complete host-neutral squad layer through explicit adapters and boundaries. It must not move AI-Verse OS, Brain, Memory, Skills, Dashboard, Automations, or host-specific canonical state into the multi-bot package.