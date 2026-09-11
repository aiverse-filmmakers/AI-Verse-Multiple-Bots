# AI-Verse Multiple Bots Integration Contract

**Target host:** AI-Verse OS v2 Unified Workspace Architecture

**Snapshot:** 2026-09-09

## 1. Integration principle

AI-Verse Multiple Bots is a coordination layer installed into AI-Verse OS, not a new source of truth.

Its native contract is:

```text
OS owns truth and workspace boundaries
Memory owns durable historical memory
Brain owns intent, goals, planning and reflection
Skills owns reusable capabilities
Multiple Bots owns coordination
Dashboard owns visualization and control surfaces
```

No layer should silently duplicate another layer's canonical state.

## 2. Ownership matrix

| Information | Canonical owner | Multiple Bots behavior |
|---|---|---|
| operator identity/preferences | AI-Verse OS `operator/profile/` | read through host context, never duplicate into Bot profiles |
| current operator state | AI-Verse OS `operator/context/` | selected into context packets when relevant |
| current workspace state | AI-Verse OS workspace `context/` | selected into scoped context packets |
| workspace manifest/scope | AI-Verse OS `WORKSPACE.yaml` | resolve server-side, never accept arbitrary model-authored roots |
| settled decisions | AI-Verse OS decisions | inject relevant decisions as higher-authority constraints |
| reusable knowledge | AI-Verse OS knowledge | retrieve through host routing, do not import wholesale into Bot storage |
| durable historical memory | AI-Verse Memory / OS memory paths | submit memory candidates, never silently write conversation transcripts as memory |
| strategic intent/goals | AI-Verse Brain | accept objectives/team-run requests and return evidence/results |
| reusable professional capabilities | AI-Verse Skills | reference skills/roles/operator packs by ID |
| runtime permission grants | AI-Verse OS/runtime policy | enforce through capability leases |
| Bot identity/config | Multiple Bots | canonical here |
| room membership/config | Multiple Bots | canonical here |
| Bot/room coordination messages | Multiple Bots | canonical coordination history only |
| delegated tasks/team-run lifecycle | Multiple Bots | canonical coordination state |
| presence/activity cache | Multiple Bots runtime | derived/disposable |
| Bot visualization | AI-Verse Dashboard | projection from Multiple Bots events and OS state |
| schedules/routines | AI-Verse OS automations | trigger Bots/runs through command boundary |

## 3. Native filesystem contract

Recommended native installation:

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
│       │   └── <run-id>/
│       └── policies/
│
├── scripts/
│   └── ai-verse-bots/
│       └── ... coordination engine ...
│
├── runtime/
│   └── ai-verse-bots/
│       ├── coordination.db
│       ├── cache/
│       ├── sockets/
│       ├── indexes/
│       └── traces/
│
├── .claude/skills/
│   └── ai-verse-bots/
│       └── SKILL.md
└── .agents/skills/
    └── ai-verse-bots/
        └── SKILL.md
```

### Ownership inside this shape

`agents/bots/` is user-owned coordination state.

`scripts/ai-verse-bots/` is system-owned installed engine code.

`runtime/ai-verse-bots/` is disposable derived/runtime state.

An update may replace engine code deliberately. It must not casually overwrite Bot manifests, rooms, policies, or retained coordination history.

## 4. Installer behavior

The native installer should detect AI-Verse OS v2 using the same style of explicit contract as AI-Verse Memory:

```yaml
schema_version: "2.0"
architecture: unified-workspace
```

plus required OS paths such as `operator/`, `workspaces/`, `agents/`, and the runtime contract.

### Native install should

1. install the coordination engine under `scripts/ai-verse-bots/`;
2. initialize required `agents/bots/` directories only when absent;
3. install runtime adapters for supported host harnesses;
4. register the capability in the appropriate AI-Verse registry;
5. add one bounded integration block to canonical `AGENTS.md` if the OS contract requires it;
6. avoid turning `CLAUDE.md` into a second standing runtime contract;
7. initialize disposable SQLite/runtime state;
8. run a `doctor` check;
9. preserve all existing user-owned Bot/room state on reinstall;
10. offer explicit migrations rather than silent destructive schema rewrites.

### Standalone install should

Use:

```text
.ai-verse-bots/
```

and not pretend the host has AI-Verse OS concepts it does not actually provide.

## 5. AI-Verse OS contract

AI-Verse OS supplies trusted context to Multiple Bots.

The coordination engine should not scan random directories to infer the active workspace.

Host injection should include at minimum:

```yaml
operator_id: local-operator
workspace:
  id: example
  root_handle: workspace:example
