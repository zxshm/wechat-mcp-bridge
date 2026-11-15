import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as z from 'zod/v4';
import {MediaTransfers} from './media-transfer.mjs';
import {registerFastMediaPrepare} from './media-fast-prepare.mjs';

const owner='fixture_owner',bytes=Buffer.from('小文件验证'),digest=createHash('sha256').update(bytes).digest('hex');
const source={eventId:'fixture_event',idempotencyKey:'fixture_key',kind:'file',fileName:'fixture.txt',size:bytes.length,sha256:digest,dataBase64:bytes.toString('base64')};
const body=r=>JSON.parse(r.content[0].text);
function fixture(sendMedia=async()=>({state:'sent'})){
 let cb;
 const transfers=new MediaTransfers({owner,readIncoming:async()=>{throw Error('unused')},checkTarget:async()=>({expiresAt:Date.now()+60000}),sendMedia});
 registerFastMediaPrepare({registerTool(_n,_c,h){cb=h}},{z,owner,transfers});
 return {transfers,cb};
}
test('真实传输对象校验后才允许发送且已发不重复',async()=>{
 let sends=0;const f=fixture(async(_owner,p)=>{sends++;assert.deepEqual(p.bytes,bytes);return {state:'sent'}});
 try{const prepared=body(await f.cb(source));assert.equal(prepared.state,'ready');assert.equal(sends,0);assert.equal((await f.transfers.send(owner,{uploadId:prepared.uploadId})).state,'sent');assert.equal(body(await f.cb(source)).state,'sent');assert.equal(sends,1)}finally{f.transfers.close()}
});
test('摘要不符无法准备为可发送状态',async()=>{
 const f=fixture();try{const r=await f.cb({...source,sha256:'0'.repeat(64)});assert.equal(r.isError,true);assert.equal(body(r).state,'preparation_failed');const u=[...f.transfers.uploads.values()][0];assert.equal(u.state,'uploading')}finally{f.transfers.close()}
});
test('发送结果未知后不会发起第二次',async()=>{
 let sends=0;const f=fixture(async()=>{sends++;return {state:'uncertain'}});
 try{const p=body(await f.cb(source));assert.equal((await f.transfers.send(owner,{uploadId:p.uploadId})).state,'uncertain');assert.equal(body(await f.cb(source)).state,'uncertain');assert.equal(sends,1)}finally{f.transfers.close()}
});
