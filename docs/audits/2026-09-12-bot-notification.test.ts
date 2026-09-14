import assert from 'node:assert/strict';
import { AccountNotificationWorker } from '../../apps/bot/src/account-notifier.ts';
import { AccountBotDatabase } from '../../apps/bot/src/account-database.ts';
import { DigestWorker } from '../../apps/bot/src/digest-worker.ts';
import { encryptJson } from '../../apps/bot/src/crypto.ts';
import { DsaApi, DsaApiError } from '@nreport/contracts';

import { it } from 'vitest';
it('reproduces notification failure paths offline', async () => {
const report:any = { reportId:'synthetic-report',accountId:'synthetic-account',flow:'message',useAi:true,status:'failed',creditState:'consumed',lifecycleAttempt:1,country:'DE',category:null,description:null,discordReportId:null,discordStatus:null,reviewStatus:null,predecessorReportId:null,successorReportId:null,retryableModes:['regenerate'],createdAt:'2026-09-09T00:00:00Z',updatedAt:'2026-09-09T00:01:00Z',target:{messageUrl:'https://example.test/synthetic'},finalText:null,legalReference:null,researchSummary:null,sources:[],timeline:[],failure:{stage:'writing',code:'preparation_timeout',message:'Synthetic failure'}};
const connection:any={discord_user_id:'synthetic-user',account_id:'synthetic-account',encrypted_api_key:'unused',event_cursor:'0'};
const quiet=()=>{};
const prefs={decisionEnabled:true,reportDeniedEnabled:false,problemEnabled:true};
function worker(db:any, client:any, api:any){return new AccountNotificationWorker(db,client,{} as any,()=>api,undefined,quiet)}

// Real notifier + real claimDmCard SQL; pool implements only its tested null-mapping predicate.
{
 let retries=0,sends=0,completed=0; const mapping='persisted-deleted-card';
 const sqlDb=new AccountBotDatabase({query:async(sql:string)=>{assert.match(sql,/AND dm_message_id IS NULL/);return {rowCount:mapping===null?1:0,rows:[]}}} as any);
 const db:any={claimNotification:async()=>({event_id:'1',event_type:'report_failed',report_id:report.reportId,trace_id:null,attempts:1,discord_user_id:'synthetic-user',encrypted_target_context:null,dm_message_id:mapping,visible_payload_hash:null}),notificationPreferences:async()=>prefs,claimDmCard:sqlDb.claimDmCard.bind(sqlDb),retryNotification:async()=>{retries++},completeNotification:async()=>{completed++}};
 const dm={messages:{fetch:async()=>{throw Object.assign(new Error('synthetic deleted'),{code:10008})}},send:async()=>{sends++}};
 const w=worker(db,{users:{fetch:async()=>({createDM:async()=>dm})}},{report:async()=>report});
 await w.processOne();await w.processOne();assert.equal(retries,2);assert.equal(sends,0);assert.equal(completed,0);
 console.log('PASS: deleted mapped card stays in retry without replacement');
}
// An accepted card creation whose response is lost uses a stable enforced nonce.
{
 let sends=0,retries=0;const payloads:any[]=[];
 const db:any={claimNotification:async()=>({event_id:'1',event_type:'report_failed',report_id:report.reportId,trace_id:null,attempts:1,discord_user_id:'synthetic-user',encrypted_target_context:null,dm_message_id:null,visible_payload_hash:null}),notificationPreferences:async()=>prefs,claimDmCard:async()=>true,releaseDmCard:async()=>{},retryNotification:async()=>{retries++},setDmMapping:async()=>{},completeCardUpdate:async()=>{},completeNotification:async()=>{}};
 const dm={send:async(p:any)=>{payloads.push(p);sends++;if(sends===1)throw new Error('synthetic lost response');return {channelId:'synthetic',id:'synthetic',reply:async()=>{}}}};
 const w=worker(db,{users:{fetch:async()=>({createDM:async()=>dm})}},{report:async()=>report});await w.processOne();await w.processOne();assert.equal(sends,2);assert.equal(retries,1);assert(payloads.every(p=>typeof p.nonce==='string'&&p.enforceNonce===true));
 console.log('PASS: lost card-send response uses a stable enforced nonce');
}
// Real replacement method, fake SQL store following the explicit UPDATE/repair predicates.
{
 const old:any={report_id:'synthetic-old',dm_message_id:'synthetic-card',dm_channel_id:'synthetic-channel'};
 const replacement:any={report_id:null,dm_message_id:null,dm_channel_id:null};
 const query=async(sql:string,v:any[]=[])=>{
  if(sql.startsWith('SELECT dm_channel_id'))return {rows:[{...old}],rowCount:1};
  if(sql.includes('report_id = $2, encrypted_request')){replacement.report_id=v[1];replacement.dm_channel_id=v[2];replacement.dm_message_id=v[3];}
  if(sql.startsWith('UPDATE bot_report_links SET dm_channel_id = NULL')){old.dm_channel_id=null;old.dm_message_id=null;}
  if(sql.includes('WITH due AS')){assert.match(sql,/report_id IS NOT NULL[\s\S]*dm_message_id IS NULL/);return {rows:[old,replacement].filter(x=>x.report_id!==null&&x.dm_message_id===null),rowCount:1};}
  return {rows:[],rowCount:1};
 };
 const db=new AccountBotDatabase({query,connect:async()=>({query,release:quiet})} as any);
 await db.completeReplacementLink('synthetic-link','synthetic-new','synthetic-old');
 const due=await db.dueCardRepairs('synthetic-user');assert.equal(due.length,1);assert.equal(due[0].report_id,old.report_id);
 console.log('PASS: predecessor becomes repair-eligible immediately after card transfer (SQL predicate simulation)');
}
// Account-level pending-link gate blocks an unrelated external report and the later feed items.
{
 let ingests=0,advanced=0;
 const query=async(sql:string)=>{if(sql.includes('FROM api_connections'))return {rows:[{discord_user_id:'synthetic-user'}]};if(sql.includes('AND report_id = $2'))return {rows:[]};if(sql.includes('report_id IS NULL'))return {rows:[{id:'synthetic-unrelated-pending'}]};return {rows:[]}};
 const sqlDb=new AccountBotDatabase({connect:async()=>({query,release:quiet})} as any);
 const db:any={cleanupExpiredForms:async()=>{},pendingReportLinks:async()=>[],ingestEvent:async(e:any)=>{ingests++;return sqlDb.ingestEvent(e)},advanceCursor:async()=>{advanced++}};
 const event={eventId:'1',accountId:'synthetic-account',reportId:'synthetic-external',traceId:'synthetic',type:'report_queued',occurredAt:'2026-09-09T00:00:00Z',lifecycleAttempt:1};
 const w=worker(db,{}, {events:async()=>({items:[event,{...event,eventId:'2'}],next:null})});await w.reconcileConnection(connection);assert.equal(ingests,2);assert.equal(advanced,2);
 console.log('PASS: reconciliation continues after an unrelated pending create');
}
// Recovery isolates a pending-operation authorization failure per account.
{
 let visited=0;
 const db:any={connections:async()=>[connection,{...connection,discord_user_id:'synthetic-second'}],cleanupExpiredForms:async()=>{},pendingReportLinks:async()=>{visited++;return [{encrypted_request:'unused',idempotency_key:'synthetic'}]}};
 const w=new AccountNotificationWorker(db,{} as any,{} as any,()=>({createReport:async()=>{throw new DsaApiError(401,'unauthorized','synthetic')}} as any),()=>({flow:'message'}) as any,quiet);
 await w.recoverOnce();assert.equal(visited,2);
 console.log('PASS: first-account authorization failure does not abort later account recovery');
}
// Fully mocked provider method, synthetic encrypted configuration. No network access.
{
 const key=Buffer.alloc(32,1);const conn={...connection,encrypted_api_key:encryptJson('synthetic',key)};
 const claims:any[]=[];let failed=0;
 const db:any={notificationPreferences:async()=>({weeklyDigest:true,dailyDigest:false}),claimDigest:async(...args:any[])=>{claims.push(args);return true},completeDigest:async(...args:any[])=>{if(args[3]==='failed')failed++}};
 const original=DsaApi.prototype.digestActivity;
 DsaApi.prototype.digestActivity=async()=>{throw new Error('synthetic unavailable')};
 try{const w=new DigestWorker(db,{} as any,{dataEncryptionKey:key,apiBaseUrl:'https://example.test'} as any);await w.processConnection(conn,new Date('2026-09-07T23:30:00Z'));await w.processConnection(conn,new Date('2026-09-08T01:30:00Z'));assert.equal(failed,1);assert.equal(claims.length,1);console.log('PASS: failed late-Monday weekly digest is never reclaimed on Tuesday');}finally{DsaApi.prototype.digestActivity=original}
}
console.log('6 failure-path simulations passed; all data synthetic, all remote calls mocked.');

});