policy:
  ref: default
runtime:
  session_id: session_...
```

The actual filesystem root is resolved internally from a trusted handle.

### Current-state precedence

When a Bot's old conversation says one thing and canonical OS current context says another, current canonical OS state wins.

A context packet should make authority explicit so the model does not have to guess.

## 6. AI-Verse Memory contract

Multiple Bots and Memory solve different problems.

### Multiple Bots stores

- who said what in a room;
- delegated task history;
- Bot-to-Bot messages;
- run traces and results;
- coordination artifacts/receipts.

### Memory stores

Historical facts/experiences worth recalling later, in the canonical operator/workspace memory locations defined by AI-Verse OS.

### No automatic transcript ingestion

A room transcript must not become long-term memory merely because it happened.

Instead Multiple Bots can emit structured candidates:

```yaml
type: candidate.memory
scope:
  workspace_id: example
proposed_by: research-bot
source:
  run_id: run_...
  event_ids: [evt_...]
text: "The client rejected direction A because it conflicts with the approved brand tone."
confidence: 0.95
reason: "Likely useful historical preference for future work"
```

Memory/OS policy decides whether and how to persist it.

### Bot-specific memory

Do not create an independent canonical personal-memory universe for every Bot inside AI-Verse OS.

Bots can receive different retrieval views or filters, but facts about the operator/workspace remain in the canonical Memory/OS layers.

Bot configuration can contain role behavior and local coordination preferences, not duplicated user truth.

## 7. AI-Verse Brain contract

Brain decides **what should be achieved and why**. Multiple Bots decides **how agents coordinate to execute a requested team operation**.

Recommended boundary:

```text
Brain
  -> TeamRunRequest
Multiple Bots
  -> ExecutionPlan
  -> coordinated execution
  -> TeamRunResult + evidence + observations
Brain
  -> reflection / strategy update / next initiative
```

### Brain can request

- objective;
- desired outcome;
- constraints;
- suggested topology if strategy requires it;
- specialist requirements;
- verification level;
- urgency;
- budget class;
- approval policy.

### Multiple Bots owns

- participant resolution;
- Worker creation;
- routing;
- handoffs;
- room scheduling;
- capability leases;
- budgets;
- cancellation;
- execution events;
- collaboration protocol compliance.

### Brain must not bypass the Gateway

Brain should not directly write fake Bot-to-Bot messages or mutate room state to "simulate" coordination.

It calls the same coordination command boundary as any other authorized caller.

## 8. AI-Verse Skills contract

A Bot manifest may reference capabilities from AI-Verse Skills:

```yaml
capabilities:
  role_refs:
    - research-analyst
  skill_refs:
    - deep-research-synthesis
    - evidence-verification
  operator_refs:
    - browser
