import assert from 'node:assert/strict';
import { it } from 'vitest';
import { AccountNotificationWorker } from '../../apps/bot/src/account-notifier.ts';
import { classifyReportView } from '../../apps/bot/src/report-ui.ts';

it.each(['request_failed','request_ambiguous'])('completes appeal failure event without delivering a problem reply: %s',async(reviewStatus)=>{
 let replies=0,completions=0;
 const report:any={reportId:'synthetic',flow:'message',status:'submitted',creditState:'consumed',reviewStatus,discordStatus:'closed_no_action',finalText:null,retryableModes:[],timeline:[],target:{messageUrl:'https://example.test'},country:'DE',useAi:false,createdAt:'2026-09-09T00:00:00Z',updatedAt:'2026-09-09T00:00:00Z'};
 const message={edit:async()=>{},reply:async()=>{replies++}};
 const db:any={claimNotification:async()=>({event_id:'1',event_type:`review_${reviewStatus}`,report_id:'synthetic',trace_id:null,attempts:1,discord_user_id:'synthetic',encrypted_target_context:null,dm_message_id:'synthetic',visible_payload_hash:null}),notificationPreferences:async()=>({problemEnabled:true,decisionEnabled:true,reportDeniedEnabled:true}),completeCardUpdate:async()=>{},completeNotification:async()=>{completions++},retryNotification:async()=>{throw new Error('Unexpected retry')}};
 const client:any={users:{fetch:async()=>({createDM:async()=>({messages:{fetch:async()=>message}})})}};
 const w=new AccountNotificationWorker(db,client,{} as any,()=>({report:async()=>report}) as any,undefined,()=>{});
 await w.processOne();assert.equal(classifyReportView(report).key,'appeal_failed');assert.equal(classifyReportView(report).terminal,true);assert.equal(replies,1);assert.equal(completions,1);
});
it('a corrupt first account credential prevents all later fast-recovery work',async()=>{
 let visits=0;
 const db:any={connections:async()=>[{encrypted_api_key:'malformed'},{encrypted_api_key:'unused'}],cleanupExpiredForms:async()=>{visits++}};
 const w=new AccountNotificationWorker(db,{} as any,{dataEncryptionKey:Buffer.alloc(32),apiBaseUrl:'https://example.test'} as any,undefined,undefined,()=>{});
 await w.recoverOnce();await w.recoverOnce();assert.equal(visits,0);
});

