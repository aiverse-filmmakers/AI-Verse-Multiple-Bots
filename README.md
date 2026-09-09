# AI-Verse Multiple Bots

**An installable coordination layer for durable AI Bots, ephemeral agent squads, group rooms, handoffs, parallel research, review, and agent-to-agent communication.**

AI-Verse Multiple Bots is designed to give a local-first AI system a real team of agents without turning the team layer into another operating system, memory store, skill library, or source of domain truth.

It is built first for AI-Verse OS, but the core is intended to work standalone and with other agent runtimes.

## North star

> **One operator can create a durable roster of specialist Bots, assemble temporary Grok-style squads when a problem benefits from multiple perspectives, let those agents talk to each other safely, and still keep one clear source of truth.**

The goal is not "use as many agents as possible." The goal is to select the smallest collaboration topology that improves the task.

## Why this repository exists

The current agent ecosystem has solved different pieces of the problem:

- xAI Grok Multi-Agent demonstrates leader-led parallel research with multiple agents contributing to one synthesized answer.
- Hermes Bot Mode demonstrates the right human mental model for durable named Bots, persistent chats, group rooms, `@mentions`, routines, and cross-machine teammates.
- Microsoft Agent Framework formalizes sequential, concurrent, handoff, group-chat, and manager-style orchestration patterns.
- OpenAI Agents SDK cleanly separates manager-owned delegation from full handoffs.
- Google ADK provides agent transfers plus graph-based sequential, parallel, and loop workflows.
- A2A 1.0 provides an open protocol for discovery and communication between opaque agents running in different frameworks or on different machines.
- OpenClaw demonstrates strong per-agent workspace, auth, session, and channel isolation.
- AgentScope, LangGraph, CrewAI, Agno, CAMEL, MetaGPT, Pydantic AI, ClawSwarm and related projects provide additional useful coordination patterns.

AI-Verse Multiple Bots combines the strongest ideas while keeping the coordination layer narrow.

## The important distinction: Bot vs Worker

### Bot

A **Bot** is a durable identity.

It can have:

- a stable name and role
- a model policy
- a runtime adapter
- a workspace scope
- granted skills and tools
- explicit permissions
- a persistent direct chat
- membership in multiple rooms
- routines owned by an external automation layer
- a memory adapter when one is available

A Bot is meant to feel like a persistent teammate.

### Worker

A **Worker** is an ephemeral delegate created for one bounded task or one team run.

Workers are useful for:

- parallel research
- independent solution generation
- verification
- critique
- source checking
- testing
- alternative plans
- temporary specialist roles

Workers disappear when their run is complete unless explicitly promoted into a durable Bot.

This separation prevents the permanent Bot roster from becoming polluted by temporary subagents.

## Core collaboration patterns

AI-Verse Multiple Bots should support all of these as first-class patterns rather than pretending one pattern fits every task.

| Pattern | Purpose |
|---|---|
| **Direct Bot Chat** | Operator talks to one durable Bot |
| **Bot-to-Bot DM** | One Bot asks another Bot for bounded help |
| **Handoff** | Control transfers from one Bot to another |
| **Manager / Agents-as-Tools** | One leader retains responsibility and calls specialists |
| **Parallel Panel** | Several agents independently solve or research the same task |
| **Group Room** | Multiple durable Bots share one visible conversation |
| **Pipeline** | Output moves through a defined sequence of specialists |
| **Debate / Review** | Agents challenge, verify, or critique proposals |
| **Dynamic Squad** | A planner creates temporary roles for the current task |
| **Hybrid** | Central leader plus selective peer-to-peer communication |

## Grok-style squad mode

The public Grok Multi-Agent design is especially useful for research and complex open-ended questions:

```text
User request
    |
    v
Task classifier
    |
    +-- simple enough ----------> strongest suitable single Bot
    |
    +-- multi-agent justified
             |
             v
        Leader / Planner
             |
      +------+------+------+
      |      |      |      |
   Worker Worker Worker Worker ...
      |      |      |      |
      +------+------+------+
             |
       cross-check / critique
             |
             v
       Leader synthesis
             |
       optional verifier
             |
             v
        final response
```

Unlike xAI's fixed public 4-agent or 16-agent configurations, AI-Verse should make squad size configurable and task-dependent.

