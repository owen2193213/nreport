import type { Client, Guild } from "discord.js";

import type { ServerSnapshot } from "./types.js";

const SNOWFLAKE = /^\d{15,22}$/;

function inviteCode(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]+)$/i
  );
  return match?.[1] ?? trimmed;
}

function snapshot(input: Omit<ServerSnapshot, "resolvedAt">): ServerSnapshot {
  return { ...input, resolvedAt: new Date().toISOString() };
}

export class ServerResolver {
  private readonly cache = new Map<string, { expiresAt: number; value: ServerSnapshot }>();

  public constructor(private readonly client: Client) {}

  public async resolve(target: string, currentGuild?: Guild | null): Promise<ServerSnapshot | null> {
    const normalized = target.trim();
    const cached = this.cache.get(normalized);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const resolved = await this.resolveUncached(normalized, currentGuild).catch(() => null);
    if (resolved) this.cache.set(normalized, { expiresAt: Date.now() + 60 * 60_000, value: resolved });
    return resolved;
  }

  private async resolveUncached(
    target: string,
    currentGuild?: Guild | null
  ): Promise<ServerSnapshot | null> {
    if (currentGuild && currentGuild.id === target) {
      return snapshot({
        id: currentGuild.id,
        name: currentGuild.name,
        description: currentGuild.description,
        iconUrl: currentGuild.iconURL(),
        approximateMemberCount: currentGuild.memberCount,
        approximatePresenceCount: currentGuild.approximatePresenceCount ?? null
      });
    }

    if (!SNOWFLAKE.test(target)) {
      const invite = await this.client.fetchInvite(inviteCode(target));
      if (!invite.guild) return null;
      return snapshot({
        id: invite.guild.id,
        name: invite.guild.name,
        description: invite.guild.description,
        iconUrl: invite.guild.iconURL(),
        approximateMemberCount: invite.memberCount,
        approximatePresenceCount: invite.presenceCount
      });
    }

    const cachedGuild = this.client.guilds.cache.get(target);
    const guild = cachedGuild ?? (await this.client.guilds.fetch(target).catch(() => null));
    if (guild) {
      return snapshot({
        id: guild.id,
        name: guild.name,
        description: guild.description,
        iconUrl: guild.iconURL(),
        approximateMemberCount: guild.memberCount,
        approximatePresenceCount: guild.approximatePresenceCount ?? null
      });
    }

    const preview = await this.client.fetchGuildPreview(target).catch(() => null);
    if (!preview) return null;
    return snapshot({
      id: preview.id,
      name: preview.name,
      description: preview.description,
      iconUrl: preview.iconURL(),
      approximateMemberCount: preview.approximateMemberCount,
      approximatePresenceCount: preview.approximatePresenceCount
    });
  }
}
