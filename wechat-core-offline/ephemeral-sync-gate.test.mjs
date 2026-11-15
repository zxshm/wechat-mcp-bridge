import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueue,enqueue} from './retention.mjs';
import {enqueueSync} from './sync-outbox.mjs';
import {BridgeModel} from './bridge-model-live.mjs';
import {WechatRuntime} from '../wechat-live-stage/wechat-runtime-live.mjs';
import {makeHandler} from './mcp-events.mjs';
import {replyOnce} from './transport-live.mjs';

const owner='synthetic-owner',base=1700000000000,day=86400000,head='a'.repeat(64),resumeId='resume-operation-001',pauseId='pause-operation-0001';
async function fixture({queued=0,unknown=false,expiredHead=false,realJanitor=false,onSend=null}={}){
 let time=base,sends=0,polls=0,delivered=0;const queue=createQueue(owner);enqueue(queue,owner,{eventId:'event',name:'weixin.owner_text',timestamp:new Date(time).toISOString(),data:{conversation_id:'weixin-self',message_id:'message',simulation:false,text:'fixture'}},{to_user_id:'synthetic-recipient',accountScope:'synthetic-scope',context_token:'synthetic-context',source_message_id:'message'},time);
 const s={version:1,owner,phase:'armed',sessionToken:'synthetic-token',queue,delivery:{event:{attempts:0,nextAt:time,done:false}},syncOutbox:{version:1,nextSequence:52,records:{}}};
 if(unknown)s.syncOutbox.records[head]={syncId:head,sequence:51,state:'uncertain',createdAt:time,updatedAt:time,expiresAt:time+day,dedupeUntil:time+7*day,parts:[{index:0,state:'uncertain',key:'synthetic-key',partId:'synthetic-part'}]};
 for(let i=0;i<queued;i++)enqueueSync(s,{sourceId:'source-'+i,role:'assistant',text:'fixture',eventId:'event'},time);if(unknown&&expiredHead)s.syncOutbox.records[head].dedupeUntil=time-1;
 let saved=structuredClone(s);const store={load:async()=>structuredClone(saved),save:async x=>{saved=structuredClone(x)}},bridge=new BridgeModel({owner,store});await bridge.load();
 const runtime=new WechatRuntime({bridge,owner,clock:()=>time,events:{deliver:async()=>{delivered++;return {accepted:true}}},poll:async()=>{polls++},sendSync:async()=>{sends++;if(onSend)await onSend();return {state:'sent'}},...(realJanitor?{}:{janitor:{start:async()=>{},reschedule(){},stop(){}}}),schedule:()=>({unref(){}}),cancel(){},onStage(){}});await runtime.start();
 return {bridge,runtime,store,gate:bridge.syncDeliveryControl,read:()=>structuredClone(saved),count:()=>({sends,polls,delivered}),setTime:t=>{time=t}};
}
const args=(gate,id)=>({epoch:gate.status(owner).epoch,operationId:id,ownerConfirmedResolutionReview:true});

