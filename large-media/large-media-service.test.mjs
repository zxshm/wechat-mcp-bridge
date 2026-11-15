import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {request} from 'node:http';
import {createLargeMediaService} from './large-media-service.mjs';
import {uploadLargeMedia} from './large-media-client.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
async function start(root,options={}) {
  const s=await createLargeMediaService({root,headroom:0,defaultPartBytes:90_000_000,...options});
  s.app.listen(0,'127.0.0.1');await once(s.app,'listening');
  // 测试控制端只绑定临时回环端口；生产使用私有 Unix 套接字。
  s.control.listen(0,'127.0.0.1');await once(s.control,'listening');
  return {...s,url:'http://127.0.0.1:'+s.app.address().port,controlUrl:'http://127.0.0.1:'+s.control.address().port};
}
async function close(s) {
  await Promise.all([s.app,s.control].map(server=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();})));
}
async function grant(s,bytes,overrides={}) {
  const res=await fetch(s.controlUrl+'/uploads',{method:'POST',body:JSON.stringify({size:bytes.length,sha256:hash(bytes),fileName:'验证.pdf',sourceId:'test-source',roomId:'example-room',expiresAt:Date.now()+600000,...overrides})});
  assert.equal(res.status,201);return res.json();
}

test('上传重启后续传、凭证隔离、完成校验且不触发微信',async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-independent-'));let s;
  try {
    s=await start(join(root,'uploads'));
    const bytes=Buffer.from('新的文件字节'),path=join(root,'原文件');await writeFile(path,bytes);
    const upload=await grant(s,bytes),endpoint=s.url+'/uploads/'+upload.id;
    assert.equal((await fetch(endpoint)).status,403);
    assert.equal((await fetch(endpoint,{headers:{authorization:'Bearer '+'x'.repeat(43)}})).status,403);
    const access=await readFile(join(root,'uploads',upload.id,'access.json'),'utf8');
    assert.ok(!access.includes(upload.token));
    const r=await fetch(endpoint+'/parts/0',{method:'PUT',headers:{authorization:'Bearer '+upload.token,'content-type':'application/octet-stream','x-part-sha256':hash(bytes)},body:bytes});
    assert.equal(r.status,200);
    await close(s);s=await start(join(root,'uploads'));
    let uploads=0;
    const result=await uploadLargeMedia({path,baseUrl:s.url,upload,fetcher:(url,opts)=>{if(opts.method==='PUT')uploads++;return fetch(url,opts);}});
    assert.equal(uploads,0);assert.equal(result.state,'verified');assert.equal(result.sent,false);
    assert.deepEqual(await uploadLargeMedia({path,baseUrl:s.url,upload}),result);
    const other=await grant(s,bytes,{sourceId:'other-source'});
    assert.equal((await fetch(s.url+'/uploads/'+other.id,{headers:{authorization:'Bearer '+upload.token}})).status,403);
  } finally {if(s)await close(s);await rm(root,{recursive:true,force:true});}
});

test('损坏分段、错误原文件和其他聊天不可进入可用状态',async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-invalid-'));let s;
  try {
    s=await start(join(root,'uploads'));const bytes=Buffer.from('正确内容'),upload=await grant(s,bytes);
    const headers={authorization:'Bearer '+upload.token};
    const endpoint=s.url+'/uploads/'+upload.id;
    assert.equal((await fetch(endpoint+'/parts/0',{method:'PUT',headers:{...headers,'content-type':'application/octet-stream','x-part-sha256':'0'.repeat(64)},body:bytes})).status,409);
    assert.equal((await fetch(endpoint+'/finish',{method:'POST',headers})).status,409);
    assert.equal((await (await fetch(endpoint,{headers})).json()).nextIndex,0);
    const path=join(root,'changed');await writeFile(path,Buffer.from('错误内容'));
    await assert.rejects(uploadLargeMedia({path,baseUrl:s.url,upload}));
    const denied=await fetch(s.controlUrl+'/uploads',{method:'POST',body:JSON.stringify({size:1,sha256:hash('x'),fileName:'a',sourceId:'new',roomId:'other',expiresAt:Date.now()+10000})});
    assert.equal(denied.status,409);
  } finally {if(s)await close(s);await rm(root,{recursive:true,force:true});}
});

test('独立接口实际接收超过 100 MB：仅两次二进制分段', {timeout:120000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-large-http-'));let s;
  try {
    s=await start(join(root,'uploads'));
    const bytes=Buffer.alloc(100_000_001,37),path=join(root,'large.bin');await writeFile(path,bytes);
    const upload=await grant(s,bytes);let puts=0;const started=performance.now();
    const result=await uploadLargeMedia({path,baseUrl:s.url,upload,fetcher:(url,options)=>{if(options.method==='PUT')puts++;return fetch(url,options);}});
    assert.equal(puts,2);assert.equal(result.sha256,hash(bytes));assert.equal(result.sent,false);
    console.log(JSON.stringify({test:'独立服务二进制上传',bytes:bytes.length,parts:puts,elapsedMs:Math.round(performance.now()-started),wechatSent:false}));
  } finally {if(s)await close(s);await rm(root,{recursive:true,force:true});}
});

