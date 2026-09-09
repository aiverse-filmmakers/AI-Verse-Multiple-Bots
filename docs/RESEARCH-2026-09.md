# AI-Verse Multiple Bots Research

**Snapshot:** 2026-09-09

## Research question

What is the strongest architecture for an installable, runtime-neutral layer that gives an AI operating system durable named Bots, temporary specialist workers, visible group conversations, agent-to-agent communication, parallel research, safe delegation, and remote interoperability without creating a second source of truth?

## Executive conclusion

No single current repository solves the complete problem well.

The strongest architecture is a deliberate combination of ideas:

1. **xAI Grok Multi-Agent** for task-scoped parallel collaboration under a leader.
2. **Hermes Bot Mode** for the user experience and mental model of persistent named Bots, direct chats, group rooms, `@mentions`, cross-machine teammates, and routines.
3. **Microsoft Agent Framework** for a modern production orchestration pattern set: sequential, concurrent, handoff, group chat, and manager/Magentic coordination.
4. **A2A 1.0** for remote and framework-independent agent discovery, tasks, messages, artifacts, streaming, and asynchronous updates.
5. **OpenAI Agents SDK** for the clean semantic distinction between agents-as-tools and handoffs.
6. **OpenClaw** for strict per-agent workspace/auth/session isolation and channel bindings.
7. **AgentScope** for a message-hub abstraction and runtime-neutral multi-agent deployment.
8. **Google ADK** for transfer-oriented LLM routing plus deterministic parallel/sequential/loop workflows.
9. **CrewAI, Agno, LangGraph, Pydantic AI, CAMEL, MetaGPT, ClawSwarm and related projects** for specific patterns, failure lessons, and implementation references.

The key design decision is that **coordination must be its own architectural layer**. Agent identity, room membership, delegation, message routing, team-run state and collaboration policy belong here. Operator truth, workspace knowledge, durable historical memory, reusable capabilities, strategy, and UI do not.

## 1. xAI Grok Multi-Agent

### What xAI publicly documents

xAI currently exposes `grok-4.20-multi-agent` as a realtime multi-agent research model. The public API documentation states:

- several agents collaborate on a query;
- agents can specialize in different research aspects;
- a designated leader synthesizes the final response;
- built-in tools can be used by the agents;
- the public configurations expose 4-agent and 16-agent modes;
- only leader output and leader tool calls are exposed by default;
- sub-agent state is kept opaque, with encrypted state optionally preserved for continuation;
- all agent tokens and tool calls count toward usage;
- client-side custom tools are more restricted than on standard model variants.

Sources:

- https://docs.x.ai/developers/model-capabilities/text/multi-agent
- https://docs.x.ai/developers/models/grok-4.20-multi-agent-0309
- https://github.com/xai-org/xai-sdk-python

### Why Grok's pattern matters

Grok gets three structural ideas right:

1. **Parallelism is task-scoped.** It does not require every agent to be a permanent persona.
2. **One leader owns synthesis.** The user receives one coherent result instead of a pile of independent agent messages.
3. **Sub-agent details are not dumped into the user conversation.** Collaboration can be rich internally while the user-facing output remains controlled.

### What AI-Verse should adopt

Adopt the concept, not the proprietary implementation:

```text
request
  -> decide whether multi-agent is justified
  -> leader/planner
  -> parallel workers
  -> evidence exchange / selective critique
  -> leader synthesis
  -> optional verifier
  -> final result
```

AI-Verse should improve on the public fixed 4/16 split by making squad size task-dependent and budget-aware.

### What not to assume

The public documentation is not a description of xAI's full internal orchestration implementation. AI-Verse should call this a **Grok-style squad mode** or **leader + parallel workers pattern**, not claim to clone hidden xAI internals.

## 2. Hermes Agent Bot Mode

### Why Hermes is one of the most important references

Hermes Bot Mode is currently the strongest public example of turning multi-agent infrastructure into a product concept normal users can understand.

A Bot is simply a Hermes profile. Each profile has isolated configuration, memory, skills, credentials, model settings and history. Bot Mode adds:

