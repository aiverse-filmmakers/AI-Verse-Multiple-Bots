# AI-Verse Multiple Bots - Build Map

**Updated:** 2026-09-10

This is the canonical progress map for the project. Update it whenever a meaningful implementation slice lands so repository state alone shows where the build is, what is complete, and what remains.

## Definition of finished

The first complete product release is reached when Phases 0 through 5 below are complete and the release acceptance suite passes.

The target is an installable persistent-teammate layer that can run standalone or attach to AI-Verse OS, host durable Bots, let them communicate and collaborate safely, create temporary multi-agent squads when useful, interoperate with external runtimes, and expose the system to Dashboard/omnichannel clients without becoming a second source of domain truth.

## Current position

```text
Phase 0  Research + Architecture        [COMPLETE]    100%
Phase 1  Runnable Coordination Core     [COMPLETE]    100%
Phase 2  Dynamic Multi-Agent Squads     [IN PROGRESS] ~97%
Phase 3  AI-Verse Native Integration    [NOT STARTED]
Phase 4  Runtime / A2A Interoperability [NOT STARTED]
Phase 5  Product + Install + Dashboard  [NOT STARTED]
```

**Directional overall first-release progress:** roughly 63% complete.

That overall figure is intentionally approximate because later phases contain different amounts of work. Passed phase gates, not percentages, are authoritative.

## Phase 0 - Research + Architecture

**Status:** COMPLETE

Completed:

- Grok Bot and Grok Multi-Agent architecture research
- Hermes Bot Mode study
- Microsoft Agent Framework orchestration patterns
- A2A / OpenAI Agents / OpenClaw / AgentScope / Pydantic AI and related benchmark research
- canonical persistent-teammate architecture
- Coordination Protocol v1.1
- AI-Verse layer boundaries
- schemas and Bot/Room templates
- implementation roadmap

## Phase 1 - Runnable Coordination Core

**Status:** COMPLETE

**Completion evidence:** GitHub Actions run 102 on 2026-09-09 passed **54/54 tests** at commit `73706c40ddc6249a755655b889aff68240d016aa`.

### 1.1 Repository/runtime skeleton - COMPLETE

- Node.js + TypeScript core
- CLI and localhost Gateway
- build/test scripts and GitHub Actions CI

### 1.2 Persistent coordination store - COMPLETE

- SQLite protocol/object store
- Bots, Messages, Tasks, Handoffs, Artifacts, Approvals and leases
- async mailboxes and persistent execution queue
- idempotency and restart persistence
- atomic multi-object/event/queue mutation primitive

### 1.3 Event substrate - COMPLETE

- append-only globally ordered events
- per-Room ordering
- correlation/causation/trace fields
- global and Room/Thread replay
- SSE and HTTP replay surfaces

### 1.4 Bot registry - PHASE-1 HARDENING COMPLETE

- immutable durable Bot identity and lifecycle
- workspace/operator registry namespaces
- collision-safe addresses/aliases
- manager/peer validation and cycle protection
- active-work and Room dependency lifecycle guards
- disabled/archived availability enforcement

### 1.5 Runtime adapter contract - PHASE-1 COMPLETE

- runtime-neutral adapter/registry
- deterministic reference adapter
- zero-dependency OpenAI-compatible HTTP adapter
- environment-handle credentials; raw manifest secrets rejected
- structured usage/receipts, cancellation, deadlines and abort signals
- real two-Bot HTTP model collaboration proven in CI

### 1.6 Persistent Task execution and recovery - PHASE-1 HARDENING COMPLETE

- event-driven execution
- Task -> runtime -> Artifact -> completion
- capability/environment authority checks
- cancellation, recursive cancellation and deadlines
- budget enforcement before Artifact acceptance
- atomic file-backed finalization
- execution leases/heartbeats and stale recovery
- `manual` and `retry_safe` recovery policies
- dead-letter inspection/retry with operator authority
- late runners cannot overwrite recovered work

### 1.7 Delegation - PHASE-1 COMPLETE

