import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueue,enqueue} from './retention.mjs';
import {enqueueSync,claimSync,finishSync,cleanSync} from './sync-outbox.mjs';
import {BridgeModel} from './bridge-model-live.mjs';
import {WechatRuntime} from '../wechat-live-stage/wechat-runtime-live.mjs';

const owner='synthetic-owner',now=1700000000000,operationId='cancel-batch-operation-0001';
async function fixture(){
 const queue=createQueue(owner);enqueue(queue,owner,{eventId:'event',name:'weixin.owner_text',timestamp:new Date(now).toISOString(),data:{conversation_id:'weixin-self',message_id:'event',simulation:false,text:'fixture'}},{to_user_id:'fixture-recipient',accountScope:'fixture-scope',context_token:'fixture-context',source_message_id:'event'},now);
 const state={version:1,owner,phase:'armed',sessionToken:'synthetic-token',queue,delivery:{},syncOutbox:{version:1,nextSequence:51,deliveryPaused:false,records:{}}};const head=enqueueSync(state,{sourceId:'head',role:'assistant',text:'unknown fixture',eventId:'event'},now),claim=claimSync(state,now+1);finishSync(state,claim,'uncertain',now+2);
 const items=Array.from({length:26},(_,i)=>{const x=enqueueSync(state,{sourceId:'queued-'+i,role:'user',text:'fixture-'+i,eventId:'event'},now+3);return {syncId:x.syncId,sequence:state.syncOutbox.records[x.syncId].sequence}});
 let saved=structuredClone(state),mode='ok';const store={load:async()=>structuredClone(saved),save:async s=>{if(mode==='before')throw Error('synthetic');saved=structuredClone(s);if(mode==='after')throw Error('synthetic')}};
 const open=async()=>{const bridge=new BridgeModel({owner,store});await bridge.load();const runtime=new WechatRuntime({bridge,owner,events:{deliver:async()=>({accepted:true})},janitor:{start:async()=>{},reschedule(){},stop(){}},clock:()=>now+10,schedule:()=>({unref(){}}),cancel(){},poll:async()=>{},sendSync:async()=>{throw Error('网络调用不可用')}});await runtime.start();return {bridge,runtime,epoch:bridge.syncDeliveryControl.status(owner).epoch}};
 return {head,items,store,open,read:()=>structuredClone(saved),fail:x=>{mode=x}};
}
const options=(items,epoch,id=operationId)=>({items,epoch,operationId:id,ownerConfirmedCancelQueued:true});
test('concurrent duplicate cancellation persists once and preserves unknown',async()=>{
 const f=await fixture(),x=await f.open();let saves=0;const save=f.store.save;f.store.save=async s=>{saves++;await save(s)};try{const results=await Promise.all([x.bridge.cancelQueuedSyncIntents(owner,options(f.items,x.epoch),()=>now+11),x.bridge.cancelQueuedSyncIntents(owner,options([...f.items].reverse(),x.epoch),()=>now+11)]);assert.deepEqual(results.map(x=>x.duplicate),[false,true]);assert.equal(saves,1);assert.equal(f.read().syncOutbox.records[f.head.syncId].state,'uncertain');}finally{await x.runtime.stopAndWait()}
});
test('duplicate cancellation rejects a retained part with an attempt',async()=>{
 const f=await fixture(),x=await f.open();try{await x.bridge.cancelQueuedSyncIntents(owner,options(f.items,x.epoch),()=>now+11);x.bridge.state.syncOutbox.records[f.items[0].syncId].parts[0].state='uncertain';await assert.rejects(x.bridge.cancelQueuedSyncIntents(owner,options(f.items,x.epoch),()=>now+12));assert.equal(x.bridge.state.syncOutbox.records[f.head.syncId].state,'uncertain');}finally{await x.runtime.stopAndWait()}
});

