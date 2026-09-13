# AI-Verse Multiple Bots

**An installable Persistent Teammate Layer for AI operating systems.**

AI-Verse Multiple Bots gives an AI system a durable roster of specialist Bots that can own jobs, work asynchronously, use real tools, collaborate with each other, share artifacts, hand off responsibility, participate in group Rooms and Threads, and create bounded temporary multi-agent squads when one agent is not enough.

It is designed first for AI-Verse OS, while the coordination core remains host-neutral and usable standalone or through adapters with other agent runtimes.

## North star

> **Give every AI operating system its own team of persistent AI coworkers without creating a second operating system or a second source of truth.**

The target experience is inspired most strongly by xAI's Grok Bot persistent-teammate model, while the execution architecture combines useful patterns from Hermes, Grok Multi-Agent, Microsoft Agent Framework, OpenAI Agents SDK, A2A, OpenClaw, AgentScope and other current multi-agent systems.

## Current implementation status

**Phase 0: Research + Architecture: COMPLETE**

**Phase 1: Runnable Coordination Core: COMPLETE**

**Phase 2: Dynamic Multi-Agent Squads: COMPLETE**

**Phase 3: AI-Verse Native Integration: COMPLETE**

**Phase 4: Runtime and Agent Interoperability: COMPLETE**

**Phase 5: Product, Installer, Omnichannel and Dashboard: IN PROGRESS (~30%)**

Phase 5.1 provides the installable package surface, Phase 5.2 standalone mode, Phase 5.3 AI-Verse OS installation, Phase 5.4 setup/onboarding, Phase 5.5 reusable Bot/team templates, and Phase 5.6 truthful production health/doctor. The current verified implementation gate passes **459/459 repository tests**, **5/5 Phase 4 compatibility evaluations**, all install/setup/runtime/template smokes, and the installed-package production-doctor smoke. Phase 5.7 upgrade/migration strategy is next.

## Install

Requires **Node.js 22.5 or newer**.

The package artifact exposes one stable command:

```bash
ai-verse-multiple-bots
```

A built package tarball can be installed globally and used immediately:

```bash
npm install -g ./ai-verse-multiple-bots-0.1.0-alpha.1.tgz
ai-verse-multiple-bots standalone init
ai-verse-multiple-bots standalone doctor
```

The package is configured for public scoped npm publication as `@ai-verse/multiple-bots`, but this repository does not claim that version `0.1.0-alpha.1` has already been published to the public npm registry.

npm installation itself performs no hidden host configuration. Setup is always explicit.

## Setup

Choose one mode on first setup.

Standalone:

```bash
ai-verse-multiple-bots setup --mode standalone
```

AI-Verse OS:

```bash
ai-verse-multiple-bots setup --mode os --root /path/to/AI-Verse-OS
```

See the available modes:

```bash
ai-verse-multiple-bots setup modes
```

Once an installation already exists, rerunning `ai-verse-multiple-bots setup` from inside it can auto-detect the single existing mode. If both modes are discoverable, setup requires an explicit `--mode`.

Setup returns structured verification plus tailored next steps. It does not silently create a Bot or team.

## Verify

Concise component status:

```bash
ai-verse-multiple-bots status
```

Deep read-only production verification:

```bash
ai-verse-multiple-bots doctor
```

Mode-specific forms:

```bash
ai-verse-multiple-bots standalone doctor --root /path/to/project
ai-verse-multiple-bots os doctor --root /path/to/AI-Verse-OS
```

Doctor reports the exact structural, attachment, runtime, dependency and operational depths it checked. In AI-Verse OS mode, whole-system/composed readiness remains explicitly delegated to OS/distribution rather than being claimed by this component.

A running mode-aware Gateway exposes `GET /v1/health/readiness`. Legacy `GET /health` remains the narrow storage health endpoint.

See [`docs/PRODUCTION-HEALTH-DOCTOR.md`](docs/PRODUCTION-HEALTH-DOCTOR.md).

## Use

Start standalone mode:

```bash
ai-verse-multiple-bots standalone serve --root /path/to/project
```

Start against AI-Verse OS using its canonical Multiple Bots database:

```bash
ai-verse-multiple-bots serve \
  --os-root /path/to/AI-Verse-OS \
  --db /path/to/AI-Verse-OS/runtime/ai-verse-bots/coordination.db
```

Setup also returns the exact resolved commands/paths for the selected installation. Durable Bot/team creation remains explicit.

## Starter Bot and team templates

Browse the built-in catalog:

```bash
ai-verse-multiple-bots template list
```

Inspect and plan before creating anything:

