import {assertWatchdogStoreIsolation} from '../wechat-core-offline/watchdog-store-isolation.mjs';
import {prepareLiveService} from './wechat-live-service.mjs';
// Call before app.listen: private-state purge must complete before the MCP service is exposed.
export async function prepareAuthorizedApp({owner,events,keys,createApp,prepare=prepareLiveService,watchdog}){
 if(!owner||!events||!keys||typeof createApp!=='function'||typeof prepare!=='function')throw new Error('Live service configuration invalid');
 const live=await prepare({owner,events,...(watchdog?{watchdog}:{})});
 try{if(watchdog?.watchdogEvents)await assertWatchdogStoreIsolation({bridge:live.bridge,originalEvents:events,watchdogEvents:watchdog.watchdogEvents});const app=createApp({events,keys,bridge:live.bridge,...(watchdog?.watchdogEvents?{watchdogEvents:watchdog.watchdogEvents}:{})});let closed=false;return {app:app.app,stopTasks:()=>live.stopTasks?.(),close:async()=>{if(closed)return;closed=true;await live.close();await app.close()}};}catch(e){await live.close();throw e;}
}
