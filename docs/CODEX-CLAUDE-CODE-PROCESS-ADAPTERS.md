# Codex and Claude Code Process Adapters

**Phase:** 4.4

**Status:** COMPLETE

## Purpose

Phase 4.4 adds bounded local process execution for two coding-agent CLIs:

- OpenAI Codex CLI
- Anthropic Claude Code

Multiple Bots remains the canonical owner of:

- durable Bot and temporary Worker identity
- workspace scope
- Task ownership and constraints
- capability/environment leases
- approvals
- budgets and deadlines
- cancellation
- local Artifact publication
- recovery bookkeeping

Codex and Claude Code remain execution runtimes only.

This slice deliberately does not implement remote login delegation, remote-machine identity, reconnectable sessions, or persistent external Bot identity. Those belong to later Phase 4 slices.

## Shared process boundary

Both adapters use `SpawnLocalCliProcessTransport`.

The shared transport guarantees:

- `shell: false`
- prompt delivery through stdin
- bounded stdout
- bounded stderr tail
- AbortSignal cancellation
- SIGTERM first
- SIGKILL escalation after one second when shutdown does not complete
- bounded outer process deadlines
- explicit child-process exit/signal results

The stdout-overflow path uses the same TERM-to-KILL cleanup law. Rejecting an oversized result therefore cannot silently leave a stubborn child process running.

## Execution envelopes

Both runtimes receive a bounded JSON task envelope over stdin.

Codex:

```text
ai-verse-multiple-bots/codex-runtime-envelope-v1
```

Claude Code:

```text
ai-verse-multiple-bots/claude-code-runtime-envelope-v1
```

The envelope contains only the already-authorized execution context needed for the delegated Task:

- local principal id/kind
- workspace id
- Task id
- Team Run id when present
- root objective id
- objective
- required constraints
- expected output contract
- capability lease id
- environment lease id
- destructive-action policy
- workspace projection
- strategic intent projection
- explicit historical recall
- explicitly resolved Skills
- bounded input Artifacts

Prompt content is never treated as an authority grant.

The envelope is limited to 512 KiB.

---

# Codex process adapter

## Runtime id

```text
codex
```

Public adapter:

```text
CodexExecRuntimeAdapter
```

Artifact kind:

```text
codex_task_result
```

## Supported local capabilities

Phase 4.4 intentionally exposes only a small provider-scoped capability vocabulary:

```text
codex:workspace-read
codex:workspace-write
codex:web-search
```

`codex:workspace-write` implies `codex:workspace-read`.

Broad/unscoped grants fail closed.

Rejected examples include:

```text
*
group:fs
codex:workspace-*
read
codex:mcp
```

This is deliberate. Codex does not currently expose the same simple exact per-built-in-tool allowlist that Claude Code exposes, so Phase 4.4 maps leases to a smaller process-level authority model rather than pretending individual Codex core tools can all be independently leased.

## Workspace containment

The configured workspace must resolve to a real directory and must not itself be a symlink.

Codex runs from a separate temporary harness directory rather than the real workspace.

This keeps project-local Codex configuration and rule discovery out of the execution bootstrap.

The actual workspace is exposed only through the custom Codex permission profile.

### No workspace capability

Filesystem profile:

```toml
":minimal" = "read"
```

No workspace path is granted.

Shell/unified execution is disabled.

### Workspace read

The actual workspace receives read authority.

### Workspace write

The actual workspace receives write authority and therefore implied read access.

Network remains disabled at the Codex permission-profile layer.

## User/project configuration boundary

The process uses:

```text
--ignore-user-config
--ignore-rules
-C <temporary-harness>
```

Codex authentication remains runtime-owned and usable through the normal Codex authentication store.

The adapter does not copy operator config into the prompt or local Artifact.

The temporary harness is removed after success, failure, timeout, or cancellation.

## Codex feature narrowing

Before execution the adapter disables Codex surfaces that are not part of the Phase 4.4 lease model, including:

- apps
- code mode
- context management
- deferred executor
- hooks
- image generation
- memories
- multi-agent v1/v2
- plugins
- request-permissions tool
- shell snapshots
- Skills injection
- token-budget side surfaces
- tool suggest
- request-user-input tool
- update-plan tool
- view-image

Shell/unified execution is enabled only when a workspace read/write capability exists.

Standalone web search and `web_search=live` are enabled only for `codex:web-search`.

## MCP preflight

MCP requires special handling because Codex may obtain servers from more than one configuration layer.

Before the delegated `exec` turn, the adapter runs:

```text
codex mcp list --json
```

from the temporary harness.

The adapter parses only configured server names.

It does not persist:

- MCP URLs
- commands
- arguments
- headers
- OAuth state
- environment configuration
- credentials

Every discovered server is then explicitly disabled in the delegated Codex process with a highest-precedence CLI override.

The execution process also sets:

```text
orchestrator.mcp.enabled=false
```

This gives Phase 4.4 two MCP barriers:

1. explicit per-discovered-server disable
2. orchestrator MCP disable

