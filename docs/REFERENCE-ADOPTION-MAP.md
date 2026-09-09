# AI-Verse Multiple Bots Reference Adoption Map

**Snapshot:** 2026-09-09

This document turns the research benchmark into an implementation policy.

The objective is not to fork one existing framework and rename it. AI-Verse Multiple Bots should have its own narrow coordination core, use open standards at its boundaries, adapt proven ideas deliberately, and avoid importing another platform's ownership model into AI-Verse OS.

## Adoption categories

- **ADOPT**: make the concept a first-class AI-Verse primitive.
- **ADAPT**: preserve the useful idea but redesign it for AI-Verse boundaries.
- **ADAPTER**: integrate with the framework instead of absorbing it.
- **STUDY**: use as an implementation reference only.
- **AVOID**: deliberately do not copy this architectural choice.

## Reference map

| Reference | Strongest idea | AI-Verse decision | Priority | Notes |
|---|---|---|---|---|
| xAI Grok Multi-Agent | Leader plus parallel task-scoped agents and one synthesized result | **ADAPT** | Critical | Implement Grok-style dynamic squads, but task-dependent rather than fixed 4/16 agent counts. Do not claim proprietary xAI internals are reproduced. |
| Hermes Bot Mode | Durable named Bots, canonical DMs, rooms, mentions, pass behavior, routines, cross-machine teammates | **ADAPT** | Critical | This is the strongest human-facing mental model. Move orchestration out of Desktop/UI and into the backend Coordination Gateway. |
| Microsoft Agent Framework | Sequential, concurrent, handoff, group chat, manager/Magentic as explicit orchestration patterns | **ADOPT** | Critical | Treat topologies as selectable primitives rather than one universal swarm loop. Optional adapter later, not a mandatory runtime dependency. |
| A2A 1.0 | AgentCard, Task, Message, Artifact, streaming, push notifications, opaque agent interoperability | **ADOPT + ADAPTER** | Critical | Preferred external agent-to-agent boundary. Keep native local protocol smaller and map it cleanly to A2A. |
| OpenAI Agents SDK | Clear distinction between manager-owned specialists and handoffs | **ADOPT** | Critical | `ask/delegate` and `handoff` must have different ownership semantics. Use explicit handoff metadata and context filtering. |
| OpenClaw | Per-agent workspace, auth, state, session and channel isolation | **ADAPT + ADAPTER** | High | Preserve the isolation discipline. Do not turn Multiple Bots into another omnichannel gateway or duplicate OpenClaw itself. |
| Google ADK | Agent transfer plus sequential/parallel/loop graph workflows | **STUDY + ADAPTER** | High | Mandatory transfer reason is especially valuable for preventing ping-pong handoffs. |
| AgentScope | MsgHub abstraction, dynamic participants, distributed agents | **ADAPT** | High | Rooms should be real message hubs with delivery semantics, not one giant shared prompt. |
| Pydantic AI | Typed delegation, explicit dependencies, usage accounting, cancellation, controlled history transfer | **ADAPT** | High | Use typed schemas and explicit context packets across every runtime adapter. |
| LangGraph | Graph orchestration, checkpointers, supervisors, handoffs | **STUDY + ADAPTER** | Medium | Useful patterns, but avoid a magical supervisor abstraction and uncontrolled shared-state propagation. |
| CrewAI | Autonomous crews wrapped in controlled Flows | **STUDY** | Medium | Reinforces deterministic orchestration around open-ended agents. Do not inherit role/persona ownership into the coordination layer. |
| Agno | Teams plus workflow runtime and observability | **STUDY** | Medium | Good production reference, but too broad to become the foundation because AI-Verse already owns memory, knowledge, skills and UI layers. |
| CAMEL | Role specialization, workforces, multi-agent research patterns | **STUDY** | Medium | Useful for dynamic role generation and research experiments, not as the universal runtime contract. |
| MetaGPT | SOP-driven agent organization | **STUDY** | Medium | Procedure should come from AI-Verse Skills/Brain, not hard-coded software-company roles. |
| ClawSwarm | Sidecar scheduler enabling shared OpenClaw group chat | **STUDY** | Medium | Strong proof of sidecar coordination architecture. GPL-3.0 means avoid copying implementation into a permissive core unless licensing strategy deliberately changes. |
| ClawTeam and related swarm projects | Leader task split, inbox, broadcast, dependencies, isolated work areas | **STUDY** | Medium | Review individual maturity and licensing before reuse. |

