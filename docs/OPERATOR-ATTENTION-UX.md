# Operator Approvals and Attention UX Contract

**Phase:** 5.11

**Status:** COMPLETE IMPLEMENTATION, ACCEPTANCE PENDING CI

## Purpose

Phase 5.11 turns existing canonical approval, task, handoff, execution and attention state into a compact operator-facing queue.

The core rule is:

```text
Operator UX
  = derived attention + routed canonical controls

Operator UX
  != notification database
  != approval authority
  != task store
  != scheduler
  != second source of truth
```

Multiple Bots remains canonical for Approval, Task, Handoff and coordination-event lifecycle.

## Priority order

The operator queue follows the existing architecture priority:

```text
needs_approval
needs_input
blocked
failed
handoff_waiting
unread_result
```

This ordering is deterministic and returned by the capability/snapshot contracts.

## Public Gateway surfaces

### Capabilities

```text
GET /v1/operator/capabilities?workspace=<workspace-id>
```

Reports:

- provider/schema;
- priority order;
- operator queries;
- dedicated Approval decision controls;
- existing coordination controls used by attention items;
- event-cursor/realtime integration.

### Attention queue

```text
GET /v1/operator/attention?workspace=<workspace-id>&after=<event-cursor>
```

Returns a read-only workspace projection with:

- current actionable attention;
- deterministic priority order;
- per-state counts;
- source identity;
- Task/Run/Room/Thread references when available;
- compact summary;
- canonical controls where applicable;
- current event cursor.

Current-state attention is derived from canonical objects:

- pending Approval -> `needs_approval`;
- Task `waiting_input` -> `needs_input`;
- Task `blocked` -> `blocked`;
- Task `failed`, `timeout`, `budget_exhausted`, or `rejected_policy` -> `failed`;
- requested Handoff -> `handoff_waiting`.

Transient event notices use canonical coordination events after the caller's cursor.

This is how `unread_result` and event-only attention can be surfaced without storing UI read/unread state in Multiple Bots.

## Read/unread law

Multiple Bots does not create a durable notification/read database.

Instead:

1. canonical coordination emits attention-bearing events;
2. the client records the last event cursor it has consumed;
3. `after=<cursor>` returns newer event notices;
4. current actionable state remains visible regardless of cursor.

This preserves the architecture rule that visual UI state is derived/disposable.

## Approval queue

```text
GET /v1/operator/approvals?workspace=<workspace-id>&status=pending
```

Supported filters:

- `pending`
- `approved`
- `denied`

Each Approval card includes:

- Approval status;
- related Task status/objective;
- assignee and owner;
- requester and approval actor;
- request/decision timestamps;
- reason;
- action kind and summary;
- rejection reason when applicable;
- currently legal controls.

The surface is intentionally compact. It does not expose arbitrary provider secrets, hidden runtime state, or model reasoning.

## Approval decision

```text
POST /v1/operator/approvals/:approval-id/decision
```

Approve example:

```json
{
  "workspaceId": "workspace-a",
  "actorId": "operator_dashboard",
  "decision": "approve"
}
```

Deny example:

```json
{
  "workspaceId": "workspace-a",
  "actorId": "operator_dashboard",
  "decision": "deny",
  "reason": "Revise the customer-facing copy first"
}
```

The endpoint does not own approval mutation.

It routes to:

```text
CoordinationGateway.approve
CoordinationGateway.rejectApproval
```

Therefore existing approval invariants remain authoritative:

- only `operator_*` actors can decide;
- only pending Approvals can be decided;
- workspace scope is checked before mutation;
- approval grants queue the Task through the canonical lifecycle;
- denial cancels the Task through the canonical lifecycle;
- canonical events remain the audit trail.

## Blocked work controls

Blocked attention can expose:

- `task.retry`, only when the execution is dead-lettered, retry-safe and below its attempt ceiling;
- `task.cancel`.

Those controls already exist in the Phase 5.9 canonical control router at:

```text
POST /v1/dashboard/control
```

Phase 5.11 does not create another retry/cancellation engine.

## Event-derived notices

Attention-bearing events can represent situations that do not have one durable notification object, for example:

- unresolved/ambiguous Room mention;
- rejected Handoff result;
- recovery/system failure;
- completed result that should be surfaced.

The operator projection uses the caller-provided event cursor for these notices.

A current Task/Approval/Handoff item takes precedence over an equivalent event notice so the queue does not duplicate the same actionable work.

## Workspace isolation

Every operator query requires an explicit workspace.

Approval decisions require:

- explicit workspace;
- exact Approval identity;
- Approval ownership by that workspace;
- an explicit `operator_*` actor identity.

Cross-workspace decisions fail before canonical mutation.

## Transport authentication

Gateway transport authentication and operator authority remain separate:

```text
bearer-authenticated request
  != operator identity
  != workspace authority
  != approval grant
```

The Phase 5.8 Gateway bearer boundary still protects these endpoints when remote access is enabled.

## No hidden reasoning

Attention summaries are built from canonical:

- Approval action/reason;
- Task objective/failure state;
- execution error receipt;
- Handoff reason;
- coordination event summary.

The surface does not expose private model chain-of-thought.

## Acceptance target

Phase 5.11 is accepted when:

- operator priority order is deterministic;
- current Approval/Input/Blocked/Failed/Handoff state is projected;
- event-cursor notices work without a read-state database;
- rich Approval cards include enough decision context;
- cross-workspace Approval decisions fail closed;
- non-operator decisions fail closed;
- approve and deny route through canonical Gateway methods;
- blocked retry is advertised only when canonically legal;
- projection reads create no coordination state;
- installed-package operator attention/approval smoke passes;
- full repository and Phase 4 compatibility suites remain green.