Any returned `mcp_tool_call` event still causes the local runtime to fail as defense in depth.

Phase 4.4 does not offer `codex:mcp` as a lease capability.

## Codex invocation

The execution shape is:

```text
codex exec \
  --strict-config \
  --skip-git-repo-check \
  --ephemeral \
  --ignore-user-config \
  --ignore-rules \
  --json \
  -C <temporary-harness> \
  [bounded CLI config overrides] \
  -
```

The final `-` tells Codex to consume the delegated request from stdin.

Optional model selection may be provided through the runtime configuration.

## Result contract

The adapter consumes Codex JSONL events.

Relevant event classes include:

- `thread.started`
- `turn.started`
- `item.started`
- `item.updated`
- `item.completed`
- `turn.completed`
- `turn.failed`
- `error`

The final user-visible local result comes only from completed `agent_message` items.

Reasoning text is not persisted into the local Artifact.

A successful local result requires:

- a valid `thread.started`
- a valid successful `turn.completed`
- no terminal failed/error condition
- no observed authority violation

## Post-run authority verification

The adapter checks observed completed item types.

The following fail closed:

- `mcp_tool_call` in every Phase 4.4 run
- `collab_tool_call` in every Phase 4.4 run
- command/file activity without workspace authority
- file changes without `codex:workspace-write`
- web search without `codex:web-search`

The runtime therefore does not trust process configuration alone.

## Usage

Codex JSONL token counters are mapped into the existing Multiple Bots usage contract.

Input accounting includes:

- input tokens
- cached input tokens
- cache-write input tokens

Output accounting includes:

- output tokens
- reasoning output tokens

Codex `exec --json` does not currently provide a stable run-cost field equivalent to Claude Code's `total_cost_usd`, so the adapter records runtime cost as zero rather than inventing an estimate.

Local/Team Run token and action budgets still apply through the existing Multiple Bots runner.

## Codex provenance receipt

The bounded receipt records:

- runtime adapter/transport
- Codex thread id
- local principal kind
- local Task id
- number of process capabilities
- command/file/web activity counts
- number of MCP servers found during preflight
- MCP policy mode
- project/user config policy
- ephemeral persistence policy
- remote-auth support state

It does not persist:

- workspace path
- capability names
- MCP server names/configuration
- projected context
- historical recall
- Skill instructions
- input Artifact content
- hidden reasoning
- credentials

---

# Claude Code process adapter

## Runtime id

```text
claude-code
```

Public adapter:

```text
ClaudeCodePrintRuntimeAdapter
```

Artifact kind:

```text
claude_code_task_result
```

## Supported local capabilities

Phase 4.4 supports exact provider-scoped capabilities:

```text
claude-code:workspace-read
claude-code:workspace-write
claude-code:shell
claude-code:web-search
claude-code:web-fetch
```

`workspace-write` implies `workspace-read`.

They map to Claude Code built-ins as follows:

| Capability | Built-in tools |
| --- | --- |
| workspace-read | `Read`, `Glob`, `Grep` |
| workspace-write | `Edit`, `Write` plus read tools |
| shell | `Bash` |
| web-search | `WebSearch` |
| web-fetch | `WebFetch` |

Groups, globs, wildcard grants, unscoped names and unknown provider capabilities fail closed.

## Native safe/restricted boundary

Claude Code is launched in non-interactive print mode with:

```text
--safe-mode
--restricted
```

The exact built-in set derived from the Multiple Bots lease is supplied through:

```text
--tools <exact-list>
```

When there are no leased built-ins, the adapter passes an explicit empty `--tools` value.

For non-empty sets, it also uses:

```text
--allowedTools <same-exact-list>
```

The permission mode is:

```text
--permission-mode dontAsk
--permission-prompts none
```

Therefore the delegated runtime cannot expand authority by asking the operator mid-turn.

## MCP boundary

Phase 4.4 does not expose Claude Code MCP authority.

The process combines:

```text
--safe-mode
--strict-mcp-config
--mcp-config '{"mcpServers":{}}'
--disallowedTools 'mcp__*'
```

This provides:

1. safe-mode MCP suppression
2. an explicit empty strict MCP configuration
3. an explicit MCP tool deny pattern

MCP is not part of the Phase 4.4 capability vocabulary.

## Other runtime narrowing

The invocation also uses:

```text
--no-session-persistence
--disable-slash-commands
--no-chrome
```

The process environment sets:

```text
CLAUDE_CODE_SKIP_PROMPT_HISTORY=1
```

The adapter does not resume previous Claude Code sessions.

## Managed-policy nuance

Claude Code safe mode intentionally leaves organization-managed policy upstream.

Current Claude Code behavior may still apply host-admin-managed policy, including managed settings that the runtime itself is not authorized to override.

This is treated as host/runtime policy, not Task-granted Multiple Bots capability.

The receipt records:

```text
managed_policy = host_managed_policy_remains_upstream
```

Phase 4.4 therefore does not claim that it can bypass or remove administrator-managed Claude Code policy.

