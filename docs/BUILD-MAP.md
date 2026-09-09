# AI-Verse Multiple Bots - Build Map

**Updated:** 2026-09-09

This is the canonical progress map for the project. Update it whenever a meaningful implementation slice lands so repository state alone shows where the build is, what is complete, and what remains.

## Definition of finished

The first complete product release is reached when Phases 0 through 5 below are complete and the release acceptance suite passes.

The target is an installable persistent-teammate layer that can run standalone or attach to AI-Verse OS, host durable Bots, let them communicate and collaborate safely, create temporary multi-agent squads when useful, interoperate with external runtimes, and expose the system to Dashboard/omnichannel clients without becoming a second source of domain truth.

## Current position

```text
Phase 0  Research + Architecture        [COMPLETE]  100%
Phase 1  Runnable Coordination Core     [COMPLETE]  100%
Phase 2  Dynamic Multi-Agent Squads     [NOT STARTED]
Phase 3  AI-Verse Native Integration    [NOT STARTED]
Phase 4  Runtime / A2A Interoperability [NOT STARTED]
Phase 5  Product + Install + Dashboard  [NOT STARTED]
```

**Directional overall first-release progress:** roughly 40% complete.

That overall figure is intentionally approximate because later phases contain different amounts of work. Passed phase gates, not percentages, are authoritative.

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

**Status:** COMPLETE

**Completion evidence:** GitHub Actions run 102 on 2026-09-09 passed **54/54 tests** at commit `73706c40ddc6249a755655b889aff68240d016aa`.

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
- Bots, Messages, Tasks, Handoffs, Artifacts, Approvals and leases
- async mailboxes
- execution queue
- idempotency
- restart persistence
- reusable atomic multi-object/event/queue mutation primitive

### 1.3 Event substrate

**COMPLETE**

- append-only events
- global sequence
- per-Room sequence
- correlation/causation/trace fields
- global replay
- Room/Thread replay
- SSE
- HTTP Room replay endpoint

### 1.4 Bot registry

**PHASE-1 HARDENING COMPLETE**

- create/get/list
- immutable durable Bot IDs
- duplicate ID protection
- active/disabled/archived lifecycle
- archived status is terminal
- operator-audited activate/disable/archive transitions
- workspace-scoped and operator-scoped registry namespaces
- normalized identity addresses from Bot ID, shorthand ID, roster name, explicit aliases and UI handle
- role titles are descriptive and never implicit addresses
- same-scope address collision prevention
- archived addresses stay reserved to protect stale automations from silent retargeting
- explicit address resolution API
- manager existence/scope/availability validation
- self-manager rejection
- manager-cycle detection
- manager dependency guards during disable/archive
- explicit peer validation
- safe forward peer declarations with inbound scope validation when the target appears
- self-peer and cross-scope peer rejection
- lifecycle transition blocked while a Bot owns or is assigned live work
- archive blocked while active Rooms still reference the Bot
- disabled Room members cannot speak, resolve as active mentions, receive speaker scheduling or own Room work

### 1.5 Runtime adapter contract

**PHASE-1 COMPLETE**

- runtime-neutral adapter interface
- structured invocation/result
- runtime registry
- deterministic reference adapter
- zero-dependency OpenAI-compatible HTTP model adapter
- provider-neutral endpoint and model configuration
- environment-handle credentials instead of raw manifest secrets
- raw credential rejection before network execution
- normalized input/output token usage
- provider request/model/finish receipts
- secret-safe receipt URLs
- abort signal and adapter cancellation hook
- execution deadline integration
- runtime usage and action receipt surfaces
- installable Gateway registers both deterministic and OpenAI-compatible runtimes
- real two-Bot HTTP model collaboration proven in CI without a paid-provider dependency

### 1.6 Persistent Task execution and recovery

**PHASE-1 HARDENING COMPLETE**

- persistent execution queue
- atomic claim
- event-driven Bot wake-up
- Task -> runtime -> Artifact -> completion
- owner notification
- capability lease validation
- expired lease rejection
- explicit cancellation
- cancellation of running runtime
- recursive parent -> child cancellation
- deadline enforcement
- budget enforcement before Artifact acceptance
- Handoff settlement on completion/failure/cancellation
- unique runner identity
- runner-owned execution claims
- execution lease expiry
- continuous heartbeat
- ownership-checked state transitions
- atomic file-backed Task/Artifact/queue finalization
- late runner cannot overwrite recovered work
- startup and periodic stale execution sweep
- conservative recovery policies: `manual` and `retry_safe`
- replay-safe stale work can be requeued only while attempts remain
- unknown/consequential work dead-letters instead of being blindly replayed
- retry-safe work dead-letters after attempt exhaustion
- terminal Task state reconciles stale queue state without replay
- dead-letter Task becomes visibly blocked with recovery metadata
- operator-only dead-letter retry
- HTTP dead-letter listing and retry controls
- live long-running runtime heartbeat proven in CI
- canceled/failed/over-budget Tasks publish no successful Artifact

