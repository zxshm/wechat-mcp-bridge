import {createHash} from 'node:crypto';
import {open,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {assembleMultipartMedia} from './multipart-media.mjs';
import {sendBinaryFile} from './binary-media-wechat.mjs';

// 此模块必须在原微信桥进程中使用，复用其发送锁、会话额度和真实发送回执。
// 接收服务不加载本模块。verifySource 必须核实原聊天真实附件，不能只相信客户端元数据。
export function createLargeMediaBridgeAdapter({root,owner,bridge,verifySource,safeFilename,cdnUploadUrl,sendFile=sendBinaryFile,clock=Date.now}) {
  if(typeof verifySource!=='function'||typeof safeFilename!=='function'||typeof cdnUploadUrl!=='function') throw new Error('缺少原来源校验或微信适配器');
  return async function sendVerified({uploadId,eventId}) {
    if(!/^[a-f0-9]{32}$/.test(uploadId)||typeof eventId!=='string') throw new Error('请求无效');
    const b=typeof bridge==='function'?bridge():bridge;
    if(!b||b.owner!==owner||b.state?.phase!=='armed') throw new Error('原微信桥不可用');
    const folder=join(root,uploadId),state=JSON.parse(await readFile(join(folder,'access.json'),'utf8'));
    if(state.state!=='verified'||state.expiresAt<=clock()||state.roomId!==(process.env.BRIDGE_ROOM_ID||'example-room')) throw new Error('文件未验证或已过期');
    if(state.boundEventId!==undefined&&state.boundEventId!==eventId)throw new Error('上传绑定的微信事件不匹配');
    const source={sourceId:state.sourceId,roomId:state.roomId,fileName:state.fileName,size:state.size,sha256:state.sha256};
    if(await verifySource(source)!==true) throw new Error('附件真实来源未核实');
    // 不以随机上传编号生成发送身份，同一原附件换上传编号不能获得新发送资格。
    const key='large-file-v1-'+createHash('sha256').update(JSON.stringify(source)).digest('hex');
    return assembleMultipartMedia({root,id:uploadId,onVerified:async file=>{
      if(file.size!==state.size||file.sha256!==state.sha256)throw new Error('授权文件不匹配');
      let marker;
      try {marker=await open(join(folder,'send-reservation.json'),'wx',0o600);}
      catch(e) {
        if(e.code!=='EEXIST')throw e;
        try {return JSON.parse(await readFile(join(folder,'send-result.json'),'utf8'));}
        catch {return {state:'reserved_unknown',retrySendAllowed:false};}
      }
      // 写前预占确保崩溃后不会把未知发送当成从未发送。
      try {await marker.writeFile(JSON.stringify({state:'reserved_unknown',key}));await marker.sync();}
      finally {await marker.close();}
      async function recordResult(value) {
        const temporary=join(folder,'send-result.pending'),handle=await open(temporary,'wx',0o600);
        try {await handle.writeFile(JSON.stringify(value));await handle.sync();} finally {await handle.close();}
        await rename(temporary,join(folder,'send-result.json'));
        return value;
      }
      let started=false,targetId=eventId,draft;
      const stages=[{stage:'verified_file_ready',at:clock()}];
      const start=reserved=>{
        targetId=reserved.effectiveEventId||eventId;
        const deadline=Math.min(state.expiresAt,reserved.expiresAt);
        if(clock()>=deadline)throw new Error('发送期限已过');
        started=true;
        return sendFile({...file,fileName:state.fileName,sessionToken:b.state.sessionToken,toUserId:reserved.to_user_id,
          contextToken:reserved.context_token,clientId:reserved.clientId,deadline,clock,safeFilename,cdnUploadUrl,
          trace:item=>stages.push(item)});
      };
      try {
        draft=await b.mediaReplyDraft(owner,{eventId,idempotencyKey:key,kind:'file',fileName:safeFilename(state.fileName),sha256:state.sha256},clock,{start});
        if(draft.state)return await recordResult({state:draft.state,retrySendAllowed:false});
        targetId=draft.effectiveEventId||eventId;
        if(draft.execution) {const outcome=await draft.execution;if(Object.hasOwn(outcome,'error'))throw outcome.error;}
        else await start(draft);
        await b.replySent(owner,targetId,key,clock());
        return await recordResult({state:'sent',retrySendAllowed:false,stages});
      } catch(error) {
        if(!started&&draft?.clientId)try {await b.discardUnstartedReply(owner,targetId,key,draft.clientId);}catch {}
        const result={state:started?'uncertain':'not_sent',retrySendAllowed:false,stages,
          reason:['upstream_upload_rejected','upstream_media_rejected','context_budget_exhausted','context_notice_requires_text','context_scope_unverified','key_seen_elsewhere'].includes(error?.code)?error.code:'operation_unconfirmed'};
        try {return await recordResult(result);} catch {return {state:'reserved_unknown',retrySendAllowed:false};}
      }
    }});
  };
}
