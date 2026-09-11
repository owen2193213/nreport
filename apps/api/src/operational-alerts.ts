export interface AlertQueuePhase {
  readyPending: number;
  delayedPending: number;
  running: number;
  oldestReadyAgeMs: number | null;
}

export interface WorkerHealthSample {
  component: string;
  lastHeartbeatAgeMs: number;
  lastProgressAgeMs: number | null;
  recentFailureCount?: number;
  recentRateLimitCount?: number;
}

export interface OperationalAlertInput {
  nowMs: number;
  queues: { preparation: AlertQueuePhase; lifecycle: AlertQueuePhase };
  workers: WorkerHealthSample[];
}

export interface OperationalAlert {
  key: string;
  severity: "warning" | "critical";
}

const HEARTBEAT_STALE_MS = 90_000;
const READY_STALLED_MS = 120_000;

export function evaluateOperationalAlerts(input: OperationalAlertInput): OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  for (const worker of input.workers) {
    if (worker.lastHeartbeatAgeMs > HEARTBEAT_STALE_MS) {
      alerts.push({ key: `worker.${worker.component}.missing`, severity: "critical" });
    }
    if ((worker.recentFailureCount ?? 0) >= 3) {
      alerts.push({ key: `worker.${worker.component}.failures`, severity: "critical" });
    }
    if ((worker.recentRateLimitCount ?? 0) >= 10) {
      alerts.push({ key: `worker.${worker.component}.rate_limits`, severity: "warning" });
    }
  }
  for (const [component, queue] of Object.entries(input.queues) as Array<["preparation" | "lifecycle", AlertQueuePhase]>) {
    if (queue.readyPending > 0 && (queue.oldestReadyAgeMs ?? 0) > READY_STALLED_MS) {
      alerts.push({ key: `queue.${component}.oldest_ready`, severity: "warning" });
    }
    const workers = input.workers.filter((worker) => worker.component === component);
    if (queue.readyPending > 0 && workers.some((worker) =>
      worker.lastHeartbeatAgeMs <= HEARTBEAT_STALE_MS && (worker.lastProgressAgeMs ?? Infinity) > READY_STALLED_MS
    )) alerts.push({ key: `queue.${component}.no_progress`, severity: "critical" });
  }
  return alerts;
}