- a durable roster;
- one persistent canonical Bot Chat per Bot;
- named group rooms;
- 2 to 6 Bot room membership;
- `@mentions` between Bots;
- Bot-to-Bot messaging;
- optional user escalation via `@user`;
- recurring routines attached to the responsible Bot;
- cross-machine Bot discovery and routing;
- persistent per-Bot sessions for each room;
- bounded discussion rounds and message caps.

Sources:

- https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode
- https://hermes-agent.nousresearch.com/docs/user-guide/desktop
- https://github.com/NousResearch/hermes-agent

### Hermes group-turn model

The documented group model is intentionally bounded:

- mentioned Bots are targeted first;
- if nobody is mentioned, members may respond;
- Bots can reply or pass;
- Bots can mention other Bots;
- a room settles when a full round stays silent;
- hard caps prevent endless discussion.

This is a very strong end-user behavior model.

### Hermes' current implementation lessons

The issue tracker is equally valuable because it exposes what goes wrong when the concept is attached to the wrong layer.

Recent 2026 issues show or have shown problems such as:

- group-turn latency caused by polling rather than push events;
- group engine logic living in the Electron/Desktop plugin rather than the canonical backend;
- provider/config inheritance inconsistencies between direct Bot chats and group rooms;
- local-vs-remote roster gating bugs;
- UI surface conflicts between group rooms and Bot DMs;
- separate group composer behavior drifting from the standard chat composer;
- unanswered mentions being swallowed near turn caps;
- group-room functionality not being equally available through gateway/web surfaces.

Useful references:

- https://github.com/NousResearch/hermes-agent/issues/92760
- https://github.com/NousResearch/hermes-agent/issues/89995
- https://github.com/NousResearch/hermes-agent/issues/94726
- https://github.com/NousResearch/hermes-agent/issues/101543

### AI-Verse conclusion from Hermes

**Copy the product model, move the engine down a layer.**

The roster, rooms, mentions, passing, bounded rounds, per-Bot identity and cross-machine participation are excellent concepts.

The room scheduler must live in a backend Coordination Gateway with an event stream. Desktop, web, CLI, Telegram and AI-Verse Dashboard must all be clients of the same engine.

### License

Hermes Agent currently uses the MIT License. Code reuse is possible subject to preserving the license/copyright requirements for copied substantial portions.

## 3. Microsoft Agent Framework

Microsoft Agent Framework is the modern successor path for Microsoft's AutoGen work. AutoGen itself is now documented as maintenance-mode for new development.

MAF provides a production-oriented orchestration set including:

- sequential orchestration;
- concurrent orchestration;
- handoff orchestration;
- group chat;
- Magentic/manager coordination;
- graph workflows;
- checkpointing;
- streaming;
- human-in-the-loop;
- time-travel/restartability;
- multiple model/provider support.

Sources:

- https://github.com/microsoft/agent-framework
- https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/
- https://github.com/microsoft/autogen

### Why it matters

It validates a central AI-Verse design choice: orchestration **patterns should be first-class and selectable**, rather than encoding one giant autonomous-agent loop.

### What to adopt

Use MAF as a reference for:

- orchestration interfaces;
- explicit concurrent vs sequential topology;
- checkpointable run state;
- human approval pauses;
- durable workflow execution.

AI-Verse should avoid making MAF itself the mandatory engine because the repository is meant to remain runtime-neutral and installable into existing systems.

### License

Microsoft Agent Framework currently uses MIT.

## 4. A2A 1.0

A2A is one of the most important standards for this repository.

A2A 1.0 is explicitly designed for communication between independent, potentially opaque agents that may use different frameworks, languages, vendors or machines.

Core concepts include:

- `AgentCard` for discovery and capability declaration;
- `Task` for stateful units of work;
- `Message` for communication;
- `Artifact` for outputs;
- `Part` for modality-neutral content;
- streaming task updates;
- push notifications for asynchronous tasks;
- task cancellation;
- authentication declarations;
- protocol extensions;
- HTTP/REST, JSON-RPC and gRPC bindings.

Sources:

- https://github.com/a2aproject/A2A
- https://a2a-protocol.org/v1.0.0/specification

