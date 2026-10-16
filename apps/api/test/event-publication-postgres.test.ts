import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { ACCOUNT_SCHEMA_SQL } from "../src/accounts.js";
import {
  REPORT_EVENT_PUBLICATION_SCHEMA_SQL,
  REPORT_SCHEMA_SQL,
  ReportRepository
} from "../src/report-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl === undefined ? describe.skip : describe;
const schema = `event_publication_${randomUUID().replaceAll("-", "")}`;
const adminPool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });
const legacySchema = `legacy_event_publication_${randomUUID().replaceAll("-", "")}`;
let pool: Pool | undefined;
let repository: ReportRepository | undefined;
let legacyPool: Pool | undefined;

async function waitForAdvisoryWait(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await adminPool!.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
         WHERE pid = $1 AND locktype = 'advisory' AND granted = false
       ) AS waiting`,
      [pid]
    );
    if (result.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The event insert did not block on the publication advisory lock.");
}

suite("event publication PostgreSQL concurrency", () => {
  beforeAll(async () => {
    await adminPool!.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await pool.query(ACCOUNT_SCHEMA_SQL);
    await pool.query(REPORT_SCHEMA_SQL);
    repository = new ReportRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await legacyPool?.end();
    if (adminPool !== undefined) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.query(`DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`);
      await adminPool.end();
    }
  });

  it("keeps a later-committing event after the feed cursor", async () => {
    const accountId = randomUUID();
    await pool!.query(
      `INSERT INTO api_accounts (id, username, username_normalized, available_credits)
       VALUES ($1, $2, $2, 1)`,
      [accountId, `test-${accountId.slice(0, 8)}`]
    );
    await pool!.query(
      `INSERT INTO credit_ledger (account_id, kind, available_delta, reserved_delta, reason)
       VALUES ($1, 'grant', 1, 0, 'PostgreSQL event-feed fixture')`,
      [accountId]
    );
    const created = await repository!.create(accountId, "event-publication-create", {
      flow: "message",
      useAi: true,
      target: {
        messageUrl: "https://discord.com/channels/@me/123456789012345678/123456789012345679"
      },
      description: "Controlled PostgreSQL event publication fixture."
    });

    const holder = await pool!.connect();
    const delayed = await pool!.connect();
    let holderTransactionOpen = false;
    let delayedTransactionOpen = false;
    try {
      await holder.query("BEGIN");
      holderTransactionOpen = true;
      await holder.query("SELECT pg_advisory_xact_lock(1729132441)");

      await delayed.query("BEGIN");
      delayedTransactionOpen = true;
      const backend = await delayed.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const delayedInsert = delayed.query<{ id: string }>(
        `INSERT INTO account_report_events
           (account_id, report_id, event_type, lifecycle_attempt)
         VALUES ($1, $2, 'publication_delayed', 1)
         RETURNING id::text AS id`,
        [accountId, created.report.id]
      );

      await waitForAdvisoryWait(backend.rows[0]!.pid);

      const committedFirst = await holder.query<{ id: string }>(
        `INSERT INTO account_report_events
           (account_id, report_id, event_type, lifecycle_attempt)
         VALUES ($1, $2, 'publication_committed_first', 1)
         RETURNING id::text AS id`,
        [accountId, created.report.id]
      );
      await holder.query("COMMIT");
      holderTransactionOpen = false;

      const committedLater = await delayedInsert;
      await delayed.query("COMMIT");
      delayedTransactionOpen = false;

      expect(BigInt(committedLater.rows[0]!.id)).toBeGreaterThan(BigInt(committedFirst.rows[0]!.id));
      const pageAfterFirstCommit = await repository!.listEvents(
        accountId,
        committedFirst.rows[0]!.id,
        25
      );
      expect(pageAfterFirstCommit.items.map((event) => event.eventId)).toEqual([
        committedLater.rows[0]!.id
      ]);
      expect(pageAfterFirstCommit.items[0]?.type).toBe("publication_delayed");
    } finally {
      if (holderTransactionOpen) await holder.query("ROLLBACK");
      if (delayedTransactionOpen) await delayed.query("ROLLBACK");
      holder.release();
      delayed.release();
    }
  }, 10_000);

  it("upgrades cached legacy IDs without reusing them or reseeding on later migrations", async () => {
    await adminPool!.query(`CREATE SCHEMA ${legacySchema}`);
    legacyPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${legacySchema}` });
    await legacyPool.query(ACCOUNT_SCHEMA_SQL);
    await legacyPool.query(`
      CREATE TABLE account_reports (
        id uuid PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES api_accounts(id),
        trace_id uuid NOT NULL DEFAULT gen_random_uuid()
      );
      CREATE TABLE account_report_events (
        id bigserial PRIMARY KEY,
        account_id uuid NOT NULL REFERENCES api_accounts(id),
        report_id uuid NOT NULL REFERENCES account_reports(id) ON DELETE CASCADE,
        event_type text NOT NULL,
        lifecycle_attempt integer NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE FUNCTION serialize_account_report_event_inserts()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(1729132441);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER account_report_events_serialize_insert
        AFTER INSERT ON account_report_events
        FOR EACH ROW EXECUTE FUNCTION serialize_account_report_event_inserts();
      ALTER SEQUENCE account_report_events_id_seq CACHE 5;
    `);

    const accountId = randomUUID();
    const reportId = randomUUID();
    await legacyPool.query(
      `INSERT INTO api_accounts (id, username, username_normalized)
       VALUES ($1, $2, $2)`,
      [accountId, `legacy-${accountId.slice(0, 8)}`]
    );
    await legacyPool.query(
      "INSERT INTO account_reports (id, account_id) VALUES ($1, $2)",
      [reportId, accountId]
    );

    const holder = await legacyPool.connect();
    const staleConnection = await legacyPool.connect();
    let holderTransactionOpen = false;
    let staleTransactionOpen = false;
    try {
      await holder.query("BEGIN");
      holderTransactionOpen = true;
      await holder.query("SELECT pg_advisory_xact_lock(1729132441)");

      await staleConnection.query("BEGIN");
      staleTransactionOpen = true;
      const backend = await staleConnection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const delayedInsert = staleConnection.query<{ id: string }>(
        `INSERT INTO account_report_events (account_id, report_id, event_type, lifecycle_attempt)
         VALUES ($1, $2, 'legacy_delayed', 1) RETURNING id::text AS id`,
        [accountId, reportId]
      );
      await waitForAdvisoryWait(backend.rows[0]!.pid);

      const committedFirst = await holder.query<{ id: string }>(
        `INSERT INTO account_report_events (account_id, report_id, event_type, lifecycle_attempt)
         VALUES ($1, $2, 'legacy_committed_first', 1) RETURNING id::text AS id`,
        [accountId, reportId]
      );
      await holder.query("COMMIT");
      holderTransactionOpen = false;
      const committedLater = await delayedInsert;
      await staleConnection.query("COMMIT");
      staleTransactionOpen = false;

      expect(BigInt(committedLater.rows[0]!.id)).toBeLessThan(BigInt(committedFirst.rows[0]!.id));
      const legacyCursor = await new ReportRepository(legacyPool).listEvents(
        accountId,
        committedFirst.rows[0]!.id,
        25
      );
      expect(legacyCursor.items).toEqual([]);

      const migrationTransaction = await legacyPool.connect();
      try {
        await migrationTransaction.query("BEGIN");
        await migrationTransaction.query(REPORT_EVENT_PUBLICATION_SCHEMA_SQL);
        await migrationTransaction.query("ROLLBACK");
      } finally {
        migrationTransaction.release();
      }
      const rolledBackShape = await legacyPool.query<{
        column_default: string | null;
        trigger_definition: string;
      }>(
        `SELECT column_default,
                (SELECT pg_get_triggerdef(event_trigger.oid)
                 FROM pg_trigger AS event_trigger
                 WHERE event_trigger.tgrelid = 'account_report_events'::regclass
                   AND NOT event_trigger.tgisinternal) AS trigger_definition
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'account_report_events' AND column_name = 'id'`
      );
      expect(rolledBackShape.rows[0]?.column_default).toContain("nextval");
      expect(rolledBackShape.rows[0]?.trigger_definition).toContain("AFTER INSERT");

      const oldSequence = await legacyPool.query<{ last_value: string }>(
        "SELECT last_value::text AS last_value FROM account_report_events_id_seq"
      );
      const oldHighWater = BigInt(oldSequence.rows[0]!.last_value);
      await legacyPool.query(REPORT_EVENT_PUBLICATION_SCHEMA_SQL);

      const sequenceState = await legacyPool.query<{
        last_value: string;
        cache_size: string;
        attached_to_event_id: boolean;
        id_default_removed: boolean;
      }>(
        `SELECT ordered.last_value::text AS last_value, seq_info.cache_size,
                pg_get_serial_sequence('account_report_events', 'id')::regclass =
                  'account_report_events_ordered_id_seq'::regclass AS attached_to_event_id,
                NOT EXISTS (
                  SELECT 1 FROM information_schema.columns
                  WHERE table_schema = current_schema()
                    AND table_name = 'account_report_events' AND column_name = 'id'
                    AND column_default IS NOT NULL
                ) AS id_default_removed
         FROM account_report_events_ordered_id_seq AS ordered
         JOIN pg_sequences AS seq_info
           ON seq_info.schemaname = current_schema()
          AND seq_info.sequencename = 'account_report_events_ordered_id_seq'`
      );
      expect(Number(sequenceState.rows[0]?.cache_size)).toBe(1);
      expect(sequenceState.rows[0]?.attached_to_event_id).toBe(true);
      expect(sequenceState.rows[0]?.id_default_removed).toBe(true);
      expect(BigInt(sequenceState.rows[0]!.last_value)).toBeGreaterThanOrEqual(oldHighWater);
      const preservedLegacySequence = await legacyPool.query<{ last_value: string }>(
        "SELECT last_value::text AS last_value FROM account_report_events_id_seq"
      );
      expect(preservedLegacySequence.rows[0]?.last_value).toBe(oldHighWater.toString());

      const firstAfterMigration = await staleConnection.query<{ id: string }>(
        `INSERT INTO account_report_events (account_id, report_id, event_type, lifecycle_attempt)
         VALUES ($1, $2, 'after_migration', 1) RETURNING id::text AS id`,
        [accountId, reportId]
      );
      expect(BigInt(firstAfterMigration.rows[0]!.id)).toBeGreaterThan(oldHighWater);

      const lastBeforeRepeat = await legacyPool.query<{ last_value: string }>(
        "SELECT last_value::text AS last_value FROM account_report_events_ordered_id_seq"
      );
      await legacyPool.query(REPORT_EVENT_PUBLICATION_SCHEMA_SQL);
      const lastAfterRepeat = await legacyPool.query<{ last_value: string }>(
        "SELECT last_value::text AS last_value FROM account_report_events_ordered_id_seq"
      );
      expect(lastAfterRepeat.rows[0]?.last_value).toBe(lastBeforeRepeat.rows[0]?.last_value);

      const nextAfterRepeat = await staleConnection.query<{ id: string }>(
        `INSERT INTO account_report_events (account_id, report_id, event_type, lifecycle_attempt)
         VALUES ($1, $2, 'after_repeat_migration', 1) RETURNING id::text AS id`,
        [accountId, reportId]
      );
      expect(BigInt(nextAfterRepeat.rows[0]!.id)).toBeGreaterThan(BigInt(firstAfterMigration.rows[0]!.id));
      const recoveredCursor = await new ReportRepository(legacyPool).listEvents(
        accountId,
        committedFirst.rows[0]!.id,
        25
      );
      expect(recoveredCursor.items.map((event) => event.type)).toEqual([
        "after_migration",
        "after_repeat_migration"
      ]);
    } finally {
      if (holderTransactionOpen) await holder.query("ROLLBACK");
      if (staleTransactionOpen) await staleConnection.query("ROLLBACK");
      holder.release();
      staleConnection.release();
    }
  }, 10_000);
});
