import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as z from 'zod/v4';
import {createQueue,enqueue} from './retention.mjs';
import {BridgeModel} from './bridge-model-live.mjs';
import {createWechatMediaTools} from './wechat-mcp-media.mjs';
import {MediaTransfers} from './media-transfer.mjs';
import {replyOnce} from './transport-live.mjs';
import {CONTEXT_NOTICE_SUFFIX} from './context-budget.mjs';

const owner='synthetic-owner',base=1700000000000,recipient='synthetic-recipient',scope='synthetic-scope';
function add(q,id,time,token){enqueue(q,owner,{eventId:id,name:'weixin.owner_text',timestamp:new Date(time).toISOString(),data:{conversation_id:'weixin-self',message_id:id,simulation:false,text:'fixture'}},{to_user_id:recipient,accountScope:scope,context_token:token,source_message_id:id},time)}
function server(){const tools=new Map();return {tools,registerTool(name,_options,fn){tools.set(name,fn)}}}
function result(value){return JSON.parse(value.content[0].text)}
async function setup({kind='file',notice='sent',media='sent',fill=8}={}){
 let time=base,saved;const q=createQueue(owner);add(q,'original',time,'old-token');saved={version:1,owner,phase:'armed',sessionToken:'synthetic-token',queue:q,delivery:{}};
 const store={save:async x=>{saved=structuredClone(x)},load:async()=>structuredClone(saved)},bridge=new BridgeModel({owner,store});await bridge.load();
 for(let i=0;i<fill;i++)await bridge.replyDraft(owner,'original',`body-${i}`,`text-${i}`,time,()=>time);
 const wakes=[],notices=[],uploads=[];
 const notify=args=>replyOnce({...args,transport:async(_url,options)=>{notices.push(JSON.parse(options.body).msg.item_list[0].text_item.text);if(notice==='uncertain')throw new Error('synthetic network failure');return new Response('{"ret":0}',{status:200})}});
 const tools=createWechatMediaTools({z,owner,bridge,clock:()=>time,notify,validate:async()=>({mimeType:'image/png',width:1,height:1}),schedule:fn=>{wakes.push(fn);return {unref(){}}},cancel:()=>{},upload:async args=>{uploads.push({context:args.contextToken,deadline:args.deadline});if(media==='uncertain')throw new Error('synthetic unknown');if(media==='rejected')throw Object.assign(new Error('synthetic rejection'),{code:'upstream_media_rejected'})}}),m=server();tools.register(m);
 const bytes=Buffer.from('synthetic-media'),sha=createHash('sha256').update(bytes).digest('hex'),u=result(await m.tools.get('begin_wechat_media_upload')({eventId:'original',idempotencyKey:'media-key',kind,fileName:kind==='image'?'fixture.png':'fixture.txt',size:bytes.length,sha256:sha}));
 await m.tools.get('append_wechat_media_upload')({uploadId:u.uploadId,offset:0,dataBase64:bytes.toString('base64')});await m.tools.get('finish_wechat_media_upload')({uploadId:u.uploadId});
 return {bridge,tools,wakes,notices,uploads,u,send:async()=>{const r=await m.tools.get('send_wechat_media_upload')({uploadId:u.uploadId});try{return result(r)}catch{return {state:'unavailable',isError:r.isError===true}}},add:(id,token)=>{time++;add(bridge.state.queue,id,time,token)},setTime:t=>{time=t}};
}

for(const kind of ['file','image'])test(`${kind} 第九位仅发一次提醒，不同上下文后自动发送一次`,async()=>{
 const f=await setup({kind});try{
  const first=await f.send();assert.equal(first.reason,'waiting_new_owner_context');assert.equal(first.noticeState,'upstream_accepted');assert.equal(first.mediaAttemptStarted,false);assert.equal(f.notices.length,1);assert.ok(f.notices[0].startsWith('(9/9) '));assert.ok(f.notices[0].endsWith(CONTEXT_NOTICE_SUFFIX));assert.equal(f.uploads.length,0);
  await f.send();assert.equal(f.notices.length,1);f.add('same-token','old-token');await f.wakes.shift()();assert.equal(f.uploads.length,0);assert.equal(f.wakes.length,1);
  f.add('new-token','new-token');await f.wakes.shift()();assert.equal(f.uploads.length,1);assert.equal(f.uploads[0].context,'new-token');assert.ok(f.uploads[0].deadline<=f.u.expiresAt);assert.equal((await f.send()).state,'sent');assert.equal(f.uploads.length,1);
 }finally{f.tools.close()}
});

test('提醒结果未知也不重发提醒；媒体尚未尝试时可在新上下文续发',async()=>{
 const f=await setup({notice:'uncertain'});try{const first=await f.send();assert.equal(first.noticeState,'uncertain');assert.equal(f.notices.length,1);await f.send();assert.equal(f.notices.length,1);f.add('new-token','new-token');await f.wakes.shift()();assert.equal(f.uploads.length,1);assert.equal((await f.send()).state,'sent');assert.equal(f.notices.length,1);}finally{f.tools.close()}
});

