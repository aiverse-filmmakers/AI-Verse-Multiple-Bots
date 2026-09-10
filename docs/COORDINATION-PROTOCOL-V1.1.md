# AI-Verse Multiple Bots Coordination Protocol v1.1

**Status:** Current implementation-aligned protocol

**Snapshot:** 2026-09-10

This revision extends the original coordination protocol for the persistent-teammate architecture discovered during the Grok Bot deep dive and now reflects the completed Phase 2 squad runtime.

The machine-readable companion is:

- `schemas/coordination-v1.schema.json`

The original `COORDINATION-PROTOCOL.md` remains useful background for delegation, Tasks, Artifacts, events, budgets, cancellation and A2A mapping. This document is the current protocol direction when the two differ.

Unless an example explicitly includes every required schema field, treat it as an illustrative excerpt. Complete Bot and Room manifest examples live in `templates/bot.yaml` and `templates/room.yaml`. Protocol objects intended as wire examples should remain schema-compatible.

## 1. Protocol goals

A persistent Bot system must support more than synchronous agent delegation.

The protocol must represent:

- durable Bot identity;
- one stable direct conversation per Bot;
- asynchronous Bot-to-Bot delivery;
- Rooms;
- Threads;
- explicit work ownership;
- Tasks;
- delegation;
- handoff;
- temporary Workers;
- Team Runs;
- Artifacts;
- capability leases;
- execution-environment leases;
- approvals;
- presence;
- human attention state;
- cancellation;
- structured observability;
- remote interoperability.

## 2. Core laws

1. Identity is explicit and machine-resolved.
2. Workspace scope is trusted runtime state.
3. Messages are not Tasks.
4. Tasks are not Artifacts.
5. Delegation is not handoff.
6. Durable Bots are not temporary Workers.
7. Every active work item has an owner.
8. Required constraints survive delegation unchanged.
9. Permission is leased, not inferred from peer text.
10. Execution environment access is leased, not invented by the model.
11. External/untrusted provenance survives forwarding.
12. Delivery is idempotent and retry-safe.
13. Room/Run streams have canonical local ordering.
14. Private model reasoning is not protocol data.
15. Consequential actions can be intercepted outside the acting Bot.
16. Multi-agent work is centrally budgeted, hierarchically cancelable, and terminally fenced.

## 3. Recommended IDs

```text
bot_         durable Bot
worker_      temporary Worker
room_        Room
thread_      Thread
conv_        durable direct conversation
run_         Team Run
task_        Task
handoff_     Handoff
msg_         Message
evt_         Event
art_         Artifact
obj_         root objective
lease_       capability lease
envlease_    environment lease
approval_    approval request
corr_        correlation chain
trace_       trace
```

Human handles such as `@researcher` are aliases. They are never canonical identity.

## 4. Durable Bot address

A Bot has one stable addressable identity regardless of runtime/provider changes.

Illustrative excerpt:

```json
{
  "id": "bot_research-lead",
  "name": "Research Lead",
  "status": "active",
  "role": {
    "title": "Research Lead",
    "mission": "Own evidence-heavy research and synthesis."
  },
  "runtime": {
    "adapter": "native"
  },
  "execution": {
    "environment_policy": "shared_workspace",
    "environment_ref": "host-default"
  },
  "scope": {
    "type": "workspace",
    "workspace_id": "product-x"
  }
}
```

Changing the model/runtime does not create a new teammate identity unless the operator explicitly creates another Bot.

## 5. Direct Bot conversation

A durable Bot has one canonical direct-conversation stream per applicable scope.

The stream can contain heterogeneous events:

- user/Bot Messages;
- Artifact publications;
- Task state;
- approvals;
- handoffs;
- Routine/Automation events;
- compact execution summaries;
- environment preview/takeover events;
- errors;
- completion events.

The UI may render each event differently. The backend does not flatten them all into Markdown text.

## 6. Asynchronous Bot mailbox

Bot-to-Bot communication must not require both Bots to be actively executing at the same instant.

### Delivery states

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

