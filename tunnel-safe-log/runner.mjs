import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {LineClassifier,SafeStore,cleanup} from './safe-log.mjs';

export function cloudflaredArguments(original){
 if(!Array.isArray(original)||original.length!==4||original[0]!=='tunnel'||original[1]!=='run'||original[2]!=='--token-file'||typeof original[3]!=='string'||!path.isAbsolute(original[3])||/[\r\n\0]/.test(original[3]))throw new Error('Unexpected original command shape');
 // Explicit null sink prevents inherited logfile/log-directory settings from creating raw files.
 return ['tunnel','--output','json','--loglevel','info','--logfile','/dev/null','--log-directory','',...original.slice(1)];
}
export async function supervise({executable,args,store,spawnImpl=spawn,clock=Date.now,signalSource=process,signalMode='control-group',periodic=setInterval,stopPeriodic=clearInterval,cleanupFn=cleanup}){
 const emit=(category,state='unknown')=>store.enqueue({at:clock(),category,state});
 let child;try{child=spawnImpl(executable,args,{stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true});}catch{emit('child_spawn_failed');return 70;}
 // A returned ChildProcess is not evidence that exec succeeded (e.g. ENOENT).
 child.once('spawn',()=>emit('collector_started'));
 const readers=[];for(const stream of [child.stdout,child.stderr]){const reader=new LineClassifier(record=>store.enqueue(record),{clock});readers.push(reader);stream.on('data',chunk=>reader.push(chunk));stream.on('error',()=>emit('pipe_failed'));}
 let cleaning=false;const timer=periodic(()=>{if(cleaning)return;cleaning=true;void Promise.resolve(cleanupFn(store.directory,clock())).catch(()=>{store.failures=Math.min(1000000,store.failures+1)}).finally(()=>{cleaning=false});},60000);timer?.unref?.();
 // systemd KillMode=control-group already signals both processes. A second signal
 // can bypass cloudflared's graceful shutdown, so production never forwards it.
 let stopped=false;const onSignal=signal=>{if(stopped)return;stopped=true;if(signalMode==='forward')try{child.kill(signal)}catch{}};const term=()=>onSignal('SIGTERM'),intr=()=>onSignal('SIGINT');signalSource.on('SIGTERM',term);signalSource.on('SIGINT',intr);
 return await new Promise(resolve=>{let failed=false;child.once('error',()=>{failed=true;emit('child_spawn_failed');});child.once('close',(code,signal)=>{for(const reader of readers)reader.end();stopPeriodic(timer);signalSource.off('SIGTERM',term);signalSource.off('SIGINT',intr);emit(signal?'child_signaled':'child_exited');resolve(failed?70:Number.isInteger(code)?Math.max(0,Math.min(255,code)):1);});});
}
async function main(argv){
 if(argv[0]==='clean'&&argv.length===2){await cleanup(path.resolve(argv[1]));return 0;}
 if(argv[0]!=='run'||argv.length!==8||argv[2]!=='--')throw new Error('Invalid arguments');
 const [,directory,,executable,...original]=argv;if(!path.isAbsolute(directory)||!path.isAbsolute(executable)||!/^cloudflared(?:\.exe)?$/.test(path.basename(executable)))throw new Error('Invalid arguments');
 const childArgs=cloudflaredArguments(original),store=new SafeStore(directory);await store.start();const code=await supervise({executable,args:childArgs,store});
 let timer;await Promise.race([store.flush(),new Promise(resolve=>{timer=setTimeout(resolve,2000)})]);if(timer)clearTimeout(timer);return code;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(code=>process.exit(code)).catch(()=>process.exit(70));
