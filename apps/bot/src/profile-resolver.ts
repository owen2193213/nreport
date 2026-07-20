import type { Client, Guild, User } from "discord.js";

import type { ReportedUserSnapshot } from "@discord-dsa/contracts";

const SNOWFLAKE = /^\d{15,22}$/;
const USER_MENTION = /^<@!?(\d{15,22})>$/;

export function normalizeProfileTarget(value: string): string {
  const target = value.trim();
  return USER_MENTION.exec(target)?.[1] ?? target;
}

export function isSnowflakeProfileTarget(value: string): boolean {
  return SNOWFLAKE.test(normalizeProfileTarget(value));
}

function snapshot(user: User, serverDisplayName?: string): ReportedUserSnapshot {
  return {
    userId: user.id,
    username: user.username,
    globalDisplayName: user.globalName,
    ...(serverDisplayName === undefined ? {} : { serverDisplayName }),
    avatarUrl: user.displayAvatarURL(),
    bot: user.bot,
    resolvedAt: new Date().toISOString()
  };
}

export class ProfileResolver {
  public constructor(private readonly client: Client) {}

  public async resolve(
    target: string,
    serverId?: string,
    currentGuild?: Guild | null
  ): Promise<ReportedUserSnapshot | null> {
    const userId = normalizeProfileTarget(target);
    if (!SNOWFLAKE.test(userId)) return null;
    const user = await this.client.users.fetch(userId, { force: true }).catch(() => null);
    if (!user) return null;

    const guild =
      serverId === undefined
        ? null
        : currentGuild?.id === serverId
          ? currentGuild
          : await this.client.guilds.fetch(serverId).catch(() => null);
    const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
    const serverDisplayName =
      member && member.displayName !== user.globalName && member.displayName !== user.username
        ? member.displayName
        : undefined;
    return snapshot(user, serverDisplayName);
  }
}