test('媒体一旦进入未知状态，新的上下文也不能自动重发',async()=>{
 const f=await setup({fill:0,media:'uncertain'});try{assert.equal((await f.send()).state,'uncertain');assert.equal(f.uploads.length,1);f.add('new-token','new-token');assert.equal((await f.send()).state,'uncertain');assert.equal(f.uploads.length,1);assert.equal(f.wakes.length,0);}finally{f.tools.close()}
});

test('媒体请求被上游拒绝后保留未知结果，不因新上下文重发',async()=>{
 const f=await setup({fill:0,media:'rejected'});try{assert.equal((await f.send()).state,'uncertain');assert.equal(f.uploads.length,1);f.add('new-token','new-token');assert.equal((await f.send()).state,'uncertain');assert.equal(f.uploads.length,1);assert.equal(f.wakes.length,0);}finally{f.tools.close()}
});

test('等待期间到达原缓存截止时间后清除媒体，不自动上传',async()=>{
 const f=await setup();try{const first=await f.send();assert.equal(first.expiresAt,f.u.expiresAt);f.setTime(f.u.expiresAt+1);await f.wakes.shift()();assert.equal(f.uploads.length,0);assert.equal((await f.send()).state,'unavailable');}finally{f.tools.close()}
});

test('进程关闭后不保留待发媒体，也不在新上下文出现时自动重传',async()=>{
 const f=await setup();const first=await f.send();assert.equal(first.reason,'waiting_new_owner_context');f.tools.close();f.add('new-token','new-token');await f.wakes.shift()();assert.equal(f.uploads.length,0);assert.equal((await f.send()).state,'unavailable');
});

test('多个媒体并发争夺第九位时最多只发送一次提醒',async()=>{
 let time=base,saved;const q=createQueue(owner);add(q,'original',time,'old-token');saved={version:1,owner,phase:'armed',sessionToken:'synthetic-token',queue:q,delivery:{}};const store={save:async x=>{saved=structuredClone(x)},load:async()=>structuredClone(saved)},bridge=new BridgeModel({owner,store});await bridge.load();for(let i=0;i<8;i++)await bridge.replyDraft(owner,'original',`body-${i}`,`text-${i}`,time,()=>time);
 const wakes=[],notices=[],uploads=[],notify=args=>replyOnce({...args,transport:async(_url,options)=>{notices.push(JSON.parse(options.body).msg.item_list[0].text_item.text);return new Response('{"ret":0}',{status:200})}}),tools=createWechatMediaTools({z,owner,bridge,clock:()=>time,notify,schedule:fn=>{wakes.push(fn);return {unref(){}}},cancel:()=>{},upload:async args=>{uploads.push(args.contextToken)}}),m=server();tools.register(m);
 try{
  const ids=[];for(const key of ['media-one','media-two']){const bytes=Buffer.from(key),sha=createHash('sha256').update(bytes).digest('hex');const u=result(await m.tools.get('begin_wechat_media_upload')({eventId:'original',idempotencyKey:key,kind:'file',fileName:key+'.txt',size:bytes.length,sha256:sha}));await m.tools.get('append_wechat_media_upload')({uploadId:u.uploadId,offset:0,dataBase64:bytes.toString('base64')});await m.tools.get('finish_wechat_media_upload')({uploadId:u.uploadId});ids.push(u.uploadId);}
  const blocked=await Promise.all(ids.map(uploadId=>m.tools.get('send_wechat_media_upload')({uploadId})));assert.ok(blocked.every(x=>result(x).reason==='waiting_new_owner_context'));assert.equal(notices.length,1);assert.equal(uploads.length,0);
  time++;add(bridge.state.queue,'fresh',time,'new-token');const pending=wakes.splice(0);await Promise.all(pending.map(wake=>wake()));assert.equal(uploads.length,2);assert.deepEqual(uploads,['new-token','new-token']);
 }finally{tools.close()}
});

test('续传时上下文再次发生竞争，仍等待并在稳定后续传',async()=>{
 const wakes=[],bytes=Buffer.from('fixture'),sha256=createHash('sha256').update(bytes).digest('hex');let attempts=0;
 const service=new MediaTransfers({owner,clock:()=>base,readIncoming:async()=>{},checkTarget:async()=>({expiresAt:base+60000}),waitForNewContext:async()=>true,schedule:fn=>{wakes.push(fn);return {unref(){}}},cancel:()=>{},sendMedia:async()=>{attempts++;if(attempts===1)throw Object.assign(new Error('waiting'),{code:'context_budget_exhausted'});if(attempts===2)throw Object.assign(new Error('race'),{code:'context_order_ambiguous'});return {state:'sent'}}});
 try{const u=await service.begin(owner,{eventId:'original',idempotencyKey:'race-media',kind:'file',fileName:'x.txt',size:bytes.length,sha256});service.append(owner,{uploadId:u.uploadId,offset:0,dataBase64:bytes.toString('base64')});await service.finish(owner,{uploadId:u.uploadId});assert.equal((await service.send(owner,{uploadId:u.uploadId})).reason,'waiting_new_owner_context');await wakes.shift()();assert.equal(wakes.length,1);await wakes.shift()();assert.equal((await service.send(owner,{uploadId:u.uploadId})).state,'sent');assert.equal(attempts,3);}finally{service.close()}
});

test('本地测试默认网络入口被禁用',async()=>{await assert.rejects(fetch('https://example.invalid'),/TEST_NETWORK_DISABLED/)});
