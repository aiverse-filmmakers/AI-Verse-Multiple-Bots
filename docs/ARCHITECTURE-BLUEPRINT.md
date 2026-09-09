# AI-Verse Multiple Bots Architecture Blueprint

**Status:** Architecture proposal

**Snapshot:** 2026-09-09

## 1. Purpose

AI-Verse Multiple Bots is a coordination substrate for running several AI agents as a coherent team.

It must support two very different experiences without conflating them:

1. **Persistent teammates:** named Bots that have stable identity, direct chats, room memberships, model/runtime choices and long-lived responsibility.
2. **Task-scoped collective intelligence:** temporary Workers that are spawned for parallel research, review, testing, critique or decomposition and disappear after the run.

The architecture must work natively with AI-Verse OS but remain portable enough to sit above Hermes, OpenClaw, OpenAI Agents, Google ADK, Microsoft Agent Framework, CLI agents, A2A peers, and future runtimes.

## 2. Non-goals

This repository must not become:

- a replacement for AI-Verse OS;
- a second workspace filesystem;
- a long-term user-memory system;
- a skill marketplace;
- a strategy/planning brain;
- an automation scheduler;
- a dashboard that happens to contain orchestration logic;
- a model provider;
- an IDE;
- a secret manager.

It coordinates agents. Other layers remain authoritative for their own domains.

## 3. Architectural laws

### Law 1: coordination is a separate layer

Agent logic and coordination logic are different concerns.

A Bot can remain the same while the topology changes from single-agent to handoff, manager, parallel panel, group room or pipeline.

### Law 2: Bot is not Worker

Durable identity and temporary delegation are separate primitives.

### Law 3: scope is trusted runtime state

Workspace identity, filesystem roots, credentials and permissions never come from model-authored text.

### Law 4: delegation cannot escalate authority

A delegated task receives a scoped capability lease. It cannot gain permissions simply because a more powerful Bot exists.

### Law 5: messages are not truth

A message can contain claims. It does not become canonical knowledge or memory merely because another Bot said it.

### Law 6: rooms are event streams

A group room is a coordination context backed by a real event log and delivery rules, not by concatenating a giant shared prompt.

### Law 7: no UI owns orchestration

Desktop, web, Telegram, Discord, AI-Verse Dashboard and CLI are clients of the same gateway.

### Law 8: multi-agent must justify itself

The system should use the smallest sufficient topology.

### Law 9: internal reasoning remains internal

The collaboration protocol transports explicit messages, evidence, task status, tool receipts and artifacts, not raw private chain-of-thought.

### Law 10: everything consequential is traceable

Every handoff, task creation, tool lease, artifact publication, approval, cancellation and final synthesis must have a machine-readable event.

## 4. System overview

```text
+-------------------------------------------------------------------+
|                              Clients                              |
| Dashboard | Desktop | CLI | Telegram | Discord | REST | Webhooks |
+-------------------------------+-----------------------------------+
                                |
                                v
+-------------------------------------------------------------------+
|                     Coordination Gateway                          |
|                                                                   |
| Identity | Registry | Router | Orchestrator | Policy | Budgets    |
| Tasks    | Rooms    | Event Bus | Presence   | Tracing | Adapters |
+----------------------+---------------------+-----------------------+
                       |                     |
             local/native runners       remote transports
                       |                     |
          +------------+----------+          +----------------------+
          |            |          |          |                      |
       AI-Verse     Hermes    OpenClaw      A2A              Generic CLI
       runtime      adapter    adapter       peers               agents
          |            |          |          |                      |
          +------------+----------+----------+----------------------+
                                |
                                v
                      Models, tools, skills
```

## 5. Core primitives

### 5.1 Bot

A durable named agent identity.

Recommended manifest fields:

```yaml
schema_version: "1.0"
id: research-lead
name: Research Lead
status: active
kind: durable

description: >
  Leads evidence-heavy research and synthesizes findings.

runtime:
  adapter: native
  profile_ref: null

model_policy:
  preferred: null
  fallbacks: []
  allow_runtime_default: true

scope:
  workspace_mode: bound
  workspace_id: null

capabilities:
  skill_refs: []
  tool_refs: []

permissions:
  policy_ref: default-bot
  allowed_peers: ["*"]
  can_create_workers: true
  can_create_bots: false
  can_handoff: true

memory:
  adapter: host
  write_policy: explicit

coordination:
  default_mode: direct
  max_parallel_workers: 4
  max_hops: 6

ui:
  avatar: null
  hidden: false
```

