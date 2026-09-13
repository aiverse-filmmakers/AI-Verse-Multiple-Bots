import assert from "node:assert/strict";
import test from "node:test";
import { CoordinationStore } from "../src/store.js";
import {
  StarterTemplateError,
  applyStarterTemplate,
  getStarterTemplate,
  listStarterTemplates,
  planStarterTemplate
} from "../src/template-catalog.js";
import type { BotManifest } from "../src/types.js";

function conflictingBot(id: string, workspaceId: string): BotManifest {
  return {
    schema_version: "1.0",
    id,
    name: "Conflicting Existing Bot",
    kind: "durable",
    status: "active",
    role: {
      title: "Existing Bot",
      mission: "Existing durable identity that must never be overwritten by template application."
    },
    runtime: { adapter: "native" },
    execution: {
      environment_policy: "shared_workspace",
      environment_ref: "host-default"
    },
    scope: { type: "workspace", workspace_id: workspaceId },
    capabilities: {
      role_refs: [],
      skill_refs: [],
      operator_refs: [],
      tool_refs: []
    },
    permissions: {
      policy_ref: "default-bot",
      allowed_peers: [],
      can_create_workers: false,
      can_create_bots: false,
      can_handoff: false
    },
    memory: {
      adapter: "host",
      view_policy: "role_scoped",
      write_policy: "candidate_only"
    },
    coordination: {
      manager_id: null,
      default_mode: "direct",
      max_parallel_workers: 1,
      max_hops: 6
    }
  };
}

test("Phase 5.5 starter catalog exposes reusable Bot and durable-team templates", () => {
  const templates = listStarterTemplates();
  assert.deepEqual(
    templates.map((template) => [template.id, template.kind]),
    [
      ["research-lead", "bot"],
      ["reviewer", "bot"],
      ["coordinator", "bot"],
      ["research-team", "team"],
      ["delivery-team", "team"]
    ]
  );

  const researchTeam = getStarterTemplate("research-team");
  assert.equal(researchTeam.bots.length, 3);
  assert.equal(researchTeam.room?.leader_slot, "lead");
  assert.equal(researchTeam.room?.mode, "manager");

  assert.throws(
    () => getStarterTemplate("does-not-exist"),
    (error: unknown) => error instanceof StarterTemplateError && error.code === "TEMPLATE_NOT_FOUND"
  );
});

test("Phase 5.5 single-Bot template plan is explicit, least-privilege, and non-mutating", () => {
  const store = new CoordinationStore(":memory:");
  try {
    const plan = planStarterTemplate(store, {
      templateId: "reviewer",
      workspaceId: "ws_alpha"
    });

    assert.equal(plan.can_apply, true);
    assert.equal(plan.template.kind, "bot");
    assert.equal(plan.objects.length, 1);
    assert.equal(plan.objects[0]?.kind, "bot");
    assert.equal(plan.objects[0]?.state, "missing");
    assert.equal(plan.objects[0]?.action, "create");
    assert.equal(plan.creates_durable_bots, true);
    assert.equal(plan.creates_team_run, false);
    assert.equal(plan.mutates_ai_verse_os_truth, false);

    const manifest = plan.objects[0]!.payload as BotManifest;
    assert.equal(manifest.scope.workspace_id, "ws_alpha");
    assert.deepEqual(manifest.permissions.allowed_peers, []);
    assert.equal(manifest.permissions.can_create_bots, false);
    assert.equal(manifest.permissions.can_create_workers, false);
    assert.equal(store.listObjects().length, 0);
  } finally {
    store.close();
  }
});

test("Phase 5.5 team template atomically creates three durable Bots plus one bounded Room and no Team Run", () => {
  const store = new CoordinationStore(":memory:");
  try {
    const result = applyStarterTemplate(store, {
      templateId: "research-team",
      workspaceId: "ws_research"
    });

    assert.equal(result.status, "applied");
    assert.equal(result.created_ids.length, 4);
    assert.equal(result.objects.every((object) => object.state === "current"), true);

    const bots = store.listObjects("bot", "ws_research");
    const rooms = store.listObjects("room", "ws_research");
    const runs = store.listObjects("team_run", "ws_research");

    assert.equal(bots.length, 3);
    assert.equal(rooms.length, 1);
    assert.equal(runs.length, 0);

    const botIds = bots.map((bot) => bot.id).sort();
    const room = rooms[0]!;
    assert.deepEqual([...(room.payload.members as string[])].sort(), botIds);
    assert.equal((room.payload.orchestration as any).leader, "bot_ws_research_research_team_lead");
    assert.equal((room.payload.orchestration as any).speaker_policy, "leader_first");
    assert.equal((room.payload.orchestration as any).max_rounds_per_user_turn, 3);
    assert.equal((room.payload.orchestration as any).max_bot_messages_per_user_turn, 8);

    for (const bot of bots) {
      const peers = (bot.payload.permissions as any).allowed_peers as string[];
      assert.equal(peers.includes("*"), false);
      assert.deepEqual(peers.sort(), botIds.filter((id) => id !== bot.id).sort());
      assert.equal((bot.payload.permissions as any).can_create_bots, false);
      assert.equal(bot.payload.scope && (bot.payload.scope as any).workspace_id, "ws_research");
    }
  } finally {
    store.close();
  }
});

