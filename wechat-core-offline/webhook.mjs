function defaultWrapTls(socket,hostname,signal){return new Promise((resolve,reject)=>{const s=tls.connect({socket,servername:hostname,rejectUnauthorized:true,signal});s.once('secureConnect',()=>resolve(s));s.once('error',reject);});}
import {resolveDoh} from './callback-doh.mjs';
// MCP Events callback security primitives. No subscription is created by importing this module.
import dns from 'node:dns/promises';import net from 'node:net';import https from 'node:https';import tls from 'node:tls';
import {connectPinnedSocks} from './socks-pinned.mjs';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';import ipaddr from 'ipaddr.js';import {Webhook} from 'standardwebhooks';
function failure(code){const e=new Error('Callback verification failed');e.code=code;return e;}
export function parseCallback(value){if(typeof value!=='string'||value.length>2048)throw failure('invalid');let u;try{u=new URL(value)}catch{throw failure('invalid')}const host=u.hostname.replace(/^\[|\]$/g,'');if(u.protocol!=='https:'||u.username||u.password||u.hash||(u.port&&u.port!=='443')||net.isIP(host)||!host.includes('.')||host.toLowerCase()==='localhost'||host.toLowerCase().endsWith('.localhost'))throw failure('invalid');return u;}
export function validPublicAddress(address){try{let ip=ipaddr.parse(address);if(ip.kind()==='ipv6'&&ip.isIPv4MappedAddress())ip=ip.toIPv4Address();return ip.range()==='unicast'}catch{return false}}
export async function resolveCallback(url,lookup=dns.lookup,{timeoutMs=4000,signal,onStage=()=>{}}={}){
 const u=parseCallback(url);onStage('dns_started');let timer,abortListener;
 try{
  if(signal?.aborted)throw failure('challenge_timeout');
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('dns_timeout')),timeoutMs)});
  const abort=new Promise((_,reject)=>{if(signal){abortListener=()=>reject(failure('challenge_timeout'));signal.addEventListener('abort',abortListener,{once:true});}});
  let records;try{records=await Promise.race([lookup(u.hostname,{all:true,verbatim:true}),timeout,abort])}catch(e){if(['dns_timeout','challenge_timeout'].includes(e?.code))throw e;throw failure('dns_error')}
  if(!Array.isArray(records)||!records.length||records.some(x=>!validPublicAddress(x.address)||![4,6].includes(x.family)||net.isIP(x.address)!==x.family))throw failure('destination_blocked');onStage('dns_completed');const families=new Set(records.map(x=>x.family));onStage(families.size===2?'dns_dual':families.has(6)?'dns_ipv6_only':'dns_ipv4_only');return {url:u,records};
 }finally{clearTimeout(timer);if(signal&&abortListener)signal.removeEventListener('abort',abortListener);}
}
export function validateSecret(secret){if(typeof secret!=='string'||!secret.startsWith('whsec_'))throw failure('invalid');const b64=secret.slice(6);if(!/^[A-Za-z0-9+/]+={0,2}$/.test(b64))throw failure('invalid');const key=Buffer.from(b64,'base64');if(key.length<24||key.length>64||key.toString('base64')!==b64)throw failure('invalid');return true;}
export function subscriptionId(owner,url,eventName){if(!owner||!['weixin.owner_text','weixin.owner_media'].includes(eventName))throw failure('invalid');const canonical=parseCallback(url).href;return 'sub_'+createHash('sha256').update(JSON.stringify([owner,canonical,eventName,{}])).digest('hex');}
export function signedHeaders(secret,subscription,id,body,now=new Date()){validateSecret(secret);if(typeof body!=='string'||Buffer.byteLength(body)>262144||!id||!subscription)throw failure('invalid');return {'Content-Type':'application/json','webhook-id':id,'webhook-timestamp':String(Math.floor(now.getTime()/1000)),'webhook-signature':new Webhook(secret).sign(id,now,body),'X-MCP-Subscription-Id':subscription};}
export function equalChallenge(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function pinnedLookup(records){if(!Array.isArray(records)||!records.length||records.some(x=>!validPublicAddress(x.address)||net.isIP(x.address)!==x.family))throw failure('destination_blocked');const safe=records.map(({address,family})=>({address,family}));return (_hostname,options,cb)=>options.all?cb(null,safe):cb(null,safe[0].address,safe[0].family);}
export async function connectCandidates(records,{signal,onStage=()=>{},connect=connectPinnedSocks}={}){
 pinnedLookup(records);const v4=records.filter(r=>r.family===4),v6=records.filter(r=>r.family===6),ordered=[];
 while(ordered.length<4&&(v4.length||v6.length)){if(v4.length)ordered.push(v4.shift());if(ordered.length<4&&v6.length)ordered.push(v6.shift());}
 let last;for(const r of ordered){if(signal?.aborted)throw failure('callback_timeout');onStage(r.family===4?'callback_try_ipv4':'callback_try_ipv6');try{return await connect(r.address,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(2000)]):AbortSignal.timeout(2000),onStage});}catch(e){last=e;onStage('callback_candidate_failed');}}
 throw failure(signal?.aborted?'callback_timeout':last?.code||'socks_error');
}
export function handleCallbackResponse(res,resolve,reject,onStage=()=>{}){
 onStage('callback_response');if(res.statusCode>=300&&res.statusCode<400){res.resume();reject(failure('redirect_rejected'));return;}
 const parts=[];let n=0;res.on('data',chunk=>{n+=chunk.length;if(n>16384){res.destroy();reject(failure('callback_error'));return;}parts.push(chunk)});res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(parts).toString('utf8')}));res.on('aborted',()=>reject(failure('callback_error')));res.on('error',()=>reject(failure('callback_error')));
}
export async function postPinned(url,headers,body,{signal,onStage=()=>{},resolver=resolveDoh,deadline,clock=Date.now,connect=connectCandidates,wrapTls=defaultWrapTls,requestFactory=https.request}={}){
 const expired=()=>Number.isFinite(deadline)&&clock()>=deadline;if(expired())throw failure('callback_expired');const bounds=[...(signal?[signal]:[]),...(Number.isFinite(deadline)?[AbortSignal.timeout(Math.max(1,deadline-clock()))]:[])];const boundedSignal=bounds.length?AbortSignal.any(bounds):undefined;
 const u=parseCallback(url);let records;try{records=await resolver(u.hostname,{signal:boundedSignal,onStage})}catch(e){if(expired()||boundedSignal?.aborted)throw failure('callback_expired');throw e}if(expired()||boundedSignal?.aborted)throw failure('callback_expired');const requestSignal=boundedSignal?AbortSignal.any([boundedSignal,AbortSignal.timeout(7000)]):AbortSignal.timeout(7000);onStage('callback_started');
 let socket;
 try{socket=await connect(records,{signal:requestSignal,onStage});onStage('tcp_connected');}catch(e){throw failure(requestSignal.aborted?'callback_timeout':e?.code||'socks_error');}
 if(expired()||boundedSignal?.aborted){socket.destroy();throw failure('callback_expired');}
 let secure;
 try{onStage('tls_started');secure=await wrapTls(socket,u.hostname,requestSignal);onStage('tls_verified');}catch(e){socket.destroy();const c=e?.code;const stage=c==='CERT_HAS_EXPIRED'?'tls_cert_expired':c==='ERR_TLS_CERT_ALTNAME_INVALID'?'tls_hostname_invalid':['UNABLE_TO_VERIFY_LEAF_SIGNATURE','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(c)?'tls_cert_untrusted':requestSignal.aborted?'tls_timeout':'tls_other';onStage(stage);throw failure(requestSignal.aborted?'callback_timeout':stage);}
 if(expired()||boundedSignal?.aborted){secure.destroy();throw failure('callback_expired');}
 const agent=new https.Agent({keepAlive:false});agent.createConnection=()=>secure;
 return await new Promise((resolve,reject)=>{
  if(expired()||boundedSignal?.aborted){secure.destroy();reject(failure('callback_expired'));return;}const req=requestFactory(u,{method:'POST',headers,agent,servername:u.hostname,signal:requestSignal},res=>handleCallbackResponse(res,resolve,reject,onStage));req.on('finish',()=>onStage('request_sent'));req.on('error',()=>reject(failure(requestSignal.aborted?'callback_timeout':'callback_error')));if(expired()||boundedSignal?.aborted){req.destroy();reject(failure('callback_expired'));return;}onStage('request_started');req.end(body);
 });
}
export async function verifyCallback(subscription,send=postPinned,{timeoutMs=12000,onStage=()=>{}}={}){
 validateSecret(subscription.secret);parseCallback(subscription.url);const challenge=randomBytes(24).toString('base64url'),id='verify_'+randomBytes(16).toString('hex'),body=JSON.stringify({type:'verification',challenge}),controller=new AbortController();let timer;onStage('challenge_started');
 try{const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failure('challenge_timeout'))},timeoutMs)});const response=await Promise.race([send(subscription.url,signedHeaders(subscription.secret,subscription.id,id,body),body,{signal:controller.signal,onStage}),timeout]);let result;try{result=JSON.parse(response.body)}catch{onStage('challenge_invalid_json');throw failure('challenge_failed')}if(response.status<200||response.status>=300){onStage('challenge_http_rejected');throw failure('challenge_failed')}if(!equalChallenge(challenge,result.challenge)){onStage('challenge_mismatch');throw failure('challenge_failed')}onStage('challenge_verified');return true;}finally{clearTimeout(timer);}
}
