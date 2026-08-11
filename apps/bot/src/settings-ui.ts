import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type MessageActionRowComponentBuilder
} from "discord.js";

import {
  DIGEST_FREQUENCIES,
  type NotificationPreferenceKey,
  type NotificationPreferences
} from "./notification-preferences.js";

const SETTINGS: Array<{
  key: NotificationPreferenceKey;
  label: string;
  read: (preferences: NotificationPreferences) => boolean;
}> = [
  { key: "submission_results", label: "Submission results", read: (value) => value.submissionResults },
  { key: "actioned", label: "Actioned", read: (value) => value.actioned },
  { key: "declined", label: "Declined", read: (value) => value.declined },
  { key: "appeal_progress", label: "Appeal progress", read: (value) => value.appealProgress }
];

function titleCase(value: string): string {
  return value[0]?.toUpperCase() + value.slice(1);
}

export function notificationSettingsView(
  preferences: NotificationPreferences
): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
  allowedMentions: { parse: [] };
} {
  const embed = new EmbedBuilder().setColor(Colors.Blurple).setTitle("Notification settings")
    .setDescription("Choose which private lifecycle alerts you receive. Report tracking continues when an alert is disabled.")
    .addFields(
      ...SETTINGS.map((setting) => ({
        name: setting.label,
        value: setting.read(preferences) ? "Enabled" : "Disabled",
        inline: true
      })),
      { name: "Digest", value: titleCase(preferences.digestFrequency), inline: true }
    );
  const toggles = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    ...SETTINGS.map((setting) => {
      const enabled = setting.read(preferences);
      return new ButtonBuilder()
        .setCustomId(`settings:notifications:toggle:${setting.key}:${String(!enabled)}`)
        .setLabel(`${setting.label}: ${enabled ? "On" : "Off"}`)
        .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Secondary);
    })
  );
  const digest = new StringSelectMenuBuilder().setCustomId("settings:notifications:digest")
    .setPlaceholder("Digest frequency")
    .addOptions(...DIGEST_FREQUENCIES.map((frequency) => new StringSelectMenuOptionBuilder()
      .setValue(frequency).setLabel(titleCase(frequency)).setDefault(frequency === preferences.digestFrequency)));
  return {
    embeds: [embed],
    components: [toggles, new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(digest)],
    allowedMentions: { parse: [] }
  };
}
