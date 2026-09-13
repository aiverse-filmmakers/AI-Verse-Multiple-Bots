# Dashboard Projection and Control Contract

**Status:** Phase 5.9 complete

**Updated:** 2026-09-13

## Purpose

Phase 5.9 gives AI-Verse Dashboard a stable Multiple Bots backend surface without moving coordination truth into the Dashboard.

The core law is:

```text
Dashboard
  = projection + routed operator control

Dashboard
  != canonical coordination store
  != scheduler
  != execution host
  != approval authority
```

Multiple Bots remains the canonical owner of Bot identity, Tasks, Rooms, Team Runs, Handoffs, Approvals, Artifacts and coordination events.

## Alignment with AI-Verse Dashboard

The current AI-Verse Dashboard architecture already follows these rules:

- Dashboard owns no domain truth;
- reads are disposable projections;
- commands route through owner-controlled boundaries;
- workspace/system isolation is explicit;
- local-first access is the default.

Phase 5.9 provides the Multiple Bots side of that contract.

It does not modify Dashboard UI code.

## Public Gateway surfaces

### Capabilities

```text
GET /v1/dashboard/capabilities?workspace=<workspace-id>
```

Reports the supported Dashboard query/control vocabulary for one workspace.

Current query capabilities:

```text
dashboard.snapshot
dashboard.events
dashboard.events.stream
```

Current control capabilities:

```text
bot.activate
bot.disable
bot.archive
approval.approve
approval.deny
task.cancel
task.retry
team_run.cancel
```

### Snapshot

```text
GET /v1/dashboard/snapshot?workspace=<workspace-id>
```

Returns one compact read-only workspace projection containing:

- counts;
- durable Bot roster;
- Task state;
- Team Run state;
- Room state;
- Approval state;
- Artifact metadata;
- attention items;
- current event cursor.

The projection explicitly reports:

```json
{
  "projection_only": true,
  "canonical_owner": "ai-verse-multiple-bots",
  "dashboard_owns_truth": false
}
```

### Event replay

```text
GET /v1/dashboard/events?workspace=<workspace-id>&after=<cursor>&limit=<n>
```

Returns only events whose canonical `workspace_id` exactly matches the requested workspace.

The cursor uses the existing monotonic coordination event sequence.

### Live events

```text
GET /v1/dashboard/events/stream?workspace=<workspace-id>&after=<cursor>
```

Uses server-sent events.

Initial replay and subsequent live delivery are both workspace-filtered.

A Dashboard client cannot receive another workspace's events through this surface.

### Control

```text
POST /v1/dashboard/control
```

Example:

```json
{
  "action": "bot.disable",
  "workspaceId": "workspace-a",
  "targetId": "bot_research",
  "actorId": "operator_dashboard",
  "reason": "optional operator reason"
}
```

Dashboard controls require an `operator_*` actor identity.

## Projection schema

Provider:

```text
ai-verse-multiple-bots/dashboard-projection-v1
```

Schema:

```text
1.0
```

The snapshot is intentionally compact.

It does not dump arbitrary raw coordination objects or hidden runtime/provider material.

### Bot projection

Current fields include:

- id;
- workspace;
- name;
- durable status;
- derived activity;
- role title;
- runtime adapter id;
- active Task count;
- pending Approval count;
- dead-letter count;
- available controls;
- updated timestamp.

Derived Bot activity is one of:

```text
idle
working
approval-needed
blocked
disabled
archived
```

Derived activity is a projection only. It does not replace canonical Bot/Task state.

### Task projection

Current fields include:

- Task status;
- objective;
- assignee/owner;
- Team Run/root objective refs;
- Approval ref;
- deadline;
- execution state;
- recovery policy;
- attempt counts;
- last error;
- available controls.

`task.retry` is advertised only when canonical recovery would actually accept it:

- Task status is `blocked`;
- execution state is `dead_letter`;
- recovery policy is `retry_safe`;
- attempt ceiling is not exhausted.

### Team Run projection

Includes:

- status;
- objective;
- leader;
- topology;
- participants;
- available controls.

Active Team Runs expose `team_run.cancel`.

Terminal runs do not.

### Approval projection

Pending Approvals expose:

```text
approval.approve
approval.deny
```

Settled Approvals expose no operator decision control.

### Artifact projection

Artifacts expose compact metadata only:

