import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,createHash} from 'node:crypto';
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {IncomingFileStore,serveIncomingFile} from './incoming-file-store.mjs';
import {MediaTransfers} from '../wechat-core-offline/media-transfer.mjs';
import {cdnDownloadUrl,parseMediaKey,safeFilename} from '../wechat-core-offline/media-codec.mjs';

const key=Buffer.alloc(16,7),eventId='inbound-file-fixture';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function encrypted(bytes){const cipher=createCipheriv('aes-128-ecb',key,null);return Buffer.concat([cipher.update(bytes),cipher.final()]);}
async function fixture(bytes=Buffer.from('录音文件测试'),options={}){
  const root=await mkdtemp(join(tmpdir(),'incoming-file-test-'));
  let calls=0,now=Date.now();
  const store=new IncomingFileStore({root,resolveUrl:cdnDownloadUrl,parseKey:parseMediaKey,safeFilename,
    origin:'https://files.example.com',headroom:0,clock:()=>now,
    fetcher:async()=>{calls++;return new Response(encrypted(bytes));},...options});
  const args={eventId,media:{mediaKind:'file',fileName:'fixture.m4a',param:'synthetic',aes_key:key.toString('base64'),declaredLength:bytes.length},expiresAt:now+3600000};
  return {root,store,args,calls:()=>calls,advance:value=>{now+=value},clock:()=>now,
    close:async()=>{store.close();await rm(root,{recursive:true,force:true});}};
}

test('超过旧20MiB的录音流式解密落盘，兼容原分块入口且不保留整文件内存',async()=>{
  const bytes=Buffer.alloc(26_654_413,47),f=await fixture(bytes);let transfers;
  try{
    const entry=await f.store.prepare(f.args);
    assert.equal(entry.storage,'disk');assert.equal(entry.bytes,undefined);assert.equal(entry.size,bytes.length);
    assert.equal(entry.sha256,digest(bytes));assert.deepEqual(await entry.readChunk(bytes.length-123,123),bytes.subarray(-123));
    transfers=new MediaTransfers({owner:'owner',clock:f.clock,readIncoming:async()=>entry,checkTarget:async()=>{},sendMedia:async()=>{throw Error('不应发送微信');}});
    const first=await transfers.read('owner',{eventId});
    assert.equal(first.size,bytes.length);assert.equal(first.nextOffset,131072);assert.equal(first.download.size,bytes.length);
    const last=await transfers.read('owner',{eventId,offset:bytes.length-123,expectedSha256:first.sha256});
    assert.equal(last.eof,true);assert.deepEqual(Buffer.from(last.dataBase64,'base64'),bytes.subarray(-123));
    const prepared=await transfers.prepareDownload('owner',{eventId});assert.equal(prepared.sha256,first.sha256);
    await assert.rejects(()=>transfers.read('other',{eventId}));
  }finally{transfers?.close();await f.close();}
});

test('并发读取复用一次下载，短期凭证并发取得相同有效值且磁盘不含原密钥和CDN地址',async()=>{
  const f=await fixture();
  try{
    const [a,b]=await Promise.all([f.store.prepare(f.args),f.store.prepare(f.args)]);
    assert.equal(f.calls(),1);const [x,y]=await Promise.all([a.download(),b.download()]);assert.equal(x.token,y.token);
    const files=await readdir(join(f.root,digest(eventId)));
    const records=(await Promise.all(files.filter(x=>x.endsWith('.json')).map(x=>readFile(join(f.root,digest(eventId),x),'utf8')))).join('');
    assert.ok(!records.includes(x.token));assert.ok(!records.includes(key.toString('base64')));assert.ok(!records.includes('cdn.weixin'));
    const ready=await f.store.prepare(f.args);assert.equal(ready.sha256,a.sha256);assert.equal(f.calls(),1);
  }finally{await f.close();}
});

