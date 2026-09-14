// Run from repository root with Node 24 and installed workspace dependencies:
// node docs/audits/2026-09-12-api-email.simulation.mjs
// Reproduces CURRENT behavior, not desired-behavior regression tests.
// Calls real repository methods with a deliberately narrow, in-memory query adapter.
// Does NOT execute PostgreSQL, model MVCC/locks, or prove transaction semantics.
// The first scenario pauses after an empty lookup, completes markSubmitted, then
// resumes the email insert. This schedules the interleaving under examination.
// All identifiers and payloads are synthetic; no network or database is accessed.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

registerHooks({
  load(url, context, next) {
    if (!url.endsWith('.ts')) return next(url, context);
    return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
      }).outputText };
  }
});
const { ReportRepository } = await import('../../apps/api/src/report-repository.ts');
const ok = (rows = []) => ({ rows, rowCount: rows.length });
const report = { id: 'synthetic-report', account_id: 'synthetic-account', lifecycle_attempt: 1,
  reporter_email: 'synthetic@example.test', discord_report_id: null,
  discord_status: null, review_status: null, error_code: null };
let messages = [], reviewJobs = 0, eventCount = 0;
let pauseLookup = false, lookupSeen, continueLookup;
const seen = new Promise(resolve => { lookupSeen = resolve; });
const gate = new Promise(resolve => { continueLookup = resolve; });

async function query(sql, values = []) {
  if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return ok();
  if (sql.includes('SELECT 1 FROM account_report_jobs')) return ok([{}]);
  if (sql.includes('SELECT * FROM account_reports') && sql.includes('discord_report_id = $1')) {
    const rows = report.discord_report_id === values[0] && report.reporter_email === values[1]
      ? [{ ...report }] : [];
    if (pauseLookup) { pauseLookup = false; lookupSeen(); await gate; }
    return ok(rows);
  }
  if (sql.includes('INSERT INTO account_inbound_messages')) {
    if (messages.some(message => message.message_id === values[0])) return ok();
    messages.push({ message_id: values[0], report_id: values[1], recipient: values[2],
      status: values[3], external_report_id: values[4], external_status: values[5],
      encrypted_payload: values[6] ?? null });
    return ok([{}]);
  }
  if (sql.includes("SET status = 'submitted', discord_report_id")) {
    report.discord_report_id = values[1];
    return ok([{ ...report }]);
  }
  if (sql.includes('FROM account_inbound_messages') && sql.includes("status = 'pending_report'")) {
    // Assert the precise missing predicate before simulating its effect.
    assert.doesNotMatch(sql, /recipient/);
    return ok(messages.filter(message => message.external_report_id === values[0]
      && message.status === 'pending_report'));
  }
  if (sql.includes('SET discord_status = $2')) { report.discord_status = values[1]; return ok([{}]); }
  if (sql.includes("SET review_status = 'queued'")) {
    if (report.review_status !== null) return ok();
    report.review_status = 'queued'; return ok([{}]);
  }
  if (sql.includes('INSERT INTO account_report_jobs') && sql.includes("'submit_review'")) {
    reviewJobs++; return ok([{}]);
  }
  if (sql.includes('UPDATE account_inbound_messages')) {
    const message = messages.find(message => message.message_id === values[0]);
    message.status = 'accepted'; message.report_id = values[1]; return ok([{}]);
  }
  if (sql.includes('INSERT INTO account_report_events')) return ok([{ id: String(++eventCount) }]);
  if (sql.includes('INSERT INTO event_destination_deliveries')) return ok();
  if (sql.includes("UPDATE account_report_jobs SET state = 'completed'")) return ok([{}]);
  throw new Error('Query adapter needs updating for an unhandled repository statement.');
}
const repo = new ReportRepository({ connect: async () => ({ query, release() {} }) });
const job = { id: 'synthetic-job', report_id: report.id, execution_token: 1 };
const email = { messageId: 'synthetic-message', recipient: report.reporter_email,
  discordReportId: 'synthetic-external', discordStatus: 'received' };

pauseLookup = true;
const inbound = repo.registerReportUpdateEmail(email);
await seen;
await repo.markSubmitted(job, email.discordReportId);
continueLookup();
assert.equal((await inbound).status, 'pending_report');
assert.equal(messages[0].status, 'pending_report');
assert.equal(report.discord_status, null);
assert.equal((await repo.registerReportUpdateEmail(email)).status, 'duplicate');
assert.equal(report.discord_status, null);
assert.equal(messages[0].status, 'pending_report');
console.log('PASS: interleaved receipt stays pending; duplicate delivery does not reconcile it');