- explicit ownership and root objective
- scoped capability lease
- parent lineage, inherited immutable constraints and hop ceilings
- response targets, deadlines and inherited budgets
- root Task-count limit
- recovery policy/max attempts
- validated same-workspace Artifact inputs

### 1.8 Handoffs - PHASE-1 HARDENING COMPLETE

- canonical Protocol v1.1 Handoff fields
- source/root/workspace/status validation
- one active Handoff per Task
- target-only acceptance and explicit rejection
- atomic ownership + lease + Approval + queue + event mutation
- claimed/running fail-closed behavior
- capability/shared-environment authority reissue
- immutable constraint preservation
- return/stay policies and automatic settlement

### 1.9 Rooms + Threads - PHASE-1 COMPLETE

- Room membership and leaders
- registry-backed aliases/mentions
- Threads and bounded selective scheduling
- Room work backed by real Tasks
- result/Artifact publication back to Room/Thread
- replay and aggregate message/round budgets

Advanced squad/topology behavior belongs in Phase 2.

### 1.10 Safety substrate - PHASE-1 COMPLETE

Implemented and enforced:

- workspace isolation
- registered/active Bot checks
- peer/tool/connection authority
- inherited constraints and root-objective preservation
- hop, Task, token, cost, action, message and round ceilings
- cancellation/deadline enforcement
- delegation-loop/ping-pong/no-progress detection
- first-class Approval objects and operator-only decisions
- conservative crash recovery
- identity/lifecycle rules that prevent silent retargeting
- raw runtime secret rejection

### Phase 1 completion gate

**PASSED.**

Two persistent Bots independently exist, communicate asynchronously, delegate actual work, transfer responsibility safely, collaborate in a Room/Thread, execute through a real runtime adapter, respect policy/limits/approvals, recover from Gateway restart, and cancel/fail without losing coordination integrity.

**Verified suite:** 54 tests passed, 0 failed, 0 canceled, 0 skipped.

### Phase 1 remaining work

None.

## Phase 2 - Dynamic Multi-Agent Squads

**Status:** IN PROGRESS

**Current phase progress:** approximately 97%.

**Current verification:** GitHub Actions run 227 passed **167/167 tests** at hardened PR-head commit `81daff9b4f1088896eae6117e5bed72d1eb511e2`.

Goal: a durable Bot decides whether to work alone or create bounded temporary Workers, coordinates them through the topology justified by the work, and returns a bounded, auditable result without turning temporary helpers into durable identities.

Major slices:

1. Team Run object and lifecycle - **COMPLETE**
2. temporary Worker identities and bounded lifecycle - **COMPLETE**
3. Worker execution + manager/supervisor topology - **COMPLETE**
4. bounded parallel fan-out - **COMPLETE**
5. direct handoff topology - **COMPLETE**
6. bounded group/discussion topology where justified - **COMPLETE**
7. disagreement detection - **COMPLETE**
8. verifier/critic role - **COMPLETE**
9. synthesis - **COMPLETE**
10. Worker cleanup hardening - **COMPLETE**
11. adaptive `single Bot vs squad` decision policy - **COMPLETE**
12. squad-wide budget/cancellation consolidation - **NEXT**

### Phase 2 capabilities now implemented

#### Team Run + temporary identity

- canonical Team Run records and explicit lifecycle
- active durable Bot leader and same-workspace enforcement
- run-scoped `worker_*` identities that never enter the durable Bot registry
- no default Worker Room membership or long-term memory authority
- leader-only Worker lifecycle control and `can_create_workers` enforcement
- Team Run `max_workers` and Worker budget-boundary enforcement
- Worker Task binding before ready/running execution states
- terminal Worker expiry cleanup with retained audit records
- restart-persistent Team Run and Worker state

#### Worker execution + manager topology

- common execution-principal runtime contract for Bots and Workers
- Worker-aware event-driven supervisor
- Worker runtime inheritance from durable leader with run-scoped overrides
- capability/environment lease validation
- `worker_generated` Artifact provenance
- race-safe Worker + lease + Task preparation before execution wake-up
- leader authority cannot be expanded through managed Worker grants
- aggregate Team Run usage enforcement before Artifact acceptance
- live Team Run cancellation aborts Worker execution
- retry-safe Worker execution recovery across restart

