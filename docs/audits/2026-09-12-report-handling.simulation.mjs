// Audit reproductions of current behavior, not regression tests of desired behavior.
// Run from the repository root (Node 24): node docs/audits/2026-09-12-report-handling.simulation.mjs
// All credentials/evidence are synthetic. HTTP is mocked except for a loopback-only transport test.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { DiscordDsaHttpError } from '@discord-dsa/client';

// In-process source loader avoids tsx's os.userInfo dependency in restricted Windows shells.
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) return next(specifier.slice(0, -3) + '.ts', context);
      throw error;
    }
  },
  load(url, context, next) {
    if (!url.endsWith('.ts')) return next(url, context);
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
    }).outputText };
  }
});
const { AccountInteractionHandler } = await import('../../apps/bot/src/account-interactions.ts');
const { encryptJson } = await import('../../apps/bot/src/crypto.ts');
const { OperationsAlertWorker } = await import('../../apps/api/src/operations-alert-worker.ts');
const { evaluateOperationalAlerts } = await import('../../apps/api/src/operational-alerts.ts');
const { AiClient } = await import('../../apps/api/src/preparation/ai-client.ts');
const { LifecycleRunner } = await import('../../apps/api/src/lifecycle-runner-v2.ts');
const { UndiciJsonTransport } = await import('../../packages/discord-dsa-client/src/transport.ts');
const { DiscordDsaNetworkError } = await import('../../packages/discord-dsa-client/src/errors.ts');

const results = [];
const empty = { readyPending: 0, delayedPending: 0, running: 0, oldestReadyAgeMs: null };
const alerts = evaluateOperationalAlerts({ nowMs: 1000000,
  queues: { preparation: { ...empty, readyPending: 1, oldestReadyAgeMs: 100 }, lifecycle: empty },
  workers: [{ component: 'preparation', lastHeartbeatAgeMs: 0, lastProgressAgeMs: 600000 }]
});
assert.equal(alerts[0].key, 'queue.preparation.no_progress');
results.push({ scenario: 'fresh job after idle', jobAgeMs: 100, falseAlert: true });

// SQLite enforces the same simple UNIQUE triple as the PostgreSQL outbox schema.
// This does not stand in for PostgreSQL transaction/locking integration testing.
const db = new DatabaseSync(':memory:');
db.exec("CREATE TABLE outbox(id INTEGER PRIMARY KEY, alert_key TEXT, kind TEXT, state TEXT, UNIQUE(alert_key,kind,state)); INSERT INTO outbox VALUES(1,'queue.preparation.no_progress','open','sent'),(2,'queue.preparation.no_progress','open','pending');");
let webhookPosts = 0;
const retries = [];
const operations = new OperationsAlertWorker({
  claimOperationsAlert: async () => {
    db.exec("UPDATE outbox SET state='sending' WHERE id=2");
    return { id: '2', payload: { alertKey: 'queue.preparation.no_progress' }, attempts: 10 };
  },
  completeOperationsAlert: async () => { db.exec("UPDATE outbox SET state='sent' WHERE id=2"); },
  retryOperationsAlert: async (_id, seconds, category) => {
    db.exec("UPDATE outbox SET state='pending' WHERE id=2"); retries.push({ seconds, category });
  }
}, 'https://example.invalid', { preparation: 2, lifecycle: 2, delivery: 1 }, async () => {
  webhookPosts++; return new Response(null, { status: 204 });
});
await operations.deliverOne();
await operations.deliverOne();
assert.equal(webhookPosts, 2);
assert.deepEqual(retries, [{ seconds: 300, category: 'network' }, { seconds: 300, category: 'network' }]);
db.close();
results.push({ scenario: 'successful alert followed by unique conflict', webhookPosts, retries });

const originalFetch = globalThis.fetch;
const key = Buffer.alloc(32, 1);
const input = { flow: 'message', useAi: false, country: 'DE', category: 'sub_other_hate_speech', finalText: 'Synthetic test.', target: { messageUrl: 'https://discord.com/channels/@me/123456789012345678/123456789012345679' } };
for (const scenario of ['invalid-202', 'lost-response']) {
  let retained = false;
  let reply;
  globalThis.fetch = async () => {
    if (scenario === 'invalid-202') return new Response('{', { status: 202 });
    throw new TypeError('Synthetic connection lost after server commit');
  };
  const handler = new AccountInteractionHandler({ config: { apiBaseUrl: 'https://example.invalid', adminApiKey: 'synthetic', dataEncryptionKey: key }, database: {
    connection: async () => ({ account_id: 'synthetic-account', encrypted_api_key: encryptJson('synthetic-key', key) }),
    beginReportLink: async () => { retained = true; return 'synthetic-link'; },
    abandonReportLink: async () => { retained = false; }
  } });
  const interaction = { user: { id: 'synthetic-user' }, deferred: true, isRepliable: () => true, editReply: async value => { reply = value.content; } };
  try { await handler.submit(interaction, input, 'create:synthetic'); assert.fail('expected failure'); }
  catch (error) { await handler.error(interaction, error); }
  assert.equal(retained, scenario === 'lost-response');
  if (scenario === 'lost-response') assert.match(reply, /Please try again/);
  results.push({ scenario, recoveryRecordRetained: retained, userReply: reply });
}
globalThis.fetch = originalFetch;