test('默认暂停时未知队首与 26 个排队项不发，入站投递和轮询继续',async()=>{
 const f=await fixture({unknown:true,queued:26});try{const before=structuredClone(f.bridge.state.syncOutbox);await f.runtime.step();await f.runtime.step();assert.equal(f.count().sends,0);assert.equal(f.count().polls,2);assert.equal(f.count().delivered,1);assert.deepEqual(f.bridge.state.syncOutbox,before);await assert.rejects(f.gate.resume(owner,args(f.gate,resumeId)),/Unresolved|Outstanding/);}finally{await f.runtime.stopAndWait()}
});
test('模拟清理器未运行时，到期未知队首不会由暂停的发送步骤清理或发送',async()=>{
 const f=await fixture({unknown:true,queued:26,expiredHead:true});try{await f.runtime.step();assert.equal(f.count().sends,0);assert.equal(f.bridge.state.syncOutbox.records[head].state,'uncertain');await assert.rejects(f.gate.resume(owner,args(f.gate,resumeId)),/Unresolved|Outstanding/);}finally{await f.runtime.stopAndWait()}
});
test('原有清理器在启动时删除到期未知，但本进程仍拒绝恢复',async()=>{
 const f=await fixture({unknown:true,queued:26,expiredHead:true,realJanitor:true});try{assert.equal(f.bridge.state.syncOutbox.records[head],undefined);assert.equal(f.gate.status(owner).knownUncertain,1);await f.runtime.step();assert.equal(f.count().sends,0);await assert.rejects(f.gate.resume(owner,args(f.gate,resumeId)),/Unresolved/);}finally{await f.runtime.stopAndWait()}
});
test('本进程观察到的未知被其他清理路径移除后仍禁止恢复',async()=>{
 const f=await fixture({unknown:true,expiredHead:true});try{assert.equal(f.gate.status(owner).knownUncertain,1);await f.bridge.listSync(owner,{},()=>base);assert.equal(f.bridge.state.syncOutbox.records[head],undefined);await assert.rejects(f.gate.resume(owner,args(f.gate,resumeId)),/Unresolved/);assert.equal(f.count().sends,0);}finally{await f.runtime.stopAndWait()}
});
test('未知或未取消排队项均拒绝恢复，取消意图不能消除未知结果',async()=>{
 for(const opts of [{queued:1},{unknown:true}]){const f=await fixture(opts);try{if(opts.unknown)f.bridge.state.syncOutbox.records[head].deliveryIntent='cancelled';await assert.rejects(f.gate.resume(owner,args(f.gate,resumeId)),/Unresolved|Outstanding/);}finally{await f.runtime.stopAndWait()}}
});
test('空队列经明确恢复后能同步；暂停和恢复旧身份重复不反转新决定',async()=>{
 const f=await fixture();try{const epoch=f.gate.status(owner).epoch;assert.equal((await f.gate.resume(owner,{epoch,operationId:resumeId,ownerConfirmedResolutionReview:true})).paused,false);await f.bridge.enqueueSync(owner,{sourceId:'new-source',role:'assistant',text:'fixture',eventId:'event'},()=>base);await f.runtime.step();assert.equal(f.count().sends,1);assert.equal(f.gate.pause(owner,{epoch,operationId:pauseId}).paused,true);assert.equal((await f.gate.resume(owner,{epoch,operationId:resumeId,ownerConfirmedResolutionReview:true})).paused,true);await f.runtime.step();assert.equal(f.count().sends,1);}finally{await f.runtime.stopAndWait()}
});
test('停止再启动必暂停，旧进程操作身份和随机纪元不能重放恢复',async()=>{
 const f=await fixture();try{const old=f.gate.status(owner).epoch;await f.gate.resume(owner,{epoch:old,operationId:resumeId,ownerConfirmedResolutionReview:true});await f.runtime.stopAndWait();await f.runtime.start();const fresh=f.gate.status(owner);assert.notEqual(fresh.epoch,old);assert.equal(fresh.paused,true);await assert.rejects(f.gate.resume(owner,{epoch:old,operationId:resumeId,ownerConfirmedResolutionReview:true}),/unavailable/);await f.runtime.step();assert.equal(f.count().sends,0);}finally{await f.runtime.stopAndWait()}
});
test('暂停与已领取未发送的竞争中，原项安全回到排队且没有开始发送',async()=>{
 const f=await fixture();try{await f.gate.resume(owner,args(f.gate,resumeId));await f.bridge.enqueueSync(owner,{sourceId:'race-source',role:'assistant',text:'fixture',eventId:'event'},()=>base);const original=f.bridge.claimSync.bind(f.bridge);let release,claimed;const wait=new Promise(r=>{release=r}),started=new Promise(r=>{claimed=r});f.bridge.claimSync=async(...a)=>{const c=await original(...a);claimed();await wait;return c};const step=f.runtime.step();await started;const status=f.gate.pause(owner,args(f.gate,pauseId));assert.equal(status.inFlight,true);release();await step;assert.equal(f.count().sends,0);assert.equal(Object.values(f.bridge.state.syncOutbox.records)[0].state,'queued');assert.equal(f.gate.status(owner).paused,true);}finally{await f.runtime.stopAndWait()}
});
test('暂停时已有发送在途会报告，结束后不再开始下一条',async()=>{
 let release,started;const wait=new Promise(r=>{release=r}),began=new Promise(r=>{started=r});const f=await fixture({onSend:async()=>{started();await wait}});try{await f.gate.resume(owner,args(f.gate,resumeId));for(let i=0;i<2;i++)await f.bridge.enqueueSync(owner,{sourceId:'running-'+i,role:'assistant',text:'fixture',eventId:'event'},()=>base);const step=f.runtime.step();await began;const paused=f.gate.pause(owner,args(f.gate,pauseId));assert.equal(paused.inFlight,true);release();await step;await f.runtime.step();assert.equal(f.count().sends,1);assert.equal(f.gate.status(owner).inFlight,false);}finally{release();await f.runtime.stopAndWait()}
});
test('恢复等待状态锁时发生暂停，旧恢复不得覆盖较新的暂停',async()=>{
 const f=await fixture();let release,locked;const wait=new Promise(r=>{release=r}),began=new Promise(r=>{locked=r});try{const held=f.bridge.locked(async()=>{locked();await wait});await began;const pending=f.gate.resume(owner,args(f.gate,resumeId));f.gate.pause(owner,args(f.gate,pauseId));release();await held;await assert.rejects(pending,/unavailable/);assert.equal(f.gate.status(owner).paused,true);}finally{release();await f.runtime.stopAndWait()}
});
test('停止运行时与已领取项目竞争，不会在停止后开始发送',async()=>{
 const f=await fixture();let release,claimed;const wait=new Promise(r=>{release=r}),started=new Promise(r=>{claimed=r});try{await f.gate.resume(owner,args(f.gate,resumeId));await f.bridge.enqueueSync(owner,{sourceId:'stop-race',role:'assistant',text:'fixture',eventId:'event'},()=>base);const original=f.bridge.claimSync.bind(f.bridge);f.bridge.claimSync=async(...a)=>{const c=await original(...a);claimed();await wait;return c};const step=f.runtime.step();await started;f.runtime.stop();release();await step;assert.equal(f.count().sends,0);assert.equal(Object.values(f.bridge.state.syncOutbox.records)[0].state,'queued');}finally{release();await f.runtime.stopAndWait()}
});
test('完成回写失败时暂停且不能在本进程恢复',async()=>{
 const f=await fixture();try{await f.gate.resume(owner,args(f.gate,resumeId));await f.bridge.enqueueSync(owner,{sourceId:'save-failure',role:'assistant',text:'fixture',eventId:'event'},()=>base);f.bridge.finishSync=async()=>false;await f.runtime.step();assert.equal(f.count().sends,1);const status=f.gate.status(owner);assert.equal(status.paused,true);assert.equal(status.faulted,true);await assert.rejects(f.gate.resume(owner,args(f.gate,'resume-operation-002')),/unavailable/);await f.runtime.step();assert.equal(f.count().sends,1);}finally{await f.runtime.stopAndWait()}
});
test('普通直接回复不受队列暂停影响，传输仅使用模拟',async()=>{
 const f=await fixture();let calls=0;try{const result=await replyOnce({bridge:f.bridge,actor:owner,eventId:'event',text:'fixture-reply',idempotencyKey:'direct-key',now:base,clock:()=>base,transport:async()=>{calls++;return new Response('{"ret":0}',{status:200})}});assert.equal(result.state,'sent');assert.equal(calls,1);assert.equal(f.gate.status(owner).paused,true);}finally{await f.runtime.stopAndWait()}
});
test('MCP 状态只读，恢复必须携带确认和当前纪元',async()=>{
 const f=await fixture(),h=makeHandler({events:{list:async()=>({events:[]})},actor:owner,bridge:f.bridge});const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'fixture',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
 const invoke=async(name,arguments_)=>{const req=new Request('http://127.0.0.1/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':name},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:arguments_,_meta:meta}})});return (await h.fetch(req)).json()};
 try{const status=await invoke('get_sync_pause_status',{}),v=JSON.parse(status.result.content[0].text);assert.equal(v.paused,true);const bad=await invoke('resume_empty_chatgpt_sync',{epoch:v.epoch,operationId:resumeId,ownerConfirmed:false,ownerConfirmedResolutionReview:true});assert.ok(bad.error||bad.result?.isError);const missing=await invoke('resume_empty_chatgpt_sync',{epoch:v.epoch,operationId:resumeId,ownerConfirmed:true});assert.ok(missing.error||missing.result?.isError);const good=await invoke('resume_empty_chatgpt_sync',{epoch:v.epoch,operationId:resumeId,ownerConfirmed:true,ownerConfirmedResolutionReview:true});assert.equal(JSON.parse(good.result.content[0].text).paused,false);}finally{await h.close();await f.runtime.stopAndWait()}
});
test('默认网络入口被禁止',async()=>{await assert.rejects(fetch('https://example.invalid'),/TEST_NETWORK_DISABLED/)});
test('queued cancellation rejects active and paused-but-inflight workers',async()=>{
 let release,began;const wait=new Promise(r=>{release=r}),started=new Promise(r=>{began=r});const f=await fixture({onSend:async()=>{began();await wait}});
 try{await f.gate.resume(owner,args(f.gate,resumeId));const rows=[];for(let i=0;i<2;i++){const r=await f.bridge.enqueueSync(owner,{sourceId:'cancel-flight-'+i,role:'assistant',text:'fixture '+i,eventId:'event'},()=>base);rows.push({syncId:r.syncId,sequence:f.bridge.state.syncOutbox.records[r.syncId].sequence})}const cancel={items:[rows[1]],epoch:f.gate.status(owner).epoch,operationId:'cancel-flight-operation-001',ownerConfirmedCancelQueued:true};await assert.rejects(f.bridge.cancelQueuedSyncIntents(owner,cancel,()=>base),/pause unavailable/);const step=f.runtime.step();await started;f.gate.pause(owner,args(f.gate,pauseId));assert.equal(f.gate.status(owner).inFlight,true);await assert.rejects(f.bridge.cancelQueuedSyncIntents(owner,cancel,()=>base),/pause unavailable/);assert.equal(f.bridge.state.syncOutbox.records[rows[1].syncId].deliveryIntent,undefined);release();await step;assert.deepEqual(await f.bridge.cancelQueuedSyncIntents(owner,cancel,()=>base),{cancelled:1,duplicate:false});assert.equal(f.gate.status(owner).paused,true);}finally{release();await f.runtime.stopAndWait()}
});
test('queued cancellation rejects a faulted runtime',async()=>{
 const f=await fixture();try{await f.gate.resume(owner,args(f.gate,resumeId));const rows=[];for(let i=0;i<2;i++){const r=await f.bridge.enqueueSync(owner,{sourceId:'fault-cancel-'+i,role:'user',text:'fixture '+i,eventId:'event'},()=>base);rows.push({syncId:r.syncId,sequence:f.bridge.state.syncOutbox.records[r.syncId].sequence})}f.bridge.finishSync=async()=>false;await f.runtime.step();assert.equal(f.gate.status(owner).faulted,true);await assert.rejects(f.bridge.cancelQueuedSyncIntents(owner,{items:[rows[1]],epoch:f.gate.status(owner).epoch,operationId:'faulted-cancel-operation-1',ownerConfirmedCancelQueued:true},()=>base),/pause unavailable/);assert.equal(f.bridge.state.syncOutbox.records[rows[1].syncId].deliveryIntent,undefined);}finally{await f.runtime.stopAndWait()}
});
test('resume is memory-only and a subsequent pause wins without persistence',async()=>{
 const f=await fixture();try{let saves=0;f.store.save=async()=>{saves++;throw Error('Unexpected persistent pause write')};await f.gate.resume(owner,args(f.gate,resumeId));f.gate.pause(owner,args(f.gate,pauseId));assert.equal(saves,0);assert.equal(f.gate.status(owner).paused,true);assert.equal(f.bridge.state.syncOutbox.deliveryPaused,undefined);}finally{await f.runtime.stopAndWait()}
});

