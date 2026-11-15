import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueue,enqueue} from './retention.mjs';
import {BridgeModel} from './bridge-model-live.mjs';
import {retainedContextReservations,CONTEXT_NOTICE_SUFFIX} from './context-budget.mjs';
import {enqueueSync,claimSync,finishSync,listSync,recoverSync} from './sync-outbox.mjs';
import {replyOnce} from './transport-live.mjs';
import {MediaTransfers} from './media-transfer.mjs';
import {createHash} from 'node:crypto';

const owner='synthetic-owner',now=1700000000000;
function add(q,id,time,token){enqueue(q,owner,{eventId:id,name:'weixin.owner_text',timestamp:new Date(time).toISOString(),data:{conversation_id:'weixin-self',message_id:id,simulation:false,text:'synthetic'}},{to_user_id:'synthetic-recipient',accountScope:'synthetic-scope',context_token:token,source_message_id:id},time)}
async function make(){const q=createQueue(owner);add(q,'e1',now,'synthetic-context');let saved={version:1,owner,phase:'armed',sessionToken:'synthetic-token',queue:q,delivery:{}};const store={save:async s=>{saved=structuredClone(s)},load:async()=>structuredClone(saved)};const bridge=new BridgeModel({owner,store});await bridge.load();return {bridge,store,saved:()=>structuredClone(saved)}}
const draft=(b,eventId,i,at=now+1)=>b.replyDraft(owner,eventId,`synthetic-text-${i}`,`key-${i}`,at,()=>at);
const media=(b,eventId,i,at=now+1)=>b.mediaReplyDraft(owner,{eventId,idempotencyKey:`media-${i}`,kind:'file',fileName:'synthetic.txt',sha256:i.toString(16).padStart(64,'0')},()=>at);