### 1.7 Delegation

**PHASE-1 COMPLETE**

- explicit owner
- root objective
- scoped capability lease
- parent lineage
- inherited constraints
- immutable constraint digest
- hop metadata/ceilings
- response target
- Task-backed Room work
- strict policy enabled by default in installable Gateway
- cancellation propagation
- deadline propagation
- inherited budget envelopes
- child Tasks cannot expand parent limits
- root Task-count ceiling
- optional persistent execution recovery policy and max-attempt ceiling
- validated same-workspace input Artifact references
- Artifact A can become structured input to Bot B without bypassing the Task contract
- input attachment is visible in the coordination event stream

### 1.8 Handoffs

**PHASE-1 HARDENING COMPLETE**

- canonical Protocol v1.1 fields: `target_bot_id` and `task_id`
- source ownership/root/workspace/status validation before request
- only one active Handoff per Task
- target-only acceptance
- explicit target/operator rejection path
- atomic Handoff + Task ownership + lease + Approval + queue + event mutation
- queued execution retargeting
- claimed/running execution fails closed rather than moving underneath a runner
- capability authority reissued to the target instead of reusing source authority
- target capability compatibility validation
- shared-workspace environment lease reissue
- isolated/external environment transfers fail closed until an adapter-specific secure transfer exists
- pending Approval actor retargeting without prematurely queueing work
- immutable constraint digest verification and stricter-constraint preservation
- `stay_with_target`, `return_on_completion`, `return_on_block`, and `explicit_only` policy contract
- automatic Handoff settlement on Task completion/failure/cancellation
- completion ownership return where configured
- Handoff lifecycle and ownership audit events
- HTTP request/accept/reject endpoints
- JSON Schema/runtime validator contract alignment

### 1.9 Rooms + Threads

**PHASE-1 COMPLETE**

- Room creation and membership
- same-workspace validation
- leaders
- registry-backed aliases and `@mentions`
- visible unresolved/ambiguous mention errors
- Threads
- pass
- bounded selective speaker scheduling
- active work owner/collaborators
- Room work creates real Tasks
- Bot Artifact/result publishes back into Room/Thread
- Room event ordering/replay storage
- Room replay HTTP API
- disabled Bots remain durable members but are unavailable for active Room work
- durable correlation IDs for multi-call Room turns
- aggregate `max_messages` enforcement across a complete correlation turn
- aggregate `max_rounds` enforcement across a complete correlation turn
- visible `room.round_scheduled` and `room.budget_exhausted` events

Advanced squad/topology behavior belongs in Phase 2.

### 1.10 Safety substrate

**PHASE-1 COMPLETE**

Implemented and enforced:

- workspace enforcement
- registered/active Bot checks
- peer allowlists
- tool/connection grant checks
- inherited constraints
- root-objective preservation
- hop ceilings
- duplicate active-Task prevention
- strict policy active by default in localhost/installable Gateway
- explicit Task cancellation
- recursive cancellation propagation
- runtime abort signaling
- wall-clock Task deadlines
- token budgets
- cost budgets
- action budgets
- root Task-count budgets
- Room message/round budgets
- child budget inheritance without privilege expansion
- delegation-loop detection
- Bot ping-pong detection
- repeated-result/no-progress detection
- first-class Approval objects
- approval queue
- operator-only approval decisions
- approval-required Tasks remain outside the execution queue
- denied approval cancels work and produces no Artifact
- fail-safe crash recovery that never auto-replays work unless explicitly declared replay-safe
- Bot identity/lifecycle rules that prevent silent retargeting or disabling a live owner
- raw runtime secret rejection and secret non-persistence checks

### Phase 1 completion gate

**PASSED.**

The required gate was:

> Two persistent Bots independently exist, communicate asynchronously, delegate actual work, transfer responsibility safely, collaborate in a Room/Thread, execute through a real runtime adapter, respect enforced policy/limits/approvals, recover from Gateway restart, and cancel/fail without losing coordination integrity.

The final release-level conformance scenario proves these behaviors together against one file-backed coordination database across a real Gateway close/reopen cycle. It also proves Handoff and Approval state survives that restart, runtime execution resumes only after approval, ownership return semantics settle correctly, Room/Thread work still executes, Room aggregate limits stop additional rounds, denied work produces no Artifact, and runtime secrets are not persisted.

**Verified suite:** 54 tests passed, 0 failed, 0 canceled, 0 skipped.

### Phase 1 remaining work

None.

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
