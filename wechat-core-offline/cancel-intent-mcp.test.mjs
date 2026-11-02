import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueue,enqueue} from './retention.mjs';
import {enqueueSync,claimSync,finishSync} from './sync-outbox.mjs';
import {BridgeModel} from './bridge-model-live.mjs';
import {makeHandler} from './mcp-events.mjs';
import {WechatRuntime} from '../wechat-live-stage/wechat-runtime-live.mjs';
test('MCP cancel records intent without changing unknown delivery evidence',async()=>{
 const owner='fixture-owner',now=Date.now(),s={version:1,owner,phase:'armed',queue:createQueue(owner),delivery:{}};
 function add(id,time,text){enqueue(s.queue,owner,{eventId:id,name:'weixin.owner_text',timestamp:new Date(time).toISOString(),data:{conversation_id:'weixin-self',message_id:id,simulation:false,text}},{to_user_id:'fixture-user',accountScope:'fixture-scope',source_message_id:id,context_token:'fixture-context-'+id},time);}
 add('old',now-5000,'old');const a=enqueueSync(s,{sourceId:'fixture-one',role:'assistant',text:'private-payload',eventId:'old'},now-4500),claim=claimSync(s,now-4400);finishSync(s,claim,'uncertain',now-4300);add('cancel',now-2000,'do not resend');const b=enqueueSync(s,{sourceId:'fixture-two',role:'assistant',text:'new',eventId:'cancel'},now-1000);
 let saved=structuredClone(s);const store={save:async x=>{saved=structuredClone(x)},load:async()=>structuredClone(saved)},bridge=new BridgeModel({owner,store});await bridge.load();const events={list:async()=>({events:[]})},h=makeHandler({events,actor:owner,bridge});const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'fixture',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
 async function call(method,params){const r=await h.fetch(new Request('http://127.0.0.1/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':method,...(params.name?{'mcp-name':params.name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:meta}})}));return (await r.json()).result;}
 try{const list=await call('tools/list',{});assert.ok(list.tools.some(t=>t.name==='cancel_uncertain_sync_delivery'));const r=await call('tools/call',{name:'cancel_uncertain_sync_delivery',arguments:{syncId:a.syncId,confirmationEventId:'cancel',ownerConfirmedCancel:true}});assert.equal(r.isError,undefined);const body=JSON.parse(r.content[0].text);assert.equal(body.state,'uncertain');assert.equal(body.deliveryIntent,'cancelled');assert.ok(!JSON.stringify(r).includes('private-payload'));assert.equal(saved.syncOutbox.records[a.syncId].parts[0].state,'uncertain');const runtime=new WechatRuntime({bridge,owner,events:{deliver:async()=>({accepted:true})},clock:()=>now,schedule:()=>({unref(){}}),cancel(){},poll:async()=>{},sendSync:async()=>{throw Error('Unexpected send')},janitor:{start:async()=>{},reschedule(){},stop(){}}});await runtime.start();await runtime.step();assert.equal(bridge.syncDeliveryControl.status(owner).paused,true);assert.equal(saved.syncOutbox.records[b.syncId].state,'queued');await runtime.stopAndWait();}finally{await h.close();}
});

test('MCP 只取消明确列出的纯排队项，不能解除未知队首',async()=>{
 const owner='fixture-owner',now=Date.now(),s={version:1,owner,phase:'armed',queue:createQueue(owner),delivery:{}};
 enqueue(s.queue,owner,{eventId:'owner-event',name:'weixin.owner_text',timestamp:new Date(now-5000).toISOString(),data:{conversation_id:'weixin-self',message_id:'owner-event',simulation:false,text:'fixture'}},{to_user_id:'fixture-user',accountScope:'fixture-scope',source_message_id:'owner-event',context_token:'fixture-context'},now-5000);
 const unknown=enqueueSync(s,{sourceId:'unknown',role:'assistant',text:'one',eventId:'owner-event'},now-4000),claim=claimSync(s,now-3900);finishSync(s,claim,'uncertain',now-3800);
 const a=enqueueSync(s,{sourceId:'queued-one',role:'assistant',text:'two',eventId:'owner-event'},now-3000),b=enqueueSync(s,{sourceId:'queued-two',role:'user',text:'three',eventId:'owner-event'},now-2000);
 let saved=structuredClone(s);const store={save:async x=>{saved=structuredClone(x)},load:async()=>structuredClone(saved)},bridge=new BridgeModel({owner,store});await bridge.load();const runtime=new WechatRuntime({bridge,owner,events:{deliver:async()=>({accepted:true})},janitor:{start:async()=>{},reschedule(){},stop(){}},schedule:()=>({unref(){}}),cancel(){},poll:async()=>{},sendSync:async()=>{throw Error('网络调用不可用')}});await runtime.start();const h=makeHandler({events:{list:async()=>({events:[]})},actor:owner,bridge});const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'fixture',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
 async function call(name,args){const r=await h.fetch(new Request('http://127.0.0.1/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':name},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:meta}})}));return (await r.json()).result;}
 try{
  const item=x=>({syncId:x.syncId,sequence:saved.syncOutbox.records[x.syncId].sequence}),operationId='cancel-operation-0001',epoch=bridge.syncDeliveryControl.status(owner).epoch;
  assert.equal((await call('cancel_queued_sync_deliveries',{items:[item(unknown),item(a)],epoch,operationId,ownerConfirmedCancelQueued:true})).isError,true);
  assert.equal(saved.syncOutbox.records[a.syncId].deliveryIntent,undefined);
  assert.equal((await call('cancel_queued_sync_deliveries',{items:[item(a),item(b)],epoch,operationId,ownerConfirmedCancelQueued:true})).isError,undefined);
  assert.equal(saved.syncOutbox.records[a.syncId].deliveryIntent,'cancelled');assert.equal(saved.syncOutbox.records[b.syncId].deliveryIntent,'cancelled');
  assert.equal((await call('resume_empty_chatgpt_sync',{epoch:'a'.repeat(32),operationId:'resume-operation-0001',ownerConfirmed:true,ownerConfirmedResolutionReview:true})).isError,true);assert.equal(saved.syncOutbox.records[unknown.syncId].state,'uncertain');
 }finally{await h.close();await runtime.stopAndWait();}
});
