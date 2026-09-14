# Public-Beta API Quick Reference

All routes are served by the Multiple Bots Coordination Gateway.

The normal local origin is loopback, for example:

```text
http://127.0.0.1:8787
```

Managed remote mode uses Tailscale Serve plus Gateway bearer authentication.

## Health

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | narrow storage health |
| GET | `/v1/health/readiness` | product readiness |
| GET | `/v1/health/4cs?workspace=...` | bounded AI-Verse integration health |

## Dashboard

| Method | Route |
| --- | --- |
| GET | `/v1/dashboard/capabilities?workspace=...` |
| GET | `/v1/dashboard/snapshot?workspace=...` |
| GET | `/v1/dashboard/events?workspace=...&after=...&limit=...` |
| GET | `/v1/dashboard/events/stream?workspace=...&after=...` |
| POST | `/v1/dashboard/control` |

Dashboard is a projection/control client. It is not a second coordination store.

## Operator attention

| Method | Route |
| --- | --- |
| GET | `/v1/operator/capabilities?workspace=...` |
| GET | `/v1/operator/attention?workspace=...&after=...` |
| GET | `/v1/operator/approvals?workspace=...&status=...` |
| POST | `/v1/operator/approvals/:id/decision` |

Approval decisions accept `approve` or `deny` and require an `operator_*` actor.

## Observability

| Method | Route |
| --- | --- |
| GET | `/v1/observability/capabilities?workspace=...` |
| GET | `/v1/observability/snapshot?workspace=...&after=...&limit=...` |
| GET | `/v1/observability/usage?workspace=...` |
| GET | `/v1/observability/timeline?workspace=...&after=...&limit=...` |

These are read-only operational projections.

The monetary field is `runtime_reported_cost_evidence`, not canonical AI cost truth.

Canonical telemetry/pricing ownership:

```text
canonical_telemetry_owner: ai-verse-token
canonical_cost_truth_owner: ai-verse-token
token_projection_interface: @ai-verse/token/gateway
```

## Channels

| Method | Route |
| --- | --- |
| GET | `/v1/channels/capabilities` |
| POST | `/v1/channels/ingress` |
| POST | `/v1/channels/telegram/ingress` |
| POST | `/v1/channels/discord/ingress` |
| POST | `/v1/channels/egress` |
| POST | `/v1/channels/egress/receipt` |

Channel ingress requires an already-authenticated provider adapter. Provider secrets and public webhook/socket lifecycle stay outside Multiple Bots.

## Bots

| Method | Route |
| --- | --- |
| GET | `/v1/bots?workspace=...` |
| POST | `/v1/bots` |
| GET | `/v1/bots/resolve?workspace=...&address=...` |
| POST | `/v1/bots/:id/activate` |
| POST | `/v1/bots/:id/disable` |
| POST | `/v1/bots/:id/archive` |

## Messages and events

| Method | Route |
| --- | --- |
| POST | `/v1/messages` |
| GET | `/v1/mailbox/:targetId` |
| GET | `/v1/events?after=...&limit=...` |
| GET | `/v1/events/stream?after=...` |

Workspace-scoped Dashboard/observability event routes are preferred for product UIs.

## Security notes

- direct non-loopback HTTP Gateway binds are rejected;
- managed remote mode requires a bearer token;
- transport authentication does not grant workspace/domain authority;
- external channel content is untrusted;
- cross-workspace mutation checks fail closed;
- raw provider secrets must not be placed in Bot messages or ordinary context.