test('concurrent direct replies reserve at most nine, and the ninth has the exact warning',async()=>{
 const {bridge}=await make();const results=await Promise.allSettled(Array.from({length:15},(_,i)=>draft(bridge,'e1',i)));
 const accepted=results.filter(x=>x.status==='fulfilled');assert.equal(accepted.length,9);
 assert.equal(accepted.filter(x=>x.value.text.endsWith(CONTEXT_NOTICE_SUFFIX)).length,1);
 assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.code==='context_budget_exhausted').length,6);
 assert.deepEqual(retainedContextReservations(bridge.state.queue,'e1',now+2),{count:9,limit:9,coverage:'incomplete'});
});
test('text and media share the budget and an existing unknown is never retried',async()=>{
 const {bridge}=await make();for(let i=0;i<7;i++)await draft(bridge,'e1',i);await media(bridge,'e1',1);
 await assert.rejects(media(bridge,'e1',2),e=>e.code==='context_notice_requires_text');
 assert.ok((await draft(bridge,'e1',9)).text.endsWith(CONTEXT_NOTICE_SUFFIX));
 await assert.rejects(draft(bridge,'e1',10),e=>e.code==='context_budget_exhausted');
 await assert.rejects(media(bridge,'e1',3),e=>e.code==='context_budget_exhausted');
 assert.equal((await draft(bridge,'e1',0)).state,'uncertain');
 assert.equal((await draft(bridge,'e1',9)).state,'uncertain');
});
test('concurrent text and media cannot consume more than nine combined slots',async()=>{
 const {bridge}=await make();const calls=[];for(let i=0;i<12;i++){calls.push(draft(bridge,'e1',i));calls.push(media(bridge,'e1',i+100));}
 const results=await Promise.allSettled(calls),successes=results.filter(x=>x.status==='fulfilled');
 assert.equal(successes.length,9);assert.equal(successes.filter(x=>typeof x.value.text==='string'&&x.value.text.endsWith(CONTEXT_NOTICE_SUFFIX)).length,1);
 assert.equal(retainedContextReservations(bridge.state.queue,'e1',now+2).count,9);
 assert.ok(results.some(x=>x.status==='rejected'&&['context_notice_requires_text','context_budget_exhausted'].includes(x.reason.code)));
});
test('same context across new events does not reset, a different verified context does',async()=>{
 const {bridge}=await make();for(let i=0;i<9;i++)await draft(bridge,'e1',i);
 add(bridge.state.queue,'e2',now+5,'synthetic-context');await assert.rejects(draft(bridge,'e2',20,now+6),e=>e.code==='context_budget_exhausted');
 add(bridge.state.queue,'e3',now+7,'synthetic-new-context');assert.ok((await draft(bridge,'e3',21,now+8)).clientId);
});
test('budget survives restart while the original records remain within retention',async()=>{
 const {bridge,store}=await make();for(let i=0;i<9;i++)await draft(bridge,'e1',i);
 const next=new BridgeModel({owner,store});await next.load();await assert.rejects(draft(next,'e1',30),e=>e.code==='context_budget_exhausted');
});
test('queue preserves a blocked unattempted part and unknown head remains blocking',()=>{
 const q=createQueue(owner);add(q,'e1',now,'synthetic-context');const s={queue:q,delivery:{}};
 const a=enqueueSync(s,{sourceId:'source-one',role:'user',text:'synthetic',eventId:'e1'},now+1);s.syncOutbox.deliveryPaused=false;const claim=claimSync(s,now+2);
 assert.equal(finishSync(s,claim,'wait_context_budget',now+3),true);
 assert.equal(s.syncOutbox.records[a.syncId].state,'queued');assert.equal(listSync(s,{},now+3).entries[0].blockedReason,'waiting_new_owner_context');
 const again=claimSync(s,now+4);assert.equal(again.syncId,a.syncId);finishSync(s,again,'uncertain',now+5);
 enqueueSync(s,{sourceId:'source-two',role:'user',text:'new',eventId:'e1'},now+6);assert.equal(claimSync(s,now+7),null);assert.equal(s.syncOutbox.records[a.syncId].state,'uncertain');
});
test('each multipart reservation consumes budget without changing a prior part',async()=>{
 const {bridge}=await make();for(let i=0;i<7;i++)await draft(bridge,'e1',i);
 const item=await bridge.enqueueSync(owner,{sourceId:'multipart',role:'assistant',text:'x'.repeat(4000),eventId:'e1'},()=>now+2);bridge.state.syncOutbox.deliveryPaused=false;
 const first=await bridge.claimSync(owner,()=>now+3);await bridge.replyDraft(owner,first.eventId,first.text,first.idempotencyKey,now+3,()=>now+3,{syncPartId:first.syncPartId});await bridge.replySent(owner,first.eventId,first.idempotencyKey,now+4);await bridge.finishSync(owner,first,'sent',()=>now+4);
 const second=await bridge.claimSync(owner,()=>now+5);const warning=await bridge.replyDraft(owner,second.eventId,second.text,second.idempotencyKey,now+5,()=>now+5,{syncPartId:second.syncPartId});assert.ok(warning.text.endsWith(CONTEXT_NOTICE_SUFFIX));await bridge.replySent(owner,second.eventId,second.idempotencyKey,now+6);
 const beforeRestart=structuredClone(bridge.state);recoverSync(beforeRestart);assert.equal(beforeRestart.syncOutbox.records[item.syncId].parts[1].state,'sent');
 await bridge.finishSync(owner,second,'sent',()=>now+6);const third=await bridge.claimSync(owner,()=>now+7);await assert.rejects(bridge.replyDraft(owner,third.eventId,third.text,third.idempotencyKey,now+7,()=>now+7,{syncPartId:third.syncPartId}),e=>e.code==='context_budget_exhausted');await bridge.finishSync(owner,third,'wait_context_budget',()=>now+7);
 const record=bridge.state.syncOutbox.records[item.syncId];assert.deepEqual(record.parts.map(p=>p.state),['sent','sent','queued']);
});
test('overlong ninth text is held before network with no ninth reservation',async()=>{
 const {bridge}=await make();for(let i=0;i<8;i++)await draft(bridge,'e1',i);
 await assert.rejects(bridge.replyDraft(owner,'e1','x'.repeat(2000),'long',now+2,()=>now+2),e=>e.code==='context_notice_no_space');
 assert.equal(retainedContextReservations(bridge.state.queue,'e1',now+2).count,8);
});
test('actual mocked send transmits the exact warning once and makes no tenth request',async()=>{
 assert.equal(CONTEXT_NOTICE_SUFFIX,'\n已达到最大上限，需要我给你发消息才能继续给我发');
 const {bridge}=await make();for(let i=0;i<8;i++)await draft(bridge,'e1',i);let calls=0;
 const transport=async(_url,options)=>{calls++;assert.equal(JSON.parse(options.body).msg.item_list[0].text_item.text,'(9/9) synthetic final'+CONTEXT_NOTICE_SUFFIX);return new Response('{"ret":0}',{status:200})};
 const args={bridge,actor:owner,eventId:'e1',text:'synthetic final',idempotencyKey:'final-key',now:now+2,clock:()=>now+2,transport};
 assert.equal((await replyOnce(args)).state,'sent');assert.equal((await replyOnce(args)).state,'sent');await assert.rejects(replyOnce({...args,text:'later',idempotencyKey:'later-key'}),e=>e.code==='context_budget_exhausted');assert.equal(calls,1);
});
test('a ninth media attempt is retained as not sent when a text warning is required',async()=>{
 let uploads=0;const bytes=Buffer.from('synthetic'),sha=createHash('sha256').update(bytes).digest('hex');
 const m=new MediaTransfers({owner,clock:()=>now,readIncoming:async()=>{},checkTarget:async()=>({expiresAt:now+60000}),sendMedia:async()=>{uploads++;throw Object.assign(new Error('blocked before upload'),{code:'context_notice_requires_text'})}});
 try{const u=await m.begin(owner,{eventId:'e1',idempotencyKey:'key',kind:'file',fileName:'synthetic.txt',size:bytes.length,sha256:sha});m.append(owner,{uploadId:u.uploadId,offset:0,dataBase64:bytes.toString('base64')});await m.finish(owner,{uploadId:u.uploadId});const r=await m.send(owner,{uploadId:u.uploadId});assert.deepEqual(r,{state:'not_sent',reason:'waiting_new_owner_context',pre_execution:true,mediaAttemptStarted:false,expiresAt:now+60000});assert.equal(uploads,1);}finally{m.close()}
});
