import { REST, Routes } from "discord.js";

import { COMMANDS } from "./commands.js";
import { loadBotConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadBotConfig();
  const rest = new REST({ version: "10" }).setToken(config.token);
  await rest.put(Routes.applicationCommands(config.applicationId), { body: COMMANDS });
  process.stdout.write(`Registered ${COMMANDS.length} global commands.\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown registration error";
  process.stderr.write(`Command registration failed: ${message}\n`);
  process.exitCode = 1;
});
