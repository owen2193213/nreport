import { Client, Events, GatewayIntentBits } from "discord.js";

import { AccountBotDatabase } from "./account-database.js";
import { AccountInteractionHandler } from "./account-interactions.js";
import { AccountNotificationWorker } from "./account-notifier.js";
import { registerGlobalCommands } from "./command-registration.js";
import { loadBotConfig } from "./config.js";
import { HealthServer } from "./health.js";
import { MessageResolver } from "./message-resolver.js";
import { BOT_PRESENCE } from "./presence.js";
import { ProfileResolver } from "./profile-resolver.js";
import { ServerResolver } from "./server-resolver.js";
import { DigestWorker } from "./digest-worker.js";

async function main(): Promise<void> {
  const config = loadBotConfig();
  if (config.environment === "production") {
    const count = await registerGlobalCommands({ applicationId: config.applicationId, token: config.token });
    process.stdout.write(`Synchronized ${count} global Discord commands.\n`);
  }
  const database = new AccountBotDatabase(config.databaseUrl);
  await database.migrate();
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    presence: BOT_PRESENCE
  });
  const handler = new AccountInteractionHandler({
    client,
    config,
    database,
    messageResolver: new MessageResolver(client),
    profileResolver: new ProfileResolver(client),
    serverResolver: new ServerResolver(client)
  });
  client.on(Events.InteractionCreate, (interaction) => void handler.handle(interaction));

  let discordReady = false;
  client.once(Events.ClientReady, (readyClient) => {
    discordReady = true;
    process.stdout.write(`Discord app ready as ${readyClient.user.username}.\n`);
  });
  const health = new HealthServer(database, () => discordReady && client.isReady(), config.reportEventWebhookSecret);
  await health.listen(config.port);
  await client.login(config.token);
  const notifier = new AccountNotificationWorker(database, client, config);
  const digests = new DigestWorker(database, client, config);
  notifier.start();
  digests.start();

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`Shutting down after ${signal}.\n`);
    await notifier.stop();
    await digests.stop();
    await client.destroy();
    await health.close();
    await database.close();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error: unknown) => {
  process.stderr.write(`Bot startup failed: ${error instanceof Error ? error.message : "Unknown startup error"}\n`);
  process.exitCode = 1;
});
