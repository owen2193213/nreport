import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  SlashCommandBuilder
} from "discord.js";
import type { RESTPostAPIApplicationCommandsJSONBody } from "discord.js";

const contexts = [
  InteractionContextType.Guild,
  InteractionContextType.BotDM,
  InteractionContextType.PrivateChannel
] as const;

function userInstalled(): SlashCommandBuilder {
  return new SlashCommandBuilder()
    .setIntegrationTypes(ApplicationIntegrationType.UserInstall)
    .setContexts(...contexts);
}

const report = userInstalled()
    .setName("report")
    .setDescription("Prepare a Discord DSA report")
    .addSubcommand((command) =>
      command
        .setName("message")
        .setDescription("Report a Discord message")
        .addStringOption((option) =>
          option
            .setName("message-link")
            .setDescription("Full Discord message link")
            .setRequired(true)
            .setMaxLength(300)
        )
        .addStringOption((option) =>
          option
            .setName("country")
            .setDescription("Auto or an EU country override")
            .setAutocomplete(true)
            .setMaxLength(100)
        )
        .addBooleanOption((option) =>
          option
            .setName("dont-use-ai")
            .setDescription("Write the final report manually instead of using DeepSeek")
        )
    )
    .addSubcommand((command) =>
      command
        .setName("profile")
        .setDescription("Report a Discord profile")
        .addStringOption((option) =>
          option
            .setName("target")
            .setDescription("Raw Discord user ID")
            .setRequired(true)
            .setMinLength(15)
            .setMaxLength(22)
        )
        .addStringOption((option) =>
          option
            .setName("server-id")
            .setDescription("Optional server ID where the profile was observed")
            .setMinLength(15)
            .setMaxLength(22)
        )
        .addStringOption((option) =>
          option
            .setName("country")
            .setDescription("Auto or an EU country override")
            .setAutocomplete(true)
            .setMaxLength(100)
        )
        .addBooleanOption((option) =>
          option
            .setName("dont-use-ai")
            .setDescription("Write the final report manually instead of using DeepSeek")
        )
    )
    .addSubcommand((command) =>
      command
        .setName("server")
        .setDescription("Report a Discord server")
        .addStringOption((option) =>
          option
            .setName("server-or-invite")
            .setDescription("Server ID or invite code; defaults to the current server")
            .setMaxLength(100)
        )
        .addStringOption((option) =>
          option
            .setName("country")
            .setDescription("Auto or an EU country override")
            .setAutocomplete(true)
            .setMaxLength(100)
        )
        .addBooleanOption((option) =>
          option
            .setName("dont-use-ai")
            .setDescription("Write the final report manually instead of using DeepSeek")
        )
    );

const reports = userInstalled()
    .setName("reports")
    .setDescription("View and manage your DSA reports")
    .addSubcommand((command) =>
      command
        .setName("list")
        .setDescription("List your recent reports")
        .addBooleanOption((option) =>
          option
            .setName("send-to-dms")
            .setDescription("Also send the report embed to your DMs")
        )
    )
    .addSubcommand((command) =>
      command
        .setName("status")
        .setDescription("View one report's current status")
        .addStringOption((option) =>
          option.setName("report-id").setDescription("Internal report ID").setRequired(true)
        )
        .addBooleanOption((option) =>
          option
            .setName("send-to-dms")
            .setDescription("Also send the report embed to your DMs")
        )
    )
    .addSubcommand((command) =>
      command
        .setName("retry")
        .setDescription("Retry a failed report as a new report")
        .addStringOption((option) =>
          option.setName("report-id").setDescription("Internal report ID").setRequired(true)
        )
        .addBooleanOption((option) =>
          option
            .setName("send-to-dms")
            .setDescription("Also send the report embed to your DMs")
        )
    );

const access = userInstalled()
    .setName("access")
    .setDescription("Manage reporting access")
    .addSubcommand((command) =>
      command
        .setName("redeem")
        .setDescription("Redeem a report-credit key")
        .addStringOption((option) =>
          option.setName("key").setDescription("Access key").setRequired(true).setMaxLength(100)
        )
    )
    .addSubcommand((command) => command.setName("status").setDescription("View your access and credits"));

const settings = userInstalled()
    .setName("settings")
    .setDescription("Configure your report defaults")
    .addSubcommand((command) =>
      command
        .setName("country")
        .setDescription("Set Auto or a default EU country")
        .addStringOption((option) =>
          option
            .setName("country")
            .setDescription("Auto or an EU country")
            .setRequired(true)
            .setAutocomplete(true)
        )
    );

const admin = userInstalled()
    .setName("admin")
    .setDescription("Administer report access")
    .addSubcommandGroup((group) =>
      group
        .setName("key")
        .setDescription("Manage access keys")
        .addSubcommand((command) =>
          command
            .setName("create")
            .setDescription("Generate report-credit keys")
            .addIntegerOption((option) =>
              option
                .setName("credits")
                .setDescription("Credits granted by each key")
                .setRequired(true)
                .setMinValue(1)
            )
            .addIntegerOption((option) =>
              option
                .setName("count")
                .setDescription("Number of keys to generate")
                .setMinValue(1)
                .setMaxValue(20)
            )
            .addStringOption((option) =>
              option
                .setName("expires-at")
                .setDescription("Optional future ISO-8601 redemption deadline")
            )
        )
        .addSubcommand((command) => command.setName("list").setDescription("List recent access keys"))
        .addSubcommand((command) =>
          command
            .setName("inspect")
            .setDescription("Inspect an access key")
            .addStringOption((option) =>
              option.setName("key-id").setDescription("Key ID").setRequired(true)
            )
        )
        .addSubcommand((command) =>
          command
            .setName("revoke")
            .setDescription("Revoke a key and suspend its redeemer")
            .addStringOption((option) =>
              option.setName("key-id").setDescription("Key ID").setRequired(true)
            )
            .addStringOption((option) =>
              option.setName("reason").setDescription("Audit reason").setMaxLength(500)
            )
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName("user")
        .setDescription("Manage reporting users")
        .addSubcommand((command) =>
          command
            .setName("inspect")
            .setDescription("Inspect a user's access")
            .addStringOption((option) =>
              option.setName("user-id").setDescription("Discord user ID").setRequired(true)
            )
        )
        .addSubcommand((command) =>
          command
            .setName("suspend")
            .setDescription("Suspend a user and clear their credits")
            .addStringOption((option) =>
              option.setName("user-id").setDescription("Discord user ID").setRequired(true)
            )
            .addStringOption((option) =>
              option.setName("reason").setDescription("Audit reason").setMaxLength(500)
            )
        )
        .addSubcommand((command) =>
          command
            .setName("reinstate")
            .setDescription("Reinstate a suspended user with zero credits")
            .addStringOption((option) =>
              option.setName("user-id").setDescription("Discord user ID").setRequired(true)
            )
        )
    );

const reportMessage = new ContextMenuCommandBuilder()
  .setName("Report Message")
  .setType(ApplicationCommandType.Message)
  .setIntegrationTypes(ApplicationIntegrationType.UserInstall)
  .setContexts(...contexts);

export const COMMANDS: RESTPostAPIApplicationCommandsJSONBody[] = [
  report.toJSON(),
  reports.toJSON(),
  access.toJSON(),
  settings.toJSON(),
  admin.toJSON(),
  reportMessage.toJSON()
];