test('临时网关错误续传同一上传，丢失响应不重复上传已落盘分段',async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-recovery-'));let s;
  try {
    s=await start(join(root,'uploads'));
    const bytes=Buffer.from('abcdefgh'),path=join(root,'原文件');await writeFile(path,bytes);
    const upload=await grant(s,bytes,{partBytes:4});let puts=0,finishes=0;
    const result=await uploadLargeMedia({path,baseUrl:s.url,upload,retryDelayMs:0,fetcher:async(url,options)=>{
      assert.ok(url.includes(upload.id));
      if(options.method==='PUT') {
        puts++;
        if(puts===1)return new Response('{}',{status:502});
        const result=await fetch(url,options);
        if(puts===2){await result.json();throw new TypeError('fetch failed');}
        return result;
      }
      if(options.method==='POST') {
        finishes++;const result=await fetch(url,options);
        if(finishes===1){await result.json();return new Response('{}',{status:524});}
        return result;
      }
      return fetch(url,options);
    }});
    assert.equal(result.state,'verified');assert.equal(result.sent,false);
    assert.equal(puts,3);assert.equal(finishes,2);
    let calls=0;
    await assert.rejects(uploadLargeMedia({path,baseUrl:s.url,upload,retryDelayMs:0,fetcher:async()=>{calls++;return new Response('{}',{status:403});}}),/403/);
    assert.equal(calls,1);
  } finally {if(s)await close(s);await rm(root,{recursive:true,force:true});}
});

test('慢上传期间持续返回保活，最终失败不能因HTTP200被接受',{timeout:10000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-streaming-'));let s;
  try {
    s=await start(join(root,'uploads'),{progressIntervalMs:20});
    const bytes=Buffer.from('云端慢速上传'),upload=await grant(s,bytes);let heartbeatCount=0;
    const result=await new Promise((resolve,reject)=>{
      let ended=false;
      const req=request(s.url+'/uploads/'+upload.id+'/parts/0',{method:'PUT',headers:{authorization:'Bearer '+upload.token,'content-type':'application/octet-stream','content-length':bytes.length,'x-part-sha256':hash(bytes),'x-upload-progress':'keepalive'}},res=>{
        const chunks=[];
        res.on('data',chunk=>{
          chunks.push(chunk);
          if(!ended){assert.match(chunk.toString(),/^\s+$/);heartbeatCount++;if(heartbeatCount>=3){ended=true;req.end(bytes.subarray(1));}}
        });
        res.on('error',reject);res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks)));}catch(error){reject(error);}});
      });req.on('error',reject);req.write(bytes.subarray(0,1));
    });
    assert.ok(heartbeatCount>=3);assert.equal(result.state,'received');
    const other=await grant(s,bytes,{sourceId:'other-source'}),path=join(root,'same.txt');await writeFile(path,bytes);
    await assert.rejects(uploadLargeMedia({path,baseUrl:s.url,upload:other,fetcher:(url,options)=>{
      if(options.method==='PUT')options.headers['x-part-sha256']='0'.repeat(64);
      return fetch(url,options);
    }}),/分段最终校验未通过/);
  }finally{if(s)await close(s);await rm(root,{recursive:true,force:true});}
});

test('段内断线保留字节，重启后从实际偏移继续并校验完整文件',{timeout:10000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-offset-'));let s;
  try {
    s=await start(join(root,'uploads'),{progressIntervalMs:20});
    const bytes=Buffer.from('abcdefgh'),upload=await grant(s,bytes),path=join(root,'原文件');await writeFile(path,bytes);
    await new Promise(resolve=>{
      const req=request(s.url+'/uploads/'+upload.id+'/parts/0',{method:'PUT',headers:{authorization:'Bearer '+upload.token,'content-type':'application/octet-stream','content-length':bytes.length,'x-part-sha256':hash(bytes),'x-part-offset':'0','x-upload-progress':'keepalive'}},res=>{
        res.resume();res.on('error',()=>{});setTimeout(()=>req.destroy(),60);
      });req.on('error',()=>{});req.on('close',resolve);req.write(bytes.subarray(0,3));
    });
    await close(s);s=await start(join(root,'uploads'));
    const endpoint=s.url+'/uploads/'+upload.id,headers={authorization:'Bearer '+upload.token};
    const status=await (await fetch(endpoint,{headers})).json();assert.equal(status.nextOffset,3);assert.equal(status.nextIndex,0);
    const wrong=await fetch(endpoint+'/parts/0',{method:'PUT',headers:{...headers,'content-type':'application/octet-stream','x-part-sha256':hash(bytes),'x-part-offset':'0'},body:bytes});assert.equal(wrong.status,409);
    let transferred=0;
    const result=await uploadLargeMedia({path,baseUrl:s.url,upload,fetcher:(url,options)=>{
      if(options.method==='PUT'){transferred+=Number(options.headers['content-length']);assert.equal(options.headers['x-part-offset'],'3');}
      return fetch(url,options);
    }});
    assert.equal(transferred,5);assert.equal(result.sha256,hash(bytes));assert.equal(result.sent,false);
  }finally{if(s)await close(s);await rm(root,{recursive:true,force:true});}
});

