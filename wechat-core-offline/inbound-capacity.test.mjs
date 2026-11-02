import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeModel} from './bridge-model-live.mjs';
import {createQueue} from './retention.mjs';
import {newState} from './core.mjs';
import {pollOnce} from './transport-live.mjs';
import {timing} from './latency-metrics.mjs';
import {WechatRuntime} from '../wechat-live-stage/wechat-runtime-live.mjs';

// This suite may only run with the network-denying preload. No real store.load,
// filesystem fixture, network listener, cloud connector or production state is used.
assert.ok(process.execArgv.some(x=>/test-no-network\.cjs$/.test(x)), 'Run with --require test-no-network.cjs');
timing.mark=()=>false;
timing.markReply=()=>false;
timing.purge=()=>false;

const OWNER='capacity-synthetic-owner',BASE=1700000000000,DAY=86400000,LIMIT=7*1024*1024;
const SENDER='capacity-synthetic-sender',ACCOUNT='capacity-synthetic-account';
const bytes=s=>Buffer.byteLength(JSON.stringify(s),'utf8');
const liveCount=s=>Object.values(s.queue.records).filter(r=>r.event).length;
const batch=(msgs,cursor='capacity-next-cursor')=>({ret:0,errcode:0,msgs,get_updates_buf:cursor});
function wire(id,kind='text',at=BASE){
 return {from_user_id:SENDER,to_user_id:ACCOUNT,message_type:1,message_state:2,message_id:id,context_token:'capacity-synthetic-context',create_time_ms:at,item_list:kind==='text'?[{type:1,text_item:{text:'synthetic inbound '+id}}]:[{type:2,image_item:{media:{encrypt_query_param:'capacity-synthetic-media-reference'}}}]};
}
function history(){
 const unknown={syncId:'a'.repeat(64),sequence:51,state:'uncertain',createdAt:BASE-10,updatedAt:BASE-5,expiresAt:BASE+DAY,dedupeUntil:BASE+7*DAY,parts:[{index:0,state:'uncertain',key:'synthetic-old-key',partId:'c'.repeat(64),text:'synthetic historical unknown'}]};
 const cancelled={...structuredClone(unknown),syncId:'b'.repeat(64),sequence:15,deliveryIntent:'cancelled',cancelledAt:BASE,cancelConfirmationHash:'d'.repeat(64)};
 return {version:1,nextSequence:52,records:{[unknown.syncId]:unknown,[cancelled.syncId]:cancelled}};
}
function seedRecord(index,{expiresAt=BASE+DAY}={}){
 const media=index%2===1,id='capacity_seed_'+index;
 const data={conversation_id:'weixin-self',message_id:id,simulation:false,...(media?{media_kind:'image',file_name:'synthetic-image'}:{text:'synthetic retained text'})};
 return {event:{eventId:id,name:media?'weixin.owner_media':'weixin.owner_text',timestamp:new Date(BASE-1).toISOString(),data},privateReplyContext:{to_user_id:SENDER,accountScope:ACCOUNT,context_token:'capacity-synthetic-context',source_message_id:id},...(media?{privateMediaContext:{mediaKind:'image',fileName:'synthetic-image',param:'capacity-synthetic-reference'}}:{}),textUntil:expiresAt,dedupeUntil:BASE+7*DAY,sendState:null};
}
function fixture({retained=0,expiresAt=BASE+DAY}={}){
 let saves=0,saved=null;
 const store={load:async()=>{throw Error('Unexpected store.load in synthetic test')},save:async s=>{saves++;saved=structuredClone(s)}};
 const bridge=new BridgeModel({owner:OWNER,store,syncLog:()=>{}});
 bridge.state={version:1,owner:OWNER,phase:'armed',sessionToken:'capacity-synthetic-token',binding:{allowedSender:SENDER,accountScope:ACCOUNT},core:newState({ownerSubject:OWNER,accountScope:ACCOUNT,allowFrom:[SENDER],armedAt:BASE-10000,initialCursor:'capacity-original-cursor'}),queue:createQueue(OWNER),delivery:{},syncOutbox:history()};
 for(let i=0;i<retained;i++){
  const r=seedRecord(i,{expiresAt});bridge.state.queue.records[r.event.eventId]=r;
  bridge.state.delivery[r.event.eventId]={attempts:1,nextAt:BASE,done:true};
 }
 // Persisted JSON has plain objects, unlike createQueue/newState's null prototypes.
 bridge.state=structuredClone(bridge.state);
 return {bridge,saves:()=>saves,saved:()=>structuredClone(saved)};
}
async function capacityRejected(f,input,now=BASE){
 const original=f.bridge.state,before=structuredClone(original),saves=f.saves();
 await assert.rejects(f.bridge.ingest(OWNER,input,now),e=>e.code==='inbound_capacity');
 assert.equal(f.bridge.state,original,'a refused batch must not publish a replacement state');
 assert.deepEqual(f.bridge.state,before,'a refused batch must not mutate cursor, history or any queue record');
 assert.equal(f.saves(),saves,'capacity refusal must happen before store.save');
 assert.equal(f.bridge.writeFailure,false,'capacity refusal is recoverable');
 assert.doesNotThrow(()=>f.bridge.check(OWNER));
}
async function byteBoundary(target){
 const input=batch([wire('byte-boundary')]),reference=fixture();
 reference.bridge.state.syntheticPadding='';
 await reference.bridge.ingest(OWNER,input,BASE);
 const paddingBytes=target-bytes(reference.bridge.state);
 assert.ok(paddingBytes>0);
 const f=fixture();
 f.bridge.state.syntheticPadding='汉'.repeat(Math.floor(paddingBytes/3))+'x'.repeat(paddingBytes%3);
 // Use actual resulting JSON as the independent byte measurement; the payload
 // deliberately has far fewer JavaScript characters than its UTF-8 byte count.
 const expected=structuredClone(reference.bridge.state);
 expected.syntheticPadding=f.bridge.state.syntheticPadding;
 assert.equal(bytes(expected),target);
 assert.ok(JSON.stringify(expected).length<LIMIT);
 assert.ok(bytes(f.bridge.state)<LIMIT,'only the arriving event crosses the admission boundary');
 return {f,input,expected};
}

