import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

type Options = { mode: "dry-run" | "apply" | "verify"; runId?: string };
type Counts = { preparationJobs: number; lifecycleJobs: number };

function options(args: readonly string[]): Options {
  let mode: Options["mode"] = "dry-run";
  let runId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--dry-run") mode = "dry-run";
    else if (args[index] === "--apply") mode = "apply";
    else if (args[index] === "--verify") mode = "verify";
    else if (args[index] === "--run-id") { runId = args[index + 1]; index += 1; }
    else throw new Error(`Unknown argument: ${args[index]}`);
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
    kind text NOT NULL, entity_id text NOT NULL, expected_locked_at timestamptz NOT NULL,
    PRIMARY KEY (run_id, kind, entity_id)
  )`);
}

async function manifestCounts(client: PoolClient, runId: string): Promise<Counts> {
  const result = await client.query<{ kind: string; count: string }>(
    "SELECT kind, count(*)::text FROM report_flow_repair_items WHERE run_id = $1 GROUP BY kind", [runId]
  );
  const rows = Object.fromEntries(result.rows.map((row) => [row.kind, Number(row.count)]));
  return { preparationJobs: rows.preparation_job ?? 0, lifecycleJobs: rows.lifecycle_job ?? 0 };
}

async function createManifest(client: PoolClient, runId: string): Promise<Counts> {
  await client.query(`INSERT INTO report_flow_repair_items (run_id, kind, entity_id, expected_locked_at)
    SELECT $1, 'preparation_job', id::text, locked_at FROM account_report_jobs
    WHERE kind = 'prepare_report' AND state = 'running' AND locked_at < now() - interval '6 minutes'`, [runId]);
  await client.query(`INSERT INTO report_flow_repair_items (run_id, kind, entity_id, expected_locked_at)
    SELECT $1, 'lifecycle_job', id::text, locked_at FROM account_report_jobs
    WHERE kind <> 'prepare_report' AND state = 'running' AND locked_at < now() - interval '2 minutes'`, [runId]);
  return manifestCounts(client, runId);
}

async function applyManifest(client: PoolClient, runId: string): Promise<Counts> {
  const preparation = await client.query(`UPDATE account_report_jobs AS job
    SET state = 'pending', locked_at = NULL, run_at = now(), updated_at = now()
    FROM report_flow_repair_items AS item
    WHERE item.run_id = $1 AND item.kind = 'preparation_job' AND item.entity_id = job.id::text
      AND job.kind = 'prepare_report' AND job.state = 'running'
      AND job.locked_at IS NOT DISTINCT FROM item.expected_locked_at
      AND job.locked_at < now() - interval '6 minutes'`, [runId]);
  const lifecycle = await client.query(`UPDATE account_report_jobs AS job
    SET state = 'pending', locked_at = NULL, run_at = now(), updated_at = now()
    FROM report_flow_repair_items AS item
    WHERE item.run_id = $1 AND item.kind = 'lifecycle_job' AND item.entity_id = job.id::text
      AND job.kind <> 'prepare_report' AND job.state = 'running'
      AND job.locked_at IS NOT DISTINCT FROM item.expected_locked_at
      AND job.locked_at < now() - interval '2 minutes'`, [runId]);
  return { preparationJobs: preparation.rowCount ?? 0, lifecycleJobs: lifecycle.rowCount ?? 0 };
}

async function remainingManifest(client: PoolClient, runId: string): Promise<Counts> {
  const result = await client.query<{ kind: string; count: string }>(`SELECT item.kind, count(*)::text
    FROM report_flow_repair_items AS item JOIN account_report_jobs AS job ON item.entity_id = job.id::text
    WHERE item.run_id = $1 AND ((item.kind = 'preparation_job' AND job.kind = 'prepare_report' AND job.state = 'running'
      AND job.locked_at IS NOT DISTINCT FROM item.expected_locked_at AND job.locked_at < now() - interval '6 minutes')
      OR (item.kind = 'lifecycle_job' AND job.kind <> 'prepare_report' AND job.state = 'running'
      AND job.locked_at IS NOT DISTINCT FROM item.expected_locked_at AND job.locked_at < now() - interval '2 minutes'))
    GROUP BY item.kind`, [runId]);
  const rows = Object.fromEntries(result.rows.map((row) => [row.kind, Number(row.count)]));
  return { preparationJobs: rows.preparation_job ?? 0, lifecycleJobs: rows.lifecycle_job ?? 0 };
}

async function main(): Promise<void> {
  const input = options(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const client = await pool.connect();
    try {
      await ensureTables(client);
      if (input.mode === "dry-run") {
        const runId = `api-${randomUUID()}`;
        await client.query("BEGIN");
        await client.query("INSERT INTO report_flow_repair_runs (run_id, service, plan) VALUES ($1, 'api', '{}'::jsonb)", [runId]);
        const plan = await createManifest(client, runId);
        await client.query("UPDATE report_flow_repair_runs SET plan = $2::jsonb WHERE run_id = $1", [runId, JSON.stringify(plan)]);
        await client.query("COMMIT");
        console.log(JSON.stringify({ mode: "dry-run", runId, plan }));
        return;
      }
      await client.query("BEGIN");
      const run = await client.query<{ applied_at: Date | null }>("SELECT applied_at FROM report_flow_repair_runs WHERE run_id = $1 AND service = 'api' FOR UPDATE", [input.runId]);
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