test("Phase 5.5 template apply is idempotent and exact current state is not rewritten", () => {
  const store = new CoordinationStore(":memory:");
  try {
    const first = applyStarterTemplate(store, {
      templateId: "delivery-team",
      workspaceId: "ws_delivery"
    });
    const eventsAfterFirst = store.listEventsAfter(0, 100).length;

    const second = applyStarterTemplate(store, {
      templateId: "delivery-team",
      workspaceId: "ws_delivery"
    });

    assert.equal(first.status, "applied");
    assert.equal(second.status, "unchanged");
    assert.deepEqual(second.created_ids, []);
    assert.equal(second.objects.every((object) => object.state === "current"), true);
    assert.equal(store.listEventsAfter(0, 100).length, eventsAfterFirst);
  } finally {
    store.close();
  }
});

test("Phase 5.5 a conflicting durable identity blocks the whole team with no partial creation", () => {
  const store = new CoordinationStore(":memory:");
  try {
    const workspaceId = "ws_conflict";
    const conflictId = "bot_ws_conflict_research_team_auditor";
    store.putObject("bot", conflictingBot(conflictId, workspaceId));

    const plan = planStarterTemplate(store, {
      templateId: "research-team",
      workspaceId
    });
    assert.equal(plan.can_apply, false);
    assert.deepEqual(plan.conflicts.map((item) => item.id), [conflictId]);

    const beforeBotIds = store.listObjects("bot", workspaceId).map((bot) => bot.id);
    assert.throws(
      () => applyStarterTemplate(store, {
        templateId: "research-team",
        workspaceId
      }),
      (error: unknown) => error instanceof StarterTemplateError && error.code === "TEMPLATE_CONFLICT"
    );

    assert.deepEqual(store.listObjects("bot", workspaceId).map((bot) => bot.id), beforeBotIds);
    assert.deepEqual(store.listObjects("room", workspaceId), []);
  } finally {
    store.close();
  }
});

test("Phase 5.5 partial exact state can be completed without overwriting the current object", () => {
  const store = new CoordinationStore(":memory:");
  try {
    const options = {
      templateId: "research-team",
      workspaceId: "ws_resume"
    };
    const plan = planStarterTemplate(store, options);
    const lead = plan.objects.find((object) => object.id.endsWith("_lead"));
    assert.ok(lead);
    store.putObject("bot", lead.payload);

    const before = store.getObject(lead.id);
    const applied = applyStarterTemplate(store, options);
    const after = store.getObject(lead.id);

    assert.equal(applied.status, "applied");
    assert.equal(applied.created_ids.includes(lead.id), false);
    assert.equal(after?.updatedAt, before?.updatedAt);
    assert.equal(store.listObjects("bot", "ws_resume").length, 3);
    assert.equal(store.listObjects("room", "ws_resume").length, 1);
  } finally {
    store.close();
  }
});

test("Phase 5.5 template identity is workspace-scoped and runtime override remains explicit", () => {
  const store = new CoordinationStore(":memory:");
  try {
    const first = applyStarterTemplate(store, {
      templateId: "coordinator",
      workspaceId: "ws_one",
      runtimeAdapter: "openai-compatible"
    });
    const second = applyStarterTemplate(store, {
      templateId: "coordinator",
      workspaceId: "ws_two",
      runtimeAdapter: "openai-compatible"
    });

    assert.notEqual(first.objects[0]?.id, second.objects[0]?.id);
    assert.equal((first.objects[0]?.payload.runtime as any).adapter, "openai-compatible");
    assert.equal((second.objects[0]?.payload.runtime as any).adapter, "openai-compatible");

    assert.throws(
      () => planStarterTemplate(store, {
        templateId: "coordinator",
        workspaceId: "ws_external",
        runtimeAdapter: "external-managed"
      }),
      (error: unknown) => error instanceof StarterTemplateError
        && error.code === "EXTERNAL_MANAGED_TEMPLATE_UNSUPPORTED"
    );
  } finally {
    store.close();
  }
});

test("Phase 5.5 atomic absent-object preconditions prevent template-style overwrite races", () => {
  const store = new CoordinationStore(":memory:");
  try {
    const id = "bot_atomic_absent";
    store.putObject("bot", conflictingBot(id, "ws_atomic"));

    assert.throws(
      () => store.atomicMutation({
        preconditions: [{ id, kind: "bot", absent: true }],
        objects: [{ kind: "bot", payload: conflictingBot(id, "ws_atomic") }],
        events: []
      }),
      /already exists/
    );
  } finally {
    store.close();
  }
});
