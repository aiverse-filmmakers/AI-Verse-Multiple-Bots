# AI-Verse Multiple Bots Reference Adoption Map

**Snapshot:** 2026-09-09

This document turns the research benchmark into implementation policy.

AI-Verse Multiple Bots should not fork one framework and rename it. The target is an independent Persistent Teammate Layer with a narrow coordination core, open interoperability boundaries, and adapters for existing runtimes.

## Adoption categories

- **ADOPT**: make the concept a first-class AI-Verse primitive.
- **ADAPT**: preserve the useful idea but redesign it for AI-Verse boundaries.
- **ADAPTER**: integrate with the framework instead of absorbing it.
- **STUDY**: use as an implementation reference only.
- **AVOID**: deliberately do not copy the architectural choice.

## Reference map

| Reference | Strongest idea | AI-Verse decision | Priority | Notes |
|---|---|---|---|---|
| **xAI Grok Bot** | Persistent named job-owning teammates, shared work environment, async Bot messaging, groups/threads, handoffs, Skills/Routines, approvals, attention-based UX | **ADOPT + ADAPT** | **Critical** | Primary product benchmark. Preserve the teammate model, but keep AI-Verse source-of-truth boundaries, model/runtime neutrality and configurable execution isolation. |
| **xAI Grok Multi-Agent** | Leader plus parallel task-scoped agents and one synthesized result | **ADAPT** | **Critical** | Use as the inner dynamic-squad topology for difficult tasks, not as the whole persistent Bot product. Squad size should be task-dependent rather than fixed. |
| **Hermes Bot Mode** | Durable named profiles, canonical DMs, rooms, mentions, pass behavior, routines and cross-machine teammates | **ADAPT + ADAPTER** | **Critical** | Strong open persistent-Bot reference. Move canonical orchestration to the backend Gateway rather than a desktop/UI lifecycle. |
| **Microsoft Agent Framework** | Sequential, concurrent, handoff, group-chat and manager/Magentic orchestration as separate patterns | **ADOPT + ADAPTER** | **Critical** | Validates topology as a first-class choice rather than one universal swarm loop. |
| **A2A 1.0** | AgentCard, Task, Message, Artifact, streaming, push, cancellation and opaque remote-agent interoperability | **ADOPT + ADAPTER** | **Critical** | Preferred external agent-to-agent boundary. Native local protocol can be smaller but should map cleanly to A2A. |
| **OpenAI Agents SDK** | Clean distinction between manager-owned specialists and handoffs | **ADOPT + ADAPTER** | **Critical** | Delegation and handoff must have different lifecycle/ownership semantics. |
| **OpenClaw** | Per-agent workspace, auth, state, session and channel isolation | **ADAPT + ADAPTER** | High | Preserve isolation discipline without turning Multiple Bots into another omnichannel gateway. |
| **AgentScope** | MsgHub abstraction, dynamic participants and distributed agents | **ADAPT** | High | Rooms should be real message hubs with delivery semantics, not shared prompt concatenation. |
| **Pydantic AI** | Typed delegation, dependency injection, usage accounting, cancellation and controlled history transfer | **ADAPT** | High | Use typed schemas and explicit context packets across every adapter. |
| **Google ADK** | Transfer-oriented routing plus sequential/parallel/loop graph workflows | **STUDY + ADAPTER** | High | Explicit transfer reason is valuable for preventing ping-pong handoffs. |
| **LangGraph** | Graph workflows, supervisors, handoffs and checkpointing | **STUDY + ADAPTER** | Medium | Useful implementation reference. Avoid magical supervisor semantics and uncontrolled shared-state propagation. |
| **CrewAI** | Autonomous crews wrapped in controlled Flows | **STUDY** | Medium | Reinforces deterministic outer control around open-ended agents. |
| **Agno** | Teams, workflow runtime and observability | **STUDY** | Medium | Strong platform reference, but too broad to become AI-Verse's core dependency. |
| **CAMEL** | Workforce and role-specialized agent collaboration | **STUDY** | Medium | Useful for experiments/dynamic roles, not as the universal runtime contract. |
| **MetaGPT** | SOP-driven multi-role organization | **STUDY** | Medium | Procedure belongs in AI-Verse Skills/Brain rather than hard-coded software-company roles. |
| **ClawSwarm** | Sidecar scheduler adding shared group chat above OpenClaw | **STUDY** | Medium | Strong proof of sidecar coordination architecture. GPL-3.0 means implementation code should stay out of a permissive core unless licensing strategy changes. |
| **ClawTeam and related projects** | Leader task split, inbox/broadcast, dependencies and isolated work areas | **STUDY** | Medium | Useful pattern references after project-by-project maturity/license review. |

## 1. What to adopt from Grok Bot

Grok Bot should shape the **outer persistent teammate product**.

### Persistent teammate as the primary object

The user's main unit is not a disposable conversation. It is a stable coworker with:

- name;
- job/mission;
- durable responsibility;
- direct conversation;
- role-scoped context;
- tools;
- execution environment;
- current state;
- recurring responsibilities;
- approval boundaries.

