# AI-Verse Multiple Bots Implementation Roadmap

**Status:** Canonical build sequence

**Recorded:** 2026-09-09

This document records the implementation sequence agreed after completion of the research and architecture phase. It exists so future implementation work can be checked against the original build intent rather than reconstructed from chat history.

## Phase 0 - Research and architecture

**Status: complete**

Canonical implementation references:

1. `docs/PERSISTENT-TEAMMATE-ARCHITECTURE.md`
2. `docs/COORDINATION-PROTOCOL-V1.1.md`
3. `schemas/coordination-v1.schema.json`
4. `templates/bot.yaml`
5. `templates/room.yaml`

North-star architecture:

> Persistent Bots on the outside, bounded temporary teams on the inside, one event-driven Coordination Gateway in the middle, explicit ownership and permission around every action, and no duplicated source of truth.

## Phase 1 - Runnable Coordination Core

Build the smallest backend that proves persistent AI coworkers can exist, communicate and coordinate safely.

### Phase 1 completion milestone

Two persistent Bots can independently exist, talk asynchronously, delegate real work to each other, hand responsibility between each other, work together in a Room, and survive a Coordination Gateway restart without losing coordination state.

### Slice 1 - Repository/runtime skeleton

- TypeScript / Node.js project
- package structure
- configuration
- protocol/schema validation
- CLI
- test harness

### Slice 2 - Persistent coordination store

SQLite-backed coordination state for:

- Bots
- Workers
- Rooms
- Threads
- Messages
- Tasks
- Handoffs
- Team Runs
- Artifacts
- approvals
- events
- delivery queue

SQLite is implementation state for the coordination service, not AI-Verse domain truth.

### Slice 3 - Canonical Event Bus

- append-only coordination events
- correlation IDs
- causation IDs
- room/run ordering
- replay
- restart recovery
- idempotency

### Slice 4 - Bot Registry

- create Bot
- read/list Bot
- disable/archive Bot
- runtime adapter binding
- workspace scope
- role
- skill/capability references
- model policy
- execution-environment policy
- peer permissions

### Slice 5 - Local Runtime Adapter

- provider-neutral invocation interface
- scoped context packet input
- structured result output
- runtime/tool receipts
- cancellation
- timeout handling

### Slice 6 - Bot-to-Bot mailbox

Delivery lifecycle:

```text
queued
accepted
delivered
processing
replied
expired
failed
canceled
```

Requirements:

- asynchronous delivery
- retry-safe/idempotent sends
- persistent mailbox state
- wake/activation hooks

### Slice 7 - Delegation

```text
Bot A
  -> bounded Task to Bot B / Worker
  -> scoped context packet
  -> capability/environment leases
  -> Artifact result
  -> Bot A retains parent/root ownership
```

### Slice 8 - Handoff

```text
handoff.requested
  -> handoff.accepted | handoff.rejected
  -> ownership.changed only after acceptance
```

Requirements:

- immutable constraints survive
- selected context/artifacts survive
- permissions cannot increase
- handoff is never silently treated as ordinary messaging

### Slice 9 - Rooms and Threads

- canonical Room stream
- `@mention` resolution
- replies
- Threads
- pass semantics
- selective speaker routing
- one active owner per work item
- push/event-driven delivery rather than polling

### Slice 10 - Safety substrate

- hop limits
- round/message limits
- Worker limits
- token/cost budgets
- wall-clock deadlines
- duplicate Task detection
- repeated handoff detection
- pair/cycle ping-pong detection
- no-progress detection
- cancellation propagation
- approval interception
- explicit user escalation

## Phase 2 - Dynamic Squads

Add Grok Multi-Agent style temporary teams inside persistent Bots.

A permanent Bot can decide whether one agent is sufficient. If not, it can create bounded temporary Workers with distinct roles, execute them concurrently, compare evidence, launch selective follow-ups, synthesize, optionally verify, and then destroy the temporary Workers.

Example:

```text
Research Lead
   +-- Worker: primary-source researcher
   +-- Worker: competitor researcher
   +-- Worker: technical analyst
   +-- Worker: skeptic/verifier
```

Workers are run-scoped and do not automatically receive durable memory or permanent team membership.

## Phase 3 - Native AI-Verse integration

Integrate the coordination engine with the existing AI-Verse layers without merging repository ownership.

```text
AI-Verse OS
    ^
    |
Multiple Bots
    |
    +-- Brain
    +-- Memory
    +-- Skills
    +-- Automations
```

Key contracts:

- OS supplies canonical workspace scope, truth and policy
- Brain can initiate/decompose work
- Memory supplies/scopes historical context and receives candidate memories
- Skills supplies reusable capabilities
- Automations owns schedules/triggers and can target responsible Bots
- Multiple Bots owns coordination identity/routing/task state only

## Phase 4 - Interoperability

Add runtime-neutral team members through adapters:

1. A2A
2. Hermes
3. OpenClaw
4. generic CLI/process agents
5. Claude Code / Codex style harnesses
6. OpenAI Agents SDK
7. Google ADK / Microsoft Agent Framework where useful

Target experience:

```text
@ChiefOfStaff  -> AI-Verse native
@Research      -> Hermes on VPS
@Developer     -> Codex/CLI runtime
@Operator      -> OpenClaw
@Legal         -> remote A2A agent
```

Multiple Bots presents them as one coherent team while preserving each runtime's boundaries.

## Phase 5 - Dashboard teammate experience

After the backend contract is stable, integrate with AI-Verse Dashboard.

Primary surfaces:

- Bot roster
- working/idle/blocked/approval-needed states
- DMs
- Rooms
- Threads
- active Tasks
- Team Runs
- handoffs
- Artifacts
- approvals
- compact cost/token/resource state
- expandable execution traces

The Dashboard remains an interface/projection layer. It never becomes the owner of orchestration state.

## Build discipline

1. Do not merge this repository into AI-Verse OS, Memory, Brain, Skills or Dashboard.
2. Keep the coordination core runtime-neutral.
3. Prefer typed protocol objects over prompt-only agent communication.
4. Do not add another canonical knowledge/memory system.
5. Keep UI logic out of the backend orchestration semantics.
6. Multi-agent execution must pass a collaboration gate rather than being the default for every request.
7. Each active work item has one explicit owner.
8. Delegation may reduce authority but may never increase it.
9. Preserve immutable constraints, provenance and workspace scope through every delegation/handoff.
10. Add deterministic tests for coordination behavior before expanding the surface area.

## Immediate next action

Begin **Phase 1, Slice 1** by creating the runnable Coordination Gateway project skeleton, schema validation, SQLite persistence substrate, append-only event store, CLI and automated tests.