### The most useful A2A principle

A2A explicitly separates **Messages** from **Artifacts** and **Tasks**.

This solves a major problem in naive agent group chats where every concept is represented as another chat line. AI-Verse should follow the same separation internally even when no A2A transport is involved.

### Where to use it

Use A2A as the external agent boundary for:

- remote machines;
- opaque third-party agents;
- cross-framework Bots;
- long-running remote tasks;
- agents that should reveal capabilities without exposing their internal memory or tools.

For local Bots in one installation, use a smaller native protocol and expose an A2A adapter at the boundary.

### License

A2A currently uses Apache-2.0.

## 5. OpenAI Agents SDK

The OpenAI Agents SDK has a very useful semantic distinction:

### Agents as tools

A manager remains in control and asks specialists for bounded help. The specialists do not take ownership of the user conversation.

### Handoffs

The active conversation transfers to another specialist. The new agent becomes responsible for the next portion of interaction.

Sources:

- https://openai.github.io/openai-agents-python/multi_agent/
- https://openai.github.io/openai-agents-python/handoffs/
- https://openai.github.io/openai-agents-python/tools/
- https://github.com/openai/openai-agents-python

### Why this matters

Many systems misuse the word "delegate" for both behaviors. AI-Verse should never make the distinction ambiguous.

`ask_agent()` and `handoff_to_agent()` must have different lifecycle semantics.

### Useful implementation ideas

- input filters for controlling context passed during handoff;
- model-generated handoff metadata such as reason/priority;
- manager-owned final answers;
- guardrails and tracing;
- agent-as-tool composition.

### License

OpenAI Agents SDK currently uses MIT.

## 6. Google ADK

Google ADK supports LLM-driven transfer between agents and workflow agents for deterministic orchestration.

Useful concepts include:

- root agents with sub-agents;
- automatic routing based on agent descriptions;
- transfer to peer/parent controls;
- sequential workflows;
- parallel workflows;
- loop workflows;
- graph/DAG workflow execution;
- state preservation and resumption.

Sources:

- https://github.com/google/adk-python
- https://google.github.io/adk-docs/

### Important failure lesson

A recent ADK contribution highlighted a classic handoff problem: agents can ping-pong if a transfer contains no explicit reason. The proposed fix adds a `transfer_reason` field.

Reference:

- https://github.com/google/adk-python/pull/6590

AI-Verse should require a reason and constraints on every handoff from day one.

## 7. OpenClaw

OpenClaw's strongest contribution is isolation and routing rather than shared-group collaboration.

A configured agent can have its own:

- workspace;
- state directory;
- model registry;
- auth profiles;
- sessions;
- channel account bindings.

Inbound channel messages route through explicit bindings to the correct agent.

Sources:

- https://github.com/openclaw/openclaw
- https://github.com/openclaw/openclaw/blob/main/docs/concepts/multi-agent.md
- https://docs.openclaw.ai/gateway/config-agents/entries-and-multi-agent

OpenClaw also has point-to-point agent messaging.

### Limitation relevant to AI-Verse

OpenClaw historically focused on isolated agents and point-to-point communication. A request for native shared group-chat collaboration was closed as not planned, which helped create room for external projects such as ClawSwarm.

Reference:

- https://github.com/openclaw/openclaw/issues/71432

### AI-Verse lesson

Use OpenClaw's **agent isolation and binding discipline**, but make shared room collaboration a native coordination primitive in this new repository.

### License

OpenClaw currently uses MIT and tracks adapted-code notices in `THIRD_PARTY_NOTICES.md`.

## 8. ClawSwarm and OpenClaw swarm projects

`1Panel-dev/ClawSwarm` is directly relevant because it adds unified multi-agent group chat on top of OpenClaw.

It includes:

- scheduler server;
- conversation/message APIs;
- web client;
- OpenClaw channel plugin;
- group chat where agents can observe and respond to each other.

Source:

- https://github.com/1Panel-dev/ClawSwarm

### Value

It proves the sidecar/plugin architecture works: a coordination server can sit above an existing agent system without replacing the underlying agent runtime.

### Constraint

