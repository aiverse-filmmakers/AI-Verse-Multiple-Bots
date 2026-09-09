# AI-Verse Multiple Bots - Build Map

**Updated:** 2026-09-09

This is the canonical progress map for the project. Update it whenever a meaningful implementation slice lands so repository state alone shows where the build is, what is complete, and what remains.

## Definition of finished

The first complete product release is reached when Phases 0 through 5 below are complete and the release acceptance suite passes.

The target is an installable persistent-teammate layer that can run standalone or attach to AI-Verse OS, host durable Bots, let them communicate and collaborate safely, create temporary multi-agent squads when useful, interoperate with external runtimes, and expose the system to Dashboard/omnichannel clients without becoming a second source of domain truth.

## Current position

```text
Phase 0  Research + Architecture        [COMPLETE]    100%
Phase 1  Runnable Coordination Core     [COMPLETE]    100%
Phase 2  Dynamic Multi-Agent Squads     [IN PROGRESS] ~72%
Phase 3  AI-Verse Native Integration    [NOT STARTED]
Phase 4  Runtime / A2A Interoperability [NOT STARTED]
Phase 5  Product + Install + Dashboard  [NOT STARTED]
```

**Directional overall first-release progress:** roughly 57% complete.

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

**Current phase progress:** approximately 72%.

**Current verification:** GitHub Actions run 173 on 2026-09-09 passed **104/104 tests** at commit `57fd202688def83af84d455edee60ea9e9782ee8`.

Goal: a durable Bot decides whether to work alone or create bounded temporary Workers, coordinates them through the topology justified by the work, and returns a bounded, auditable result without turning temporary helpers into durable identities.

Major slices:

1. Team Run object and lifecycle - **COMPLETE**
2. temporary Worker identities and bounded lifecycle - **COMPLETE**
3. Worker execution + manager/supervisor topology - **COMPLETE**
4. bounded parallel fan-out - **COMPLETE**
5. direct handoff topology - **COMPLETE**
6. bounded group/discussion topology where justified - **COMPLETE**
7. disagreement detection - **COMPLETE**
8. verifier/critic role - **NEXT**
9. synthesis - remaining
10. Worker cleanup - remaining beyond terminal expiry foundation already implemented
11. adaptive `single Bot vs squad` decision policy - remaining
12. squad budget/cancellation controls - remaining beyond current Worker, fan-out, aggregate usage, direct-handoff, discussion, disagreement, cancellation, recovery and CAS foundations

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
- stale setup reservations intentionally fail closed; timeout/reaping is not claimed yet
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
- later compatible subset analysis cannot clear unresolved Team Run verification debt; only the future verifier/critic stage may explicitly resolve it
- report lookup/listing ignores cross-run or cross-workspace poisoned references
- report history and latest report survive database reopen

### Phase 2.6 acceptance gate

**PASSED.**

The eleven discussion acceptance/regression tests prove:

1. temporary discussion Workers remain outside durable Room membership and the Bot registry
2. a completed discussion turn leaves its Worker reusable and nonterminal until the discussion closes
3. speaker capability grants reach the turn-scoped capability lease
4. Worker Room publication cannot cross Team Run boundaries
5. an existing setup reservation blocks another opener before Worker creation
6. two Workers can be reused for four ordered turns under `max_workers: 2`
7. later turns receive prior candidate Artifacts as structured evidence
8. Team Run message/round/task limits cap the discussion before scheduling
9. unsupported topologies fail closed instead of opening a discussion
10. cancellation closes active discussion work and temporary participants
11. restart after completed-but-unreconciled work resumes without duplicating completed Tasks or Worker turn records

### Phase 2.7 acceptance gate

**PASSED.**

The eleven disagreement acceptance/regression tests prove:

1. incompatible values for the same fact produce a high-severity evidence conflict and require verification
2. different recommendations remain compatible unless candidates explicitly declare them mutually exclusive
3. opposed stances on the same declared claim produce a contradiction
4. material confidence gaps are surfaced without automatically forcing verifier work
5. estimate differences conflict only when they exceed declared tolerance
6. unstructured/non-comparable candidates return insufficient evidence rather than invented disagreement
7. cross-run candidate inputs and bounded input ceilings fail closed before report creation
8. identical analysis is deterministic and idempotent
9. default candidate references and disagreement reports survive database reopen
10. a later compatible subset cannot clear unresolved Team Run verification debt from an earlier conflict
11. `latest`/`list` ignore disagreement-report references that belong to another Team Run

The full package suite now passes **104/104 tests**.

### Next Phase 2 gate

**2.8 - Verifier/critic role**

Consume structured disagreement reports only when verification is justified. The verifier must evaluate the explicit conflict evidence, preserve source/provenance lineage, produce a structured verdict Artifact, and explicitly resolve or retain entries in `verification_required_report_refs`. It must not clear verification debt merely because a later candidate subset looks compatible, and it must remain bounded by Team Run authority, budget, cancellation, and restart rules.

After 2.8, continue through synthesis, Worker cleanup hardening, adaptive collaboration choice, and final squad-wide budget/cancellation consolidation.

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
