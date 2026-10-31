// Diagnostic only: hostname stays in memory, DNS is validated, TLS sends no HTTP or signed data.
import tls from 'node:tls';import {resolveCallback} from './webhook.mjs';
export async function probeHost(hostname,{diagnostic=()=>{},resolve=resolveCallback,dial=tls.connect,timeoutMs=6000}={}){
 diagnostic('probe_started');let records;
 try{({records}=await resolve('https://'+hostname+'/',undefined,{timeoutMs:4000}));diagnostic('probe_dns_ok');}catch{diagnostic('probe_dns_failed');return;}
 await Promise.all([4,6].map(async family=>{
  const tag=family===4?'probe_v4':'probe_v6',record=records.find(x=>x.family===family);
  if(!record){diagnostic(tag+'_unavailable');return;}
  await new Promise(resolveDone=>{
   let socket,timer,connected=false,finished=false;
   function finish(stage){if(finished)return;finished=true;clearTimeout(timer);diagnostic(tag+'_'+stage);socket?.destroy();resolveDone();}
   try{socket=dial({host:record.address,port:443,servername:hostname,rejectUnauthorized:true});}catch{finish('tcp_failed');return;}
   timer=setTimeout(()=>finish(connected?'tls_timeout':'tcp_timeout'),timeoutMs);
   socket.once('connect',()=>{connected=true;diagnostic(tag+'_tcp_connected');});
   socket.once('secureConnect',()=>finish('tls_verified'));
   socket.once('error',()=>finish(connected?'tls_failed':'tcp_failed'));
  });
 }));
}
