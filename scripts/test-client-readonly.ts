import { DiscordDsaClient } from "../src/client.js";

const proxyUrl = process.env.DSA_PROXY_URL;
if (proxyUrl === undefined || proxyUrl.length === 0) {
  throw new Error("DSA_PROXY_URL is required for the read-only client smoke test.");
}

const client = new DiscordDsaClient({
  codeQueryB: process.env.DSA_CODE_QUERY_B ?? "js30bq",
  proxyUrl
});

try {
  const fingerprint = await client.bootstrapFingerprint();
  const menu = await client.getMenu("message_urf");
  console.log(
    JSON.stringify({
      fingerprintAcquired: fingerprint.length > 0,
      menu: menu.name,
      version: menu.version,
      variant: menu.variant,
      rootNodeId: menu.root_node_id
    })
  );
} finally {
  await client.close();
}
