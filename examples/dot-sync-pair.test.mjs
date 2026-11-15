import test from 'node:test';
import assert from 'node:assert/strict';
import syncPair from './dot-sync-pair.mjs';

// 用可控门闩验证先后依赖，不以机器快慢判断是否真正并行。
const latch = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

// 全部使用内存桩，不连接平台、不预占实际来源、不发送微信。
function fixture(overrides = {}) {
  const now = Date.now();
  const input = { questionId: 'q', answerId: 'a', roomId: 'example-room',
    eventId: 'event', linkId: 'example-link', ordinaryAuthorizedTurn: true, conversationCursor: 'cursor' };
  const tasks = {
    'example-receiver': [true, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    'example-old-listener': [false, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
    'example-old-recovery': [false, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc']
  };
  input.configuration = {roomId:'example-room',linkId:'example-link',ownerAuthorId:'user-example',assistantAuthorId:'assistant-example',writers:Object.entries(tasks).map(([id,[enabled,version]])=>[id,enabled,version])};
  const message = id => ({ message_id: id, author: id === 'q' ? 'user' : 'aeon',
    author_id: id === 'q' ? 'user-example' : 'assistant-example',
    content: { text: id }, sent_at: new Date(now - (id === 'q' ? 1000 : 500)).toISOString() });
  const calls = [];
  const value = object => ({ content: [{ type: 'text', text: JSON.stringify(object) }] });
  const methods = {
    read_messages: () => ({ room_id: input.roomId, message: message('q'), after: [message('a')], before: [], partial: false }),
    automations_get: p => ({ structuredContent: { automation: { id: p.automation_id, is_enabled: tasks[p.automation_id][0] },
      contextVersion: tasks[p.automation_id][1] }, isError: false }),
    list_recent_wechat_conversation: () => ({ entries: [], nextCursor: null, resumeCursor: 'cursor2' }),
    get_wechat_event: () => ({ eventId: 'event', name: 'weixin.owner_text', timestamp: new Date(now - 2000).toISOString(),
      data: { conversation_id: 'weixin-self', simulation: false } }),
    minihome_prepare_verified_sync_submission: p => ({ acquired:true,firstSubmissionClaim:true,
      contentDigest:'a'.repeat(64),submission:{...p,contentDigest:'a'.repeat(64)},
      observation:{durableReadBack:true,observedMetadata:{...p,contentDigest:'a'.repeat(64)}},
      history:{status:'not_recorded',coverage:{historyCoverage:'complete_for_source_window'},
      directAttemptCoverage:{historyCoverage:'complete_for_source_window',reservationCount:0,status:'none_observed',attributionComplete:true,hasMore:false}} }),
    enqueue_chatgpt_sync_message: () => ({ state: 'queued' }),
    minihome_record_sync_source_result: () => ({ saved: true }),
    ...overrides
  };
  const tools = Object.fromEntries(Object.entries(methods).map(([name, fn]) => [
    (name === 'read_messages' ? 'mcp__codex_apps__user_message_' : name === 'automations_get' ? 'mcp__codex_apps__' : 'mcp__codex_apps__mcp_') + name,
    async args => { calls.push({ name, args }); const result = await fn(args); return result?.isError ? result : value(result); }
  ]));
  return { tools, input, calls, message, methods };
}


test('每轮只用两次合并调用代替六次分步，保持原发送顺序',async()=>{
 const f=fixture(),r=await syncPair(f.tools,f.input);
 assert.equal(r.sources.assistant.state,'queued');
 assert.equal(f.calls.length,12);
 assert.equal(f.calls.filter(x=>x.name==='minihome_prepare_verified_sync_submission').length,2);
 assert.deepEqual(f.calls.filter(x=>x.name==='enqueue_chatgpt_sync_message').map(x=>x.args.sourceId),['q','a']);
 assert.equal(r.preparations.user.history.status,'not_recorded');
});
for(const failure of ['event','writers','source'])test('外部核验失败不调用合并接口：'+failure,async()=>{
 const f=fixture();
 if(failure==='event')f.tools.mcp__codex_apps__mcp_get_wechat_event=async()=>({structuredContent:{eventId:'wrong'}});
 if(failure==='writers')f.tools.mcp__codex_apps__automations_get=async()=>({structuredContent:{}});
 if(failure==='source')f.input.answerId='missing';
 const r=await syncPair(f.tools,f.input);assert.equal(r.stoppedAt,failure);
 assert.ok(!f.calls.some(x=>/prepare|enqueue/.test(x.name)));
});
test('完整历史不通过或预占响应未知不入队',async()=>{
 for(const response of [{acquired:false,firstSubmissionClaim:false},{acquired:true,firstSubmissionClaim:true}]){
 const f=fixture({minihome_prepare_verified_sync_submission:()=>response});
 await syncPair(f.tools,f.input);assert.ok(!f.calls.some(x=>x.name==='enqueue_chatgpt_sync_message'));
 }
});
test('问题入队失败仍等待回答合并调用，不产生补发',async()=>{
 const f=fixture();let finished=false;
 const original=f.methods.minihome_prepare_verified_sync_submission;
 f.tools.mcp__codex_apps__mcp_minihome_prepare_verified_sync_submission=async p=>{
 if(p.sourceId==='a'){await new Promise(r=>setTimeout(r,20));finished=true;}
 return {structuredContent:original(p)};
 };
 f.tools.mcp__codex_apps__mcp_enqueue_chatgpt_sync_message=async()=>({isError:true,content:[{type:'text',text:'upstream_timeout'}]});
 const r=await syncPair(f.tools,f.input);assert.equal(r.stoppedAt,'enqueue-user');assert.equal(finished,true);
});
test('回答合并被拒绝时仍等待问题回写，保留原状态',async()=>{
 const f=fixture();const original=f.methods.minihome_prepare_verified_sync_submission;
 f.tools.mcp__codex_apps__mcp_minihome_prepare_verified_sync_submission=async p=>({structuredContent:p.sourceId==='a'?{acquired:false}:original(p)});
 const r=await syncPair(f.tools,f.input);assert.equal(r.sources.user.state,'queued');
 assert.equal(r.sources.assistant.prepare,'not_acquired');assert.deepEqual(r.recordResults,['fulfilled']);
});

test('近期只读查询明确内部错误后只恢复一次，原错误与调用参数保留',async()=>{
 let reads=0;
 const f=fixture({list_recent_wechat_conversation:()=>++reads===1?{isError:true,content:[{type:'text',text:'tool call error: tool call failed for `codex_apps/mcp.list_recent_wechat_conversation`\n\nCaused by:\n    Mcp error: -32603: Internal error'}]}:{entries:[],nextCursor:null,resumeCursor:'cursor2'}});
 const r=await syncPair(f.tools,f.input);assert.equal(r.sources.assistant.state,'queued');
 assert.equal(r.readRecovery.recovered,true);assert.equal(r.errors[0].code,-32603);
 const calls=f.calls.filter(x=>x.name==='list_recent_wechat_conversation');assert.equal(calls.length,2);assert.deepEqual(calls[0].args,calls[1].args);
});
test('连续内部错误只读两次后停止，拒绝和未知错误只读一次',async()=>{
 for(const [text,count] of [['Mcp error: -32603: Internal error',2],['approval_denied',1],['unknown_failure',1],['denied: Mcp error: -32603: Internal error',1]]){
  const f=fixture({list_recent_wechat_conversation:()=>({isError:true,content:[{type:'text',text}]})});
  const r=await syncPair(f.tools,f.input);assert.equal(r.stoppedAt,'read');
  assert.equal(f.calls.filter(x=>x.name==='list_recent_wechat_conversation').length,count);
  assert.ok(!f.calls.some(x=>/prepare|enqueue/.test(x.name)));
 }
});
test('预占和发送的内部错误不重试',async()=>{
 for(const method of ['minihome_prepare_verified_sync_submission','enqueue_chatgpt_sync_message']){
  const f=fixture({[method]:()=>({isError:true,content:[{type:'text',text:'Mcp error: -32603: Internal error'}]})});
  const r=await syncPair(f.tools,f.input);
  assert.equal(f.calls.filter(x=>x.name===method&&x.args.sourceId==='q').length,1);
  assert.equal(r.errors[0].code,-32603);
 }
});
test('缓存与事件索引全丢失后从完整真实分页重建，不伪造事件',async()=>{
 const f=fixture({list_recent_wechat_conversation:p=>p.after===null?
  {entries:[],nextCursor:'next',resumeCursor:'next'}:
  {entries:[{source:'wechat',eventId:'event',receivedAt:Date.now()-2000}],nextCursor:null,resumeCursor:'latest'}});
 delete f.input.eventId;delete f.input.conversationCursor;
 const r=await syncPair(f.tools,f.input);
 assert.equal(r.sources.assistant.state,'queued');assert.equal(r.contextBootstrap.used,true);
 assert.equal(r.contextBootstrap.pages,2);assert.deepEqual(r.context,{eventId:'event',conversationCursor:'latest'});
 assert.deepEqual(f.calls.filter(x=>x.name==='list_recent_wechat_conversation').map(x=>x.args.after),[null,'next']);
});
test('缓存丢失且没有本人事件、分页循环或分页超限均不预占',async()=>{
 for(const mode of ['empty','loop','limit']){
  let count=0;const f=fixture({list_recent_wechat_conversation:()=>({entries:[],resumeCursor:'cursor',nextCursor:mode==='empty'?null:mode==='loop'?'same':String(++count)})});
  delete f.input.eventId;delete f.input.conversationCursor;
  const r=await syncPair(f.tools,f.input);assert.ok(r.stoppedAt);
  assert.ok(!f.calls.some(x=>/prepare|enqueue/.test(x.name)));
  assert.ok(f.calls.length<=24);
 }
});
