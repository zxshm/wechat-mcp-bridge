import {timing} from './latency-metrics.mjs';
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
export async function pollOnce({bridge,actor,transport=fetch,now=Date.now(),signal}){
 if(signal?.aborted)throw new Error('Poll stopped');
 if(bridge?.state?.phase!=='armed'||actor!==bridge.owner)throw new Error('Bridge not armed');const s=bridge.state;
 const batch=await execute(updatesRequest({token:s.sessionToken,cursor:s.core.cursor}),transport,35000,signal);
 if(signal?.aborted)throw new Error('Poll stopped');return bridge.ingest(actor,normalizeUpdates(batch,{previousCursor:s.core.cursor}),now);
}
export async function replyOnce({bridge,actor,eventId,text,idempotencyKey,transport=fetch,now=Date.now(),clock=Date.now,diagnostic=(id,key,stage,detail)=>timing.markReply(id,key,stage,detail)}){
 if(bridge?.state?.phase!=='armed'||actor!==bridge.owner)throw new Error('Bridge not armed');
 // This saves uncertain status before any network request and never returns private draft fields.
 const draft=await bridge.replyDraft(actor,eventId,text,idempotencyKey,now,clock);if(draft.state==='sent'||draft.state==='uncertain')return {state:draft.state};if(!Number.isSafeInteger(draft.expiresAt)||clock()>=draft.expiresAt){await bridge.clean(actor,clock());return {state:'expired'};}
 let result,httpStatus;const report=(stage,detail={})=>{try{diagnostic(eventId,idempotencyKey,stage,{httpStatus,...detail})}catch{}};const trackedTransport=(...args)=>{timing.mark(eventId,'send_start');return transport(...args)};try{result=await execute(replyRequest({token:bridge.state.sessionToken,eventId,draft}),trackedTransport,15000,AbortSignal.timeout(Math.max(1,draft.expiresAt-clock())),{deadline:draft.expiresAt,clock,onHttpStatus:s=>{httpStatus=s}});}catch(e){if(e?.code==='expired_before_send'){await bridge.clean(actor,clock());return {state:'expired'};}const stage={network_failure:'reply_network_failure',http_failure:'reply_http_failure',response_failure:'reply_response_failure'}[e?.code]||'reply_local_failure';report(stage);return {state:'uncertain'};}
 const detail={ret:result.ret,errcode:result.errcode,hasServerMessageId:typeof result.message_id==='string'||typeof result.message_id==='number'};
 if((result.ret!==undefined&&result.ret!==0)||(result.errcode!=null&&result.errcode!==0)){const upstreamCategory=result.errmsg==='rate limited'?'upstream_rate_limited':result.errmsg==='prepare failed'?'upstream_prepare_failed':'upstream_other';report('reply_upstream_rejected',{...detail,upstreamCategory});return {state:'uncertain'};}
 report('reply_upstream_success',detail);timing.mark(eventId,'upstream_ack');try{await bridge.replySent(actor,eventId,idempotencyKey,clock());return {state:'sent'};}catch{report('reply_store_failure',detail);return {state:'uncertain'};}
}
