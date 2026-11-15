import {privatePath,stateDirectory,largeMediaPaths} from '../wechat-core-offline/config.mjs';
import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {hkdfSync} from 'node:crypto';
import {SecureStore} from '../wechat-core-offline/secure-store.mjs';
import {ReplyWatchdogEvents} from '../wechat-core-offline/reply-watchdog-events.mjs';
import {acquireBridgeLock} from './wechat-single-writer.mjs';
import {prepareAuthorizedApp} from './wechat-live-launch.mjs';
const ROOT=privatePath('reply-watchdog');
const fail=()=>new Error('Preprovisioned independent watchdog store unavailable');
// Reads existing private material only. Never provisions keys, state or subscriptions.
export async function openWatchdogSubscriber({owner,originalEvents,root=ROOT}){
 let release,store,key,derived,fh;
 try{
  if(!owner||!originalEvents?.store?.directory||root!==ROOT)throw fail();
  const d=await lstat(root);if(!d.isDirectory()||d.isSymbolicLink()||(d.mode&0o077)||(process.getuid&&d.uid!==process.getuid())||await realpath(root)!==root)throw fail();
  if(await realpath(originalEvents.store.directory)===root)throw fail();
  for(const name of ['key','state.enc']){const s=await lstat(join(root,name));if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||(s.mode&0o077)||(process.getuid&&s.uid!==process.getuid()))throw fail();}
  release=await acquireBridgeLock(root);
  fh=await open(join(root,'key'),constants.O_RDONLY|constants.O_NOFOLLOW);const ks=await fh.stat();if(!ks.isFile()||ks.size!==32||ks.nlink!==1||(ks.mode&0o077)||(process.getuid&&ks.uid!==process.getuid()))throw fail();key=await fh.readFile();await fh.close();fh=null;
  derived=Buffer.from(hkdfSync('sha256',key,Buffer.from('xiaodi-wechat'),Buffer.from('reply-watchdog-v1'),32));
  store=new SecureStore(root,derived);const events=new ReplyWatchdogEvents({owner,store,isAuthorized:async actor=>actor===owner});await events.load();
  if(events.state.subscription!==null){const s=events.state.subscription;if(s?.owner!==owner||s?.name!=='weixin.reply_overdue')throw fail();}
  let closed=false;return {watchdogEvents:events,close:async()=>{if(closed)return;closed=true;try{store.close()}finally{await release()}}};
 }catch{store?.close();await release?.();throw fail();}finally{key?.fill(0);derived?.fill(0);await fh?.close();}
}
export async function prepareWatchdogApp({mode='off',openSubscriber=openWatchdogSubscriber,prepare=prepareAuthorizedApp,...options}){
 if(!['off','provision','active'].includes(mode))throw new Error('Invalid watchdog mode');
 if(mode==='off')return prepare(options);
 let subscriber,live;
 try{subscriber=await openSubscriber({owner:options.owner,originalEvents:options.events});live=await prepare({...options,watchdog:{enabled:mode==='active',watchdogEvents:subscriber.watchdogEvents}});let closed=false;return {...live,close:async()=>{if(closed)return;closed=true;try{await live.close()}finally{await subscriber.close()}}};}
 catch(error){await subscriber?.close();throw error;}
}
