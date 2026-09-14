# Public-Beta Examples

These examples are shipped with the `@ai-verse/multiple-bots` package and are acceptance-tested from a clean packed installation.

They are intentionally local and deterministic. They do not require provider credentials, public network access, or a live AI-Verse OS host unless the example says so.

## 1. Standalone quickstart

Creates a temporary standalone installation, applies the built-in `research-team` starter with the deterministic runtime, verifies production readiness, prints a summary, then removes the temporary root.

```bash
node examples/standalone-quickstart.mjs
```

To keep the installation instead of using a temporary root:

```bash
node examples/standalone-quickstart.mjs --root /path/to/my-bots
```

This example demonstrates product setup and durable roster creation. It does not claim the deterministic runtime is a production model provider.

## 2. Operator approval + observability

Creates an in-memory Gateway, registers two Bots, delegates an approval-gated Task, inspects the operator attention queue, approves the Task through the public operator route, then reads the observability projection.

```bash
node examples/operator-observability.mjs
```

The example also prints the AI-Verse Token ownership boundary:

```text
canonical_telemetry_owner = ai-verse-token
canonical_cost_truth_owner = ai-verse-token
token_projection_interface = @ai-verse/token/gateway
runtime_usage_is_canonical_token_truth = false
```

Multiple Bots keeps execution-local usage for coordination and budgets. AI-Verse Token remains the canonical telemetry, pricing and cost-truth owner.

## 3. Channel bridge

Creates an in-memory Telegram binding, simulates one already-verified Telegram adapter message, routes it to a canonical Bot, creates a canonical Bot reply, then formats the outbound Telegram transport command.

```bash
node examples/channel-bridge.mjs
```

This is not a public Telegram webhook server. Provider webhook/socket verification and provider credentials remain owned by the external channel adapter.

## Safety / ownership reminders

- examples use loopback or in-memory Gateways only;
- they never enable Tailscale Funnel or direct public HTTP binds;
- channel examples set `adapterVerified: true` only because the adapter transport is deliberately simulated locally;
- examples do not grant workspace, Connection, Brain, Skills, Memory, OS-write or provider authority;
- Dashboard/operator/observability views remain projections over canonical Multiple Bots coordination state;
- canonical global/historical telemetry and AI cost truth remain owned by AI-Verse Token.