The manifest references host capabilities. It does not copy workspace truth or skill content.

### 5.2 Worker

Ephemeral execution identity.

A Worker should have:

- run-scoped ID;
- parent Bot or leader;
- generated or selected role;
- task assignment;
- model selection;
- capability lease;
- context packet;
- output contract;
- deadline;
- budget;
- no durable room membership;
- no automatic long-term memory writes.

Example ID:

```text
run_01J.../worker/source-auditor-2
```

### 5.3 Room

A durable shared coordination context for Bots.

Recommended manifest:

```yaml
schema_version: "1.0"
id: product-council
name: Product Council
status: active

scope:
  workspace_id: product-x

members:
  - product-lead
  - researcher
  - operator

orchestration:
  mode: conversational
  speaker_policy: selective
  leader: null
  max_rounds_per_user_turn: 3
  max_bot_messages_per_user_turn: 10
  allow_member_mentions: true
  allow_user_escalation: true

context:
  history_policy: summarized
  max_recent_messages: 30

budget:
  token_limit_per_turn: null
  cost_limit_per_turn: null
  wall_clock_seconds: 300
```

A Bot may belong to many rooms.

### 5.4 Team Run

A bounded multi-agent execution.

A Team Run is not necessarily a visible room.

Examples:

- 4 researchers investigate separate dimensions in parallel;
- 3 coders generate alternatives, then one verifier tests them;
- planner delegates tasks to two existing Bots and three temporary Workers;
- a leader creates a dynamic squad for one request.

Lifecycle:

```text
created
  -> planning
  -> running
  -> waiting_input | waiting_approval
  -> synthesizing
  -> verifying
  -> completed | failed | canceled | budget_exhausted
```

### 5.5 Task

A delegated unit of work with explicit lifecycle.

Task fields should include:

- task ID;
- parent task ID;
- root objective ID;
- creator;
- assignee;
- workspace scope;
- objective;
- immutable required constraints;
- optional guidance;
- expected output schema;
- referenced artifacts;
- capability lease;
- budget;
- deadline;
- status;
- progress summary;
- result artifacts;
- failure information.

### 5.6 Message

A conversational event.

Messages can exist in:

- operator <-> Bot DM;
- Bot <-> Bot DM;
- Room;
- task clarification channel.

Messages should not be used as the only representation of task results.

### 5.7 Artifact

An output handle.

Artifacts may represent:

- Markdown;
- code patch;
- file;
- report;
- dataset;
- image;
- URL;
- structured JSON;
- test result;
- diff;
- evidence bundle.

The coordination layer stores artifact metadata and references. Canonical content may live in the host OS or external system.

### 5.8 Event

Immutable coordination state transition.

Examples:

```text
bot.created
room.member_added
message.sent
task.created
task.assigned
task.started
task.progress
task.artifact_published
handoff.requested
handoff.accepted
approval.requested
approval.granted
run.budget_warning
run.canceled
run.completed
```

Events power observability and replay.

## 6. Storage model

The system should use **append-first durable coordination logs + rebuildable indexes**.

### Native AI-Verse OS mode

```text
agents/bots/
├── registry.yaml
├── bots/
│   └── <bot-id>.yaml
├── rooms/
│   └── <room-id>.yaml
├── conversations/
│   ├── dm/
│   └── rooms/
├── runs/
│   └── <run-id>/
└── policies/

runtime/ai-verse-bots/
├── coordination.db
├── sockets/
├── cache/
├── indexes/
└── traces/
```

### Canonical vs derived

Canonical coordination state:

- Bot manifests;
- Room manifests;
- append-only conversation/event records;
- Team Run receipts when retention requires durability.

Derived:

- SQLite indexes;
- search indexes;
- presence cache;
- UI projections;
- graph layouts;
- cost summaries that can be recomputed from receipts.

If `runtime/ai-verse-bots/` is deleted, the important coordination history must remain reconstructable.

## 7. Coordination Gateway

The Gateway is the authoritative backend for this repository.

