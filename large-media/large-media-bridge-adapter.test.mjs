import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {createMultipartMedia,putMultipartPart} from './multipart-media.mjs';
import {createLargeMediaBridgeAdapter} from './large-media-bridge-adapter.mjs';

async function prepared(root,sourceId='real-source') {
  const data=Buffer.from('已核实的附件'),sha256=createHash('sha256').update(data).digest('hex'),expiresAt=Date.now()+100000;
  const u=await createMultipartMedia({root,size:data.length,sha256,expiresAt});
  const request=Readable.from([data]);request.headers={};
  await putMultipartPart({root,id:u.id,index:0,sha256,request});
  await writeFile(join(root,u.id,'access.json'),JSON.stringify({state:'verified',sourceId,roomId:'example-room',fileName:'file.txt',size:data.length,sha256,expiresAt}));
  return u.id;
}
test('大文件发送复用原桥预占和回执，同附件换上传编号仍使用同一身份',async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-adapter-'));
  try {
    let calls=0;const keys=new Set();
    const bridge={owner:'owner',state:{phase:'armed',sessionToken:'fake'},
      async mediaReplyDraft(actor,args,clock,{start}) {
        assert.equal(actor,'owner');
        if(keys.has(args.idempotencyKey))return {state:'sent'};
        keys.add(args.idempotencyKey);
        const execution=Promise.resolve(start({effectiveEventId:'current',expiresAt:Date.now()+10000,to_user_id:'bound',context_token:'fake',clientId:'xiaodi:1-12345678'})).then(value=>({value}),error=>({error}));
        return {effectiveEventId:'current',execution};
      },async replySent(_actor,id){assert.equal(id,'current');}};
    const send=createLargeMediaBridgeAdapter({root,owner:'owner',bridge,verifySource:async()=>true,safeFilename:x=>x,cdnUploadUrl:()=>'',sendFile:async args=>{calls++;assert.equal(args.toUserId,'bound');return {accepted:true};}});
    const id=await prepared(root);
    assert.equal((await send({uploadId:id,eventId:'original'})).state,'sent');
    assert.equal((await send({uploadId:id,eventId:'original'})).state,'sent');
    assert.equal((await send({uploadId:await prepared(root),eventId:'original'})).state,'sent');
    assert.equal(calls,1);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('来源未核实不调用原桥；发送结果未知保留预占且不重发',async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-adapter-'));let calls=0;
  try {
    const id=await prepared(root),bridge={owner:'owner',state:{phase:'armed',sessionToken:'fake'},async mediaReplyDraft(){calls++;return {expiresAt:Date.now()+10000};}};
    const options={root,owner:'owner',bridge,safeFilename:x=>x,cdnUploadUrl:()=>'',sendFile:async()=>{throw new Error('响应丢失');}};
    const denied=createLargeMediaBridgeAdapter({...options,verifySource:async()=>false});
    await assert.rejects(denied({uploadId:id,eventId:'test'}));assert.equal(calls,0);
    const send=createLargeMediaBridgeAdapter({...options,verifySource:async()=>true});
    assert.equal((await send({uploadId:id,eventId:'test'})).state,'uncertain');
    assert.equal((await send({uploadId:id,eventId:'test'})).retrySendAllowed,false);assert.equal(calls,1);
  } finally {await rm(root,{recursive:true,force:true});}
});