report.discord_status = 'actioned'; report.review_status = null;
await repo.registerReportUpdateEmail({ ...email, messageId: 'synthetic-late-message',
  discordStatus: 'closed_no_action', encryptedReviewUrl: 'synthetic-placeholder' });
assert.equal(report.discord_status, 'actioned');
assert.equal(report.review_status, 'queued');
assert.equal(reviewJobs, 1);
console.log('PASS: delayed closure queues an appeal after an actioned decision');

report.discord_report_id = null; report.discord_status = null; report.review_status = null;
messages = [{ message_id: 'synthetic-other', recipient: 'other@example.test',
  external_report_id: email.discordReportId, external_status: 'received',
  status: 'pending_report', encrypted_payload: null }];
await repo.markSubmitted(job, email.discordReportId);
assert.equal(messages[0].status, 'accepted');
assert.equal(messages[0].report_id, report.id);
assert.equal(report.discord_status, 'received');
console.log('PASS: replay applies pending mail with a different recipient');

// Additional query-shape check, not a simulated deadline/recovery SQL execution.
const recoveryQueries = [];
const recoveryRepo = new ReportRepository({ connect: async () => ({
  async query(sql) { recoveryQueries.push(sql); return ok(); }, release() {}
}) });
await recoveryRepo.recoverInterruptedJobs();
await recoveryRepo.expireDeadlines();
assert.ok(recoveryQueries.length > 4);
assert.ok(recoveryQueries.every(sql => !sql.includes('account_inbound_messages')));
console.log('PASS: recovery/deadline queries never consult the inbound-mail table');

// Fault injection: model a successful preparation COMMIT whose acknowledgement
// is lost. This does not reproduce a pg socket failure; the durable-success state
// and rejection are injected at the store boundary. The REAL worker catch path
// and REAL failPreparation method then run. No six-minute reclaim is required.
const { PreparationWorker } = await import('../../apps/api/src/preparation-worker.ts');
const durable = { status: 'queued', credit_state: 'reserved', preparationJob: 'running' };
let released = false;
const failureRepo = new ReportRepository({ connect: async () => ({
  release() {},
  async query(sql) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return ok();
    if (sql.includes('chain.state AS credit_state') && sql.includes('FOR UPDATE OF report, chain, account')) {
      return ok([{ account_id: 'synthetic-account', credit_chain_id: 'synthetic-chain',
        status: durable.status, credit_state: durable.credit_state, lifecycle_attempt: 1 }]);
    }
    if (sql.includes('available_credits = available_credits + 1')) { released = true; return ok([{}]); }
    if (sql.includes("SET state = 'released'")) { durable.credit_state = 'released'; return ok([{}]); }
    if (sql.includes('INSERT INTO credit_ledger')) return ok([{}]);
    if (sql.includes("SET status = 'failed', failure_stage = status")) {
      // No submission boundary was crossed in the injected committed state.
      durable.status = 'failed'; return ok([{}]);
    }
    if (sql.includes("UPDATE account_report_jobs SET state = 'failed'")) {
      durable.preparationJob = 'failed'; return ok([{}]);
    }
    if (sql.includes('INSERT INTO account_report_events')) return ok([{ id: 'synthetic-event' }]);
    if (sql.includes('INSERT INTO event_destination_deliveries')) return ok();
    throw new Error('Unhandled fault-injection query.');
  }
}) });
const preparation = new PreparationWorker({
  async claimPreparation() { return { jobId: 'synthetic-job', report: {
    id: 'synthetic-report', trace_id: 'synthetic-trace', retry_mode: null,
    request_input: { useAi: false, country: 'DE', category: 'synthetic-category', finalText: 'Synthetic text.' }
  } }; },
  async completePreparation() {
    durable.status = 'requesting_verification';
    durable.preparationJob = 'completed';
    throw new Error('Synthetic lost COMMIT acknowledgement after durable success.');
  },
  failPreparation: failureRepo.failPreparation.bind(failureRepo)
}, {}, () => ({}));
await preparation.processOne();
assert.equal(released, true);
assert.equal(durable.credit_state, 'released');
assert.equal(durable.status, 'failed');
assert.equal(durable.preparationJob, 'failed');
console.log('PASS: injected lost commit acknowledgement makes worker undo a completed preparation');