```

These references describe what the Bot knows how to do.

They do **not** grant permission.

### Skill is not permission

Effective execution still requires:

```text
host policy
INTERSECT
workspace policy
INTERSECT
Bot grant
INTERSECT
task capability lease
```

Phase 3.5 keeps `skill_refs` on the Bot/Worker and Task method contract. It never copies them into `capability_lease.tools` or `capability_lease.connections`.

### Canonical resolver ownership

Multiple Bots does not read the AI-Verse Skills registry or implement its own provider-ranking system.

In native mode it calls the AI-Verse OS capability resolver using the exact Task workspace scope. AI-Verse OS remains responsible for OS/distributed/local/workspace provider discovery, provider precedence, protected aliases, qualified identity selection and provider health.

AI-Verse Skills remains responsible for reusable packages, immutable generations, package metadata and package provenance.

### Progressive disclosure

The Bot registry stores only declared references. Full skill instructions/resources load only when a Task explicitly requests the capability.

For a selected package, Phase 3.5 verifies the OS-selected `aiverse-package-sha256-v1` digest before and after reading the package `SKILL.md`. The instruction body is runtime-only. Coordination receipts retain bounded provider/generation/package/instruction digests, not the copied skill body.

### Worker skills

Temporary Workers may receive a run-scoped subset of skills selected by the leader/orchestrator. They do not automatically inherit every capability of the leader.

Manager, fan-out, discussion and verifier paths all enforce this explicit subset. Final synthesis remains leader-owned and may also request an explicit leader-declared method subset.

### Handoffs

Task skill requirements survive a Handoff. A durable target must declare the required methods before it can accept the work.

The Handoff reissues only the pre-existing execution lease authority. Skill knowledge does not become permission and does not bypass Approval state.

### Standalone behavior

Tasks without `skill_refs` require no Skills provider. An explicitly skill-dependent Task fails closed if no capability-resolution source exists.

See `AI-VERSE-SKILLS-CAPABILITY-RESOLUTION.md` for the detailed Phase 3.5 contract.

## 9. AI-Verse Dashboard contract

Dashboard is the primary visual Control Room, but it is not the coordination engine.

### Dashboard reads

- Bot roster;
- room list;
- room event streams;
- active Team Runs;
- tasks;
- agent presence;
- cost/token summaries;
- approvals;
- errors;
- produced artifacts;
- topology graph/timeline.

### Dashboard commands

Dashboard sends commands through the OS/Multiple Bots command boundary such as:

```text
bots.create
bots.update
bots.message
bots.delegate
bots.handoff
rooms.create
rooms.message
rooms.add_member
rooms.remove_member
runs.start
runs.cancel
runs.resume
approvals.resolve
```

It must never mutate Bot YAML, room event logs or task files directly from the browser client.

### Recommended Dashboard surfaces

#### Bots

- roster;
- role/model/runtime;
- availability;
- current assignment;
- granted capability summary.

#### Rooms

- group conversations;
- mentions;
- active speaker state;
- pass/settled status;
- pinned task/artifact references.

#### Team Runs

- topology visualization;
- leader/workers;
- parallel branches;
- progress;
- retries;
- verifier status;
- budget.

#### Timeline

All structured coordination events projected into human-readable activity.

## 10. Automations contract

AI-Verse OS Automations owns Cadence. Multiple Bots does not create a competing scheduler.

Canonical host ownership includes:

- scheduled/repeated job definitions;
- event-trigger definitions;
- trigger subscriptions and polling where applicable;
- automation-level retry/failure policy;
- automation-level approvals and kill switches;
- automation-run history.

Phase 3.6 implements only the receive-side coordination command:

```text
POST /v1/automations/invoke
```

### Invocation identity

Every fired occurrence supplies a unique host-owned `invocationId` plus the canonical automation source identity, workspace, fire timestamp, source path and source SHA-256.

Multiple Bots derives deterministic coordination identity from that occurrence. Duplicate delivery is idempotent. A replay with changed semantics fails closed.

### Source ownership and kill fence

Native automation invocations must point to a canonical AI-Verse OS automation definition under:

```text
automations/jobs/...
automations/triggers/...
workspaces/<workspace-id>/automations/...
```

The definition is revalidated against the exact active workspace and current source digest before ingress. If the source changed or disappeared after the host fired it, replay is rejected rather than silently running stale cadence.

Multiple Bots stores only bounded source provenance and digests, never the source body or scheduler state.

### Durable Bot wake

A Bot wake creates a normal Task through the existing policy boundary.

Tools, connections, skills, Memory recall, budget, deadlines, Approval and recovery remain Task-level contracts. No automation invocation grants authority by itself.

### Team Run start

A Team Run invocation opens only bounded coordination state.

It creates no Task, lease, Approval, Worker or queue item. The run must have explicit hard worker/task/action/wall-clock/hop bounds and an active leader allowed to create Workers.

Task-only authority fields are rejected at run creation. Later executable Tasks must receive those fields through their normal Team Run execution surfaces.

If host automation policy still requires approval to start the run, the host must resolve that approval before invoking Multiple Bots. Phase 3.6 does not invent a parallel run-level approval system.

### No scheduler in Multiple Bots

Phase 3.6 adds no cron parser, RRULE parser, timer, watcher, polling loop, recurring-state database or automation history.

See `AI-VERSE-AUTOMATION-WAKE-SCHEDULE.md` for the complete contract.


## 11. OS write-command contract

Multiple Bots does not directly mutate AI-Verse OS canonical context, knowledge, decisions or other owner state.

Phase 3.7 routes a bounded request through the OS-owned write-command boundary:

```text
Multiple Bots
  -> exact immutable write command
