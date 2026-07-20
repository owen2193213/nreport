import { registerGlobalCommands } from "./command-registration.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main(): Promise<void> {
  const count = await registerGlobalCommands({
    applicationId: required("DISCORD_APPLICATION_ID"),
    token: required("DISCORD_BOT_TOKEN")
  });
  process.stdout.write(`Registered ${count} global commands.\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown registration error";
  process.stderr.write(`Command registration failed: ${message}\n`);
  process.exitCode = 1;
});
