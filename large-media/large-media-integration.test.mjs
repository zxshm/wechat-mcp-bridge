process.env.BRIDGE_FILE_UPLOAD_ORIGIN='https://files.example.com';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import * as z from 'zod/v4';
import {createLargeMediaService} from './large-media-service.mjs';
import {createLargeMediaIntegration,privateMediaCall} from './large-media-integration.mjs';
import {uploadLargeMedia} from './large-media-client.mjs';

test('独立接收服务与原桥接线：绑定事件、上传校验、发送回执和重复查询',{skip:process.platform==='win32'},async()=>{
  const root=await mkdtemp(join(tmpdir(),'xd-integration-'));let receiver,integration;let calls=0;
  try{
    receiver=await createLargeMediaService({root:join(root,'uploads'),headroom:0});
    receiver.control.listen(join(root,'receiver.sock'));await once(receiver.control,'listening');
    receiver.app.listen(0,'127.0.0.1');await once(receiver.app,'listening');
    const bridge={owner:'owner',state:{phase:'armed',sessionToken:'fake'},async readEvent(){return {expiresAt:Date.now()+60000};},
      async mediaReplyDraft(){return {expiresAt:Date.now()+60000,to_user_id:'owner-wechat',context_token:'fake',clientId:'xiaodi:1-12345678'};},async replySent(){}};
    integration=createLargeMediaIntegration({z,owner:'owner',bridge,root:join(root,'uploads'),receiverSocket:join(root,'receiver.sock'),controlSocket:join(root,'bridge.sock'),safeFilename:x=>x,cdnUploadUrl:()=>'',sendFile:async()=>{calls++;return {accepted:true};}});await integration.ready;
    const body=Buffer.from('真实接线测试'),path=join(root,'file.txt');await writeFile(path,body);
    const metadata={eventId:'event',sourceId:'source',roomId:'example-room',fileName:'file.txt',size:body.length,sha256:createHash('sha256').update(body).digest('hex')};
    const upload=await privateMediaCall(join(root,'bridge.sock'),'/begin',metadata);
    assert.equal(upload.cloudUploadAvailable,true);
    assert.equal(upload.partBytes,90_000_000);
    assert.equal(upload.uploadEndpoint,'https://files.example.com');
    assert.equal(upload.protocol.body,'raw binary, not base64');
    await uploadLargeMedia({path,baseUrl:'http://127.0.0.1:'+receiver.app.address().port,upload});
    const args={uploadId:upload.id,eventId:'event',sourceId:'source',roomId:metadata.roomId,sha256:metadata.sha256};
    await assert.rejects(privateMediaCall(join(root,'bridge.sock'),'/send',{...args,eventId:'other'}));
    assert.equal(calls,0);
    assert.equal((await privateMediaCall(join(root,'bridge.sock'),'/send',args)).state,'sent');
    const status=await privateMediaCall(join(root,'bridge.sock'),'/status',{uploadId:upload.id});
    assert.equal(status.sendResult.state,'sent');assert.equal(calls,1);
    assert.equal(JSON.stringify(status).includes(upload.token),false);
  }finally{
    if(integration)await integration.close();
    if(receiver)await Promise.all([receiver.app,receiver.control].map(s=>new Promise(resolve=>{s.close(resolve);s.closeIdleConnections();})));
    await rm(root,{recursive:true,force:true});
  }
});