## Claude Code invocation

The execution shape is:

```text
claude -p "<constant harness instruction>" \
  --safe-mode \
  --restricted \
  --tools <exact-list> \
  --disallowedTools 'mcp__*' \
  --strict-mcp-config \
  --mcp-config '{"mcpServers":{}}' \
  --permission-mode dontAsk \
  --permission-prompts none \
  --output-format json \
  --no-session-persistence \
  --disable-slash-commands \
  --no-chrome
```

Optional bounded runtime configuration may additionally set:

- model
- effort
- max turns
- max budget USD

The complete delegated Task envelope arrives through stdin.

## Result contract

The adapter accepts the Claude Code JSON print result only when:

- the output is valid JSON
- `session_id` is present
- `subtype === "success"`
- `is_error !== true`
- `result` is a string

Failure/error/max-turn style result subtypes never become successful local Artifacts.

## Usage and cost

Claude Code exposes explicit result accounting.

Input usage maps:

- input tokens
- cache-creation input tokens
- cache-read input tokens

Output usage maps:

- output tokens

Cost maps from:

```text
total_cost_usd
```

Actions map from `num_turns`.

Permission-denial count is retained as bounded provenance metadata.

## Claude Code provenance receipt

The receipt records:

- runtime adapter/transport
- Claude session id
- local principal kind
- local Task id
- number of process capabilities
- number of enabled built-in tools
- permission-denial count
- safe-mode/restricted policy markers
- permission mode
- MCP policy
- managed-policy ownership marker
- persistence policy
- remote-auth support state

It does not persist:

- workspace path
- actual built-in tool names
- projected context
- historical recall
- Skill instructions
- input Artifact content
- credentials

---

# Bot and Worker identity

Neither process runtime owns Multiple Bots identity.

A durable Bot remains the local principal even when Codex or Claude Code performs the execution.

A temporary Worker remains temporary and retains Team Run lineage.

Codex thread ids and Claude Code session ids are runtime provenance only.

They do not register or promote an external CLI session into a durable Multiple Bots Bot.

---

# Cancellation

Local cancellation remains authoritative.

Each adapter owns its active child-process AbortController.

Cancellation terminates the exact active local process through the shared process transport.

No remote resume/reconnect semantics are introduced.

---

# Remote boundary

Phase 4.4 rejects runtime configuration that would turn these local adapters into ad hoc remote clients or resumed-session bridges.

Examples include:

- endpoint / URL / host / port
- API key/token/Authorization
- arbitrary headers
- SSH
- WebSocket URL
- generic remote/cloud mode
- external session/thread resume identifiers

Remote-machine identity/authentication remains Phase 4.6.

Remote capability/environment leases remain Phase 4.7.

Disconnect/reconnect/retry semantics remain Phase 4.8.

---

# Acceptance proof

The hardened implementation head `9783dca791881ca53265e116ec835e2552e0f43a` passed GitHub Actions **CI run 410 (`34715059115`) with 337/337 tests**, **0 failures, 0 canceled and 0 skipped**.

Acceptance coverage proves:

1. Codex executes through one-shot `codex exec --json`
2. Codex project config/rules are isolated through a temporary harness
3. Codex user config is ignored while runtime authentication remains external
4. Codex exact provider-scoped capability vocabulary fails closed
5. Codex workspace read/write permission profiles remain bounded
6. Codex network remains disabled at the process permission layer
7. Codex web search requires explicit lease authority
8. Codex MCP inventory is discovered then every listed server is explicitly disabled
9. Codex MCP and collaboration events fail closed after execution
10. Codex reasoning is not copied into the local Artifact
11. Codex durable Bot identity remains local
12. Codex temporary Worker identity and Team Run lineage remain local
13. Claude Code executes in print mode with safe + restricted policy
14. Claude Code receives an exact built-in tool list
15. Claude Code zero-capability runs explicitly expose no built-in tools
16. Claude Code MCP uses safe-mode + strict empty config + explicit MCP deny
17. Claude Code permission prompts cannot widen the Task lease
18. Claude Code session persistence is disabled
19. Claude Code exact provider-scoped capabilities fail closed
20. Claude Code usage and reported USD cost map into the local usage contract
21. Claude Code durable Bot and temporary Worker identity remain local
22. both adapters reject remote/auth/resume fields owned by later Phase 4 slices
23. both adapters support exact local cancellation
24. the shared process transport always uses `shell: false`
25. shared process deadlines fail explicitly
26. stdout overflow still preserves bounded SIGTERM-to-SIGKILL cleanup
27. the Gateway exposes `codex` and `claude-code` as ordinary runtimes
28. every pre-existing Phase 0-4.3 test remains green

## Non-goals

Phase 4.4 does not:

- create external managed durable Bot identity
- implement remote-machine authentication
- add remote capability/environment leases
- implement reconnect/retry semantics
- resume external Codex/Claude sessions
- expose Codex or Claude MCP as Task capabilities
- make runtime CLI state canonical
- begin Phase 5
