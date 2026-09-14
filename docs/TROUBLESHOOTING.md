# Public-Beta Troubleshooting

## Setup says mode is ambiguous

Error:

```text
SETUP_MODE_AMBIGUOUS
```

Cause: both standalone and AI-Verse OS installations are discoverable.

Fix: select one explicitly.

```bash
ai-verse-multiple-bots setup --mode standalone --root /path/to/project
```

or:

```bash
ai-verse-multiple-bots setup --mode os --root /path/to/AI-Verse-OS
```

## Doctor says runtime/dependency is unavailable

Run:

```bash
ai-verse-multiple-bots doctor
```

Starter templates require an explicit runtime adapter. The stock Gateway has no implicit `native` runtime.

Use `deterministic` only for tests/examples or configure a supported production runtime with its required executable/endpoint/credentials.

## Direct remote bind is rejected

Error:

```text
DIRECT_REMOTE_BIND_FORBIDDEN
```

Do not bind the Gateway directly to `0.0.0.0`, a LAN IP, tailnet IP or public address.

Use loopback locally or the managed remote path:

```bash
ai-verse-multiple-bots remote plan
ai-verse-multiple-bots remote serve
```

## Remote plan says bearer token is missing

Set a strong environment secret:

```bash
export AI_VERSE_GATEWAY_TOKEN="$(openssl rand -hex 32)"
```

The value is not stored in project/OS config.

## Tailscale remote mode is unavailable

Verify:

```bash
tailscale status
```

Managed remote mode requires the Tailscale CLI and an active connected tailnet.

It does not fall back to unauthenticated LAN HTTP.

## Channel ingress returns CHANNEL_ADAPTER_UNVERIFIED

The Telegram/Discord public transport must be verified by the external adapter before Multiple Bots admission.

Do not bypass this in production.

The packaged channel example sets `adapterVerified: true` only because it deliberately simulates an already-verified local adapter.

## Approval decision is rejected

Check:

- Approval is still pending;
- workspace exactly matches the Approval;
- actor ID begins with `operator_`;
- the target has not already transitioned.

Use:

```text
GET /v1/operator/approvals?workspace=<workspace>&status=pending
```

before deciding.

## A Task is blocked or dead-lettered

Inspect:

```text
GET /v1/operator/attention?workspace=<workspace>
GET /v1/observability/snapshot?workspace=<workspace>
```

Retry is offered only when the canonical execution recovery policy is `retry_safe` and the attempt ceiling has not been exhausted.

Do not manually rewrite queue state.

## Usage/cost does not match AI-Verse Token

Multiple Bots observability is not the canonical telemetry or pricing ledger.

Its `runtime_reported_cost_evidence` exists for coordination budgets and operational settlement only.

Canonical historical/global telemetry, immutable usage accounting, pricing evidence and ACTUAL/CALCULATED/UNKNOWN cost truth belong to AI-Verse Token.

Use:

```text
@ai-verse/token/gateway
```

for canonical Token projections.

Do not independently reprice runtime usage inside Multiple Bots.

## Status says update-required

Preview:

```bash
ai-verse-multiple-bots update-plan
```

Then apply:

```bash
ai-verse-multiple-bots update
```

## Status says migration-required

Do not force an update by editing schema metadata.

The current updater fails closed on unsupported coordination-schema transitions.

Use the migration/release path documented for the target release set.

## AI-Verse OS extension is disabled

Setup and update preserve an operator-disabled registration.

They do not silently re-enable it.

Inspect the OS-owned extension lifecycle/registry state and use the supported host lifecycle path.

## What to include in an issue

Include:

- Multiple Bots package version;
- installation mode;
- `status` output;
- `doctor` output;
- exact error code/message;
- relevant Task/Run/Bot/Approval IDs;
- relevant event sequence/cursor when useful.

Do not include:

- bearer tokens;
- API keys;
- provider credentials;
- raw secrets;
- private model chain-of-thought.
