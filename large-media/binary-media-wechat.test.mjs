import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDecipheriv, createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sendBinaryFile} from './binary-media-wechat.mjs';

test('模拟微信接口验证流式加密内容及发送参数', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xiaodi-send-test-'));
  try {
    const data = Buffer.alloc(300001, 37), path = join(dir, 'payload');
    await writeFile(path, data);
    let key, calls = 0;
    const fetcher = async (url, options) => {
      calls++;
      if (calls === 1) {
        const body = JSON.parse(options.body);
        assert.equal(body.rawsize, data.length);
        assert.equal(body.rawfilemd5, createHash('md5').update(data).digest('hex'));
        key = Buffer.from(body.aeskey, 'hex');
        return new Response(JSON.stringify({ret:0,upload_param:'mock'}));
      }
      if (calls === 2) {
        assert.equal(url, 'https://example.invalid/upload');
        const parts=[]; for await (const chunk of options.body) parts.push(chunk);
        const cipher=Buffer.concat(parts);
        assert.equal(cipher.length, Number(options.headers['Content-Length']));
        const decipher=createDecipheriv('aes-128-ecb',key,null);
        assert.deepEqual(Buffer.concat([decipher.update(cipher),decipher.final()]), data);
        return new Response('', {headers:{'x-encrypted-param':'mock-param'}});
      }
      assert.equal(JSON.parse(options.body).msg.item_list[0].file_item.len, String(data.length));
      return new Response(JSON.stringify({ret:0}));
    };
    assert.deepEqual(await sendBinaryFile({path,size:data.length,md5:createHash('md5').update(data).digest('hex'),fileName:'a.bin',
      sessionToken:'mock',toUserId:'mock',contextToken:'mock',clientId:'xiaodi:123-12345678',
      safeFilename:x=>x,cdnUploadUrl:()=> 'https://example.invalid/upload',fetcher,deadline:Date.now()+10000}), {accepted:true});
    assert.equal(calls,3);
  } finally {await rm(dir, {recursive:true,force:true});}
});

test('上游提前响应但未消费完整文件时，不调用消息发送', async () => {
  const dir=await mkdtemp(join(tmpdir(),'xiaodi-early-response-'));
  try {
    const path=join(dir,'payload'),data=Buffer.alloc(2_000_000,1);
    await writeFile(path,data);
    let calls=0;
    const fetcher=async()=>{
      calls++;
      return calls===1 ? new Response(JSON.stringify({ret:0,upload_param:'mock'}))
        : new Response('',{headers:{'x-encrypted-param':'mock'}});
    };
    await assert.rejects(sendBinaryFile({path,size:data.length,md5:createHash('md5').update(data).digest('hex'),fileName:'a.bin',
      sessionToken:'mock',toUserId:'mock',contextToken:'mock',clientId:'xiaodi:123-12345678',
      safeFilename:x=>x,cdnUploadUrl:()=> 'https://example.invalid/upload',fetcher,deadline:Date.now()+250}));
    assert.equal(calls,2);
  } finally {await rm(dir,{recursive:true,force:true});}
});
