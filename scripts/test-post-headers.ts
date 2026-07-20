import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { DiscordDsaClient, REPORT_FLOWS, type ReportFlow } from "@discord-dsa/client";

const proxyUrl = process.env.DSA_PROXY_URL;
if (proxyUrl === undefined || proxyUrl.length === 0) {
  throw new Error("DSA_PROXY_URL is required for the POST-header smoke test.");
}

const email = process.env.DSA_TEST_EMAIL;
if (email === undefined || email.length === 0) {
  throw new Error("DSA_TEST_EMAIL is required for the POST-header smoke test.");
}

const flowValue = process.env.DSA_TEST_FLOW ?? "message_urf";
if (!REPORT_FLOWS.includes(flowValue as ReportFlow)) {
  throw new Error(`Unsupported DSA_TEST_FLOW: ${flowValue}`);
}
const flow = flowValue as ReportFlow;

const client = new DiscordDsaClient({
  proxyUrl
});

const prompt = createInterface({ input: stdin, output: stdout });

try {
  const fingerprint = await client.bootstrapFingerprint();
  await client.sendEmailCode(flow, email);

  console.log(
    JSON.stringify({
      codeSent: true,
      flow,
      fingerprintAcquired: fingerprint.length > 0
    })
  );

  const code = (await prompt.question("Verification code: ")).trim();
  if (!/^[A-Z0-9]{6}$/i.test(code)) {
    throw new Error("The verification code must contain six letters or digits.");
  }

  const emailToken = await client.verifyEmailCode(flow, email, code);
  const menu = await client.getMenu(flow);

  console.log(
    JSON.stringify({
      verified: emailToken.length > 0,
      menu: menu.name,
      version: menu.version,
      variant: menu.variant,
      rootNodeId: menu.root_node_id
    })
  );
} finally {
  prompt.close();
  await client.close();
}
