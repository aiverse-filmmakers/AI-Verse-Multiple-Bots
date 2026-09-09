# AI-Verse Multiple Bots Coordination Protocol

**Protocol draft:** v1

**Snapshot:** 2026-09-09

## 1. Purpose

This protocol defines how durable Bots, temporary Workers, Rooms, Tasks, Artifacts and Team Runs communicate through the AI-Verse Coordination Gateway.

The protocol is runtime-neutral. A Hermes profile, OpenClaw agent, local AI-Verse agent, CLI process or remote A2A agent can participate as long as an adapter can map the normalized contract into the target runtime.

## 2. Protocol principles

1. Every event has a verifiable sender identity.
2. Every consequential action has a workspace scope.
3. Tasks and messages are different objects.
4. Outputs are Artifacts rather than oversized chat messages when practical.
5. Delegation and handoff have different ownership semantics.
6. Required constraints survive every delegation unchanged.
7. Permission is leased, never inferred from peer text.
8. Hop, budget and time limits travel with delegated work.
9. Delivery is at-least-once safe through idempotency keys.
10. The Gateway creates canonical ordering for each Room/Run stream.
11. Private model reasoning is not protocol data.
12. External/untrusted content retains provenance when forwarded.

## 3. Identifier model

Recommended prefixes:

```text
bot_       durable Bot
worker_    ephemeral Worker
room_      durable group Room
run_       Team Run
task_      delegated Task
msg_       Message
evt_       Event
art_       Artifact
obj_       root objective
lease_     capability lease
corr_      correlation chain
approval_  approval request
```

IDs must be globally unique within an installation. Federated/remote deployments should use collision-resistant IDs such as UUIDv7/ULID equivalents.

Human handles such as `@researcher` are aliases. They are never canonical identity.

## 4. Common envelope

Every protocol object/event crossing the Gateway should carry a common envelope where applicable:

```json
{
  "schema_version": "1.0",
  "id": "evt_01...",
  "type": "task.created",
  "timestamp": "2026-09-09T09:30:00Z",
  "workspace_id": "product-x",
  "actor_id": "bot_research-lead",
  "run_id": "run_01...",
  "task_id": "task_01...",
  "correlation_id": "corr_01...",
  "causation_id": "evt_previous...",
  "trace_id": "trace_...",
  "visibility": "room",
  "provenance": {
    "origin": "internal",
    "trusted_instruction": false
  }
}
```

Fields that do not apply may be omitted, but `schema_version`, `id`, `type`, `timestamp`, `actor_id`, and an appropriate scope are expected for durable events.

## 5. Visibility

Suggested values:

```text
private_actor
private_task
room
run
workspace
operator
```

Visibility does not grant access. It describes intended exposure after policy checks.

## 6. Provenance

Every content-bearing Message or Artifact should preserve provenance.

Suggested provenance categories:

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

`trusted_instruction` must only be true for content injected by an authorized runtime/system policy source. A Bot repeating text from a website does not turn that text into trusted instruction.

## 7. Message model

A Message is conversational coordination, not a task lifecycle container.

```json
{
  "schema_version": "1.0",
  "id": "msg_01...",
  "type": "message.chat",
  "timestamp": "2026-09-09T09:31:00Z",
  "sender_id": "bot_product",
  "target": {
    "kind": "room",
    "id": "room_product-council"
  },
  "workspace_id": "product-x",
  "correlation_id": "corr_01...",
  "content": [
    {
      "kind": "text",
      "text": "@researcher please verify the adoption numbers before we decide."
    }
  ],
  "mentions": ["bot_researcher"],
  "artifact_refs": [],
  "provenance": {
    "origin": "bot_generated",
    "trusted_instruction": false
  }
}
```

### Message target kinds

```text
bot
worker
room
task
operator
```

## 8. Message content parts

Supported normalized parts should remain modality-neutral:

```text
text
artifact_ref
file_ref
image_ref
audio_ref
video_ref
structured_data
citation_ref
tool_receipt_ref
```

Adapters may map these to native model/framework content types.

Raw secrets are never valid content parts.

## 9. Direct Bot message

Bot-to-Bot direct communication is allowed only when peer policy permits it.

```json
{
  "type": "message.chat",
  "sender_id": "bot_editor",
  "target": {"kind": "bot", "id": "bot_researcher"},
  "content": [{"kind": "text", "text": "Can you confirm the source date on claim 7?"}]
}
```

