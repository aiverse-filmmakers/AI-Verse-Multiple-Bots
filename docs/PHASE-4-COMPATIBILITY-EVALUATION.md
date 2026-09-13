# Phase 4.9 - Runtime Compatibility and Evaluation Suite

## Status

This document defines the final Phase 4 acceptance layer.

Phase 4.9 does not add another runtime. It proves that all Gateway runtimes participate through one Multiple Bots coordination contract while preserving runtime-specific boundaries.

## What the suite evaluates

The canonical machine-readable matrix is:

`evals/phase-4-runtime-compatibility.json`

It covers every runtime registered by the Gateway:

- `deterministic`
- `openai-compatible`
- `a2a`
- `hermes`
- `openclaw`
- `codex`
- `claude-code`
- `external-managed`

The compatibility laws are:

1. every Gateway runtime is represented exactly once
2. durable Bot identity remains canonical
3. temporary Worker identity is preserved, or the runtime explicitly rejects Workers
4. runtime authority cannot exceed the local Task/lease boundary
5. runtime/provider failure cannot become a successful local Artifact
6. local cancellation remains authoritative
7. persisted provenance stays bounded and excludes copied hidden context or credentials
8. remote recovery behavior is explicit rather than assumed

## Intentional runtime differences

Compatibility does not mean pretending every runtime has identical capabilities.

`external-managed` is intentionally durable-Bot-only because it binds one canonical Bot to one persistent external profile.

Remote recovery is intentionally limited to runtimes with an explicit safe replay contract:

- A2A through the negotiated AI-Verse remote recovery extension
- external-managed through an explicit `exact_task_key` provider contract

Local one-shot/stdio/process runtimes do not claim durable remote recovery.

## Evaluation evidence

Phase 4.9 aggregates the deterministic adapter tests already built during 4.1 through 4.8 rather than replacing them.

The matrix links each runtime to its executable evidence files. The compatibility evaluator verifies that:

- every matrix entry maps to a real Gateway registration
- every evidence file exists
- required evidence markers remain present
- no runtime silently changes Worker/recovery support
- the deterministic reference runtime satisfies the shared result contract for both durable Bots and temporary Workers

This creates a fail-closed traceability layer over the existing adapter-specific tests.

## Running it

```bash
npm run eval:phase4
```

The normal full suite also includes the Phase 4.9 evaluator:

```bash
npm test
```

## Acceptance gate

Phase 4 is complete only when:

1. the dedicated Phase 4.9 evaluation command passes
2. the complete repository test suite passes
3. the matrix and Gateway runtime registry agree exactly
4. all 4.1 through 4.8 evidence remains green
5. canonical Phase 4 status/build-map documents are updated with the exact verified CI proof

No Phase 5 product, installer, Dashboard or omnichannel scope belongs in this slice.