#### Parallel fan-out

- bounded fan-out under `parallel_panel`, `dynamic_squad`, and `hybrid`
- central concurrency ceiling and scheduling-time Worker/Task limits
- reservation-safe Team Run token/cost/action allocation before parallel execution
- independent Worker Tasks, leases, contexts and Artifacts
- `all`, `first_success`, and bounded quorum joins
- partial failure preserves successful sibling Artifacts
- explicit/remainder cancellation
- two-stage durable fan-out activation/recovery
- multi-Worker restart proof
- leader Artifact collection for later synthesis
- cross-process Team Run compare-and-swap hardening

#### Direct handoff topology

- host-neutral `TeamRunHandoff` built around the canonical Handoff object instead of a duplicate transfer protocol
- queued Worker -> Worker and Worker -> durable Bot ownership transfer
- target Worker binding without Bot promotion
- source Worker lifecycle termination after accepted transfer
- durable Bot Team Run participant tracking without registry mutation
- workspace/run/root-objective and immutable-constraint preservation
- capability and shared-environment authority reissue
- pending Approval actor retargeting
- claimed/running execution fails closed
- mixed Bot/Worker hop and ownership-loop bounds
- run-wide cancellation reaches durable-Bot-owned handed-off work
- accepted Handoffs settle on completion/failure/cancellation regardless of Bot or Worker target
- public `PrincipalRunner` enforces active Team Run scope for run-scoped durable Bot execution
- durable Bot Team Run output counts toward the same aggregate run budget as Worker output
- aggregate run usage persistence protected by compare-and-swap
- default completion returns final Task ownership to the active durable Team Run leader without reviving a terminated Worker
- explicit `stay_with_target` retains the accepted target as final owner
- file-backed Worker handoff survives database reopen and executes under the accepted target
- Artifact provenance continues to identify the actual producing principal

#### Bounded group/discussion topology

- host-neutral `TeamRunDiscussion` reuses canonical Room/Thread/Message/Task/Artifact/Worker primitives
- discussion is topology-gated to `group_room`, `dynamic_squad`, and `hybrid`
- durable leader remains the only durable Room member; Workers stay temporary participants
- explicit speaker/round turn plan prevents free-form all-to-all chatter
- one Worker identity per discussion role is reused across rounds
- successful turn lifecycle is `running -> waiting`; Workers become terminal only when the discussion closes
- Team Run `max_workers`, `max_messages`, `max_rounds`, and `max_tasks` bound the discussion before execution
- speaker tool/connection grants persist and become turn-scoped capability leases without expanding leader authority
- prior candidate Artifacts and bounded transcript context feed later turns
- candidate Artifacts remain same-workspace and same-TeamRun and retain actual Worker provenance
- temporary Worker Room publication is restricted to the exact discussion and to the Worker's own scoped candidate Artifact
- setup is protected by a Team Run CAS reservation before Worker creation; competing setup fails closed
- deterministic kickoff, Thread, turn Message and idempotent events make restart reconciliation replay-safe
- completed-but-unreconciled turns resume from the next explicit speaker without duplicating completed work
- discussion-created setup Workers are explicitly tagged to their opening reservation; stale setup reaping never infers unrelated Workers into the discussion
- explicit cancellation closes the current discussion and temporary participant set

#### Structured disagreement detection

