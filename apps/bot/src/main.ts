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
import { setBotDiagnosticSink } from "./observability.js";

async function main(): Promise<void> {
  const config = loadBotConfig();
  if (config.environment === "production") {
    const count = await registerGlobalCommands({ applicationId: config.applicationId, token: config.token });
    process.stdout.write(`Synchronized ${count} global Discord commands.\n`);
  }
  const database = new AccountBotDatabase(config.databaseUrl);
  await database.migrate();
  setBotDiagnosticSink((event, fields, level) => {
    const reportId = typeof fields.reportId === "string" ? fields.reportId : undefined;
    const traceId = typeof fields.traceId === "string" ? fields.traceId : undefined;
    if ((reportId !== undefined || traceId !== undefined || level !== "info") && event !== "bot_diagnostic_persistence_failed") {
      void database.recordDiagnostic({
        ...(reportId === undefined ? {} : { reportId }), ...(traceId === undefined ? {} : { traceId }), service: "bot", severity: level, event,
        ...(typeof fields.stage === "string" ? { stage: fields.stage } : {}), ...(typeof fields.outcome === "string" ? { outcome: fields.outcome } : {}), details: fields
      }).catch(() => {
        process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", service: "nreport-discord-dsa-bot", event: "bot_diagnostic_persistence_failed", stage: "diagnostics", outcome: "failed" })}\n`);
      });
    }
  });
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
  const diagnosticsPurge = setInterval(() => void database.purgeDiagnostics().catch(() => undefined), 60 * 60_000);
  notifier.start();
  digests.start();

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`Shutting down after ${signal}.\n`);
    await notifier.stop();
    await digests.stop();
    clearInterval(diagnosticsPurge);
    setBotDiagnosticSink(undefined);
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
