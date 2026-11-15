import {syncDiagnostic,replyIdFor} from './sync-diagnostic.mjs';
import {timing} from './latency-metrics.mjs';
import {contextDiagnostics} from './context-diagnostics.mjs';
import {normalizeUpdates} from '../wechat-live-stage/wechat-updates-normalize.mjs';
// Bounded transport. No action is executed by importing this module.
import {updatesRequest,replyRequest,parseWire} from './weixin-adapter.mjs';
async function execute(request,transport,timeoutMs,signal,{deadline,clock=Date.now,onHttpStatus=()=>{}}={}){if(signal?.aborted||Number.isFinite(deadline)&&clock()>=deadline)throw Object.assign(new Error('Send expired'),{code:'expired_before_send'});
 if(typeof transport!=='function')throw new Error('Transport unavailable');
 let response;try{response=await transport(request.url,{...request.options,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});}catch{throw Object.assign(new Error('Upstream transport failed'),{code:'network_failure'});}
 if(Number.isInteger(response?.status))onHttpStatus(response.status);
 if(!response?.ok)throw Object.assign(new Error('Upstream rejected'),{code:'http_failure'});if(!response.body)throw Object.assign(new Error('Upstream response invalid'),{code:'response_failure'});let total=0;const chunks=[];
 try{for await(const chunk of response.body){total+=chunk.length;if(total>262144)throw new Error();chunks.push(chunk);}}catch{throw Object.assign(new Error('Upstream response invalid'),{code:'response_failure'});}
 try{const value=parseWire(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}catch{throw Object.assign(new Error('Upstream response invalid'),{code:'response_failure'});}
}
export async function pollOnce({bridge,actor,transport=fetch,now,clock=now===undefined?Date.now:()=>now,signal}){
 if(signal?.aborted)throw new Error('Poll stopped');
 if(bridge?.state?.phase!=='armed'||actor!==bridge.owner)throw new Error('Bridge not armed');const s=bridge.state;
 const batch=await execute(updatesRequest({token:s.sessionToken,cursor:s.core.cursor}),transport,35000,signal);
 if(signal?.aborted)throw new Error('Poll stopped');return bridge.ingest(actor,normalizeUpdates(batch,{previousCursor:s.core.cursor,allowMessagesWithoutCursor:true}),clock(),clock);
}
export async function replyOnce({bridge,actor,eventId,text,idempotencyKey,syncPartId,syncId,replyPurpose,nextUpdateAt,replyToEventId,mayStart=()=>true,transport=fetch,now=Date.now(),clock=Date.now,diagnostic=(id,key,stage,detail)=>timing.markReply(id,key,stage,detail),syncLog=syncDiagnostic}){
 if(bridge?.state?.phase!=='armed'||actor!==bridge.owner)throw new Error('Bridge not armed');
 let effectiveEventId=eventId,result,httpStatus,contextAttempt,started=false,diagnosticStart=clock();const replyId=replyIdFor(idempotencyKey);
 const diag=(stage,detail={})=>{try{syncLog({stage,syncId,replyId,sendStarted:started,historyCoverage:'incomplete',elapsedMs:Math.max(0,clock()-diagnosticStart),httpStatus,...detail})}catch{}};
 const contextDone=category=>{try{contextDiagnostics.complete(contextAttempt,category,clock())}catch{}};
 const report=(stage,detail={})=>{try{diagnostic(effectiveEventId,idempotencyKey,stage,{httpStatus,...detail})}catch{}};
 const trackedTransport=(...args)=>{started=true;diag('send_started');timing.mark(effectiveEventId,'send_start');try{contextAttempt=contextDiagnostics.begin(bridge.state?.queue?.records?.[effectiveEventId],'text',clock())}catch{}return transport(...args);};
 const start=draft=>{effectiveEventId=draft.effectiveEventId||eventId;diagnosticStart=clock();if(typeof mayStart!=='function'||mayStart()!==true)throw Object.assign(new Error('Send paused before start'),{code:'send_paused_before_start'});if(!Number.isSafeInteger(draft.expiresAt)||clock()>=draft.expiresAt)throw Object.assign(new Error('Send expired'),{code:'expired_before_send'});return execute(replyRequest({token:bridge.state.sessionToken,eventId:effectiveEventId,draft}),trackedTransport,15000,AbortSignal.timeout(Math.max(1,draft.expiresAt-clock())),{deadline:draft.expiresAt,clock,onHttpStatus:s=>{httpStatus=s}});};
 // Reservation is durable before start is called synchronously under the bridge lock.
 const draft=await bridge.replyDraft(actor,eventId,text,idempotencyKey,now,clock,{syncPartId,syncId,replyPurpose,nextUpdateAt,replyToEventId,start});effectiveEventId=draft.effectiveEventId||eventId;
 if(draft.state==='sent'||draft.state==='uncertain'){diag('send_result',{upstream:'not_started',delivery:draft.state==='sent'?'accepted_upstream':'unknown'});return {state:draft.state};}
 try{if(draft.execution){const outcome=await draft.execution;if(Object.hasOwn(outcome,'error'))throw outcome.error;result=outcome.value;}else result=await start(draft);}
 catch(e){
  if(!started){try{await bridge.discardUnstartedReply(actor,effectiveEventId,idempotencyKey,draft.clientId);}catch{return {state:'uncertain',reason:'reply_store_failure'};}
   if(e?.code==='expired_before_send'){diag('send_result',{reason:'expired',upstream:'not_started',delivery:'unknown'});await bridge.clean(actor,clock());return {state:'expired'};}
   throw Object.assign(new Error('No network request started'),{code:e?.code==='send_paused_before_start'?'send_paused_before_start':'pre_execution_failure'});
  }
  const stage={network_failure:'reply_network_failure',http_failure:'reply_http_failure',response_failure:'reply_response_failure'}[e?.code]||'reply_local_failure';diag('send_result',{reason:stage,upstream:'unknown',delivery:'unknown'});report(stage);contextDone({reply_network_failure:'network_unknown',reply_http_failure:'http_unknown',reply_response_failure:'response_unknown'}[stage]||'local_unknown');return {state:'uncertain',reason:stage};
 }
 const detail={ret:result.ret,errcode:result.errcode,hasServerMessageId:typeof result.message_id==='string'||typeof result.message_id==='number'};
 if((result.ret!==undefined&&result.ret!==0)||(result.errcode!=null&&result.errcode!==0)){const upstreamCategory=result.errmsg==='rate limited'?'upstream_rate_limited':result.errmsg==='prepare failed'?'upstream_prepare_failed':'upstream_other';diag('send_result',{reason:upstreamCategory,upstream:'rejected',delivery:'unknown',ret:result.ret,errcode:result.errcode});report('reply_upstream_rejected',{...detail,upstreamCategory});contextDone(upstreamCategory);if(typeof bridge.replyRejected==='function'){try{await bridge.replyRejected(actor,effectiveEventId,idempotencyKey,clock());}catch{return {state:'uncertain',reason:'reply_store_failure'};}}return {state:'uncertain',reason:upstreamCategory};}
 diag('send_result',{reason:'sent',upstream:'accepted',delivery:'accepted_upstream',ret:result.ret,errcode:result.errcode});report('reply_upstream_success',detail);contextDone('upstream_accepted');timing.mark(effectiveEventId,'upstream_ack');try{await bridge.replySent(actor,effectiveEventId,idempotencyKey,clock(),{serverMessageId:result.message_id});return {state:'sent'};}catch{diag('send_result',{reason:'reply_store_failure',upstream:'accepted',delivery:'unknown'});report('reply_store_failure',detail);return {state:'uncertain',reason:'reply_store_failure'};}
}
