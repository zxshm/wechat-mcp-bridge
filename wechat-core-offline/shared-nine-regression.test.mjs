import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createQueue,enqueue} from './retention.mjs';
import {BridgeModel} from './bridge-model-live.mjs';
import {CONTEXT_NOTICE_SUFFIX,retainedContextReservations} from './context-budget.mjs';
import {enqueueSync,claimSync,finishSync,listSync,cancelQueuedSyncIntents,recoverSync} from './sync-outbox.mjs';
import {replyOnce} from './transport-live.mjs';
import {WechatRuntime} from '../wechat-live-stage/wechat-runtime-live.mjs';

const owner='synthetic-owner',now=1700000000000,day=86400000;
const hash=s=>createHash('sha256').update(s).digest('hex');
const cancelArgs=(s,ids)=>({items:ids.map(syncId=>({syncId,sequence:s.syncOutbox.records[syncId].sequence})),operationId:'cancel-operation-0001',ownerConfirmedCancelQueued:true});
function add(q,id,time,token){
 enqueue(q,owner,{eventId:id,name:'weixin.owner_text',timestamp:new Date(time).toISOString(),data:{conversation_id:'weixin-self',message_id:id,simulation:false,text:'synthetic'}},{to_user_id:'synthetic-recipient',accountScope:'synthetic-scope',context_token:token,source_message_id:id},time);
}
function fixture(){
 const q=createQueue(owner);add(q,'e1',now,'token-one');let saved={version:1,owner,phase:'armed',sessionToken:'test-token',queue:q,delivery:{}},mode='ok';
 const store={save:async s=>{if(mode==='before')throw new Error('synthetic save failure');saved=structuredClone(s);if(mode==='after')throw new Error('synthetic uncertain save');},load:async()=>structuredClone(saved)};
 return {store,get:()=>structuredClone(saved),set:s=>{saved=structuredClone(s)},fail:m=>{mode=m}};
}
async function make(){const f=fixture(),bridge=new BridgeModel({owner,store:f.store});await bridge.load();return {...f,bridge}}
const draft=(b,id,i,t=now+1)=>b.replyDraft(owner,id,`message-${id}-${i}`,`key-${id}-${i}`,t,()=>t);
const media=(b,id,i,t=now+1)=>b.mediaReplyDraft(owner,{eventId:id,idempotencyKey:`media-${id}-${i}`,kind:'file',fileName:'file.txt',sha256:i.toString(16).padStart(64,'0')},()=>t);
test('refund of an earlier unstarted reservation cannot duplicate a retained ninth notice',async()=>{
 for(const kind of ['text','media']){const {bridge}=await make();const first=await draft(bridge,'e1',0);for(let i=1;i<9;i++)await draft(bridge,'e1',i);await bridge.discardUnstartedReply(owner,'e1','key-e1-0',first.clientId);const next=kind==='text'?await draft(bridge,'e1',20):await media(bridge,'e1',20);if(kind==='text')assert.ok(!next.text.endsWith(CONTEXT_NOTICE_SUFFIX));assert.equal(retainedContextReservations(bridge.state.queue,'e1',now+1).count,9);assert.equal(Object.values(bridge.state.queue.records.e1.replies).filter(x=>x.budgetNotice===true).length,1);await assert.rejects(draft(bridge,'e1',21),e=>e.code==='context_budget_exhausted');}
});
test('actual runtime plus replyOnce holds tenth queued part and sends it only on a fresh context',async()=>{
 const {bridge}=await make();let time=now+1,calls=0;const runtime=new WechatRuntime({bridge,owner,events:{deliver:async()=>({accepted:true})},clock:()=>time,schedule:()=>({unref(){}}),cancel(){},poll:async()=>{},janitor:{start:async()=>{},reschedule(){},stop(){}},sendSync:args=>replyOnce({...args,transport:async()=>{calls++;return new Response('{"ret":0}',{status:200})}})});await runtime.start();try{await bridge.syncDeliveryControl.resume(owner,{epoch:bridge.syncDeliveryControl.status(owner).epoch,operationId:'runtime-budget-resume-001',ownerConfirmedResolutionReview:true});const items=[];for(let i=0;i<10;i++)items.push(await bridge.enqueueSync(owner,{sourceId:'runtime-item-'+i,role:['user','assistant','progress'][i%3],text:'runtime body '+i,eventId:'e1'},()=>time));const tenth=items[9].syncId,identity=structuredClone(bridge.state.syncOutbox.records[tenth].parts[0]);await runtime.step();await runtime.step();await runtime.step();assert.equal(calls,9);assert.equal(bridge.state.syncOutbox.records[tenth].state,'queued');assert.equal(bridge.state.syncOutbox.records[tenth].parts[0].key,identity.key);assert.equal(bridge.state.syncOutbox.records[tenth].parts[0].partId,identity.partId);time++;add(bridge.state.queue,'fresh-runtime',time,'token-two');await runtime.step();assert.equal(calls,10);assert.equal(bridge.state.syncOutbox.records[tenth].state,'sent');assert.equal(bridge.state.syncOutbox.records[tenth].eventId,'fresh-runtime');}finally{await runtime.stopAndWait()}
});

