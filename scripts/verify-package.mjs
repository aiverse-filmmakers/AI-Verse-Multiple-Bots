import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(process.cwd());
const tempRoot = mkdtempSync(join(tmpdir(), "ai-verse-multiple-bots-pack-"));
const packDir = join(tempRoot, "pack");
const installDir = join(tempRoot, "install");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        result.stdout,
        result.stderr
      ].filter(Boolean).join("\n")
    );
  }
  return result.stdout.trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });

  const packedJson = run("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    packDir
  ]);
  const packed = JSON.parse(packedJson);
  assert.equal(Array.isArray(packed), true, "npm pack --json must return an array");
  assert.equal(packed.length, 1, "npm pack must produce exactly one package");

  const record = packed[0];
  assert.equal(record.name, "@ai-verse/multiple-bots");
  assert.equal(record.version, "0.1.0-alpha.1");
  const files = new Set((record.files ?? []).map((entry) => String(entry.path)));

  for (const required of [
    "package.json",
    "README.md",
    "dist/src/cli.js",
    "dist/src/server.js",
    "dist/src/standalone-install.js",
    "dist/src/ai-verse-os-install.js",
    "dist/src/setup.js",
    "dist/src/template-catalog.js",
    "dist/src/production-health.js",
    "dist/src/update.js",
    "dist/src/standalone-update.js",
    "dist/src/standalone-receipt.js",
    "dist/src/ai-verse-os-update.js",
    "dist/src/coordination-migration.js",
    "dist/src/versioning.js",
    "dist/src/gateway-security.js",
    "dist/src/secure-remote-gateway.js",
    "dist/src/dashboard-projection.js",
    "dist/src/dashboard-control.js",
    "dist/src/channel-bridge.js",
    "dist/src/operator-attention.js",
    "dist/src/observability.js",
    "schemas/coordination-v1.schema.json",
    "templates/bot.yaml",
    "templates/room.yaml",
    "templates/starter-catalog.json",
    "integrations/ai-verse-os/INSTRUCTIONS.md",
    "integrations/ai-verse-os/extension.json"
  ]) {
    assert.equal(files.has(required), true, `packed artifact is missing ${required}`);
  }

  for (const forbiddenPrefix of ["test/", "dist/test/", "runtime/"]) {
    assert.equal(
      [...files].some((path) => path.startsWith(forbiddenPrefix)),
      false,
      `packed artifact must not contain ${forbiddenPrefix}`
    );
  }

  const tarball = join(packDir, basename(String(record.filename)));
  assert.equal(existsSync(tarball), true, "npm pack did not create the tarball");

  writeFileSync(
    join(installDir, "package.json"),
    JSON.stringify({ name: "phase-5-1-install-smoke", private: true }, null, 2) + "\n",
    "utf8"
  );
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: installDir });

  const installedPackagePath = join(installDir, "node_modules", "@ai-verse", "multiple-bots", "package.json");
  const installed = JSON.parse(readFileSync(installedPackagePath, "utf8"));
  assert.deepEqual(installed.bin, { "ai-verse-multiple-bots": "dist/src/cli.js" });
  assert.equal(installed.scripts?.postinstall, undefined, "package must not mutate the host during npm install");

  const binName = process.platform === "win32" ? "ai-verse-multiple-bots.cmd" : "ai-verse-multiple-bots";
  const binPath = join(installDir, "node_modules", ".bin", binName);
  assert.equal(existsSync(binPath), true, "npm install did not expose the CLI bin");

  const setupModes = JSON.parse(run(binPath, ["setup", "modes"], { cwd: installDir }));
  assert.equal(setupModes.ok, true);
  assert.deepEqual(
    setupModes.setup_help.modes.map((item) => item.mode),
    ["standalone", "ai-verse-os"]
  );

  const templateList = JSON.parse(run(binPath, ["template", "list"], { cwd: installDir }));
  assert.equal(templateList.ok, true);
  assert.deepEqual(
    templateList.templates.map((item) => item.id),
    ["research-lead", "reviewer", "coordinator", "research-team", "delivery-team"]
  );

  const templateDbPath = join(installDir, "runtime", "template-smoke.db");
  const templatePlan = JSON.parse(run(
    binPath,
    ["template", "plan", "--id", "research-team", "--workspace", "ws_package", "--runtime", "deterministic", "--db", templateDbPath],
    { cwd: installDir }
  ));
  assert.equal(templatePlan.ok, true);
  assert.equal(templatePlan.plan.can_apply, true);
  assert.equal(templatePlan.plan.creates_team_run, false);
  assert.equal(templatePlan.plan.objects.length, 4);

  const templateApply = JSON.parse(run(
    binPath,
    ["template", "apply", "--id", "research-team", "--workspace", "ws_package", "--runtime", "deterministic", "--db", templateDbPath],
    { cwd: installDir }
  ));
  assert.equal(templateApply.ok, true);
  assert.equal(templateApply.application.status, "applied");
  assert.equal(templateApply.application.created_ids.length, 4);

  const templateApplyAgain = JSON.parse(run(
    binPath,
    ["template", "apply", "--id", "research-team", "--workspace", "ws_package", "--runtime", "deterministic", "--db", templateDbPath],
    { cwd: installDir }
  ));
  assert.equal(templateApplyAgain.ok, true);
  assert.equal(templateApplyAgain.application.status, "unchanged");
  assert.deepEqual(templateApplyAgain.application.created_ids, []);

  const setupStandaloneRoot = join(installDir, "setup-standalone-project");
  mkdirSync(setupStandaloneRoot, { recursive: true });
  const setupStandalone = JSON.parse(run(
    binPath,
    ["setup", "--mode", "standalone", "--root", setupStandaloneRoot, "--port", "0"],
    { cwd: installDir }
  ));
  assert.equal(setupStandalone.ok, true);
  assert.equal(setupStandalone.setup.mode, "standalone");
  assert.equal(setupStandalone.setup.status, "ready");
  assert.equal(setupStandalone.setup.selected_by, "explicit");
  assert.equal(existsSync(join(setupStandaloneRoot, ".ai-verse-bots", "config.json")), true);
  assert.equal(existsSync(join(setupStandaloneRoot, ".ai-verse-bots", "runtime", "coordination.db")), true);

  const standaloneStatus = JSON.parse(run(
    binPath,
    ["status", "--mode", "standalone", "--root", setupStandaloneRoot],
    { cwd: installDir }
  ));
  assert.equal(standaloneStatus.state, "ready");
  assert.equal(standaloneStatus.ready, true);

  const productionStandaloneDoctor = JSON.parse(run(
    binPath,
    ["doctor", "--mode", "standalone", "--root", setupStandaloneRoot],
    { cwd: installDir }
  ));
  assert.equal(productionStandaloneDoctor.provider, "ai-verse-multiple-bots/production-health-v1");
  assert.equal(productionStandaloneDoctor.state, "ready");
  assert.equal(productionStandaloneDoctor.ready, true);
  assert.equal(productionStandaloneDoctor.read_only, true);
  assert.deepEqual(
    productionStandaloneDoctor.checked_depths,
    ["structural", "attachment", "runtime", "dependency", "operational"]
  );

  const fakeTailscalePath = join(installDir, "tailscale-fake");
  writeFileSync(fakeTailscalePath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("1.99.0-package-smoke");
  process.exit(0);
}
if (args[0] === "status" && args[1] === "--json") {
  console.log(JSON.stringify({ BackendState: "Running" }));
  process.exit(0);
}
if (args[0] === "serve") {
  console.log("Available within your tailnet:");
  console.log("https://package-smoke.example.ts.net");
  const timer = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });
  process.on("SIGINT", () => { clearInterval(timer); process.exit(0); });
} else {
  process.exit(2);
}
`, { encoding: "utf8", mode: 0o755 });

  const remoteToken = "package-smoke-remote-token-abcdefghijklmnopqrstuvwxyz";
  const remotePlan = JSON.parse(run(
    binPath,
    [
      "remote", "plan",
      "--mode", "standalone",
      "--root", setupStandaloneRoot,
      "--local-port", "0",
      "--tailscale-bin", fakeTailscalePath
    ],
    {
      cwd: installDir,
      env: { AI_VERSE_GATEWAY_TOKEN: remoteToken }
    }
  ));
  assert.equal(remotePlan.ok, true);
  assert.equal(remotePlan.remote.provider, "tailscale-serve");
  assert.equal(remotePlan.remote.mode, "standalone");
  assert.equal(remotePlan.remote.local_host, "127.0.0.1");
  assert.equal(remotePlan.remote.transport.exposure, "tailnet-only");
  assert.equal(remotePlan.remote.transport.tailnet_connected, true);
  assert.equal(remotePlan.remote.transport.tls_terminated_by, "tailscale-serve");
  assert.equal(remotePlan.remote.auth.configured, true);
  assert.equal(JSON.stringify(remotePlan).includes(remoteToken), false);

  const installedRoot = join(installDir, "node_modules", "@ai-verse", "multiple-bots");
  const installedServerUrl = pathToFileURL(join(installedRoot, "dist", "src", "server.js")).href;
  const installedSecurityUrl = pathToFileURL(join(installedRoot, "dist", "src", "gateway-security.js")).href;
  const inboundAuthSmoke = JSON.parse(run(process.execPath, [
    "--input-type=module",
    "--eval",
    `const s=await import(${JSON.stringify(installedServerUrl)}); const g=await import(${JSON.stringify(installedSecurityUrl)}); const token=${JSON.stringify(remoteToken)}; const service=s.createGatewayServer({dbPath:':memory:',port:0,inboundAuth:g.resolveGatewayBearerAuth('AI_VERSE_GATEWAY_TOKEN',{AI_VERSE_GATEWAY_TOKEN:token})}); const a=await service.listen(); try { const u='http://127.0.0.1:'+a.port+'/health'; const no=await fetch(u); const yes=await fetch(u,{headers:{authorization:'Bearer '+token}}); const body=await yes.json(); console.log(JSON.stringify({unauthorized:no.status,authorized:yes.status,ok:body.ok,nosniff:yes.headers.get('x-content-type-options')})); } finally { await service.close(); }`
  ], { cwd: installDir }));
  assert.equal(inboundAuthSmoke.unauthorized, 401);
  assert.equal(inboundAuthSmoke.authorized, 200);
  assert.equal(inboundAuthSmoke.ok, true);
  assert.equal(inboundAuthSmoke.nosniff, "nosniff");

  const dashboardSmoke = JSON.parse(run(process.execPath, [
    "--input-type=module",
    "--eval",
    `const s=await import(${JSON.stringify(installedServerUrl)}); const service=s.createGatewayServer({dbPath:':memory:',port:0}); service.gateway.createBot({schema_version:'1.0',id:'bot_dashboard_package',name:'Package Dashboard Bot',kind:'durable',status:'active',role:{title:'Package Bot',mission:'Verify Dashboard package surface'},runtime:{adapter:'deterministic'},execution:{environment_policy:'shared_workspace'},scope:{type:'workspace',workspace_id:'ws_dashboard_package'},permissions:{policy_ref:'default-bot',allowed_peers:['*']},coordination:{default_mode:'direct'}}); const a=await service.listen(); try { const base='http://127.0.0.1:'+a.port; const before=await (await fetch(base+'/v1/dashboard/snapshot?workspace=ws_dashboard_package')).json(); const control=await (await fetch(base+'/v1/dashboard/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'bot.disable',workspaceId:'ws_dashboard_package',targetId:'bot_dashboard_package',actorId:'operator_package'})})).json(); const after=await (await fetch(base+'/v1/dashboard/snapshot?workspace=ws_dashboard_package')).json(); console.log(JSON.stringify({provider:before.provider,projection_only:before.projection_only,bots_before:before.bots.length,control_provider:control.provider,control_status:control.resulting_status,bot_status_after:after.bots[0]?.status,dashboard_owns_truth:after.dashboard_owns_truth})); } finally { await service.close(); }`
  ], { cwd: installDir }));
  assert.equal(dashboardSmoke.provider, "ai-verse-multiple-bots/dashboard-projection-v1");
  assert.equal(dashboardSmoke.projection_only, true);
  assert.equal(dashboardSmoke.bots_before, 1);
  assert.equal(dashboardSmoke.control_provider, "ai-verse-multiple-bots/dashboard-control-v1");
  assert.equal(dashboardSmoke.control_status, "disabled");
  assert.equal(dashboardSmoke.bot_status_after, "disabled");
  assert.equal(dashboardSmoke.dashboard_owns_truth, false);

  const channelSmoke = JSON.parse(run(process.execPath, [
    "--input-type=module",
    "--eval",
    `const s=await import(${JSON.stringify(installedServerUrl)}); const service=s.createGatewayServer({dbPath:':memory:',port:0,channelBindings:[{id:'package_telegram',provider:'telegram',accountId:'package_bot',conversationId:'7301',workspaceId:'ws_channel_package',targetKind:'bot',targetId:'bot_channel_package'}]}); service.gateway.createBot({schema_version:'1.0',id:'bot_channel_package',name:'Package Channel Bot',kind:'durable',status:'active',role:{title:'Channel Bot',mission:'Verify channel package surface'},runtime:{adapter:'deterministic'},execution:{environment_policy:'shared_workspace'},scope:{type:'workspace',workspace_id:'ws_channel_package'},permissions:{policy_ref:'default-bot',allowed_peers:['*']},coordination:{default_mode:'direct'}}); const a=await service.listen(); try { const base='http://127.0.0.1:'+a.port; const ingress=await (await fetch(base+'/v1/channels/telegram/ingress',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accountId:'package_bot',adapterVerified:true,update:{update_id:1,message:{message_id:9,date:1800000000,chat:{id:7301},from:{id:3301},text:'package channel'}}})})).json(); const reply=service.gateway.sendMessage({senderId:'bot_channel_package',targetKind:'operator',targetId:ingress.actor_id,workspaceId:'ws_channel_package',text:'package reply',replyToMessageId:ingress.canonical_message_id}); const egress=await (await fetch(base+'/v1/channels/egress',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bindingId:'package_telegram',messageId:reply.message.id})})).json(); console.log(JSON.stringify({provider:ingress.provider,binding:ingress.binding_id,target:ingress.target.id,recipient:egress.external_recipient_id,replyTo:egress.reply_to_external_message_id,method:egress.transport_command.method,channelOwnsTruth:egress.channel_owns_truth})); } finally { await service.close(); }`
  ], { cwd: installDir }));
  assert.equal(channelSmoke.provider, "ai-verse-multiple-bots/channel-bridge-v1");
  assert.equal(channelSmoke.binding, "package_telegram");
  assert.equal(channelSmoke.target, "bot_channel_package");
  assert.equal(channelSmoke.recipient, "3301");
  assert.equal(channelSmoke.replyTo, "9");
  assert.equal(channelSmoke.method, "sendMessage");
  assert.equal(channelSmoke.channelOwnsTruth, false);

  const operatorAttentionSmoke = JSON.parse(run(process.execPath, [
    "--input-type=module",
    "--eval",
    `const s=await import(${JSON.stringify(installedServerUrl)}); const service=s.createGatewayServer({dbPath:':memory:',port:0}); service.gateway.createBot({schema_version:'1.0',id:'bot_operator_requester',name:'Requester',kind:'durable',status:'active',role:{title:'Requester',mission:'Request approval'},runtime:{adapter:'deterministic'},execution:{environment_policy:'shared_workspace'},scope:{type:'workspace',workspace_id:'ws_operator_package'},permissions:{policy_ref:'default-bot',allowed_peers:['bot_operator_worker']},coordination:{default_mode:'direct'}}); service.gateway.createBot({schema_version:'1.0',id:'bot_operator_worker',name:'Worker',kind:'durable',status:'active',role:{title:'Worker',mission:'Execute approved work'},runtime:{adapter:'deterministic'},execution:{environment_policy:'shared_workspace'},scope:{type:'workspace',workspace_id:'ws_operator_package'},permissions:{policy_ref:'default-bot',allowed_peers:['*']},coordination:{default_mode:'direct'}}); const d=service.gateway.delegate({createdBy:'bot_operator_requester',assigneeId:'bot_operator_worker',workspaceId:'ws_operator_package',rootObjectiveId:'objective_operator_package',objective:'Publish approved package result',reason:'Package operator smoke',approval:{required:true,action:{kind:'publish.external',summary:'Publish package result'}}}); const a=await service.listen(); try { const base='http://127.0.0.1:'+a.port; const attention=await (await fetch(base+'/v1/operator/attention?workspace=ws_operator_package')).json(); const cards=await (await fetch(base+'/v1/operator/approvals?workspace=ws_operator_package&status=pending')).json(); const decision=await (await fetch(base+'/v1/operator/approvals/'+d.approval.id+'/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspaceId:'ws_operator_package',actorId:'operator_package',decision:'approve'})})).json(); console.log(JSON.stringify({provider:attention.provider,ownsTruth:attention.operator_ux_owns_truth,top:attention.items[0]?.state,pending:cards.approvals.length,summary:cards.approvals[0]?.action_summary,decision:decision.decision,approvalStatus:decision.approval_status,taskStatus:decision.task_status})); } finally { await service.close(); }`
  ], { cwd: installDir }));
  assert.equal(operatorAttentionSmoke.provider, "ai-verse-multiple-bots/operator-attention-v1");
  assert.equal(operatorAttentionSmoke.ownsTruth, false);
  assert.equal(operatorAttentionSmoke.top, "needs_approval");
  assert.equal(operatorAttentionSmoke.pending, 1);
  assert.equal(operatorAttentionSmoke.summary, "Publish package result");
  assert.equal(operatorAttentionSmoke.decision, "approve");
  assert.equal(operatorAttentionSmoke.approvalStatus, "approved");
  assert.equal(operatorAttentionSmoke.taskStatus, "assigned");

  const observabilitySmoke = JSON.parse(run(process.execPath, [
    "--input-type=module",
    "--eval",
    `const s=await import(${JSON.stringify(installedServerUrl)}); const service=s.createGatewayServer({dbPath:':memory:',port:0}); service.gateway.createBot({schema_version:'1.0',id:'bot_observe_package',name:'Observe Bot',kind:'durable',status:'active',role:{title:'Observer',mission:'Verify observability package surface'},runtime:{adapter:'deterministic'},execution:{environment_policy:'shared_workspace'},scope:{type:'workspace',workspace_id:'ws_observe_package'},permissions:{policy_ref:'default-bot',allowed_peers:['*']},coordination:{default_mode:'direct'}}); service.store.putObject('task',{schema_version:'1.0',id:'task_observe_package',type:'task.delegate',created_by:'operator_package',assignee_id:'bot_observe_package',owner_id:'bot_observe_package',workspace_id:'ws_observe_package',root_objective_id:'objective_observe_package',parent_task_id:null,reason:'Package observability smoke',objective:'Observe package usage',required_constraints:[],expected_output:{contract:'artifact'},lease_id:'lease_observe_package',environment_lease_id:null,deadline_at:null,budget:{},approval_id:null,hop:0,max_hops:6,status:'completed',completed_at:new Date().toISOString(),usage:{input_tokens:20,output_tokens:10,cost:0.02,actions:1}}); service.gateway.emit({type:'task.completed',actorId:'bot_observe_package',workspaceId:'ws_observe_package',taskId:'task_observe_package',summary:'Package observable result',attentionState:'unread_result'}); const a=await service.listen(); try { const base='http://127.0.0.1:'+a.port; const snapshot=await (await fetch(base+'/v1/observability/snapshot?workspace=ws_observe_package')).json(); const usage=await (await fetch(base+'/v1/observability/usage?workspace=ws_observe_package')).json(); const timeline=await (await fetch(base+'/v1/observability/timeline?workspace=ws_observe_package&after=0&limit=10')).json(); console.log(JSON.stringify({provider:snapshot.provider,ownsTruth:snapshot.observability_owns_truth,telemetryOwner:snapshot.canonical_telemetry_owner,costOwner:snapshot.canonical_cost_truth_owner,tokenProjection:snapshot.token_projection_interface,isCanonicalTokenTruth:snapshot.runtime_usage_is_canonical_token_truth,pricesHere:snapshot.prices_model_usage_here,tokens:usage.usage.totals.total_tokens,runtimeCostEvidence:usage.usage.totals.runtime_reported_cost_evidence,legacyCost:Object.prototype.hasOwnProperty.call(usage.usage.totals,'cost'),eventSummary:timeline.events.at(-1)?.summary,privateReasoning:snapshot.private_reasoning_exposed})); } finally { await service.close(); }`
  ], { cwd: installDir }));
  assert.equal(observabilitySmoke.provider, "ai-verse-multiple-bots/observability-v1");
  assert.equal(observabilitySmoke.ownsTruth, false);
  assert.equal(observabilitySmoke.telemetryOwner, "ai-verse-token");
  assert.equal(observabilitySmoke.costOwner, "ai-verse-token");
  assert.equal(observabilitySmoke.tokenProjection, "@ai-verse/token/gateway");
  assert.equal(observabilitySmoke.isCanonicalTokenTruth, false);
  assert.equal(observabilitySmoke.pricesHere, false);
  assert.equal(observabilitySmoke.tokens, 30);
  assert.equal(observabilitySmoke.runtimeCostEvidence, 0.02);
  assert.equal(observabilitySmoke.legacyCost, false);
  assert.equal(observabilitySmoke.eventSummary, "Package observable result");
  assert.equal(observabilitySmoke.privateReasoning, false);

  const standaloneConfigPath = join(setupStandaloneRoot, ".ai-verse-bots", "config.json");
  const standaloneReceiptPath = join(setupStandaloneRoot, ".ai-verse-bots", "install.json");
  const standaloneDbPath = join(setupStandaloneRoot, ".ai-verse-bots", "runtime", "coordination.db");
  assert.equal(existsSync(standaloneReceiptPath), true);
  const standaloneConfigBeforeUpdate = readFileSync(standaloneConfigPath, "utf8");
  const standaloneDbBeforeUpdate = sha256(standaloneDbPath);

  rmSync(standaloneReceiptPath, { force: true });
  const legacyStandalonePlan = JSON.parse(run(
    binPath,
    ["update-plan", "--mode", "standalone", "--root", setupStandaloneRoot],
    { cwd: installDir }
  ));
  assert.equal(legacyStandalonePlan.ok, true);
  assert.equal(legacyStandalonePlan.update.mode, "standalone");
  assert.equal(legacyStandalonePlan.update.update_required, true);
  assert.equal(legacyStandalonePlan.update.migration_required, false);
  assert.equal(legacyStandalonePlan.update.can_update, true);
  assert.equal(legacyStandalonePlan.update.plan.installed_version_state, "legacy-unversioned");

  const legacyStandaloneUpdate = JSON.parse(run(
    binPath,
    ["update", "--mode", "standalone", "--root", setupStandaloneRoot],
    { cwd: installDir }
  ));
  assert.equal(legacyStandaloneUpdate.ok, true);
  assert.equal(legacyStandaloneUpdate.update.mode, "standalone");
  assert.equal(legacyStandaloneUpdate.update.status, "adopted");
  assert.equal(legacyStandaloneUpdate.update.migration_performed, false);
  assert.equal(existsSync(standaloneReceiptPath), true);
  assert.equal(readFileSync(standaloneConfigPath, "utf8"), standaloneConfigBeforeUpdate);
  assert.equal(sha256(standaloneDbPath), standaloneDbBeforeUpdate);

  const standaloneUpdateAgain = JSON.parse(run(
    binPath,
    ["standalone", "update", "--root", setupStandaloneRoot],
    { cwd: installDir }
  ));
  assert.equal(standaloneUpdateAgain.ok, true);
  assert.equal(standaloneUpdateAgain.update.status, "unchanged");

  const dbPath = join(installDir, "runtime", "install-smoke.db");
  const initOutput = run(binPath, ["init", "--db", dbPath], { cwd: installDir });
  const init = JSON.parse(initOutput);
  assert.equal(init.ok, true);
  assert.equal(resolve(init.db), resolve(dbPath));
  assert.equal(init.schemaVersion, "1");

  const doctorOutput = run(binPath, ["doctor", "--db", dbPath], { cwd: installDir });
  const doctor = JSON.parse(doctorOutput);
  assert.equal(doctor.ok, true);

  const standaloneRoot = join(installDir, "standalone-project");
  mkdirSync(standaloneRoot, { recursive: true });
  const standaloneInitOutput = run(
    binPath,
    ["standalone", "init", "--root", standaloneRoot, "--port", "0"],
    { cwd: installDir }
  );
  const standaloneInit = JSON.parse(standaloneInitOutput);
  assert.equal(standaloneInit.ok, true);
  assert.equal(standaloneInit.mode, "standalone");
  assert.equal(standaloneInit.installation.status, "initialized");
  assert.equal(existsSync(join(standaloneRoot, ".ai-verse-bots", "config.json")), true);
  assert.equal(existsSync(join(standaloneRoot, ".ai-verse-bots", "runtime", "coordination.db")), true);
  assert.equal(existsSync(join(standaloneRoot, "AI-VERSE.yaml")), false);
  assert.equal(existsSync(join(standaloneRoot, "operator")), false);
  assert.equal(existsSync(join(standaloneRoot, "workspaces")), false);

  const standaloneDoctorOutput = run(
    binPath,
    ["standalone", "doctor", "--root", standaloneRoot],
    { cwd: installDir }
  );
  const standaloneDoctor = JSON.parse(standaloneDoctorOutput);
  assert.equal(standaloneDoctor.provider, "ai-verse-multiple-bots/production-health-v1");
  assert.equal(standaloneDoctor.state, "ready");
  assert.equal(standaloneDoctor.ready, true);
  assert.equal(standaloneDoctor.mode, "standalone");
  assert.equal(standaloneDoctor.read_only, true);

  const osRoot = join(installDir, "ai-verse-os");
  mkdirSync(join(osRoot, "operator"), { recursive: true });
  mkdirSync(join(osRoot, "workspaces"), { recursive: true });
  mkdirSync(join(osRoot, "system", "extensions"), { recursive: true });
  writeFileSync(join(osRoot, "AI-VERSE.yaml"), 'schema_version: "2.0"\narchitecture: unified-workspace\n', "utf8");
  writeFileSync(join(osRoot, "AGENTS.md"), "# Runtime contract\nLoad .aiverse/extensions/registry.json when present.\n", "utf8");
  writeFileSync(join(osRoot, "system", "extensions", "README.md"), "# Local extensions\nRegistry: .aiverse/extensions/registry.json\n", "utf8");
  writeFileSync(join(osRoot, "operator", "sentinel.md"), "operator canonical state\n", "utf8");
  writeFileSync(join(osRoot, "workspaces", "sentinel.md"), "workspace canonical state\n", "utf8");
  const canonicalBefore = {
    manifest: readFileSync(join(osRoot, "AI-VERSE.yaml"), "utf8"),
    agents: readFileSync(join(osRoot, "AGENTS.md"), "utf8"),
    extensionContract: readFileSync(join(osRoot, "system", "extensions", "README.md"), "utf8"),
    operator: readFileSync(join(osRoot, "operator", "sentinel.md"), "utf8"),
    workspace: readFileSync(join(osRoot, "workspaces", "sentinel.md"), "utf8")
  };

  const osPlanOutput = run(binPath, ["os", "install-plan", "--root", osRoot], { cwd: installDir });
  const osPlan = JSON.parse(osPlanOutput);
  assert.equal(osPlan.ok, true);
  assert.equal(osPlan.install.can_install, true);

  const osInstallOutput = run(binPath, ["os", "install", "--root", osRoot], { cwd: installDir });
  const osInstall = JSON.parse(osInstallOutput);
  assert.equal(osInstall.ok, true);
  assert.equal(osInstall.install.status, "installed");
  assert.equal(osInstall.install.database_initialized, true);
  assert.equal(osInstall.install.registration_status, "registered");

  const enginePath = join(osRoot, ".aiverse", "extensions", "ai-verse-multiple-bots", "engine.mjs");
  const instructionsPath = join(osRoot, ".aiverse", "extensions", "ai-verse-multiple-bots", "INSTRUCTIONS.md");
  const registryPath = join(osRoot, ".aiverse", "extensions", "registry.json");
  const osDbPath = join(osRoot, "runtime", "ai-verse-bots", "coordination.db");
  assert.equal(existsSync(enginePath), true);
  assert.equal(existsSync(instructionsPath), true);
  assert.equal(existsSync(registryPath), true);
  assert.equal(existsSync(osDbPath), true);

  const registered = JSON.parse(readFileSync(registryPath, "utf8")).extensions["ai-verse-multiple-bots"];
  assert.equal(registered.source, "AI-Verse-Multiple-Bots");
  assert.equal(registered.version, "0.1.0-alpha.1");
  assert.equal(registered.engine, ".aiverse/extensions/ai-verse-multiple-bots/engine.mjs");

  assert.deepEqual({
    manifest: readFileSync(join(osRoot, "AI-VERSE.yaml"), "utf8"),
    agents: readFileSync(join(osRoot, "AGENTS.md"), "utf8"),
    extensionContract: readFileSync(join(osRoot, "system", "extensions", "README.md"), "utf8"),
    operator: readFileSync(join(osRoot, "operator", "sentinel.md"), "utf8"),
    workspace: readFileSync(join(osRoot, "workspaces", "sentinel.md"), "utf8")
  }, canonicalBefore);

  const engineUrl = pathToFileURL(enginePath).href;
  const engineSmoke = run(process.execPath, [
    "--input-type=module",
    "--eval",
    `const m=await import(${JSON.stringify(engineUrl)}); const s=await m.startGateway({port:0}); try { const r=await fetch('http://'+s.address.host+':'+s.address.port+'/health'); const b=await r.json(); if(!b.ok||b.schemaVersion!=='1') throw new Error('health failed'); console.log(JSON.stringify({ok:true,root:m.aiVerseOsRoot,db:s.db})); } finally { await s.service.close(); }`
  ], { cwd: installDir });
  const engineResult = JSON.parse(engineSmoke);
  assert.equal(engineResult.ok, true);
  assert.equal(resolve(engineResult.root), resolve(osRoot));
  assert.equal(resolve(engineResult.db), resolve(osDbPath));

  const osDbBeforeUpdate = sha256(osDbPath);
  const registryForUpdate = JSON.parse(readFileSync(registryPath, "utf8"));
  registryForUpdate.extensions["ai-verse-multiple-bots"].version = "0.1.0-alpha.0";
  writeFileSync(registryPath, JSON.stringify(registryForUpdate, null, 2) + "\n", "utf8");
  writeFileSync(instructionsPath, "# old package instructions\n", "utf8");
  writeFileSync(enginePath, "export const oldPackageEngine = true;\n", "utf8");

  const osUpdatePlan = JSON.parse(run(
    binPath,
    ["os", "update-plan", "--root", osRoot],
    { cwd: installDir }
  ));
  assert.equal(osUpdatePlan.ok, true);
  assert.equal(osUpdatePlan.update.current_version, "0.1.0-alpha.0");
  assert.equal(osUpdatePlan.update.current_version_state, "older");
  assert.equal(osUpdatePlan.update.update_required, true);
  assert.equal(osUpdatePlan.update.migration_required, false);
  assert.equal(osUpdatePlan.update.can_update, true);

  const osUpdate = JSON.parse(run(
    binPath,
    ["os", "update", "--root", osRoot],
    { cwd: installDir }
  ));
  assert.equal(osUpdate.ok, true);
  assert.equal(osUpdate.update.status, "updated");
  assert.equal(osUpdate.update.previous_version, "0.1.0-alpha.0");
  assert.equal(osUpdate.update.registration_status, "updated");
  assert.deepEqual(osUpdate.update.changed_files, [
    ".aiverse/extensions/ai-verse-multiple-bots/INSTRUCTIONS.md",
    ".aiverse/extensions/ai-verse-multiple-bots/engine.mjs"
  ].sort());
  assert.equal(sha256(osDbPath), osDbBeforeUpdate);
  assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).extensions["ai-verse-multiple-bots"].version, "0.1.0-alpha.1");
  assert.notEqual(readFileSync(instructionsPath, "utf8"), "# old package instructions\n");
  assert.notEqual(readFileSync(enginePath, "utf8"), "export const oldPackageEngine = true;\n");
  assert.deepEqual({
    manifest: readFileSync(join(osRoot, "AI-VERSE.yaml"), "utf8"),
    agents: readFileSync(join(osRoot, "AGENTS.md"), "utf8"),
    extensionContract: readFileSync(join(osRoot, "system", "extensions", "README.md"), "utf8"),
    operator: readFileSync(join(osRoot, "operator", "sentinel.md"), "utf8"),
    workspace: readFileSync(join(osRoot, "workspaces", "sentinel.md"), "utf8")
  }, canonicalBefore);

  const osUpgradeAlias = JSON.parse(run(
    binPath,
    ["os", "upgrade", "--root", osRoot],
    { cwd: installDir }
  ));
  assert.equal(osUpgradeAlias.ok, true);
  assert.equal(osUpgradeAlias.upgrade.status, "unchanged");

  const osInstallAgain = JSON.parse(run(binPath, ["os", "install", "--root", osRoot], { cwd: installDir }));
  assert.equal(osInstallAgain.install.status, "unchanged");
  assert.equal(osInstallAgain.install.database_initialized, false);
  assert.equal(osInstallAgain.install.registration_status, "unchanged");

  const setupOs = JSON.parse(run(binPath, ["setup", "--root", osRoot], { cwd: installDir }));
  assert.equal(setupOs.ok, true);
  assert.equal(setupOs.setup.mode, "ai-verse-os");
  assert.equal(setupOs.setup.status, "ready");
  assert.equal(setupOs.setup.selected_by, "detected");
  assert.equal(setupOs.setup.changed, false);
  assert.equal(setupOs.setup.verification.ok, true);

  const osDoctor = JSON.parse(run(
    binPath,
    ["doctor", "--mode", "os", "--root", osRoot],
    { cwd: installDir }
  ));
  assert.equal(osDoctor.mode, "ai-verse-os");
  assert.equal(osDoctor.state, "ready");
  assert.equal(osDoctor.ready, true);
  assert.deepEqual(osDoctor.delegated_depths, ["system/composed"]);

  console.log(JSON.stringify({
    ok: true,
    package: `${record.name}@${record.version}`,
    tarball: record.filename,
    packed_files: files.size,
    command: "ai-verse-multiple-bots",
    install_smoke: "passed",
    standalone_install_smoke: "passed",
    ai_verse_os_install_smoke: "passed",
    ai_verse_os_engine_smoke: "passed",
    setup_onboarding_smoke: "passed",
    starter_template_smoke: "passed",
    production_doctor_smoke: "passed",
    update_migration_smoke: "passed",
    secure_remote_gateway_smoke: "passed",
    dashboard_projection_control_smoke: "passed",
    channel_bridge_smoke: "passed",
    operator_attention_smoke: "passed",
    observability_usage_smoke: "passed"
  }, null, 2));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
