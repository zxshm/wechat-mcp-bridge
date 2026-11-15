import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createMultipartMedia,putMultipartPart,multipartStatus,assembleMultipartMedia,removeMultipartMedia,cleanupExpiredMultipart,MAX_PART_BYTES} from './multipart-media.mjs';

const buffer=Buffer.alloc(1_000_000,37);
async function* bytes(size) {
  while(size>0) { const n=Math.min(size,buffer.length); yield buffer.subarray(0,n); size-=n; }
}
function digest(size) {
  const hash=createHash('sha256');
  while(size>0) { const n=Math.min(size,buffer.length); hash.update(buffer.subarray(0,n)); size-=n; }
  return hash.digest('hex');
}
function request(size) { const r=Readable.from(bytes(size)); r.headers={'content-length':String(size)}; return r; }

test('超过 100 MB 的文件按 90 MB 分段并重组，重复提交不会重复写入', {timeout:120000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-multipart-test-'));
  try {
    const size=100_000_001, upload=await createMultipartMedia({root,size,sha256:digest(size),expiresAt:Date.now()+120000});
    assert.equal(upload.parts,2);
    await assert.rejects(putMultipartPart({root,id:upload.id,index:1,sha256:digest(size-MAX_PART_BYTES),request:request(size-MAX_PART_BYTES)}));
    assert.equal((await putMultipartPart({root,id:upload.id,index:0,sha256:digest(MAX_PART_BYTES),request:request(MAX_PART_BYTES)})).nextIndex,1);
    assert.equal((await putMultipartPart({root,id:upload.id,index:0,sha256:digest(MAX_PART_BYTES),request:request(MAX_PART_BYTES)})).state,'already_received');
    assert.equal((await multipartStatus({root,id:upload.id})).nextIndex,1);
    await putMultipartPart({root,id:upload.id,index:1,sha256:digest(size-MAX_PART_BYTES),request:request(size-MAX_PART_BYTES)});
    const result=await assembleMultipartMedia({root,id:upload.id,onVerified:async file=>({size:file.size,sha256:file.sha256})});
    assert.deepEqual(result,{size,sha256:digest(size)});
    await removeMultipartMedia({root,id:upload.id});
    await assert.rejects(multipartStatus({root,id:upload.id}));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('分段校验失败或中断不会被当成有效分段，损坏的完整文件不会进入发送',async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-multipart-test-'));
  try {
    const upload=await createMultipartMedia({root,size:4,sha256:digest(4),partBytes:4,expiresAt:Date.now()+10000});
    await assert.rejects(putMultipartPart({root,id:upload.id,index:0,sha256:'0'.repeat(64),request:request(4)}));
    const broken=Readable.from((async function*(){yield Buffer.from([37]);throw new Error('断开')})()); broken.headers={};
    await assert.rejects(putMultipartPart({root,id:upload.id,index:0,sha256:digest(4),request:broken}));
    assert.equal((await multipartStatus({root,id:upload.id})).nextIndex,0);
    await putMultipartPart({root,id:upload.id,index:0,sha256:digest(4),request:request(4)});
    await writeFile(join(root,upload.id,'part-0'),Buffer.from('xxxx'));
    let sent=false;
    await assert.rejects(assembleMultipartMedia({root,id:upload.id,onVerified:async()=>{sent=true;}}));
    assert.equal(sent,false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('回收只处理已过期的合法会话',async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-expiry-test-'));
  try {
    const expiry=Date.now()+10000;
    const a=await createMultipartMedia({root,size:4,sha256:digest(4),partBytes:4,expiresAt:expiry});
    const b=await createMultipartMedia({root,size:4,sha256:digest(4),partBytes:4,expiresAt:expiry+10000});
    assert.deepEqual(await cleanupExpiredMultipart({root,now:expiry}),{removed:1,skipped:0});
    await assert.rejects(multipartStatus({root,id:a.id}));
    assert.equal((await multipartStatus({root,id:b.id})).nextIndex,0);
  } finally {await rm(root,{recursive:true,force:true});}
});