### Example peer Message

```json
{
  "schema_version": "1.0",
  "id": "msg_01...",
  "type": "message.chat",
  "timestamp": "2026-09-09T10:00:00Z",
  "sender_id": "bot_product-lead",
  "target": {
    "kind": "bot",
    "id": "bot_research-lead"
  },
  "workspace_id": "product-x",
  "delivery_state": "queued",
  "content": [
    {
      "kind": "text",
      "text": "Please check whether the competitor pricing changed this week."
    }
  ],
  "provenance": {
    "origin": "bot_generated",
    "trusted_instruction": false
  }
}
```

If the request expects bounded work with lifecycle/result guarantees, create a Task instead of relying only on a conversational Message.

## 7. Idempotent delivery

Every mutating client/Gateway request carries an idempotency key or stable request ID.

Retrying a timed-out send must not create duplicate peer Tasks/messages.

Internal consumers deduplicate by event ID.

At-least-once event transport is acceptable if consumers are idempotent.

## 8. Room

A Room is a durable shared coordination stream.

Required concepts:

- workspace scope;
- members;
- optional leader;
- work-owner policy;
- canonical sequence;
- mention routing;
- Thread support;
- budgets;
- attention/escalation settings.

Illustrative excerpt:

```yaml
id: product-council
scope:
  type: workspace
  workspace_id: product-x
members:
  - product-lead
  - research-lead
  - finance-analyst
orchestration:
  mode: conversational
  speaker_policy: selective
  work_owner_policy: explicit_single_owner
threads:
  enabled: true
```

## 9. Room event ordering

The Gateway assigns a monotonic `room_sequence` after accepting an event.

Clients may render pending local messages optimistically, but canonical order comes from the Gateway.

Global total ordering across unrelated Rooms is unnecessary.

## 10. Thread

A Thread is a focused branch attached to a parent Message in a Room or direct Bot conversation.

Example:

```json
{
  "schema_version": "1.0",
  "id": "thread_01...",
  "type": "thread",
  "workspace_id": "product-x",
  "room_id": "room_product-council",
  "parent_message_id": "msg_01...",
  "created_by": "operator_local",
  "status": "active"
}
```

Threads inherit parent workspace scope by default.

Use Threads for one subproblem, one Artifact review, one handoff, one approval or one blocker.

## 11. Reply semantics

A Message can contain:

```json
{
  "thread_id": "thread_01...",
  "reply_to_message_id": "msg_parent..."
}
```

`reply_to_message_id` gives conversational relation.

`thread_id` gives branch membership.

They are related but not interchangeable.

## 12. Mentions

Mentions are resolved by the Gateway from human aliases to canonical Bot IDs.

Ambiguous aliases fail visibly.

Explicit mentions receive priority in Room speaker scheduling.

An unresolved mandatory mention at a hard cap becomes a `room.unresolved_mention` event rather than disappearing silently.

## 13. Pass

A Bot can decline to add a conversational response.

```json
{
  "type": "room.pass",
  "room_id": "room_product-council",
  "actor_id": "bot_finance",
  "reason_code": "NO_ADDITIONAL_VALUE"
}
```

Possible reasons:

```text
NO_ADDITIONAL_VALUE
OUT_OF_SCOPE
AWAITING_OTHER_AGENT
INSUFFICIENT_CONTEXT
CONFLICT_OF_ROLE
```

Pass events may remain hidden from the normal chat UI while staying visible in trace/audit views.

## 14. Explicit work ownership

Every active Task/work item has one owner.

```json
{
  "work_item_id": "task_01...",
  "owner_id": "worker_source-auditor",
  "collaborator_ids": [
    "bot_finance"
  ]
}
```

For a delegated child Task, `owner_id` identifies the actor accountable for that child Task. The delegating Bot can still retain ownership of the parent Task, root objective, or final user-facing synthesis. Only a handoff changes ownership of the handed-off work item.

A collaborator contributes but does not automatically gain authority to finalize, send or publish the owner's work.

## 15. Delegation

