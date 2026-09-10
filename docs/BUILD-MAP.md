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
Phase 2  Dynamic Multi-Agent Squads     [COMPLETE]    100%
Phase 3  AI-Verse Native Integration    [NOT STARTED]
Phase 4  Runtime / A2A Interoperability [NOT STARTED]
Phase 5  Product + Install + Dashboard  [NOT STARTED]
```

**Directional overall first-release progress:** roughly 65% complete.

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

Completed foundation:

- Node.js + TypeScript package, CLI, localhost Gateway, build/test CI
- SQLite coordination/object store and append-only ordered event substrate
- persistent Bots, Messages, Tasks, Handoffs, Artifacts, Approvals and leases
- asynchronous mailbox and persistent execution queue
- atomic multi-object/event/queue mutations and idempotency
- durable Bot registry, address resolution and lifecycle guards
- runtime-neutral adapter registry plus zero-dependency OpenAI-compatible HTTP adapter
- environment-handle credentials; raw manifest secrets rejected
- Task -> runtime -> Artifact execution with capability/environment validation
- execution leases, heartbeats, cancellation, deadlines, budgets, dead letters and restart recovery
- explicit delegation, inherited immutable constraints, root-objective lineage and hop/task ceilings
- accepted Handoff ownership/lease/approval/queue mutation with fail-closed claimed execution
- Rooms, Threads, mentions, bounded scheduling and result publication
- workspace isolation, loop/no-progress protection and approval enforcement

### Phase 1 completion gate

**PASSED.**

Two persistent Bots independently exist, communicate asynchronously, delegate actual work, transfer responsibility safely, collaborate in a Room/Thread, execute through a real runtime adapter, respect policy/limits/approvals, recover from Gateway restart, and cancel/fail without losing coordination integrity.

## Phase 2 - Dynamic Multi-Agent Squads

**Status:** COMPLETE

**Current phase progress:** 100%.

**Completion verification:** the hardened Phase 2.12 PR-head package suite passed **175/175 tests** with **0 failures, 0 canceled, and 0 skipped** on GitHub Actions run 248.

Goal achieved: a durable Bot decides whether to work alone or create bounded temporary Workers, coordinates them through the topology justified by the work, detects/verifies material disagreement, returns one canonical result, and enforces a shared run-wide safety contract without turning temporary helpers into durable identities.

### Phase 2 slices

1. Team Run object and lifecycle - **COMPLETE**
2. temporary Worker identities and bounded lifecycle - **COMPLETE**
3. Worker execution + manager/supervisor topology - **COMPLETE**
4. bounded parallel fan-out - **COMPLETE**
5. direct handoff topology - **COMPLETE**
6. bounded group/discussion topology - **COMPLETE**
7. structured disagreement detection - **COMPLETE**
8. verifier/critic role - **COMPLETE**
9. canonical synthesis - **COMPLETE**
10. Worker cleanup hardening - **COMPLETE**
11. adaptive `single Bot vs squad` decision policy - **COMPLETE**
12. squad-wide budget/cancellation consolidation - **COMPLETE**

### Phase 2 capabilities

#### Team Run + temporary identity

- canonical Team Run records and explicit lifecycle
- active durable Bot leader and same-workspace enforcement
- run-scoped `worker_*` identities that never enter the durable Bot registry
- no default Worker Room membership or long-term memory authority
- leader-only Worker lifecycle control and `can_create_workers` enforcement
- Worker Task binding and bounded identity capacity
- restart-persistent Team Run/Worker state and retained audit records

#### Worker execution + manager topology

- common Bot/Worker execution-principal contract
- Worker-aware event-driven supervisor
- Worker runtime inheritance with bounded run overrides
- capability/environment lease validation
- `worker_generated` Artifact provenance
- race-safe Worker + lease + Task preparation
- no authority expansion through Worker grants
- aggregate Team Run usage enforcement
- cancellation, deadlines and retry-safe recovery

#### Parallel fan-out

- bounded `parallel_panel`, `dynamic_squad`, and `hybrid` fan-out
- central concurrency ceiling and scheduling-time Worker/Task limits
- reservation-safe token/cost/action allocation before parallel execution
- independent Tasks, leases, contexts and Artifacts
- `all`, `first_success`, and bounded quorum joins
- partial-failure evidence preservation and remainder cancellation
- durable activation/recovery and cross-process compare-and-swap hardening

#### Direct handoff

- canonical Handoff-based Worker -> Worker and Worker -> durable Bot transfer
- no Worker promotion
- root/workspace/constraint preservation
- capability/environment authority reissue and Approval retargeting
- claimed/running fail-closed behavior
- mixed-principal hop and ownership-loop limits
- run-wide cancellation reaches durable-Bot-owned transferred work
- accepted transfer survives restart
- explicit return/stay ownership settlement

#### Bounded group/discussion

- temporary Room/Thread discussion without durable Worker membership
- explicit speaker/round plan and reusable nonterminal Worker participants
- Worker/message/round/Task ceilings
- turn-scoped capability leases
- prior candidate Artifact context with actual Worker provenance
- exact temporary-room publication authorization
- deterministic setup/thread/message settlement and restart-safe reconciliation

#### Structured disagreement + verifier

- deterministic structured-claim comparison without storing hidden reasoning
- evidence/constraint/recommendation/estimate/confidence conflict detection
- deterministic `disagreement_report` Artifacts and persistent verification debt
- bounded temporary verifier work only when debt warrants it
- canonical `verification_verdict` Artifacts
- scoped evidence, inherited authority/environment policy and no cross-run clearance
- cancellation/failure preserves unresolved debt; restart settlement is idempotent

#### Canonical synthesis

- durable Team Run leader performs final synthesis without another Worker identity
- unresolved verification debt/live temporary work blocks finalization
- bounded same-run canonical evidence set
- untrusted runtime draft must pass `synthesis-final-v1`
- deterministic immutable `synthesis_final` Artifact
- atomic `final_artifact_ref` + run completion
- late work, cancellation and aggregate budget exhaustion cannot be hidden by final settlement
- completed-but-unreconciled synthesis survives restart

#### Worker cleanup

- host-neutral `TeamRunCleanup`
- terminal temporary identity expiry without durable registry mutation
- transient capability/run-exclusive environment authority revocation
- genuinely shared environment preservation
- residual queue/Approval/mailbox cleanup while preserving audit objects
- temporary Room/Thread closure without deleting Messages/Artifacts/provenance
- stale discussion-opening reaping through explicit lifecycle tags
- idempotent startup/recovery cleanup

#### Adaptive collaboration decision policy

- host-neutral `TeamRunDecisionPolicy`
- simple linear work remains single-Bot
- minimum justified supported topology selected from structured work signals
- cumulative Worker/Task/concurrency/message/round/verifier/handoff capacity planning
- tool/connection authority cannot exceed leader permissions
- root objective, workspace, constraints, approval requirement and budget preserved
- deterministic decision Artifact/run IDs
- compatible run reuse and duplicate-root-objective loop prevention
- atomic/restart-safe decision settlement

#### Squad-wide budget/cancellation control

- public host-neutral `TeamRunControl`
- one aggregate Team Run budget snapshot across every supported topology
- token, cost, action, Task, Worker, hop, message and round ceilings
- absolute run wall-clock deadline from Team Run creation
- pre-claim queued-work guard and runtime deadline propagation
- running-work abort at the run deadline
- durable Team Run leader can hierarchically cancel any same-run participant-owned Task
- cancellation/budget exhaustion fences the Team Run before execution drain
- pending Approvals, active Handoffs and queue work become non-actionable
- active capability and run-exclusive environment authority are revoked without overwriting prior independent revocation attribution
- shared environments are preserved only while referenced outside the run
- temporary Rooms/Threads close and active topology pointers clear
- terminal dead-letter retry/topology reconciliation cannot resurrect execution
- startup recovers pending termination before topology recovery or queue drain
- termination audit summaries are idempotent and preserve already-applied evidence

### Phase 2 completion gate

**PASSED.**

The package proves the complete host-neutral squad lifecycle: adaptive single-vs-squad selection, manager/fan-out/handoff/discussion coordination, structured disagreement, selective verification, canonical synthesis, shared run-wide budget/cancellation control, restart recovery and evidence-preserving cleanup.

**Final code gate:** 175 tests passed, 0 failed, 0 canceled, 0 skipped.

### Phase 2 remaining work

None.

## Phase 3 - AI-Verse Native Integration

**Status:** NOT STARTED

Goal: attach the finished host-neutral teammate/squad package to AI-Verse OS without moving or duplicating canonical OS/Brain/Memory/Skills state into this repository.

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

Goal: make durable Bots/temporary Workers portable across supported local and remote runtimes while preserving protocol identity, authority, cancellation, provenance and recovery.

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

Goal: turn the completed coordination/integration/interoperability layers into a member-installable product with health, onboarding, remote/channel access and observability.

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

## Next gate

**Phase 3.1 - AI-Verse OS installer/registration contract.**

Phase 3 work must be additive through explicit host adapters. It must not merge this repository into AI-Verse OS or make the multi-bot package the source of truth for OS, Brain, Memory, Skills, Dashboard, or Automations state.

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