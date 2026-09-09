# AI-Verse Multiple Bots: Persistent Teammate Architecture

**Status:** Canonical architecture direction

**Snapshot:** 2026-09-09

## 1. Product definition

AI-Verse Multiple Bots is an installable **Persistent Teammate Layer**.

It gives a host AI operating system a durable roster of job-owning Bots that can:

- keep one stable identity over time;
- maintain one durable direct conversation;
- receive role-scoped context from the host;
- use real tools and execution environments;
- continue work asynchronously;
- message other Bots;
- collaborate in Rooms and Threads;
- delegate bounded Tasks;
- hand off active ownership;
- share Artifacts;
- request approvals;
- receive work from schedules, events, the host Brain, the user, or peer Bots;
- create temporary Workers and dynamic squads when one agent is not enough.

The layer coordinates work. It does not replace the host OS, memory system, capability library, strategy layer, automation scheduler, or UI.

## 2. Product north star

> **A user should be able to install this layer, create a small team of persistent AI coworkers with clear jobs, and let those coworkers coordinate real work without making the user manually route every message or sacrificing the host operating system's source-of-truth boundaries.**

## 3. Architectural position

Inside AI-Verse:

```text
                       Operator
                          |
                          v
                 AI-Verse Dashboard
                interface / attention
                          |
                          v
                command + event boundary
                          |
              +-----------+-----------+
              |                       |
              v                       v
      AI-Verse Brain          AI-Verse Multiple Bots
     intent / strategy       coordination / execution
              |                       |
              +-----------+-----------+
                          |
                     AI-Verse OS
              truth / scope / policy
           +--------------+--------------+
           |              |              |
           v              v              v
        Memory          Skills       Connections
        history      capabilities      systems
                          |
                          v
                    Automations
               schedules / triggers
```

The exact repository layout may evolve, but these ownership boundaries are architectural law.

## 4. What this layer owns

Canonical coordination state:

- Bot identity and role metadata;
- Bot relationships such as optional manager/coordinator links;
- Room membership and Room configuration;
- Thread identity;
- Bot-to-Bot delivery records;
- Task delegation records;
- handoff lifecycle;
- Team Run lifecycle;
- Worker identities for active/retained runs;
- capability and environment lease references;
- approval request lifecycle;
- Artifact coordination metadata/references;
- durable coordination event streams.

Derived/runtime state:

- presence;
- current activity;
- attention projections;
- delivery caches;
- sockets;
- indexes;
- search projections;
- cost dashboards;
- graph layouts;
- transient execution traces.

## 5. What this layer does not own

It must not become canonical for:

- user/operator identity;
- workspace current truth;
- workspace knowledge;
- settled business/project decisions;
- durable historical user memory;
- strategic goals;
- reusable professional skills;
- credentials/secrets;
- automation schedules;
- external system records;
- visual UI state that can be projected from canonical coordination events.

## 6. Human-facing primitives

The user experience should stay much smaller than the internal protocol.

Recommended primary surfaces:

```text
Bots
Rooms
Work
Routines
Results
```

### Bots

Persistent coworkers with a name, role, status, current responsibility and direct conversation.

### Rooms

Shared team/project conversations among several Bots, with Threads for focused branches.

### Work

Current Tasks and Team Runs, including ownership, blockers, approvals and progress.

### Routines

Host Automations associated with a responsible Bot. The Multiple Bots layer projects responsibility but does not become the scheduler.

### Results

Artifacts, reports, files, receipts, decisions proposed for write-back and other finished outputs.

## 7. Internal primitives

### Durable

- `Bot`
- `Room`
- `Thread`
- `BotRelationship`
- `ExecutionEnvironmentReference`

### Run-scoped

- `Worker`
- `TeamRun`
- `Task`
- `CapabilityLease`
- `EnvironmentLease`
- `Approval`

### Content/state

- `Message`
- `Artifact`
- `Event`
- `Presence`
- `AttentionState`

## 8. Durable Bot contract

A Bot exists because some responsibility deserves a long-lived owner.

A Bot should minimally define:

```yaml
id: research-lead
name: Research Lead

role:
  title: Research Lead
  mission: Own evidence-heavy research and synthesis.
  responsibilities:
    - decompose broad research requests
    - verify important claims
    - return one coherent evidence-backed result
  non_responsibilities:
    - publish externally without approval

runtime:
  adapter: native

execution:
  environment_policy: shared_workspace
  environment_ref: host-default

scope:
  type: workspace
  workspace_id: example

permissions:
  policy_ref: default-bot

coordination:
  manager_id: null
  can_create_workers: true
  can_handoff: true
```

### Durable identity does not mean duplicated truth

The Bot may have role instructions, responsibility metadata, conversation history and role-scoped retrieval preferences.

It should not copy the entire operator profile, workspace context, knowledge tree or historical memory into its own competing canonical store.

## 9. Bot vs Worker

This distinction is non-negotiable.

### Bot

- durable identity;
- durable responsibility;
- stable conversation address;
- can belong to multiple Rooms;
- may own Automations/Routines by reference;
- may have role-specific memory retrieval view;
- remains after one task ends.

### Worker

- created for one Team Run or Task;
- receives one bounded assignment;
- gets a scoped capability/environment lease;
- has no default durable Room membership;
- has no automatic long-term memory write authority;
- disappears when its run is complete unless explicitly promoted.

This prevents temporary swarm roles from polluting the permanent roster.

## 10. One owner per work item

Multiple agents may contribute, but active responsibility should normally be singular.

```yaml
work_item:
  owner_id: research-lead
  collaborators:
    - source-auditor
    - reviewer
```

Ownership means responsibility for moving the work forward and returning the result.

Collaboration does not imply shared authority over every final action.

## 11. Coordination Gateway

The canonical runtime component is the **Coordination Gateway**.

```text
+----------------------------------------------------------------+
| Clients                                                        |
| Dashboard | CLI | Desktop | Mobile | Telegram | Discord | API  |
+------------------------------+---------------------------------+
                               |
                               v
+----------------------------------------------------------------+
| Coordination Gateway                                           |
|                                                                |
| Identity | Registry | Router | Tasks | Handoffs | Rooms         |
| Threads  | Runs     | Policy | Budgets | Leases | Approvals     |
| Context  | Delivery | Events | Presence | Attention | Adapters  |
+----------------------+---------------------+---------------------+
                       |                     |
                       v                     v
                 local runtimes          remote runtimes
                       |                     |
          +------------+----------+          +--------------------+
          |            |          |          |                    |
       AI-Verse     Hermes    OpenClaw      A2A              Generic CLI
```

The Gateway owns coordination semantics regardless of which UI or channel initiated the work.

## 12. Event-driven operation

Primary local delivery should use push semantics:

- WebSocket for bidirectional interactive clients;
- SSE for lightweight event subscribers;
- local socket/pipe where appropriate;
- webhooks for asynchronous system callbacks;
- A2A streaming/push for compatible remote agents.

Polling is fallback only.

A desktop application must not be required for Bots to talk to each other.

## 13. Asynchronous Bot-to-Bot delivery

Persistent teammates need mailbox semantics, not only synchronous function calls.

Recommended delivery lifecycle:

```text
queued
  -> accepted
  -> delivered
  -> processing
  -> replied
```

Terminal alternatives:

```text
expired
failed
canceled
```

This permits:

- receiving Bot temporarily busy;
- sender no longer in foreground;
- remote machine temporarily disconnected;
- user UI closed;
- response arriving later.

Every delivery uses stable IDs and idempotency keys so retries do not duplicate work.

## 14. Rooms

A Room is a durable shared coordination context for several Bots.

It has:

- one workspace scope;
- member list;
- optional leader/coordinator;
- explicit work-owner policy;
- canonical ordered event stream;
- mention routing;
- bounded speaker policy;
- Thread support;
- Artifact references;
- attention/escalation rules;
- budgets.

A Room is not created by concatenating every Bot's entire history into one prompt.

## 15. Threads

A Thread is a focused branch attached to a Message in a Bot DM or Room.

Use Threads for:

- one Artifact review;
- one approval discussion;
- one handoff;
- one blocker;
- one subproblem;
- one failure investigation.

Threads inherit parent workspace scope by default.

They prevent the permanent Room transcript from becoming noisy without requiring a new Room for every side discussion.

## 16. Speaker scheduling

Default Room scheduling:

1. explicit `@mentions` receive priority;
2. otherwise the speaker policy selects zero or more relevant members;
3. each selected Bot may reply, pass, delegate, hand off, publish an Artifact or escalate to the user;
4. new mentions can enqueue another bounded continuation;
5. a full eligible round with no substantive output settles the turn;
6. message, round, token, cost and time caps terminate runaway discussion;
7. unresolved mandatory mentions become visible events instead of being silently dropped.

Bots are allowed to pass. They should not manufacture agreement messages merely to prove they were present.

## 17. Delegation vs handoff

These are distinct protocol operations.

### Delegation

Caller remains owner.

```text
Bot A owns objective
  -> asks Bot B/Worker for bounded result
  <- receives result
Bot A remains responsible for final output
```

### Handoff

Ownership transfers.

```text
Bot A owns objective
  -> requests transfer to Bot B
Bot B accepts
  -> Bot B becomes current owner
```

Every handoff includes:

- reason;
- original/root objective;
- immutable required constraints;
- selected context;
- Artifact references;
- permission lease;
- environment lease if needed;
- return policy.

The target does not become owner until the transfer is accepted.

## 18. Dynamic squad execution

Grok Multi-Agent style fan-out belongs inside one Team Run.

```text
request
  -> collaboration gate
       |
       +-- single Bot sufficient -> execute once
       |
       +-- team justified
              -> leader creates distinct Tasks
              -> parallel Workers execute
              -> results returned as Artifacts
              -> leader identifies gaps/conflicts
              -> selective follow-up/reviewer
              -> synthesis
              -> optional verification
              -> final result
```

Workers should preserve independence when diversity is the purpose. Do not make every Worker debate every other Worker by default.

## 19. Collaboration gate

Multi-agent coordination must justify its cost.

Inputs can include:

- task difficulty;
- decomposability;
- need for independent evidence;
- need for specialist capability;
- consequence of error;
- model strength;
- available Bots;
- latency tolerance;
- cost/token budget.

Possible decisions:

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

The default is the smallest topology predicted to improve reliability or coverage.

## 20. Execution environments

The coordination layer references environments without owning the virtualization implementation.

First-class policies:

### `shared_workspace`

Trusted Bots share a workspace execution environment.

Useful for low-friction collaboration, shared files and handoffs.

### `isolated_bot`

A durable Bot gets an isolated browser/session/compute boundary.

Useful for credential separation or sensitive responsibility.

### `isolated_run`

A Team Run/Worker gets a temporary sandbox.

Useful for untrusted code, downloads, risky browser operations and disposable parallel work.

### `external_managed`

Execution lives in another runtime or machine such as Hermes, OpenClaw or an A2A peer.

The host adapter controls how each policy is implemented.

## 21. Environment lease

A Task that needs execution receives a trusted environment lease.

```yaml
id: envlease_...
issued_to: worker_source-auditor
workspace_id: product-x
task_id: task_...
environment_policy: isolated_run
environment_ref: env_...
expires_at: 2026-09-09T10:00:00Z
```

Models never invent `environment_ref` values.

## 22. Environment inspection and takeover

Computer-use adapters should expose a normalized optional contract:

```text
status()
preview()
request_takeover()
return_control()
```

This lets clients show:

- minimal current state;
- visual preview when desired;
- explicit human takeover for authentication, CAPTCHA or judgment;
- safe return of control.

The Dashboard owns the visual presentation. The runtime adapter owns the actual computer/session.

## 23. Capability and context boundaries

Capabilities and context should not be coupled.

### Broad/shared capability

Examples:

- research Skill;
- spreadsheet Skill;
- browser operator;
- Gmail connector;
- GitHub connector.

### Role/workspace-scoped context

Examples:

- current client state;
- project decisions;
- role-specific historical memories;
- current Room discussion;
- active Task constraints.