- host-neutral `TeamRunDisagreementDetector` compares declared structured claims rather than hidden model reasoning
- accepted claim kinds: fact, constraint, recommendation, estimate, and opinion
- detects fact/value conflicts, constraint contradictions, opposed stances, explicitly incompatible recommendations, estimate gaps beyond declared tolerance, and material confidence gaps
- compatible alternatives remain compatible unless exclusivity is explicitly declared
- non-comparable or unstructured inputs return `insufficient_evidence` instead of hallucinating conflict
- every finding retains source Artifact and claim references
- disagreement reports are immutable deterministic `disagreement_report` Artifacts with source provenance
- deterministic report IDs/digests and idempotent analysis events make repeated identical analysis replay-safe
- source Artifacts must remain in the same workspace and Team Run
- Artifact/claim ceilings keep comparison bounded
- Team Run disagreement state is persisted with `updatedAt` compare-and-swap retry
- hard conflict creates persistent verification debt through `verification_required_report_refs`
- later compatible subset analysis cannot clear unresolved Team Run verification debt
- report lookup/listing ignores cross-run or cross-workspace poisoned references
- report history and latest report survive database reopen

#### Verifier / critic role

- host-neutral `TeamRunVerifier` consumes explicit unresolved `disagreement_report` debt rather than rediscovering conflict
- compatible/no-debt runs skip verifier Worker creation by default
- one bounded temporary Verifier/Critic Worker can evaluate multiple selected pending reports in one Task
- verifier Task input includes the disagreement reports and their scoped candidate Artifacts
- verifier inherits candidate Task constraints and stays inside the original root objective
- runtime verifier output is untrusted until it passes the `verifier-verdict-v1` contract and lineage checks
- every hard disagreement finding must receive exactly one structured status: resolved, unresolved, or insufficient evidence
- resolved findings must cite same-workspace/same-TeamRun Artifact evidence
- foreign/cross-run evidence fails closed and produces canonical `verifier_failed` settlement without clearing debt
- canonical immutable `verification_verdict` Artifacts preserve disagreement report, candidate evidence, raw verifier output, and actual verifier provenance
- only report IDs validated as resolved are removed from `verification_required_report_refs`; unrelated debt is retained
- `requires_verification` clears only when no unresolved debt refs remain
- all-debt-resolved success moves the Team Run to `synthesizing`; unresolved/insufficient/failure/cancel stays `verifying`
- malformed runtime output becomes visible `verifier_failed` state rather than mutating debt
- cancellation preserves unresolved debt and records a canonical canceled verdict
- verifier Task settlement is idempotent and completed-but-unreconciled verification survives database reopen
- startup and stale-recovery reconciliation are integrated with `ExecutionSupervisor`
- verifier tool/connection grants cannot expand durable leader authority
- verifier execution inherits the leader environment policy and cannot change it through an override
- verifier Worker creation obeys the existing Team Run `max_workers` ceiling; verification capacity must therefore be budgeted rather than silently exempted

#### Canonical synthesis

- host-neutral `TeamRunSynthesis` makes the durable Team Run leader the final synthesizer instead of consuming another temporary Worker slot
- synthesis cannot schedule while required verification debt, a live verifier Task, live Team Run Tasks, or active temporary Workers remain
- manager/fan-out/handoff/discussion Task outputs, candidate Artifacts, disagreement reports, and resolved canonical verification verdicts can be collected into one bounded source set
- explicit and default source selection is same-workspace/same-TeamRun and fail-closed; poisoned or foreign references cannot be silently skipped
- raw verifier runtime output cannot bypass the canonical `verification_verdict`, and raw prior synthesis drafts cannot become synthesis sources
- source count is bounded before lifecycle mutation; synthesis also requires one remaining Team Run Task slot
- the synthesis Task is a real run-scoped durable-leader Task with capability lease, inherited constraints, budget, cancellation, execution-queue, and recovery semantics
- synthesis grants cannot expand the durable leader's tool or connection authority
- runtime synthesis output is untrusted until the package validates the `synthesis-final-v1` contract, source citations, confidence, and Task/run scope
- canonical immutable `synthesis_final` Artifacts preserve root objective, source Artifacts, disagreement/verifier lineage, raw synthesis draft, and durable leader provenance
- final Artifact identity is deterministic from canonical settlement material; repeated reconciliation returns the same final instead of duplicating output
- `final_artifact_ref` and Team Run `completed` status are committed atomically under Team Run compare-and-swap
- finalization rechecks verification and live-work gates immediately before that commit, so late concurrent Worker creation blocks completion rather than being stranded behind a final result
- malformed/canceled synthesis creates no canonical final and leaves a nonterminal run retryable in `synthesizing`
- aggregate budget exhaustion preserves terminal `budget_exhausted` state and cannot be overwritten by synthesis settlement
- completed-but-unreconciled synthesis survives database reopen and is reconciled by `ExecutionSupervisor`

