import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeHandler} from '../mcp-events.mjs';
import {createMinihomeSourceLedger} from './minihome-source-ledger.mjs';

test('微信 MCP 挂载共享来源账本，不改变原有工具',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mcp-ledger-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const events={list:async()=>({events:[]}),testDelivery:async()=>({accepted:false})};
 const file=join(dir,'sources.sqlite'),ledger=createMinihomeSourceLedger({file,roomId:'fixture_room'});
 const handler=makeHandler({events,actor:'fixture_owner',sourceLedger:ledger});
 async function call(method,params={}){
  const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'fixture',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
  const headers={'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':method};
  if(params.name)headers['mcp-name']=params.name;
  const response=await handler.fetch(new Request('http://127.0.0.1/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:meta}})}));
  assert.equal(response.status,200);return response.json();
 }
 try{
  const names=(await call('tools/list')).result.tools.map(tool=>tool.name);
  assert.ok(names.includes('enqueue_chatgpt_sync_message'));
  assert.ok(names.includes('minihome_capture_sync_source_observation'));
  const status=await call('tools/call',{name:'minihome_get_sync_source_storage',arguments:{}});
  assert.equal(JSON.parse(status.result.content[0].text).roomId,'fixture_room');
 }finally{await handler.close()}
});
