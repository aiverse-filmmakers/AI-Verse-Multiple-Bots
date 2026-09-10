#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def announce(name: str) -> None:
    print(f"\n==> {name}", flush=True)


def run(
    name: str,
    argv: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    input_text: str | None = None,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    announce(name)
    completed = subprocess.run(
        argv,
        cwd=str(cwd) if cwd else None,
        env={**os.environ, **(env or {})},
        input=input_text,
        text=True,
        capture_output=capture,
        check=False,
    )
    if completed.returncode != 0:
        if capture:
            if completed.stdout:
                print(completed.stdout, file=sys.stderr)
            if completed.stderr:
                print(completed.stderr, file=sys.stderr)
        raise RuntimeError(f"{name} failed with exit code {completed.returncode}")
    return completed


def run_json(name: str, argv: list[str], *, cwd: Path | None = None) -> dict:
    completed = run(name, argv, cwd=cwd, capture=True)
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{name} did not return JSON: {error}") from error
    if not isinstance(value, dict):
        raise RuntimeError(f"{name} returned a non-object JSON value")
    return value


def enable_brain(os_root: Path) -> None:
    manifest = os_root / "AI-VERSE.yaml"
    text = manifest.read_text(encoding="utf-8")
    if "\n  brain:\n" in text:
        return
    needle = "extensions:\n"
    if text.count(needle) != 1:
        raise RuntimeError("AI-VERSE.yaml must contain exactly one top-level extensions block")
    replacement = (
        "extensions:\n"
        "  brain:\n"
        "    supported: true\n"
        "    enabled: true\n"
    )
    manifest.write_text(text.replace(needle, replacement, 1), encoding="utf-8")


def load_memory(os_root: Path):
    memory_path = os_root / "scripts" / "ai-verse-memory" / "memory.py"
    spec = importlib.util.spec_from_file_location("platform_smoke_memory", memory_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load installed AI-Verse Memory module")
    memory = importlib.util.module_from_spec(spec)
    sys.modules["platform_smoke_memory"] = memory
    spec.loader.exec_module(memory)
    return memory


def discover_skills(os_root: Path, skills_root: Path, work_root: Path) -> list[dict]:
    capabilities_path = work_root / "capabilities.json"
    script = r'''
import fs from "node:fs";
import assert from "node:assert/strict";
import { discoverCapabilities, selectCapability } from "./scripts/capability-resolver.mjs";

const options = {
  osRoot: process.cwd(),
  scope: "operator",
  skillsRoot: process.env.PLATFORM_SKILLS_ROOT,
  localSkillsRoot: `${process.env.PLATFORM_WORK_ROOT}/no-local-skills`
};
const discovered = discoverCapabilities({
  ...options,
  query: "Aurora release whisper audio transcode dialogue delivery",
  limit: 50
});
const provider = discovered.providers.find((item) => item.provider === "aiverse-skills");
assert.equal(provider?.state, "healthy");
const whisper = discovered.candidates.find((item) => item.id === "aiverse-skills:whisper");
assert.ok(whisper, "real Skills provider did not expose whisper");
const selected = selectCapability({ ...options, qualifiedId: "aiverse-skills:whisper" });
assert.equal(selected.status, "selected");
assert.equal(selected.selection.generation_id, provider.generation_id);
assert.equal(selected.selection.digest.algorithm, "aiverse-package-sha256-v1");
fs.writeFileSync(process.env.PLATFORM_CAPABILITIES_JSON, JSON.stringify(discovered.candidates, null, 2));
console.log("OS x Skills provider discovery: PASS");
'''
    run(
        "OS x Skills provider discovery",
        ["node", "--input-type=module", "-e", script],
        cwd=os_root,
        env={
            "PLATFORM_SKILLS_ROOT": str(skills_root),
            "PLATFORM_WORK_ROOT": str(work_root),
            "PLATFORM_CAPABILITIES_JSON": str(capabilities_path),
        },
    )
    capabilities = json.loads(capabilities_path.read_text(encoding="utf-8"))
    if not isinstance(capabilities, list):
        raise RuntimeError("OS capability resolver did not emit a candidate list")
    return capabilities


def exercise_brain_memory_skills(os_root: Path, capabilities: list[dict]) -> None:
    from aiverse_brain import BrainRuntime, Scope
    from aiverse_brain.cadence import Trigger
    from aiverse_brain.direction_ownership import DirectionOwnershipService
    from aiverse_brain.host_selection import HostSelection
    from aiverse_brain.tick_output import build_tick_summary

    memory = load_memory(os_root)
    memory_mode = memory.detect_mode(os_root)

    class PlatformHost:
        def __init__(self) -> None:
            self.action_calls = 0
            self.notifications = 0
            self.context_reads: list[dict] = []

        def read_context(self, scope):
            completed = subprocess.run(
                [
                    "node",
                    str(os_root / "scripts" / "current-context.mjs"),
                    "read",
                    "--root",
                    str(os_root),
                    "--scope",
                    str(scope),
                ],
                text=True,
                capture_output=True,
                check=True,
            )
            payload = json.loads(completed.stdout)
            self.context_reads.append(payload)
            return payload

        def retrieve_history(self, query, scope):
            rows = memory.recall(query, scope=str(scope), limit=12, root=os_root, mode=memory_mode)
            return [dict(row) for row in rows]

        def list_capabilities(self, scope):
            return list(capabilities)

        def list_connections(self, scope):
            return []

        def request_action(self, request):
            self.action_calls += 1
            raise AssertionError("platform smoke cognition must not dispatch host actions")

        def request_evaluation(self, request):
            return {}

        def schedule_trigger(self, trigger):
            return {}

        def cancel_trigger(self, trigger_id):
            return None

        def notify_user(self, notification):
            self.notifications += 1
            raise AssertionError("platform smoke runtime must not notify implicitly")

        def write_route(self, classification, payload, scope):
            return None

    class CaptureReasoner:
        model_id = "platform-smoke-capture"

        def __init__(self) -> None:
            self.contexts: list[tuple[object, dict]] = []

        def reason(self, request, context):
            self.contexts.append((request, context))
            return {"proposals": []}

    runtime = BrainRuntime(str(os_root))
    ownership = DirectionOwnershipService(runtime.controller)
    assert ownership.owner("operator") == "os"
    handover = ownership.handover("operator", confirm_import=True)
    assert handover.owner == "brain"
    assert handover.state == "active"
    assert len(handover.brain_refs) == 1
    goal_id = handover.brain_refs[0].split("brain:intent:", 1)[1]
    goal = runtime.controller.store.load("intent", "operator", goal_id)
    assert goal.status == "CONFIRMED"
    assert "Aurora release" in goal.payload["statement"]

    host = PlatformHost()
    reasoner = CaptureReasoner()
    result = runtime.run_tick(
        Trigger("scheduled_orientation", Scope("operator"), "platform-wide-smoke"),
        host=host,
        reasoner=reasoner,
        session_id="platform-wide-smoke",
    )
    assert result.ok, result.errors
    assert result.reasoner_calls == 2
    assert len(reasoner.contexts) == 2
    assert host.action_calls == 0
    assert host.notifications == 0
    assert host.context_reads
    assert all("FROZEN PLATFORM STRATEGY" not in str(item.get("current_context", "")) for item in host.context_reads)
    assert any("platform operational fact" in str(item.get("current_context", "")) for item in host.context_reads)

    history_rows = [row for _, ctx in reasoner.contexts for row in ctx.get("history", [])]
    matched_history = [
        row for row in history_rows
        if "Aurora release prerequisite" in str(row.get("text", ""))
    ]
    assert matched_history, "Brain history context did not contain the real Memory record"
    assert any(row.get("source_identity") for row in matched_history)
    assert any(row.get("source_version") for row in matched_history)

    capability_rows = [row for _, ctx in reasoner.contexts for row in ctx.get("capabilities", [])]
    whisper = next((row for row in capability_rows if row.get("id") == "aiverse-skills:whisper"), None)
    assert whisper is not None, "Brain capability ranking lost the real whisper capability"
    assert whisper.get("generation_id")
    assert whisper.get("digest", {}).get("algorithm") == "aiverse-package-sha256-v1"

    retrieval_queries = [ctx.get("retrieval_queries", {}) for _, ctx in reasoner.contexts]
    joined_queries = json.dumps(retrieval_queries).lower()
    assert "aurora" in joined_queries
    assert "whisper" in joined_queries
    assert "gap_analysis" not in joined_queries

    selection = HostSelection(
        host=host,
        mode="platform-smoke-host",
        real_host=True,
        adapter_id="acceptance:os-memory-skills",
        operations=("read_context", "retrieve_history", "list_capabilities", "list_connections"),
    )
    summary = build_tick_summary(result, selection, runtime)
    assert summary["orientation"]["mode"] == "deterministic"
    assert summary["orientation"]["direction_owner"] == "brain"
    assert summary["orientation"]["state"]["goals"]["total"] >= 1
    assert any(item.get("id") == goal.id for item in summary["orientation"]["state"]["goals"]["items"])

    print("OS direction handover x Memory x Brain x Skills runtime data flow: PASS")


def verify_context_boundary(os_root: Path) -> None:
    payload = run_json(
        "Ownership-aware OS current-context read",
        [
            "node",
            str(os_root / "scripts" / "current-context.mjs"),
            "read",
            "--root",
            str(os_root),
            "--scope",
            "operator",
        ],
        cwd=os_root,
    )
    current = str(payload.get("current_context", ""))
    assert payload.get("direction_owner") == "brain"
    assert "FROZEN PLATFORM STRATEGY" not in current
    assert "platform operational fact" in current
    print("Frozen OS strategy read boundary after Brain handover: PASS")


def verify_memory_isolation(os_root: Path) -> None:
    memory = load_memory(os_root)
    mode = memory.detect_mode(os_root)
    for workspace in ("alpha", "beta"):
        workspace_root = os_root / "workspaces" / workspace
        (workspace_root / "context").mkdir(parents=True, exist_ok=True)
        (workspace_root / "WORKSPACE.yaml").write_text(
            f'schema_version: "1.0"\nid: {workspace}\nname: {workspace.title()}\n',
            encoding="utf-8",
        )

    alpha_id, _, _ = memory.write_atomic(
        "alpha-only-platform-smoke-secret",
        "state",
        "workspace:alpha",
        root=os_root,
        mode=mode,
    )
    beta_id, _, _ = memory.write_atomic(
        "beta-only-platform-smoke-secret",
        "state",
        "workspace:beta",
        root=os_root,
        mode=mode,
    )
    beta_rows = memory.recall(
        "alpha-only-platform-smoke-secret",
        workspace="beta",
        root=os_root,
        mode=mode,
    )
    assert alpha_id not in {row["id"] for row in beta_rows}
    assert "workspace:alpha" not in {row["scope"] for row in beta_rows}
    alpha_rows = memory.recall(
        "alpha-only-platform-smoke-secret",
        workspace="alpha",
        root=os_root,
        mode=mode,
    )
    alpha_ids = {row["id"] for row in alpha_rows}
    assert alpha_id in alpha_ids
    assert beta_id not in alpha_ids
    print("Memory workspace isolation under composition: PASS")


def verify_permission_intersection(os_root: Path) -> None:
    from aiverse_brain.action_boundary import ActionExecutor, ActionRequest
    from aiverse_brain.errors import PermissionDenied
    from aiverse_brain.models import Scope
    from aiverse_brain.policy import BrainPolicy

    policy_path = os_root / "automations" / "policies" / "action-permissions.yaml"
    policy_path.parent.mkdir(parents=True, exist_ok=True)
    policy_path.write_text(
        'schema_version: "1.0"\n'
        'approval:\n'
        '  external_actions: "deny"\n'
        '  destructive_actions: "deny"\n'
        '  high_stakes_decisions: "deny"\n',
        encoding="utf-8",
    )

    class OSHost:
        action_calls = 0

        def authorize_action(self, request):
            completed = subprocess.run(
                ["node", "scripts/action-permission.mjs", "--root", str(os_root)],
                cwd=str(os_root),
                input=json.dumps(request),
                text=True,
                capture_output=True,
                check=True,
            )
            return json.loads(completed.stdout)

        def request_action(self, request):
            self.action_calls += 1
            return {"status": "succeeded", "effect_occurred": True, "result": {}}

    policy = BrainPolicy()
    policy.action_policy["send_message"] = "allow_within_scope"
    request = ActionRequest(
        action_class="send_message",
        scope=Scope("operator"),
        operation="send",
        parameters={"to": "contract@example.test", "body": "platform smoke"},
        idempotency_key="platform-smoke-permission",
        in_scope=True,
        within_budget=True,
        reversible=True,
        reason="platform smoke acceptance",
    )
    host = OSHost()
    try:
        ActionExecutor(os_root, policy).execute(request, host, host_idempotency_supported=True)
    except PermissionDenied:
        pass
    else:
        raise AssertionError("OS deny did not override Brain allow")
    assert host.action_calls == 0
    print("OS x Brain restrictive permission intersection: PASS")


def install_multiple_bots(os_root: Path, multiple_bots_root: Path, work_root: Path) -> None:
    extension_root = os_root / ".aiverse" / "extensions" / "ai-verse-multiple-bots"
    extension_root.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(
        multiple_bots_root / "integrations" / "ai-verse-os" / "INSTRUCTIONS.md",
        extension_root / "INSTRUCTIONS.md",
    )
    dist_source = multiple_bots_root / "dist" / "src"
    if not dist_source.is_dir():
        raise RuntimeError("Multiple Bots dist/src is missing; run the platform smoke through npm so build happens first")
    shutil.copytree(dist_source, extension_root / "dist", dirs_exist_ok=True)
    (extension_root / "engine.mjs").write_text('export * from "./dist/index.js";\n', encoding="utf-8")

    cli = multiple_bots_root / "dist" / "src" / "cli.js"
    detected = run_json(
        "Multiple Bots detects the real composed OS",
        ["node", str(cli), "os", "detect", "--root", str(os_root)],
        cwd=multiple_bots_root,
    )
    assert detected.get("ok") is True
    assert detected.get("compatibility", {}).get("status") == "compatible"

    registered = run_json(
        "Multiple Bots registers through the OS extension registry",
        ["node", str(cli), "os", "register", "--root", str(os_root)],
        cwd=multiple_bots_root,
    )
    assert registered.get("ok") is True
    assert registered.get("registration", {}).get("extension_id") == "ai-verse-multiple-bots"

    registry = json.loads((os_root / ".aiverse" / "extensions" / "registry.json").read_text(encoding="utf-8"))
    extensions = registry.get("extensions", {})
    assert "ai-verse-memory" in extensions, "Multiple Bots registration lost the Memory extension entry"
    bots_entry = extensions.get("ai-verse-multiple-bots")
    assert isinstance(bots_entry, dict)
    assert bots_entry.get("installed") is True
    assert bots_entry.get("enabled") is True
    assert bots_entry.get("instructions") == ".aiverse/extensions/ai-verse-multiple-bots/INSTRUCTIONS.md"
    assert bots_entry.get("engine") == ".aiverse/extensions/ai-verse-multiple-bots/engine.mjs"

    engine_url = (extension_root / "engine.mjs").resolve().as_uri()
    run(
        "Load installed Multiple Bots extension engine",
        ["node", "--input-type=module", "-e", f"await import({json.dumps(engine_url)}); console.log('Multiple Bots extension engine load: PASS')"],
        cwd=os_root,
    )

    doctor_db = work_root / "multiple-bots-smoke.db"
    doctor = run_json(
        "Multiple Bots coordination store doctor",
        ["node", str(cli), "doctor", "--db", str(doctor_db)],
        cwd=multiple_bots_root,
    )
    if doctor.get("ok") is False:
        raise RuntimeError(f"Multiple Bots doctor reported failure: {doctor}")

    tracked = run(
        "Verify extension composition did not dirty tracked OS files beyond explicit Brain registration",
        ["git", "status", "--porcelain", "--untracked-files=no"],
        cwd=os_root,
        capture=True,
    ).stdout.strip().splitlines()
    unexpected = [line for line in tracked if line.strip() and not line.endswith("AI-VERSE.yaml")]
    if unexpected:
        raise RuntimeError(f"unexpected tracked OS mutations: {unexpected}")
    print("Multiple Bots x real AI-Verse OS extension composition: PASS")


def main() -> int:
    parser = argparse.ArgumentParser(description="Composed AI-Verse platform smoke acceptance")
    parser.add_argument("--os-root", required=True)
    parser.add_argument("--memory-root", required=True)
    parser.add_argument("--brain-root", required=True)
    parser.add_argument("--skills-root", required=True)
    parser.add_argument("--multiple-bots-root", required=True)
    parser.add_argument("--work-root", required=True)
    args = parser.parse_args()

    os_root = Path(args.os_root).resolve()
    memory_root = Path(args.memory_root).resolve()
    brain_root = Path(args.brain_root).resolve()
    skills_repo = Path(args.skills_root).resolve()
    multiple_bots_root = Path(args.multiple_bots_root).resolve()
    work_root = Path(args.work_root).resolve()

    run(
        "Install Memory into the audited OS checkout",
        [
            sys.executable,
            str(memory_root / "scripts" / "install.py"),
            "--target",
            str(os_root),
            "--source-dir",
            str(memory_root),
        ],
    )
    registry_path = os_root / ".aiverse" / "extensions" / "registry.json"
    assert registry_path.is_file()
    assert "ai-verse-memory" in registry_path.read_text(encoding="utf-8")

    announce("Enable and initialize Brain under the OS contract")
    enable_brain(os_root)
    from aiverse_brain.installation import initialize, read_installation_marker
    initialize(str(os_root))
    assert read_installation_marker(str(os_root)) is not None
    print("Brain native initialization: PASS")

    installed_skills_root = work_root / "installed-skills"
    skills_cache = work_root / "skills-cache"
    run(
        "Install audited Skills generation externally",
        [
            sys.executable,
            str(skills_repo / "installer" / "aiverse_skills.py"),
            "--root",
            str(installed_skills_root),
            "--cache",
            str(skills_cache),
            "install",
            "--profile",
            "creator",
        ],
    )
    capabilities = discover_skills(os_root, installed_skills_root, work_root)

    context_path = os_root / "operator" / "context" / "CURRENT.md"
    context_path.parent.mkdir(parents=True, exist_ok=True)
    context_path.write_text(
        "# Current Context\n\n"
        "## Current priorities\n\n"
        "- FROZEN PLATFORM STRATEGY: Ship the Aurora release after whisper dialogue transcription and transcode validation.\n\n"
        "## Current state\n\n"
        "- platform operational fact: the media workspace is mounted and healthy.\n",
        encoding="utf-8",
    )
    run(
        "Write a real Memory record used by Brain retrieval",
        [
            sys.executable,
            str(os_root / "scripts" / "ai-verse-memory" / "memory.py"),
            "--root",
            str(os_root),
            "remember",
            "--type",
            "experience",
            "--scope",
            "operator",
            "--source",
            "platform-wide-smoke",
            "--text",
            "Aurora release prerequisite: transcode dialogue with whisper before delivery",
        ],
    )

    announce("Exercise OS direction x Memory x Brain x Skills runtime flow")
    exercise_brain_memory_skills(os_root, capabilities)
    verify_context_boundary(os_root)

    announce("Exercise Memory workspace isolation under full composition")
    verify_memory_isolation(os_root)

    announce("Exercise OS x Brain permission intersection")
    verify_permission_intersection(os_root)

    announce("Exercise Multiple Bots against the composed host")
    install_multiple_bots(os_root, multiple_bots_root, work_root)

    print("\nFive-repo composed runtime acceptance: PASS")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"\nFive-repo composed runtime acceptance: FAIL\n{error}", file=sys.stderr)
        raise