- identity;
- workspace;
- Task/Run refs;
- producer;
- kind;
- title;
- summary;
- updated timestamp.

Phase 5.9 does not turn Dashboard projection into an unrestricted Artifact-content transport.

## Attention projection

The snapshot currently surfaces compact attention items for:

1. pending Approvals;
2. dead-letter executions;
3. failed Tasks not already represented by a dead letter.

Attention is derived from canonical state.

Dashboard does not persist a second attention database.

The richer operator attention UX remains Phase 5.11.

## Control routing law

The Dashboard control endpoint contains no independent mutation engine.

Every supported control routes through an existing canonical owner.

### Bot lifecycle

```text
Dashboard control
  -> CoordinationGateway.transitionBot
```

### Approval decision

```text
Dashboard control
  -> CoordinationGateway.approve / rejectApproval
```

### Task cancellation

```text
Dashboard control
  -> BotRunner.cancelTask
```

This preserves:

- hierarchical cancellation;
- runtime cancellation;
- execution queue cancellation;
- Handoff settlement;
- canonical events.

### Dead-letter retry

```text
Dashboard control
  -> ExecutionSupervisor.retryDeadLetter
  -> RecoveryCoordinator
```

The Dashboard cannot bypass replay-safety rules or attempt ceilings.

### Team Run cancellation

```text
Dashboard control
  -> runner.teamRunControl.cancelRun
```

The same Team Run authority, fencing, cleanup and terminal cascade is used.

There is no second Dashboard-specific Team Run control plane.

## Workspace isolation

Every projection requires an explicit workspace.

Every control requires:

- explicit workspace;
- exact target identity;
- target ownership by that workspace.

A target from another workspace is rejected before canonical mutation.

The acceptance suite proves a workspace-A Dashboard request cannot disable a workspace-B Bot.

Event replay and live event delivery are independently workspace-filtered.

## Operator boundary

Dashboard does not gain Bot/Worker identity merely because it can reach the endpoint.

Controls require an explicit `operator_*` actor id.

Existing deeper owner rules continue to apply inside the routed canonical methods.

Transport authentication from Phase 5.8 and domain/operator authority are separate layers:

```text
remote bearer authentication
  != operator identity
  != workspace authority
  != approval grant
```

## Realtime model

Phase 5.9 uses the existing append-only coordination event stream.

It does not create another pub/sub truth source.

The Dashboard can:

1. fetch a workspace snapshot;
2. record its `event_cursor`;
3. replay events after that cursor;
4. subscribe to the workspace SSE stream.

This is restart-safe because durable history remains in the canonical event store.

## Local and remote access

The Dashboard endpoints are ordinary Gateway routes.

Therefore:

- local use remains loopback-first;
- Phase 5.8 managed remote mode protects them with the same bearer authentication;
- there is no unauthenticated remote Dashboard bypass;
- no browser CORS policy is opened automatically.

Browser-origin/CORS integration can be completed when the Dashboard client is wired to this backend contract.

## Installed-package acceptance

The implementation head `122616d2b9aff059a24d16c5f30944b441d3c897` passed GitHub Actions CI run 570 (`34782101256`):

- full repository suite: **476/476 passed**;
- Phase 4 compatibility suite: **5/5 passed**;
- packed artifact: **218 files**;
- package install smoke: passed;
- standalone install smoke: passed;
- AI-Verse OS install smoke: passed;
- generated OS engine smoke: passed;
- setup/onboarding smoke: passed;
- starter-template smoke: passed;
- production-doctor smoke: passed;
- update/migration smoke: passed;
- secure-remote Gateway smoke: passed;
- installed-package Dashboard projection/control smoke: passed;
- **0 failures, 0 canceled, 0 skipped**.

The installed-package Dashboard smoke proves the packed runtime can:

- start the Gateway;
- create canonical workspace Bot state through the normal Gateway;
- read it through the Dashboard snapshot;
- route an operator lifecycle control;
- observe the resulting canonical state through a fresh snapshot;
- keep `dashboard_owns_truth: false`.

## Phase boundary

Phase 5.9 does not implement:

- AI-Verse Dashboard UI changes;
- browser CORS expansion;
- Telegram/Discord/channel ingress;
- channel-specific authentication;
- rich operator attention UI;
- observability/usage dashboards;
- release-wide final acceptance.

Telegram/Discord/other channel bridge contracts are Phase 5.10.
