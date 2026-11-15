import {assertWatchdogStoreIsolation} from '../wechat-core-offline/watchdog-store-isolation.mjs';
import {ReplyWatchdogRuntime} from './reply-watchdog-runtime.mjs';
const running=new WeakSet();
// Caller loads the bridge and independent subscriber under its existing single-
// writer ownership. No credential, subscription, service or store is created here.
export async function startReplyWatchdog({enabled=false,bridge,owner,watchdogEvents,originalEvents,
 clock=Date.now,schedule,cancel,onError,intervalMs=30000,activationOptions}={}){
 if(enabled!==true)return {enabled:false,close:async()=>{}};
 if(!bridge||bridge.owner!==owner||bridge.state?.phase!=='armed'||!watchdogEvents||
 watchdogEvents===originalEvents||!originalEvents||!watchdogEvents.store||
 watchdogEvents.store===originalEvents.store||watchdogEvents.store===bridge.store||typeof watchdogEvents.ready!=='function')throw new Error('Independent watchdog wiring required');
 if(running.has(bridge))throw new Error('Watchdog already attached');
 running.add(bridge);let runtime;
 try{
  await assertWatchdogStoreIsolation({bridge,originalEvents,watchdogEvents});
  if(!await watchdogEvents.ready(owner,clock()))throw new Error('Verified active watchdog subscription required');
  // Idempotent activation never resets the original boundary or old obligations.
  await bridge.enableWatchdog(owner,clock(),activationOptions);
  runtime=new ReplyWatchdogRuntime({bridge,owner,clock,schedule,cancel,onError,intervalMs,
   sendAlert:(actor,event)=>watchdogEvents.deliver(actor,event,clock())});
  await runtime.start();let closed=false;
  return {enabled:true,close:async()=>{if(closed)return;closed=true;try{await runtime.stopAndWait();}finally{running.delete(bridge);}}};
 }catch(e){runtime?.stop();running.delete(bridge);throw e;}
}
