import test from 'node:test';
import assert from 'node:assert/strict';
import {makeHandler} from './mcp-events.mjs';

const owner='synthetic-owner';
const metadata={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'fixture',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
async function invoke(bridge){
 const handler=makeHandler({events:{list:async()=>({events:[]})},actor:owner,bridge});
 try{
  const request=new Request('http://127.0.0.1/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':'get_wechat_event'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_wechat_event',arguments:{eventId:'synthetic-event'},_meta:metadata}})});
  const response=await handler.fetch(request);return {status:response.status,body:await response.json()};
 }finally{await handler.close();}
}

test('事件读取内部异常被包装为工具错误，不直接返回内部错误码',async()=>{
 const result=await invoke({owner,state:{phase:'armed'},readEvent:async()=>{throw new Error('synthetic failure')}});
 assert.equal(result.status,200);assert.equal(result.body.error,undefined);assert.equal(result.body.result.isError,true);assert.equal(result.body.result.content[0].text,'Event is unavailable or expired.');
});

test('桥接对象获取阶段异常也被工具框架包装为工具错误',async()=>{
 const result=await invoke(()=>{throw new Error('synthetic bridge getter failure')});
 assert.equal(result.status,200);assert.equal(result.body.error,undefined);assert.equal(result.body.result.isError,true);assert.equal(result.body.result.content[0].text,'synthetic bridge getter failure');
});
