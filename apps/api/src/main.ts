import { loadConfig } from "./config.js";
import { Database } from "./database.js";
import { JobRunner } from "./job-runner.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const database = new Database(config.databaseUrl);
  await database.migrate();
  const app = await buildServer(config, database);
  const runner = new JobRunner(database, config, app.log);
  if (config.workerEnabled) runner.start();

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, "Shutting down");
    await app.close();
    if (config.workerEnabled) await runner.stop();
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