#### Worker cleanup hardening

- host-neutral `TeamRunCleanup` handles post-run temporary state without deleting canonical protocol evidence
- cleanup is a maintenance/recovery boundary, so completed/failed/canceled Worker settlement remains observable before later expiry
- nonterminal Team Runs are refused; inconsistent live Tasks/Workers and unresolved Handoffs block cleanup visibly
- terminal temporary Workers expire without entering or mutating the durable Bot registry
- run-scoped capability leases and run-exclusive environment leases are revoked; environment leases still referenced by another Team Run are preserved
- residual execution-queue records are canceled
- stale pending Approvals attached to terminal run Tasks become non-actionable without deleting their records
- actionable mailbox deliveries targeting run Workers are canceled while Messages remain auditable
- temporary Team Run Rooms/Threads close while Messages, Tasks, Handoffs, Approvals, Workers, events, Artifacts and provenance remain intact
- structured cleanup summaries and audit events are idempotent and preserve side-effect evidence across compare-and-swap retries
- stale discussion opening reservations are reaped only through explicit setup lifecycle tags; active/task-bound/ambiguous state fails closed
- supervisor startup/recovery sweeps recover stale setup and terminal cleanup after database reopen

#### Adaptive collaboration decision policy

- host-neutral `TeamRunDecisionPolicy` decides whether one durable Bot is enough or a bounded squad is justified
- structured signals cover workstream independence, specialist/stage shape, uncertainty, verification need, discussion, ownership transfer, cost and latency sensitivity
- simple linear work remains `single` and creates no Team Run
- only already-supported topologies can be selected
- Worker identity, Task, concurrency, message, round and verifier capacity are considered before squad creation
- required verification reserves separate lifetime Worker capacity so earlier fan-out/discussion cannot strand it
- high cost sensitivity favors serial help unless explicit latency pressure justifies safe parallel work
- required ownership transfer fails closed when hop budget cannot execute a handoff
- required tool/connection authority cannot exceed durable leader permissions
- root objective, workspace, immutable constraints, approvals and bounded budget carry into the selected Team Run
- deterministic decision Artifact and selected Team Run IDs make equivalent requests idempotent
- an existing compatible Team Run for the root objective is reused; multiple runs for one objective are treated as orchestration-loop inconsistency
- decision Artifact integrity is validated before work opens
- decision Artifact plus audit event settle atomically; selected Team Run plus creation event settle atomically
- database reopen cannot duplicate a decision or adaptive Team Run

### Phase 2.6 acceptance gate

**PASSED.**

The eleven discussion acceptance/regression tests prove bounded temporary discussion, Worker isolation, reusable turn lifecycle, scoped grants, cross-run publication protection, setup reservation safety, budget limits, cancellation and restart-safe reconciliation.

### Phase 2.7 acceptance gate

**PASSED.**

The disagreement acceptance/regression tests prove structured conflict detection, compatible alternatives, tolerance/confidence behavior, fail-closed evidence scope, deterministic reports, persistent verification debt and restart-safe report history.

### Phase 2.8 acceptance gate

**PASSED.**

The verifier acceptance/regression tests prove bounded verifier creation, debt preservation/clearance, scoped evidence, authority/environment restrictions, cancellation, idempotency and restart-safe settlement.

### Phase 2.9 acceptance gate

**PASSED.**

The synthesis acceptance/hardening tests prove durable-leader synthesis, verification/live-work gates, canonical evidence boundaries, deterministic final settlement, cancellation, budget exhaustion and restart safety.

### Phase 2.10 acceptance gate

**PASSED.**

The cleanup acceptance/hardening suite proves terminal Worker/transient authority cleanup, shared environment preservation, temporary-surface closure, idempotency, stale setup reaping, restart recovery, unresolved-state blockers and audit preservation.