test('并发预留最多九条，第九条包含计数和提醒，第十条不产生请求',async()=>{
 const {bridge}=await make();let calls=0;const wire=[];
 const transport=async(_url,options)=>{calls++;wire.push(JSON.parse(options.body).msg.item_list[0].text_item.text);return new Response('{"ret":0}',{status:200})};
 const run=i=>replyOnce({bridge,actor:owner,eventId:'e1',text:`body-${i}`,idempotencyKey:`wire-${i}`,now:now+1,clock:()=>now+1,transport});
 const result=await Promise.allSettled(Array.from({length:12},(_,i)=>run(i)));
 assert.equal(calls,9);assert.equal(result.filter(x=>x.status==='fulfilled').length,9);assert.equal(result.filter(x=>x.status==='rejected'&&x.reason.code==='context_budget_exhausted').length,3);
 assert.deepEqual(wire.map(s=>s.match(/^\(\d\/9\)/)?.[0]),Array.from({length:9},(_,i)=>`(${i+1}/9)`));
 assert.ok(wire[8].endsWith(CONTEXT_NOTICE_SUFFIX));assert.ok(wire.slice(0,8).every(x=>!x.endsWith(CONTEXT_NOTICE_SUFFIX)));
 assert.equal((await run(0)).state,'sent');assert.equal(calls,9);
});

test('文本和媒体共享额度，媒体不能占用必须发送提醒的第九位',async()=>{
 const {bridge}=await make();for(let i=0;i<4;i++)await draft(bridge,'e1',i);for(let i=0;i<4;i++)await media(bridge,'e1',i+1);
 await assert.rejects(media(bridge,'e1',99),e=>e.code==='context_notice_requires_text');
 const ninth=await draft(bridge,'e1',99);assert.ok(ninth.text.startsWith('(9/9) '));assert.ok(ninth.text.endsWith(CONTEXT_NOTICE_SUFFIX));
 await assert.rejects(draft(bridge,'e1',100),e=>e.code==='context_budget_exhausted');
 assert.equal((await draft(bridge,'e1',0)).state,'uncertain');
});

test('直接回复、媒体、三类同步和拆分片段共享一组计数',async()=>{
 const {bridge}=await make();assert.ok((await draft(bridge,'e1',1)).text.startsWith('(1/9) '));await media(bridge,'e1',2);
 for(const role of ['user','assistant','progress'])await bridge.enqueueSync(owner,{sourceId:`source-${role}`,role,text:'x'.repeat(1901),eventId:'e1'},()=>now+2);
 for(let i=3;i<=8;i++){
  const part=await bridge.claimSync(owner,()=>now+3),prepared=await bridge.replyDraft(owner,part.eventId,part.text,part.idempotencyKey,now+3,()=>now+3,{syncPartId:part.syncPartId});
  assert.ok(prepared.text.startsWith(`(${i}/9) `));await bridge.replySent(owner,part.eventId,part.idempotencyKey,now+4);await bridge.finishSync(owner,part,'sent',()=>now+4);
 }
 const ninth=await draft(bridge,'e1',90,now+5);assert.ok(ninth.text.startsWith('(9/9) '));assert.ok(ninth.text.endsWith(CONTEXT_NOTICE_SUFFIX));
});

