import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPair,exportJWK,SignJWT,createLocalJWKSet} from 'jose';
import {createApp,AUDIENCE} from '../server-v2.mjs';
import {createMinihomeSourceLedger} from './minihome-source-ledger.mjs';

test('账本工具经过微信 MCP 本人鉴权才能访问',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'ledger-http-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const jwk=await exportJWK(publicKey);jwk.kid='fixture';jwk.alg='RS256';
 const keys=createLocalJWKSet({keys:[jwk]}),events={list:async()=>({events:[]})};
 const ledger=createMinihomeSourceLedger({file:join(dir,'sources.sqlite'),roomId:'fixture_room'});
 const {app,close}=createApp({events,keys,localPort:0,sourceLedger:ledger,owner:"owner@example.com",issuer:"https://access.example.com",publicHost:"bridge.example.com"});
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${app.address().port}/mcp`;
 const base={'host':'bridge.example.com','content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':'tools/list'};
 const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'fixture',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}});
 const signed=async email=>new SignJWT({email}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer('https://access.example.com').setAudience(AUDIENCE).setExpirationTime('5m').sign(privateKey);
 try{
  assert.equal((await fetch(url,{method:'POST',headers:base,body})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{...base,'cf-access-jwt-assertion':await signed('other@example.com')},body})).status,403);
  const response=await fetch(url,{method:'POST',headers:{...base,'cf-access-jwt-assertion':await signed('owner@example.com')},body});
  assert.equal(response.status,200);
  const names=(await response.json()).result.tools.map(tool=>tool.name);
  assert.ok(names.includes('minihome_capture_sync_source_observation'));
  assert.ok(names.includes('enqueue_chatgpt_sync_message'));
 }finally{await new Promise(resolve=>app.close(resolve));await close()}
});
