import {serverConfig} from './config.mjs';
import {privatePath,stateDirectory,largeMediaPaths} from './config.mjs';
import {startJwksBackgroundRefresh} from './jwks-background-refresh.mjs';
import {prepareWatchdogApp} from '../wechat-live-stage/reply-watchdog-entry.mjs';
// Standalone events-test stage. No WeChat login, polling, send, or system autostart.
import {createRemoteJWKSet,customFetch} from 'jose';
import {createJwksFetch} from './jwks-fetch.mjs';
import {initEventsStore} from './private-init.mjs';
import {Events} from './events.mjs';
import {createApp} from './server-v2.mjs';
import {recordStage} from './safe-diagnostics.mjs';
import {timing} from './latency-metrics.mjs';
const configuration=serverConfig();
const OWNER=configuration.owner;
let store,live,timingTimer,keyRefresh,closing;
const shutdown=code=>{
 if(closing)return closing; keyRefresh?.stop();
 closing=(async()=>{
  try{
   const stopping=Promise.resolve().then(()=>live?.stopTasks?.());stopping.catch(()=>{});
   if(live?.app)await new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve()};const timer=setTimeout(()=>{live.app.closeAllConnections?.();finish()},1000);try{live.app.close(finish);live.app.closeIdleConnections?.()}catch{finish()}});
   try{await stopping}finally{await live?.close()}
  }
  catch{code=1;}
  finally{try{store?.close()}finally{if(timingTimer)clearInterval(timingTimer);process.exitCode=code;}}
 })();return closing;
};
try {
 timing.purge();timingTimer=setInterval(()=>timing.purge(),3600000);timingTimer.unref();
 store=await initEventsStore(stateDirectory());
 const events=new Events({owner:OWNER,store,isAuthorized:async principal=>principal===OWNER});await events.load();
 const keys=createRemoteJWKSet(new URL('/cdn-cgi/access/certs',configuration.issuer),{timeoutDuration:4000,cooldownDuration:30000,cacheMaxAge:600000,[customFetch]:createJwksFetch()});
 try{await keys.reload();recordStage('jwks_prefetch_ok')}catch{recordStage('jwks_prefetch_failed')}
 keyRefresh=startJwksBackgroundRefresh(keys,{onResult:r=>recordStage(r.ok?'jwks_prefetch_ok':'jwks_prefetch_failed',r.elapsedMs)});
 live=await prepareWatchdogApp({mode:process.env.XIAODI_REPLY_WATCHDOG_MODE??'off',owner:OWNER,events,keys,createApp:options=>createApp({...options,...configuration})});
 const {app}=live;
 app.once('error',()=>{void shutdown(1)});
 for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>{void shutdown(0)});
 await new Promise((resolve,reject)=>{const failed=error=>{app.removeListener('listening',ready);reject(error)};const ready=()=>{app.removeListener('error',failed);resolve()};app.once('error',failed);app.once('listening',ready);app.listen(configuration.port,'127.0.0.1');});
} catch {await shutdown(1);}