test('同一上下文续期不重置，不同有效上下文可按 9+9+8 计数',async()=>{
 const {bridge}=await make();for(let i=0;i<9;i++)await draft(bridge,'e1',i);
 add(bridge.state.queue,'same',now+10,'token-one');await assert.rejects(draft(bridge,'same',1,now+11),e=>e.code==='context_budget_exhausted');
 add(bridge.state.queue,'e2',now+20,'token-two');for(let i=0;i<9;i++)assert.ok((await draft(bridge,'e2',i,now+21)).text.startsWith(`(${i+1}/9) `));
 add(bridge.state.queue,'e3',now+30,'token-three');for(let i=0;i<8;i++)assert.ok((await draft(bridge,'e3',i,now+31)).text.startsWith(`(${i+1}/9) `));
 assert.equal(retainedContextReservations(bridge.state.queue,'e3',now+32).count,8);
});

test('上下文顺序无法确定时，文字和媒体均在预留前停止',async()=>{
 const {bridge}=await make();add(bridge.state.queue,'tie',now,'other-token');
 await assert.rejects(draft(bridge,'e1',1),e=>e.code==='context_order_ambiguous');
 await assert.rejects(media(bridge,'e1',2),e=>e.code==='context_order_ambiguous');
 assert.equal(retainedContextReservations(bridge.state.queue,'e1',now+1).count,0);
});

test('出现新上下文后不能对旧上下文发起媒体上传预留',async()=>{
 const {bridge}=await make();add(bridge.state.queue,'new-event',now+5,'new-token');
 await assert.rejects(media(bridge,'e1',4,now+6),e=>e.code==='stale_context');
 assert.equal(retainedContextReservations(bridge.state.queue,'e1',now+6).count,0);
});

test('旧版已接受或未知记录保留原线报文身份',async()=>{
 const {bridge}=await make();const r=bridge.state.queue.records.e1;r.replies={};
 r.replies[hash('old-sent')]={hash:hash('old-sent-body'),state:'sent',attemptedAt:now,clientId:'legacy-sent',text:'old-sent-body'};
 r.replies[hash('old-unknown')]={hash:hash('old-unknown-body'),state:'uncertain',attemptedAt:now,clientId:'legacy-unknown',text:'old-unknown-body'};
 assert.equal((await bridge.replyDraft(owner,'e1','old-sent-body','old-sent',now+1,()=>now+1)).state,'sent');
 assert.equal((await bridge.replyDraft(owner,'e1','old-unknown-body','old-unknown',now+1,()=>now+1)).state,'uncertain');
 await assert.rejects(bridge.replyDraft(owner,'e1','old-unknown-body','different-key',now+1,()=>now+1));
});

test('确定网络尚未开始的失败撤销预留，不消耗额度',async()=>{
 const {bridge}=await make();bridge.state.sessionToken='';let calls=0;
 const args={bridge,actor:owner,eventId:'e1',text:'body',idempotencyKey:'preflight',now:now+1,clock:()=>now+1,transport:async()=>{calls++;return new Response('{"ret":0}',{status:200})}};
 await assert.rejects(replyOnce(args),e=>e.code==='pre_execution_failure');assert.equal(calls,0);assert.equal(retainedContextReservations(bridge.state.queue,'e1',now+1).count,0);
 bridge.state.sessionToken='test-token';assert.equal((await replyOnce(args)).state,'sent');assert.equal(calls,1);
});

test('旧队列批量取消全有或全无，未知队首不能被释放',()=>{
 const q=createQueue(owner);add(q,'e1',now,'token-one');const s={queue:q,delivery:{}};
 const ids=Array.from({length:27},(_,i)=>enqueueSync(s,{sourceId:`source-${i}`,role:'user',text:`body-${i}`,eventId:'e1'},now+1).syncId);
 s.syncOutbox.deliveryPaused=false;const head=claimSync(s,now+2);finishSync(s,head,'uncertain',now+3);s.syncOutbox.deliveryPaused=true;
 assert.throws(()=>cancelQueuedSyncIntents(s,cancelArgs(s,[ids[0],ids[1]]),now+4));assert.equal(s.syncOutbox.records[ids[1]].deliveryIntent,undefined);
 assert.deepEqual(cancelQueuedSyncIntents(s,cancelArgs(s,ids.slice(1)),now+4),{cancelled:26,duplicate:false});
 assert.equal(listSync(s,{},now+4).pendingCount,0);assert.equal(s.syncOutbox.records[ids[0]].state,'uncertain');
 s.syncOutbox.deliveryPaused=false;assert.equal(claimSync(s,now+5),null);
});

