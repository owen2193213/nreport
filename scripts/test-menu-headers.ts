import { ProxyAgent, request } from "undici";
import type { Dispatcher } from "undici";

import { REPORT_FLOWS, type ReportFlow } from "@discord-dsa/client";

const baseUrl = "https://discord.com/api/v9/reporting/unauthenticated/menu/";
const proxyUrl = process.env.DSA_PROXY_URL;
const dispatcher: Dispatcher | undefined =
  proxyUrl === undefined ? undefined : new ProxyAgent(proxyUrl);

const browserHeaders: Record<string, string> = {
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  priority: "u=1, i",
  "sec-ch-ua": '"Chromium";v="150"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "x-debug-options": "bugReporterEnabled",
  "x-discord-locale": "en-US",
  "x-discord-timezone": process.env.DSA_TEST_TIMEZONE ?? "Europe/Berlin"
};

const sessionHeaders: Record<string, string> = {};
if (process.env.DSA_FINGERPRINT !== undefined) {
  sessionHeaders["x-fingerprint"] = process.env.DSA_FINGERPRINT;
}
if (process.env.DSA_INSTALLATION_ID !== undefined) {
  sessionHeaders["x-installation-id"] = process.env.DSA_INSTALLATION_ID;
}
if (process.env.DSA_SUPER_PROPERTIES !== undefined) {
  sessionHeaders["x-super-properties"] = process.env.DSA_SUPER_PROPERTIES;
}

const profiles: Record<string, Record<string, string>> = {
  none: {},
  accept_only: { accept: "*/*" },
  locale: {
    accept: "*/*",
    "x-discord-locale": "en-US",
    "x-discord-timezone": "Europe/Berlin"
  },
  browser_transport: browserHeaders
};

if (Object.keys(sessionHeaders).length > 0) {
  profiles.full_with_session = { ...browserHeaders, ...sessionHeaders };
  profiles.session_only = { accept: "*/*", ...sessionHeaders };

  const fingerprint = sessionHeaders["x-fingerprint"];
  if (fingerprint !== undefined) {
    profiles.fingerprint_no_accept = {
      "x-fingerprint": fingerprint
    };
    profiles.fingerprint_only = {
      accept: "*/*",
      "x-fingerprint": fingerprint
    };
    const installationId = sessionHeaders["x-installation-id"];
    if (installationId !== undefined) {
      profiles.fingerprint_installation = {
        accept: "*/*",
        "x-fingerprint": fingerprint,
        "x-installation-id": installationId
      };
    }
  }

  for (const headerName of Object.keys(sessionHeaders)) {
    const ablated = { ...browserHeaders, ...sessionHeaders };
    delete ablated[headerName];
    profiles[`without_${headerName}`] = ablated;
  }
}

interface ResultRow {
  profile: string;
  flow: string;
  status: number | string;
  validMenu: boolean;
}

const results: ResultRow[] = [];
const requestedFlow = process.env.DSA_TEST_FLOW;
const flows: readonly ReportFlow[] =
  requestedFlow === undefined
    ? REPORT_FLOWS
    : REPORT_FLOWS.includes(requestedFlow as ReportFlow)
      ? [requestedFlow as ReportFlow]
      : [];

if (flows.length === 0) {
  throw new Error(`Unsupported DSA_TEST_FLOW: ${requestedFlow ?? ""}`);
}

const requestedProfiles = new Set(
  (process.env.DSA_TEST_PROFILES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
);
const profileEntries = Object.entries(profiles).filter(
  ([name]) => requestedProfiles.size === 0 || requestedProfiles.has(name)
);

if (profileEntries.length === 0) {
  throw new Error("DSA_TEST_PROFILES did not match any available profile.");
}

for (const [profile, headers] of profileEntries) {
  for (const flow of flows) {
    try {
      const response = await request(`${baseUrl}${flow}`, {
        method: "GET",
        headers,
        ...(dispatcher === undefined ? {} : { dispatcher }),
        headersTimeout: 15_000,
        bodyTimeout: 15_000
      });
      const text = await response.body.text();
      let validMenu = false;
      try {
        const parsed = JSON.parse(text) as { name?: unknown };
        validMenu = parsed.name === flow;
      } catch {
        validMenu = false;
      }
      results.push({ profile, flow, status: response.statusCode, validMenu });
    } catch (error) {
      results.push({
        profile,
        flow,
        status: error instanceof Error ? error.name : "network_error",
        validMenu: false
      });
    }
  }
}

console.log(`Proxy configured: ${proxyUrl === undefined ? "no" : "yes"}`);
console.log(
  `Session metadata supplied: ${Object.keys(sessionHeaders).length === 0 ? "no" : "yes"}`
);
console.table(results);
await dispatcher?.close();

if (results.some((result) => !result.validMenu)) process.exitCode = 1;
