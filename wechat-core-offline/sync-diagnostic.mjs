// Candidate diagnostic only: explicit allowlist, no text, token, headers, URLs or arbitrary errors.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash,randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const context = new AsyncLocalStorage();
const hex64 = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const requestId = x => typeof x === 'string' && /^[a-f0-9]{16}$/.test(x);
const stages = new Set(['enqueued','enqueue_failed','queue_blocked','queue_error','send_started','send_result']);
const reasons = new Set(['uncertain_head','failed_head','inflight_head','queued_part_unavailable','waiting_new_owner_context','context_budget_exhausted','claim_failed','finish_failed','prior_attempt','owner_context_unavailable','upstream_context_rejected','key_seen_elsewhere','stale_context','context_order_ambiguous','context_scope_unverified','reply_capacity','reply_network_failure','reply_http_failure','reply_response_failure','reply_local_failure','reply_store_failure','upstream_prepare_failed','upstream_rate_limited','upstream_other','expired','sent']);
export const withRequestId = (id, fn) => context.run(requestId(id) ? id : null, fn);
export const replyIdFor = key => typeof key === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(key) ? createHash('sha256').update(key).digest('hex') : undefined;
export const syncIdFor = sourceId => typeof sourceId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(sourceId) ? createHash('sha256').update(JSON.stringify(['chatgpt',sourceId])).digest('hex') : undefined;
export function sanitizeDiagnostic(input, now = Date.now()) {
  if (!input || !stages.has(input.stage) || !Number.isSafeInteger(now)) return null;
  const result = {at:now, stage:input.stage};
  const req = input.requestId;
  if (requestId(req)) result.requestId=req;
  if (hex64(input.syncId)) result.syncId=input.syncId;
  if (hex64(input.replyId)) result.replyId=input.replyId;
  if (reasons.has(input.reason)) result.reason=input.reason;
  if (['accepted','rejected','unknown','not_started'].includes(input.upstream)) result.upstream=input.upstream;
  if (['accepted_upstream','unknown','not_started'].includes(input.delivery)) result.delivery=input.delivery;
  if (typeof input.sendStarted==='boolean') result.sendStarted=input.sendStarted;
  if (['incomplete','unavailable'].includes(input.historyCoverage)) result.historyCoverage=input.historyCoverage;
  if (Number.isSafeInteger(input.elapsedMs) && input.elapsedMs>=0 && input.elapsedMs<=86400000) result.elapsedMs=input.elapsedMs;
  if (Number.isInteger(input.httpStatus) && input.httpStatus>=100 && input.httpStatus<=599) result.httpStatus=input.httpStatus;
  for (const key of ['ret','errcode']) if (Number.isInteger(input[key]) && input[key]>=-2147483648 && input[key]<=2147483647) result[key]=input[key];
  return result;
}
export const sanitizeCurrentDiagnostic = (input,now) => sanitizeDiagnostic({...input,requestId:input?.requestId ?? context.getStore()},now);
export function createSyncDiagnostic(file,{clock=Date.now,schedule=setTimeout,cancel=clearTimeout,fsApi=fs}={}) {
 const last=new Map();let timer=null;
 const tempPrefix=path.basename(file)+'.tmp-';
 const cleanupTemps=()=>{try{for(const name of fsApi.readdirSync(path.dirname(file))){if(!name.startsWith(tempPrefix)||!/^[a-f0-9]{32}$/.test(name.slice(tempPrefix.length)))continue;const candidate=path.join(path.dirname(file),name),stat=fsApi.lstatSync(candidate);if(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0&&stat.nlink===1&&(!process.getuid||stat.uid===process.getuid()))fsApi.unlinkSync(candidate)}return true}catch{return false}};
 const update=input=>{let fd,tmpfd,tmp,renamed=false;try{
  const now=clock(), item=input===null?null:sanitizeCurrentDiagnostic(input,now);if(!Number.isSafeInteger(now)||(input!==null&&!item))return false;
  const sig=item?.stage==='queue_blocked'?JSON.stringify([item.syncId,item.reason]):null;
  if(sig&&now-(last.get(sig)??-Infinity)<30000)return true;
  fd=fsApi.openSync(file,fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);
  const stat=fsApi.fstatSync(fd);if(!stat.isFile()||(stat.mode&0o077)!==0||stat.nlink!==1||(process.getuid&&stat.uid!==process.getuid())||stat.size>131072)return false;
  const rows=[];for(const line of fsApi.readFileSync(fd,'utf8').split('\n'))try{const old=JSON.parse(line);if(Number.isSafeInteger(old.at)&&old.at<=now&&now-old.at<86400000){const clean=sanitizeDiagnostic(old,old.at);if(clean)rows.push(clean)}}catch{}
  if(item)rows.push(item);const lines=rows.slice(-512).map(x=>JSON.stringify(x));let size=lines.reduce((n,x)=>n+Buffer.byteLength(x)+1,0);while(size>131072&&lines.length)size-=Buffer.byteLength(lines.shift())+1;
  fsApi.closeSync(fd);fd=undefined;
  tmp=path.join(path.dirname(file),tempPrefix+randomBytes(16).toString('hex'));
  tmpfd=fsApi.openSync(tmp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  const tmpstat=fsApi.fstatSync(tmpfd);if(!tmpstat.isFile()||(tmpstat.mode&0o077)!==0||tmpstat.nlink!==1||(process.getuid&&tmpstat.uid!==process.getuid()))return false;
  fsApi.writeFileSync(tmpfd,lines.length?lines.join('\n')+'\n':'','utf8');fsApi.fsyncSync(tmpfd);fsApi.closeSync(tmpfd);tmpfd=undefined;fsApi.renameSync(tmp,file);renamed=true;
  // Directory fsync is best effort; unsupported filesystems cannot promise
  // persistence across power failure even after an atomic rename.
  let dirfd;try{dirfd=fsApi.openSync(path.dirname(file),fs.constants.O_RDONLY|(fs.constants.O_DIRECTORY||0));fsApi.fsyncSync(dirfd)}catch{}finally{if(dirfd!==undefined)try{fsApi.closeSync(dirfd)}catch{}}
  if(sig){last.set(sig,now);if(last.size>2048)last.delete(last.keys().next().value);}
  if(timer!==null)cancel(timer);timer=null;if(lines.length){const first=Math.min(...lines.map(line=>JSON.parse(line).at));timer=schedule(()=>{timer=null;update(null)},Math.max(0,first+86400000-now));timer?.unref?.();}return true;
 }catch{return false}finally{if(fd!==undefined)try{fsApi.closeSync(fd)}catch{}if(tmpfd!==undefined)try{fsApi.closeSync(tmpfd)}catch{}if(tmp&&!renamed)try{fsApi.unlinkSync(tmp)}catch{}}};
 update.purge=()=>update(null);update.cleanupTemps=cleanupTemps;update.close=()=>{if(timer!==null)cancel(timer);timer=null};return update;
}
export const syncDiagnostic=()=>false;