AI-Verse OS scripts/write-command.mjs
  -> validates scope / fingerprint / permission / idempotency
  -> queues under runtime/write-commands/
  -> canonical_effect_occurred = false
Later owner handler
  -> separately validates and performs any canonical effect
```

Native Multiple Bots exposes:

```text
POST /v1/os/write-commands
```

A durable Bot or temporary Worker may request only within its exact scope. Temporary Workers cannot escalate into operator scope.

The OS runtime queue is disposable. Exact replay therefore recontacts the host while Multiple Bots retains one provenance-only receipt Artifact.

The Multiple Bots receipt stores parameter digests and coordination provenance, not the parameter body.

Phase 3.7 does not implement knowledge/decision promotion. Candidate routing/promotion is Phase 3.8.

See `AI-VERSE-OS-WRITE-COMMAND-BOUNDARY.md`.

## 12. Connections contract

Bots may use connected systems only through host-approved connection/tool handles.

Bot manifests should never contain raw secrets.

Example:

```yaml
connections:
  allowed_handles:
    - gmail:operator
    - github:aiverse-filmmakers
```

A delegated Worker receives only the handles explicitly leased for that task.

A peer Bot cannot forward a raw OAuth token to another Bot.

## 12. Workspace isolation

Every DM, Room, Task and Team Run has a workspace scope unless explicitly operator-scoped.

### Room example

```yaml
scope:
  type: workspace
  workspace_id: client-acme
```

All room participants may be global Bot identities, but their effective context and tool access inside the room are restricted to `client-acme`.

### Cross-workspace collaboration

Default: denied.

Allowed pattern:

```text
Workspace A
  -> explicit selected artifact export
  -> bridge authorization
  -> Workspace B task context
```

Disallowed pattern:

```text
Bot has access to A and B
therefore room in A may freely search B
```

The existence of one multi-workspace Bot must never collapse workspace isolation.

## 13. Source-of-truth routing

When a Bot encounters information, routing should follow meaning rather than convenience.

```text
Temporary coordination detail
    -> Multiple Bots conversation/run state

Current workspace state change
    -> OS workspace context through write contract

Settled choice
    -> OS decisions

Historical fact/experience
    -> Memory candidate

Reusable cross-workspace knowledge
    -> OS knowledge candidate

Repeatable procedure
    -> Skills candidate

Strategic observation / goal impact
    -> Brain observation/result
```

The team layer is therefore a producer and consumer of canonical information, not its final owner.

## 14. Command boundary

Recommended namespace:

```text
bots.*
rooms.*
runs.*
tasks.*
artifacts.*
approvals.*
```

### Examples

```text
bots.list
bots.get
bots.create
bots.update
bots.message
bots.delegate
bots.handoff

rooms.list
rooms.create
rooms.message
rooms.add_member
rooms.remove_member
rooms.archive

runs.start
runs.get
runs.cancel
runs.resume
runs.events