Recommended responsibilities:

### 7.1 Identity service

- resolve Bot IDs and aliases;
- prevent ambiguous handles;
- preserve provenance of Bot creation;
- support same-name Bots on different machines by globally unique IDs;
- resolve `@mention` handles.

### 7.2 Registry service

- load Bot/Room manifests;
- validate schemas;
- expose capability metadata;
- hot-reload safe manifest changes;
- keep runtime connection state separate from static config.

### 7.3 Router

Routes:

- operator messages to Bots;
- Bot-to-Bot DMs;
- room messages;
- task assignments;
- handoffs;
- A2A requests;
- runtime events back to subscribers.

### 7.4 Orchestrator

Executes collaboration topologies.

### 7.5 Policy engine

Checks:

- workspace access;
- peer access;
- tool/capability lease;
- cross-workspace transfer;
- destructive action approval;
- external network policy;
- agent creation;
- model/cost policy.

### 7.6 Budget manager

Tracks:

- tokens;
- model cost;
- tool cost;
- message count;
- worker count;
- wall-clock time;
- recursive depth;
- hop count.

### 7.7 Event bus

Pushes state transitions to:

- clients;
- Dashboard;
- logs;
- metrics;
- automation callbacks;
- optional remote subscribers.

## 8. Transport design

### 8.1 Local transport

Preferred:

- Unix domain socket on macOS/Linux where practical;
- localhost HTTP/WebSocket as portable default;
- named pipes or localhost on Windows.

### 8.2 Client event delivery

Use:

- WebSocket for bidirectional interactive clients;
- SSE for simple read-only streaming;
- webhooks for asynchronous server-to-server callbacks.

Do not make polling the primary room-turn mechanism.

### 8.3 Remote Bot transport

Support two modes:

1. Gateway-to-Gateway native protocol for trusted AI-Verse installations.
2. A2A 1.0 for framework-neutral or opaque remote agents.

### 8.4 A2A mapping

AI-Verse native concept -> A2A:

| AI-Verse | A2A |
|---|---|
| Bot capability card | AgentCard |
| delegated Task | Task |
| conversational exchange | Message |
| output reference | Artifact |
| content component | Part |
| task update stream | streaming response |
| async callback | push notification |

AI-Verse-specific fields should be transported through a namespaced A2A extension when needed rather than forking the standard.

## 9. Orchestration pattern interface

Each topology should implement the same high-level interface:

```text
plan(input, context, policy) -> ExecutionPlan
start(plan) -> TeamRun
handle_event(event) -> state transition
cancel(run_id)
resume(run_id, input?)
```

### 9.1 Single Agent

Use when no collaboration benefit is predicted.

### 9.2 Manager

```text
user -> manager
manager -> specialist A
manager <- result A
manager -> specialist B
manager <- result B
manager -> final
```

Leader owns final output.

### 9.3 Handoff

```text
user -> triage -> specialist
                    |
                    -> user
```

Control transfers.

Mandatory handoff fields:

- reason;
- objective;
- immutable constraints;
- context selection;
- expected result;
- return policy.

### 9.4 Parallel panel

```text
              +-> worker A -+
request -> fan+-> worker B -+-> aggregator
              +-> worker C -+
```

Workers should start from sufficiently independent context to preserve diversity.

### 9.5 Grok-style dynamic squad

Stages:

1. classify task;
2. leader identifies dimensions;
3. choose Workers;
4. fan out;
5. collect structured results;
6. identify conflicts/gaps;
7. selectively request critique/follow-up;
8. synthesize;
9. verify;
10. return final.

Do not force all workers to debate every answer. That can destroy useful independence.

### 9.6 Group room

A visible shared conversation among durable Bots.

Speaker scheduling:

1. explicit `@mentions` get priority;
2. otherwise relevance selector nominates zero or more members;
3. each nominated Bot can answer or pass;
4. new `@mentions` can enqueue a continuation;
5. stop on silence, no-progress, cap, user escalation or budget exhaustion.

### 9.7 Pipeline

Useful when ordered transformations matter.

Example:

```text
research -> draft -> fact-check -> legal review -> final editor
```

Each step has a typed artifact contract.

### 9.8 Reviewer / adversarial verification

A reviewer receives:

- original objective;
- immutable constraints;
- candidate artifact;
- evidence references;
- failure criteria.

Reviewer returns findings, not a rewritten answer unless asked.

## 10. Collaboration gate

Before using several agents, a lightweight gate chooses topology.

Inputs:

- task type;
- estimated difficulty;
- decomposability;
- need for independent evidence;
- need for domain specialists;
- failure cost;
- available Bots;
- model strength;
- budget;
- latency tolerance.

Possible output:

```yaml
decision: multi_agent
pattern: parallel_panel
reason: "Independent source verification materially improves confidence"
participants: 3
reviewer: true
budget_class: medium
```

### Default heuristics

Prefer single agent when:

- task is simple;
- no independent verification is needed;
- one Bot already has the correct specialist capabilities;
- latency or budget is tight.

Prefer parallel panel when:

- broad research is needed;
- multiple independent solutions are useful;
- source diversity matters.

Prefer manager when:

- one agent must own coherence;
- multiple specialists provide bounded contributions.

Prefer handoff when:

- one specialist should become the primary conversational owner.

Prefer group room when:

- the persistent team needs visible discussion and operator steering.

## 11. Context packets

Every agent turn should receive a generated Context Packet rather than indiscriminate global history.

Suggested structure:

```yaml
objective:
  id: obj_...
  text: "..."

assignment:
  task_id: task_...
  text: "..."

constraints:
  required: []
  optional: []

scope:
  workspace_id: example

participants:
  self: research-bot
  leader: lead-bot
  peers: [critic-bot]

recent_messages: []
artifact_refs: []
source_refs: []

permissions:
  lease_id: lease_...

output_contract:
  type: structured_result
  schema_ref: result-v1

budget:
  remaining_tokens: null
  remaining_seconds: 120
```

### Context precedence

1. runtime/system policy;
2. workspace/current canonical context;
3. settled decisions;
4. task immutable constraints;
5. Bot role instructions;
6. selected collaboration history;
7. untrusted external content.

Peer messages never outrank runtime policy or canonical decisions.

## 12. Delegation envelope

A Bot-to-Bot task request should be structured.

```json
{
  "schema_version": "1.0",
  "type": "task.delegate",
  "id": "msg_...",
  "correlation_id": "corr_...",
  "sender": "research-lead",
  "recipient": "source-auditor",
  "workspace_id": "project-x",
  "root_objective_id": "obj_...",
  "task_id": "task_...",
  "reason": "Verify the three highest-impact claims independently.",
  "objective": "Check claims A, B, and C against primary sources.",
  "required_constraints": [
    "Use primary sources where available",
    "Do not modify project files"
  ],
  "expected_output": {
    "type": "claim_verification_report"
  },
  "artifact_refs": ["artifact_..."],
  "lease_id": "lease_...",
  "hop": 2,
  "max_hops": 6,
  "deadline": null
}
```

## 13. Permission model

### 13.1 Capability lease

Every delegated execution receives a signed/logged lease containing:

- user principal;
- initiating Bot;
- assignee;
- workspace;
- allowed tool classes;
- allowed paths/data sources;
- allowed network destinations where applicable;
- destructive-action policy;
- expiry;
- task ID.

### 13.2 Intersection rule

Effective permission =

```text
host policy
INTERSECT
workspace policy
INTERSECT
Bot grants
INTERSECT
task lease
```

No union is allowed during delegation.

### 13.3 High-risk actions

Require explicit approval or a pre-existing policy for actions such as:

- deleting files;
- sending external messages;
- spending money;
- changing account permissions;
- publishing publicly;
- secrets access;
- creating persistent agents with broad grants;
- crossing workspace boundaries.

## 14. Loop and runaway prevention

A robust Bot society needs several independent brakes.

### Hard ceilings

- `max_hops`;
- `max_depth`;
- `max_workers`;
- `max_rounds`;
- `max_messages`;
- token/cost budget;
- wall-clock deadline.

### Behavioral detectors

- repeated A->B->A handoff pattern;
- semantically duplicate message sequence;
- repeated identical tool request;
- no new artifact/evidence after N turns;
- acknowledgements without progress;
- same unresolved question repeated.

### Escalation

When stuck:

