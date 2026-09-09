# AI-Verse Multiple Bots

**An installable Persistent Teammate Layer for AI operating systems.**

AI-Verse Multiple Bots gives an AI system a durable roster of specialist Bots that can own jobs, work asynchronously, use real tools, collaborate with each other, share artifacts, hand off responsibility, participate in group Rooms and Threads, and spawn temporary multi-agent squads when one agent is not enough.

It is designed first for AI-Verse OS, but the coordination core is intended to work standalone and through adapters with other agent runtimes.

## North star

> **Give every AI operating system its own team of persistent AI coworkers without creating a second operating system or a second source of truth.**

The target experience is inspired most strongly by xAI's Grok Bot persistent-teammate model, while the execution architecture combines the strongest ideas from Hermes, Grok Multi-Agent, Microsoft Agent Framework, OpenAI Agents SDK, A2A, OpenClaw, AgentScope and other current multi-agent systems.

## Current implementation status

**Phase 0: Research + Architecture — complete**

**Phase 1: Runnable Coordination Core — started**

The repository now contains the first tested runtime substrate:

- TypeScript / Node.js project skeleton
- SQLite coordination store
- append-only coordination event log
- per-Room event ordering
- idempotent event writes
- persistent protocol-object storage
- persistent asynchronous delivery/mailbox queue
- Bot registry creation/listing substrate
- protocol-aligned runtime validation
- CLI commands for init, doctor, Bot creation/listing and event inspection
- automated restart/persistence and event-ordering tests

The implementation sequence is recorded in [`docs/IMPLEMENTATION-ROADMAP.md`](docs/IMPLEMENTATION-ROADMAP.md).

## Canonical architecture

For implementation, these are the current source documents:

1. [`docs/PERSISTENT-TEAMMATE-ARCHITECTURE.md`](docs/PERSISTENT-TEAMMATE-ARCHITECTURE.md) is the **canonical product and system architecture**.
2. [`docs/COORDINATION-PROTOCOL-V1.1.md`](docs/COORDINATION-PROTOCOL-V1.1.md) is the **current coordination protocol direction**.
3. [`schemas/coordination-v1.schema.json`](schemas/coordination-v1.schema.json) is the **architecture-stage machine-readable companion** and will evolve as implementation tests harden the protocol.
4. [`templates/bot.yaml`](templates/bot.yaml) and [`templates/room.yaml`](templates/room.yaml) are the current Bot and Room manifest examples.

The earlier [`docs/ARCHITECTURE-BLUEPRINT.md`](docs/ARCHITECTURE-BLUEPRINT.md) and [`docs/COORDINATION-PROTOCOL.md`](docs/COORDINATION-PROTOCOL.md) remain valuable research/background documents, but when they differ from the canonical files above, **the Persistent Teammate Architecture and Protocol v1.1 win**.

## Grok Bot vs Grok Multi-Agent

These are different layers and AI-Verse supports both ideas.

### Grok Bot product model

A Bot is a durable teammate with:

- a name and long-lived job
- one persistent conversation
- role-specific context
- access to real tools and a work environment
- background execution
- Bot-to-Bot messaging
- group collaboration
- handoffs
- Skills and recurring responsibilities
- approval boundaries
- visible working, blocked and attention states

This is the primary product benchmark for AI-Verse Multiple Bots.

### Grok Multi-Agent model

For one difficult task, a leader can launch several temporary agents in parallel, collect their work, resolve gaps and synthesize one result.

AI-Verse treats this as a **dynamic squad topology inside a Bot or Team Run**, not as the whole product.

## Why Grok Bot nailed the product model

The most important lessons are not model-specific:

1. **The primary object is the teammate, not the chat.** Users return to a stable Bot with responsibility that compounds over time.
2. **Each Bot has a clear job.** A small focused roster is more useful than dozens of vague universal assistants.
3. **Bots finish work in real tools.** Browser, files, shell, connectors and computer use turn advice into execution.
4. **Capabilities can be shared while context stays role-specific.** Tools and Skills do not require one giant shared memory.
5. **Bots coordinate without making the user a dispatcher.** They can message, hand off, collaborate in groups and wake each other asynchronously.
6. **Autonomy grows progressively.** Do a task once, make it reliable, save the method, then automate it.
7. **The interface manages attention rather than surveillance.** Working, waiting, blocked, approval-needed and completed states matter more than a constant wall of logs.
8. **Work can begin without a user prompt.** A user, schedule, event, Brain initiative or peer Bot can activate work.

See [`docs/GROK-BOT-DEEP-DIVE.md`](docs/GROK-BOT-DEEP-DIVE.md).

