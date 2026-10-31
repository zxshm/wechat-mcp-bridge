import https from 'node:https';import tls from 'node:tls';import net from 'node:net';import ipaddr from 'ipaddr.js';import {connectPinnedSocks} from './socks-pinned.mjs';
const err=code=>Object.assign(new Error('Callback DNS resolution failed'),{code});
const bootstrap=['1.1.1.1','1.0.0.1'],provider='cloudflare-dns.com',maxBody=65536;
const dnsName=s=>{if(typeof s!=='string')throw err('doh_invalid');const n=s.toLowerCase().replace(/\.$/,'');if(n.length>253||!n.includes('.')||n.split('.').some(x=>!x||x.length>63||!/^[a-z0-9_-]+$/.test(x)))throw err('doh_invalid');return n;};
const publicAddress=(address,family)=>{try{if(net.isIP(address)!==family)return false;let ip=ipaddr.parse(address);if(ip.kind()==='ipv6'&&ip.isIPv4MappedAddress())ip=ip.toIPv4Address();return ip.range()==='unicast'}catch{return false}};

export async function queryCloudflare(host,type,{signal,onStage=()=>{}}={}){
 const name=dnsName(host);if(!['A','AAAA'].includes(type))throw err('doh_invalid');let last;
 for(let i=0;i<bootstrap.length;i++){
  if(signal?.aborted)throw err('doh_timeout');let socket,secure;
  try{
   onStage(i?'doh_bootstrap_secondary':'doh_bootstrap_primary');
   socket=await connectPinnedSocks(bootstrap[i],{signal});
   secure=await new Promise((resolve,reject)=>{const t=tls.connect({socket,servername:provider,rejectUnauthorized:true,signal});t.once('secureConnect',()=>resolve(t));t.once('error',reject)});
   const agent=new https.Agent({keepAlive:false});agent.createConnection=()=>secure;
   const url=new URL('https://cloudflare-dns.com/dns-query');url.searchParams.set('name',name);url.searchParams.set('type',type);
   return await new Promise((resolve,reject)=>{const req=https.get(url,{agent,headers:{accept:'application/dns-json'},signal},res=>{if(res.statusCode!==200){res.resume();reject(err('doh_http_error'));return}const chunks=[];let n=0;res.on('data',b=>{n+=b.length;if(n>maxBody){res.destroy();reject(err('doh_response_large'));return}chunks.push(b)});res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{reject(err('doh_invalid'))}});res.on('aborted',()=>reject(err('doh_transport_error')));res.on('error',()=>reject(err('doh_transport_error')))});req.on('error',()=>reject(err(signal?.aborted?'doh_timeout':'doh_transport_error')))});
  }catch(e){socket?.destroy();secure?.destroy();last=e;if(signal?.aborted)throw err('doh_timeout');if(['doh_invalid','doh_response_large','doh_http_error'].includes(e?.code))throw e;}
 }
 throw err(signal?.aborted?'doh_timeout':last?.code==='doh_transport_error'?'doh_transport_error':'doh_bootstrap_error');
}

export function parseDohAnswer(host,result){
 const original=dnsName(host);if(!result||result.Status!==0||result.TC===true||!Array.isArray(result.Answer??[]))throw err('doh_invalid');
 const answer=result.Answer||[];if(answer.length>64)throw err('doh_invalid');const aliases=new Map(),records=[],ttls=[];
 for(const r of answer){if(!r||![1,5,28].includes(r.type))throw err('doh_invalid');const owner=dnsName(r.name);if(!Number.isInteger(r.TTL)||r.TTL<0||r.TTL>2147483647)throw err('doh_invalid');ttls.push(r.TTL);
  if(r.type===5){const target=dnsName(r.data);if(aliases.has(owner)&&aliases.get(owner)!==target)throw err('doh_invalid');aliases.set(owner,target);}
  else{const family=r.type===1?4:6;if(!publicAddress(r.data,family))throw err('doh_private');records.push({owner,address:r.data,family});}}
 let current=original;const seen=new Set();for(let hops=0;aliases.has(current);hops++){if(hops>=8||seen.has(current))throw err('doh_loop');seen.add(current);current=aliases.get(current);}if(seen.has(current))throw err('doh_loop');
 if([...aliases.keys()].some(x=>!seen.has(x))||records.some(r=>r.owner!==current))throw err('doh_invalid');
 return {terminal:current,hasAliases:aliases.size>0,records:records.map(({address,family})=>({address,family})),ttl:ttls.length?Math.min(...ttls):null};
}

export function createDohResolver({query=queryCloudflare,now=Date.now}={}){
 const cache=new Map();return async function resolveDoh(host,{signal,onStage=()=>{}}={}){
  const name=dnsName(host);if(signal?.aborted)throw err('doh_timeout');const old=cache.get(name);if(old&&now()<old.expiresAt){onStage('doh_cache_hit');return old.records.map(x=>({...x}))}cache.delete(name);onStage('doh_started');
  const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(7000)]):AbortSignal.timeout(7000);
  try{const [a,aaaa]=await new Promise((resolve,reject)=>{const abort=()=>reject(err('doh_timeout'));if(bounded.aborted){abort();return}bounded.addEventListener('abort',abort,{once:true});Promise.all(['A','AAAA'].map(t=>query(name,t,{signal:bounded,onStage}))).then(resolve,reject).finally(()=>bounded.removeEventListener('abort',abort));});if(bounded.aborted)throw err('doh_timeout');const x=parseDohAnswer(name,a),y=parseDohAnswer(name,aaaa);if((x.records.length||x.hasAliases)&&(y.records.length||y.hasAliases)&&x.terminal!==y.terminal)throw err('doh_invalid');if(x.records.some(r=>r.family!==4)||y.records.some(r=>r.family!==6))throw err('doh_invalid');const unique=new Map();for(const r of [...x.records,...y.records])unique.set(r.family+':'+r.address,r);const records=[...unique.values()];if(!records.length)throw err('doh_empty');const ttl=x.records.length&&y.records.length&&x.ttl!==null&&y.ttl!==null?Math.min(x.ttl,y.ttl,300):0;if(ttl>0){if(cache.size>=256)cache.delete(cache.keys().next().value);cache.set(name,{records:records.map(r=>({...r})),expiresAt:now()+ttl*1000})}onStage('doh_completed');return records;
  }catch(e){onStage('doh_failed');throw err(bounded.aborted?'doh_timeout':/^doh_[a-z_]+$/.test(e?.code||'')?e.code:'doh_transport_error');}
 };
}
export const resolveDoh=createDohResolver();