async function cancelFixtureHead(f){
 return f.bridge.cancelUncertainSyncIntent(owner,{syncId:head,confirmationEventId:'event',ownerConfirmedCancel:true},()=>base);
}

test('formally cancelled uncertain history permits explicit resume and only new delivery',async()=>{
 const f=await fixture({unknown:true,queued:26});try{
  const priorId='c'.repeat(64),prior=structuredClone(f.bridge.state.syncOutbox.records[head]);prior.syncId=priorId;prior.sequence=15;f.bridge.state.syncOutbox.records[priorId]=prior;
  const queued=Object.values(f.bridge.state.syncOutbox.records).filter(r=>r.state==='queued').map(r=>({syncId:r.syncId,sequence:r.sequence}));
  await f.bridge.cancelQueuedSyncIntents(owner,{items:queued,epoch:f.gate.status(owner).epoch,operationId:'cancel-old-fixture-26',ownerConfirmedCancelQueued:true},()=>base);
  await f.bridge.cancelUncertainSyncIntent(owner,{syncId:priorId,confirmationEventId:'event',ownerConfirmedCancel:true},()=>base);
  const cancelled=await cancelFixtureHead(f);assert.equal(cancelled.state,'uncertain');
  const before=structuredClone(f.bridge.state.syncOutbox);await assert.rejects(f.gate.resume(owner,{...args(f.gate,resumeId),ownerConfirmedResolutionReview:false}),/review required/);
  assert.equal((await f.gate.resume(owner,args(f.gate,resumeId))).paused,false);assert.deepEqual(f.bridge.state.syncOutbox,before);
  await f.runtime.step();await f.runtime.step();assert.equal(f.count().sends,0);
  await f.bridge.enqueueSync(owner,{sourceId:'fresh-after-cancellation',role:'assistant',text:'new only',eventId:'event'},()=>base);
  await f.runtime.step();assert.equal(f.count().sends,1);assert.equal(f.bridge.state.syncOutbox.records[head].state,'uncertain');assert.equal(f.bridge.state.syncOutbox.records[head].parts[0].state,'uncertain');
  assert.equal((await f.gate.resume(owner,args(f.gate,resumeId))).duplicate,true);
 }finally{await f.runtime.stopAndWait()}
});