## AI-Verse layer boundary

AI-Verse Multiple Bots owns **coordination**, not domain truth.

```text
AI-Verse OS             -> canonical state, workspace isolation, policy
AI-Verse Memory         -> durable historical memory
AI-Verse Brain          -> intent, goals, planning, reflection, initiative
AI-Verse Skills         -> reusable capabilities and operator packs
AI-Verse Automations    -> schedules, triggers and recurring execution policy
AI-Verse Multiple Bots  -> Bot identity, Rooms, routing, tasks, handoffs, team runs
AI-Verse Dashboard      -> visual control and observability
```

Important discoveries from Bot work are proposed back through normal AI-Verse write contracts. A Bot conversation never becomes canonical truth merely because an agent said something.

## Core primitives

### Durable primitives

- **Bot**: persistent named teammate with one durable role and responsibility
- **Room**: shared group conversation for several durable Bots
- **Thread**: focused branch inside a DM or Room
- **Bot Relationship**: optional manager/coordinator relationship between durable Bots
- **Execution Environment Reference**: trusted handle to the environment where a Bot can act

### Run-scoped primitives

- **Worker**: temporary specialist created for one bounded task
- **Team Run**: bounded multi-agent execution
- **Task**: delegated unit of work with ownership and lifecycle
- **Capability Lease**: task-scoped authority
- **Environment Lease**: task-scoped execution environment assignment
- **Approval**: explicit decision gate for consequential action

### Content and state

- **Message**: conversational coordination
- **Artifact**: durable output/result handle
- **Event**: immutable coordination state transition
- **Presence**: ephemeral runtime activity
- **Attention State**: what the human needs to notice

## Bot vs Worker

A **Bot** is durable because a job deserves a long-lived owner.

A **Worker** is disposable because one task temporarily benefits from additional intelligence.

```text
Persistent roster
  Chief of Staff
  Research Lead
  Content Lead
  Finance Analyst

One difficult request
  Research Lead
      +-- temporary source auditor
      +-- temporary competitor researcher
      +-- temporary data checker
      +-- temporary verifier
```

Workers disappear when the Team Run completes unless explicitly promoted into a durable Bot.

## Collaboration patterns

The system does not pretend one swarm pattern fits every task.

| Pattern | Purpose |
|---|---|
| **Direct Bot Chat** | Operator talks to one durable teammate |
| **Bot-to-Bot DM** | Asynchronous peer communication |
| **Delegation** | Bot asks another Bot/Worker for bounded work while retaining ownership |
| **Handoff** | Active responsibility transfers to another Bot |
| **Manager** | One leader calls specialists and owns the final result |
| **Parallel Panel** | Independent agents work simultaneously |
| **Group Room** | Several durable Bots share visible project/team context |
| **Pipeline** | Work moves through an ordered sequence |
| **Review** | Independent critic/verifier checks a result |
| **Dynamic Squad** | Leader creates temporary specialist Workers for the current task |
| **Hybrid** | Central coordination plus selective peer-to-peer communication |

Every multi-agent run begins with a **collaboration gate**. If one strong suitable Bot can solve the task reliably, use one Bot.

## Grok-style dynamic squad

```text
Request
   |
   v
Collaboration Gate
   |
   +-- single Bot is enough ---> single execution
   |
   +-- team justified
           |
           v
      Leader / Planner
           |
     +-----+-----+-----+
     |     |     |     |
  Worker Worker Worker Worker
     |     |     |     |
     +-----+-----+-----+
           |
      gap/conflict check
           |
     selective follow-up
           |
           v
        synthesis
           |
     optional verifier
           |
           v
       final result
```

Unlike xAI's public fixed 4-agent/16-agent research configurations, AI-Verse squad size is task-dependent, model-neutral and centrally budgeted.

## Execution environments

Grok Bot currently uses one persistent cloud computer per user, shared by that user's Bots. That makes handoffs easy but is explicitly not a per-Bot security boundary.

AI-Verse improves this with configurable environment policy:

```text
shared_workspace  -> trusted Bots share a workspace execution environment
isolated_bot      -> one durable Bot gets an isolated environment/session boundary
isolated_run      -> temporary Worker/Team Run gets a disposable sandbox
external_managed  -> execution lives in Hermes, OpenClaw, A2A peer or another runtime
```

Multiple Bots stores environment **references and leases**, not VM implementation details. A runtime adapter can back those handles with local processes, browser profiles, containers, VMs, worktrees or remote computers.

## Coordination Gateway