test('错误长度清除部分文件，同一原事件可重新读取；低磁盘空间在网络请求前失败',async()=>{
  const f=await fixture(Buffer.alloc(1024,3));
  try{
    await assert.rejects(()=>f.store.prepare({...f.args,media:{...f.args.media,declaredLength:100}}),e=>e.code==='incoming_media_length_mismatch');
    assert.ok(!(await readdir(join(f.root,digest(eventId)))).some(x=>x.startsWith('partial-')));
    assert.equal((await f.store.prepare(f.args)).size,1024);
    f.store.headroom=Number.MAX_SAFE_INTEGER;
    await assert.rejects(()=>f.store.prepare({...f.args,eventId:'another'}),e=>e.code==='incoming_media_no_space');assert.equal(f.calls(),2);
  }finally{await f.close();}
});

test('解密失败不会发布文件，缓存到期后清理且重启可复用有效文件',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(()=>f.store.prepare({...f.args,media:{...f.args.media,aes_key:Buffer.alloc(16,8).toString('base64')}}),e=>e.code==='incoming_media_decrypt_failed');
    const entry=await f.store.prepare(f.args);
    const restarted=new IncomingFileStore({root:f.root,resolveUrl:cdnDownloadUrl,parseKey:parseMediaKey,safeFilename,headroom:0,clock:f.clock,fetcher:async()=>{throw Error('不应重新下载');}});
    assert.equal((await restarted.prepare(f.args)).sha256,entry.sha256);restarted.close();
    f.advance(900001);await f.store.cleanup();assert.deepEqual(await readdir(f.root),[]);
    await assert.rejects(()=>entry.readChunk(0,1),e=>e.code==='incoming_media_expired');
  }finally{await f.close();}
});

test('HTTPS下载协议核验凭证、完整摘要、Range续传和失效时间',async()=>{
  const bytes=Buffer.from('0123456789abcdef'),f=await fixture(bytes);let server;
  try{
    const entry=await f.store.prepare(f.args),grant=await entry.download();
    server=createServer(async(req,res)=>{if(!await serveIncomingFile(req,res,{root:f.root,clock:f.clock}))res.writeHead(404).end();});
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const endpoint=`http://127.0.0.1:${server.address().port}`+new URL(grant.endpoint).pathname;
    assert.equal((await fetch(endpoint)).status,403);
    assert.equal((await fetch(endpoint,{headers:{authorization:'Bearer '+'a'.repeat(43)}})).status,403);
    const headers={authorization:'Bearer '+grant.token};
    const full=await fetch(endpoint,{headers});assert.equal(full.status,200);assert.equal(full.headers.get('x-content-sha256'),digest(bytes));
    assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
    const part=await fetch(endpoint,{headers:{...headers,range:'bytes=5-9'}});assert.equal(part.status,206);assert.equal(part.headers.get('content-range'),'bytes 5-9/16');assert.equal(await part.text(),'56789');
    assert.equal((await fetch(endpoint,{method:'HEAD',headers})).headers.get('content-length'),'16');
    assert.equal((await fetch(endpoint,{headers:{...headers,range:'bytes=0-999'}})).status,416);
    f.advance(900001);assert.equal((await fetch(endpoint,{headers})).status,403);
  }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await f.close();}
});

test('百兆入站文件按流处理，完整大小与摘要一致',async()=>{
  const size=100_002_422,block=Buffer.alloc(1024*1024,9),hash=createHash('sha256');
  const f=await fixture(Buffer.alloc(0),{fetcher:async()=>{
    async function* chunks(){const cipher=createCipheriv('aes-128-ecb',key,null);for(let sent=0;sent<size;sent+=block.length){const chunk=block.subarray(0,Math.min(block.length,size-sent));hash.update(chunk);yield cipher.update(chunk);}yield cipher.final();}
    return {ok:true,body:Readable.from(chunks())};
  }});
  try{
    f.args.media.declaredLength=size;
    const entry=await f.store.prepare(f.args);assert.equal(entry.size,size);assert.equal(entry.sha256,hash.digest('hex'));
    assert.equal(entry.bytes,undefined);assert.deepEqual(await entry.readChunk(size-16,16),Buffer.alloc(16,9));
  }finally{await f.close();}
});

test('已验证文件在磁盘被修改后停止交付',async()=>{
  const f=await fixture();
  try{
    const entry=await f.store.prepare(f.args);await writeFile(join(f.root,digest(eventId),'payload'),Buffer.from('changed'));
    await assert.rejects(()=>entry.readChunk(0,1),e=>e.code==='incoming_media_unavailable');
  }finally{await f.close();}
});