test('formal cancellation survives restart but restart still needs fresh explicit resume',async()=>{
 const f=await fixture({unknown:true});let fresh;try{await cancelFixtureHead(f);const old=args(f.gate,resumeId);await f.gate.resume(owner,old);await f.runtime.stopAndWait();const bridge=new BridgeModel({owner,store:f.store});await bridge.load();let sends=0;fresh=new WechatRuntime({bridge,owner,clock:()=>base+day+1,events:{deliver:async()=>({accepted:true})},poll:async()=>{},sendSync:async()=>{sends++;return {state:'sent'}},schedule:()=>({unref(){}}),cancel(){},onStage(){}});await fresh.start();const gate=bridge.syncDeliveryControl;assert.equal(gate.status(owner).paused,true);assert.equal(gate.status(owner).knownUncertain,1);await assert.rejects(gate.resume(owner,old),/unavailable/);await gate.resume(owner,args(gate,'resume-after-restart-001'));await fresh.step();assert.equal(sends,0);assert.equal(bridge.state.syncOutbox.records[head].state,'uncertain');assert.equal(bridge.state.syncOutbox.records[head].deliveryIntent,'cancelled');}finally{if(fresh)await fresh.stopAndWait();await f.runtime.stopAndWait()}
});

test('cancelled intent without complete formal proof cannot unlock uncertain history',async()=>{
 const mutations=[r=>delete r.cancelConfirmationHash,r=>r.cancelConfirmationHash='bad',r=>delete r.cancelledAt,r=>r.cancelledAt=base-1,r=>r.cancelledAt=base+60001,r=>delete r.updatedAt,r=>r.parts[0].state='inflight',r=>r.parts[0].state='unrecognized',r=>r.deliveryIntent=undefined];
 for(const mutate of mutations){const f=await fixture({unknown:true});try{await cancelFixtureHead(f);mutate(f.bridge.state.syncOutbox.records[head]);await assert.rejects(f.gate.resume(owner,args(f.gate,resumeId)),/Unresolved|Outstanding/);assert.equal(f.count().sends,0);assert.equal(f.gate.status(owner).paused,true);}finally{await f.runtime.stopAndWait()}}
});