The heart of the repository is an event-driven, runtime-neutral **Coordination Gateway**.

```text
          Dashboard / CLI / Desktop / Mobile / Channels
                              |
                              v
                  +-------------------------+
                  |  Coordination Gateway   |
                  +-------------------------+
                   |    |     |     |     |
             identity routing tasks policy budgets
                   |    |     |     |     |
                   +----+-----+-----+-----+
                              |
                           Event Bus
                              |
          +-------------------+-------------------+
          |                   |                   |
      Native Runner      Runtime Adapters       A2A Peers
          |                   |                   |
      AI-Verse OS       Hermes/OpenClaw/CLI    remote agents
```

No desktop or web client owns room scheduling or Bot-to-Bot routing.

Use push events through WebSocket/SSE locally. Polling is fallback only.

## Rooms and Threads

Rooms are real message hubs, not giant shared prompts.

A Room has:

- workspace scope
- member list
- active work ownership
- optional coordinator/leader
- canonical ordered event stream
- mention routing
- bounded turns
- Threads
- shared Artifact references
- attention/escalation state

Bots receive participant-specific context packets rather than the entire global history by default.

## One owner per stage

Parallel intelligence must not mean ambiguous responsibility.

Each active work item has one owner:

```yaml
owner_id: research-lead
collaborators:
  - source-auditor
  - reviewer
```

Collaborators can contribute without silently becoming co-owners of the final action.

## Safe Bot-to-Bot messaging

Every consequential delegation carries structured metadata:

- sender and recipient
- workspace scope
- root objective
- reason for delegation/handoff
- immutable required constraints
- expected output contract
- referenced Artifacts
- task ID and correlation ID
- capability lease
- execution environment lease when needed
- budget
- hop/TTL limit
- visibility and provenance

Agent-to-agent communication is a protocol, not one model sending another an unstructured paragraph.

## Permission law

> **Delegation may reduce authority, but it may never increase authority.**

Effective permission is the intersection of:

```text
host policy
INTERSECT
workspace policy
INTERSECT
Bot grants
INTERSECT
task capability lease
```

A peer cannot launder privilege by asking a more powerful Bot to perform something the current task was never authorized to do.

Secrets travel as handles, not raw values.

## Approval law

Consequential action should pass through policy outside the acting Bot:

```text
Bot proposes action
  -> policy engine
  -> optional independent risk reviewer
  -> allow | approval_required | deny
  -> execution
  -> receipt
```

This mirrors the strongest aspect of Grok Bot's approval/Auto Review model without depending on one provider.

## Workspace law

Workspace scope is trusted runtime state.

Bots cannot prompt each other into another AI-Verse workspace or invent filesystem roots.

Cross-workspace work is explicit and transfers selected Artifacts/summaries rather than casually joining both contexts.

## Context law

Capabilities may be broad. Context should remain scoped.

Each Bot turn receives only the context packet it needs:

- current objective
- current workspace/current canonical context
- relevant decisions
- immutable constraints
- selected Room/Thread messages
- assigned Task
- Artifact references
- Skills relevant to the task
- permitted tools/connections
- output contract

Peer messages never outrank system policy or canonical OS decisions.

## Work can start from five directions

```text
User message ──────────────┐
Brain initiative ──────────┤
OS Automation ─────────────┤
External event ────────────┤
Peer Bot message/handoff ──┤
                           v
                  Coordination Gateway
                           |
                           v
                          Bot
```

Multiple Bots does not create a second scheduler. AI-Verse Automations remains canonical for schedules/events, while the Bot UI can project those automations as "this Bot's routines."

## Skills and learning workflows

AI-Verse follows the same strong progression Grok Bot uses:

```text
perform once
   -> verify
   -> capture reusable method
   -> evaluate as Skill
   -> approve/promote Skill
   -> optionally bind Automation to responsible Bot
```

Teach-by-demonstration can later feed AI-Verse Skills through action traces without moving skill ownership into this repository.

## Presence and human attention

Runtime presence:

```text
idle
thinking
using_tool
waiting
blocked
```

Human attention state:

```text
none
working
unread_result
needs_input
needs_approval
handoff_waiting
failed
```

The Dashboard should default to attention state and a short current-action summary. Full traces remain available when the operator wants to inspect them.

## Native AI-Verse OS shape

