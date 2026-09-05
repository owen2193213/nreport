import type { ReportDraft } from "@discord-dsa/client";
import type {
  CreateReportInput,
  GuildElement,
  MessageEvidence,
  ReportedMessageSnapshot,
  ReportedReferencedMessageSnapshot,
  ReportedUserSnapshot,
  ReportRetryMode,
  UserProfileElement
} from "@discord-dsa/contracts";
import { supportedCountries } from "./pseudonyms.js";

const FLOW_VALUES = new Set(["message", "profile", "server"] as const);
export const DISCORD_FORM_LANGUAGE = "en" as const;
const PROFILE_ELEMENTS = new Set<UserProfileElement>(["photos", "name", "descriptors"]);
const GUILD_ELEMENTS = new Set<GuildElement>([
  "name",
  "icon",
  "banner",
  "invite_splash",
  "discovery_splash",
  "welcome_screen_description",
  "channel_names",
  "other"
]);

export interface RetryReportInput {
  mode: ReportRetryMode;
}

export interface PreparedReportInput {
  request: CreateReportInput;
  country: string;
  category: string;
  description: string;
  finalText: string;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  input: Record<string, unknown>,
  key: string,
  maximum = 2_000
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maximum) throw new Error(`${key} is too long.`);
  return trimmed;
}

function optionalString(
  input: Record<string, unknown>,
  key: string,
  maximum: number
): string | undefined {
  if (input[key] === undefined) return undefined;
  return requiredString(input, key, maximum);
}

function nullableString(
  input: Record<string, unknown>,
  key: string,
  maximum: number
): string | null {
  return input[key] === null ? null : requiredString(input, key, maximum);
}

function rawString(input: Record<string, unknown>, key: string, maximum: number): string {
  const value = input[key];
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`${key} must be a string no longer than ${maximum} characters.`);
  }
  return value;
}

function evidenceString(input: Record<string, unknown>, key: string, maximum: number): string {
  return rawString(input, key, maximum).replaceAll(String.fromCharCode(0), "");
}

