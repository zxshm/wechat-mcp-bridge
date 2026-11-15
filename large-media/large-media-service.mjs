import {IncomingFileStore,serveIncomingFile} from './incoming-file-store.mjs';
import http from 'node:http';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdir, readFile, readdir, rename, stat, statfs, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createMultipartMedia, putMultipartPart, multipartStatus, assembleMultipartMedia, cleanupExpiredMultipart} from './multipart-media.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const idPattern = /^[a-f0-9]{32}$/;
async function jsonBody(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if(size>8192) throw new Error('元数据过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const reply=(res,status,value)=>res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(value));

// 独立服务只接收文件，不持有微信凭据、不修改消息账本，也不发送微信。
// 创建上传仅经权限为 0600 的本机控制套接字；HTTP 凭证只授权一个上传。
export async function createLargeMediaService({root, headroom=256*1024*1024, maxSessions=8, maxActive=2,defaultPartBytes=90_000_000,progressIntervalMs=15000,uploadIdleMs=60000}) {
  if(!Number.isSafeInteger(progressIntervalMs)||progressIntervalMs<10||progressIntervalMs>60000) throw new Error('上传保活间隔无效');
  if(!Number.isSafeInteger(uploadIdleMs)||uploadIdleMs<10||uploadIdleMs>120000)throw new Error('收包空闲期限无效');
  await mkdir(root,{recursive:true,mode:0o700});
  const incomingFiles=new IncomingFileStore({root:join(root,'incoming')});
  const busy=new Set(); let creating=false;
  const statePath=id=>join(root,id,'access.json');
  const readState=async id=>JSON.parse(await readFile(statePath(id),'utf8'));
  async function saveState(id,state) {
    const temporary=join(root,id,'access-'+randomBytes(8).toString('hex'));
    await writeFile(temporary,JSON.stringify(state),{mode:0o600,flag:'wx'});
    await rename(temporary,statePath(id));
  }
  async function create(args) {
    if(creating) throw new Error('创建上传繁忙');
    creating=true;
    try {
      const {size,sha256,fileName,sourceId,roomId,expiresAt,boundEventId,partBytes=defaultPartBytes}=args;
      if(!Number.isSafeInteger(size)||size<1||size>Number.MAX_SAFE_INTEGER/2 ||
        !/^[a-f0-9]{64}$/.test(sha256)||typeof fileName!=='string'||!fileName.length||fileName.length>255||/[\x00-\x1f\\/]/.test(fileName)||
        typeof sourceId!=='string'||!sourceId.length||sourceId.length>200||
        roomId!==(process.env.BRIDGE_ROOM_ID||'example-room')||
        !Number.isSafeInteger(partBytes)||partBytes<1||partBytes>90_000_000||
        (boundEventId!==undefined&&!/^[A-Za-z0-9_-]{1,160}$/.test(boundEventId))||
        !Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||expiresAt>Date.now()+86400000) throw new Error('上传参数无效');
      let reserved=0,count=0;
      for(const entry of await readdir(root)) {
        if(!idPattern.test(entry)) continue;
        const state=await readState(entry);
        if(state.sourceId===sourceId&&state.expiresAt>Date.now()) {
          // 同一来源的重复 begin 只恢复原上传凭证，不改变身份、分段或有效期。
          if(state.size!==size||state.sha256!==sha256||state.fileName!==fileName||state.roomId!==roomId||state.boundEventId!==boundEventId) throw new Error('原上传来源绑定不一致');
          if(busy.has(entry)) throw new Error('原上传仍在处理中');
          let reserved=false;
          try{await stat(join(root,entry,'send-reservation.json'));reserved=true;}catch(error){if(error.code!=='ENOENT')throw error;}
          if(reserved) throw new Error('原上传已有发送预占，只可查询结果');
          const manifest=JSON.parse(await readFile(join(root,entry,'manifest.json'),'utf8'));
          const token=randomBytes(32).toString('base64url');
          await saveState(entry,{...state,tokenHash:digest(token)});
          return {id:entry,partBytes:manifest.partBytes,parts:Math.ceil(size/manifest.partBytes),token,size,sha256,expiresAt:state.expiresAt,reused:true};
        }
        if(state.expiresAt>Date.now()) {reserved+=state.size*2;count++;}
      }
      const fs=await statfs(root);
      if(count>=maxSessions||fs.bavail*fs.bsize<reserved+size*2+headroom) throw new Error('暂存空间或会话数量不足');
      const upload=await createMultipartMedia({root,size,sha256,expiresAt,partBytes});
      const token=randomBytes(32).toString('base64url');
      const state={size,sha256,fileName,sourceId,roomId,expiresAt,boundEventId,tokenHash:digest(token),state:'uploading'};
      await saveState(upload.id,state);
      return {...upload,token,size,sha256,expiresAt};
    } finally {creating=false;}
  }
  async function authorize(req,id) {
    const token=req.headers.authorization;
    if(typeof token!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(token)) throw new Error('未授权');
    const state=await readState(id);
    if(state.expiresAt<=Date.now()||!timingSafeEqual(Buffer.from(digest(token.slice(7)),'hex'),Buffer.from(state.tokenHash,'hex'))) throw new Error('未授权');
    return state;
  }
  // 90 MB 在慢速公网链路上可能超过 Node 默认的五分钟收包期限。
  // 总收包上限三十分钟，另保留连接空闲超时和上传凭证有效期。
  const app=http.createServer({requestTimeout:1800000},async(req,res)=>{
    req.setTimeout(120000,()=>req.destroy());
    if(await serveIncomingFile(req,res,{root:join(root,'incoming')}))return;
    if(req.method==='GET'&&req.url==='/healthz') return reply(res,200,{status:'ok',mode:'receive_only',active:busy.size});
    const match=/^\/uploads\/([a-f0-9]{32})(?:\/parts\/(\d+)|\/(finish))?$/.exec(req.url||'');
    if(!match) return reply(res,404,{error:'not_found'});
    const [,id,index,finish]=match;
    let state;
    try {state=await authorize(req,id);} catch {return reply(res,403,{error:'upload_not_authorized'});}
    if(req.method==='GET'&&index===undefined&&!finish) {
      try {return reply(res,200,{...await multipartStatus({root,id}),active:busy.has(id),state:state.state,size:state.size,sha256:state.sha256});}
      catch {return reply(res,409,{error:'upload_unavailable'});}
    }
    if(busy.has(id)||busy.size>=maxActive) return reply(res,409,{error:'upload_busy'});
    busy.add(id);
    let progressTimer,expiryTimer,idleTimer;
    const resetIdle=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(()=>req.destroy(),uploadIdleMs);idleTimer.unref();};
    try {
      if(req.method==='PUT'&&index!==undefined) {
        if(state.state!=='uploading') return reply(res,409,{error:'upload_already_verified'});
        if(req.headers['content-type']!=='application/octet-stream') return reply(res,415,{error:'binary_body_required'});
        expiryTimer=setTimeout(()=>req.destroy(),Math.max(1,state.expiresAt-Date.now()));
        expiryTimer.unref();
        // 响应保活不能刷新请求体的收包期限，避免断线后的旧请求长期占用上传。
        resetIdle();
        // 可选流式响应：JSON 前导空白维持代理读取，不将提前返回的 HTTP 200 当作上传完成。
        // 客户端必须读完整个响应，并验证最终 JSON 的 state 和 nextIndex。
        if(req.headers['x-upload-progress']==='keepalive') {
          res.writeHead(200,{'content-type':'application/json','cache-control':'no-store, no-transform','x-accel-buffering':'no'});
          res.flushHeaders();res.write(' ');
          progressTimer=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write(' ');},progressIntervalMs);
          progressTimer.unref();
        }
        const result=await putMultipartPart({root,id,index:Number(index),sha256:req.headers['x-part-sha256'],request:req,onData:resetIdle});
        if(res.headersSent) return res.end(JSON.stringify(result));
        return reply(res,200,result);
      }
      if(req.method==='POST'&&finish) {
        if(state.state!=='verified') {
          // 验收仅返回摘要；不将临时磁盘路径暴露给上传者。
          const result=await assembleMultipartMedia({root,id,onVerified:async file=>({size:file.size,sha256:file.sha256})});
          state={...state,...result,state:'verified'};
          await saveState(id,state);
        }
        return reply(res,200,{state:'verified',size:state.size,sha256:state.sha256,sent:false});
      }
      return reply(res,405,{error:'method_not_allowed'});
    } catch {if(!res.destroyed) {
      const failure={error:'upload_incomplete_or_invalid'};
      if(res.headersSent)res.end(JSON.stringify(failure));else reply(res,409,failure);
    }}
    finally {clearInterval(progressTimer);clearTimeout(expiryTimer);clearTimeout(idleTimer);busy.delete(id);}
  });
  const control=http.createServer(async(req,res)=>{
    try {
      if(req.method==='POST'&&req.url==='/uploads') return reply(res,201,await create(await jsonBody(req)));
      return reply(res,404,{error:'not_found'});
    } catch {return reply(res,409,{error:'invalid_metadata_or_capacity'});}
  });
  // 回收与上传互斥；不删除尚在处理的会话。
  async function cleanup() {
    if(creating||busy.size) return;
    creating=true;
    try {const result=await cleanupExpiredMultipart({root});await incomingFiles.cleanup();return result;} finally {creating=false;}
  }
  return {app,control,cleanup};
}