Delegation creates bounded work while the caller retains ownership of the parent/root work unless an explicit handoff occurs.

Required:

- creator;
- assignee;
- owner for the delegated Task;
- workspace;
- root objective;
- reason;
- objective;
- immutable required constraints;
- expected output;
- Artifact inputs;
- capability lease;
- environment lease when execution requires it;
- hop/max hops;
- budget;
- deadline when relevant.

For a normal delegated child Task, `owner_id` will usually equal `assignee_id`.

Example:

```json
{
  "schema_version": "1.0",
  "id": "task_01...",
  "type": "task.delegate",
  "created_by": "bot_research-lead",
  "assignee_id": "worker_source-auditor",
  "owner_id": "worker_source-auditor",
  "workspace_id": "product-x",
  "root_objective_id": "obj_01...",
  "reason": "Independent primary-source verification is required.",
  "objective": "Verify claims A, B and C.",
  "required_constraints": [
    "Use primary sources where available",
    "Do not modify project files"
  ],
  "expected_output": {
    "contract": "claim-verification-report-v1"
  },
  "lease_id": "lease_01...",
  "environment_lease_id": "envlease_01...",
  "hop": 1,
  "max_hops": 6,
  "status": "assigned"
}
```

## 16. Immutable constraints

Required constraints descend unchanged.

A child Task can add stricter constraints. It cannot silently remove an inherited required constraint.

Consequential runs can carry a digest of the inherited required-constraint set.

The verifier compares final output against the original root constraints.

## 17. Handoff

Handoff transfers active responsibility.

Lifecycle:

```text
handoff.requested
  -> handoff.accepted
  -> ownership.changed
```

or:

```text
handoff.requested
  -> handoff.rejected
```

Required handoff metadata:

- source owner;
- target Bot/Worker as permitted by topology;
- reason;
- root objective;
- immutable constraints;
- selected context;
- Artifact references;
- capability/environment lease;
- return policy.

Structured handoff request example:

```json
{
  "schema_version": "1.0",
  "id": "handoff_01...",
  "type": "handoff",
  "source_owner_id": "bot_research-lead",
  "target_bot_id": "bot_legal-reviewer",
  "workspace_id": "product-x",
  "root_objective_id": "obj_01...",
  "reason": "The next stage requires legal review ownership.",
  "required_constraints": [
    "Do not publish externally",
    "Preserve all cited source references"
  ],
  "artifact_refs": ["art_research-report"],
  "capability_lease_id": "lease_legal-review",
  "environment_lease_id": null,
  "return_policy": "return_on_completion",
  "status": "requested"
}
```

The target becomes owner only after acceptance and the ownership transition is recorded atomically by the Gateway/adapter boundary.

## 18. Capability lease

Capability authority is task-scoped.

```json
{
  "id": "lease_01...",
  "type": "capability_lease",
  "principal": "operator_local",
  "issued_to": "worker_source-auditor",
  "workspace_id": "product-x",
  "task_id": "task_01...",
  "tools": ["web.search", "web.fetch"],
  "connections": [],
  "destructive_actions": "deny",
  "expires_at": "2026-09-09T11:00:00Z"
}
```

Effective authority remains the intersection of host, workspace, Bot and Task policy.

A Team Run terminal fence may revoke a run-scoped capability lease before its original expiry. Revocation is durable protocol state; later retry/recovery must not treat the lease as active.

## 19. Environment lease

Execution access is independent from capability instructions.

```json
{
  "id": "envlease_01...",
  "type": "environment_lease",
  "issued_to": "worker_source-auditor",
  "workspace_id": "product-x",
  "task_id": "task_01...",
  "environment_policy": "isolated_run",
  "environment_ref": "env_01...",
  "expires_at": "2026-09-09T11:00:00Z"
}
```

Supported policy classes:

```text
shared_workspace
isolated_bot
isolated_run
external_managed
```

Environment references are created/resolved by trusted runtime infrastructure, never model-authored free text.