ClawSwarm is GPL-3.0. If AI-Verse intends to remain permissively licensed, do not copy GPL implementation code into the core. Study the architecture and implement independently unless the licensing strategy explicitly changes.

Other OpenClaw swarm projects such as ClawTeam also demonstrate useful point-to-point inbox, broadcast, worktree isolation, task dependencies and leader coordination.

## 9. LangGraph multi-agent patterns

LangGraph demonstrates several useful coordination shapes:

- supervisor/main-agent pattern;
- handoffs;
- routing;
- subagents as tools;
- hierarchical supervisors;
- controlled history modes;
- checkpointers and stores.

Source:

- https://github.com/langchain-ai/langgraph-supervisor-py
- https://langchain-ai.github.io/langgraph/tutorials/multi_agent/multi-agent-collaboration/

### Current lesson

The dedicated `langgraph-supervisor` helper is no longer the recommended abstraction for many cases. LangChain recommends implementing the supervisor pattern more directly with tools for better context control.

That is a strong signal for AI-Verse: **do not hide routing semantics behind a magical helper**. Keep the protocol explicit.

### Known issues worth designing against

- context/state can be lost or malformed during handoffs;
- high-level supervisor helpers are not naturally parallel;
- shared artifact synchronization is expensive and difficult;
- supervisors can accept outputs after delegation silently dropped constraints.

These are not LangGraph-only problems. They are general multi-agent failure modes.

## 10. CrewAI

CrewAI provides:

- role-based agents;
- autonomous Crews;
- hierarchical processes;
- event-driven Flows;
- multiple crews inside controlled flows.

Source:

- https://github.com/crewAIInc/crewAI

CrewAI's strongest current production recommendation is **Flow-first**: wrap autonomous crews in a controlled flow that owns state, branching and observability.

### AI-Verse lesson

This reinforces the distinction between:

- bounded deterministic coordination where code should own the flow;
- open-ended collaboration where the model can decide routing.

AI-Verse needs both.

## 11. Agno

Agno provides:

- agents;
- multi-agent Teams;
- a team leader with shared state/context;
- workflows with sequential, parallel, loop and branch execution;
- production runtime/API;
- control plane and observability.

Source:

- https://github.com/agno-agi/agno

### AI-Verse lesson

Agno is a strong example of a complete agent platform, but AI-Verse Multiple Bots must remain narrower. It should not bring its own competing knowledge, memory and control-plane ownership into AI-Verse OS.

Study the runtime contracts and team APIs, not the product boundary.

## 12. AgentScope

AgentScope is particularly relevant for its **message hub** concept.

It supports:

- flexible multi-agent message routing;
- adding/removing participants dynamically;
- broadcast;
- distributed agents;
- A2A;
- MCP;
- observability and Studio;
- local, serverless and Kubernetes deployment.

Sources:

- https://github.com/agentscope-ai/agentscope
- https://github.com/agentscope-ai/agentscope-studio

### AI-Verse lesson

A room should not be implemented as "give everybody the same prompt." It should be implemented as a real message hub with participant membership and explicit delivery semantics.

## 13. Pydantic AI

Pydantic AI documents a useful progression of complexity:

1. single agent;
2. delegation;
3. programmatic handoff;
4. graph control flow;
5. deep agents.

Source:

- https://github.com/pydantic/pydantic-ai/blob/main/docs/multi-agent-applications.md

Useful implementation lessons:

- typed dependency injection;
- usage accounting across delegates;
- cancellation propagation;
- explicit message-history transfer;
- do not casually pass incompatible tool/system history between agents.

AI-Verse should use typed schemas for all cross-Bot messages and task envelopes.

## 14. CAMEL

CAMEL is one of the major research-oriented multi-agent frameworks and includes role playing and Workforce concepts.

Sources:

- https://github.com/camel-ai/camel
- https://github.com/camel-ai/camel/tree/master/examples/workforce

Useful ideas:

- dynamic workforces;
- role specialization;
- manager selection of speakers;
- parallel team members;
- shared notes/artifacts as coordination mechanisms.

AI-Verse should avoid inheriting CAMEL's research-specific assumptions as the universal runtime contract.