```bash
ai-verse-multiple-bots template show --id research-team

ai-verse-multiple-bots template plan \
  --id research-team \
  --workspace my-workspace \
  --runtime deterministic \
  --db /path/to/coordination.db
```

Apply explicitly:

```bash
ai-verse-multiple-bots template apply \
  --id research-team \
  --workspace my-workspace \
  --runtime deterministic \
  --db /path/to/coordination.db
```

Current starters include `research-lead`, `reviewer`, `coordinator`, `research-team`, and `delivery-team`.

Team templates create durable Bots plus a bounded Room. They do **not** create a Team Run or temporary Workers automatically. Runtime selection is explicit because the stock Gateway does not provide an implicit `native` execution adapter. The normal collaboration gate still decides when one task justifies temporary multi-agent execution.

See [`docs/BOT-TEAM-TEMPLATES.md`](docs/BOT-TEAM-TEMPLATES.md).

## Update / disable / uninstall

The existing expert AI-Verse OS lifecycle commands remain available:

```bash
ai-verse-multiple-bots os upgrade-plan --root /path/to/AI-Verse-OS
ai-verse-multiple-bots os upgrade --root /path/to/AI-Verse-OS
ai-verse-multiple-bots os uninstall-plan --root /path/to/AI-Verse-OS
ai-verse-multiple-bots os uninstall --root /path/to/AI-Verse-OS
```

The standardized public update/enable/disable/uninstall lifecycle and migration UX is still a later Phase 5 slice. Setup never silently re-enables a disabled registration.

## What setup does and does not grant

Setup initializes Multiple Bots-owned coordination state and, in AI-Verse OS mode, materializes/attaches the local extension through the existing safe registry boundary.

Setup does **not** grant AI-Verse OS workspace access, connection permission, external action approval, Brain authority, or remote/public-network exposure.

See [`docs/SETUP-ONBOARDING.md`](docs/SETUP-ONBOARDING.md).

## Standalone mode

Create a host-neutral standalone installation:

```bash
mkdir my-bots
cd my-bots
ai-verse-multiple-bots standalone init
ai-verse-multiple-bots standalone doctor
ai-verse-multiple-bots standalone serve
```

Standalone state lives only under:

```text
.ai-verse-bots/
├── config.json
└── runtime/
    └── coordination.db
```

The default Gateway bind is `127.0.0.1:8787`. Standalone mode does not create `AI-VERSE.yaml`, `.aiverse/`, `operator/`, `workspaces/`, or substitute Brain/Memory/Skills/Automations stores.

See [`docs/STANDALONE-INSTALL.md`](docs/STANDALONE-INSTALL.md).

## AI-Verse OS install mode

Install into an existing compatible AI-Verse OS v2 host:

```bash
ai-verse-multiple-bots os install-plan --root /path/to/AI-Verse-OS
ai-verse-multiple-bots os install --root /path/to/AI-Verse-OS
```

The install materializes only local extension-owned files under `.aiverse/extensions/ai-verse-multiple-bots/`, initializes `runtime/ai-verse-bots/coordination.db`, and registers through the OS-owned local extension registry contract.

It does not rewrite `AI-VERSE.yaml`, `AGENTS.md`, operator/workspace canonical state, `agents/registry.yaml`, `skills/registry.yaml`, Brain, Memory, Skills generations, Automations, apps, or connection declarations.

The generated `engine.mjs` loads the installed package and starts the real OS-attached Coordination Gateway.

See [`docs/AI-VERSE-OS-INSTALL.md`](docs/AI-VERSE-OS-INSTALL.md).

The current package includes:

- durable Bot registry with collision-safe identity and lifecycle rules
- persistent Bot-to-Bot messaging and asynchronous mailboxes
- Room and Thread collaboration with bounded scheduling
- Task delegation, capability/environment leases, ownership and immutable constraints
- safe Handoffs with authority reissue, Approval retargeting and ownership settlement
- first-class Approval gates for consequential work
- persistent execution queue with cancellation, deadlines, heartbeats, dead letters and restart recovery
- strict workspace, peer, tool and connection policy enforcement
- deterministic and OpenAI-compatible runtime adapters
- temporary Team Run Workers that never become durable Bots implicitly
- manager, parallel fan-out, direct handoff, bounded discussion, review/verifier and hybrid squad behavior
- adaptive single-Bot-vs-squad selection
- structured disagreement detection and verification debt
- canonical leader synthesis with provenance
- squad-wide aggregate budgets, absolute wall-clock deadlines and hierarchical cancellation
- evidence-preserving terminal cleanup and restart recovery
- AI-Verse OS v2 compatibility detection and safe local extension registration
- extension registry preservation, path/symlink safety, concurrent-writer protection and idempotent reinstall
- live workspace-scoped runtime projection for durable Bots and temporary Workers without copying canonical host text
- Brain objective ingress with explicit direction ownership, semantic-root provenance and execution-time stale-intent fencing
- exact Brain re-ingress contract protection for authority, deadlines, hops, leases and Approvals
- explicit AI-Verse Memory recall through the installed Memory engine without reading or owning its SQLite index
- bounded canonical Memory source/path/provenance validation with runtime-only recalled text for durable Bots and temporary Workers
- installable `ai-verse-multiple-bots` CLI with unified `setup`, starter-template list/show/plan/apply, standalone `init`/`doctor`/`serve`, AI-Verse OS `install-plan`/`install`, and lower-level OS registration/lifecycle surfaces