```text
AI-Verse-OS/
├── agents/
│   ├── registry.yaml
│   └── bots/
│       ├── registry.yaml
│       ├── bots/
│       │   └── <bot-id>.yaml
│       ├── rooms/
│       │   └── <room-id>.yaml
│       ├── conversations/
│       │   ├── dm/
│       │   └── rooms/
│       ├── runs/
│       └── policies/
│
├── scripts/
│   └── ai-verse-bots/
│
└── runtime/
    └── ai-verse-bots/
        ├── coordination.db
        ├── cache/
        ├── sockets/
        ├── indexes/
        └── traces/
```

`agents/bots/` is user-owned coordination state. Engine code is system-owned. Runtime indexes/caches are disposable.

## Standalone mode

Without AI-Verse OS:

```text
.ai-verse-bots/
├── registry.yaml
├── bots/
├── rooms/
├── conversations/
├── runs/
├── policies/
└── runtime/
```

Host integrations can supply their own memory, skills, filesystem, automation and execution backends.

## Interoperability

Planned adapters:

1. native AI-Verse runtime
2. A2A remote agent
3. Hermes
4. OpenClaw
5. generic CLI/process agents such as Claude Code or Codex
6. OpenAI Agents SDK where useful
7. Google ADK / Microsoft Agent Framework where useful

MCP remains primarily agent-to-tool. A2A is the preferred external agent-to-agent standard.

## Anti-runaway controls

The Gateway centrally enforces:

- maximum hops/depth
- maximum Workers
- maximum Room rounds/messages
- token and cost budgets
- wall-clock deadlines
- duplicate Task detection
- repeated-handoff detection
- pair/cycle ping-pong detection
- no-progress detection
- cancellation propagation
- user escalation

The policy is not hard-coded into a UI.

## Research warning: more agents can be worse

2026 controlled research shows fixed multi-agent teams can underperform a strong single agent, waste budget, duplicate effort or average away the strongest expert.

Therefore the system selects the **smallest sufficient topology** and records whether multi-agent coordination actually improved the task class.

## Research and architecture documents

- [`docs/GROK-BOT-DEEP-DIVE.md`](docs/GROK-BOT-DEEP-DIVE.md) - real Grok Bot product architecture and AI-Verse lessons
- [`docs/PERSISTENT-TEAMMATE-ARCHITECTURE.md`](docs/PERSISTENT-TEAMMATE-ARCHITECTURE.md) - canonical architecture
- [`docs/COORDINATION-PROTOCOL-V1.1.md`](docs/COORDINATION-PROTOCOL-V1.1.md) - current protocol
- [`docs/IMPLEMENTATION-ROADMAP.md`](docs/IMPLEMENTATION-ROADMAP.md) - canonical build sequence and phase history
- [`docs/RESEARCH-2026-09.md`](docs/RESEARCH-2026-09.md) - multi-agent/open-source ecosystem benchmark
- [`docs/REFERENCE-ADOPTION-MAP.md`](docs/REFERENCE-ADOPTION-MAP.md) - what to adopt, adapt, integrate, study or avoid
- [`docs/AI-VERSE-INTEGRATION.md`](docs/AI-VERSE-INTEGRATION.md) - contracts with OS, Memory, Brain, Skills, Automations and Dashboard

## Machine-readable starting contracts

- [`schemas/coordination-v1.schema.json`](schemas/coordination-v1.schema.json)
- [`templates/bot.yaml`](templates/bot.yaml)
- [`templates/room.yaml`](templates/room.yaml)

These are architecture-stage contracts and will be tightened through implementation/evaluation rather than treated as frozen API forever.

## First production slice

The first implementation should deliver one end-to-end vertical slice:

1. Bot registry and durable Bot conversation.
2. Room + Thread event stream.
3. asynchronous Bot-to-Bot delivery.
4. explicit active work owner.
5. Task/Artifact/Event protocol.
6. Coordination Gateway.
7. local runtime adapter.
8. execution-environment references/leases.
9. `@mention` routing and pass semantics.
10. manager, handoff, parallel panel and Room orchestration.
11. temporary Worker squad execution.
12. approval/policy hook.
13. central budgets, loop controls and cancellation.
14. presence + attention events.
15. WebSocket/SSE subscriptions.
16. AI-Verse OS native installer.
17. A2A adapter.
18. deterministic coordination evaluation suite.

The visual Bot roster belongs in AI-Verse Dashboard after this backend contract is stable.

## North-star rule

> **Persistent Bots on the outside, bounded temporary teams on the inside, one event-driven Coordination Gateway in the middle, explicit ownership and permission around every action, and no duplicated source of truth.**

## Research snapshot

Architecture research snapshot: **2026-09-09**.

This project is informed by publicly documented product behavior, open-source projects, open standards and research. It does not claim to reproduce proprietary xAI Grok Bot internals.