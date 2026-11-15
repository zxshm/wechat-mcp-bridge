import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export const MAX_PART_BYTES = 90_000_000;
const hashPattern = /^[a-f0-9]{64}$/;
const sessionPattern = /^[a-f0-9]{32}$/;
const locked = new Set();

async function withLock(id, operation) {
  if (locked.has(id)) throw new Error('上传正在处理中');
  locked.add(id);
  try { return await operation(); } finally { locked.delete(id); }
}

function validateMetadata(meta, {allowExpired=false, now=Date.now()}={}) {
  if (!Number.isSafeInteger(meta.size) || meta.size < 1 || !hashPattern.test(meta.sha256) ||
      !Number.isSafeInteger(meta.partBytes) || meta.partBytes < 1 || meta.partBytes > MAX_PART_BYTES ||
      !Number.isSafeInteger(meta.expiresAt) || (!allowExpired && meta.expiresAt <= now)) throw new Error('上传元数据无效');
}

async function metadata(root, id) {
  if (!sessionPattern.test(id)) throw new Error('上传编号无效');
  const dir = join(root, id);
  const value = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  validateMetadata(value);
  return {dir, ...value};
}

async function digestFile(path) {
  const sha = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(path)) { size += chunk.length; sha.update(chunk); }
  return {size, sha256:sha.digest('hex')};
}

function partSize(meta, index) {
  const count = Math.ceil(meta.size / meta.partBytes);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error('分段编号无效');
  return Math.min(meta.partBytes, meta.size - index * meta.partBytes);
}