function timestamp(input: Record<string, unknown>, key: string): string {
  const value = requiredString(input, key, 100);
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${key} must be an ISO-8601 timestamp.`);
  }
  return value;
}

function httpsUrl(input: Record<string, unknown>, key: string, nullable = false): string | null {
  if (nullable && input[key] === null) return null;
  const value = requiredString(input, key, 2_048);
  try {
    if (new URL(value).protocol !== "https:") throw new Error("not https");
  } catch {
    throw new Error(`${key} must be an HTTPS URL.`);
  }
  return value;
}

function snowflake(input: Record<string, unknown>, key: string): string {
  const value = requiredString(input, key, 22);
  if (!/^\d{15,22}$/.test(value)) throw new Error(`${key} must be a Discord snowflake.`);
  return value;
}

function reportedReferencedMessageSnapshot(
  value: unknown
): ReportedReferencedMessageSnapshot {
  const input = record(value);
  const attachmentsValue = input.attachments;
  let attachments: ReportedReferencedMessageSnapshot["attachments"] = undefined;
  if (attachmentsValue !== undefined) {
    if (!Array.isArray(attachmentsValue) || attachmentsValue.length > 25) {
      throw new Error("referencedMessage.attachments must contain at most 25 items.");
    }
    attachments = attachmentsValue.map((item) => {
      const attachment = record(item);
      const size = attachment.size;
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
        throw new Error("referencedMessage attachment size must be a non-negative integer.");
      }
      if (typeof attachment.spoiler !== "boolean") {
        throw new Error("referencedMessage attachment spoiler must be a boolean.");
      }
      return {
        name: requiredString(attachment, "name", 256),
        contentType: nullableString(attachment, "contentType", 100),
        size,
        spoiler: attachment.spoiler
      };
    });
  }
  if (typeof input.authorBot !== "boolean") {
    throw new Error("referencedMessage.authorBot must be a boolean.");
  }
  return {
    messageId: snowflake(input, "messageId"),
    authorId: snowflake(input, "authorId"),
    authorUsername: requiredString(input, "authorUsername", 100),
    authorDisplayName: nullableString(input, "authorDisplayName", 100),
    authorBot: input.authorBot,
    content: evidenceString(input, "content", 4_000),
    ...(attachments !== undefined ? { attachments } : {})
  };
}

function reportedMessageSnapshot(value: unknown): ReportedMessageSnapshot {
  const input = record(value);
  const attachmentsValue = input.attachments;
  const embedsValue = input.embeds;
  if (!Array.isArray(attachmentsValue) || attachmentsValue.length > 25) {
    throw new Error("messageEvidence.snapshot.attachments must contain at most 25 items.");
  }
  if (!Array.isArray(embedsValue) || embedsValue.length > 25) {
    throw new Error("messageEvidence.snapshot.embeds must contain at most 25 items.");
  }
  const attachments = attachmentsValue.map((value) => {
    const attachment = record(value);
    const size = attachment.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("messageEvidence attachment size must be a non-negative integer.");
    }
    if (typeof attachment.spoiler !== "boolean") {
      throw new Error("messageEvidence attachment spoiler must be a boolean.");
    }
    return {
      name: requiredString(attachment, "name", 256),
      url: httpsUrl(attachment, "url")!,
      contentType: nullableString(attachment, "contentType", 100),
      size,
      spoiler: attachment.spoiler
    };
  });
  const embeds = embedsValue.map((value) => {
    const embed = record(value);
    return {
      title: embed.title === null ? null : evidenceString(embed, "title", 256),
      description:
        embed.description === null ? null : evidenceString(embed, "description", 4_096),
      url: httpsUrl(embed, "url", true)
    };
  });
  if (typeof input.authorBot !== "boolean") {
    throw new Error("messageEvidence.snapshot.authorBot must be a boolean.");
  }
  const referencedMessage =
    input.referencedMessage === undefined || input.referencedMessage === null
      ? null
      : reportedReferencedMessageSnapshot(input.referencedMessage);
  return {
    messageId: snowflake(input, "messageId"),
    channelId: snowflake(input, "channelId"),
    channelName: nullableString(input, "channelName", 100),
    serverId: input.serverId === null ? null : snowflake(input, "serverId"),
    serverName: nullableString(input, "serverName", 100),
    authorId: snowflake(input, "authorId"),
    authorUsername: requiredString(input, "authorUsername", 100),
    authorDisplayName: nullableString(input, "authorDisplayName", 100),
    authorAvatarUrl: httpsUrl(input, "authorAvatarUrl", true),
    authorBot: input.authorBot,
    content: evidenceString(input, "content", 4_000),
    createdAt: timestamp(input, "createdAt"),
    attachments,
    embeds,
    ...(referencedMessage ? { referencedMessage } : {})
  };
}

function optionalMessageEvidence(input: Record<string, unknown>): MessageEvidence | undefined {
  if (input.messageEvidence === undefined) return undefined;
  const evidence = record(input.messageEvidence);
  const status = requiredString(evidence, "status", 20);
  const source = requiredString(evidence, "source", 20);
  if (status === "unavailable") {
    if (source !== "message_link") {
      throw new Error("Unavailable messageEvidence must come from a message link.");
    }
    return {
      source,
      status,
      attemptedAt: timestamp(evidence, "attemptedAt")
    };
  }
  if (status !== "captured" || (source !== "context_menu" && source !== "message_link")) {
    throw new Error("messageEvidence status or source is unsupported.");
  }
  return {
    source,
    status,
    capturedAt: timestamp(evidence, "capturedAt"),
    snapshot: reportedMessageSnapshot(evidence.snapshot)
  };
}

function stringArray<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<T>
): T[] {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${key} must be a non-empty array.`);
  }
  const unique = new Set<T>();
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item as T)) {
      throw new Error(`${key} contains an unsupported value.`);
    }
    unique.add(item as T);
  }
  return [...unique];
}