A Bot can know how to use a capability without receiving unrelated workspace context.

## 24. Context packet

Every agent turn receives a generated context packet.

```yaml
objective:
  id: obj_...
  text: "..."

assignment:
  task_id: task_...
  text: "..."

constraints:
  required: []

scope:
  workspace_id: example

participants:
  self: research-bot
  owner: research-lead
  peers: []

recent_messages: []
artifact_refs: []
source_refs: []

permissions:
  capability_lease_id: lease_...
  environment_lease_id: envlease_...

output_contract:
  type: structured_result
```

Do not broadcast all workspace knowledge, all memory or every Room event by default.

## 25. Authority precedence

Context should explicitly preserve authority:

1. runtime/system policy;
2. canonical current workspace/operator context;
3. settled decisions;
4. immutable Task constraints;
5. Bot role instructions;
6. selected Room/Thread/peer messages;
7. untrusted external content.

Peer text never outranks canonical decisions or runtime policy.

## 26. Permission model

Effective permission is:

```text
host policy
INTERSECT
workspace policy
INTERSECT
Bot grants
INTERSECT
task capability lease
```

Delegation can reduce authority. It cannot increase authority.

This prevents privilege laundering through a more powerful teammate.

## 27. Approval model

High-risk action authorization happens outside the acting model.

```text
Bot proposes action
  -> policy engine
  -> optional independent risk reviewer
  -> allow | approval_required | deny
  -> execution adapter
  -> receipt
```

Examples likely to require approval or explicit policy:

- external messages;
- public publishing;
- financial transfers/purchases;
- deletion/overwrite;
- permission changes;
- production changes;
- legal acceptance;
- broad cross-workspace transfer;
- persistent high-authority Bot creation.

## 28. Secrets

Raw credentials are not protocol content.

Bots and Workers receive handles such as:

```text
gmail:operator
github:aiverse-filmmakers
browser-session:finance
```

The tool/runtime layer resolves the handle without exposing the raw token/password to ordinary messages or traces.

## 29. Artifacts as handoff currency

Agents should share explicit Artifacts rather than rely on undocumented shared filesystem state.

Artifact metadata includes:

- creator;
- workspace;
- Task/Run;
- type/media type;
- version;
- content reference;
- digest;
- provenance;
- source references.

Parallel Workers should normally create separate immutable Artifacts. The leader synthesizes them afterward.

## 30. Mutable Artifact concurrency

When several agents may edit one Artifact:

```text
read version N
  -> produce patch against N
  -> verify current version still N
  -> apply or conflict
```

No blind last-write-wins.

Use designated ownership or locks only where necessary.

## 31. Work activation

A Bot can be activated by:

```text
user message
Brain initiative
OS Automation schedule
external event
peer Bot message
peer Bot handoff
```

All activations enter the same Gateway so permissions, workspace scope, budgets, delivery and observability behave consistently.

## 32. Skills and Routines

Multiple Bots does not duplicate AI-Verse Skills or Automations.

Recommended lifecycle:

```text
one-time task
  -> verified successful method
  -> candidate Skill
  -> Skills evaluation/promotion
  -> optional Automation binding
  -> responsible Bot shown as Routine owner
```

A future teach-by-demonstration flow can produce an action trace and proposed Skill, but the Skills layer still owns promotion and reusable procedure truth.

## 33. Presence and attention

### Presence

Ephemeral runtime state:

```text
offline
idle
thinking
using_tool
waiting
blocked
```

### Attention

Human-facing state:

```text
none
working
unread_result
needs_input
needs_approval
handoff_waiting
failed
```

Dashboard should prioritize attention over raw trace volume.

## 34. Observability

Structured events should show meaningful progress without exposing private model reasoning.

Example:

```text
09:42:01 Research Lead started competitor analysis
09:42:03 3 Workers created
09:42:04 Source Auditor began primary-source search
09:42:12 Source Auditor published evidence bundle
09:42:18 Market Worker published comparison table
09:42:22 Research Lead requested one conflict check
09:42:31 Verifier flagged one unsupported claim
09:42:37 Research Lead revised synthesis
09:42:41 Run completed
```