A simple task should often use one agent. A complex research task might use 3 to 6 specialists. Large fan-out should require a clear reason, an explicit budget, or operator approval.

## Architecture boundary

AI-Verse Multiple Bots owns **coordination state**, not domain truth.

It may own:

- Bot registry metadata
- room membership
- conversation envelopes
- team-run state
- routing state
- task delegation state
- presence and activity state
- coordination policies
- execution receipts and traces

It must not silently become the canonical home for:

- operator identity
- workspace knowledge
- long-term user memory
- strategic goals
- reusable skills
- business/project truth
- schedules owned by the OS automation layer

When installed into AI-Verse OS:

```text
AI-Verse OS          -> canonical state, workspace isolation, policy
AI-Verse Memory      -> durable historical memory
AI-Verse Brain       -> intent, goals, planning, reflection, initiative
AI-Verse Skills      -> reusable capabilities and operator packs
AI-Verse Multiple Bots -> agent identity, rooms, routing, delegation, collaboration
AI-Verse Dashboard   -> visual control and observability
```

## Native AI-Verse OS shape

Proposed installation contract:

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
│       └── conversations/       # coordination history, not domain truth
│
├── scripts/
│   └── ai-verse-bots/           # installed coordination engine
│
├── runtime/
│   └── ai-verse-bots/           # disposable indexes, sockets, caches, traces
│
└── .agents / .claude adapters   # optional runtime-facing adapters
```

Important information discovered in Bot conversations should be promoted through the normal AI-Verse OS write contracts into context, memory, decisions, or knowledge. Conversation history itself does not outrank canonical OS state.

## Standalone mode

Without AI-Verse OS, the layer can use a self-contained root such as:

```text
.ai-verse-bots/
├── registry.yaml
├── bots/
├── rooms/
├── conversations/
├── policies/
└── runtime/
```

Standalone integrations may optionally connect their own memory, skills, filesystem, or automation backends.

## Coordination Gateway

The heart of this repository should be a runtime-neutral **Coordination Gateway**.

```text
                    Operator / UI / Channel
                             |
                             v
                  +-----------------------+
                  | Coordination Gateway  |
                  +-----------------------+
                    |     |      |      |
          routing --+     |      |      +-- observability events
          policy ---------+      |
          budgets ---------------+
                    |
          +---------+---------+----------------+
          |                   |                |
          v                   v                v
     Local Bot Runner    Remote Bot Runner   A2A Agent
          |                   |                |
          v                   v                v
     model/runtime       model/runtime    opaque external