function optionalReportedUserSnapshot(
  input: Record<string, unknown>
): ReportedUserSnapshot | undefined {
  if (input.reportedUserSnapshot === undefined) return undefined;
  const value = record(input.reportedUserSnapshot);
  const userId = requiredString(value, "userId", 22);
  const username = requiredString(value, "username", 100);
  if (!/^\d{15,22}$/.test(userId)) {
    throw new Error("reportedUserSnapshot.userId must be a Discord snowflake.");
  }
  const globalNameValue = value.globalDisplayName;
  const globalDisplayName =
    globalNameValue === null ? null : requiredString(value, "globalDisplayName", 100);
  const serverDisplayName = optionalString(value, "serverDisplayName", 100);
  const avatarValue = value.avatarUrl;
  const avatarUrl = avatarValue === null ? null : requiredString(value, "avatarUrl", 500);
  if (avatarUrl !== null && !/^https:\/\//i.test(avatarUrl)) {
    throw new Error("reportedUserSnapshot.avatarUrl must be an HTTPS URL.");
  }
  const bannerValue = value.bannerUrl;
  const bannerUrl = bannerValue === null ? null : requiredString(value, "bannerUrl", 500);
  if (bannerUrl !== null && !/^https:\/\//i.test(bannerUrl)) {
    throw new Error("reportedUserSnapshot.bannerUrl must be an HTTPS URL.");
  }
  if (typeof value.bot !== "boolean") {
    throw new Error("reportedUserSnapshot.bot must be a boolean.");
  }
  const resolvedAt = requiredString(value, "resolvedAt", 100);
  if (!Number.isFinite(new Date(resolvedAt).getTime())) {
    throw new Error("reportedUserSnapshot.resolvedAt must be an ISO-8601 timestamp.");
  }
  return {
    userId,
    username,
    globalDisplayName,
    ...(serverDisplayName === undefined ? {} : { serverDisplayName }),
    avatarUrl,
    bannerUrl,
    bot: value.bot,
    resolvedAt
  };
}

function rejectIdentityFields(input: Record<string, unknown>): void {
  for (const key of ["name", "legalName", "email", "reporterLegalName", "reporterEmail"]) {
    if (key in input) {
      throw new Error(`${key} is generated by the service and must not be supplied.`);
    }
  }
}

