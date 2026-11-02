import test from 'node:test';
import assert from 'node:assert/strict';
import {makeHandler} from './mcp-events.mjs';

test('MCP advertises and calls owner status tool without exposing message content',async()=>{
  const owner='fixture-owner', key='fixture-key', events={list:async()=>({events:[]})};
  const state={owner,phase:'armed',queue:{records:{}},syncOutbox:{records:{one:{expiresAt:Date.now()+10000,state:'queued',parts:[{key,state:'queued',text:'private-payload'}]}}}};
  const bridge={owner,state,locked:async fn=>fn()};
  const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'fixture',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
  const h=makeHandler({events,actor:owner,bridge});
  async function call(method,params){const r=await h.fetch(new Request('http://127.0.0.1/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':method,...(params.name?{'mcp-name':params.name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:meta}})}));return (await r.json()).result;}
  try{const list=await call('tools/list',{});assert.ok(list.tools.some(t=>t.name==='get_wechat_reply_status'));const result=await call('tools/call',{name:'get_wechat_reply_status',arguments:{idempotencyKey:key}});assert.equal(JSON.parse(result.content[0].text).state,'not_attempted_by_queue');assert.ok(!JSON.stringify(result).includes('private-payload'));}finally{await h.close();}
});