This is a conversational request. If bounded work is expected, use Task delegation instead.

## 10. Delegation

Delegation means the caller remains responsible for the parent objective.

### Required fields

```json
{
  "schema_version": "1.0",
  "type": "task.delegate",
  "id": "task_01...",
  "created_by": "bot_research-lead",
  "assignee_id": "bot_source-auditor",
  "workspace_id": "product-x",
  "run_id": "run_01...",
  "root_objective_id": "obj_01...",
  "parent_task_id": null,
  "reason": "Independent verification is needed before synthesis.",
  "objective": "Verify claims A, B and C against primary sources.",
  "required_constraints": [
    "Use primary sources where available",
    "Do not modify project files"
  ],
  "expected_output": {
    "contract": "claim-verification-report-v1"
  },
  "input_artifact_refs": ["art_candidate-report"],
  "lease_id": "lease_01...",
  "hop": 1,
  "max_hops": 6,
  "budget": {
    "token_limit": 25000,
    "wall_clock_seconds": 180
  }
}
```

### Constraint law

`required_constraints` are inherited immutably by descendants unless the operator/authorized policy explicitly changes the root objective.

A child Task may add stricter constraints. It may not remove parent required constraints.

## 11. Task lifecycle

Normalized states:

```text
created
assigned
accepted
running
waiting_input
waiting_approval
blocked
completed
failed
canceled
timeout
budget_exhausted
rejected_policy
```

Suggested transitions:

```text
created -> assigned -> accepted -> running
running -> waiting_input -> running
running -> waiting_approval -> running
running -> completed
running -> failed
running -> blocked
any active -> canceled
after deadline -> timeout
after budget ceiling -> budget_exhausted
before execution -> rejected_policy
```

Adapters may have richer native states, but must map them into these normalized states for callers.

## 12. Task status event

```json
{
  "type": "task.progress",
  "task_id": "task_01...",
  "actor_id": "bot_source-auditor",
  "status": "running",
  "summary": "Primary sources found for two of three claims; checking claim C.",
  "progress": {
    "completed_units": 2,
    "total_units": 3
  }
}
```

Progress summaries are explicit model/runtime outputs, not hidden reasoning traces.

## 13. Task result

A completed Task should return structured metadata plus Artifacts.

```json
{
  "type": "task.completed",
  "task_id": "task_01...",
  "actor_id": "bot_source-auditor",
  "status": "completed",
  "summary": "Two claims verified; claim C contradicted by the primary source.",
  "artifact_refs": ["art_verification-report"],
  "constraint_check": {
    "passed": true,
    "violations": []
  }
}
```

## 14. Artifact model

```json
{
  "schema_version": "1.0",
  "id": "art_verification-report",
  "type": "artifact",
  "workspace_id": "product-x",
  "created_by": "bot_source-auditor",
  "run_id": "run_01...",
  "task_id": "task_01...",
  "media_type": "application/json",
  "kind": "claim_verification_report",
  "version": 1,
  "content_ref": "workspace-artifact:...",
  "digest": "sha256:...",
  "provenance": {
    "origin": "bot_generated",
    "source_refs": ["source_1", "source_2"]
  }
}
```

The coordination layer may store small inline artifacts, but large/canonical outputs should normally be referenced through host storage handles.

## 15. Artifact mutation

When an existing artifact is mutable, every write declares a base version.

```json
{
  "type": "artifact.patch",
  "artifact_id": "art_report",
  "base_version": 7,
  "patch_ref": "art_patch_01"
}
```

If current version is not 7, Gateway returns `ARTIFACT_CONFLICT`.

Do not silently last-write-wins on concurrent agent edits.

## 16. Handoff

Handoff transfers active responsibility.

### Request

```json
{
  "type": "handoff.request",
  "id": "evt_...",
  "from_agent_id": "bot_triage",
  "to_agent_id": "bot_legal",
  "workspace_id": "contract-review",
  "root_objective_id": "obj_...",
  "reason": "The remaining question requires legal-contract specialization.",
  "required_constraints": [
    "Do not send external communications",
    "Use the approved contract workspace only"
  ],
  "context_selection": {
    "recent_messages": 8,
    "artifact_refs": ["art_contract", "art_issue-list"]
  },
  "return_policy": "stay_with_target",
  "lease_id": "lease_..."
}
```

