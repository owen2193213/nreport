import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

type RepairArguments = { mode: "dry-run" | "apply" | "verify"; runId?: string };
type Counts = { pendingLinks: number; cardRepairs: number; staleNotifications: number };

export function parseRepairArguments(args: readonly string[]): RepairArguments {
  let mode: RepairArguments["mode"] = "dry-run";
  let runId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") mode = "dry-run";
    else if (argument === "--apply") mode = "apply";
    else if (argument === "--verify") mode = "verify";
    else if (argument === "--run-id") { runId = args[index + 1]; index += 1; }
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if ((mode === "apply" || mode === "verify") && (runId === undefined || !/^[a-zA-Z0-9-]{8,80}$/.test(runId))) throw new Error(`${mode} requires --run-id from a dry-run preview.`);
  return { mode, ...(runId === undefined ? {} : { runId }) };
}

async function ensureTables(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS report_flow_repair_runs (
    run_id text PRIMARY KEY, service text NOT NULL, plan jsonb NOT NULL,
    applied_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS report_flow_repair_items (
    run_id text NOT NULL REFERENCES report_flow_repair_runs(run_id) ON DELETE CASCADE,
    kind text NOT NULL, entity_id text NOT NULL, expected_at timestamptz NOT NULL,
    PRIMARY KEY (run_id, kind, entity_id)
  )`);
}

async function manifestCounts(client: PoolClient, runId: string): Promise<Counts> {
  const result = await client.query<{ kind: string; count: string }>("SELECT kind, count(*)::text FROM report_flow_repair_items WHERE run_id = $1 GROUP BY kind", [runId]);
  const rows = Object.fromEntries(result.rows.map((row) => [row.kind, Number(row.count)]));
  return { pendingLinks: rows.pending_link ?? 0, cardRepairs: rows.card_repair ?? 0, staleNotifications: rows.notification ?? 0 };
}

async function createManifest(client: PoolClient, runId: string): Promise<Counts> {
  await client.query(`INSERT INTO report_flow_repair_items (run_id, kind, entity_id, expected_at)
    SELECT $1, 'pending_link', id::text, updated_at FROM bot_report_links
    WHERE report_id IS NULL AND (recovery_claimed_at IS NULL OR recovery_claimed_at < now() - interval '2 minutes')`, [runId]);
  await client.query(`INSERT INTO report_flow_repair_items (run_id, kind, entity_id, expected_at)
    SELECT $1, 'card_repair', id::text, updated_at FROM bot_report_links
    WHERE report_id IS NOT NULL AND superseded_by_report_id IS NULL AND dm_message_id IS NULL
      AND (card_repair_claimed_at IS NULL OR card_repair_claimed_at < now() - interval '2 minutes')`, [runId]);
  await client.query(`INSERT INTO report_flow_repair_items (run_id, kind, entity_id, expected_at)
    SELECT $1, 'notification', event_id::text, locked_at FROM lifecycle_inbox
    WHERE state = 'sending' AND locked_at < now() - interval '2 minutes'`, [runId]);
  return manifestCounts(client, runId);
}

async function applyManifest(client: PoolClient, runId: string): Promise<Counts> {
  const links = await client.query(`UPDATE bot_report_links AS link SET recovery_claimed_at = NULL, recovery_run_at = now(), updated_at = now()
    FROM report_flow_repair_items AS item WHERE item.run_id = $1 AND item.kind = 'pending_link' AND item.entity_id = link.id::text
      AND link.report_id IS NULL AND link.updated_at IS NOT DISTINCT FROM item.expected_at
      AND (link.recovery_claimed_at IS NULL OR link.recovery_claimed_at < now() - interval '2 minutes')`, [runId]);
  const cards = await client.query(`UPDATE bot_report_links AS link SET card_repair_claimed_at = NULL, card_repair_run_at = now(), updated_at = now()
    FROM report_flow_repair_items AS item WHERE item.run_id = $1 AND item.kind = 'card_repair' AND item.entity_id = link.id::text
      AND link.report_id IS NOT NULL AND link.superseded_by_report_id IS NULL AND link.dm_message_id IS NULL
      AND link.updated_at IS NOT DISTINCT FROM item.expected_at
      AND (link.card_repair_claimed_at IS NULL OR link.card_repair_claimed_at < now() - interval '2 minutes')`, [runId]);
  const notifications = await client.query(`UPDATE lifecycle_inbox AS inbox SET state = 'pending', locked_at = NULL, run_at = now()
    FROM report_flow_repair_items AS item WHERE item.run_id = $1 AND item.kind = 'notification' AND item.entity_id = inbox.event_id::text
      AND inbox.state = 'sending' AND inbox.locked_at IS NOT DISTINCT FROM item.expected_at
      AND inbox.locked_at < now() - interval '2 minutes'`, [runId]);
  return { pendingLinks: links.rowCount ?? 0, cardRepairs: cards.rowCount ?? 0, staleNotifications: notifications.rowCount ?? 0 };
}

async function remainingManifest(client: PoolClient, runId: string): Promise<Counts> {
  const result = await client.query<{ kind: string; count: string }>(`SELECT item.kind, count(*)::text
    FROM report_flow_repair_items AS item LEFT JOIN bot_report_links AS link ON item.entity_id = link.id::text
    LEFT JOIN lifecycle_inbox AS inbox ON item.entity_id = inbox.event_id::text
    WHERE item.run_id = $1 AND ((item.kind = 'pending_link' AND link.report_id IS NULL
      AND link.updated_at IS NOT DISTINCT FROM item.expected_at AND (link.recovery_claimed_at IS NULL OR link.recovery_claimed_at < now() - interval '2 minutes'))
      OR (item.kind = 'card_repair' AND link.report_id IS NOT NULL AND link.superseded_by_report_id IS NULL AND link.dm_message_id IS NULL
      AND link.updated_at IS NOT DISTINCT FROM item.expected_at AND (link.card_repair_claimed_at IS NULL OR link.card_repair_claimed_at < now() - interval '2 minutes'))
      OR (item.kind = 'notification' AND inbox.state = 'sending' AND inbox.locked_at IS NOT DISTINCT FROM item.expected_at AND inbox.locked_at < now() - interval '2 minutes'))
    GROUP BY item.kind`, [runId]);
  const rows = Object.fromEntries(result.rows.map((row) => [row.kind, Number(row.count)]));
  return { pendingLinks: rows.pending_link ?? 0, cardRepairs: rows.card_repair ?? 0, staleNotifications: rows.notification ?? 0 };
}

async function main(): Promise<void> {
  const input = parseRepairArguments(process.argv.slice(2));
  const databaseUrl = process.env.BOT_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("BOT_DATABASE_URL is required.");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const client = await pool.connect();
    try {
      await ensureTables(client);
      if (input.mode === "dry-run") {
        const runId = `bot-${randomUUID()}`;
        await client.query("BEGIN");
        await client.query("INSERT INTO report_flow_repair_runs (run_id, service, plan) VALUES ($1, 'bot', '{}'::jsonb)", [runId]);
        const plan = await createManifest(client, runId);
        await client.query("UPDATE report_flow_repair_runs SET plan = $2::jsonb WHERE run_id = $1", [runId, JSON.stringify(plan)]);
        await client.query("COMMIT");
        console.log(JSON.stringify({ mode: "dry-run", runId, plan }));
        return;
      }
      await client.query("BEGIN");
      const run = await client.query<{ applied_at: Date | null }>("SELECT applied_at FROM report_flow_repair_runs WHERE run_id = $1 AND service = 'bot' FOR UPDATE", [input.runId]);
      if (run.rows[0] === undefined) throw new Error("Unknown repair preview run.");
      if (input.mode === "verify") {
        const remaining = await remainingManifest(client, input.runId!);
        await client.query("COMMIT");
        console.log(JSON.stringify({ mode: "verify", runId: input.runId, remaining }));
        return;
      }
      if (run.rows[0].applied_at !== null) throw new Error("This repair preview was already applied.");
      const repaired = await applyManifest(client, input.runId!);
      await client.query("UPDATE report_flow_repair_runs SET applied_at = now() WHERE run_id = $1", [input.runId]);
      await client.query("COMMIT");
      console.log(JSON.stringify({ mode: "apply", runId: input.runId, repaired }));
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  } finally { await pool.end(); }
}

if (process.argv[1]?.endsWith("repair-report-flow.ts") || process.argv[1]?.endsWith("repair-report-flow.js")) {
  void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "repair failed"); process.exitCode = 1; });
}
