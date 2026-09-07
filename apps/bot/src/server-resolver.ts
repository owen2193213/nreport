import type { Client } from "discord.js";

export interface ServerDisplaySnapshot {
  idOrInvite: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  memberCount: number | null;
  presenceCount: number | null;
}

export class ServerResolver {
  public constructor(private readonly client: Client) {}

  public async resolve(idOrInvite: string): Promise<ServerDisplaySnapshot | null> {
    const value = idOrInvite.trim();
    if (!value) return null;
    if (/^\d{15,22}$/.test(value)) {
      const guild = await this.client.guilds.fetch({ guild: value, withCounts: true }).catch(() => null);
      if (!guild?.name) return null;
      return {
        idOrInvite: guild.id,
        name: guild.name,
        description: guild.description,
        imageUrl: guild.iconURL(),
        memberCount: guild.approximateMemberCount ?? null,
        presenceCount: guild.approximatePresenceCount ?? null
      };
    }
    const invite = await this.client.fetchInvite(value).catch(() => null);
    const guild = invite?.guild;
    if (!guild?.name) return null;
    return {
      idOrInvite: guild.id ?? value,
      name: guild.name,
      description: guild.description ?? null,
      imageUrl: guild.iconURL(),
      memberCount: invite?.memberCount ?? null,
      presenceCount: invite?.presenceCount ?? null
    };
  }
}
