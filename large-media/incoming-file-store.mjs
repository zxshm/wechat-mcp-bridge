import {acquireBridgeLock} from '../wechat-live-stage/wechat-single-writer.mjs';
import {createHash,createDecipheriv,randomBytes,timingSafeEqual} from 'node:crypto';
import {createReadStream,createWriteStream,constants} from 'node:fs';
import {mkdir,open,readFile,readdir,rename,rm,stat,lstat,realpath,statfs,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const ID=/^[a-f0-9]{64}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
const failure=code=>Object.assign(new Error(code),{code});
const json=async file=>{
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{if((await handle.stat()).size>8192)throw failure('incoming_media_unavailable');return JSON.parse(await handle.readFile('utf8'));}
  finally{await handle.close();}
};
async function atomicJson(file,value){
  const temporary=file+'.'+randomBytes(8).toString('hex');
  try{await writeFile(temporary,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(temporary,file);}
  finally{await rm(temporary,{force:true});}
}

// 文件字节保存在私有磁盘，大小按剩余空间准入，读取时只分配当前块。
export class IncomingFileStore {
  constructor({root,resolveUrl,parseKey,safeFilename,origin,fetcher=fetch,clock=Date.now,headroom=256*1024*1024,maxSessions=8,acquireLock=acquireBridgeLock}){
    this.root=resolve(root);Object.assign(this,{resolveUrl,parseKey,safeFilename,origin,fetcher,clock,headroom,maxSessions,acquireLock});
    this.loading=new Map();this.grants=new Map();this.controllers=new Set();
  }
  async initialize(){
    await mkdir(this.root,{recursive:true,mode:0o700});
    const info=await lstat(this.root);
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(this.root)!==this.root||
       (process.platform!=='win32'&&((info.mode&0o077)||(process.getuid&&info.uid!==process.getuid()))))
      throw failure('incoming_media_storage_unavailable');
  }
  async cleanup(){
    await this.initialize();
    for(const id of await readdir(this.root)){
      if(!ID.test(id)||this.loading.has(id))continue;
      let release;
      try{release=await this.acquireLock(this.lockPath(id));}catch{continue;}
      try{
        const directory=join(this.root,id);let info;
        try{info=await lstat(directory);}catch(error){if(error.code==='ENOENT')continue;throw error;}
        if(!info.isDirectory()||info.isSymbolicLink())throw failure('incoming_media_storage_unavailable');
        let expired;
        try{expired=(await json(join(directory,'ready.json'))).expiresAt<=this.clock();}
        catch(error){if(error.code!=='ENOENT')throw error;expired=info.mtimeMs+1800000<=this.clock();}
        // 校验后的目录在私有根目录内，跨进程锁保护下载与到期清理。
        if(expired){await rm(directory,{recursive:true});this.grants.delete(id);}
      }finally{await release();}
    }
  }
  lockPath(id){return join(this.root,'incoming-slot-'+(parseInt(id.slice(0,2),16)%16));}

  async prepare({eventId,media,expiresAt}){
    if(this.closed||media?.mediaKind!=='file'||typeof eventId!=='string'||!Number.isSafeInteger(expiresAt)||expiresAt<=this.clock())
      throw failure('incoming_media_expired');
    const id=hash(eventId);
    if(this.loading.has(id))return this.loading.get(id);
    if(this.loading.size>=this.maxSessions)throw failure('incoming_media_capacity');
    const operation=(async()=>{
      await this.initialize();let release;
      try{release=await this.acquireLock(this.lockPath(id));}
      catch{throw failure('incoming_media_busy');}
      try{return await this.download({id,eventId,media,expiresAt});}
      finally{await release();}
    })().finally(()=>this.loading.delete(id));
    this.loading.set(id,operation);return operation;
  }
  async download({id,eventId,media,expiresAt}){
    await this.cleanup();
    const directory=join(this.root,id),manifest=join(directory,'ready.json');
    try{
      const existing=await json(manifest);
      if(existing.eventId!==eventId||existing.expiresAt>expiresAt||existing.fileName!==this.safeFilename(media.fileName)||
         (Number.isSafeInteger(media.declaredLength)&&existing.size!==media.declaredLength))
        throw failure('incoming_media_identity_mismatch');
      if(existing.expiresAt>this.clock())return await this.entry(id,existing);
      this.grants.delete(id);await rm(join(directory,'access.json'),{force:true});
    }catch(error){if(error.code!=='ENOENT')throw error;}
    if((await readdir(this.root)).filter(name=>ID.test(name)&&name!==id).length>=this.maxSessions)
      throw failure('incoming_media_capacity');
    // 另一个进程可能已清理过期目录，本进程的旧下载凭证同时失效。
    this.grants.delete(id);
    const declared=media.declaredLength;
    if(declared!==undefined&&(!Number.isSafeInteger(declared)||declared<1))throw failure('incoming_media_length_mismatch');
    const space=await statfs(this.root),reserved=[...this.loading.keys()].length*8*1024*1024;
    if(space.bavail*space.bsize<this.headroom+(declared||0)+reserved)throw failure('incoming_media_no_space');
    await mkdir(directory,{recursive:true,mode:0o700});
    const directoryInfo=await lstat(directory);
    if(!directoryInfo.isDirectory()||directoryInfo.isSymbolicLink()||await realpath(directory)!==directory)throw failure('incoming_media_storage_unavailable');
    const temporary=join(directory,'partial-'+randomBytes(8).toString('hex'));
    const controller=new AbortController();this.controllers.add(controller);
    const duration=Math.max(1,Math.min(900000,expiresAt-this.clock()));
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(duration)]);
    let key,stage='network',idle;
    const resetIdle=()=>{clearTimeout(idle);idle=setTimeout(()=>controller.abort(),60000);idle.unref();};
    try{
      const response=await this.fetcher(this.resolveUrl(media),{method:'GET',redirect:'error',signal});
      if(!response.ok||!response.body)throw failure('incoming_media_download_failed');
      key=this.parseKey(media);
      const decipher=createDecipheriv('aes-128-ecb',key,null),digest=createHash('sha256');
      let size=0,checked=0;
      const meter=new Transform({transform:(chunk,_encoding,callback)=>{
        size+=chunk.length;digest.update(chunk);resetIdle();
        if((declared!==undefined&&size>declared)||!Number.isSafeInteger(size))return callback(failure('incoming_media_length_mismatch'));
        const inspect=size-checked>=8*1024*1024;
        if(!inspect)return callback(null,chunk);
        checked=size;
        statfs(this.root).then(info=>{
          if(info.bavail*info.bsize<this.headroom)callback(failure('incoming_media_no_space'));
          else callback(null,chunk);
        },()=>callback(failure('incoming_media_storage_unavailable')));
      }});
      resetIdle();stage='decrypt';
      const body=typeof response.body.getReader==='function'?Readable.fromWeb(response.body):Readable.from(response.body);
      await pipeline(body,decipher,meter,createWriteStream(temporary,{flags:'wx',mode:0o600}),{signal});
      if(!size||(declared!==undefined&&size!==declared))throw failure('incoming_media_length_mismatch');
      if(this.closed||this.clock()>=expiresAt)throw failure('incoming_media_expired');
      const handle=await open(temporary,'r+');try{await handle.sync();}finally{await handle.close();}
      const payload=join(directory,'payload');await rename(temporary,payload);
      const info=await stat(payload);
      const record={eventId,fileName:this.safeFilename(media.fileName),mimeType:'application/octet-stream',size,
        sha256:digest.digest('hex'),expiresAt:Math.min(expiresAt,this.clock()+900000),
        device:String(info.dev),inode:String(info.ino),mtimeMs:info.mtimeMs};
      await atomicJson(manifest,record);return await this.entry(id,record);
    }catch(error){
      controller.abort();
      await rm(temporary,{force:true});
      if(/^incoming_media_[a-z_]+$/.test(error.code||''))throw error;
      if(error.code==='ENOSPC')throw failure('incoming_media_no_space');
      throw failure(stage==='network'?'incoming_media_download_failed':'incoming_media_decrypt_failed');
    }finally{clearTimeout(idle);key?.fill(0);this.controllers.delete(controller);}
  }
  async entry(id,record){
    const payload=join(this.root,id,'payload');
    const checked=await openPayload(payload,record,this.clock());await checked.close();
    return {...record,storage:'disk',
      readChunk:async(offset,length)=>{
        const handle=await openPayload(payload,record,this.clock());
        try{const buffer=Buffer.alloc(length);const {bytesRead}=await handle.read(buffer,0,length,offset);return buffer.subarray(0,bytesRead);}
        finally{await handle.close();}
      },
      download:async()=>{
        if(this.closed||this.clock()>=record.expiresAt)throw failure('incoming_media_expired');
        if(!this.origin)return undefined;
        const origin=new URL(this.origin);
        if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)
          throw failure('incoming_media_endpoint_unavailable');
        if(!this.grants.has(id)){
          const grant=(async()=>{
            const token=randomBytes(32).toString('base64url');
            await atomicJson(join(this.root,id,'access.json'),{tokenHash:hash(token),expiresAt:record.expiresAt});
            return token;
          })();
          this.grants.set(id,grant);
          grant.catch(()=>{if(this.grants.get(id)===grant)this.grants.delete(id);});
        }
        return {endpoint:origin.origin+'/incoming/'+id+'/file',token:await this.grants.get(id),expiresAt:record.expiresAt,
          size:record.size,sha256:record.sha256,method:'GET',authorization:'Bearer token in Authorization header',
          range:'bytes=start-end',redirects:'reject',instruction:'在云端用 HTTPS 连续下载原始字节，核对大小和 SHA-256 后交付附件；支持 Range 续传。'};
      }
    };
  }
  close(){this.closed=true;for(const controller of this.controllers)controller.abort();this.grants.clear();}
}

