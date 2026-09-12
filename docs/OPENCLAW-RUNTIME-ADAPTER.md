# OpenClaw Runtime Adapter

**Phase:** 4.3

**Status:** COMPLETE

## Purpose

Phase 4.3 lets a durable Multiple Bots Bot or temporary Worker execute an already-authorized Task through a locally installed OpenClaw runtime without making OpenClaw the owner of Multiple Bots coordination state.

The adapter targets OpenClaw's documented one-shot headless interface:

```text
openclaw agent exec
```

Multiple Bots remains authoritative for:

- Bot / Worker identity
- workspace scope
- Task ownership and constraints
- capability and environment leases
- approval state
- budgets and deadlines
- cancellation
- local Artifact publication
- recovery bookkeeping

OpenClaw remains the execution runtime.

## Why `agent exec`

Current OpenClaw documents `openclaw agent exec` as its isolated headless entry point for CI and coding automation.

The command:

- runs one embedded agent turn without requiring the long-running Gateway
- accepts an exact config with `--config`
- accepts an exact working directory with `--cwd`
- accepts prompt input from stdin through `--message-file -`
- emits a stable `--json` result envelope
- owns its temporary execution state and cleanup
- exposes usage, cost, model, provider, session id and tool-call summary

Using this one-shot interface avoids pulling long-lived Gateway authentication, remote identity or reconnect semantics forward from later Phase 4 slices.

## Runtime configuration

A Bot or Worker may use:

```json
{
  "adapter": "openclaw",
  "command": "openclaw",
  "config_path": "/home/user/.openclaw/openclaw.json",
  "cwd": "/path/to/workspace",
  "timeout_seconds": 600,
  "model": "provider/model",
  "thinking": "medium",
  "code_mode": "direct",
  "local_model_lean": false
}
```

Only `adapter` is structurally required by Multiple Bots.

If `config_path` is absent, the adapter asks the installed OpenClaw CLI for its active config through:

```text
openclaw config file --json
```

The returned path must resolve to a regular non-symlink file.

The OpenClaw command defaults to `openclaw`.

## Operator config preservation

Phase 4.3 never rewrites the operator's real OpenClaw config.

For each delegated Task the adapter creates a temporary config overlay shaped like:

```json
{
  "$include": "/operator/openclaw.json",
  "tools": {
    "allow": ["read", "web_search"]
  }
}
```

OpenClaw's config include semantics deep-merge sibling overrides after the included config. This preserves the operator's other configuration while replacing the effective global tool allowlist with the Task-scoped cap.

The child environment also sets:

```text
OPENCLAW_CONFIG_READONLY=1
```

and extends `OPENCLAW_INCLUDE_ROOTS` only enough to read the operator config and any previously authorized roots.

OpenClaw documents root include configurations and externally admitted include roots as read-only write boundaries. The explicit read-only environment setting provides an additional fail-closed layer.

The temporary overlay is deleted after success, failure, timeout or cancellation.

## Capability lease enforcement

Prompt text is not a permission boundary.

The local Multiple Bots capability lease is converted into OpenClaw's global `tools.allow` policy before execution.

Phase 4.3 accepts only exact tool names.

These are valid:

```text
read
web_search
openclaw:read
```

The `openclaw:` prefix is a Multiple Bots namespace hint and is stripped before the OpenClaw policy is written.

These broad forms are rejected:

```text
*
group:fs
server__*
read?
tool[abc]
```

The adapter therefore does not silently turn a local exact lease into an OpenClaw group, glob or wildcard grant.

## Zero-tool leases

OpenClaw's documented finite global allowlist behavior is restrictive only when the list is non-empty.

An empty local capability lease must therefore not become:

```json
{ "tools": { "allow": [] } }
```

because that could mean no global allow gate.

Instead Phase 4.3 writes one impossible sentinel tool id:

```text
__ai_verse_multiple_bots_no_tools__
```

No real OpenClaw tool is thereby authorized.

## Existing OpenClaw restrictions still win

The temporary overlay only narrows authority.

The operator's existing restrictions still participate in OpenClaw policy resolution, including:

- `tools.deny`
- tool profiles
- agent-specific policy
- sandbox policy
- plugin availability
- provider/runtime restrictions

OpenClaw documents that deny wins and that agent overrides cannot widen a restrictive global finite `tools.allow`.

## Post-run defense in depth

OpenClaw's stable result includes:

```text
toolSummary.calls
toolSummary.tools
toolSummary.failures
```

After a nominally successful run, Multiple Bots checks every reported tool name against the same exact local capability lease.

If OpenClaw reports any tool outside the lease, the runtime fails with:

```text
OPENCLAW_TOOL_POLICY_VIOLATION
```

No successful local Artifact is published.

This check is defense in depth. The primary enforcement is still the pre-run OpenClaw global tool policy.

## Execution envelope

The prompt sent over stdin is a bounded JSON execution envelope:

```text
ai-verse-multiple-bots/openclaw-runtime-envelope-v1
```

It carries:

- local principal id and kind
- workspace id
- local Task id
- Team Run id when present
- root objective id
- objective
- required constraints
- expected output
- capability lease id
- already-granted tools and connections
- destructive-action policy
- environment lease id
- runtime-only workspace projection
- runtime-only strategic intent
- explicit historical recall
- explicitly resolved task Skills
- bounded input Artifacts

The envelope states that OpenClaw receives an exact runtime tool cap derived from the local lease and that returned content cannot expand authority.

