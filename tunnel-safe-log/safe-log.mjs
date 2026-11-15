import {constants} from 'node:fs';
import {mkdir,lstat,open,opendir,unlink} from 'node:fs/promises';
import path from 'node:path';

export const HOUR=3600000, RETENTION=23*HOUR, MAX_FILE_BYTES=16384;
export const CATEGORIES=new Set(['edge_registered','edge_unregistered','edge_connection_terminated','edge_dial_failed','edge_serve_failed','edge_registration_failed','edge_retrying','request_failed','cloudflared_error_other','collector_started','child_spawn_failed','child_exited','child_signaled','pipe_failed']);
const STATES=new Set(['connected','disconnected','retrying','unknown']);
const ERROR_CATEGORIES=new Set(['timeout','dns','certificate','authentication','connection_reset','connection_refused','network_unreachable','protocol','other']);
// Bounded phrase recognition only. No match groups, addresses, codes or original
// error text are returned. Ambiguous/unrecognized text stays "other".
const ERROR_PATTERNS=[
 ['timeout',/(?:^|: )(?:context deadline exceeded|i\/o timeout|TLS handshake timeout|timeout: no recent network activity|timeout: handshake did not complete in time)$/i],
 ['dns',/(?:^|: )(?:no such host|server misbehaving|temporary failure in name resolution)$/i],
 ['certificate',/(?:^|: )(?:x509: (?:certificate signed by unknown authority|certificate has expired or is not yet valid|certificate is valid for |cannot validate certificate for |certificate is not valid for any names)|tls: (?:failed to verify certificate|bad certificate|unknown certificate authority))/i],
 ['authentication',/(?:^|: )(?:Unauthorized|Unauthenticated|Authentication failed|Invalid tunnel secret|Invalid tunnel token|Invalid credentials)$/i],
 ['connection_reset',/(?:^|: )(?:connection reset by peer|ECONNRESET)$/i],
 ['connection_refused',/(?:^|: )(?:connection refused|ECONNREFUSED)$/i],
 ['network_unreachable',/(?:^|: )(?:network is unreachable|network unreachable|no route to host|ENETUNREACH|EHOSTUNREACH)$/i],
 ['protocol',/(?:^|: )(?:PROTOCOL_VIOLATION|FRAME_ENCODING_ERROR|TRANSPORT_PARAMETER_ERROR|VERSION_NEGOTIATION_ERROR|CRYPTO_ERROR|protocol violation|invalid protocol|unsupported protocol|unexpected ALPN|no application protocol)(?:$|[: (])/i],
];
export function classifyError(error){
 if(typeof error!=='string')return undefined;
 if(!error.length||error.length>4096||/[\r\n\0]/.test(error))return 'other';
 const matches=ERROR_PATTERNS.filter(([,pattern])=>pattern.test(error));
 return matches.length===1?matches[0][0]:'other';
}
// Exact upstream message literals only. No captured substring ever reaches output.
const MESSAGES=new Map([
 ['Registered tunnel connection',['edge_registered','connected']],
 ['Unregistered tunnel connection',['edge_unregistered','disconnected']],
 ['Connection terminated',['edge_connection_terminated','disconnected']],
 ['Unable to establish connection with Cloudflare edge',['edge_dial_failed','disconnected']],
 ['Unable to establish connection.',['edge_dial_failed','disconnected']],
 ['Failed to dial a quic connection',['edge_dial_failed','disconnected']],
 ['Serve tunnel error',['edge_serve_failed','unknown']],
 ['Failed to serve quic connection',['edge_serve_failed','unknown']],
 ['Register tunnel error from server side',['edge_registration_failed','unknown']],
 ['Request failed',['request_failed','unknown']],
]);
export function safeRecord(input){
 if(!input||!Number.isSafeInteger(input.at)||input.at<0||input.at>8640000000000000||!CATEGORIES.has(input.category)||!STATES.has(input.state))return null;
 const result={at:input.at,category:input.category,state:input.state};
 if(Number.isInteger(input.connIndex)&&input.connIndex>=0&&input.connIndex<=255)result.connIndex=input.connIndex;
 if(ERROR_CATEGORIES.has(input.errorCategory))result.errorCategory=input.errorCategory;
 return result;
}
export function classify(line,at){
 if(typeof line!=='string'||Buffer.byteLength(line)>16384)return null;
 let value;try{value=JSON.parse(line)}catch{return null}
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 if(!['info','warn','error','fatal','panic'].includes(value.level))return null;
 let selected=MESSAGES.get(value.message);
 // This Msgf contains a duration; accept only the fixed template plus a bounded number/unit.
 if(!selected&&typeof value.message==='string'&&/^Retrying connection in up to \d{1,8}(?:\.\d{1,9})?(?:ms|s|m(?:\d{1,2}(?:\.\d{1,9})?s)?)$/.test(value.message))selected=['edge_retrying','retrying'];
 if(!selected&&['error','fatal','panic'].includes(value.level))selected=['cloudflared_error_other','unknown'];
 return selected?safeRecord({at,category:selected[0],state:selected[1],connIndex:value.connIndex,errorCategory:classifyError(value.error)}):null;
}
// A newline is mandatory. Oversized lines are discarded through the next newline.
export class LineClassifier{
 constructor(emit,{clock=Date.now,maxLine=16384,maxLinesPerSecond=200}={}){this.emit=emit;this.clock=clock;this.maxLine=maxLine;this.maxLinesPerSecond=maxLinesPerSecond;this.buffer=Buffer.alloc(0);this.discard=false;this.second=-1;this.used=0;this.dropped=0;}
 push(chunk){
  if(!Buffer.isBuffer(chunk))chunk=Buffer.from(chunk);
  let offset=0;
  while(offset<chunk.length){let end=chunk.indexOf(10,offset);const complete=end!==-1;if(!complete)end=chunk.length;const part=chunk.subarray(offset,end);
   if(!this.discard){if(this.buffer.length+part.length>this.maxLine){this.buffer=Buffer.alloc(0);this.discard=true;this.dropped=Math.min(1000000,this.dropped+1);}else this.buffer=Buffer.concat([this.buffer,part]);}
   if(complete){if(!this.discard){const now=this.clock(),second=Math.floor(now/1000);if(second!==this.second){this.second=second;this.used=0;}if(this.used++<this.maxLinesPerSecond){const record=classify(this.buffer.toString('utf8'),now);if(record)try{this.emit(record)}catch{}}else this.dropped=Math.min(1000000,this.dropped+1);}this.buffer=Buffer.alloc(0);this.discard=false;}
   offset=end+(complete?1:0);
  }
 }
 end(){this.buffer=Buffer.alloc(0);this.discard=false;}
}
const NAME=/^safe-(\d{1,13})\.ndjson$/;
function policy(){return Object.assign(new Error('Safe log storage unavailable'),{code:'SAFE_LOG_STORAGE'});}
async function verifyDirectory(directory,{create=false}={}){
 if(!path.isAbsolute(directory))throw policy();
 if(create)await mkdir(directory,{recursive:false,mode:0o700});
 const st=await lstat(directory);if(!st.isDirectory()||st.isSymbolicLink())throw policy();
 if(process.platform!=='win32'&&((st.mode&0o077)!==0||st.uid!==process.getuid()))throw policy();
}
function verifyFile(st){if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw policy();if(process.platform!=='win32'&&((st.mode&0o077)!==0||st.uid!==process.getuid()))throw policy();}
export async function cleanup(directory,now=Date.now()){
 try{await verifyDirectory(directory)}catch(e){if(e?.code==='ENOENT')return {removed:0,files:0};throw e;}
 if(!Number.isSafeInteger(now)||now<0)throw policy();
 const dir=await opendir(directory);let removed=0,files=0,seen=0;
 for await(const entry of dir){if(++seen>64)throw policy();const match=NAME.exec(entry.name);if(!match)throw policy();const target=path.join(directory,entry.name),hour=Number(match[1]);
  let st;try{st=await lstat(target)}catch(e){if(e?.code==='ENOENT')continue;throw e}verifyFile(st);
  if(!Number.isSafeInteger(hour)||hour*HOUR>now||now>=hour*HOUR+RETENTION||st.size>MAX_FILE_BYTES){try{await unlink(target);removed++}catch(e){if(e?.code!=='ENOENT')throw e}}else files++;
 }
 if(files>23)throw policy();return {removed,files};
}
export class SafeStore{
 constructor(directory,{clock=Date.now,maxPending=64,maxPendingBytes=32768,maxPerSecond=20,io={open}}={}){this.directory=path.resolve(directory);this.clock=clock;this.maxPending=maxPending;this.maxPendingBytes=maxPendingBytes;this.maxPerSecond=maxPerSecond;this.io=io;this.queue=[];this.pendingBytes=0;this.writing=false;this.waiters=[];this.dropped=0;this.failures=0;this.second=-1;this.used=0;}
 async start(){try{await verifyDirectory(this.directory)}catch(e){if(e?.code!=='ENOENT')throw e;await verifyDirectory(this.directory,{create:true})}await cleanup(this.directory,this.clock());}
 enqueue(input){const record=safeRecord(input);if(!record)return false;const now=this.clock(),second=Math.floor(now/1000);if(second!==this.second){this.second=second;this.used=0;}
  const line=JSON.stringify(record)+'\n',size=Buffer.byteLength(line);
  if(++this.used>this.maxPerSecond||this.queue.length+(this.writing?1:0)>=this.maxPending||this.pendingBytes+size>this.maxPendingBytes){this.dropped=Math.min(1000000,this.dropped+1);return false;}
  this.queue.push({record,line,size});this.pendingBytes+=size;void this.pump();return true;
 }
 async pump(){if(this.writing)return;this.writing=true;
  try{while(this.queue.length){const {record,line,size}=this.queue.shift();let f;try{
   const now=this.clock(),hour=Math.floor(record.at/HOUR);if(record.at>now||now>=hour*HOUR+RETENTION)continue;
   if(this.lastHour!==Math.floor(now/HOUR)){await cleanup(this.directory,now);this.lastHour=Math.floor(now/HOUR);}
   const target=path.join(this.directory,`safe-${hour}.ndjson`);f=await this.io.open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|(constants.O_NOFOLLOW||0),0o600);const st=await f.stat();verifyFile(st);
   if(st.size+size>MAX_FILE_BYTES){this.dropped=Math.min(1000000,this.dropped+1);continue;}
   await f.writeFile(line);
  }catch{this.failures=Math.min(1000000,this.failures+1);}finally{if(f)try{await f.close()}catch{this.failures=Math.min(1000000,this.failures+1)}this.pendingBytes-=size;}}
  }finally{this.writing=false;for(const done of this.waiters.splice(0))done();}
 }
 flush(){return this.writing||this.queue.length?new Promise(resolve=>this.waiters.push(resolve)):Promise.resolve();}
 health(){return {queued:this.queue.length,pendingBytes:this.pendingBytes,dropped:this.dropped,failures:this.failures};}
}