// 429 with Retry-After:60 is retried immediately three times by the AI client.
let aiCalls = 0;
const aiStarted = Date.now();
const ai = new AiClient('synthetic-key', 'synthetic-model', { request: async () => {
  aiCalls++; return new Response('{}', { status: 429, headers: { 'retry-after': '60' } });
} });
await assert.rejects(ai.complete({}, Date.now() + 10000, { userId: 'synthetic', traceId: '33333333-3333-4333-8333-333333333333' }, 'plan'), error => error.kind === 'rate_limited');
assert.equal(aiCalls, 3);
assert.ok(Date.now() - aiStarted < 60000);
results.push({ scenario: 'AI rate limit', calls: aiCalls, elapsedMs: Date.now() - aiStarted, requestedWaitMs: 60000 });

// Discord lifecycle retry likewise disregards Retry-After even though transport preserves it.
let retryDelay;
const job = { id: 'synthetic', report_id: 'synthetic', kind: 'request_code', attempts: 1, max_attempts: 3, execution_token: 1, payload: {} };
const runner = new LifecycleRunner({
  claimLifecycleJob: async () => job,
  getLifecycleReport: async () => ({ flow: 'message', reporter_email: 'test@example.invalid' }),
  setStatus: async () => true,
  retryLifecycleJob: async (_job, _code, seconds) => { retryDelay = seconds; return true; }
}, {}, () => ({
  sendEmailCode: async () => { throw new DiscordDsaHttpError('synthetic', 429, { retryAfterSeconds: 60 }); },
  close: async () => {}
}));
await runner.processOne();
assert.equal(retryDelay, 10);
results.push({ scenario: 'Discord rate limit', requestedWaitSeconds: 60, scheduledWaitSeconds: retryDelay });

// A socket closing after headers bypasses the transport's network-error wrapper.
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
  res.flushHeaders(); res.write('{');
  setTimeout(() => res.destroy(), 30);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const transport = new UndiciJsonTransport({ baseUrl: `http://127.0.0.1:${server.address().port}/`, timeoutMs: 1000 });
let transportError;
try { await transport.requestJson({ method: 'GET', path: '/synthetic' }); }
catch (error) { transportError = error; }
finally { await transport.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
assert.ok(transportError);
assert.equal(transportError instanceof DiscordDsaNetworkError, false);
results.push({ scenario: 'connection lost during body', errorName: transportError.name, retryableNetworkClassification: false });

// Fastify injection executes actual hooks without binding a port or accessing a database.
const { buildV2Server } = await import('../../apps/api/src/server-v2.ts');
let serverCommitted = false;
const app = await buildV2Server({ environment: 'test', sessionEncryptionKey: key }, {
  healthcheck: async () => {}, accounts: { authenticate: async () => ({ accountId: '11111111-1111-4111-8111-111111111111', status: 'active' }),
    accountView: async () => { throw new Error('synthetic database unavailable'); }
  }, reports: {
    create: async () => { serverCommitted = true; return { created: true, report: {} }; },
    queueLength: async () => { throw new Error('synthetic queue snapshot unavailable after commit'); }
  }
});
try {
  const response = await app.inject({ method: 'GET', url: '/v1/discord/dsa/account', headers: { authorization: 'Bearer synthetic' } });
  assert.equal(response.statusCode, 429);
  results.push({ scenario: 'database failure on normal rate-limited route', actualStatus: response.statusCode, actualError: response.json().error.code, expectedStatus: 500 });
  let pendingRecord = false;
  let errorStatus;
  globalThis.fetch = async (url, init) => {
    const injected = await app.inject({ method: init.method, url: new URL(url).pathname, headers: init.headers, payload: init.body });
    return new Response(injected.body, { status: injected.statusCode });
  };
  const handler = new AccountInteractionHandler({ config: { apiBaseUrl: 'https://example.invalid', dataEncryptionKey: key }, database: {
    connection: async () => ({ account_id: 'synthetic', encrypted_api_key: encryptJson('synthetic', key) }),
    beginReportLink: async () => { pendingRecord = true; return 'synthetic'; },
    abandonReportLink: async () => { pendingRecord = false; }
  } });
  try { await handler.submit({ user: { id: 'synthetic' } }, input, 'create:synthetic-committed'); }
  catch (error) { errorStatus = error.status; }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(serverCommitted, true);
  assert.equal(errorStatus, 429);
  assert.equal(pendingRecord, false);
  results.push({ scenario: 'post-commit queue query fails', serverCommitted, errorStatus, recoveryRecordRetained: pendingRecord });
} finally { await app.close(); }

console.log(JSON.stringify({ externalRequests: 0, results }, null, 2));