## 15. MetaGPT

MetaGPT popularized an SOP-driven simulated software company:

- Product Manager;
- Architect;
- Project Manager;
- Engineer;
- standardized process artifacts.

Source:

- https://github.com/FoundationAgents/MetaGPT

### AI-Verse lesson

The key transferable idea is **structured organizational procedure**, not the software-company roles themselves.

AI-Verse Skills and Brain can supply domain-specific role bundles and process knowledge. Multiple Bots should remain neutral.

## 16. Hermes Swarm / mission-control projects

Several community projects claim Hermes swarm or mission-control functionality. They vary widely in maturity. Some are primarily dashboards or mock data; some are active orchestration servers.

The useful lesson is to validate whether a repository actually owns a working coordination backend before treating its visual UI as proof of orchestration capability.

Do not copy a dashboard that only simulates agents.

## 17. Research: more agents can make the result worse

The most important 2026 research finding for this architecture is that agent count alone is not a capability multiplier.

### Do More Agents Help? (2026)

A controlled benchmark found that most tested fixed multi-agent systems did not beat the matched single-agent baseline and often occupied worse cost/accuracy tradeoffs.

- https://arxiv.org/abs/2606.05670

### Multi-Agent Teams Hold Experts Back (2026)

This study found self-organizing agent teams can fail to exploit their best expert and instead converge toward compromise, with reported performance losses as team size grows.

- https://arxiv.org/abs/2602.01011

### Capable language models can outgrow the benefits of collaboration (2026)

Controlled experiments across multiple model families and architectures found that whether multi-agent coordination helps depends strongly on the capability of the underlying single agent and the task. Coordination can improve or degrade results.

- https://www.nature.com/articles/s42256-026-01268-y
- https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/

### Coordination as an Architectural Layer (2026)

This work argues that coordination should be modeled as a configurable architecture separate from agent logic and information access.

- https://arxiv.org/abs/2605.03310

### AI-Verse consequence

The system needs a **collaboration gate** before fan-out.

Questions the gate should ask:

- Can one strong agent solve this reliably?
- Is the task decomposable into independent work?
- Do we need source diversity?
- Is verification worth the extra compute?
- Is there a true specialist advantage?
- Is shared discussion necessary, or would parallel independent answers be better?
- What is the maximum useful team size?
- What is the budget?

The default should be the smallest sufficient topology.

## 18. Failure taxonomy AI-Verse must design against

### 18.1 Infinite or wasteful conversations

Failure:

- A hands to B;
- B sends back to A;
- room agents keep acknowledging each other;
- cost grows without progress.

Required controls:

- hop limits;
- round limits;
- message limits;
- no-progress detector;
- ping-pong detector;
- duplicate similarity detection;
- budget ceiling;
- cancellation.

### 18.2 Constraint loss during delegation

Failure:

The parent reformulates the task and accidentally drops an important constraint.

Required design:

- original objective ID;
- immutable required constraints;
- explicit delegated scope;
- expected-output schema;
- verifier checks constraints before accepting work.

### 18.3 Context explosion

Failure:

Every agent receives the entire room, all artifacts, all tool logs and all other agents' history.

Result:

- token blow-up;
- instruction leakage;
- lower relevance;
- more opportunities for prompt injection.

Required design:

- participant-specific context packets;
- references instead of full artifact copies;
- summaries for old room history;
- progressive retrieval.

### 18.4 Shared artifact conflicts

Failure:

Several agents independently edit the same artifact with no transaction or version contract.

Required design:

- artifact IDs;
- immutable versions;
- optimistic concurrency or explicit locks;
- patches/diffs instead of blind replacement;
- designated owner when appropriate.

### 18.5 Privilege laundering

Failure:

A low-privilege agent persuades a higher-privilege agent to perform an action it could not perform itself.

Required design:

- task-scoped capability leases;
- intersection-of-permissions rule;
- destination Bot permissions do not automatically transfer to the task;
- approval for privilege elevation;
- clear initiating user identity in every envelope.

### 18.6 Cross-workspace data leakage

Failure:

