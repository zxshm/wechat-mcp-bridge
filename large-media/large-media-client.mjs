import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export async function hashMediaFile(path,{start,end}={}) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path,{start,end})) hash.update(chunk);
  return hash.digest('hex');
}

// 描述符由受认证控制端提供。凭证只放请求头，不写日志、URL或命令行。
// 仅对临时网络错误恢复同一上传；先查询已确认进度，绝不发送微信消息。
export async function uploadLargeMedia({path,baseUrl,upload,fetcher=fetch,onProgress=()=>{},maxRetries=32,retryDelayMs=2000}) {
  if(!Number.isInteger(maxRetries)||maxRetries<0||maxRetries>64||!Number.isFinite(retryDelayMs)||retryDelayMs<0) throw new Error('重试参数无效');
  const base=new URL(baseUrl);
  if(base.username||base.password||base.search||base.hash||base.pathname!=='/'||
    !(base.protocol==='https:'||(base.protocol==='http:'&&base.hostname==='127.0.0.1'))) throw new Error('上传地址无效');
  if(!/^[a-f0-9]{32}$/.test(upload.id)||!Number.isSafeInteger(upload.partBytes)||upload.partBytes<1||upload.partBytes>90000000) throw new Error('上传描述符无效');
  const before=await stat(path);
  if(!before.isFile()||before.size!==upload.size||await hashMediaFile(path)!==upload.sha256) throw new Error('本地文件与授权不符');
  const endpoint=new URL('/uploads/'+upload.id,base).href;
  async function call(url,options={}) {
    const remaining=upload.expiresAt-Date.now();
    if(remaining<=0) throw new Error('上传授权已过期');
    const response=await fetcher(url,{...options,headers:{authorization:'Bearer '+upload.token,...options.headers},redirect:'error',signal:AbortSignal.timeout(Math.min(remaining,1800000))});
    if(!response.ok) {
      let detail;try {detail=await response.json();}catch {}
      const error=new Error('上传接口返回 '+response.status);
      error.retryable=[408,429,500,502,503,504,520,522,524].includes(response.status)||(response.status===409&&detail?.error==='upload_busy');
      throw error;
    }
    return response.json();
  }
  const transient=error=>error.retryable===true||((error instanceof TypeError)&&['fetch failed','terminated'].includes(error.message))||error.name==='TimeoutError';
  async function recover(operation) {
    for(let attempt=0;;attempt++) {
      try {return await operation();}catch(error) {
        if(attempt>=maxRetries||!transient(error)) throw error;
        await new Promise(resolve=>setTimeout(resolve,retryDelayMs*(attempt+1)));
      }
    }
  }
  const count=Math.ceil(upload.size/upload.partBytes);
  async function progress() {
    for(;;){
      const status=await recover(()=>call(endpoint));
      if(!Number.isSafeInteger(status.nextIndex)||status.nextIndex<0||status.nextIndex>count) throw new Error('上传进度无效');
      if(!status.active)return status;
      await new Promise(resolve=>setTimeout(resolve,Math.max(100,retryDelayMs)));
    }
  }
  const status=await progress();
  for(let index=status.nextIndex;index<count;index++) {
    const start=index*upload.partBytes,end=Math.min(upload.size,start+upload.partBytes)-1;
    const sha256=await hashMediaFile(path,{start,end});
    await recover(async()=>{
      // 丢失响应不等于分段丢失；确认服务端仍缺此段后才重新传输原字节。
      const current=await progress();
      if(current.nextIndex>index) return;
      const offset=current.nextOffset??0;
      if(current.nextIndex!==index||!Number.isSafeInteger(offset)||offset<0||offset>end-start+1)throw new Error('段内续传进度无效');
      const body=offset===end-start+1?null:createReadStream(path,{start:start+offset,end});
      try {
        const result=await call(endpoint+'/parts/'+index,{method:'PUT',duplex:'half',body,
          headers:{'content-type':'application/octet-stream','content-length':String(end-start+1-offset),'x-part-sha256':sha256,'x-part-offset':String(offset),'x-upload-progress':'keepalive'}});
        if(!['received','already_received'].includes(result.state)||result.nextIndex!==index+1) throw new Error('分段最终校验未通过');
      } finally {body?.destroy();}
    });
    onProgress({completedParts:index+1,totalParts:count,bytes:end+1});
  }
  const after=await stat(path);
  if(after.size!==before.size||after.mtimeMs!==before.mtimeMs) throw new Error('上传期间原文件发生变化');
  const result=await recover(()=>call(endpoint+'/finish',{method:'POST'}));
  if(result.state!=='verified'||result.sha256!==upload.sha256||result.size!==upload.size) throw new Error('服务端完整文件校验失败');
  return result;
}
