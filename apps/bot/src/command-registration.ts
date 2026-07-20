import { REST, Routes } from "discord.js";

import { COMMANDS } from "./commands.js";

export interface CommandRegistrationOptions {
  applicationId: string;
  rest?: REST;
  token: string;
}

export async function registerGlobalCommands(
  options: CommandRegistrationOptions
): Promise<number> {
  const rest = options.rest ?? new REST({ version: "10" }).setToken(options.token);
  await rest.put(Routes.applicationCommands(options.applicationId), { body: COMMANDS });
  return COMMANDS.length;
}
