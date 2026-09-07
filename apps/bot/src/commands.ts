import { ANALYTICS_PERIODS } from "@nreport/contracts";
import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  ContextMenuCommandBuilder,
  InteractionContextType,
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";

const contexts = [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel] as const;
const installed = () => new SlashCommandBuilder().setIntegrationTypes(ApplicationIntegrationType.UserInstall).setContexts(...contexts);
const report = installed().setName("report").setDescription("Submit a Discord DSA report")
  .addSubcommand((command) => command.setName("message").setDescription("Report a Discord message")
    .addStringOption((option) => option.setName("message-link").setDescription("Full Discord message link").setRequired(true).setMaxLength(300)))
  .addSubcommand((command) => command.setName("profile").setDescription("Report a Discord profile")
    .addStringOption((option) => option.setName("target").setDescription("Discord user ID").setRequired(true).setMinLength(15).setMaxLength(22))
    .addStringOption((option) => option.setName("server-id").setDescription("Optional server ID").setMinLength(15).setMaxLength(22)))
  .addSubcommand((command) => command.setName("server").setDescription("Report a Discord server")
    .addStringOption((option) => option.setName("server-or-invite").setDescription("Server ID or invite code").setMaxLength(100)));

const reports = installed().setName("reports").setDescription("View and manage your API reports")
  .addSubcommand((command) => command.setName("list").setDescription("List recent reports"))
  .addSubcommand((command) => command.setName("status").setDescription("View a report")
    .addStringOption((option) => option.setName("report-id").setDescription("Report ID").setRequired(true)))
  .addSubcommand((command) => command.setName("retry").setDescription("Retry an eligible report")
    .addStringOption((option) => option.setName("report-id").setDescription("Report ID").setRequired(true))
    .addStringOption((option) => option.setName("mode").setDescription("Retry mode").setRequired(true)
      .addChoices({ name: "Reuse prepared report", value: "reuse" }, { name: "Regenerate with AI", value: "regenerate" })));

const access = installed().setName("access").setDescription("Connect your personal reporting account")
  .addSubcommand((command) => command.setName("connect").setDescription("Connect or update your personal API key"))
  .addSubcommand((command) => command.setName("status").setDescription("View your connected API account"))
  .addSubcommand((command) => command.setName("disconnect").setDescription("Disconnect this Discord user from the API account"));

const settings = installed().setName("settings").setDescription("Configure private notifications")
  .addSubcommand((command) => command.setName("notifications").setDescription("Update notification preferences")
    .addBooleanOption((option) => option.setName("decisions").setDescription("DM when Discord accepts a report/appeal or denies an appeal"))
    .addBooleanOption((option) => option.setName("report-denied").setDescription("DM when the original report is denied before automatic appeal"))
    .addBooleanOption((option) => option.setName("problems").setDescription("DM when a report needs attention or cannot continue"))
    .addBooleanOption((option) => option.setName("daily-digest").setDescription("Daily activity digest"))
    .addBooleanOption((option) => option.setName("weekly-digest").setDescription("Weekly activity digest")));

const analytics = installed().setName("analytics").setDescription("View report analytics")
  .addStringOption((option) => option.setName("period").setDescription("Time period")
    .addChoices(...ANALYTICS_PERIODS.map((period) => ({ name: period, value: period }))))
  .addBooleanOption((option) => option.setName("community").setDescription("Show anonymized community analytics"));

const admin = installed().setName("admin").setDescription("Administer API accounts")
  .addSubcommand((command) => command.setName("account-create").setDescription("Create an approved API account")
    .addStringOption((option) => option.setName("username").setDescription("Immutable username").setRequired(true))
    .addIntegerOption((option) => option.setName("credits").setDescription("Initial credits").setMinValue(0)))
  .addSubcommand((command) => command.setName("key-issue").setDescription("Issue a personal API key")
    .addStringOption((option) => option.setName("account-id").setDescription("API account ID").setRequired(true)))
  .addSubcommand((command) => command.setName("key-rotate").setDescription("Rotate an API key")
    .addStringOption((option) => option.setName("account-id").setDescription("API account ID").setRequired(true)))
  .addSubcommand((command) => command.setName("credits").setDescription("Adjust report credits")
    .addStringOption((option) => option.setName("account-id").setDescription("API account ID").setRequired(true))
    .addIntegerOption((option) => option.setName("delta").setDescription("Signed credit change").setRequired(true))
    .addStringOption((option) => option.setName("reason").setDescription("Audit reason").setRequired(true)))
  .addSubcommand((command) => command.setName("suspend").setDescription("Suspend an API account")
    .addStringOption((option) => option.setName("account-id").setDescription("API account ID").setRequired(true))
    .addStringOption((option) => option.setName("reason").setDescription("Audit reason").setRequired(true)))
  .addSubcommand((command) => command.setName("reinstate").setDescription("Reinstate an API account")
    .addStringOption((option) => option.setName("account-id").setDescription("API account ID").setRequired(true))
    .addStringOption((option) => option.setName("reason").setDescription("Audit reason").setRequired(true)));

const reportMessage = new ContextMenuCommandBuilder().setName("Report Message").setType(ApplicationCommandType.Message)
  .setIntegrationTypes(ApplicationIntegrationType.UserInstall).setContexts(...contexts);
const quickReportMessage = new ContextMenuCommandBuilder().setName("Quick Report Message").setType(ApplicationCommandType.Message)
  .setIntegrationTypes(ApplicationIntegrationType.UserInstall).setContexts(...contexts);

export const COMMANDS: RESTPostAPIApplicationCommandsJSONBody[] = [
  report.toJSON(), reports.toJSON(), access.toJSON(), settings.toJSON(), analytics.toJSON(), admin.toJSON(),
  reportMessage.toJSON(), quickReportMessage.toJSON()
];