test('cancelling one unknown does not release other unknown or uncancelled queued entries',async()=>{
 for(const pending of ['unknown','queued','failed']){const f=await fixture({unknown:true,queued:pending==='queued'?1:0});try{await cancelFixtureHead(f);if(pending!=='queued'){const other=structuredClone(f.bridge.state.syncOutbox.records[head]);other.syncId='b'.repeat(64);other.sequence=78;other.state=pending==='unknown'?'uncertain':'failed';other.parts[0].state=other.state;delete other.deliveryIntent;delete other.cancelConfirmationHash;delete other.cancelledAt;f.bridge.state.syncOutbox.records[other.syncId]=other;}await assert.rejects(f.gate.resume(owner,args(f.gate,resumeId)),/Unresolved|Outstanding/);assert.equal(f.count().sends,0);}finally{await f.runtime.stopAndWait()}}
});

test('failed formal cancellation save leaves pause and unresolved evidence intact',async()=>{
 const f=await fixture({unknown:true});try{const resume=args(f.gate,resumeId);f.store.save=async()=>{throw Error('mock-save-failed')};await assert.rejects(cancelFixtureHead(f),/mock-save-failed/);assert.equal(f.bridge.state.syncOutbox.records[head].deliveryIntent,undefined);await assert.rejects(f.gate.resume(owner,resume),/storage unavailable/i);assert.equal(f.count().sends,0);}finally{await f.runtime.stopAndWait()}
});

test('known cancelled unknown disappearing before review still fails closed',async()=>{
 const f=await fixture({unknown:true});try{await cancelFixtureHead(f);delete f.bridge.state.syncOutbox.records[head];await assert.rejects(f.gate.resume(owner,args(f.gate,resumeId)),/Unresolved/);assert.equal(f.count().sends,0);}finally{await f.runtime.stopAndWait()}
});

test('body expiry preserves formal cancellation proof without extending retention',async()=>{
 const f=await fixture({unknown:true});try{await cancelFixtureHead(f);const before=structuredClone(f.bridge.state.syncOutbox.records[head]);f.setTime(base+day+1);await f.bridge.clean(owner,base+day+1);const after=f.bridge.state.syncOutbox.records[head];assert.equal(after.updatedAt,before.updatedAt);assert.equal(after.dedupeUntil,before.dedupeUntil);assert.equal(after.cancelConfirmationHash,before.cancelConfirmationHash);await f.gate.resume(owner,args(f.gate,resumeId));await f.runtime.step();assert.equal(f.count().sends,0);}finally{await f.runtime.stopAndWait()}
});