On Team Run termination, run-exclusive environment authority is revoked. A shared environment lease may remain active only when canonical state proves it is still referenced outside the terminating Team Run; termination must not destroy authority still required by another run.

## 20. Environment events

Optional normalized events for computer-use runtimes:

```text
environment.started
environment.activity
environment.preview_available
environment.takeover_requested
environment.takeover_granted
environment.control_returned
environment.stopped
```

Sensitive screenshots or session material remain subject to host policy/redaction.

## 21. Approval

Consequential action can create an approval object.

```json
{
  "id": "approval_01...",
  "type": "approval",
  "workspace_id": "brand",
  "actor_id": "bot_marketing",
  "task_id": "task_01...",
  "status": "pending",
  "action": {
    "kind": "external_publish",
    "summary": "Publish the approved campaign post."
  }
}
```

Possible states:

```text
pending
approved
denied
expired
canceled
```

The acting Bot is not the sole authority deciding whether its own high-risk action is safe.

A pending Approval attached to a Team Run Task becomes non-actionable when that Team Run is terminally canceled or budget-exhausted.

## 22. Presence

Presence is ephemeral runtime state.

Suggested values:

```text
offline
idle
thinking
using_tool
waiting
blocked
```

Presence can be rebuilt after restart and does not define durable truth.

## 23. Attention state

Attention is a user-facing projection derived from durable/runtime events.

```text
none
working
unread_result
needs_input
needs_approval
handoff_waiting
failed
```

Example event:

```json
{
  "type": "attention.changed",
  "actor_id": "bot_finance",
  "workspace_id": "finance",
  "attention_state": "needs_approval",
  "summary": "Expense report is ready to submit."
}
```

Clients should default to this level of information and expose full traces on demand.

## 24. Activation sources

A Bot invocation can originate from:

```text
user
brain
os_automation
external_event
peer_bot_message
peer_bot_handoff
```

Activation source is recorded in the root event/trace so background work remains attributable.

Every source enters the same Gateway policy/scope/budget path.

## 25. Worker

A Worker is ephemeral and run-scoped.

Worker creation records:

- parent owner/leader;
- role;
- Task;
- model/runtime selection;
- capability lease;
- environment lease;
- budget;
- output contract.

It has no default long-term memory write authority and no durable Room membership.

A Worker used for an explicitly bounded multi-turn discussion may return to a nonterminal `waiting` state between its scheduled turns. That does not make it durable; it remains scoped to the same Team Run and becomes terminal when the bounded discussion/run lifecycle closes.

Promotion into a permanent Bot is a separate approved operation.

## 26. Team Run

Team Run lifecycle:

```text
created
planning
running
waiting_input
waiting_approval
synthesizing
verifying
completed
failed
canceled
budget_exhausted
```

A Team Run records:

- root objective;
- durable owner/leader;
- topology;
- participants;
- Tasks;
- budgets;
- Artifacts;
- verification debt/result;
- final result;
- candidate write-backs;
- terminal cleanup/termination evidence when applicable.

All run-scoped execution, regardless of whether the current Task owner is a Worker or durable Bot, remains subordinate to the Team Run's aggregate budget and terminal state.

## 27. Collaboration topology event

Before fan-out:

```json
{
  "type": "run.topology_selected",
  "run_id": "run_01...",
  "decision": "multi_agent",
  "topology": "dynamic_squad",
  "reason": "Independent technical, market and legal evidence is required."
}
```

Or:

```json
{
  "decision": "single_agent",
  "reason": "The assigned specialist can solve the task reliably without coordination overhead."
}
```

The adaptive decision layer chooses only supported bounded topology shapes and must fail closed when declared authority/budget/hop/identity capacity cannot safely execute the selected shape.

## 28. Dynamic squad

Protocol stages:

1. select topology;
2. create distinct Worker Tasks where justified;
3. execute subject to the shared Team Run budget;
4. publish structured Artifacts;
5. analyze conflicts/gaps;
6. selectively create follow-up/reviewer Tasks;
7. verify when required;
8. synthesize one canonical result;
9. complete or terminally stop;
10. clean temporary authority/state without deleting evidence.