test('inbound capacity suite has real network entry points disabled',async()=>{
 await assert.rejects(fetch('https://example.invalid'),/TEST_NETWORK_DISABLED/);
});

for(const kind of ['text','media'])test('128 retained mixed events can receive new '+kind,async()=>{
 const f=fixture({retained:128}),old=structuredClone(f.bridge.state);
 assert.deepEqual(await f.bridge.ingest(OWNER,batch([wire('after-128-'+kind,kind)]),BASE),{accepted:1});
 assert.equal(liveCount(f.bridge.state),129);assert.equal(f.saves(),1);
 assert.equal(f.bridge.state.core.cursor,'capacity-next-cursor');
 for(const [id,r] of Object.entries(old.queue.records))assert.deepEqual(f.bridge.state.queue.records[id],r);
 assert.deepEqual(f.bridge.state.syncOutbox,old.syncOutbox);
});

for(const kind of ['text','media'])test('shared 1024 boundary admits the final '+kind+' and refuses the next',async()=>{
 const f=fixture({retained:1023});
 assert.deepEqual(await f.bridge.ingest(OWNER,batch([wire('at-1024-'+kind,kind)]),BASE),{accepted:1});
 assert.equal(liveCount(f.bridge.state),1024);
 assert.ok(bytes(f.bridge.state)<LIMIT-4096,'the count boundary remains below the byte boundary');
 await capacityRejected(f,batch([wire('over-1024-'+kind,kind)],'must-not-advance'));
});

test('a mixed text/media batch is wholly committed at 1024 and wholly refused above it',async()=>{
 const input=batch([wire('mixed-media','media'),wire('mixed-text')]);
 const fits=fixture({retained:1022});
 assert.deepEqual(await fits.bridge.ingest(OWNER,input,BASE),{accepted:2});
 assert.equal(liveCount(fits.bridge.state),1024);assert.equal(fits.saves(),1);
 const full=fixture({retained:1023});
 assert.ok(bytes(full.bridge.state)<LIMIT-4096,'the mixed count fixture has room under the byte limit');
 await capacityRejected(full,input);
 assert.equal(liveCount(full.bridge.state),1023);assert.equal(full.saves(),0);
});

test('exactly 7 MiB of final UTF-8 JSON is accepted',async()=>{
 const {f,input,expected}=await byteBoundary(LIMIT);
 assert.deepEqual(await f.bridge.ingest(OWNER,input,BASE),{accepted:1});
 assert.equal(bytes(f.bridge.state),LIMIT);assert.deepEqual(f.bridge.state,expected);
 assert.deepEqual(f.saved(),expected);assert.equal(f.saves(),1);assert.equal(f.bridge.writeFailure,false);
});

test('7 MiB plus one UTF-8 byte is refused without save, mutation or failstop',async()=>{
 const {f,input}=await byteBoundary(LIMIT+1);
 await capacityRejected(f,input);assert.equal(f.saves(),0);assert.equal(f.saved(),null);
});

test('retained-event capacity refusal recovers after expiry without dropping dedupe or unknown history',async()=>{
 const f=fixture({retained:1024,expiresAt:BASE+1000}),oldHistory=structuredClone(f.bridge.state.syncOutbox),input=batch([wire('after-expiry')]);
 assert.ok(bytes(f.bridge.state)<LIMIT-4096,'the expiry case must exercise the count limit');
 await capacityRejected(f,input);
 assert.deepEqual(await f.bridge.ingest(OWNER,input,BASE+1000),{accepted:1});
 assert.equal(f.saves(),1);assert.equal(liveCount(f.bridge.state),1);
 assert.equal(Object.keys(f.bridge.state.queue.records).length,1025);
 for(let i=0;i<1024;i++)assert.equal(f.bridge.state.queue.records['capacity_seed_'+i].event,undefined);
 assert.deepEqual(f.bridge.state.syncOutbox,oldHistory);assert.equal(f.bridge.writeFailure,false);
});