1. summarize what was attempted;
2. state blocker;
3. preserve artifacts;
4. request operator judgment or return control to leader;
5. stop spending.

## 15. Cancellation

Cancellation must be hierarchical.

Canceling a Team Run cancels:

- pending Workers;
- active delegated Tasks;
- in-flight remote requests when supported;
- child tasks;
- follow-up critique rounds.

The engine must distinguish:

- graceful cancel;
- hard kill;
- timeout;
- budget exhaustion;
- policy block.

Partial artifacts remain traceable.

## 16. Shared artifact concurrency

Do not allow blind simultaneous writes.

Artifact mutation contract:

```text
read artifact version N
  -> produce patch against N
  -> validate current version
  -> apply if still N
  -> otherwise conflict
```

Options:

- optimistic concurrency by default;
- explicit ownership for long edits;
- file locking only where required;
- merge agent for compatible patches;
- immutable outputs for research Workers.

Parallel research should normally publish separate immutable artifacts, then synthesize them, rather than editing one shared report simultaneously.

## 17. Room history model

The room has one canonical coordination event stream.

Each Bot receives a **view** of that stream, not an independently authoritative copy.

This avoids a Hermes-like risk where each member can accumulate divergent room state.

A participant session may maintain a local compacted context cache, but the room event log remains authoritative for who said what and when.

### Compaction

For long rooms:

```text
recent raw messages
+ pinned decisions
+ active tasks
+ room summary checkpoints
+ referenced artifacts
```

Do not rewrite historical events. Add summary checkpoints as derived/secondary records.

## 18. Presence and activity

Presence is ephemeral.

Suggested states:

```text
offline
idle
thinking
using_tool
waiting
blocked
waiting_user
completed_recently
```

Presence belongs in runtime/cache. It must not be stored as durable truth unless emitted as historical run events.

## 19. Model policy

Each Bot can have a model policy, but the orchestrator may also select models by task.

Example:

- cheap/fast model for routing;
- strong reasoning model for leader;
- fast search-capable models for Workers;
- specialist coding model for code tasks;
- verifier model different from generator where useful.

### Avoid false diversity

Three agents using identical model, identical context and identical prompt may produce correlated errors.

Diversity can come from:

- different source assignments;
- different roles;
- different prompts;
- different tools;
- different models;
- intentionally independent sampling.

The architecture should record what kind of diversity was actually used.

## 20. Synthesis policy

Never default to majority vote for open-ended expert tasks.

The leader should consider:

- evidence quality;
- source authority;
- specialist relevance;
- test results;
- recency;
- contradictions;
- uncertainty;
- known decision authority.

A strong specialist with evidence can outweigh several weaker opinions.

## 21. Verification

Consequential multi-agent runs should end with a verifier stage when practical.

Verifier checks:

- original objective satisfied;
- all immutable constraints preserved;
- claims supported;
- required artifacts present;
- tests passed;
- no unresolved contradictions hidden by synthesis;
- no unauthorized actions occurred;
- budget/trace complete.

The verifier can return:

```text
PASS
PASS_WITH_WARNINGS
REVISE
BLOCK
```

## 22. Learning and write-back

Multiple Bots itself should not autonomously convert conversations into user memory.

Instead it emits candidates:

```text
candidate.memory
candidate.knowledge
candidate.skill
candidate.decision
candidate.process_improvement
```

The host OS/Memory/Brain/Skills layers decide how to handle them.

This keeps coordination experience from silently becoming canonical truth.

## 23. Runtime adapter interface

Every adapter should expose a minimal normalized API:

```text
capabilities() -> AgentCapabilities
start_turn(request) -> stream<Event>
cancel(turn_id)
health()
optional create_worker(spec)
optional destroy_worker(worker_id)
```

### Normalized request

Contains:

- agent identity;
- context packet;
- allowed tools/capabilities;
- output contract;
- workspace handle;
- budget;
- cancellation token;
- trace context.

### Adapter examples

#### Native AI-Verse

Runs the host agent runtime with trusted workspace and capability injection.

#### Hermes

Maps durable Bot to Hermes profile and canonical Bot chat/isolated session APIs. AI-Verse owns cross-Bot coordination rather than relying on Hermes Desktop room scheduler.

#### OpenClaw

