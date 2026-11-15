import {performance} from 'node:perf_hooks';
import {computeSyncContentDigest} from './source-content-digest.mjs';

// 历史查询函数仅由已鉴权宿主注入，客户端不能提交或伪造历史证据。
export function registerCombinedPreparation(server,{z,store,bridge,actor,inspectSubmission,inspectDirect,name='minihome_inspect_and_prepare_sync_submission'}){
 const id=z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),number=z.number().int().nonnegative().safe();
 server.registerTool(name,{
  description:'为原 dot 对话的新普通文字合并来源观察、完整提交及直发历史核查、固定请求元数据与首次预占。调用方须先核实真实原聊天、作者、原文、时间、当前任务职责和有效本人微信事件。本工具在桥进程锁和账本事务内执行；返回完整历史与原绑定元数据，历史不足或既有尝试不预占。与原工具共用账本，不恢复旧未知或拒绝项。仅本次 acquired=true 且 firstSubmissionClaim=true 可继续原 enqueue 首次请求及平台审批；丢失响应只读对账。本工具不发送微信、不存正文、不授予跨路径锁。',
  inputSchema:z.object({sourceId:id,role:z.enum(['user','assistant','progress']),sourceCreatedAt:number,sourceExpiresAt:number,eventId:id,sourceText:z.string().min(1).max(8192)}).strict(),
  annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}
 },async p=>{
  const started=performance.now();let lockStarted;
  const timing=()=>({totalMs:performance.now()-started,lockWaitMs:lockStarted===undefined?null:lockStarted-started,processingMs:lockStarted===undefined?null:performance.now()-lockStarted});
  const answer=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
  try{
   const active=typeof bridge==='function'?bridge():bridge;
   if(!active||active.owner!==actor||active.state?.phase!=='armed'||typeof active.locked!=='function'||typeof inspectSubmission!=='function'||typeof inspectDirect!=='function')throw Error('source_bridge_unavailable');
   const {sourceText,...metadata}=p,digest=computeSyncContentDigest(sourceText);
   const result=await active.locked(()=>{
    lockStarted=performance.now();active.check(actor);
    if(active.state?.phase!=='armed')throw Error('source_bridge_unavailable');
    return store.prepareWithHistory({...metadata,contentDigest:digest.contentDigest},()=>{
     const now=Date.now(),args={sourceId:p.sourceId,role:p.role,contentDigest:digest.contentDigest,sourceCreatedAt:p.sourceCreatedAt,sourceExpiresAt:p.sourceExpiresAt};
     return {...inspectSubmission(active.state,args,now,active.submissionCoverage),directAttemptCoverage:inspectDirect(active.directAttemptCoverage,args,now)};
    });
   });
   return answer({...result,...digest,schemaVersion:1,timing:timing()});
  }catch(e){
   if(e.message==='source_history_not_clear')return answer({acquired:false,firstSubmissionClaim:false,retrySendAllowed:false,reason:e.message,history:e.history,timing:timing()});
   const code=/^source_[a-z_]+$/.test(e.message)?e.message:'source_combined_unavailable_read_before_retry';
   return {...answer({error_code:code,acquired:false,firstSubmissionClaim:false,retrySendAllowed:false,timing:timing()}),isError:true};
  }
 });
}