tasks.get
tasks.cancel

artifacts.get
artifacts.publish

approvals.resolve
```

All mutating commands are validated server-side for caller identity, workspace and policy.

## 15. Brain-to-Bots run request

Suggested normalized request:

```yaml
schema_version: "1.0"
request_id: req_...
caller: ai-verse-brain
workspace_id: product-x

objective:
  text: "Determine whether we should launch feature X this quarter."
  required_constraints:
    - "Use only evidence from the current strategy workspace and approved external research"
    - "Surface unresolved disagreement"

collaboration:
  topology: auto
  preferred_leader: strategy-lead
  specialist_requirements:
    - market-research
    - finance
    - product
  verifier: true

budget:
  class: medium

approval:
  external_writes: ask
```

Multiple Bots returns:

```yaml
run_id: run_...
status: completed
final_artifact_ref: artifact_...
evidence_refs: []
observations: []
candidate_writebacks: []
metrics:
  participants: 4
  topology: manager_parallel
```

## 16. Dashboard event projection

The Gateway publishes events. Dashboard subscribes.

Example event:

```json
{
  "type": "task.started",
  "event_id": "evt_...",
  "run_id": "run_...",
  "workspace_id": "product-x",
  "actor": "market-researcher",
  "task_id": "task_...",
  "timestamp": "2026-09-09T09:30:00Z",
  "summary": "Market researcher started competitor evidence collection"
}
```

Dashboard does not need private model reasoning to show meaningful progress.

## 17. Failure propagation between layers

### Worker fails

Multiple Bots handles retry/fallback within run policy.

### Run blocked by missing permission

Multiple Bots emits approval request to host command/Inbox layer.

### Run reveals stale canonical context

Multiple Bots emits a candidate/current-state conflict. OS/Brain decides whether to update canonical state.

### Memory unavailable

Run may proceed with current OS context if policy permits. Coordination layer must not invent its own replacement memory system.

### Skills unavailable

Bot can still operate with native runtime abilities. Missing skill references are surfaced as capability health issues.

### Dashboard unavailable

Bots/rooms/team runs continue through the backend Gateway. UI absence cannot stop orchestration.

## 18. Health contract

`doctor` should check native integration across the five surrounding layers.

Suggested checks:

- AI-Verse OS v2 detected;
- agents/bots schema valid;
- workspace resolver works;
- runtime index rebuild works;
- Gateway bind policy safe;
- host command boundary available;
- Memory adapter optional/healthy;
- Brain integration contract version compatible;
- Skills references resolvable;
- Dashboard event endpoint available when Dashboard installed;
- no duplicate standing runtime blocks;
- no secrets found in Bot manifests;
- cross-workspace denial test passes;
- permission intersection test passes;
- cancellation test passes.

## 19. Uninstall contract

Default uninstall removes engine/runtime integration while preserving user-owned coordination state.

Keep by default:

```text
agents/bots/
```

Remove or disable:

```text
scripts/ai-verse-bots/
runtime/ai-verse-bots/
runtime adapters/registry integration
```

A separate explicit purge operation can remove Bot/room history after warning the operator.

## 20. Layer diagram

```text
                      Operator
                         |
                         v
                AI-Verse Dashboard
                  visual/control
                         |
                         v
                 command boundary
                         |
         +---------------+---------------+
         |                               |
         v                               v
   AI-Verse Brain                 AI-Verse Multiple Bots
 intent/goals/planning             coordination/execution
         |                               |
         +---------------+---------------+
                         |
                AI-Verse OS Core
          workspace / truth / policy
             /          |          \
            v           v           v
       Memory        Skills      Connections
      history      capabilities    systems
```

Multiple Bots sits **beside Brain as an execution coordination layer**, while both remain subordinate to OS workspace and policy boundaries.

## North-star integration rule

> **The Bots layer can coordinate anything the host authorizes, but it never earns the right to redefine who the user is, what the workspace says is true, what a skill means, what a goal is, or what the UI owns.**