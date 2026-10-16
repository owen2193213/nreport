import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_DISCORD_JS_VERSION = "14.27.0";
const ORIGINAL_LINE = "    this.channelId = data.channel_id ?? channel.id;";
const PATCHED_LINE = "    this.channelId = message.channelId ?? channel?.id;";

/**
 * Avoids a discord.js 14.27.0 Poll constructor crash for uncached channels.
 * The patch is intentionally exact-version and exact-source guarded: upstream
 * changes require reviewing and updating this small compatibility patch.
 */
export async function applyDiscordJsPollPatch(discordPackagePath) {
  const packageJsonPath = join(discordPackagePath, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.name !== "discord.js" || packageJson.version !== EXPECTED_DISCORD_JS_VERSION) {
    throw new Error(
      `Discord.js poll compatibility patch expected discord.js ${EXPECTED_DISCORD_JS_VERSION}; ` +
      `found ${String(packageJson.name)} ${String(packageJson.version)}. Review upstream before updating the patch.`
    );
  }

  const sourcePath = join(discordPackagePath, "src", "structures", "Poll.js");
  const source = await readFile(sourcePath, "utf8");
  const originalCount = source.split(ORIGINAL_LINE).length - 1;
  const patchedCount = source.split(PATCHED_LINE).length - 1;

  if (originalCount === 0 && patchedCount === 1) return "already-applied";
  if (originalCount !== 1 || patchedCount !== 0) {
    throw new Error("Discord.js 14.27.0 Poll.js has an unexpected source shape; refusing to patch it.");
  }

  await writeFile(sourcePath, source.replace(ORIGINAL_LINE, PATCHED_LINE), "utf8");
  return "applied";
}

async function runAtRepositoryRoot() {
  const rootDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  const discordPackagePath = join(rootDirectory, "node_modules", "discord.js");

  try {
    await readFile(join(discordPackagePath, "package.json"), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  const result = await applyDiscordJsPollPatch(discordPackagePath);
  if (result === "applied") console.log("Applied guarded discord.js Poll uncached-channel compatibility patch.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runAtRepositoryRoot();
}