Independent Workers should not receive every other Worker's intermediate answer before they have produced their own evidence when independence is valuable.

## 29. Artifact

Artifact is the preferred handoff unit for finished work.

```json
{
  "id": "art_verification",
  "type": "artifact",
  "workspace_id": "product-x",
  "created_by": "worker_source-auditor",
  "run_id": "run_01...",
  "task_id": "task_01...",
  "kind": "claim_verification_report",
  "version": 1,
  "content_ref": "workspace-artifact:...",
  "digest": "sha256:...",
  "provenance": {
    "origin": "worker_generated",
    "trusted_instruction": false,
    "source_refs": ["source_primary_1"]
  }
}
```

The coordination layer can store small inline results, but canonical/large outputs should normally use host Artifact/file handles.

Terminal cancellation or cleanup does not delete already-published canonical Artifacts. Partial or failed-run Artifacts remain attributable through run/task/provenance lineage and can be retained according to host policy.

## 30. Artifact concurrency

Mutable Artifact updates declare a base version.

If the current version changed, reject with a conflict instead of silently overwriting another Bot's work.

Parallel research should normally publish separate immutable Artifacts and synthesize later.

## 31. Provenance

Content-bearing Messages/Artifacts preserve origin such as:

```text
canonical_os
operator_input
bot_generated
worker_generated
external_web
external_document
external_message
remote_agent
runtime_tool
```

A Bot repeating untrusted website instructions does not promote them into trusted system instructions.

Peer messages remain below runtime policy/canonical decisions in authority.

## 32. Context transfer

A normal delegation context packet contains:

- root objective;
- Task objective;
- inherited constraints;
- selected canonical current context;
- selected Room/Thread messages;
- Artifact references;
- capability/environment leases;
- expected output contract;
- budget.

Do not include by default:

- every workspace;
- full private memory;
- raw credentials;
- entire sender transcript;
- private model reasoning;
- every historical Room event.

## 33. Loop/runaway prevention

Reject/stop based on:

- hop cap;
- recursion depth;
- Worker cap;
- Task cap;
- message/round cap;
- token/cost/action cap;
- absolute Team Run wall-clock deadline;
- A -> B -> A ping-pong;
- longer cycles;
- duplicate Task creation;
- repeated identical tool action;
- no-progress detector.

Team Run ceilings are aggregate run constraints, not topology-local suggestions. Switching from manager to handoff, fan-out, discussion, verifier, synthesis, Worker ownership, or durable-Bot ownership must not reset or expand the envelope.

Loop/budget detection emits structured state and returns control to the owner/leader/user according to policy.

## 34. Cancellation and terminal Team Run control

Cancellation is hierarchical and run-wide.

The durable Team Run leader and trusted operator may terminate the run. The leader's cancellation authority reaches any same-workspace Task canonically scoped to that Team Run even when a temporary Worker or another durable Bot currently owns/created the Task.

A Team Run cancellation or budget-exhaustion cascade follows these laws:

1. **Fence first.** Persist terminal run state (`canceled` or `budget_exhausted`) before draining work so no new successful execution can start behind the cancellation race.
2. **One envelope.** Token, cost, action, Task, Worker, hop, message, round and wall-clock ceilings remain run-wide across every topology and principal kind.
3. **Absolute wall clock.** A run wall-clock limit is derived from Team Run creation, not reset per Task. Queued Tasks are guarded before execution and running Tasks receive an effective deadline no later than the run deadline.
4. **Drain all run work.** Cancel queued/claimed/running run-scoped Tasks, including Worker-owned work, durable-Bot-owned handoff work, verifier work and synthesis work.
5. **Stop pending authority.** Pending Approvals and active Handoffs attached to run Tasks become non-actionable.
6. **Revoke transient leases.** Run-scoped capability leases expire/revoke. Run-exclusive environment leases revoke; genuinely shared environment leases are preserved only when canonical state shows an external run still references them.
7. **Close temporary surfaces.** Temporary Team Run Rooms and Threads close; active fan-out/verifier/synthesis/discussion-opening pointers are cleared.
8. **Preserve evidence.** Messages, Tasks, Handoffs, Approvals, Workers, Events, canonical Artifacts and provenance remain available for audit. Cleanup may later expire temporary identity without erasing prior terminal status evidence.
9. **No resurrection.** Dead-letter retry, stale recovery and topology reconciliation must refuse to re-enable executable work for a canceled or budget-exhausted Team Run.
10. **Recover termination first.** After restart, pending Team Run termination reconciliation runs before topology recovery and queue draining.
11. **Idempotent audit.** Repeated/retried termination preserves a stable union of what was stopped/revoked/closed and does not duplicate canonical completion events.

