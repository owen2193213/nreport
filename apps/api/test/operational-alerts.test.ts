import { describe, expect, it } from "vitest";

import { evaluateOperationalAlerts } from "../src/operational-alerts.js";

describe("evaluateOperationalAlerts", () => {
  it("opens a queue-stalled alert only when ready work has exceeded the safe age threshold", () => {
    const alerts = evaluateOperationalAlerts({
      nowMs: 1_000_000,
      queues: {
        preparation: { readyPending: 0, delayedPending: 0, running: 0, oldestReadyAgeMs: null },
        lifecycle: { readyPending: 2, delayedPending: 0, running: 0, oldestReadyAgeMs: 121_000 }
      },
      workers: [{ component: "lifecycle", lastHeartbeatAgeMs: 2_000, lastProgressAgeMs: 121_000 }]
    });

    expect(alerts).toContainEqual({ key: "queue.lifecycle.oldest_ready", severity: "warning" });
    expect(JSON.stringify(alerts)).not.toMatch(/report|trace|message/i);
  });

  it("does not raise no-progress for newly queued work after an idle worker interval", () => {
    const alerts = evaluateOperationalAlerts({
      nowMs: 1_000_000,
      queues: {
        preparation: { readyPending: 1, delayedPending: 0, running: 0, oldestReadyAgeMs: 1_000 },
        lifecycle: { readyPending: 0, delayedPending: 0, running: 0, oldestReadyAgeMs: null }
      },
      workers: [{ component: "preparation", lastHeartbeatAgeMs: 1_000, lastProgressAgeMs: 600_000 }]
    });

    expect(alerts).not.toContainEqual({ key: "queue.preparation.no_progress", severity: "critical" });
  });
});
