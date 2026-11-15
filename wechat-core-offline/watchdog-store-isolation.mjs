import {realpath,stat} from 'node:fs/promises';import {join} from 'node:path';
// Recheck before exposure and each independent subscription mutation. Never
// infer isolation from different JavaScript objects alone.
export async function assertWatchdogStoreIsolation({bridge,originalEvents,watchdogEvents}){
 if(!bridge||!originalEvents||!watchdogEvents||originalEvents===watchdogEvents)throw new Error('Independent watchdog wiring required');
 const stores=[bridge.store,originalEvents.store,watchdogEvents.store];
 if(stores.some(s=>!s)||new Set(stores).size!==3)throw new Error('Independent watchdog stores required');
 if(stores.some(s=>s.directory!==undefined)){
  if(stores.some(s=>typeof s.directory!=='string'))throw new Error('Independent store paths required');
  const paths=await Promise.all(stores.map(s=>realpath(s.directory)));
  if(new Set(paths).size!==3)throw new Error('Independent store paths required');
  const files=await Promise.all(paths.map(p=>stat(join(p,'state.enc'))));
  if(new Set(files.map(s=>`${s.dev}:${s.ino}`)).size!==3)throw new Error('Independent store files required');
 }
}
