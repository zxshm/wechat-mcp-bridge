import {open} from 'node:fs/promises';import {constants} from 'node:fs';import {spawn} from 'node:child_process';import path from 'node:path';import {stateDirectory} from '../wechat-core-offline/config.mjs';
const fail=()=>Object.assign(new Error('Private bridge unavailable'),{code:'session_lock_unavailable'});
export async function acquireBridgeLock(root,{command='flock'}={}){
 if(typeof root!=='string'||path.resolve(root)!==path.join(stateDirectory(),'wechat-session'))throw fail();const lockPath=root+'.lock';let f;
 try{f=await open(lockPath,constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);const st=await f.stat();if(!st.isFile()||(st.mode&0o077)!==0||(process.getuid&&st.uid!==process.getuid()))throw fail();}catch{throw fail()}finally{await f?.close()}
 const worker="process.stdout.write('READY\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
 const child=spawn(command,['-n','-x','--',lockPath,process.execPath,'-e',worker],{stdio:['pipe','pipe','ignore']});child.stdin.on('error',()=>{});let settled=false;
 try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>finish(false),3000);let out='';const finish=ok=>{if(settled)return;settled=true;clearTimeout(timer);ok?resolve():reject(fail())};child.once('error',()=>finish(false));child.once('exit',()=>finish(false));child.stdout.on('data',b=>{out+=b.toString('utf8');if(out==='READY\n')finish(true);else if(out.length>6)finish(false)});});}catch{child.stdin.end();child.kill();throw fail()}
 let released=false;return async()=>{if(released)return;released=true;await new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve()};const timer=setTimeout(()=>{child.kill();finish()},3000);child.once('exit',finish);child.stdin.end();});};
}