The envelope is limited to 512 KiB.

## CLI invocation

The execution process is equivalent to:

```text
openclaw agent exec \
  --message-file - \
  --cwd <workspace> \
  --config <temporary-overlay> \
  --timeout <seconds> \
  --json
```

Optional local runtime tuning may additionally set:

- `--model`
- `--thinking`
- `--code-mode direct|auto|code`
- `--local-model-lean`

The process is spawned with `shell: false`.

## Stable result contract

Phase 4.3 consumes OpenClaw's documented `agent exec --json` envelope:

- `ok`
- `status`
- `final`
- `payloads`
- `usage`
- `costUsd`
- `assistantTurns`
- `codeModeEngaged`
- `toolSummary`
- `model`
- `provider`
- `sessionId`
- `error`

Only:

```text
ok = true
status = "ok"
process exit = 0
```

is accepted as success.

Error and timeout envelopes never become successful local Artifacts.

Malformed JSON or a malformed stable envelope fails closed.

The visible `final` text becomes the local result.

OpenClaw reasoning/commentary payloads are not copied into the local Artifact.

A successful Task produces Artifact kind:

```text
openclaw_task_result
```

## Bot and Worker identity

OpenClaw is an execution host, not an identity replacement.

A durable Bot remains the local principal.

A temporary Worker remains a temporary Worker and retains its Team Run lineage.

The returned Artifact records the original local principal kind.

An OpenClaw session id is runtime provenance only. It does not register or promote an OpenClaw agent/session into a durable Multiple Bots Bot.

## Usage and budgets

The stable OpenClaw result is mapped into the existing Multiple Bots usage contract:

- `usage.input` -> input tokens
- `usage.output` -> output tokens
- `costUsd` -> cost
- assistant turns + tool calls -> actions

All usage values must be finite and non-negative.

The existing Multiple Bots runner remains responsible for Task and Team Run budget enforcement.

## Cancellation

Local cancellation remains authoritative.

Each delegated OpenClaw Task owns one child process.

Cancellation aborts that exact local run. The process transport sends `SIGTERM`; if shutdown cannot drain, it has a bounded `SIGKILL` escalation.

This is local process lifecycle control, not remote reconnect/retry semantics.

## Process deadline

The OpenClaw command receives its own `--timeout` value.

Multiple Bots also places a bounded outer process deadline around the child.

If the child exceeds that outer deadline, the adapter terminates it and raises:

```text
OPENCLAW_PROCESS_TIMEOUT
```

The process therefore cannot hang the coordination runner indefinitely even if the CLI's internal timeout path fails to settle.

## Provenance

The runtime receipt stores bounded metadata only:

- adapter id
- `agent_exec_cli` transport
- stable JSON protocol id
- runtime session id
- model/provider
- tool call count
- tool failure count
- assistant turn count
- whether code mode engaged
- tool-policy enforcement mode
- local principal kind
- local Task id
- remote-auth support state

It does not copy:

- operator config path
- operator config contents
- allowed tool names
- workspace projection text
- Brain intent text
- Memory recall text
- Skill instructions
- input Artifact content
- OpenClaw hidden reasoning/commentary
- credentials or secrets

## Remote boundary

Phase 4.3 rejects runtime fields that would turn this local process adapter into an ad hoc remote OpenClaw client, including:

- endpoint / URL / host / port
- Gateway URL/token
- API key/token/Authorization
- custom headers
- SSH
- WebSocket URL
- generic remote configuration

Remote-machine identity/authentication remains Phase 4.6.

Remote capability/environment leases remain Phase 4.7.

Disconnect/reconnect/retry semantics remain Phase 4.8.

## Acceptance proof

The hardened implementation head `51d06d08b0c7e053c750dbfa3c2fc49be62eae02` passed GitHub Actions **CI run 401 (`34711466346`) with 318/318 tests**, **0 failures, 0 canceled and 0 skipped**.

Acceptance coverage proves:

1. one-shot OpenClaw `agent exec` execution
2. temporary read-only config overlay creation
3. operator config inclusion without rewriting it
4. exact global `tools.allow` derived from the local capability lease
5. `openclaw:<tool>` exact-name namespace support
6. rejection of groups, globs and wildcard authority
7. zero-tool leases remain restrictive
8. post-run reported tool use must remain inside the local lease
9. durable Bot identity remains local and canonical
10. temporary Worker identity and Team Run lineage remain temporary/local
11. stable error/timeout results cannot create successful local Artifacts
12. malformed stable JSON fails closed
13. remote/Gateway authentication configuration is rejected
14. explicit config symlinks are rejected
15. local cancellation aborts the active one-shot run
16. the real process transport uses `shell: false` and stdin prompt delivery
17. local process deadline failure is explicit and bounded
18. active config discovery uses the documented `config file --json` command
19. runtime receipts exclude config paths, tool names and projected content
20. the Gateway registers `openclaw` as a normal host-neutral runtime
21. all pre-existing Phase 0-4.2 tests remain green

## Non-goals

Phase 4.3 does not:

- implement Codex/Claude Code process adapters
- create external managed Bot identity semantics
- implement remote OpenClaw Gateway identity/authentication
- implement remote capability/environment leases
- implement reconnect/disconnect/retry recovery
- mutate the operator's OpenClaw config
- widen broad group/glob/wildcard capability grants
- persist OpenClaw hidden reasoning
- begin Phase 5