test('byte-capacity refusal recovers when an expired retained body is purged',async()=>{
 const f=fixture({retained:1,expiresAt:BASE+1000}),r=f.bridge.state.queue.records.capacity_seed_0;
 r.replyText='汉'.repeat(Math.ceil(LIMIT/3));
 const input=batch([wire('after-byte-expiry')]),oldHistory=structuredClone(f.bridge.state.syncOutbox);
 await capacityRejected(f,input);
 assert.deepEqual(await f.bridge.ingest(OWNER,input,BASE+1000),{accepted:1});
 assert.equal(f.saves(),1);assert.ok(bytes(f.bridge.state)<LIMIT);
 assert.equal(f.bridge.state.queue.records.capacity_seed_0.replyText,undefined);
 assert.equal(f.bridge.state.queue.records.capacity_seed_0.event,undefined);
 assert.deepEqual(f.bridge.state.syncOutbox,oldHistory);assert.equal(f.bridge.writeFailure,false);
});

test('4096 dedupe identities remain the limit while a retained duplicate is harmless',async()=>{
 const f=fixture();
 for(let i=0;i<4095;i++)f.bridge.state.queue.records['capacity_tombstone_'+i]={textUntil:BASE-1,dedupeUntil:BASE+DAY};
 const input=batch([wire('dedupe-last')]);
 assert.deepEqual(await f.bridge.ingest(OWNER,input,BASE),{accepted:1});
 assert.equal(Object.keys(f.bridge.state.queue.records).length,4096);
 await capacityRejected(f,batch([wire('dedupe-overflow')],'refused-cursor'));
 assert.deepEqual(await f.bridge.ingest(OWNER,batch(input.msgs,'duplicate-cursor'),BASE),{accepted:0});
 assert.equal(Object.keys(f.bridge.state.queue.records).length,4096);
 assert.equal(f.bridge.state.core.cursor,'duplicate-cursor');assert.equal(f.bridge.writeFailure,false);
});

test('owner and text/media sender, recipient and group restrictions survive the increased capacity',async()=>{
 const f=fixture({retained:128}),before=structuredClone(f.bridge.state);
 await assert.rejects(f.bridge.ingest('different-owner',batch([wire('wrong-owner')]),BASE),/Owner required/);
 assert.deepEqual(f.bridge.state,before);assert.equal(f.saves(),0);
 const invalid=[];
 for(const kind of ['text','media']){
  invalid.push({...wire('wrong-sender-'+kind,kind),from_user_id:'different-sender'});
  invalid.push({...wire('wrong-recipient-'+kind,kind),to_user_id:'different-account'});
  invalid.push({...wire('group-'+kind,kind),group_id:'synthetic-group'});
 }
 assert.deepEqual(await f.bridge.ingest(OWNER,batch(invalid),BASE),{accepted:0});
 assert.equal(liveCount(f.bridge.state),128);
 assert.deepEqual(f.bridge.state.queue,before.queue);assert.deepEqual(f.bridge.state.syncOutbox,before.syncOutbox);
});

test('mock poll runs through parse, normalization, ingest and local delivery above the old limit',async()=>{
 const f=fixture({retained:128}),oldHistory=structuredClone(f.bridge.state.syncOutbox),stages=[];
 let calls=0,deliveries=0,sends=0;
 const runtime=new WechatRuntime({bridge:f.bridge,owner:OWNER,clock:()=>BASE,
  events:{deliver:async()=>{deliveries++;return {accepted:true}}},
  poll:args=>pollOnce({...args,transport:async()=>{calls++;return new Response(JSON.stringify(batch([wire('poll-text'),wire('poll-media','media')])));}}),
  sendSync:async()=>{sends++;throw Error('Unexpected outbound operation')},
  janitor:{start:async()=>{},reschedule(){},stop(){}},schedule:()=>({unref(){}}),cancel(){},onStage:(stage,elapsed,category)=>stages.push({stage,category})});
 try{
  await runtime.start();await runtime.step();
  assert.equal(calls,1);assert.equal(deliveries,2);assert.equal(sends,0);
  assert.equal(liveCount(f.bridge.state),130);assert.equal(f.bridge.state.core.cursor,'capacity-next-cursor');
  assert.ok(stages.some(x=>x.stage==='wechat_poll_ok'));assert.ok(!stages.some(x=>x.stage==='wechat_poll_error'));
  assert.deepEqual(f.bridge.state.syncOutbox,oldHistory);assert.equal(f.bridge.syncDeliveryControl.status(OWNER).paused,true);
 }finally{await runtime.stopAndWait()}
});