AI-Verse should adopt this directly.

### Small focused roster

Create a durable Bot when a responsibility deserves a long-lived owner.

Do not create a permanent Bot for every temporary specialist thought.

Temporary expertise belongs in Workers.

### Work in real tools

A Bot should be able to execute through:

- APIs/connectors;
- browser automation;
- computer use;
- filesystem;
- terminal/process tools;
- host Skills/operator packs.

Multiple Bots coordinates access. It does not become the tool implementation layer.

### Async peer communication

Bots need durable mailbox semantics so one Bot can wake another and receive a later response without both being inside one synchronous model loop.

### Rooms and Threads

Persistent team collaboration should include:

- group Rooms;
- `@mentions`;
- focused Threads;
- Artifact sharing;
- explicit work ownership;
- Bot-to-Bot handoff.

### Progressive autonomy

Preserve the workflow:

```text
perform once
  -> verify
  -> capture reusable method
  -> promote as Skill
  -> bind Automation/Routine
```

AI-Verse improves the architecture by leaving reusable method ownership in Skills and trigger/schedule ownership in Automations.

### Attention rather than surveillance

Expose concise human states:

```text
working
needs_input
needs_approval
handoff_waiting
unread_result
failed
```

Full traces remain secondary and inspectable.

## 2. What to improve beyond Grok Bot

### Configurable execution isolation

Grok Bot's shared user computer makes collaboration easy but does not create a Bot-level security boundary.

AI-Verse supports first-class policies:

```text
shared_workspace
isolated_bot
isolated_run
external_managed
```

The host decides the environment policy. The model cannot promote itself into a broader environment.

### Local-first and runtime-neutral

Do not require one cloud platform or model provider.

Support local runtimes and remote/cloud adapters.

### Explicit canonical ownership

Grok-like role memory must not duplicate AI-Verse OS/Memory truth.

A Bot receives a role-scoped retrieval view rather than owning another full user/workspace truth tree.

### Explicit leases

Tool/environment authority is granted through task-scoped capability and environment leases.

### Open remote interoperability

Use A2A at the external agent boundary instead of creating a proprietary-only peer protocol.

### Measured multi-agent use

Do not assume more agents are better. Use a collaboration gate and record topology performance.

## 3. What to adopt from Grok Multi-Agent

Grok Multi-Agent should shape the **inner temporary squad execution pattern**.

Adopt:

- leader-owned synthesis;
- parallel independent research/work;
- task-scoped Workers;
- selective cross-check/follow-up;
- one coherent final result.

Improve with:

- task-dependent Worker count;
- model/provider diversity when useful;
- explicit output contracts;
- immutable constraints;
- workspace/capability leases;
- cancellation;
- verifier stage;
- cost/time budgets;
- evidence-weighted synthesis;
- preserved disagreement.

Avoid:

- forcing 4 or 16 agents everywhere;
- fan-out for simple tasks;
- assuming majority vote equals truth;
- coupling all Workers to one provider/runtime.

## 4. What to adopt from Hermes

Hermes is one of the strongest open references for persistent named Bots.

Adopt:

- durable named Bot profiles;
- one stable direct chat per Bot;
- group Rooms;
- mentions;
- pass behavior;
- bounded discussion;
- user escalation;
- remote/cross-machine teammates;
- ability for one Bot to belong to several Rooms.

Redesign:

- canonical Room engine lives in backend Gateway;
- push delivery is primary;
- one canonical Room event stream;
- same behavior through desktop/web/CLI/channels;
- explicit local/remote identity resolution;
- deterministic mention/speaker tests;
- unresolved mentions become visible events;
- runtime/model configuration has one normalized contract.

Avoid:

- desktop-owned orchestration;
- long polling as normal Bot-to-Bot transport;
- separate UI surfaces implementing different coordination semantics;
- configuration drift between DM and Room execution paths.

## 5. What Microsoft Agent Framework validates

Use topology as an explicit strategy:

```text
single
manager
handoff
parallel_panel
group_room
pipeline
review
dynamic_squad
hybrid
```

The Bot roster remains stable while the topology changes per task.

This is more robust than treating every multi-agent run as a generic swarm.

## 6. What OpenAI Agents SDK validates

### Delegation

Caller retains ownership:

```text
A asks B for bounded work
B returns result
A owns final response
```

### Handoff

Ownership transfers:

```text
A requests transfer to B
B accepts
B becomes active owner
```

Use different protocol commands, state transitions and context contracts for these operations.

## 7. What A2A should standardize

Do not reinvent remote-agent concepts A2A already covers:

- capability/discovery cards;
- Tasks;
- Messages;
- Artifacts;
- Parts;
- status/progress;
- streaming;
- push notifications;
- cancellation;
- authentication declaration;
- extensions.

AI-Verse-specific workspace and lease metadata should use namespaced extensions rather than changing A2A core semantics.

## 8. What OpenClaw should teach the isolation model

Collaboration is not permission sharing.

Keep separate:

- runtime profile;
- model policy;
- credentials;
- filesystem scope;
- sessions;
- channel bindings;
- connection grants.