test('长上传仍在凭证到期时中止，不保存未完成分段',{timeout:5000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-expiry-'));let s;
  try {
    s=await start(join(root,'uploads'),{progressIntervalMs:20});
    const bytes=Buffer.from('到期测试'),upload=await grant(s,bytes,{expiresAt:Date.now()+200});
    await new Promise((resolve,reject)=>{
      const req=request(s.url+'/uploads/'+upload.id+'/parts/0',{method:'PUT',headers:{authorization:'Bearer '+upload.token,'content-type':'application/octet-stream','content-length':bytes.length,'x-part-sha256':hash(bytes),'x-upload-progress':'keepalive'}},res=>{
        res.resume();res.on('aborted',resolve);res.on('error',resolve);res.on('end',()=>reject(new Error('未完整上传却正常结束')));
      });req.on('error',resolve);req.write(bytes.subarray(0,1));
    });
    await assert.rejects(readFile(join(root,'uploads',upload.id,'part-0')),/ENOENT/);
  }finally{if(s)await close(s);await rm(root,{recursive:true,force:true});}
});

test('响应保活不掩盖收包停滞，释放占用并保留段内续传进度',{timeout:5000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-idle-'));let s;
  try {
    s=await start(join(root,'uploads'),{progressIntervalMs:20,uploadIdleMs:100});
    const bytes=Buffer.from('abcdefgh'),upload=await grant(s,bytes);let beats=0;
    await new Promise(resolve=>{
      const req=request(s.url+'/uploads/'+upload.id+'/parts/0',{method:'PUT',headers:{authorization:'Bearer '+upload.token,'content-type':'application/octet-stream','content-length':bytes.length,'x-part-sha256':hash(bytes),'x-part-offset':'0','x-upload-progress':'keepalive'}},res=>{
        res.on('data',()=>beats++);res.on('aborted',resolve);res.on('error',resolve);
      });req.on('error',resolve);req.write(bytes.subarray(0,3));
    });
    let status;
    for(let i=0;i<20;i++){
      status=await (await fetch(s.url+'/uploads/'+upload.id,{headers:{authorization:'Bearer '+upload.token}})).json();
      if(!status.active)break;await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(beats>=2);assert.equal(status.active,false);assert.equal(status.nextOffset,3);
  }finally{if(s)await close(s);await rm(root,{recursive:true,force:true});}
});

test('重复创建恢复同一来源上传及进度，旧凭证失效且已有发送不可恢复',async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-renew-'));let s;
  try{
    s=await start(join(root,'uploads'));const bytes=Buffer.from('abcdefgh'),original=await grant(s,bytes,{partBytes:4});
    const endpoint=s.url+'/uploads/'+original.id;
    assert.equal((await fetch(endpoint+'/parts/0',{method:'PUT',headers:{authorization:'Bearer '+original.token,'content-type':'application/octet-stream','x-part-sha256':hash(bytes.subarray(0,4))},body:bytes.subarray(0,4)})).status,200);
    const renewed=await grant(s,bytes);
    assert.equal(renewed.id,original.id);assert.equal(renewed.partBytes,4);assert.equal(renewed.expiresAt,original.expiresAt);assert.equal(renewed.reused,true);
    assert.notEqual(renewed.token,original.token);
    assert.equal((await fetch(endpoint,{headers:{authorization:'Bearer '+original.token}})).status,403);
    assert.equal((await (await fetch(endpoint,{headers:{authorization:'Bearer '+renewed.token}})).json()).nextIndex,1);
    const metadata={size:bytes.length,sha256:hash(bytes),fileName:'变更.txt',sourceId:'test-source',roomId:'example-room',expiresAt:Date.now()+600000};
    assert.equal((await fetch(s.controlUrl+'/uploads',{method:'POST',body:JSON.stringify(metadata)})).status,409);
    await writeFile(join(root,'uploads',original.id,'send-reservation.json'),'{}');
    assert.equal((await fetch(s.controlUrl+'/uploads',{method:'POST',body:JSON.stringify({...metadata,fileName:'验证.pdf'})})).status,409);
  }finally{if(s)await close(s);await rm(root,{recursive:true,force:true});}
});