async function openPayload(file,record,now){
  if(!Number.isSafeInteger(record.size)||record.size<1||!/^[a-f0-9]{64}$/.test(record.sha256)||!Number.isSafeInteger(record.expiresAt)||now>=record.expiresAt)throw failure('incoming_media_expired');
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.nlink!==1||info.size!==record.size||String(info.dev)!==record.device||
       String(info.ino)!==record.inode||info.mtimeMs!==record.mtimeMs)throw failure('incoming_media_unavailable');
    return handle;
  }catch(error){await handle.close();throw error;}
}

// 复用已有文件 HTTPS 入口，授权仅覆盖单个已验证的入站文件。
export async function serveIncomingFile(req,res,{root,clock=Date.now}){
  const match=/^\/incoming\/([a-f0-9]{64})\/file$/.exec(req.url||'');
  if(!match)return false;
  const respond=(status,code)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({error:code}));};
  if(!['GET','HEAD'].includes(req.method)){respond(405,'method_not_allowed');return true;}
  let handle;
  try{
    const directory=join(resolve(root),match[1]),info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory)throw failure('incoming_media_unavailable');
    const access=await json(join(directory,'access.json'));
    const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'');
    if(!token||!/^[a-f0-9]{64}$/.test(access.tokenHash)||!Number.isSafeInteger(access.expiresAt)||clock()>=access.expiresAt||
       !timingSafeEqual(Buffer.from(hash(token[1]),'hex'),Buffer.from(access.tokenHash,'hex'))){respond(403,'incoming_media_not_authorized');return true;}
    const record=await json(join(directory,'ready.json'));
    handle=await openPayload(join(directory,'payload'),record,clock());
    let start=0,end=record.size-1;
    if(req.headers.range){
      const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if(!range){respond(416,'invalid_range');return true;}
      start=Number(range[1]);end=range[2]?Number(range[2]):end;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||end>=record.size){respond(416,'invalid_range');return true;}
    }
    res.writeHead(req.headers.range?206:200,{'content-type':'application/octet-stream','content-length':end-start+1,
      'accept-ranges':'bytes','cache-control':'no-store','x-content-sha256':record.sha256,
      ...(req.headers.range?{'content-range':`bytes ${start}-${end}/${record.size}`}:{})});
    if(req.method==='HEAD'){res.end();return true;}
    const timer=setTimeout(()=>res.destroy(),Math.max(1,record.expiresAt-clock()));timer.unref();
    try{await pipeline(handle.createReadStream({start,end,autoClose:false}),res);}
    finally{clearTimeout(timer);}
  }catch(error){if(!res.headersSent)respond(error.code==='ENOENT'?404:410,'incoming_media_unavailable');else res.destroy();}
  finally{await handle?.close();}
  return true;
}