test('仅取消精确序号 52–77，保留未知队首、正文和既有期限',async()=>{
 const f=await fixture(),x=await f.open();try{assert.deepEqual(f.items.map(x=>x.sequence),Array.from({length:26},(_,i)=>52+i));const before=f.read();const result=await x.bridge.cancelQueuedSyncIntents(owner,options(f.items,x.epoch),()=>now+11);assert.deepEqual(result,{cancelled:26,duplicate:false});const after=f.read();assert.deepEqual(after.syncOutbox.records[f.head.syncId],before.syncOutbox.records[f.head.syncId]);for(const {syncId} of f.items){const a=after.syncOutbox.records[syncId],b=before.syncOutbox.records[syncId];assert.equal(a.state,'queued');assert.equal(a.deliveryIntent,'cancelled');assert.deepEqual(a.parts,b.parts);assert.equal(a.expiresAt,b.expiresAt);assert.equal(a.dedupeUntil,b.dedupeUntil);}await x.runtime.step();assert.equal(x.bridge.syncDeliveryControl.status(owner).paused,true);assert.equal(await x.bridge.claimSync(owner,()=>now+12),null);}finally{await x.runtime.stopAndWait()}
});
test('稳定身份按相同集合幂等，其他集合或身份不能覆盖历史',async()=>{
 const f=await fixture(),x=await f.open();try{await x.bridge.cancelQueuedSyncIntents(owner,options(f.items,x.epoch),()=>now+11);const before=f.read();assert.deepEqual(await x.bridge.cancelQueuedSyncIntents(owner,options([...f.items].reverse(),x.epoch),()=>now+12),{cancelled:26,duplicate:true});assert.deepEqual(f.read(),before);await assert.rejects(x.bridge.cancelQueuedSyncIntents(owner,options(f.items.slice(1),x.epoch),()=>now+13));await assert.rejects(x.bridge.cancelQueuedSyncIntents(owner,options(f.items,x.epoch,'different-operation-0001'),()=>now+13));}finally{await x.runtime.stopAndWait()}
});
test('序号不匹配、未知混入或任何已尝试分片均全批拒绝',async()=>{
 for(const mode of ['sequence','unknown','sent','prior','legacy']){const f=await fixture(),x=await f.open();try{const items=structuredClone(f.items);if(mode==='sequence')items[0].sequence++;if(mode==='unknown')items[0]={syncId:f.head.syncId,sequence:51};const target=x.bridge.state.syncOutbox.records[f.items[0].syncId];if(mode==='sent')target.parts[0].state='sent';if(mode==='prior'){const key=target.parts[0].key;const {createHash}=await import('node:crypto');x.bridge.state.queue.records.event.replies={[createHash('sha256').update(key).digest('hex')]:{state:'uncertain'}}}if(mode==='legacy')x.bridge.state.queue.records.legacy={sendState:'uncertain',idempotencyKey:target.parts[0].key};await assert.rejects(x.bridge.cancelQueuedSyncIntents(owner,options(items,x.epoch),()=>now+11));assert.ok(f.items.every(({syncId})=>x.bridge.state.syncOutbox.records[syncId].deliveryIntent===undefined));}finally{await x.runtime.stopAndWait()}}
});
test('暂停门不可用、未暂停、在途或旧纪元时拒绝取消',async()=>{
 const f=await fixture(),x=await f.open();try{await assert.rejects(x.bridge.cancelQueuedSyncIntents(owner,options(f.items,'a'.repeat(32)),()=>now+11));assert.ok(f.items.every(({syncId})=>f.read().syncOutbox.records[syncId].deliveryIntent===undefined));}finally{await x.runtime.stopAndWait()}
 const g=await fixture(),bridge=new BridgeModel({owner,store:g.store});await bridge.load();await assert.rejects(bridge.cancelQueuedSyncIntents(owner,options(g.items,'a'.repeat(32)),()=>now+11));
});
test('保存结果未知后重启，同一操作身份可安全判定是否已完成',async()=>{
 for(const mode of ['before','after']){const f=await fixture(),first=await f.open();f.fail(mode);await assert.rejects(first.bridge.cancelQueuedSyncIntents(owner,options(f.items,first.epoch),()=>now+11));await first.runtime.stopAndWait();f.fail('ok');const next=await f.open();try{const result=await next.bridge.cancelQueuedSyncIntents(owner,options(f.items,next.epoch),()=>now+12);assert.equal(result.duplicate,mode==='after');assert.equal(result.cancelled,26);assert.equal(f.read().syncOutbox.records[f.head.syncId].state,'uncertain');}finally{await next.runtime.stopAndWait()}}
});
test('幂等标记不延长已有清理期限',async()=>{
 const f=await fixture(),x=await f.open();try{await x.bridge.cancelQueuedSyncIntents(owner,options(f.items,x.epoch),()=>now+11);const before=f.read();const deadline=before.syncOutbox.records[f.items[0].syncId].dedupeUntil;assert.ok(f.items.every(({syncId})=>f.read().syncOutbox.records[syncId].dedupeUntil===deadline));const copy=f.read();cleanSync(copy,deadline);assert.equal(copy.syncOutbox.records[f.items[0].syncId],undefined);}finally{await x.runtime.stopAndWait()}
});