Full tool receipts and traces remain inspectable for audit/debugging.

## 35. Loop/runaway controls

Central hard ceilings:

- maximum hops;
- maximum recursive depth;
- maximum Workers;
- maximum messages;
- maximum Room rounds;
- token budget;
- monetary budget;
- wall-clock deadline.

Behavioral detectors:

- A -> B -> A ping-pong;
- longer routing cycles;
- duplicate Task creation;
- repeated identical tool action;
- semantic duplicate messages;
- acknowledgement-only loops;
- no new evidence/Artifact/state after N turns.

On detection:

1. stop spending;
2. preserve partial Artifacts;
3. summarize attempted work;
4. return to owner/leader or ask the user;
5. emit a visible event.

## 36. Cancellation

Cancellation propagates hierarchically.

Canceling a Team Run cancels:

- queued Workers;
- active child Tasks;
- pending follow-ups;
- remote calls where protocol supports cancellation.

Distinguish:

```text
graceful cancel
hard kill
timeout
budget exhaustion
policy block
```

## 37. Interoperability

### Native local protocol

Small, efficient coordination protocol for local AI-Verse installations.

### A2A

Preferred standard for opaque/remote/framework-independent agents.

Mapping:

| AI-Verse | A2A |
|---|---|
| external Bot card | AgentCard |
| delegated Task | Task |
| conversational exchange | Message |
| result/output | Artifact |
| content component | Part |
| progress | streaming/status updates |
| async callback | push notification |

AI-Verse-specific workspace/lease fields use namespaced extensions rather than changing A2A core semantics.

## 38. Runtime adapter interface

Every adapter should normalize to something close to:

```text
capabilities() -> AgentCapabilities
start_turn(request) -> stream<Event>
cancel(turn_id)
health()
optional create_worker(spec)
optional destroy_worker(worker_id)
optional environment_status(ref)
optional environment_preview(ref)
optional request_takeover(ref)
```

Adapters must fail explicitly when they cannot preserve required semantics safely.

## 39. Native AI-Verse storage