test('队列全部明确取消后才可显式恢复，新消息随后可发送',()=>{
 const q=createQueue(owner);add(q,'e1',now,'token-one');const s={queue:q,delivery:{}};
 const ids=['one','two'].map(sourceId=>enqueueSync(s,{sourceId,role:'user',text:sourceId,eventId:'e1'},now+1).syncId);s.syncOutbox.deliveryPaused=true;
 assert.equal(listSync(s,{},now+2).pendingCount,2);
 cancelQueuedSyncIntents(s,cancelArgs(s,ids),now+3);
 const fresh=enqueueSync(s,{sourceId:'fresh',role:'assistant',text:'fresh',eventId:'e1'},now+5);
 assert.equal(claimSync(s,now+6).syncId,fresh.syncId);
});

test('保存失败及其结果不确定时都停发，重启后仍默认暂停',async()=>{
 for(const mode of ['before','after']){
  const f=fixture(),s=f.get();const id=enqueueSync(s,{sourceId:'queued',role:'user',text:'body',eventId:'e1'},now+1).syncId;s.syncOutbox.deliveryPaused=false;f.set(s);
  const first=new BridgeModel({owner,store:f.store});await first.load();const runtime=new WechatRuntime({bridge:first,owner,events:{deliver:async()=>({accepted:true})},janitor:{start:async()=>{},reschedule(){},stop(){}},schedule:()=>({unref(){}}),cancel(){},poll:async()=>{},sendSync:async()=>{throw Error('网络调用不可用')}});await runtime.start();const epoch=first.syncDeliveryControl.status(owner).epoch;f.fail(mode);
  await assert.rejects(first.cancelQueuedSyncIntents(owner,{...cancelArgs(s,[id]),epoch},()=>now+2));await assert.rejects(first.claimSync(owner,()=>now+3),e=>e.code==='state_storage_unavailable');await runtime.stopAndWait();
  f.fail('ok');const restarted=new BridgeModel({owner,store:f.store});await restarted.load();const again=new WechatRuntime({bridge:restarted,owner,events:{deliver:async()=>({accepted:true})},janitor:{start:async()=>{},reschedule(){},stop(){}},clock:()=>now+4,schedule:()=>({unref(){}}),cancel(){},poll:async()=>{},sendSync:async()=>{throw Error('Unexpected send')}});await again.start();await again.step();assert.equal(restarted.syncDeliveryControl.status(owner).paused,true);await again.stopAndWait();
  assert.equal(restarted.state.syncOutbox.records[id].deliveryIntent,mode==='after'?'cancelled':undefined);
 }
});

test('带计数的队列已发送分片可在崩溃恢复时识别',async()=>{
 const {bridge}=await make();const item=await bridge.enqueueSync(owner,{sourceId:'multipart',role:'assistant',text:'x'.repeat(2000),eventId:'e1'},()=>now+2);
 bridge.state.syncOutbox.deliveryPaused=false;const part=await bridge.claimSync(owner,()=>now+3);const sent=await bridge.replyDraft(owner,part.eventId,part.text,part.idempotencyKey,now+3,()=>now+3,{syncPartId:part.syncPartId});assert.ok(sent.text.startsWith('(1/9) '));
 await bridge.replySent(owner,part.eventId,part.idempotencyKey,now+4);const persisted=structuredClone(bridge.state);recoverSync(persisted);assert.equal(persisted.syncOutbox.records[item.syncId].parts[0].state,'sent');
});

test('已知暂缓限制：超过保留期后同上下文可能重新计数',async()=>{
 const {bridge}=await make();for(let i=0;i<9;i++)await draft(bridge,'e1',i);add(bridge.state.queue,'renewed',now+23*3600000,'token-one');
 const after=now+25*3600000;const result=await draft(bridge,'renewed',90,after);assert.ok(result.text.startsWith('(1/9) '));
});