Maps Bot to an OpenClaw agent ID/session. Preserve OpenClaw workspace/auth boundaries.

#### OpenAI Agents

Maps manager/handoff patterns to Agents SDK when useful, while retaining AI-Verse run/task records.

#### Generic CLI

Runs a process in an explicitly scoped working directory and exchanges structured request/result files or stdio messages.

## 24. External A2A agent discovery

Remote A2A agents can be registered as external Bot endpoints.

Do not automatically trust an AgentCard.

Registration flow:

1. fetch AgentCard;
2. validate URL and TLS;
3. inspect declared skills/capabilities;
4. operator or policy approves trust;
5. pin identity/card signature where possible;
6. create local external-Bot record;
7. assign explicit permissions and workspace transfer policy.

An external agent never receives broad local filesystem access merely because it advertises a useful skill.

## 25. Security threat model

### Spoofed Bot identity

Mitigation:

- unique IDs;
- signed gateway connections;
- authenticated transports;
- UI attribution from verified identity, not message text.

### Prompt injection relayed by teammate

Mitigation:

- provenance labels survive forwarding;
- peer messages are data below runtime policy;
- untrusted source content remains marked;
- no automatic tool grant.

### Denial of wallet

Mitigation:

- budgets;
- worker caps;
- rate limits;
- fan-out approval thresholds;
- loop detectors.

### Secret leakage

Mitigation:

- secrets represented by handles;
- tool layer resolves secrets;
- redact logs;
- peer-to-peer envelopes never carry raw credentials.

### Cross-workspace exfiltration

Mitigation:

- workspace-bound rooms/tasks;
- explicit bridge operation for selected artifacts;
- server-side deny by default.

### Compromised remote agent

Mitigation:

- treat remote results as untrusted inputs;
- no local tool invocation based solely on remote text;
- verify artifacts before execution;
- per-peer permissions.

## 26. Observability contract

Every run should expose a clean activity stream without leaking private reasoning.

Example:

```text
09:42:01 run started: research-panel
09:42:02 leader created 4 worker tasks
09:42:03 source-auditor started web research
09:42:04 market-researcher started web research
09:42:12 source-auditor published 6-source evidence bundle
09:42:17 market-researcher published report
09:42:20 leader requested conflict check
09:42:27 verifier flagged 1 unsupported claim
09:42:34 leader revised synthesis
09:42:38 run completed
```

Dashboard can render this as timeline, room activity, task board or graph.

## 27. Metrics

Track per topology:

- task success;
- verifier pass rate;
- human correction rate;
- cost;
- latency;
- token use;
- worker utilization;
- duplicate work ratio;
- handoff count;
- handoff failure rate;
- context-loss incidents;
- constraint-loss incidents;
- loop prevention triggers;
- cross-agent contradiction rate;
- artifact conflict rate;
- best-agent utilization;
- single-agent counterfactual where available.

The system should learn which topologies work for which task classes, but any automatic topology policy belongs under controlled evaluation.

## 28. Evaluation harness

Before calling the system reliable, build deterministic tests for:

### Routing

- explicit mentions;
- ambiguous handles;
- nonexistent Bots;
- remote/local same-name Bot;
- disabled Bot.

### Handoffs

- reason preserved;
- constraints preserved;
- context filtered;
- loop detected;
- permission does not increase.

### Rooms

- only eligible speakers respond;
- pass works;
- silence settles;
- mention continuation works;
- cap stops correctly;
- user escalation works;
- multiple rooms per Bot remain isolated.

### Parallel runs

- tasks start concurrently;
- cancellation propagates;
- one worker failure does not corrupt others;
- aggregator receives all valid artifacts;
- timeouts handled deterministically.

### Workspace safety

- no cross-workspace leak;
- external Bot cannot request arbitrary paths;
- room binding enforced server-side.

### Budget safety

- token limit;
- cost limit;
- worker limit;
- depth limit;
- wall-clock limit.

### Recovery

- gateway restart mid-run;
- remote Bot disconnect;
- client disconnect;
- duplicate event delivery;
- resume from checkpoint.

## 29. Suggested implementation stack

Keep the protocol language-neutral, but a pragmatic first implementation can be:

### Core

