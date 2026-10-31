import fs from 'node:fs';import crypto from 'node:crypto';import path from 'node:path';
const REPLY_STAGES=new Set(['reply_network_failure','reply_http_failure','reply_response_failure','reply_local_failure','reply_upstream_rejected','reply_store_failure','reply_upstream_success']);
const ALLOWED=new Set(['event_received','outbox_ack','read_start','send_start','upstream_ack',...REPLY_STAGES]);
const UPSTREAM_CATEGORIES=new Set(['upstream_rate_limited','upstream_prepare_failed','upstream_other']);
const safeCode=x=>Number.isInteger(x)&&x>=-2147483648&&x<=2147483647;
function sanitize(x){if(!x||!/^[0-9a-f]{64}$/.test(x.id_hash)||!ALLOWED.has(x.stage)||!Number.isSafeInteger(x.at))return null;const y={id_hash:x.id_hash,stage:x.stage,at:x.at};if(REPLY_STAGES.has(x.stage)){if(!/^[0-9a-f]{64}$/.test(x.key_hash))return null;y.key_hash=x.key_hash;if(Number.isInteger(x.httpStatus)&&x.httpStatus>=100&&x.httpStatus<=599)y.httpStatus=x.httpStatus;if(safeCode(x.ret))y.ret=x.ret;if(safeCode(x.errcode))y.errcode=x.errcode;if(typeof x.hasServerMessageId==='boolean')y.hasServerMessageId=x.hasServerMessageId;if(x.stage==='reply_upstream_rejected'&&UPSTREAM_CATEGORIES.has(x.upstreamCategory))y.upstreamCategory=x.upstreamCategory;}return y;}
const MAX_AGE=7*86400000,MAX_ROWS=512,MAX_BYTES=131072;
export function createTimingLog(file,{clock=Date.now}={}){
 function update(item){let fd;try{
  fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);
  const st=fs.fstatSync(fd);if(!st.isFile()||(st.mode&0o077)!==0||st.nlink!==1||(process.getuid&&st.uid!==process.getuid())||st.size>MAX_BYTES)return false;
  const now=clock();if(!Number.isSafeInteger(now))return false;const rows=[];
  for(const line of fs.readFileSync(fd,'utf8').split('\n')){try{const x=sanitize(JSON.parse(line));if(x&&x.at<=now&&now-x.at<MAX_AGE)rows.push(x)}catch{}}
  if(item){const valid=sanitize(item);if(!valid)return false;rows.push(valid);}const lines=rows.slice(-MAX_ROWS).map(x=>JSON.stringify(x));let size=lines.reduce((n,line)=>n+Buffer.byteLength(line,'utf8')+1,0);while(size>MAX_BYTES&&lines.length)size-=Buffer.byteLength(lines.shift(),'utf8')+1;const next=lines.join('\n');fs.ftruncateSync(fd,0);if(next)fs.writeSync(fd,next+'\n',0,'utf8');return true;
 }catch{return false}finally{if(fd!==undefined)try{fs.closeSync(fd)}catch{}}}
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 return {mark(id,stage){if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(id)||!ALLOWED.has(stage)||REPLY_STAGES.has(stage))return false;const at=clock();if(!Number.isSafeInteger(at))return false;return update({id_hash:hash(id),stage,at})},markReply(id,key,stage,detail={}){if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(id)||typeof key!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(key)||!REPLY_STAGES.has(stage))return false;const at=clock();if(!Number.isSafeInteger(at))return false;return update({id_hash:hash(id),key_hash:hash(key),stage,at,httpStatus:detail.httpStatus,ret:detail.ret,errcode:detail.errcode,hasServerMessageId:detail.hasServerMessageId,upstreamCategory:detail.upstreamCategory})},purge(){return update(null)}};
}
export const timing=process.env.BRIDGE_STATE_DIR?createTimingLog(path.join(process.env.BRIDGE_STATE_DIR,'timing.ndjson')):{mark:()=>false,markReply:()=>false,purge:()=>false};
