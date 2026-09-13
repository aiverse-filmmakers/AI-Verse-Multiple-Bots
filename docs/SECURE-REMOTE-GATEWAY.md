# Secure Remote Gateway

**Status:** Phase 5.8 complete

**Updated:** 2026-09-13

## Purpose

Phase 5.8 adds a production-safe remote access option without turning the Coordination Gateway into a raw internet-facing HTTP service.

The security model is:

```text
remote client
  -> HTTPS / Tailscale Serve
  -> loopback proxy hop
  -> bearer-authenticated Coordination Gateway
  -> existing coordination authority/policy
```

The Gateway itself stays on loopback.

Direct non-loopback HTTP binding is intentionally forbidden.

## Why this topology

Current mature local-agent gateways use the same basic pattern:

- keep the application Gateway on loopback by default;
- use an authenticated/private ingress such as Tailscale Serve or an SSH tunnel;
- terminate TLS outside the local HTTP listener;
- still require application-layer authentication for sensitive API surfaces.

Tailscale Serve provides tailnet-only HTTPS routing to a local service while leaving the origin on localhost.

Bearer credentials must not be exposed over an unprotected network path. The managed remote mode therefore never sends the token over a direct clear-text LAN/public listener.

## Public commands

Read-only preflight:

```bash
ai-verse-multiple-bots remote plan --mode standalone --root /path/to/project
```

or:

```bash
ai-verse-multiple-bots remote plan --mode os --root /path/to/AI-Verse-OS
```

Start the managed remote Gateway:

```bash
ai-verse-multiple-bots remote serve --mode standalone --root /path/to/project
```

or:

```bash
ai-verse-multiple-bots remote serve --mode os --root /path/to/AI-Verse-OS
```

When exactly one configured installation is discoverable from the current directory, `--mode` / `--root` may be omitted.

If both modes are discoverable, remote startup fails until the mode is explicit.

## Authentication

The default bearer secret handle is:

```text
AI_VERSE_GATEWAY_TOKEN
```

The secret must:

- be present in the Gateway process environment;
- be at least 32 characters;
- contain no whitespace;
- never be written to project config;
- never be written to the AI-Verse OS registry;
- never be printed by `remote plan` or `remote serve`.

Example shell setup:

```bash
export AI_VERSE_GATEWAY_TOKEN="$(openssl rand -hex 32)"
```

A custom environment handle can be selected:

```bash
ai-verse-multiple-bots remote serve \
  --auth-env MY_GATEWAY_TOKEN
```

Clients send:

```http
Authorization: Bearer <token>
```

Authentication applies to the whole managed remote Gateway surface, including:

- `/health`;
- `/v1/health/readiness`;
- Bot/Room/Task/Approval APIs;
- event replay;
- server-sent event streams;
- native AI-Verse ingress/write surfaces.

There is no unauthenticated remote health bypass.

## Transport

Phase 5.8 ships one managed remote provider:

```text
tailscale-serve
```

Preflight verifies:

1. Multiple Bots installation is production-ready;
2. bearer token handle resolves safely;
3. Tailscale CLI exists;
4. `tailscale status --json` reports `BackendState: Running`;
5. local and HTTPS ports are valid.

Only `remote serve` mutates transport state.

`remote plan` is read-only.

## Tailscale lifecycle

Managed startup launches a foreground route equivalent to:

```bash
tailscale serve --yes --https=443 http://127.0.0.1:<gateway-port>
```

The Gateway waits until Tailscale reports a tailnet HTTPS URL before reporting remote readiness.

The Tailscale process is intentionally foreground-owned by the Gateway lifecycle.

When the managed remote Gateway shuts down:

- the foreground Tailscale Serve claim is terminated;
- the local Gateway is closed;
- no persistent public/LAN HTTP bind is left behind.

If Tailscale exits unexpectedly, the local managed Gateway is closed instead of continuing as if remote transport were healthy.

## Loopback law

These are valid local hosts:

- `127.0.0.1` and other `127.0.0.0/8` loopback addresses;
- `::1`;
- `localhost`.

These direct HTTP binds are rejected:

```text
0.0.0.0
LAN address
tailnet address
public address
```

For example:

```bash
ai-verse-multiple-bots serve --host 0.0.0.0
```

fails with:

```text
DIRECT_REMOTE_BIND_FORBIDDEN
```

Likewise, new standalone installations cannot persist a non-loopback Gateway host.

Remote reachability must go through the secure transport boundary.

## Request hardening

Managed bearer-protected Gateway responses include:

- `Cache-Control: no-store`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`;
- restrictive Content Security Policy;
- restrictive Permissions Policy.

JSON request bodies are bounded.

The default maximum is:

```text
2 MiB
```

Oversized requests fail before JSON parsing.

## Origin/Host behavior

The HTTP router no longer derives its parsing base from the untrusted Host header.

Request routing uses a fixed internal URL base.

Phase 5.8 does not enable browser CORS.

Dashboard browser-origin policy belongs with the Dashboard/control surface in Phase 5.9 rather than being silently opened here.

## Standalone mode

Standalone secure remote startup reuses the existing standalone installation:

```text
.ai-verse-bots/
├── config.json
├── install.json
└── runtime/
    └── coordination.db
```

No remote credential is added to this tree.

No AI-Verse OS state is created.

The local origin stays:

```text
http://127.0.0.1:<port>
```

and the remote client uses the Tailscale HTTPS URL plus bearer token.

## AI-Verse OS mode

OS remote mode uses the current attached Multiple Bots database:

```text
runtime/ai-verse-bots/coordination.db
```

and supplies the existing AI-Verse OS root to the normal Gateway.

Remote transport does not bypass:

- workspace scope;
- Bot permissions;
- Approval requirements;
- Brain ownership;
- Memory boundaries;
- Skills capability resolution;
- OS write-command authority;
- connection/tool authority.

Transport authentication proves access to the Gateway. It does not grant domain authority.

## Remote plan output

The plan reports only non-secret evidence such as:

- installation mode/root;
- database path;
- local loopback host/port;
- HTTPS port;
- auth environment handle name;
- whether the credential is configured;
- whether Tailscale is installed;
- whether the tailnet is connected;
- component health state;
- blocking reasons.

The resolved bearer token value is never included.

## Failure behavior

Remote startup fails closed when:

- installation is not ready;
- setup/update/migration is required;
- AI-Verse OS extension is disabled;
- bearer token is missing or malformed;
- Tailscale executable is unavailable;
- Tailscale daemon is not connected;
- Tailscale Serve exits before publishing an HTTPS URL;
- a direct non-loopback bind is requested.

No fallback to unauthenticated LAN HTTP is attempted.

## Public internet scope

Phase 5.8 does **not** enable Tailscale Funnel or another public-internet ingress automatically.

The shipped managed mode is tailnet-only.

Public webhook/channel ingress belongs to later channel/Gateway contracts where endpoint-specific authentication, replay protection and authority can be designed explicitly.

## Acceptance evidence

The initial installed-package implementation gate at head `69878f4640af42374dbe31c90fce625c91058fa7` passed GitHub Actions CI run 548 (`34780451390`):

- full repository suite: **471/471 tests passed**;
- Phase 4 compatibility suite: **5/5 passed**;
- package install smoke: passed;
- standalone install smoke: passed;
- AI-Verse OS install smoke: passed;
- generated OS engine smoke: passed;
- setup/onboarding smoke: passed;
- starter-template smoke: passed;
- production-doctor smoke: passed;
- update/migration smoke: passed;
- installed-package secure-remote Gateway smoke: passed;
- packed artifact: **212 files**;
- **0 failures, 0 canceled, 0 skipped**.

The hardened implementation head `96eef0e3ad65aa9b456dab18f679566d0c6eea69` also passed GitHub Actions **CI run 553 (`34780581616`)** with the same **471/471 repository tests**, **5/5 Phase 4 compatibility evaluations**, **212-file packed artifact**, every prior package smoke, and the installed-package secure-remote Gateway smoke.

## Phase boundary

Phase 5.8 does not implement:

- Dashboard projections/control endpoints;
- browser CORS policy for Dashboard;
- Telegram/Discord/webhook channel ingress;
- public Funnel exposure;
- operator attention UI;
- observability/usage views.

Dashboard projections/control endpoints are Phase 5.9.