### Phase 2.11 acceptance gate

**PASSED.**

The adaptive decision acceptance/hardening suite proves:

1. simple linear work remains with one durable Bot
2. genuinely parallel work selects the minimum bounded parallel shape
3. required verification capacity is reserved independently and cannot be stranded
4. discussion/parallel/manager choices respect cumulative Worker, Task, message, round and concurrency limits
5. cost/latency signals select bounded serial vs parallel execution deterministically
6. unavailable Worker authority, capability authority, task capacity or handoff hop capacity fails closed
7. root objective, workspace, constraints, approvals and budget boundaries are preserved into adaptive Team Runs
8. compatible existing Team Runs are reused and duplicate root-objective Team Runs fail closed as an orchestration-loop inconsistency
9. tampered decision Artifacts cannot open work
10. decision Artifact and audit event settle atomically with clean retry after interruption
11. database reopen preserves one deterministic decision and selected Team Run without duplicate events

The full package suite now passes **167/167 tests** on the hardened Phase 2.11 PR head.

### Next Phase 2 gate

**2.12 - Squad-wide budget/cancellation consolidation**

Finish Phase 2 by auditing and consolidating the budget/cancellation contract across every supported squad topology. Token, cost, wall-clock, Worker, Task, action, hop, message and round ceilings must remain enforceable regardless of topology or whether current ownership sits with a Worker or run-scoped durable Bot. Cancellation and terminal budget exhaustion must reach all active squad work and prevent later reconciliation/recovery from resurrecting execution, while preserving canonical Artifacts and audit evidence. Add cross-topology and restart/recovery acceptance coverage, then close Phase 2 only when the full package gate is green.

## Phase 3 - AI-Verse Native Integration

**Status:** NOT STARTED

Remaining major slices:

1. AI-Verse OS installer/registration contract
2. workspace-scoped state projection
3. Brain initiative/goal ingress
4. Memory context/recall adapter
5. Skills capability resolution
6. Automations wake/schedule integration
7. OS write-command boundary
8. candidate knowledge/decision write-back
9. 4Cs health integration
10. uninstall/upgrade without canonical-state damage

## Phase 4 - Runtime and Agent Interoperability

**Status:** NOT STARTED

Remaining major slices:

1. A2A adapter
2. Hermes adapter
3. OpenClaw adapter
4. Codex/Claude Code process adapters where appropriate
5. external managed Bot runtime
6. remote-machine identity/authentication
7. remote capability/environment leases
8. retry/disconnect/reconnect semantics
9. compatibility/evaluation suite

## Phase 5 - Product, Installer, Omnichannel and Dashboard

**Status:** NOT STARTED

Remaining major slices:

1. simple install command/package
2. standalone install mode
3. AI-Verse OS install mode
4. setup/onboarding flow
5. Bot/team templates
6. production health/doctor
7. upgrade/migration strategy
8. secure remote Gateway option
9. Dashboard projections/control endpoints
10. Telegram/Discord/other channel bridge contracts
11. operator approvals/attention UX
12. observability/usage views
13. release docs/examples
14. full release acceptance suite

## Release acceptance

The first finished release must prove at minimum:

- install from a clean machine
- standalone mode works
- AI-Verse OS mode works without duplicating canonical state
- two durable Bots can collaborate end-to-end
- a Bot can form a temporary squad and synthesize its work
- work survives restart
- cancellation works
- budgets/limits stop runaway coordination
- approval-required actions cannot bypass approval boundary
- workspace isolation cannot be bypassed through Bot-to-Bot routing
- external runtime failure does not corrupt coordination state
- Dashboard/channel clients can observe/control without owning truth
- upgrade/uninstall preserves user-owned state

## How to report progress

For future implementation updates, report:

```text
Overall: Phase X of 5
Current phase: approximately N%
Current slice: X.Y
Just completed: ...
Next gate: ...
Major phases remaining: ...
```

Percentages are directional planning indicators only. Passed completion gates are authoritative.