See [`docs/BUILD-MAP.md`](docs/BUILD-MAP.md) for the canonical project progress map and [`docs/PHASE-5-STATUS.md`](docs/PHASE-5-STATUS.md) for the current productization ledger.

## Canonical architecture

For implementation, these are the current source documents:

1. [`docs/PERSISTENT-TEAMMATE-ARCHITECTURE.md`](docs/PERSISTENT-TEAMMATE-ARCHITECTURE.md) is the **canonical product and system architecture**.
2. [`docs/COORDINATION-PROTOCOL-V1.1.md`](docs/COORDINATION-PROTOCOL-V1.1.md) is the **current coordination protocol direction**.
3. [`schemas/coordination-v1.schema.json`](schemas/coordination-v1.schema.json) is the machine-readable coordination companion and evolves through implementation tests.
4. [`docs/AI-VERSE-OS-REGISTRATION-CONTRACT.md`](docs/AI-VERSE-OS-REGISTRATION-CONTRACT.md) is the Phase 3.1 host-registration boundary.
5. [`docs/AI-VERSE-BRAIN-OBJECTIVE-INGRESS.md`](docs/AI-VERSE-BRAIN-OBJECTIVE-INGRESS.md) is the Phase 3.3 Brain-to-coordination boundary.
6. [`docs/AI-VERSE-MEMORY-RECALL.md`](docs/AI-VERSE-MEMORY-RECALL.md) is the Phase 3.4 Memory-to-runtime recall boundary.
7. [`templates/bot.yaml`](templates/bot.yaml) and [`templates/room.yaml`](templates/room.yaml) are the current Bot and Room manifest examples.

The earlier [`docs/ARCHITECTURE-BLUEPRINT.md`](docs/ARCHITECTURE-BLUEPRINT.md) and [`docs/COORDINATION-PROTOCOL.md`](docs/COORDINATION-PROTOCOL.md) remain research/background documents. Where they differ from the canonical files above, the current architecture/protocol/status documents win.

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
AI-Verse Multiple Bots  -> Bot identity, Rooms, routing, Tasks, Handoffs, Team Runs
AI-Verse Dashboard      -> visual control and observability
```

Important discoveries from Bot work are proposed back through explicit AI-Verse write contracts. A Bot conversation, Worker result, or Team Run Artifact never becomes canonical OS truth merely because it exists.

## Core primitives

### Durable primitives

- **Bot**: persistent named teammate with one durable role and responsibility
- **Room**: shared group conversation for several durable Bots
- **Thread**: focused branch inside a DM or Room
- **Bot Relationship**: optional manager/coordinator relationship between durable Bots
- **Execution Environment Reference**: trusted handle to the environment where a Bot can act

### Run-scoped primitives

- **Worker**: temporary specialist created for bounded Team Run work
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

A **Worker** is disposable because one bounded run temporarily benefits from additional intelligence.

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

Workers terminate with their Team Run lifecycle and never enter the durable Bot registry implicitly. Creating a durable Bot is a separate explicit lifecycle decision, not Worker promotion by side effect.

## Collaboration patterns

The system does not pretend one swarm pattern fits every task.

| Pattern | Purpose |
|---|---|
| **Direct Bot Chat** | Operator talks to one durable teammate |
| **Bot-to-Bot DM** | Asynchronous peer communication |
| **Delegation** | Bot asks another Bot/Worker for bounded work while retaining ownership |
| **Handoff** | Active responsibility transfers to another principal |
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
     selective verifier
           |
           v
        synthesis
           |
           v
       final result
```

AI-Verse squad size is task-dependent, model-neutral, centrally budgeted and bounded by one Team Run control plane.

## Execution environments

