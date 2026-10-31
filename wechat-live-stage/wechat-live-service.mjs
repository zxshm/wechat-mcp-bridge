import {openPrivateBridge} from './wechat-private-bridge-live.mjs';import {WechatRuntime} from './wechat-runtime-live.mjs';
// The caller must await this before publishing the authenticated MCP listener.
export async function prepareLiveService({owner,events,open=openPrivateBridge,clock=Date.now,schedule=setTimeout,cancel=clearTimeout,poll}){
 const opened=await open(owner);let runtime;
 try{runtime=new WechatRuntime({bridge:opened.bridge,owner,events,clock,schedule,cancel,...(poll?{poll}:{})});await runtime.start();let closed=false;return {bridge:opened.bridge,runtime,close:async()=>{if(closed)return;closed=true;await runtime.stopAndWait();await opened.close()}};}catch(e){runtime?.stop();await opened.close();throw e;}
}
