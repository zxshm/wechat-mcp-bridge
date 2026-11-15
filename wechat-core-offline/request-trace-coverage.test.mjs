import test from 'node:test';
import assert from 'node:assert/strict';
import {McpRequestTracer,isInspectableTool} from './mcp-request-diagnostics.mjs';
import {safeTraceRow} from './request-trace-sink.mjs';

test('近期查询与合并入口保留真实名称和协议结果',async()=>{
 for(const tool of ['list_recent_wechat_conversation','minihome_prepare_verified_sync_submission','enqueue_chatgpt_sync_message','get_mcp_request_diagnostics']){
  const tracer=new McpRequestTracer();const context={requestId:'0123456789abcdef',method:'tools/call',tool,startedAt:Date.now()};
  assert.equal(isInspectableTool(context.method,tool),true);
  await tracer.inspect(new Response(JSON.stringify({result:{content:[{type:'text',text:'秘密正文'}]}}),{headers:{'content-type':'application/json'}}),context);
  const row=tracer.snapshot().events[0];assert.equal(row.tool,tool);assert.equal(row.result,'success');assert.ok(!JSON.stringify(row).includes('秘密'));
 }
});
test('HTTP200仍能区别RPC内部错误与工具错误',async()=>{
 for(const [body,expected] of [[{error:{code:-32603,message:'秘密'}},'rpc_error'],[{result:{isError:true,content:[]}},'tool_error']]){
  const tracer=new McpRequestTracer();
  await tracer.inspect(new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}}),{requestId:'0123456789abcdef',method:'tools/call',tool:'list_recent_wechat_conversation',startedAt:Date.now()});
  assert.equal(tracer.snapshot().events[0].result,expected);
 }
});
test('持久化出口不接受正文参数凭据字段',()=>{
 const row=safeTraceRow({at:1,requestId:'0123456789abcdef',tool:'list_recent_wechat_conversation',args:{text:'秘密'},text:'秘密',headers:'秘密',token:'秘密'});
 assert.deepEqual(Object.keys(row),['at','requestId','tool']);assert.ok(!JSON.stringify(row).includes('秘密'));
});
