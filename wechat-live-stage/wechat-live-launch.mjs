import {prepareLiveService} from './wechat-live-service.mjs';
// Call before app.listen: private-state purge must complete before the MCP service is exposed.
export async function prepareAuthorizedApp({owner,events,keys,createApp,prepare=prepareLiveService}){
 if(!owner||!events||!keys||typeof createApp!=='function'||typeof prepare!=='function')throw new Error('Live service configuration invalid');
 const live=await prepare({owner,events});
 try{const app=createApp({events,keys,bridge:live.bridge});let closed=false;return {app:app.app,close:async()=>{if(closed)return;closed=true;await live.close();await app.close()}};}catch(e){await live.close();throw e;}
}
