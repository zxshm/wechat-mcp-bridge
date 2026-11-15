import {openPrivateBridge} from './wechat-private-bridge-live.mjs';import {WechatRuntime} from './wechat-runtime-live.mjs';
import {startReplyWatchdog} from './reply-watchdog-bootstrap.mjs';
// Caller awaits before publishing listener. Existing polling runs with no watchdog by default.
export async function prepareLiveService({owner,events,open=openPrivateBridge,clock=Date.now,schedule=setTimeout,cancel=clearTimeout,poll,watchdog,Runtime=WechatRuntime,startWatchdog=startReplyWatchdog}){
 const opened=await open(owner);let runtime,watch,stopping;
 const stopTasks=()=>stopping??=Promise.allSettled([runtime?.stopAndWait(),watch?.close()]).then(results=>{const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;});
 const shutdown=async()=>{try{await stopTasks();}finally{await opened.close();}};
 try{
  if(watchdog?.enabled===true)watch=await startWatchdog({...watchdog,bridge:opened.bridge,owner,originalEvents:events,clock});
  runtime=new Runtime({bridge:opened.bridge,owner,events,clock,schedule,cancel,...(poll?{poll}:{})});await runtime.start();let closed=false;
  return {bridge:opened.bridge,runtime,stopTasks,close:async()=>{if(closed)return;closed=true;await shutdown();}};
 }catch(e){await shutdown();throw e;}
}
