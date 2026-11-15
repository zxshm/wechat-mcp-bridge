import {isAbsolute} from 'node:path';
import {privatePath,stateDirectory,largeMediaPaths} from '../wechat-core-offline/config.mjs';
import {mkdir,lstat} from 'node:fs/promises';import {initEventsStore} from '../wechat-core-offline/private-init.mjs';import {BridgeModel} from '../wechat-core-offline/bridge-model-live.mjs';import {acquireBridgeLock} from './wechat-single-writer.mjs';
const DEFAULT_ROOT=privatePath('wechat-session');
export async function openPrivateBridge(owner,{root=DEFAULT_ROOT,init=initEventsStore}={}){
 if(typeof owner!=='string'||!owner||typeof root!=='string'||!isAbsolute(root))throw Object.assign(new Error('Private bridge unavailable'),{code:'session_store_unavailable'});
 try{await mkdir(root,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw Object.assign(new Error('Private bridge unavailable'),{code:'session_store_unavailable'})}
 const st=await lstat(root);if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0||(process.getuid&&st.uid!==process.getuid()))throw Object.assign(new Error('Private bridge unavailable'),{code:'session_store_unavailable'});
 const release=await acquireBridgeLock(root);let store;
 try{store=await init(root);const bridge=new BridgeModel({owner,store});const state=await store.load();if(state?.version===1&&state.owner===owner){await bridge.load();}else if(state&&Object.keys(state).length===1&&state.subscriptions&&Object.keys(state.subscriptions).length===0){await bridge.initialize();}else throw new Error('Private bridge state invalid');let closed=false;return {bridge,store,close:async()=>{if(closed)return;closed=true;store.close();await release()}};}catch{store?.close();await release();throw Object.assign(new Error('Private bridge unavailable'),{code:'session_store_unavailable'})}
}
