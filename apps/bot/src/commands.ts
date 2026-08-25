import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  SlashCommandBuilder
} from "discord.js";
import type { RESTPostAPIApplicationCommandsJSONBody } from "discord.js";
import { ANALYTICS_PERIODS } from "@discord-dsa/contracts";

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
    );

const reports = userInstalled()
    .setName("reports")
    .setDescription("View and manage your DSA reports")
    .addSubcommand((command) =>
      command
        .setName("list")
        .setDescription("List your recent reports")
    )
    .addSubcommand((command) =>
      command
        .setName("status")
        .setDescription("View one report's current status")
        .addStringOption((option) =>
          option.setName("report-id").setDescription("Internal report ID").setRequired(true)
        )
    )
    .addSubcommand((command) =>
      command
        .setName("retry")
        .setDescription("Retry a failed report as a new report")
        .addStringOption((option) =>
          option.setName("report-id").setDescription("Internal report ID").setRequired(true)
        )
    );

const access = userInstalled()
    .setName("access")
    .setDescription("Manage reporting access")
    .addSubcommand((command) =>
      command
        .setName("redeem")
        .setDescription("Redeem an access key")
        .addStringOption((option) =>
          option.setName("key").setDescription("Access key").setRequired(true).setMaxLength(100)
        )
    )
    .addSubcommand((command) => command.setName("status").setDescription("View your reporting access"));

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
    )
    .addSubcommand((command) => command.setName("notifications")
      .setDescription("Configure private lifecycle alerts and digests"));

const analytics = userInstalled()
  .setName("analytics")
  .setDescription("View your private report analytics")
  .addStringOption((option) =>
    option.setName("period").setDescription("Analytics time period").setRequired(false)
      .addChoices(...ANALYTICS_PERIODS.map((period) => ({
        name: period === "24h" ? "Last 24 hours"
          : period === "7d" ? "Last 7 days"
            : period === "30d" ? "Last 30 days"
              : period === "ytd" ? "Year to date"
                : period === "365d" ? "Last 365 days"
                  : "All time",
        value: period
      })))
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
            .setDescription("Generate access keys")
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
            .setDescription("Revoke an access key and suspend its redeemer")
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
            .setDescription("Suspend a user")
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
            .setDescription("Reinstate a suspended user")
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

const quickReportMessage = new ContextMenuCommandBuilder()
  .setName("Quick Report Message")
  .setType(ApplicationCommandType.Message)
  .setIntegrationTypes(ApplicationIntegrationType.UserInstall)
  .setContexts(...contexts);

export const COMMANDS: RESTPostAPIApplicationCommandsJSONBody[] = [
  report.toJSON(),
  reports.toJSON(),
  access.toJSON(),
  settings.toJSON(),
  analytics.toJSON(),
  admin.toJSON(),
  reportMessage.toJSON(),
  quickReportMessage.toJSON()
];