### Accepted

```json
{
  "type": "handoff.accepted",
  "handoff_id": "evt_...",
  "actor_id": "bot_legal"
}
```

### Rejected

```json
{
  "type": "handoff.rejected",
  "handoff_id": "evt_...",
  "actor_id": "bot_legal",
  "reason_code": "CAPABILITY_UNAVAILABLE"
}
```

The Gateway does not make the target current owner until acceptance or an adapter-specific atomic transfer succeeds.

## 17. Return policy

Suggested values:

```text
stay_with_target
return_to_sender_after_task
return_to_leader
operator_decides
```

A manager calling a specialist normally uses delegation, not handoff with `return_to_sender_after_task`.

## 18. Room model

A Room has:

- unique ID;
- workspace scope;
- member list;
- optional leader;
- speaker policy;
- round/message/time budgets;
- canonical ordered event stream.

A Room does not copy member credentials or merge member memories.

## 19. Room message ordering

The Gateway assigns a monotonic `room_sequence` after accepting a Room event.

```json
{
  "type": "message.chat",
  "room_id": "room_product-council",
  "room_sequence": 184,
  "sender_id": "bot_product",
  "mentions": ["bot_researcher"]
}
```

Clients may optimistically render pending messages, but canonical order comes from Gateway acceptance.

## 20. Room speaker scheduling

Default selective scheduler:

1. parse explicit mentions from accepted Message;
2. resolve handles to member IDs;
3. enqueue explicitly mentioned Bots first;
4. if no Bot was explicitly mentioned, apply relevance policy to room members;
5. each selected participant receives a context packet and may `reply`, `pass`, `delegate`, `handoff`, `publish_artifact`, or `escalate_user`;
6. new Bot mentions enqueue eligible members for the next bounded continuation;
7. a full eligible round with no substantive response settles the turn;
8. hard message/round/time/budget caps terminate the turn even if agents keep talking;
9. unresolved mandatory mention at a cap becomes a visible `room.unresolved_mention` event, not a silent drop.

## 21. Pass semantics

A Bot should be allowed to say nothing without generating a social filler message.

Normalized response:

```json
{
  "type": "room.pass",
  "room_id": "room_product-council",
  "actor_id": "bot_finance",
  "reason_code": "NO_ADDITIONAL_VALUE"
}
```

Suggested reason codes:

```text
NO_ADDITIONAL_VALUE
OUT_OF_SCOPE
AWAITING_OTHER_AGENT
INSUFFICIENT_CONTEXT
CONFLICT_OF_ROLE
```

Pass events may be hidden from normal user chat while remaining visible in traces.

## 22. User escalation

A Bot can request operator input explicitly.

```json
{
  "type": "user.escalation",
  "actor_id": "bot_researcher",
  "room_id": "room_product-council",
  "question": "Should I include the private customer interview notes in this analysis?",
  "reason": "The room objective is ambiguous about use of restricted internal interviews.",
  "blocks": ["task_01..."]
}
```

The Room/Run moves affected Tasks to `waiting_input` rather than spinning.

## 23. Approval request

High-risk action:

```json
{
  "type": "approval.requested",
  "id": "approval_01...",
  "actor_id": "bot_marketing",
  "workspace_id": "brand",
  "task_id": "task_...",
  "action": {
    "kind": "external_publish",
    "target": "company-social-account"
  },
  "summary": "Publish the approved campaign copy.",
  "expires_at": null
}
```

No execution until approval policy returns authorized.

## 24. Team Run model

```json
{
  "schema_version": "1.0",
  "id": "run_01...",
  "type": "team_run",
  "workspace_id": "research",
  "root_objective_id": "obj_01...",
  "leader_id": "bot_research-lead",
  "topology": "dynamic_squad",
  "status": "running",
  "budget": {
    "max_workers": 5,
    "max_hops": 6,
    "max_messages": 30,
    "wall_clock_seconds": 600,
    "token_limit": 150000,
    "cost_limit": 5.00
  }
}
```

Budgets are examples, not global defaults.

## 25. Grok-style dynamic squad protocol

### Stage 1: collaboration decision

```json
{
  "type": "run.topology_selected",
  "decision": "multi_agent",
  "topology": "dynamic_squad",
  "reason": "The question needs independent technical, market and legal evidence streams."
}
```

If not justified:

