import { createGatewayServer } from "../dist/src/server.js";

const service = createGatewayServer({
  dbPath: ":memory:",
  port: 0,
  channelBindings: [{
    id: "telegram_release_example",
    provider: "telegram",
    accountId: "example-bot",
    conversationId: "9001",
    workspaceId: "example-workspace",
    targetKind: "bot",
    targetId: "bot_channel"
  }]
});

service.gateway.createBot({
  schema_version: "1.0",
  id: "bot_channel",
  name: "Channel Bot",
  kind: "durable",
  status: "active",
  role: { title: "Channel Bot", mission: "Demonstrate channel normalization." },
  runtime: { adapter: "deterministic" },
  execution: { environment_policy: "shared_workspace" },
  scope: { type: "workspace", workspace_id: "example-workspace" },
  permissions: { policy_ref: "default-bot", allowed_peers: ["*"] },
  coordination: { default_mode: "direct" }
});

const address = await service.listen();
const base = `http://127.0.0.1:${address.port}`;

try {
  const ingress = await (await fetch(base + "/v1/channels/telegram/ingress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountId: "example-bot",
      adapterVerified: true,
      update: {
        update_id: 1,
        message: {
          message_id: 42,
          date: 1800000000,
          chat: { id: 9001 },
          from: { id: 7001 },
          text: "Hello from the trusted Telegram adapter"
        }
      }
    })
  })).json();

  const reply = service.gateway.sendMessage({
    senderId: "bot_channel",
    targetKind: "operator",
    targetId: ingress.actor_id,
    workspaceId: "example-workspace",
    text: "Hello back",
    replyToMessageId: ingress.canonical_message_id
  });

  const egress = await (await fetch(base + "/v1/channels/egress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      bindingId: "telegram_release_example",
      messageId: reply.message.id
    })
  })).json();

  console.log(JSON.stringify({
    example: "channel-bridge",
    ingress_provider: ingress.provider,
    target_id: ingress.target.id,
    external_recipient_id: egress.external_recipient_id,
    reply_to_external_message_id: egress.reply_to_external_message_id,
    transport_method: egress.transport_command.method,
    channel_owns_truth: egress.channel_owns_truth
  }, null, 2));
} finally {
  await service.close();
}