## What Grok got right

The Grok reference should influence **task execution**, not permanent Bot identity.

### Adopt

- leader owns synthesis;
- parallel specialists can investigate different dimensions;
- agent collaboration is hidden behind one coherent final response when appropriate;
- fan-out is useful for broad research and verification;
- worker outputs return to an orchestrator rather than competing directly for the user conversation.

### Improve

AI-Verse should add:

- collaboration gate before fan-out;
- configurable agent count;
- cost and token ceilings;
- explicit worker roles and output contracts;
- participant-specific context packets;
- evidence-weighted synthesis;
- optional verifier;
- cancellation propagation;
- workspace and permission isolation;
- visible structured progress when the host UI wants it;
- ability to mix durable Bots and temporary Workers.

### Do not copy

- a fixed 4-agent or 16-agent assumption;
- multi-agent use on every request;
- one-provider dependency;
- hidden permission inheritance;
- architecture that requires sub-agents to use the same model or runtime.

## What Hermes got right

Hermes should influence **the persistent teammate experience**.

### Adopt

- Bots are durable named identities;
- each Bot has one stable direct conversation surface;
- Bots can join group rooms;
- explicit `@mentions` route attention;
- Bots can mention other Bots;
- a Bot can pass rather than manufacture filler;
- room turns are bounded;
- user escalation is explicit;
- remote Bots can participate;
- one Bot can participate in several teams/rooms;
- routines can target a responsible Bot.

### Redesign

- canonical room engine belongs in backend service;
- push events replace polling as primary coordination transport;
- one room event stream is canonical rather than independent member-owned versions of room history;
- the room engine is usable from CLI, Dashboard, web, desktop and messaging channels equally;
- runtime/model inheritance is explicit in manifests and adapter contracts;
- local and remote members are resolved through one identity registry;
- speaker scheduling has deterministic tests;
- unresolved `@mentions` cannot silently disappear at caps;
- activity and delivery state are protocol events rather than UI assumptions.

### Avoid

- orchestration logic coupled to Electron/Desktop lifecycle;
- duplicated composer or chat semantics for group mode;
- long polling between Bots;
- separate backend behavior depending on which UI initiated the room;
- accidental divergence between Bot DM configuration and room configuration.

## What Microsoft Agent Framework validates

Use separate first-class orchestration strategies:

```text
single
manager
handoff
parallel
room
group_manager
pipeline
review
dynamic_squad
hybrid
```

The topology can change while the Bot identities remain constant.

This prevents the common mistake of describing all multi-agent work as a "swarm."

## What OpenAI Agents SDK validates

AI-Verse protocol terminology should distinguish:

### Delegation / agent-as-tool

The caller remains the owner.

```text
A asks B for a bounded result
B returns result to A
A remains responsible for user response
```

### Handoff

Ownership changes.

```text
A transfers active responsibility to B
B becomes the current conversational owner
```

The two operations must never share one ambiguous method.

Recommended command names:

```text
bots.delegate
bots.handoff
```

rather than a generic `bots.send_to_agent` for both meanings.

## What A2A should standardize for us

Use A2A at the external boundary for independently running agents.

Do not reinvent remote-agent concepts that A2A already standardizes:

- capability/discovery card;
- task identity and lifecycle;
- messages;
- artifacts;
- content parts;
- streaming updates;
- asynchronous push;
- cancellation;
- authentication declarations;
- extension negotiation.

AI-Verse-specific concepts such as workspace lease metadata should be represented through namespaced extensions instead of changing A2A core semantics.

## What OpenClaw should teach the isolation layer

Agent collaboration is not permission sharing.

A durable Bot should be able to have:

- its own runtime profile;
- its own model policy;
- its own allowed tools;
- its own connection grants;
- a bounded workspace scope;
- its own sessions;
- explicit channel bindings.

When two Bots collaborate, only the task-scoped intersection of authority is usable.

Do not merge their credentials, filesystem roots, or session stores.

## Message hub architecture from AgentScope

A Room should implement delivery and participation explicitly.

Bad model:

```text
join every agent transcript together
send giant prompt to each agent
hope the agents infer who should answer
```

Target model:

```text
room event
  -> gateway resolves eligible participants
  -> speaker policy selects/queues recipients
  -> each recipient gets its scoped context packet
  -> recipient emits reply/pass/task/artifact event
  -> gateway appends canonical event
  -> subscribers receive push update
```

## Typed delegation from Pydantic AI

Every runtime adapter must convert AI-Verse's typed Task/Message/Artifact contracts into the native framework rather than passing arbitrary prompt blobs around.

This enables:

- schema validation;
- permission checks before execution;
- deterministic retries;
- compatible history transfer;
- usage accounting;
- cancellation;
- easier cross-framework adapters.

## Lessons from LangGraph and supervisor frameworks

### Keep useful ideas

- checkpointed runs;
- graph-shaped workflows;
- supervisor nodes;
- explicit handoffs;
- resumability.

### Avoid recurring failure modes

- dropping constraints during task reformulation;
- assuming a high-level supervisor abstraction automatically enables true parallelism;
- passing incompatible histories to another agent;
- making all participants mutate one shared state object without an artifact concurrency contract;
- assuming the final supervisor will notice that a delegated task silently lost part of the original requirement.

AI-Verse solves these through root objective IDs, immutable constraints, typed outputs, artifact versions, and verification.

## Licensing and code-reuse policy

The research intentionally distinguishes **ideas** from **copied implementation**.

Verified during this architecture phase:

- Hermes Agent: MIT;
- Microsoft Agent Framework: MIT;
- OpenAI Agents SDK: MIT;
- OpenClaw: MIT;
- A2A: Apache-2.0;
- ClawSwarm: GPL-3.0 according to its repository metadata/documentation reviewed during research.

Before copying code from any other project, verify its exact current license and attribution obligations at implementation time.

### Recommended policy

1. Build the AI-Verse coordination core independently.
2. Prefer dependencies/adapters for full external frameworks instead of vendoring them.
3. Reuse only small, clearly useful permissively licensed components where doing so materially reduces risk or duplication.
4. Preserve copyright/license notices when code is copied or substantially adapted.
5. Maintain `THIRD_PARTY_NOTICES.md` as soon as the repository incorporates third-party code.
6. Keep GPL implementation code out of a permissively licensed core unless the entire licensing decision is deliberately revisited.
7. Public API behavior, papers, documentation and architecture concepts can inform design without pretending proprietary source code was obtained.

## What should not become a dependency

The core should not require:

- Hermes;
- OpenClaw;
- Microsoft Agent Framework;
- OpenAI Agents SDK;
- Google ADK;
- LangGraph;
- CrewAI;
- Agno;
- a vector database;
- Redis;
- Kubernetes;
- a cloud control plane;
- one model provider.

Those systems should integrate through adapters where valuable.

## Core dependencies should stay boring

The ideal local install requires only:

- one supported language runtime;
- schema validation;
- SQLite or equivalent local derived store;
- local HTTP/WebSocket/SSE transport;
- host runtime adapter.

Everything else is optional.

## Implementation priority

### Tier 1: implement directly

1. Bot registry and manifests.
2. Worker/run identity.
3. Room message hub.
4. Task, Message, Artifact and Event models.
5. Coordination Gateway.
6. permission/capability lease engine.
7. budget and loop controls.
8. single, manager, handoff, parallel and room topologies.
9. context packet builder.
10. event-driven observability.

### Tier 2: standards and native integration

1. A2A adapter.
2. AI-Verse OS installer.
3. Memory/Brain/Skills/Dashboard contracts.
4. restart/checkpoint handling.
5. evaluation harness.

### Tier 3: external runtime adapters

1. Hermes.
2. OpenClaw.
3. generic CLI runtime.
4. OpenAI Agents SDK.
5. Google ADK.
6. Microsoft Agent Framework.
7. other frameworks only when a real use case exists.

## Final adoption rule

> **Take Grok's squad intelligence, Hermes' teammate experience, Microsoft's topology discipline, OpenAI's ownership semantics, OpenClaw's isolation, AgentScope's message-hub model, Pydantic AI's typed delegation, and A2A's interoperability. Do not inherit any one framework's entire platform boundary.**