```json
{
  "decision": "single_agent",
  "reason": "One specialist has sufficient capability and independent fan-out adds little value."
}
```

### Stage 2: plan

Leader creates distinct Tasks.

Workers should not all receive the same broad assignment unless independent solution diversity is the objective.

### Stage 3: parallel execution

Tasks run concurrently subject to worker/budget limits.

### Stage 4: conflict/gap analysis

Leader compares structured results and identifies:

- agreement;
- contradiction;
- missing evidence;
- low-confidence claims.

### Stage 5: selective second pass

Only unresolved gaps trigger follow-up/reviewer Tasks.

Do not automatically make all Workers debate each other.

### Stage 6: synthesis

Leader produces a candidate final Artifact with evidence references.

### Stage 7: verification

Optional verifier compares final Artifact against the original objective and immutable constraints.

### Stage 8: complete

Run emits final result and candidate write-backs.

## 26. Worker creation

A Worker is created only inside a run/task scope.

```json
{
  "type": "worker.created",
  "worker_id": "worker_source-auditor-2",
  "run_id": "run_01...",
  "parent_agent_id": "bot_research-lead",
  "role": "Independent primary-source auditor",
  "model_policy_ref": "fast-research",
  "lease_id": "lease_..."
}
```

Worker has no durable Room membership and no automatic memory write authority.

## 27. Worker promotion

If an ephemeral role proves useful, promotion into a durable Bot is a separate operator/policy-approved action.

```json
{
  "type": "bot.promotion_requested",
  "source_worker_id": "worker_source-auditor-2",
  "proposed_bot_id": "bot_source-auditor"
}
```

No automatic permanent roster growth.

## 28. Capability lease

```json
{
  "schema_version": "1.0",
  "id": "lease_01...",
  "principal": "operator_local",
  "issued_to": "worker_source-auditor-2",
  "workspace_id": "product-x",
  "task_id": "task_01...",
  "tools": ["web.search", "web.fetch"],
  "connections": [],
  "filesystem": {
    "read_handles": ["artifact:candidate-report"],
    "write_handles": ["run-artifacts:task_01"]
  },
  "destructive_actions": "deny",
  "expires_at": "2026-09-09T10:00:00Z"
}
```

Lease cannot contain authority unavailable under host/workspace/Bot policy.

## 29. Hop control

Every delegated child increments `hop`.

If:

```text
hop >= max_hops
```

new delegation/handoff is rejected with:

```text
HOP_LIMIT_EXCEEDED
```

A Bot may still finish its current Task or escalate to the leader/operator.

## 30. Loop detection

Gateway should detect at minimum:

### Pair ping-pong

```text
A -> B -> A -> B
```

with substantially unchanged objective.

### Cycle

```text
A -> B -> C -> A
```

### Duplicate delegation

Same parent creates semantically/effectively identical Task for same assignee after result already exists.

### No progress

N consecutive collaboration events produce no new Artifact, source, test result, decision, or meaningful state transition.

Detection emits:

```json
{
  "type": "run.loop_detected",
  "pattern": "PAIR_PING_PONG",
  "participants": ["bot_a", "bot_b"],
  "action": "RETURN_TO_LEADER"
}
```

## 31. Budget events

Suggested thresholds:

```text
run.budget_warning
run.budget_exhausted
```

Warning contains remaining resources but must not expose provider secrets.

At exhaustion:

1. stop spawning new Workers;
2. cancel non-essential follow-ups;
3. allow policy-defined synthesis from completed work if safe;
4. mark incomplete evidence explicitly;
5. return control.

## 32. Cancellation

```json
{
  "type": "run.cancel_requested",
  "run_id": "run_01...",
  "requested_by": "operator_local",
  "mode": "graceful"
}
```

Modes:

```text
graceful
hard
```

Gateway propagates cancellation to child Tasks and adapters.

Adapters unable to cancel remotely must mark that limitation explicitly.

## 33. Delivery semantics

### Idempotency

Mutating client requests carry:

```text
idempotency_key
```

Gateway stores request/result mapping long enough to prevent duplicate Bot messages/tasks caused by retries.

### Delivery

Internal event transport should be at-least-once safe.

Consumers deduplicate by event ID.

### Ordering

Global total ordering is unnecessary.

Require monotonic sequence within:

- each Room event stream;
- each Team Run event stream.

