import test from 'node:test';
import assert from 'node:assert/strict';
import {McpServer,createMcpHandler} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {McpRequestTracer,isInspectableTool,dispatchWithDiagnostics} from './mcp-request-diagnostics.mjs';
import {createBoundedDiagnosticWriter,getDiagnosticWriterHealth} from './safe-diagnostics.mjs';
import {makeHandler} from './mcp-events.mjs';

const id='0123456789abcdef',secret='synthetic_private_marker',ctx={requestId:id,method:'tools/call',tool:'get_wechat_event',startedAt:1000};
const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'fixture',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
function request(method,params){return new Request('http://127.0.0.1/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':method,...(params.name?{'mcp-name':params.name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,_meta:meta}})});}
function response(value,type='application/json'){return new Response(type==='application/json'?JSON.stringify(value):`data: ${JSON.stringify(value)}\n\n`,{status:200,headers:{'content-type':type}})}

test('默认网络入口被测试保护拦截',async()=>{await assert.rejects(fetch('https://example.invalid'),/TEST_NETWORK_DISABLED/);});
test('仅允许固定字段和工具名，敏感输入不进入记录',()=>{
 const t=new McpRequestTracer({clock:()=>1000});assert.equal(t.record({...ctx,stage:'dispatch',body:secret,token:secret,headers:secret,url:secret,error:secret}),true);t.record({...ctx,stage:'dispatch',tool:secret,method:secret});
 const value=t.snapshot();assert.equal(value.events[1].tool,'other');assert.equal(value.events[1].method,'other');assert.ok(!JSON.stringify(value).includes(secret));assert.equal(t.record({...ctx,requestId:secret,stage:'dispatch'}),false);
});
test('并发请求的随机标识不串线，未知错误码不会被记录',async()=>{
 const t=new McpRequestTracer({clock:()=>1010}),a={...ctx,requestId:'aaaaaaaaaaaaaaaa'},b={...ctx,requestId:'bbbbbbbbbbbbbbbb'};
 await Promise.all([t.run(a,async()=>{await new Promise(resolve=>setTimeout(resolve,3));t.sdkError(new Error('Failed to encode result for '+secret));}),t.run(b,async()=>{await Promise.resolve();t.sdkError(new Error(secret));})]);
 await t.inspect(response({error:{code:987654321,message:secret}}),a);const events=t.snapshot().events;assert.equal(events.find(x=>x.requestId===a.requestId&&x.stage==='sdk_error').errorClass,'encoding_failure');assert.equal(events.find(x=>x.requestId===b.requestId).errorClass,'sdk_error');assert.equal(events.at(-1).rpcCode,undefined);assert.ok(!JSON.stringify(events).includes(secret));
});
test('内存记录遵循上限和不超过 24 小时的期限',()=>{
 let time=1000;const t=new McpRequestTracer({clock:()=>time,maxEvents:2,ttlMs:100});for(let i=0;i<3;i++){time++;t.record({...ctx,stage:'dispatch'});}assert.equal(t.snapshot().events.length,2);time+=100;assert.equal(t.snapshot().events.length,0);
 assert.throws(()=>new McpRequestTracer({ttlMs:86400001}));
});
test('只检查允许的只读工具响应，区分工具错误和 JSON-RPC 错误',async()=>{
 assert.equal(isInspectableTool('tools/call','get_wechat_event'),true);assert.equal(isInspectableTool('tools/call','send_wechat_media_upload'),false);
 const t=new McpRequestTracer({clock:()=>1010});await t.inspect(response({result:{content:[{type:'text',text:secret}],isError:true}}),ctx);await t.inspect(response({error:{code:-32603,message:secret}},'text/event-stream'),ctx);
 const events=t.snapshot().events;assert.equal(events[0].result,'tool_error');assert.equal(events[1].result,'rpc_error');assert.equal(events[1].rpcCode,-32603);assert.ok(!JSON.stringify(events).includes(secret));
});
test('诊断分派不改变原始响应，关闭时不产生记录',async()=>{
 const t=new McpRequestTracer({clock:()=>1010});let calls=0;const perform=async()=>{calls++;return response({result:{content:[{type:'text',text:secret}]}})};
 const disabled=await dispatchWithDiagnostics(t,ctx,perform,false);await disabled.inspection;assert.equal(t.snapshot().events.length,0);assert.equal((await disabled.response.json()).result.content[0].text,secret);
 const enabled=await dispatchWithDiagnostics(t,ctx,perform,true);await enabled.inspection;assert.equal((await enabled.response.json()).result.content[0].text,secret);assert.equal(calls,2);assert.deepEqual(t.snapshot().events.map(x=>x.stage),['dispatch','complete']);assert.ok(!JSON.stringify(t.snapshot()).includes(secret));
});
test('诊断自身异常不能中断请求或重复调用处理器',async()=>{
 let calls=0;const perform=async()=>{calls++;return response({result:{}})};
 const broken={clock:()=>{throw new Error('clock')},record:()=>{throw new Error('record')},run:()=>{throw new Error('before invoke')},inspect:()=>{throw new Error('inspect')}};
 const result=await dispatchWithDiagnostics(broken,ctx,perform,true);await result.inspection;assert.equal(calls,1);assert.deepEqual(await result.response.json(),{result:{}});
 const afterInvoke={...broken,run:(_context,fn)=>fn()};await assert.rejects(dispatchWithDiagnostics(afterInvoke,ctx,async()=>{calls++;throw new Error('handler failure')},true),/handler failure/);assert.equal(calls,2);
});
test('过大响应不保存内容，检查并发受限',async()=>{
 const t=new McpRequestTracer({clock:()=>1010,maxInspections:1}),body='x'.repeat(65537),large=new Response(body,{headers:{'content-type':'application/json'}});await t.inspect(large,ctx);assert.equal(t.snapshot().events.at(-1).errorClass,'inspect_limit');assert.equal(await large.text(),body);
 const never=new ReadableStream({pull(){return new Promise(()=>{})}});const pending=t.inspect(new Response(never,{headers:{'content-type':'application/json'}}),ctx,{timeoutMs:10});await t.inspect(response({result:{}}),ctx);await pending;const kinds=t.snapshot().events.map(x=>x.errorClass);assert.ok(kinds.includes('inspect_limit'));assert.ok(kinds.includes('inspect_timeout'));
});
test('检查超时后迟到的响应不会增加错误的完成记录',async()=>{
 const t=new McpRequestTracer({clock:()=>1010}),payload=JSON.stringify({result:{content:[{type:'text',text:secret}]}});const stream=new ReadableStream({start(controller){setTimeout(()=>{controller.enqueue(new TextEncoder().encode(payload));controller.close()},30)}});const r=new Response(stream,{headers:{'content-type':'application/json'}});
 await t.inspect(r,ctx,{timeoutMs:5});assert.equal(await r.text(),payload);await new Promise(resolve=>setTimeout(resolve,5));assert.deepEqual(t.snapshot().events.map(x=>x.stage),['inspect_failed']);
});
test('文件写入失败只增加可读计数，不暴露路径或异常',async()=>{
 const before=getDiagnosticWriterHealth().writeFailures;const writer=createBoundedDiagnosticWriter('\0');await writer({kind:'synthetic'});const health=getDiagnosticWriterHealth();assert.equal(health.writeFailures,before+1);assert.ok(!JSON.stringify(health).includes(secret));
});
test('真实 SDK 的结果编码异常映射为 -32603 且只记录固定类别',async()=>{
 const t=new McpRequestTracer({clock:()=>1010});const h=createMcpHandler(()=>{const m=new McpServer({name:'fixture',version:'1'});m.server.registerCapabilities({events:{}});m.server.onerror=e=>t.sdkError(e);m.server.setRequestHandler('events/list',{params:z.object({}).passthrough(),result:z.object({}).passthrough()},async()=>({events:[],resultType:'partial'}));return m;},{legacy:'stateless'});
 try{const c={...ctx,method:'events/list',tool:'other'};const r=await t.run(c,()=>h.fetch(request('events/list',{})));await t.inspect(r,c);const body=await r.json();assert.equal(body.error.code,-32603);assert.equal(body.error.message,'Internal error');const events=t.snapshot().events;assert.ok(events.some(x=>x.stage==='sdk_error'&&x.errorClass==='encoding_failure'));assert.ok(events.some(x=>x.rpcCode===-32603&&x.result==='rpc_error'));assert.ok(!JSON.stringify(events).includes('Handler for'));}finally{await h.close()}
});
test('MCP 诊断工具只返回有界状态，不需要消息正文',async()=>{
 const h=makeHandler({events:{list:async()=>({events:[]})},actor:'synthetic-owner'});
 try{const r=await h.fetch(request('tools/call',{name:'get_mcp_request_diagnostics',arguments:{limit:4}}));const data=await r.json();assert.equal(data.result.isError,undefined);const value=JSON.parse(data.result.content[0].text);assert.ok(Array.isArray(value.events));assert.equal(typeof value.writer.writeFailures,'number');assert.ok(!JSON.stringify(value).includes(secret));}finally{await h.close()}
});
