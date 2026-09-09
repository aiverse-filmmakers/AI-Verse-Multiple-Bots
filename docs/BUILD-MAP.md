# AI-Verse Multiple Bots - Build Map

**Updated:** 2026-09-09

This is the canonical progress map for the project. Update it whenever a meaningful implementation slice lands so repository state alone shows where the build is, what is complete, and what remains.

## Definition of finished

The first complete product release is reached when Phases 0 through 5 below are complete and the release acceptance suite passes.

The target is an installable persistent-teammate layer that can run standalone or attach to AI-Verse OS, host durable Bots, let them communicate and collaborate safely, create temporary multi-agent squads when useful, interoperate with external runtimes, and expose the system to Dashboard/omnichannel clients without becoming a second source of domain truth.

## Current position

```text
Phase 0  Research + Architecture        [COMPLETE]  100%
Phase 1  Runnable Coordination Core     [ACTIVE]     ~70%
Phase 2  Dynamic Multi-Agent Squads     [NOT STARTED]
Phase 3  AI-Verse Native Integration    [NOT STARTED]
Phase 4  Runtime / A2A Interoperability [NOT STARTED]
Phase 5  Product + Install + Dashboard  [NOT STARTED]
```

Overall product completion should be judged by passed milestones, not calendar time. At this checkpoint, the architecture is complete and most of the single-Task/persistent-team substrate exists, but dynamic squads, native AI-Verse integration, external-runtime interoperability, installer/product hardening, and final release acceptance remain.

## Phase 0 - Research + Architecture

**Status:** COMPLETE

- Grok Bot deep dive
- Grok Multi-Agent distinction
- Hermes Bot Mode study
- Microsoft Agent Framework orchestration patterns
- A2A / OpenAI Agents / OpenClaw / AgentScope / Pydantic AI and related benchmark research
- canonical persistent-teammate architecture
- protocol v1.1
- AI-Verse layer boundaries
- schemas and Bot/Room templates
- implementation roadmap

## Phase 1 - Runnable Coordination Core

**Status:** ACTIVE, approximately 70%

### 1.1 Repository/runtime skeleton

**COMPLETE**

- Node.js + TypeScript core
- CLI
- localhost Gateway
- build/test scripts
- GitHub Actions CI

### 1.2 Persistent coordination store

**COMPLETE**

- SQLite coordination state
- protocol object store
- Bots, Messages, Tasks, Handoffs, Artifacts, leases
- async mailboxes
- execution queue
- idempotency
- restart persistence

### 1.3 Event substrate

**COMPLETE**

- append-only events
- global sequence
- per-Room sequence
- correlation/causation/trace fields
- replay
- SSE
- Room/Thread replay storage

### 1.4 Bot registry

**PARTIAL**

Complete:
- create/get/list
- active status validation
- workspace association
- runtime/execution/permission metadata

Remaining:
- explicit disable/archive transition API
- alias/collision hardening outside Rooms
- relationship validation hardening

### 1.5 Runtime adapter contract

**COMPLETE FOR TEST SUBSTRATE**

- runtime-neutral adapter interface
- structured invocation/result
- deterministic adapter
- runtime registry

Remaining before Phase 1 closes:
- first real useful runtime adapter
- cancellation/timeout propagation through adapter
- richer runtime/tool receipts

### 1.6 Persistent Task execution

**COMPLETE FOR HAPPY PATH + BASIC FAILURE PATH**

- persistent execution queue
- atomic claim
- event-driven Bot wake-up
- startup recovery scan
- Task -> runtime -> Artifact -> completion
- owner notification
- expired capability lease rejection

Remaining:
- cancellation
- retry/dead-letter policy
- stale-claim recovery
- deadline enforcement
- multi-process lease hardening

### 1.7 Delegation

**COMPLETE FOR CORE SEMANTICS**

- explicit owner
- root objective
- scoped capability lease
- parent lineage support
- hop metadata
- response target
- Task-backed Room work

Remaining:
- strict policy enabled by default in installable Gateway
- budget propagation
- cancellation propagation

### 1.8 Handoffs

**PARTIAL**

Complete:
- request
- target-only acceptance
- ownership mutation after acceptance
- ownership events

Remaining:
- atomic transaction across handoff + ownership + events + execution queue
- reject flow
- queue retargeting
- capability/environment lease intersection or transfer
- immutable-constraint digest verification
- return-policy execution

### 1.9 Rooms + Threads

**COMPLETE FOR CORE PHASE-1 BEHAVIOR**

- Room creation and membership
- same-workspace validation
- leaders
- aliases and @mentions
- visible unresolved/ambiguous mention errors
- Threads
- pass
- bounded selective speaker scheduling
- active work owner/collaborators
- Room work creates real Tasks
- Bot Artifact/result publishes back into Room/Thread
- Room event ordering/replay storage

Remaining:
- expose Room replay over HTTP
- advanced group-turn policies belong in later squad/product phases

### 1.10 Safety substrate

**PARTIAL**

Implemented policy primitives:
- workspace enforcement
- registered/active Bot checks
- peer allowlists
- tool/connection grant checks
- inherited constraints
- root-objective preservation
- hop ceilings
- duplicate active-Task prevention

Remaining:
- enable strict policy by default in the installable Gateway
- cancellation propagation
- wall-clock deadlines
- token/cost/resource budgets
- loop/ping-pong detection
- no-progress detection
- Room turn/message ceilings as enforced runtime budgets
- approval interceptor
- user escalation

### Phase 1 completion gate

Phase 1 is complete only when all of the following pass together:

> Two persistent Bots independently exist, communicate asynchronously, delegate actual work, transfer responsibility safely, collaborate in a Room/Thread, execute through a real runtime adapter, respect enforced policy/limits/approvals, recover from Gateway restart, and cancel/fail without losing coordination integrity.

## Phase 2 - Dynamic Multi-Agent Squads

**Status:** NOT STARTED

Goal: a durable Bot decides whether to work alone or create bounded temporary Workers.

Remaining major slices:

1. Team Run object and lifecycle
2. temporary Worker identities
3. manager/supervisor topology
4. parallel fan-out
5. direct handoff topology
6. group/discussion topology where justified
7. disagreement detection
8. verifier/critic role
9. synthesis
10. Worker cleanup
11. adaptive "single Bot vs squad" decision policy
12. squad budget/cancellation controls

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
- approval-required actions cannot bypass the approval boundary
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