A Bot with access to several workspaces mixes client/project data into the wrong room.

Required design:

- server-side workspace binding;
- room workspace scope;
- deny cross-workspace by default;
- explicit selected-artifact transfer for allowed cross-workspace collaboration.

### 18.7 Prompt injection propagation

Failure:

An agent reads untrusted content and repeats malicious instructions into a trusted group where other Bots treat it as teammate instruction.

Required design:

- provenance on every content part;
- untrusted-source labels survive agent forwarding;
- peer messages do not outrank system/runtime policy;
- quoted external text is data;
- tool permissions remain policy-controlled.

### 18.8 Expert dilution

Failure:

A strong expert's correct answer is averaged with weaker opinions.

Required design:

- explicit expertise metadata;
- evidence-weighted synthesis;
- leader may prefer a specialist over majority vote;
- disagreement is preserved rather than automatically compromised.

### 18.9 UI-owned orchestration

Failure:

A desktop plugin becomes the only place the room algorithm exists.

Required design:

- backend engine owns truth;
- clients subscribe to events;
- CLI/web/mobile/channel behavior is parity by construction.

## 19. Recommended architecture synthesis

The target architecture should be:

```text
                         Clients
        Dashboard / CLI / Desktop / Telegram / API
                            |
                            v
                  Coordination Gateway
       +----------+---------+---------+----------+
       |          |         |         |          |
    Identity   Router   Orchestrator Policy   Event Bus
       |          |         |         |          |
       +----------+---------+---------+----------+
                            |
          +-----------------+------------------+
          |                 |                  |
      Local Bots       Runtime Adapters      A2A Peers
          |                 |                  |
       workers        Hermes/OpenClaw/etc   remote agents
```

Core principles:

1. durable Bots and ephemeral Workers are different primitives;
2. rooms are message hubs, not prompt concatenation;
3. manager, handoff, concurrent, pipeline and group modes are separate topologies;
4. one central event-driven backend owns coordination state;
5. no UI-specific orchestration engine;
6. A2A at remote/opaque boundaries;
7. permission intersection on delegation;
8. workspace scope enforced server-side;
9. task and artifact semantics are separate from chat;
10. collaboration is selected only when it improves the job;
11. agent internal reasoning remains private, while collaboration messages and evidence are observable;
12. important domain truth is promoted back to the host OS through explicit write contracts.

## 20. Repositories worth studying first during implementation

### Tier A: direct architecture references

- xAI multi-agent docs: https://docs.x.ai/developers/model-capabilities/text/multi-agent
- Hermes Agent: https://github.com/NousResearch/hermes-agent
- Microsoft Agent Framework: https://github.com/microsoft/agent-framework
- A2A: https://github.com/a2aproject/A2A
- OpenAI Agents SDK: https://github.com/openai/openai-agents-python
- OpenClaw: https://github.com/openclaw/openclaw
- AgentScope: https://github.com/agentscope-ai/agentscope

### Tier B: pattern references

- Google ADK: https://github.com/google/adk-python
- LangGraph Supervisor: https://github.com/langchain-ai/langgraph-supervisor-py
- CrewAI: https://github.com/crewAIInc/crewAI
- Agno: https://github.com/agno-agi/agno
- Pydantic AI: https://github.com/pydantic/pydantic-ai
- CAMEL: https://github.com/camel-ai/camel
- MetaGPT: https://github.com/FoundationAgents/MetaGPT

### Tier C: specific group/swarm implementations

- ClawSwarm: https://github.com/1Panel-dev/ClawSwarm
- related OpenClaw swarm/team projects should be studied for task queues, broadcasts, work isolation and UI patterns, but individually reviewed for maturity and license before reuse.

## Final research judgment

The best version is not "Hermes Bot Mode copied into AI-Verse" and it is not "Grok's 4/16-agent research loop copied everywhere."

The stronger design is:

> **Hermes' persistent teammate experience + Grok's task-scoped parallel squad + Microsoft's topology library + OpenAI's handoff semantics + OpenClaw's isolation + A2A interoperability + AI-Verse source-of-truth discipline.**

That combination is the architecture pursued by this repository.