A remote adapter should propagate cancellation to the remote call when supported. If a remote runtime cannot cancel, the local terminal fence still removes that late execution's authority to publish a successful canonical result into the stopped Team Run; the adapter limitation must be visible.

## 35. Retry rules

Safe automatic retries:

- transient network read;
- idempotent fetch;
- provider timeout before accepted mutation.

Require idempotency receipt:

- Message send;
- Task creation;
- Artifact publication;
- external mutations.

Never blindly retry financial/destructive/publication operations.

A dead-lettered Task belonging to a canceled or budget-exhausted Team Run is not retryable into executable state. A new explicit run/objective is required if the user wants fresh work after terminal cancellation.

## 36. Remote A2A mapping

```text
AI-Verse external Bot card -> A2A AgentCard
AI-Verse Task              -> A2A Task
AI-Verse Message           -> A2A Message
AI-Verse Artifact          -> A2A Artifact
AI-Verse content part      -> A2A Part
AI-Verse progress          <- A2A status/streaming
AI-Verse cancel            -> A2A cancel when supported
```

Workspace/capability/environment lease metadata uses namespaced extension fields and never grants an external agent arbitrary local filesystem access.

## 37. Adapter conformance

Every adapter must prove:

1. canonical Bot identity preserved;
2. workspace scope preserved;
3. required constraints preserved;
4. delegation vs handoff distinction preserved;
5. cancellation mapped or limitation surfaced;
6. timeout mapped;
7. idempotent retry behavior;
8. Artifact result returned;
9. Task state mapped;
10. permission cannot increase;
11. provenance preserved;
12. environment policy/lease preserved when applicable;
13. unsupported safety-critical features fail explicitly;
14. late remote results cannot bypass a local terminal Team Run fence.

An adapter must never silently downgrade a handoff into an ordinary Message or drop permission/scope metadata.

## 38. Candidate write-backs

The coordination layer may emit:

```text
candidate.context_update
candidate.memory
candidate.knowledge
candidate.decision
candidate.skill
candidate.process_improvement
```

Each candidate links to the Run/Task/Event/Artifact evidence that produced it.

The host layer decides whether to canonize it.

## 39. Normalized errors

Recommended errors include:

```text
NOT_FOUND
IDENTITY_AMBIGUOUS
AGENT_OFFLINE
AGENT_BUSY
CAPABILITY_UNAVAILABLE
POLICY_DENIED
WORKSPACE_DENIED
LEASE_EXPIRED
ENVIRONMENT_UNAVAILABLE
INVALID_SCHEMA
INVALID_STATE_TRANSITION
HOP_LIMIT_EXCEEDED
ROUND_LIMIT_EXCEEDED
MESSAGE_LIMIT_EXCEEDED
BUDGET_EXHAUSTED
DEADLINE_EXCEEDED
LOOP_DETECTED
ARTIFACT_CONFLICT
REMOTE_PROTOCOL_ERROR
ADAPTER_UNAVAILABLE
DELIVERY_EXPIRED
CANCELED
```

## 40. Conformance north star

> **A Bot is a persistent addressable coworker. Work between coworkers travels with explicit identity, scope, owner, objective, constraints, authority, environment, lifecycle, provenance and evidence. Collaboration remains safe and observable even when the user interface is closed.**
