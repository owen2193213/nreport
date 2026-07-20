import { DsaApi } from "@discord-dsa/contracts";
import { Client, Events, GatewayIntentBits } from "discord.js";

import { registerGlobalCommands } from "./command-registration.js";
import { loadBotConfig } from "./config.js";
import { BotDatabase } from "./database.js";
import { HealthServer } from "./health.js";
import { InteractionHandler } from "./interactions.js";
import { NotificationWorker } from "./notifier.js";
import { ServerResolver } from "./server-resolver.js";

async function main(): Promise<void> {
  const config = loadBotConfig();
  if (config.environment === "production") {
    const count = await registerGlobalCommands({
      applicationId: config.applicationId,
      token: config.token
    });
    process.stdout.write(`Synchronized ${count} global Discord commands.\n`);
  }
  const database = new BotDatabase(config.databaseUrl);
  await database.migrate();
  const api = new DsaApi({ baseUrl: config.apiBaseUrl, apiKey: config.apiKey });
  const { countries } = await api.countries();
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages]
  });
  const serverResolver = new ServerResolver(client);
  const handler = new InteractionHandler({ api, config, countries, database, serverResolver });
  client.on(Events.InteractionCreate, (interaction) => void handler.handle(interaction));

  let discordReady = false;
  client.once(Events.ClientReady, (readyClient) => {
    discordReady = true;
    process.stdout.write(`Discord app ready as ${readyClient.user.username}.\n`);
  });
  const health = new HealthServer(
    database,
    () => discordReady && client.isReady(),
    config.reportEventWebhookSecret
  );
  await health.listen(config.port);
  await client.login(config.token);
  const notifier = new NotificationWorker(database, api, client, config, serverResolver);
  notifier.start();

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`Shutting down after ${signal}.\n`);
    notifier.stop();
    await client.destroy();
    await health.close();
    await database.close();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  process.stderr.write(`Bot startup failed: ${message}\n`);
  process.exitCode = 1;
});