```

The Gateway should live outside any UI. Web, desktop, Telegram, Discord, AI-Verse Dashboard, CLI, and future clients should all talk to the same backend coordination engine.

## Push, not polling

Agent turns and room activity should be event-driven.

Use WebSocket/SSE locally and A2A streaming or push notifications for compatible remote agents. Polling should only be a fallback.

This is a deliberate lesson from current Hermes Bot Mode issues where group-turn polling can add latency and UI coupling.

## Message and task separation

Agent communication should distinguish:

- **Message**: conversational coordination
- **Task**: a unit of delegated work with lifecycle and ownership
- **Artifact**: a produced output or result handle
- **Event**: state transition, activity, error, approval, progress

This follows one of the strongest ideas in A2A 1.0: do not overload chat messages with task lifecycle and output semantics.

## Safe agent-to-agent messaging

Every cross-agent delegation should carry structured metadata, including:

- sender
- recipient or room
- workspace scope
- correlation ID
- task ID when applicable
- delegation reason
- expected output
- constraints that must survive the handoff
- budget
- hop count / TTL
- visibility
- permission context

A handoff reason is mandatory. A vague "talk to agent B" is not sufficient.

## Anti-loop controls

Agent societies can easily produce expensive or infinite conversations. The engine should enforce:

- maximum hops
- maximum rounds
- maximum messages per user turn
- per-run token and cost budgets
- wall-clock deadlines
- duplicate-message detection
- repeated-handoff detection
- agent-pair ping-pong detection
- no-progress detection
- cancellation propagation
- user escalation

The limits should be policy, not hard-coded into the UI.

## Permission law

> **Delegation may reduce authority, but it may never increase authority.**

If Bot A delegates to Bot B, B receives only the intersection of:

1. B's normal grants,
2. the current workspace scope,
3. the task-specific delegated capability lease.

A Bot cannot gain a secret, tool, filesystem path, connection, or destructive capability merely because another Bot asked it to act.

## Workspace law

Scope comes from trusted runtime context.

Bots must never invent filesystem roots or move themselves into another AI-Verse workspace by prompting each other.

Cross-workspace collaboration requires an explicit policy decision and should pass selected artifacts or summaries, not casually merge both workspaces into one context.

## Context law

Do not broadcast the complete shared history to every agent by default.

Each turn should receive a **context packet** containing only what that participant needs:

- current objective
- relevant constraints
- relevant room messages
- referenced artifacts
- assigned task
- allowed tools
- known decisions
- required response contract

This reduces context poisoning, token waste, and instruction leakage between agents.

## Human visibility

Agents should collaborate without forcing the operator to watch every tool call.

The default UI should expose:

- which Bots are active
- who is speaking to whom
- current tasks
- short progress summaries
- produced artifacts
- blocked / waiting states
- approvals
- cost and token use
- errors and retries

Internal hidden reasoning is not a collaboration protocol. Bots should exchange explicit messages, evidence, structured results, and artifacts.

## Interoperability

The repository should support several adapter levels:

1. **Native local adapter** for AI-Verse compatible runtimes.
2. **Hermes adapter** for Hermes profiles/Bots.
3. **OpenClaw adapter** for isolated OpenClaw agents.
4. **OpenAI Agents adapter** for manager/handoff workflows.
5. **Google ADK / Microsoft Agent Framework adapters** where useful.
6. **A2A adapter** as the standard boundary for remote or opaque agents.
7. **Generic process adapter** for CLI agents such as Claude Code, Codex, or other harnesses.

MCP remains primarily an agent-to-tool protocol. A2A is the preferred standard for agent-to-agent interoperability.

## Research-driven selection rule

2026 evidence shows that multi-agent systems can underperform a strong single agent when coordination is unnecessary, redundant, or poorly structured.

Therefore every run should begin with a topology decision:

```text
Can one suitable agent solve this reliably?
    yes -> use one agent
    no  -> why not?
             |
             +-- independent breadth needed -> parallel panel
             +-- specialist ownership needed -> handoff
             +-- decomposition needed -> manager + workers
             +-- ordered transformation -> pipeline
             +-- adversarial verification -> reviewer/debate
             +-- persistent team discussion -> room
             +-- unknown decomposition -> dynamic squad
```

Multi-agent execution must justify its additional complexity.

## First implementation target

The first production slice should implement the smallest complete substrate:

1. Bot and Room manifests.
2. Coordination Gateway.
3. local runner adapter.
4. durable DM and Room event logs.
5. `@mention` routing.
6. Bot-to-Bot task messaging.
7. manager, handoff, parallel-panel, and group-room orchestration.
8. hard budgets, cancellation, loop detection, and user escalation.
9. WebSocket/SSE event stream.
10. A2A-compatible remote adapter.
11. AI-Verse OS native installer and registry integration.
12. a deterministic test harness for coordination behavior.

The visual Bot roster should be implemented through AI-Verse Dashboard or another client after the backend contract is stable.

## Documents

- [`docs/RESEARCH-2026-09.md`](docs/RESEARCH-2026-09.md) - September 2026 research and framework benchmark.
- [`docs/ARCHITECTURE-BLUEPRINT.md`](docs/ARCHITECTURE-BLUEPRINT.md) - detailed technical architecture.
- [`docs/REFERENCE-ADOPTION-MAP.md`](docs/REFERENCE-ADOPTION-MAP.md) - what to adopt, adapt, study, or avoid from existing projects.
- [`docs/AI-VERSE-INTEGRATION.md`](docs/AI-VERSE-INTEGRATION.md) - exact boundaries with OS, Memory, Brain, Skills, and Dashboard.
- [`docs/COORDINATION-PROTOCOL.md`](docs/COORDINATION-PROTOCOL.md) - message, task, room, handoff, budget, and safety contracts.

## Research snapshot

Architecture research snapshot: **2026-09-09**.

This project is inspired by publicly documented behavior and open-source architectures. It does not claim to reproduce proprietary xAI internals.