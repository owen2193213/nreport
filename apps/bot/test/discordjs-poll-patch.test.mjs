import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDiscordJsPollPatch } from "../../../scripts/patch-discordjs-poll.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const vulnerableLine = "    this.channelId = data.channel_id ?? channel.id;";
const patchedLine = "    this.channelId = message.channelId ?? channel?.id;";
let fixtureDirectories = [];

afterEach(async () => {
  for (const fixtureDirectory of fixtureDirectories) {
    if (dirname(fixtureDirectory) !== testDirectory) throw new Error("Refusing to remove an unexpected test directory.");
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
  fixtureDirectories = [];
});

async function fixture(version = "14.27.0", sourceLine = vulnerableLine) {
  const fixtureDirectory = await mkdtemp(join(testDirectory, "discordjs-poll-patch-"));
  fixtureDirectories.push(fixtureDirectory);
  const packagePath = join(fixtureDirectory, "discord.js");
  const sourcePath = join(packagePath, "src", "structures", "Poll.js");
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(join(packagePath, "package.json"), JSON.stringify({ name: "discord.js", version }));
  await writeFile(sourcePath, `class Poll {\n${sourceLine}\n}`);
  return { packagePath, sourcePath };
}

describe("Discord.js poll compatibility patch", () => {
  it("applies the uncached-channel fallback only to the pinned package", async () => {
    const { packagePath, sourcePath } = await fixture();

    await expect(applyDiscordJsPollPatch(packagePath)).resolves.toBe("applied");
    await expect(readFile(sourcePath, "utf8")).resolves.toContain(patchedLine);
  });

  it("is idempotent after the exact patch is present", async () => {
    const { packagePath, sourcePath } = await fixture("14.27.0", patchedLine);
    const original = await readFile(sourcePath, "utf8");

    await expect(applyDiscordJsPollPatch(packagePath)).resolves.toBe("already-applied");
    await expect(readFile(sourcePath, "utf8")).resolves.toBe(original);
  });

  it("fails closed when discord.js has an unreviewed version", async () => {
    const wrongVersion = await fixture("14.28.0");
    await expect(applyDiscordJsPollPatch(wrongVersion.packagePath)).rejects.toThrow("expected discord.js 14.27.0");
  });

  it("fails closed when Poll.js has an unreviewed source shape", async () => {
    const unexpectedSource = await fixture("14.27.0", "    this.channelId = null;");
    await expect(applyDiscordJsPollPatch(unexpectedSource.packagePath)).rejects.toThrow("unexpected source shape");
  });
});
