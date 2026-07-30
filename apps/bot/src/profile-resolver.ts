import type { Client, User } from "discord.js";

import type { ReportedUserSnapshot } from "@discord-dsa/contracts";

const SNOWFLAKE = /^\d{15,22}$/;

export function normalizeProfileTarget(value: string): string {
  return value.trim();
}

export function isValidProfileTarget(value: string): boolean {
  return SNOWFLAKE.test(normalizeProfileTarget(value));
}

function snapshot(user: User): ReportedUserSnapshot {
  return {
    userId: user.id,
    username: user.username,
    globalDisplayName: user.globalName,
    avatarUrl: user.displayAvatarURL(),
    bannerUrl: user.bannerURL() ?? null,
    bot: user.bot,
    resolvedAt: new Date().toISOString()
  };
}

export class ProfileResolver {
  public constructor(private readonly client: Client) {}

  public async resolve(target: string): Promise<ReportedUserSnapshot | null> {
    const userId = normalizeProfileTarget(target);
    if (!SNOWFLAKE.test(userId)) return null;
    const user = await this.client.users.fetch(userId, { force: true }).catch(() => null);
    if (!user) return null;

    return snapshot(user);
  }
}
