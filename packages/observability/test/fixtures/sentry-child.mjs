import { captureLifecycleFailure, flushSentry } from "../../dist/index.js";
import * as Sentry from "@sentry/node";

if (process.argv[2] === "capture") {
  const cause = new Error("upstream response code=503 with https://provider.example/?token=private");
  const error = new Error("provider failed canary-api-key-do-not-log", { cause });
  const eventId = captureLifecycleFailure(error, {
    service: "api",
    operation: "report.prepare",
    reportId: "8a637427-81d0-4115-9098-21bd9520048c",
    traceId: "e6103c37-995b-41ef-b0de-0654dfac06cb",
    stage: "preparation",
    upstreamResponseSummary: "provider_error=temporary_unavailable"
  });
  const flushed = await flushSentry(3_000);
  process.stdout.write(JSON.stringify({ captured: eventId !== undefined, enabled: Sentry.isEnabled(), flushed }) + "\n");
} else if (process.argv[2] === "unhandled") {
  Promise.reject(new Error("fatal unhandled canary-api-key-do-not-log", {
    cause: new Error("nested provider failure https://provider.example/?token=private")
  }));
} else {
  setTimeout(() => {
    throw new Error("fatal canary-api-key-do-not-log", {
      cause: new Error("nested provider failure https://provider.example/?token=private")
    });
  }, 0);
}