// 此模块不处理身份验证，调用方必须先确认原聊天和微信目标并授权每项操作。
export async function createMultipartMedia({root, size, sha256, expiresAt, partBytes=MAX_PART_BYTES}) {
  const value = {size, sha256, expiresAt, partBytes};
  validateMetadata(value);
  await mkdir(root, {recursive:true, mode:0o700});
  for (let i=0; i<5; i++) {
    const id = randomBytes(16).toString('hex'), dir = join(root,id);
    try {
      await mkdir(dir, {mode:0o700});
      await writeFile(join(dir,'manifest.json'), JSON.stringify(value), {flag:'wx',mode:0o600});
      return {id,partBytes,parts:Math.ceil(size/partBytes)};
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('无法创建上传');
}

export async function multipartStatus({root,id}) {
  const m = await metadata(root,id), count = Math.ceil(m.size/m.partBytes);
  const names = new Set(await readdir(m.dir)); let nextIndex = 0;
  while (nextIndex < count && names.has('part-'+nextIndex)) {
    if ((await stat(join(m.dir,'part-'+nextIndex))).size !== partSize(m,nextIndex)) throw new Error('暂存文件损坏');
    nextIndex++;
  }
  let nextOffset=0;
  if(nextIndex<count) {
    try {nextOffset=(await stat(join(m.dir,'resume-'+nextIndex))).size;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(nextOffset>partSize(m,nextIndex))throw new Error('续传长度损坏');
  }
  return {nextIndex,nextOffset,parts:count,complete:nextIndex===count};
}

// 删除由调用方确认不再使用的本次传输缓存，不根据文件名处理其他目录。
export async function removeMultipartMedia({root,id}) {
  if (!sessionPattern.test(id)) throw new Error('上传编号无效');
  return withLock(id, async () => {
    await rm(join(root,id), {recursive:true,force:true});
  });
}

// 只回收有合法清单且已经过期的本模块会话；使用中的会话留待下次处理。
export async function cleanupExpiredMultipart({root,now=Date.now()}) {
  if (!Number.isSafeInteger(now)) throw new Error('时间无效');
  let removed=0, skipped=0;
  let entries;
  try { entries=await readdir(root,{withFileTypes:true}); }
  catch(error) { if(error.code==='ENOENT') return {removed,skipped}; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !sessionPattern.test(entry.name) || locked.has(entry.name)) continue;
    try {
      await withLock(entry.name,async()=>{
        const dir=join(root,entry.name);
        const manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
        validateMetadata(manifest,{allowExpired:true});
        // 原桥进程的发送期限不超过会话期限，额外保留一分钟供流关闭及回执落盘。
        let sending=false;
        try {await stat(join(dir,'send-reservation.json'));sending=true;}catch(error){if(error.code!=='ENOENT')throw error;}
        if (manifest.expiresAt+(sending?60000:0)<=now) { await rm(dir,{recursive:true,force:true}); removed++; }
      });
    } catch { skipped++; }
  }
  return {removed,skipped};
}

export async function putMultipartPart({root,id,index,sha256,request,onData=()=>{}}) {
  if (!hashPattern.test(sha256) || !request) throw new Error('分段参数无效');
  return withLock(id, async () => {
    const m=await metadata(root,id), expected=partSize(m,index), target=join(m.dir,'part-'+index);
    const status=await multipartStatus({root,id});
    if (index < status.nextIndex) {
      const existing=await digestFile(target);
      if (existing.size !== expected || existing.sha256 !== sha256) throw new Error('已有分段不匹配');
      return {state:'already_received',nextIndex:status.nextIndex};
    }
    if (index !== status.nextIndex) throw new Error('分段顺序不匹配');
    // 显式偏移启用段内续传；断线保留已落盘前缀，最终仍校验整段摘要。
    const offsetHeader=request.headers?.['x-part-offset'];
    if(offsetHeader!==undefined) {
      if(!/^\d+$/.test(String(offsetHeader)))throw new Error('续传偏移无效');
      const offset=Number(offsetHeader),partial=join(m.dir,'resume-'+index),binding=partial+'.json';
      if(!Number.isSafeInteger(offset)||offset!==status.nextOffset)throw new Error('续传偏移不匹配');
      const declared=request.headers?.['content-length'];
      if(declared!==undefined&&(!/^\d+$/.test(String(declared))||Number(declared)!==expected-offset))throw new Error('续传长度不匹配');
      let previous;
      try {previous=JSON.parse(await readFile(binding,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(previous&&previous.sha256!==sha256)throw new Error('续传摘要绑定冲突');
      if(!previous)await writeFile(binding,JSON.stringify({sha256}),{flag:'wx',mode:0o600});
      let received=offset,overflow=false;
      const meter=new Transform({transform(chunk,encoding,cb){
        onData();
        received+=chunk.length;
        if(received>expected){overflow=true;return cb(new Error('续传超出预期大小'));}
        cb(null,chunk);
      }});
      try {await pipeline(request,meter,createWriteStream(partial,{flags:'a',mode:0o600}));}
      catch(error){
        if(overflow||Date.now()>=m.expiresAt){await rm(partial,{force:true});await rm(binding,{force:true});}
        throw error;
      }
      const actual=await digestFile(partial);
      if(actual.size!==expected)throw new Error('续传尚未完成');
      if(actual.sha256!==sha256){await rm(partial,{force:true});await rm(binding,{force:true});throw new Error('续传分段校验失败');}
      if(Date.now()>=m.expiresAt)throw new Error('上传已过期');
      await rename(partial,target);await rm(binding,{force:true});
      return {state:'received',nextIndex:index+1,nextOffset:0};
    }
    const declared=request.headers?.['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared)!==expected)) throw new Error('请求长度不匹配');
    const partial=join(m.dir,'partial-'+randomBytes(16).toString('hex'));
    let size=0; const hash=createHash('sha256');
    const meter=new Transform({transform(chunk,encoding,cb) {
      onData();
      size+=chunk.length;
      if(size>expected) return cb(new Error('分段超出预期大小'));
      hash.update(chunk); cb(null,chunk);
    }});
    try {
      await pipeline(request,meter,createWriteStream(partial,{flags:'wx',mode:0o600}));
      const digest=hash.digest();
      if(size!==expected || !timingSafeEqual(digest,Buffer.from(sha256,'hex'))) throw new Error('分段校验失败');
      if (Date.now()>=m.expiresAt) throw new Error('上传已过期');
      await rename(partial,target);
      return {state:'received',nextIndex:index+1};
    } finally { await rm(partial,{force:true}); }
  });
}

// 回调只在完整文件校验成功后执行；微信发送预占和未知结果处理由调用方承担。
export async function assembleMultipartMedia({root,id,onVerified}) {
  if(typeof onVerified!=='function') throw new Error('缺少处理器');
  return withLock(id,async()=>{
    const m=await metadata(root,id), status=await multipartStatus({root,id});
    if(!status.complete) throw new Error('上传尚未完成');
    const scratch=await mkdtemp(join(m.dir,'assemble-')), path=join(scratch,'payload');
    try {
      const output=await open(path,'wx',0o600), sha=createHash('sha256'), md5=createHash('md5'); let size=0;
      try {
        for(let i=0;i<status.parts;i++) {
          for await(const chunk of createReadStream(join(m.dir,'part-'+i))) {
            size+=chunk.length;
            if(size>m.size) throw new Error('文件长度异常');
            sha.update(chunk); md5.update(chunk);
            let offset=0;
            while(offset<chunk.length) { const result=await output.write(chunk,offset,chunk.length-offset); if(!result.bytesWritten) throw new Error('文件写入失败'); offset+=result.bytesWritten; }
          }
        }
      } finally { await output.close(); }
      const actual=sha.digest();
      if(size!==m.size || !timingSafeEqual(actual,Buffer.from(m.sha256,'hex'))) throw new Error('完整文件校验失败');
      if(Date.now()>=m.expiresAt) throw new Error('上传已过期');
      return await onVerified({path,size,sha256:actual.toString('hex'),md5:md5.digest('hex')});
    } finally { await rm(scratch,{recursive:true,force:true}); }
  });
}
