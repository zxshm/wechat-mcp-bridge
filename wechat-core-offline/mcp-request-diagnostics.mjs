import {AsyncLocalStorage} from 'node:async_hooks';

const DAY=86400000,MAX_EVENTS=128,MAX_BYTES=65536,MAX_INSPECTIONS=8;
const METHODS=new Set(['initialize','server/discover','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe']);
const TOOLS=new Set(['get_wechat_event','list_chatgpt_sync_queue','get_wechat_context_diagnostics','list_wechat_delivery_status','send_wechat_reply','send_wechat_media_upload','enqueue_chatgpt_sync_message','cancel_queued_sync_deliveries','resume_empty_chatgpt_sync','get_mcp_request_diagnostics']);
const INSPECT_TOOLS=new Set(['get_wechat_event','list_chatgpt_sync_queue','get_wechat_context_diagnostics','list_wechat_delivery_status']);
const STAGES=new Set(['received','authenticated','auth_rejected','auth_unavailable','dispatch','complete','sdk_error','dispatch_error','response_aborted','inspect_failed']);
const ERROR_CLASSES=new Set(['encoding_failure','sdk_error','dispatch_error','response_aborted','inspect_limit','inspect_invalid','inspect_timeout','inspect_stream']);
const CODES=new Set([-32700,-32600,-32601,-32602,-32603,-32015]);
const idOk=x=>typeof x==='string'&&/^[a-f0-9]{16}$/.test(x);
const bounded=(value,max)=>Number.isFinite(value)?Math.max(0,Math.min(max,Math.floor(value))):0;
export const isInspectableTool=(method,tool)=>method==='tools/call'&&INSPECT_TOOLS.has(tool);

export class McpRequestTracer {
 constructor({clock=Date.now,maxEvents=MAX_EVENTS,ttlMs=DAY,maxInspections=MAX_INSPECTIONS}={}){
  if(typeof clock!=='function'||!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>MAX_EVENTS||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>DAY||!Number.isSafeInteger(maxInspections)||maxInspections<1||maxInspections>MAX_INSPECTIONS)throw new Error('Invalid diagnostics configuration');
  Object.assign(this,{clock,maxEvents,ttlMs,maxInspections});this.events=[];this.activeInspections=0;this.context=new AsyncLocalStorage();
 }
 prune(){const now=this.clock();this.events=this.events.filter(x=>now>=x.at&&now-x.at<this.ttlMs);}
 record(input){
  if(!input||!idOk(input.requestId)||!STAGES.has(input.stage))return false;
  const at=this.clock();if(!Number.isSafeInteger(at))return false;this.prune();
  const item={at,requestId:input.requestId,stage:input.stage,method:METHODS.has(input.method)?input.method:'other',tool:TOOLS.has(input.tool)?input.tool:'other'};
  if(input.elapsedMs!==undefined)item.elapsedMs=bounded(input.elapsedMs,120000);
  if(Number.isInteger(input.httpStatus)&&input.httpStatus>=100&&input.httpStatus<=599)item.httpStatus=input.httpStatus;
  if(ERROR_CLASSES.has(input.errorClass))item.errorClass=input.errorClass;
  if(CODES.has(input.rpcCode))item.rpcCode=input.rpcCode;
  if(['success','tool_error','rpc_error','unknown'].includes(input.result))item.result=input.result;
  this.events.push(item);if(this.events.length>this.maxEvents)this.events.splice(0,this.events.length-this.maxEvents);return true;
 }
 snapshot(limit=32){if(!Number.isInteger(limit)||limit<1||limit>32)throw new Error('Invalid diagnostic limit');this.prune();return {retentionMs:this.ttlMs,maxEvents:this.maxEvents,events:this.events.slice(-limit).map(x=>({...x}))};}
 run(context,fn){if(!context||!idOk(context.requestId)||typeof fn!=='function')throw new Error('Invalid diagnostic context');return this.context.run({requestId:context.requestId,method:METHODS.has(context.method)?context.method:'other',tool:TOOLS.has(context.tool)?context.tool:'other',startedAt:this.clock()},fn);}
 sdkError(error){const c=this.context.getStore();if(!c)return false;const message=typeof error?.message==='string'?error.message:'';const errorClass=message.startsWith('Failed to encode result for ')?'encoding_failure':'sdk_error';return this.record({...c,stage:'sdk_error',elapsedMs:this.clock()-c.startedAt,errorClass});}
 async inspect(response,context,{timeoutMs=1000}={}){
  if(this.activeInspections>=this.maxInspections){this.record({...context,stage:'inspect_failed',errorClass:'inspect_limit'});return;}
  this.activeInspections++;let reader,timer,stopped=false;
  try{
   const type=response?.headers?.get('content-type')||'';if(!type.includes('application/json')&&!type.includes('text/event-stream'))throw Object.assign(new Error('Invalid response'),{kind:'inspect_invalid'});
   reader=response.clone().body?.getReader();if(!reader)throw Object.assign(new Error('Missing response'),{kind:'inspect_invalid'});
   const work=(async()=>{const chunks=[];let size=0;while(true){const {done,value}=await reader.read();if(stopped)return;if(done)break;size+=value.length;if(size>MAX_BYTES)throw Object.assign(new Error('Response too large'),{kind:'inspect_limit'});chunks.push(value);if(type.includes('text/event-stream')){const text=Buffer.concat(chunks.map(x=>Buffer.from(x))).toString('utf8');if(text.split(/\r?\n\r?\n/).slice(0,-1).some(frame=>/^data:/m.test(frame)))break;}}
    const text=Buffer.concat(chunks.map(x=>Buffer.from(x))).toString('utf8');const raw=type.includes('text/event-stream')?text.split(/\r?\n/).find(x=>x.startsWith('data:'))?.slice(5).trim():text;let parsed;try{parsed=JSON.parse(raw)}catch{throw Object.assign(new Error('Invalid response'),{kind:'inspect_invalid'})}
    if(stopped)return;const result=parsed?.error?'rpc_error':parsed?.result?.isError===true?'tool_error':parsed?.result?'success':'unknown';this.record({...context,stage:'complete',elapsedMs:this.clock()-context.startedAt,httpStatus:response.status,result,...(CODES.has(parsed?.error?.code)?{rpcCode:parsed.error.code}:{})});
   })();
   await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Inspection timeout'),{kind:'inspect_timeout'})),timeoutMs);})]);
  }catch(e){this.record({...context,stage:'inspect_failed',elapsedMs:this.clock()-context.startedAt,errorClass:ERROR_CLASSES.has(e?.kind)?e.kind:'inspect_stream'});}
  finally{stopped=true;if(timer)clearTimeout(timer);if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock()}catch{}}this.activeInspections--;}
 }
}

export const mcpRequestTracer=new McpRequestTracer();
export async function dispatchWithDiagnostics(tracer,context,perform,enabled){
 if(!enabled)return {response:await perform(),inspection:Promise.resolve()};
 try{tracer.record({...context,stage:'dispatch',elapsedMs:tracer.clock()-context.startedAt})}catch{}
 let invoked=false,response;const invoke=()=>{invoked=true;return perform();};
 try{response=await tracer.run(context,invoke);}catch(e){if(invoked)throw e;response=await perform();}
 let inspection=Promise.resolve();try{if(isInspectableTool(context.method,context.tool))inspection=Promise.resolve(tracer.inspect(response,context)).catch(()=>{});}catch{}
 return {response,inspection};
}