- Python 3.11+ or TypeScript/Node 24+;
- SQLite WAL for local coordination index/queue;
- append-only JSONL or structured files for durable event history;
- Pydantic or Zod for schemas;
- WebSocket/SSE;
- OpenTelemetry traces;
- A2A SDK adapter.

### Why SQLite first

- local-first;
- no infrastructure dependency;
- good enough for one machine and moderate agent concurrency;
- WAL supports concurrent readers/writer patterns;
- rebuildable indexes fit AI-Verse philosophy.

### Scale path

Later optional adapters:

- Postgres;
- Redis/NATS for high-throughput event transport;
- distributed durable execution engine if real workloads justify it.

Do not require these for ordinary local AI-Verse installs.

## 30. Proposed repository layout

```text
AI-Verse-Multiple-Bots/
├── README.md
├── docs/
│   ├── RESEARCH-2026-09.md
│   ├── ARCHITECTURE-BLUEPRINT.md
│   ├── REFERENCE-ADOPTION-MAP.md
│   ├── AI-VERSE-INTEGRATION.md
│   └── COORDINATION-PROTOCOL.md
│
├── schemas/
│   ├── bot.schema.json
│   ├── room.schema.json
│   ├── message.schema.json
│   ├── task.schema.json
│   ├── artifact.schema.json
│   └── event.schema.json
│
├── templates/
│   ├── bot.yaml
│   └── room.yaml
│
├── src/
│   ├── gateway/
│   ├── registry/
│   ├── routing/
│   ├── orchestration/
│   │   ├── single/
│   │   ├── manager/
│   │   ├── handoff/
│   │   ├── parallel/
│   │   ├── room/
│   │   └── pipeline/
│   ├── policy/
│   ├── budgets/
│   ├── events/
│   ├── storage/
│   ├── context/
│   └── adapters/
│       ├── native/
│       ├── a2a/
│       ├── hermes/
│       ├── openclaw/
│       └── cli/
│
├── installers/
│   ├── install.sh
│   └── install.ps1
│
├── evals/
├── tests/
└── examples/
```

## 31. Delivery phases

### Phase 1: protocol and local substrate

- schemas;
- Bot registry;
- Room registry;
- Gateway;
- event store;
- local adapter;
- DM;
- `@mention` routing;
- task envelope;
- budgets;
- loop controls.

### Phase 2: core topologies

- manager;
- handoff;
- parallel panel;
- room scheduler;
- pipeline;
- verifier;
- collaboration gate.

### Phase 3: AI-Verse native integration

- installer;
- agents registry integration;
- workspace scope injection;
- Skills references;
- Memory candidate write-back;
- Brain team-run request contract;
- Dashboard event projection.

### Phase 4: interoperability

- A2A;
- Hermes adapter;
- OpenClaw adapter;
- generic CLI adapter;
- remote gateway federation.

### Phase 5: reliability and learning

- full eval suite;
- restart recovery;
- topology performance metrics;
- cost optimization;
- adaptive topology selection under explicit controls.

## 32. Acceptance criteria for v1

AI-Verse Multiple Bots v1 is not complete until all of these are true:

1. A user can create several durable Bots.
2. Each Bot can use a distinct model/runtime/capability set.
3. Bots can DM each other.
4. Bots can join multiple rooms.
5. Rooms work from backend APIs without any desktop app running.
6. `@mentions` route deterministically.
7. Bots can pass instead of generating filler.
8. A Bot can create bounded Workers for one run.
9. A leader can fan out work in parallel and synthesize results.
10. Handoffs preserve reason and immutable constraints.
11. Cancellation propagates.
12. Cost/token/time/hop limits are enforced centrally.
13. Delegation cannot increase permissions.
14. Workspace scope cannot be changed by model text.
15. Remote A2A agent can participate through an adapter.
16. All activity is observable as structured events.
17. Important findings can be proposed back to AI-Verse OS without becoming canonical automatically.
18. Deleting runtime indexes does not destroy durable coordination history.
19. One-agent mode remains available and is preferred when collaboration is unnecessary.
20. Evaluation proves the multi-agent topology provides value on at least the task classes it claims to improve.

## North-star architecture

> **Persistent Bot identities on the outside, bounded task-specific teams on the inside, an event-driven Coordination Gateway in the middle, explicit policy around every delegation, and no duplicate source of truth.**