```text
AI-Verse-OS/
├── agents/
│   ├── registry.yaml
│   └── bots/
│       ├── registry.yaml
│       ├── bots/
│       ├── rooms/
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

### Canonical

- Bot manifests;
- Room manifests;
- retained Threads/messages/events;
- Team Run/Task receipts according to retention policy;
- policy/configuration.

### Derived/disposable

- SQLite indexes;
- search index;
- current presence;
- sockets;
- UI projections;
- transient traces/caches.

Deleting runtime indexes must not destroy important retained coordination history.

## 40. Standalone storage

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

Standalone mode can bind to the host's own memory, tool, automation and filesystem abstractions.

## 41. AI-Verse write-back

Multiple Bots can emit candidates:

```text
candidate.context_update
candidate.memory
candidate.knowledge
candidate.decision
candidate.skill
candidate.process_improvement
```

The relevant host layer decides whether to canonize them.

A Room transcript does not automatically become Memory.

## 42. Dashboard projection

Recommended eventual Dashboard surfaces:

### Bot roster

- name/avatar;
- job;
- presence;
- attention;
- current owner/work summary.

### Bot conversation

One stable direct teammate surface containing heterogeneous event types:

- messages;
- Artifacts;
- approvals;
- handoffs;
- Routine events;
- current action summaries;
- optional environment preview.

### Rooms

- members;
- mentions;
- Threads;
- active work owner;
- shared Artifacts;
- compact progress.

### Attention queue

Priority order such as:

```text
needs_approval
needs_input
blocked
failed
handoff_waiting
unread_result
```

### Advanced

- Team Run graph;
- traces;
- cost/tokens;
- leases/policies;
- Worker details;
- environment logs.

## 43. Security threat model

Must design against:

- spoofed Bot identity;
- prompt injection relayed by a peer;
- privilege laundering;
- cross-workspace leakage;
- secret leakage;
- denial of wallet through fan-out;
- compromised remote agent;
- shared-environment credential bleed;
- malicious/untrusted code from a Worker;
- duplicate external mutations due to retry.

Controls include authenticated identity, provenance, permission intersection, environment isolation policy, budgets, idempotency receipts, explicit approvals and artifact verification.

## 44. Evaluation requirements

### Bot identity

- stable ID/alias resolution;
- ambiguous handle rejection;
- disabled Bot handling;
- local/remote same-name safety.

### Async delivery

- queued while recipient busy;
- survives client disconnect;
- retry is idempotent;
- expiration/failure visible.

### Rooms/Threads

- mentions deterministic;
- pass works;
- Thread scope inherited correctly;
- message caps stop cleanly;
- unresolved mention surfaced;
- multiple Rooms isolated.

### Delegation/handoff

- reason preserved;
- immutable constraints preserved;
- ownership changes only after accepted handoff;
- loop blocked;
- permission cannot increase.

### Execution environments

- shared policy intentionally shares allowed state;
- isolated Bot cannot read another isolated Bot environment;
- isolated Run cleaned after policy-defined retention;
- model cannot forge environment handle;
- takeover lifecycle works where adapter supports it.

### Parallel squads

- actual concurrency;
- one Worker failure isolated;
- cancellation propagates;
- aggregator receives valid Artifacts;
- verifier sees original constraints.

### Workspace safety

- no accidental cross-workspace retrieval;
- explicit bridge required;
- remote agent receives only selected data.

### Cost/runaway safety

- Worker cap;
- hop cap;
- token/cost cap;
- no-progress detector;
- cycle detector;
- timeout.

## 45. Implementation phases

### Phase 1: persistent teammate substrate

- schemas;
- Bot registry;
- durable Bot conversation;
- Room + Thread event store;
- async delivery queue;
- Gateway;
- local adapter;
- presence/attention events;
- environment references;
- policy/approval hook;
- basic CLI/API.

### Phase 2: coordination topologies

- delegation;
- handoff;
- manager;
- parallel panel;
- Room scheduler;
- pipeline;
- reviewer;
- dynamic squad;
- collaboration gate.

### Phase 3: AI-Verse native integration

- installer;
- workspace resolver;
- OS command boundary;
- Skills references;
- Memory candidate write-back;
- Brain TeamRun request/result contract;
- Automation bindings;
- Dashboard event projection.

### Phase 4: remote/runtime interoperability

- A2A;
- Hermes;
- OpenClaw;
- generic CLI;
- optional framework-specific adapters.

### Phase 5: reliability/adaptation

- restart recovery;
- full eval suite;
- topology performance metrics;
- model/runtime selection policy;
- adaptive topology selection only after measured evidence.

## 46. v1 acceptance criteria

The architecture becomes a working v1 only when all are true:

1. Several durable Bots can be created with distinct roles.
2. Each Bot has one stable direct conversation.
3. Bots can message each other asynchronously.
4. Bots can join multiple Rooms.
5. Rooms support Threads.
6. Every active work item has an explicit owner.
7. `@mentions` route deterministically.
8. Bots can pass without filler.
9. Delegation and handoff have different semantics.
10. A handoff preserves reason and immutable constraints.
11. Workers can be created for bounded runs.
12. Parallel Workers actually execute concurrently where runtime supports it.
13. A leader can synthesize Worker Artifacts.
14. A verifier can check the result against the original objective.
15. Environment policy supports at least shared and isolated-run modes.
16. Delegation cannot increase authority.
17. Workspace scope cannot be changed by model text.
18. Consequential actions can trigger approvals.
19. Cancellation propagates.
20. Cost/time/hop/message/Worker limits are centrally enforced.
21. Gateway works without any desktop UI running.
22. Activity is exposed as structured events.
23. AI-Verse native install does not duplicate Memory, Skills, Brain or Automation state.
24. An A2A remote agent can participate through an adapter.
25. Deterministic evaluations validate the claimed coordination behavior.
26. Single-agent execution remains the default when extra agents do not improve the task.

## Final architecture rule

> **Persistent job-owning Bots on the outside, bounded temporary teams on the inside, one event-driven Coordination Gateway in the middle, explicit ownership, scope, authority and evidence around every action, and no duplicated source of truth.**