export function parseCreateReportInput(value: unknown): CreateReportInput {
  const input = record(value);
  rejectIdentityFields(input);
  for (const forbidden of [
    "submitterDiscordUserId", "reporterUsername", "provider", "model", "metadata",
    "callbackUrl", "reportReason", "reportType", "context"
  ]) {
    if (forbidden in input) throw new Error(`${forbidden} must not be supplied.`);
  }
  const flowValue = requiredString(input, "flow", 32);
  if (!FLOW_VALUES.has(flowValue as never)) throw new Error("Unsupported flow.");
  const flow = flowValue as CreateReportInput["flow"];
  if (typeof input.useAi !== "boolean") throw new Error("useAi must be a boolean.");
  const useAi = input.useAi;
  const countryValue = optionalString(input, "country", 2)?.toUpperCase();
  if (countryValue !== undefined && !supportedCountries().includes(countryValue)) {
    throw new Error(`Unsupported country. Supported countries: ${supportedCountries().join(", ")}.`);
  }
  const category = optionalString(input, "category", 100);
  if (category !== undefined && !/^[a-z0-9_]+$/.test(category)) {
    throw new Error("category is invalid.");
  }
  const description = optionalString(input, "description", 4_000);
  const finalText = optionalString(input, "finalText", 512);
  if (useAi && finalText !== undefined) throw new Error("finalText cannot be supplied when useAi is true.");
  if (!useAi && countryValue === undefined) throw new Error("country is required when useAi is false.");
  if (!useAi && category === undefined) throw new Error("category is required when useAi is false.");
  if (!useAi && finalText === undefined) throw new Error("finalText is required when useAi is false.");

  const target = record(input.target);
  let parsedTarget: CreateReportInput["target"];
  if (flow === "message") {
    const messageUrl = requiredString(target, "messageUrl", 300);
    if (!/^https:\/\/(?:www\.)?discord\.com\/channels\/(?:@me|\d+)\/\d+\/\d+$/.test(messageUrl)) {
      throw new Error("messageUrl must be a complete Discord message URL.");
    }
    const messageEvidence = optionalMessageEvidence(target);
    if (messageEvidence?.status === "captured") {
      const [, , urlServerId, urlChannelId, urlMessageId] = new URL(messageUrl).pathname.split("/");
      if (
        messageEvidence.snapshot.channelId !== urlChannelId ||
        messageEvidence.snapshot.messageId !== urlMessageId
      ) {
        throw new Error("messageEvidence snapshot must match messageUrl.");
      }
      if (urlServerId !== "@me" && messageEvidence.snapshot.serverId !== urlServerId) {
        throw new Error("messageEvidence serverId must match messageUrl.");
      }
    }
    parsedTarget = {
      messageUrl,
      ...(messageEvidence === undefined ? {} : { messageEvidence })
    };
  } else if (flow === "profile") {
    const reportedUsername = requiredString(target, "reportedUsername", 100);
    const reportedUserId = requiredString(target, "reportedUserId", 22);
    if (!/^\d{15,22}$/.test(reportedUserId)) {
      throw new Error("reportedUserId must be a Discord snowflake.");
    }
    const reportedUserSnapshot = optionalReportedUserSnapshot(target);
    if (reportedUserSnapshot === undefined) {
      throw new Error("reportedUserSnapshot is required.");
    }
    if (reportedUserSnapshot.userId !== reportedUserId) {
      throw new Error("reportedUserSnapshot.userId must match reportedUserId.");
    }
    if (reportedUserSnapshot.username !== reportedUsername) {
      throw new Error("reportedUserSnapshot.username must match reportedUsername.");
    }
    const reportedUserServerId = optionalString(target, "reportedUserServerId", 32);
    if (reportedUserServerId !== undefined && !/^\d{15,22}$/.test(reportedUserServerId)) {
      throw new Error("reportedUserServerId must be a Discord snowflake.");
    }
    parsedTarget = {
      reportedUsername,
      reportedUserId,
      reportedUserSnapshot,
      ...(reportedUserServerId === undefined ? {} : { reportedUserServerId }),
      profileElements: stringArray(target, "profileElements", PROFILE_ELEMENTS)
    };
  } else {
    parsedTarget = {
      guildIdOrInviteCode: requiredString(target, "guildIdOrInviteCode", 100),
      guildElements: stringArray(target, "guildElements", GUILD_ELEMENTS)
    };
  }

  const base = {
    flow,
    target: parsedTarget,
    ...(countryValue === undefined ? {} : { country: countryValue }),
    ...(category === undefined ? {} : { category }),
    ...(description === undefined ? {} : { description })
  };
  return useAi
    ? { ...base, useAi: true }
    : {
        ...base,
        useAi: false,
        country: countryValue!,
        category: category!,
        description: description ?? finalText!,
        finalText: finalText!
      };
}

export function parseRetryReportInput(value: unknown): RetryReportInput {
  const input = record(value);
  const modeValue = input.mode;
  if (modeValue !== "reuse" && modeValue !== "regenerate") {
    throw new Error("mode must be reuse or regenerate.");
  }
  return { mode: modeValue };
}

export function toReportDraft(
  input: PreparedReportInput,
  legalName: string
): ReportDraft {
  const reporter = {
    country: input.country,
    legalName
  };
  const common = {
    reporter,
    reportType: input.category,
    context: input.finalText
  };
  const target = input.request.target;
  switch (input.request.flow) {
    case "message":
      if (!("messageUrl" in target)) throw new Error("Prepared target does not match flow.");
      return { ...common, flow: "message_urf", messageUrl: target.messageUrl };
    case "profile":
      if (!("reportedUsername" in target)) throw new Error("Prepared target does not match flow.");
      return {
        ...common,
        flow: "user_urf",
        reportedUsername: target.reportedUsername,
        ...(target.reportedUserServerId === undefined
          ? {}
          : { reportedUserServerId: target.reportedUserServerId }),
        profileElements: target.profileElements
      };
    case "server":
      if (!("guildIdOrInviteCode" in target)) throw new Error("Prepared target does not match flow.");
      return {
        ...common,
        flow: "guild_urf",
        guildIdOrInviteCode: target.guildIdOrInviteCode,
        guildElements: target.guildElements
      };
  }
}
