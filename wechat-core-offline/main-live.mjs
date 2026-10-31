import {prepareAuthorizedApp} from '../wechat-live-stage/wechat-live-launch.mjs';
// Standalone events-test stage. No WeChat login, polling, send, or system autostart.
import {createRemoteJWKSet,customFetch} from 'jose';
import {createJwksFetch} from './jwks-fetch.mjs';
import {initEventsStore} from './private-init.mjs';
import {Events} from './events.mjs';
import {createApp} from './server-v2.mjs';
import {recordStage} from './safe-diagnostics.mjs';
import {timing} from './latency-metrics.mjs';
import {serverConfig} from './config.mjs';
try {
 const {owner:OWNER,stateDir,audience,publicHost,issuer,port}=serverConfig();
 timing.purge();const timingTimer=setInterval(()=>timing.purge(),3600000);timingTimer.unref();
 const store=await initEventsStore(stateDir);
 const events=new Events({owner:OWNER,store,isAuthorized:async principal=>principal===OWNER});await events.load();
 const keys=createRemoteJWKSet(new URL('/cdn-cgi/access/certs',issuer),{timeoutDuration:4000,cooldownDuration:30000,cacheMaxAge:600000,[customFetch]:createJwksFetch()});
 try{await keys.reload();recordStage('jwks_prefetch_ok')}catch{recordStage('jwks_prefetch_failed')}
 const {app,close}=await prepareAuthorizedApp({owner:OWNER,events,keys,createApp:options=>createApp({...options,owner:OWNER,audience,publicHost,issuer,localPort:port})});
 app.listen(port,'127.0.0.1');
 for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>{app.close(()=>{void close().finally(()=>{store.close();process.exit(0)});});});
} catch (error) {console.error('Bridge startup failed:',error?.message||'configuration unavailable');process.exitCode=1;}