AI-Verse supports configurable environment policy:

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
             identity routing Tasks policy budgets
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

No desktop or web client owns Room scheduling or Bot-to-Bot routing. Push events are primary; polling is fallback only.

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
- Task ID and correlation ID
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
Task capability lease
```

A peer cannot launder privilege by asking a more powerful Bot to perform something the current Task was never authorized to do. Secrets travel as handles, not raw values.

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

## Workspace law

Workspace scope is trusted runtime state.

Bots cannot prompt each other into another AI-Verse workspace or invent filesystem roots. Cross-workspace work is explicit and transfers selected Artifacts/summaries rather than casually joining both contexts.

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
- Skills relevant to the Task
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

Multiple Bots does not create a second scheduler. AI-Verse Automations remains canonical for schedules/events, while a Bot surface may project those automations as that Bot's routines.

## Skills and learning workflows

AI-Verse follows a progressive pattern:

```text
perform once
   -> verify
   -> capture reusable method
   -> evaluate as Skill
   -> approve/promote Skill
   -> optionally bind Automation to responsible Bot
```

Teach-by-demonstration can later feed AI-Verse Skills through action traces without moving Skill ownership into this repository.

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

Dashboard clients should default to attention state and a short current-action summary. Full traces remain available for inspection.

## AI-Verse OS integration

AI-Verse OS v2 exposes optional local extensions through:

```text
AI-Verse-OS/
└── .aiverse/
    └── extensions/
        ├── registry.json
        ├── registry.json.lock       # transient shared mutation guard
        └── ai-verse-multiple-bots/
            ├── INSTRUCTIONS.md
            ├── engine.mjs
            └── <future adapters>