When agents collaborate, effective authority is narrowed to the current task lease.

Do not merge credentials merely because two Bots are teammates.

## 9. What AgentScope should teach Rooms

Bad Room implementation:

```text
concatenate every transcript
send everything to every agent
hope the model infers who should speak
```

Target Room implementation:

```text
accepted Room event
  -> Gateway resolves eligible members
  -> speaker policy selects recipients
  -> each recipient receives scoped context packet
  -> recipient replies / passes / delegates / hands off / publishes Artifact
  -> Gateway appends canonical event
  -> subscribers receive push update
```

## 10. What Pydantic AI should teach adapters

Cross-agent work should be typed and validated.

Every adapter must preserve:

- identity;
- workspace;
- objective;
- immutable constraints;
- expected output contract;
- capability lease;
- cancellation;
- usage/budget accounting;
- Artifact result semantics.

Do not reduce the normalized protocol to a generic prompt string if the target runtime can preserve structure.

## 11. Lessons from LangGraph and supervisor frameworks

Keep:

- checkpointable workflows;
- resumability;
- graph execution;
- explicit handoff nodes;
- supervisor/manager roles where useful.

Design against:

- constraints dropped during reformulation;
- fake parallelism;
- incompatible history transfer;
- uncontrolled shared mutable state;
- supervisor accepting a result that no longer satisfies the original Task.

AI-Verse uses root objective IDs, immutable constraint sets, typed Artifacts, explicit ownership and verification to reduce these failures.

## 12. What not to use as the base

### Unofficial `grok-bot-app/grok-bot`

The public repository using this name explicitly identifies itself as an unofficial community guide/reimplementation rather than xAI source.

Its small example orchestrator routes an unstructured string from one Bot to another and includes a placeholder approval flow. It is useful as a conceptual demo, not as a production architecture base.

### No single framework wholesale

Do not make any of these the required core:

- Hermes;
- OpenClaw;
- Microsoft Agent Framework;
- OpenAI Agents SDK;
- Google ADK;
- LangGraph;
- CrewAI;
- Agno;
- CAMEL;
- MetaGPT.

Adapters may use them when the host already does.

## 13. Licensing and code-reuse policy

Verified during this architecture phase:

- Hermes Agent: MIT;
- Microsoft Agent Framework: MIT;
- OpenAI Agents SDK: MIT;
- OpenClaw: MIT;
- A2A: Apache-2.0;
- ClawSwarm: GPL-3.0 based on repository metadata/documentation reviewed during research.

Before copying code from any project, verify the current license again at implementation time.

Recommended policy:

1. Build the AI-Verse coordination core independently.
2. Prefer adapters/dependencies to vendoring full frameworks.
3. Reuse permissively licensed components only where they materially reduce risk/duplication.
4. Preserve required copyright and license notices.
5. Add `THIRD_PARTY_NOTICES.md` when implementation actually incorporates third-party code.
6. Keep GPL implementation code outside a permissively licensed core unless the licensing strategy is intentionally changed.
7. Product behavior, public API contracts, papers and documentation can inform design without implying access to proprietary source.

## 14. Core dependencies should remain minimal

The normal local install should not require:

- Redis;
- Kubernetes;
- a vector database;
- one model vendor;
- one cloud control plane;
- one external orchestration framework.

A practical core can rely on:

- one supported language runtime;
- schema validation;
- SQLite or equivalent local derived store;
- append-first durable coordination records;
- local HTTP/WebSocket/SSE or equivalent transport;
- one host runtime adapter.

## 15. Implementation priority

### Tier 1: implement directly

1. durable Bot registry;
2. stable Bot conversation;
3. Room + Thread event hub;
4. async peer delivery queue;
5. Task/Message/Artifact/Event contracts;
6. Coordination Gateway;
7. ownership and handoff state;
8. capability/environment leases;
9. approval/policy hooks;
10. presence/attention events;
11. loop/budget/cancellation controls;
12. context packet builder.

### Tier 2: orchestration

1. delegation;
2. handoff;
3. manager;
4. parallel panel;
5. group scheduler;
6. pipeline;
7. review/verifier;
8. dynamic squad;
9. collaboration gate.

### Tier 3: native AI-Verse integration

1. OS installer/registry;
2. workspace resolver;
3. Brain Team Run boundary;
4. Skills references;
5. Memory/write-back candidates;
6. Automation/Routine binding;
7. Dashboard event projection.

### Tier 4: interoperability

1. A2A;
2. Hermes;
3. OpenClaw;
4. generic CLI processes;
5. optional framework-specific adapters.

## Final adoption rule

> **Use Grok Bot for the persistent teammate product model, Grok Multi-Agent for temporary squad intelligence, Hermes for open persistent-Bot interaction patterns, Microsoft for topology discipline, OpenAI for ownership semantics, OpenClaw for isolation lessons, AgentScope for message-hub design, Pydantic AI for typed delegation, and A2A for interoperability. Build the AI-Verse coordination core independently rather than inheriting any one platform's entire boundary.**