Cross-room ordering is by timestamp/trace only and may be concurrent.

## 34. Retry policy

Retries are classified.

### Safe automatic retry

- transient network failure;
- model provider timeout before accepted action;
- idempotent read/tool call;
- remote task status fetch.

### Requires idempotency receipt

- sending a message;
- creating a Task;
- publishing an Artifact;
- calling external mutation APIs.

### Never blindly retry

- payment;
- destructive action;
- external publication;
- email/message send;
- permission change.

The underlying tool/host policy remains authoritative.

## 35. Error model

Normalized error codes should include:

```text
NOT_FOUND
IDENTITY_AMBIGUOUS
AGENT_OFFLINE
AGENT_BUSY
CAPABILITY_UNAVAILABLE
POLICY_DENIED
WORKSPACE_DENIED
LEASE_EXPIRED
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
CANCELED
```

Every error contains a safe human-readable summary and machine-readable code.

## 36. Remote A2A mapping

When an AI-Verse Task is delegated to A2A peer:

```text
AI-Verse Task -> A2A Task
AI-Verse Message -> A2A Message
AI-Verse Artifact -> A2A Artifact
AI-Verse content part -> A2A Part
AI-Verse progress events <- A2A streaming/status updates
AI-Verse cancel -> A2A cancel operation when supported
```

AI-Verse workspace/lease metadata uses a namespaced extension and is never interpreted by an external peer as local filesystem access.

The local Gateway remains responsible for deciding exactly what data is transferred.

## 37. Context transfer

### Delegation context

Default contents:

- root objective summary;
- Task objective;
- immutable required constraints;
- selected relevant canonical context;
- selected peer/room messages;
- Artifact references;
- capability lease;
- expected output contract.

### Do not include by default

- full sender conversation history;
- unrelated workspaces;
- sender credentials;
- full private memory;
- other Bots' hidden reasoning;
- every room event since creation.

## 38. Constraint checksum

For consequential runs, immutable constraints can carry a deterministic digest:

```json
{
  "required_constraints": ["...", "..."],
  "constraints_digest": "sha256:..."
}
```

Child Task creation validates the digest/inherited set so a model-generated reformulation cannot silently remove constraints.

## 39. Verification result

```json
{
  "type": "verification.completed",
  "artifact_id": "art_final",
  "verdict": "REVISE",
  "findings": [
    {
      "code": "UNSUPPORTED_CLAIM",
      "summary": "Claim 4 lacks primary evidence.",
      "severity": "high"
    }
  ],
  "constraint_check": {
    "passed": true,
    "violations": []
  }
}
```

Verdicts:

```text
PASS
PASS_WITH_WARNINGS
REVISE
BLOCK
```

## 40. Candidate write-back events

Multiple Bots can propose but not silently canonize:

```text
candidate.memory
candidate.knowledge
candidate.decision
candidate.skill
candidate.context_update
candidate.process_improvement
```

Each candidate links to source Run/Task/Event/Artifact IDs.

## 41. Presence events

Presence is ephemeral:

```json
{
  "type": "presence.changed",
  "actor_id": "bot_researcher",
  "state": "using_tool",
  "summary": "Researching primary sources"
}
```

States:

```text
offline
idle
thinking
using_tool
waiting
blocked
waiting_user
```

These may be dropped/rebuilt and do not define durable truth.

## 42. Version negotiation

Gateway exposes protocol capabilities:

```json
{
  "protocol": "ai-verse-bots",
  "versions": ["1.0"],
  "features": [
    "rooms",
    "handoffs",
    "parallel_runs",
    "a2a",
    "artifact_versioning"
  ]
}
```

Adapters must fail explicitly if required semantics cannot be represented safely.

Do not silently downgrade a handoff into an ordinary message or drop workspace/permission metadata.

## 43. Protocol conformance tests

Every adapter must pass tests for:

1. identity preservation;
2. scope preservation;
3. required-constraint preservation;
4. cancellation;
5. timeout;
6. idempotent retry;
7. error mapping;
8. Artifact return;
9. Task state mapping;
10. no permission elevation;
11. untrusted provenance preservation;
12. safe unsupported-feature failure.

## North-star protocol rule

> **Bots communicate with explicit identity, scope, objective, constraints, authority, lifecycle and evidence. Agent-to-agent communication is a protocol, not one model prompting another model with an unstructured paragraph.**