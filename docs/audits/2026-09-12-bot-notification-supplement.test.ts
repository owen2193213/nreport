import assert from 'node:assert/strict';
import { it } from 'vitest';
import { AccountNotificationWorker } from '../../apps/bot/src/account-notifier.ts';
import { classifyReportView } from '../../apps/bot/src/report-ui.ts';

it.each(['request_failed','request_ambiguous'])('delivers one terminal reply and completes the appeal failure event: %s',async(reviewStatus)=>{
 let replies=0,completions=0;
 const report:any={reportId:'synthetic',flow:'message',status:'submitted',creditState:'consumed',reviewStatus,discordStatus:'closed_no_action',finalText:null,retryableModes:[],timeline:[],target:{messageUrl:'https://example.test'},country:'DE',useAi:false,createdAt:'2026-09-09T00:00:00Z',updatedAt:'2026-09-09T00:00:00Z'};
 const message={edit:async()=>{},reply:async()=>{replies++}};
 const db:any={claimNotification:async()=>({event_id:'1',event_type:`review_${reviewStatus}`,report_id:'synthetic',trace_id:null,attempts:1,discord_user_id:'synthetic',encrypted_target_context:null,dm_message_id:'synthetic',visible_payload_hash:null}),notificationPreferences:async()=>({problemEnabled:true,decisionEnabled:true,reportDeniedEnabled:true}),completeCardUpdate:async()=>{},completeNotification:async()=>{completions++},retryNotification:async()=>{throw new Error('Unexpected retry')}};
 const client:any={users:{fetch:async()=>({createDM:async()=>({messages:{fetch:async()=>message}})})}};
 const w=new AccountNotificationWorker(db,client,{} as any,()=>({report:async()=>report}) as any,undefined,()=>{});
 await w.processOne();assert.equal(classifyReportView(report).key,'appeal_failed');assert.equal(classifyReportView(report).terminal,true);assert.equal(replies,1);assert.equal(completions,1);
});
it('continues fast recovery for a valid later account when an earlier credential is corrupt',async()=>{
 const connections=[
  {account_id:'account-1',discord_user_id:'user-1',encrypted_api_key:'malformed'},
  {account_id:'account-2',discord_user_id:'user-2',encrypted_api_key:'valid'}
 ];
 let cleanupVisits=0;
 const pendingUsers:string[]=[];
 const db:any={
  connections:async()=>connections,
  cleanupExpiredForms:async()=>{cleanupVisits++},
  pendingReportLinks:async(userId:string)=>{pendingUsers.push(userId);return[]}
 };
 const apiFactory=(connection:{encrypted_api_key:string})=>{
  if(connection.encrypted_api_key==='malformed')throw new Error('credential could not be decrypted');
  return {} as any;
 };
 const w=new AccountNotificationWorker(db,{} as any,{dataEncryptionKey:Buffer.alloc(32),apiBaseUrl:'https://example.test'} as any,apiFactory as any,undefined,()=>{});
 await w.recoverOnce();
 assert.deepEqual(pendingUsers,['user-2']);
 assert.equal(cleanupVisits,1);
});

