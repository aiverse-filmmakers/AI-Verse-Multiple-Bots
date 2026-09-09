import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ProtocolValidationError, validateProtocolObject } from "../src/validator.js";

test("coordination schema carries Safety II budget fields and canonical Handoff keys", () => {
  const schema = JSON.parse(readFileSync("schemas/coordination-v1.schema.json", "utf8")) as any;
  assert.equal(schema.title, "AI-Verse Multiple Bots Coordination Protocol v1.1");
  assert.ok(schema.$defs.Budget.properties.max_tasks);
  assert.ok(schema.$defs.Budget.properties.max_actions);
  assert.ok(schema.$defs.Handoff.required.includes("target_bot_id"));
  assert.ok(schema.$defs.Handoff.required.includes("task_id"));
  assert.ok(schema.$defs.Handoff.properties.constraints_digest);
});

test("runtime validator accepts canonical Handoff and rejects legacy-only aliases", () => {
  const canonical = {
    schema_version: "1.0",
    id: "handoff_contract",
    type: "handoff",
    source_owner_id: "bot_a",
    target_bot_id: "bot_b",
    workspace_id: "ws_contract",
    task_id: "task_contract",
    root_objective_id: "obj_contract",
    reason: "Transfer specialist ownership",
    required_constraints: ["Do not publish"],
    return_policy: "return_on_completion",
    status: "requested"
  };
  assert.equal(validateProtocolObject(canonical, "handoff").target_bot_id, "bot_b");

  assert.throws(
    () => validateProtocolObject({
      ...canonical,
      target_bot_id: undefined,
      task_id: undefined,
      target_owner_id: "bot_b",
      work_item_id: "task_contract"
    }, "handoff"),
    (error: unknown) => error instanceof ProtocolValidationError
  );
});
