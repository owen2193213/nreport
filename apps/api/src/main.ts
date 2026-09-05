import { loadConfig } from "./config.js";
import { AccountRepository } from "./accounts.js";
import { LifecycleRunner } from "./lifecycle-runner-v2.js";
import { AccountEventDeliveryWorker } from "./event-delivery-v2.js";
import { PostgresDatabase } from "./postgres.js";
import { PreparationWorker } from "./preparation-worker.js";
import { ApiReportPreparer } from "./preparation/api-report-preparer.js";
import { createProxySessionId, generateIdentity, supportedCountries } from "./pseudonyms.js";
import { ReportRepository } from "./report-repository.js";
import { buildV2Server } from "./server-v2.js";
import { decryptJson } from "./security.js";
import { WebhookDestinationRepository } from "./webhook-destinations.js";
import { AnalyticsRepository } from "./analytics-repository.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const database = new PostgresDatabase(config.databaseUrl);
  await database.migrate();
  const accounts = new AccountRepository(database.pool, config.apiKeyPepper);
  const reports = new ReportRepository(database.pool);
  const destinations = new WebhookDestinationRepository(
    database.pool,
    config.sessionEncryptionKey,
    config.allowRailwayPrivateHttpWebhooks ?? false
  );
  const analytics = new AnalyticsRepository(database.pool);
  await reports.recoverInterruptedJobs();
  const app = await buildV2Server(config, {
    healthcheck: () => database.healthcheck(),
    accounts,
    reports,
    destinations,
    analytics
  });
  const preparer = new ApiReportPreparer({
    aiApiKey: config.aiApiKey,
    aiModel: config.aiModel,
    braveSearchApiKey: config.braveSearchApiKey,
    supportedCountries: supportedCountries(),
    provider: config.aiProvider
  });
  const preparationWorker = new PreparationWorker(
    reports,
    preparer,
    (country) => {
      const identity = generateIdentity(country, config.emailDomain);
      return {
        legalName: identity.displayName,
        email: identity.email,
        locale: identity.locale,
        timezone: identity.timezone,
        language: identity.language,
        proxySessionId: createProxySessionId()
      };
    },
    config.preparationConcurrency,
    undefined,
    (error) => app.log.error(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "Preparation worker iteration failed"
    )
  );
  const lifecycleRunner = new LifecycleRunner(reports, config);
  const eventDeliveryWorker = new AccountEventDeliveryWorker(reports, {
    decrypt: (value) => decryptJson<string>(value, config.sessionEncryptionKey)
  });
  if (config.workerEnabled) {
    preparationWorker.start();
    lifecycleRunner.start();
    eventDeliveryWorker.start();
  }

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, "Shutting down");
    await app.close();
    if (config.workerEnabled) {
      await preparationWorker.stop();
      await lifecycleRunner.stop();
      await eventDeliveryWorker.stop();
    }
    await database.close();
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  await app.listen({ host: "0.0.0.0", port: config.port });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  process.stderr.write(`Startup failed: ${message}\n`);
  process.exitCode = 1;
});
