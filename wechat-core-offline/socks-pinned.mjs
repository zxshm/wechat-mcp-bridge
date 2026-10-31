import net from 'node:net';
import ipaddr from 'ipaddr.js';

const failure=(code='socks_error')=>Object.assign(new Error('SOCKS connection failed'),{code});
// Direct connections are the default; an explicitly configured SOCKS proxy
// receives only an already resolved and validated public IP address.
export async function connectPinnedSocks(address,{signal,proxyHost=process.env.BRIDGE_SOCKS_HOST,proxyPort=Number(process.env.BRIDGE_SOCKS_PORT||1080),onStage=()=>{}}={}){
  const family=net.isIP(address); if(!family||ipaddr.parse(address).range()!=='unicast') throw failure();
  if(!proxyHost){if(signal?.aborted)throw failure('socks_timeout');const socket=net.connect({host:address,port:443});return await new Promise((resolve,reject)=>{const cleanup=()=>{socket.off('connect',ok);socket.off('error',bad);signal?.removeEventListener('abort',abort)};const ok=()=>{cleanup();resolve(socket)},bad=()=>{cleanup();socket.destroy();reject(failure('socks_target_error'))},abort=()=>{cleanup();socket.destroy();reject(failure('socks_timeout'))};socket.once('connect',ok);socket.once('error',bad);signal?.addEventListener('abort',abort,{once:true});});}
  if(!Number.isInteger(proxyPort)||proxyPort<1||proxyPort>65535)throw failure();
  const target=Buffer.from(ipaddr.parse(address).toByteArray());
  const socket=net.connect({host:proxyHost,port:proxyPort});
  let buffer=Buffer.alloc(0),waiting=null,problem=null,phase='proxy';
  const settle=()=>{if(!waiting)return;if(problem){const w=waiting;waiting=null;w.reject(problem);return}if(buffer.length>=waiting.n){const w=waiting;waiting=null;const v=buffer.subarray(0,w.n);buffer=buffer.subarray(w.n);w.resolve(v)}};
  const onData=b=>{buffer=Buffer.concat([buffer,b]);if(buffer.length>4096)problem=failure();settle()};
  const onError=()=>{problem=failure('socks_'+phase+'_error');settle()};
  const onClose=()=>{problem=failure('socks_'+phase+'_error');settle()};
  const onAbort=()=>{problem=failure('socks_timeout');socket.destroy();settle()};
  const read=n=>new Promise((resolve,reject)=>{if(waiting)return reject(failure());waiting={n,resolve,reject};settle()});
  socket.on('data',onData);socket.on('error',onError);socket.on('close',onClose);signal?.addEventListener('abort',onAbort,{once:true});
  try{
    if(signal?.aborted)throw failure();
    onStage('socks_proxy_started');
    await new Promise((resolve,reject)=>{const ok=()=>{cleanup();resolve()},bad=()=>{cleanup();reject(failure(signal?.aborted?'socks_timeout':'socks_proxy_error'))},cleanup=()=>{socket.off('connect',ok);socket.off('error',bad);socket.off('close',bad);signal?.removeEventListener('abort',bad)};socket.once('connect',ok);socket.once('error',bad);socket.once('close',bad);signal?.addEventListener('abort',bad,{once:true});});onStage('socks_proxy_connected');
    phase='method';onStage('socks_method_started');socket.write(Buffer.from([5,1,0]));const method=await read(2);if(method[0]!==5||method[1]!==0){onStage('socks_method_rejected');throw failure('socks_method_error');}onStage('socks_method_ok');
    socket.write(Buffer.concat([Buffer.from([5,1,0,family===4?1:4]),target,Buffer.from([1,187])]));
    phase='target';onStage('socks_target_started');const head=await read(4);if(head[0]!==5||head[2]!==0)throw failure('socks_protocol_error');if(head[1]!==0){onStage(head[1]<=8?'socks_reply_'+head[1]:'socks_reply_other');throw failure(head[1]<=8?'socks_reply_'+head[1]:'socks_reply_other');}onStage('socks_target_connected');
    let size;if(head[3]===1)size=4;else if(head[3]===4)size=16;else if(head[3]===3)size=(await read(1))[0];else throw failure();
    await read(size+2);if(buffer.length)throw failure();
    socket.pause();socket.off('data',onData);socket.off('error',onError);socket.off('close',onClose);signal?.removeEventListener('abort',onAbort);
    return socket;
  }catch(e){socket.destroy();signal?.removeEventListener('abort',onAbort);const code=signal?.aborted?'socks_timeout':(e?.code||'socks_error');onStage(code==='socks_timeout'?'socks_timeout':'socks_failed');throw failure(code);}
}