```

Phase 3.1 implements compatibility detection and safe registration through this local extension hook. Phase 3.2 adds read-only live workspace projection. Phase 3.3 adds bounded Brain objective ingress and execution-time strategic freshness checks. Phase 3.4 adds explicit, bounded workspace-scoped historical recall through AI-Verse Memory.

Important boundaries:

- normal Multiple Bots registration does **not** edit tracked AI-Verse OS files
- it does **not** create or rewrite `agents/registry.yaml`
- it preserves unknown registry fields and unrelated extension registrations
- registration does not imply health, permissions, approvals, workspace access or runtime readiness
- installed extension paths must stay inside the OS root and must not traverse symlinks
- competing registry writers fail visibly instead of silently overwriting each other
- workspace, Brain and Memory projections remain derived runtime context; canonical host/Brain/Memory state stays outside the coordination database
- Brain-rooted execution is revalidated against current canonical Brain state immediately before runtime execution
- Memory recall uses Memory's installed engine rather than reading its SQLite index directly, and recalled text is never persisted into coordination receipts

Programmatic host registration is exported as `aiVerseOsRegistrationAdapter`.

CLI surfaces:

```bash
ai-verse-multiple-bots os detect --root /path/to/AI-Verse-OS
ai-verse-multiple-bots os install-plan --root /path/to/AI-Verse-OS
ai-verse-multiple-bots os install --root /path/to/AI-Verse-OS
ai-verse-multiple-bots os plan --root /path/to/AI-Verse-OS
ai-verse-multiple-bots os register --root /path/to/AI-Verse-OS
```

`os register` remains a lower-level registration operation. Phase 5.3 adds the member-facing `os install` path that materializes the extension payload, initializes runtime coordination state, and then uses the existing registration contract.

See [`docs/AI-VERSE-OS-REGISTRATION-CONTRACT.md`](docs/AI-VERSE-OS-REGISTRATION-CONTRACT.md), [`docs/AI-VERSE-BRAIN-OBJECTIVE-INGRESS.md`](docs/AI-VERSE-BRAIN-OBJECTIVE-INGRESS.md), and [`docs/AI-VERSE-MEMORY-RECALL.md`](docs/AI-VERSE-MEMORY-RECALL.md).

## Standalone mode

Without AI-Verse OS, the same coordination core can be hosted independently. Host integrations can supply their own memory, skills, filesystem, automation and execution backends without changing the core protocol.

## Interoperability

Planned adapters:

1. native AI-Verse integration
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

Controlled multi-agent research shows fixed teams can underperform a strong single agent, waste budget, duplicate effort or average away the strongest expert.

Therefore the system selects the **smallest sufficient topology** and keeps multi-agent work explicitly bounded.

## Research and architecture documents

- [`docs/GROK-BOT-DEEP-DIVE.md`](docs/GROK-BOT-DEEP-DIVE.md) - Grok Bot product benchmark and AI-Verse lessons
- [`docs/PERSISTENT-TEAMMATE-ARCHITECTURE.md`](docs/PERSISTENT-TEAMMATE-ARCHITECTURE.md) - canonical architecture
- [`docs/COORDINATION-PROTOCOL-V1.1.md`](docs/COORDINATION-PROTOCOL-V1.1.md) - current coordination protocol
- [`docs/BUILD-MAP.md`](docs/BUILD-MAP.md) - canonical project completion map
- [`docs/PHASE-1-STATUS.md`](docs/PHASE-1-STATUS.md) - Phase 1 ledger
- [`docs/PHASE-2-STATUS.md`](docs/PHASE-2-STATUS.md) - Phase 2 ledger
- [`docs/PHASE-3-STATUS.md`](docs/PHASE-3-STATUS.md) - completed Phase 3 ledger
- [`docs/PHASE-4-STATUS.md`](docs/PHASE-4-STATUS.md) - completed Phase 4 ledger
- [`docs/PHASE-5-STATUS.md`](docs/PHASE-5-STATUS.md) - current Phase 5 ledger
- [`docs/STANDALONE-INSTALL.md`](docs/STANDALONE-INSTALL.md) - Phase 5.2 standalone installation contract
- [`docs/AI-VERSE-OS-INSTALL.md`](docs/AI-VERSE-OS-INSTALL.md) - Phase 5.3 AI-Verse OS installation contract
- [`docs/SETUP-ONBOARDING.md`](docs/SETUP-ONBOARDING.md) - Phase 5.4 setup/onboarding contract
- [`docs/BOT-TEAM-TEMPLATES.md`](docs/BOT-TEAM-TEMPLATES.md) - Phase 5.5 reusable starter Bot/team template contract
- [`docs/PRODUCTION-HEALTH-DOCTOR.md`](docs/PRODUCTION-HEALTH-DOCTOR.md) - Phase 5.6 truthful production readiness contract
- [`docs/AI-VERSE-OS-REGISTRATION-CONTRACT.md`](docs/AI-VERSE-OS-REGISTRATION-CONTRACT.md) - Phase 3.1 host contract
- [`docs/AI-VERSE-BRAIN-OBJECTIVE-INGRESS.md`](docs/AI-VERSE-BRAIN-OBJECTIVE-INGRESS.md) - Phase 3.3 Brain ingress contract
- [`docs/AI-VERSE-MEMORY-RECALL.md`](docs/AI-VERSE-MEMORY-RECALL.md) - Phase 3.4 Memory recall contract
- [`docs/RESEARCH-2026-09.md`](docs/RESEARCH-2026-09.md) - multi-agent/open-source ecosystem benchmark
- [`docs/REFERENCE-ADOPTION-MAP.md`](docs/REFERENCE-ADOPTION-MAP.md) - adopt/adapt/integrate/study/avoid map
- [`docs/AI-VERSE-INTEGRATION.md`](docs/AI-VERSE-INTEGRATION.md) - broader AI-Verse integration direction

## Machine-readable contracts

- [`schemas/coordination-v1.schema.json`](schemas/coordination-v1.schema.json)
- [`templates/bot.yaml`](templates/bot.yaml)
- [`templates/room.yaml`](templates/room.yaml)
- [`templates/starter-catalog.json`](templates/starter-catalog.json)
- [`integrations/ai-verse-os/extension.json`](integrations/ai-verse-os/extension.json)

Contracts are tightened through implementation/evaluation rather than treated as frozen forever.

## Implementation progress

Phases 0 through 4 are complete. Phase 5 is in progress.

Phase 5.1 package installation, Phase 5.2 standalone mode, Phase 5.3 AI-Verse OS install mode, Phase 5.4 setup/onboarding, Phase 5.5 Bot/team templates, and Phase 5.6 production health/doctor are complete. Remaining productization work starts with upgrade/migration strategy, followed by secure remote access, Dashboard/channel surfaces, observability, release documentation and the final release acceptance suite.

The visual Bot roster belongs in AI-Verse Dashboard. Multiple Bots remains the backend coordination authority for Bot identity, routing, Tasks, Handoffs, Rooms, Team Runs and runtime orchestration.

## North-star rule

> **Persistent Bots on the outside, bounded temporary teams on the inside, one event-driven Coordination Gateway in the middle, explicit ownership and permission around every action, and no duplicated source of truth.**

## Research snapshot

Architecture research snapshot: **2026-09-09**.

This project is informed by publicly documented product behavior, open-source projects, open standards and research. It does not claim to reproduce proprietary xAI Grok Bot internals.