import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const preloadUrl = new URL("./fixtures/sentry-preload.mjs", import.meta.url).href;
const disabledPreloadUrl = new URL("../dist/instrument-api.js", import.meta.url).href;
const fixturePath = fileURLToPath(new URL("./fixtures/sentry-child.mjs", import.meta.url));

interface CapturedEvent {
  exception?: { values?: Array<{ value?: string; stacktrace?: { frames?: unknown[] } }> };
  contexts?: Record<string, unknown> & { lifecycle?: Record<string, unknown> };
  tags?: Record<string, string>;
}

type Envelope = [Record<string, unknown>, Array<[{ type?: string }, CapturedEvent]>];

function runNode(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function eventFromOutput(stdout: string): CapturedEvent {
  let receivedEnvelope = false;
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith("SENTRY_ENVELOPE=")) continue;
    receivedEnvelope = true;
    const envelope = JSON.parse(line.slice("SENTRY_ENVELOPE=".length)) as Envelope;
    const item = envelope[1].find(([headers]) => headers.type === "event");
    if (item !== undefined) return item[1];
  }
  if (!receivedEnvelope) throw new Error("The SDK transport did not receive an event envelope");
  throw new Error("Expected an event envelope item");
}

describe("Sentry Node bootstrap", () => {
  it("sends a scrubbed original Error, cause, and lifecycle context through the SDK transport", async () => {
    const result = await runNode(["--enable-source-maps", "--import", preloadUrl, fixturePath, "capture"], {
      ...process.env,
      NODE_ENV: "production",
      SENTRY_DSN: "http://public@example.invalid/1",
      SENTRY_ENVIRONMENT: "",
      SENTRY_TRACES_SAMPLE_RATE: "0"
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('"captured":true');
    expect(result.stdout).toContain('"flushed":true');
    const event = eventFromOutput(result.stdout);
    expect(event.exception?.values?.map((value) => value.value).join(" ")).toContain("provider failed");
    expect(event.exception?.values?.length).toBeGreaterThanOrEqual(2);
    expect(event.exception?.values?.some((value) => (value.stacktrace?.frames?.length ?? 0) > 0)).toBe(true);
    expect(event.contexts?.lifecycle).toMatchObject({ service: "api", operation: "report.prepare", stage: "preparation" });
    expect(event.tags).toMatchObject({ report_id: "8a637427-81d0-4115-9098-21bd9520048c", report_trace_id: "e6103c37-995b-41ef-b0de-0654dfac06cb" });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("canary-api-key-do-not-log");
    expect(serialized).not.toContain("https://provider.example");
    expect(serialized).toContain("[REDACTED_SECRET]");
    expect(serialized).toContain("[REDACTED_URL]");
  }, 40_000);

  it.each(["fatal", "unhandled"] as const)("logs scrubbed %s diagnostics, sends the original exception, and exits nonzero", async (mode) => {
    const result = await runNode(["--enable-source-maps", "--import", preloadUrl, fixturePath, mode], {
      ...process.env,
      NODE_ENV: "production",
      SENTRY_DSN: "http://public@example.invalid/1",
      SENTRY_TRACES_SAMPLE_RATE: "0"
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"level":"fatal"');
    expect(result.stderr).not.toContain("canary-api-key-do-not-log");
    const event = eventFromOutput(result.stdout);
    expect(event.exception?.values?.map((value) => value.value).join(" ")).toContain("fatal");
    expect(JSON.stringify(event)).not.toContain("canary-api-key-do-not-log");
    expect(JSON.stringify(event)).not.toContain("https://provider.example");
  }, 40_000);

  it.each([
    ["fatal", ""],
    ["unhandled", ""],
    ["fatal", "not-a-dsn"],
    ["unhandled", "not-a-dsn"]
  ] as const)("redacts %s failures when Sentry is unavailable (DSN: %s)", async (mode, dsn) => {
    const result = await runNode(["--import", disabledPreloadUrl, fixturePath, mode], {
      ...process.env,
      NODE_ENV: "production",
      SENTRY_DSN: dsn
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"level":"fatal"');
    expect(result.stderr).not.toContain("canary-api-key-do-not-log");
    expect(result.stderr).not.toContain("https://provider.example");
    expect(result.stderr).not.toContain("Node.js v");
    expect(result.stderr.match(/"level":"fatal"/gu)).toHaveLength(1);
  }, 40_000);

  it("keeps the production CLI preload safe when the DSN is absent", async () => {
    const result = await runNode(["--enable-source-maps", "--import", disabledPreloadUrl, "-e", "process.stdout.write('app-loaded\\n')"], {
      ...process.env,
      SENTRY_DSN: "",
      NODE_ENV: "production"
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("app-loaded");
    expect(result.stderr).toBe("");
  }, 40_000);
});
