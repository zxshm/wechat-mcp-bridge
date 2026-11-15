import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDecipheriv,createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {createMultipartMedia,putMultipartPart,assembleMultipartMedia,MAX_PART_BYTES} from './multipart-media.mjs';
import {sendBinaryFile} from './binary-media-wechat.mjs';

async function fileHash(path, start, end) {
  const h=createHash('sha256');
  for await(const chunk of createReadStream(path,{start,end})) h.update(chunk);
  return h.digest('hex');
}

async function makePdf(path) {
  const out=createWriteStream(path,{flags:'wx'}); let position=0; const offsets=[0];
  const write=async data=>{position+=Buffer.byteLength(data);if(!out.write(data))await once(out,'drain');};
  await write('%PDF-1.4\n');
  const object=async (id,body)=>{offsets[id]=position;await write(id+' 0 obj\n'+body+'\nendobj\n');};
  await object(1,'<< /Type /Catalog /Pages 2 0 R >>');
  await object(2,'<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  await object(3,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>');
  await object(4,'<< /Length 0 >>\nstream\n\nendstream');
  offsets[5]=position;
  const fillerSize=100_000_000;
  await write('5 0 obj\n<< /Length '+fillerSize+' >>\nstream\n');
  const block=Buffer.alloc(1_000_000,65);
  for(let i=0;i<100;i++) await write(block);
  await write('\nendstream\nendobj\n');
  const xref=position;
  await write('xref\n0 6\n0000000000 65535 f \n');
  for(let i=1;i<=5;i++) await write(String(offsets[i]).padStart(10,'0')+' 00000 n \n');
  await write('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n');
  out.end(); await once(out,'finish'); return position;
}

test('真实本机 HTTP 上传并拼接超过 100 MB 的 PDF，解析器可打开', {timeout:120000}, async()=>{
  const root=await mkdtemp(join(tmpdir(),'xiaodi-http-test-'));
  let server;
  try {
    const source=join(root,'source.pdf'), size=await makePdf(source), sha256=await fileHash(source,0,size-1);
    const upload=await createMultipartMedia({root:join(root,'uploads'),size,sha256,expiresAt:Date.now()+120000});
    server=createServer(async(req,res)=>{
      try {
        const index=Number(req.url.slice(1));
        const result=await putMultipartPart({root:join(root,'uploads'),id:upload.id,index,sha256:req.headers['x-part-sha256'],request:req});
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(result));
      } catch {res.writeHead(400).end();}
    });
    server.listen(0,'127.0.0.1'); await once(server,'listening');
    for(let index=0;index<upload.parts;index++) {
      const start=index*MAX_PART_BYTES,end=Math.min(size,start+MAX_PART_BYTES)-1;
      const r=await fetch('http://127.0.0.1:'+server.address().port+'/'+index,{method:'PUT',duplex:'half',
        headers:{'content-length':String(end-start+1),'x-part-sha256':await fileHash(source,start,end)},
        body:createReadStream(source,{start,end})});
      assert.equal(r.status,200);
    }
    await assembleMultipartMedia({root:join(root,'uploads'),id:upload.id,onVerified:async ({path,sha256:actual,md5})=>{
      assert.equal(actual,sha256);
      const result=execFileSync('python',['-c','import fitz,sys; d=fitz.open(sys.argv[1]); print(len(d))',path],{encoding:'utf8'});
      assert.equal(result.trim(),'1');
      let calls=0,key;
      const fetcher=async (_url, options)=>{
        calls++;
        if(calls===1) {
          const info=JSON.parse(options.body);
          assert.equal(info.rawsize,size);
          key=Buffer.from(info.aeskey,'hex');
          return new Response(JSON.stringify({ret:0,upload_param:'mock'}));
        }
        if(calls===2) {
          const decipher=createDecipheriv('aes-128-ecb',key,null), hash=createHash('sha256');
          for await(const chunk of options.body) hash.update(decipher.update(chunk));
          hash.update(decipher.final());
          assert.equal(hash.digest('hex'),sha256);
          return new Response('',{headers:{'x-encrypted-param':'mock'}});
        }
        assert.equal(JSON.parse(options.body).msg.item_list[0].file_item.len,String(size));
        return new Response(JSON.stringify({ret:0}));
      };
      const sent=await sendBinaryFile({path,size,md5,fileName:'large.pdf',sessionToken:'mock',toUserId:'mock',
        contextToken:'mock',clientId:'xiaodi:123-12345678',safeFilename:x=>x,cdnUploadUrl:()=> 'https://example.invalid/upload',
        fetcher,deadline:Date.now()+30000});
      assert.equal(sent.accepted,true);
      assert.equal(calls,3);
    }});
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true});
  }
});
