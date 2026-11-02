import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,lstat,chmod,symlink,link} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {SafeStore,cleanup,HOUR} from './safe-log.mjs';
import {supervise} from './runner.mjs';
assert.ok(process.execArgv.some(x=>/test-no-network\.cjs$/.test(x)),'Run through run-tests.mjs or use the network-denying preload');
const options={skip:process.platform!=='linux',timeout:10000};
const here=path.dirname(fileURLToPath(import.meta.url));
async function temporary(fn){const root=await mkdtemp(path.join(os.tmpdir(),'safe-log-linux-'));try{return await fn(root)}finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('safe-log-linux-'));await rm(root,{recursive:true,force:true});}}
test('Linux storage creates owner-only directory and files',options,()=>temporary(async root=>{
 const dir=path.join(root,'logs'),store=new SafeStore(dir);await store.start();store.enqueue({at:Date.now(),category:'collector_started',state:'unknown'});await store.flush();
 const ds=await lstat(dir);assert.equal(ds.mode&0o777,0o700);assert.equal(ds.uid,process.getuid());
 const files=await readdir(dir);assert.equal(files.length,1);const st=await lstat(path.join(dir,files[0]));assert.equal(st.mode&0o777,0o600);assert.equal(st.uid,process.getuid());
}));
test('Linux storage rejects accessible directories and symlinks without touching target',options,()=>temporary(async root=>{
 const wide=path.join(root,'wide');await mkdir(wide,{mode:0o755});await chmod(wide,0o755);await assert.rejects(new SafeStore(wide).start());
 const dir=path.join(root,'logs');await mkdir(dir,{mode:0o700});const outside=path.join(root,'outside');await writeFile(outside,'SYNTHETIC_UNTOUCHED',{mode:0o600});const target=path.join(dir,`safe-${Math.floor(Date.now()/HOUR)}.ndjson`);await symlink(outside,target);
 await assert.rejects(cleanup(dir));assert.equal(await readFile(outside,'utf8'),'SYNTHETIC_UNTOUCHED');assert.equal((await lstat(target)).isSymbolicLink(),true);
}));
test('Linux storage rejects hardlinks without altering referenced content',options,()=>temporary(async root=>{
 const dir=path.join(root,'logs');await mkdir(dir,{mode:0o700});const outside=path.join(root,'outside');await writeFile(outside,'SYNTHETIC_UNTOUCHED',{mode:0o600});await link(outside,path.join(dir,`safe-${Math.floor(Date.now()/HOUR)}.ndjson`));await assert.rejects(cleanup(dir));assert.equal(await readFile(outside,'utf8'),'SYNTHETIC_UNTOUCHED');
}));
test('real missing child executable is a failure, never a successful start',options,()=>temporary(async root=>{
 const records=[],store={directory:root,failures:0,enqueue:r=>records.push(r)};
 const code=await supervise({executable:path.join(root,'DOES_NOT_EXIST_SYNTHETIC_CHILD'),args:[],store,cleanupFn:async()=>{}});
 assert.equal(code,70);assert.ok(records.some(r=>r.category==='child_spawn_failed'));assert.ok(!records.some(r=>r.category==='edge_registered'));assert.ok(!records.some(r=>r.category==='collector_started'));
}));
test('real Linux process group termination reaches child exactly once',options,async()=>{
 const child=spawn(process.execPath,['--require',path.join(here,'test-no-network.cjs'),path.join(here,'linux-signal-driver.mjs')],{detached:true,stdio:['ignore','pipe','pipe']});
 let output='',errors='',sent=false;
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});
 const guard=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}},6000);
 try{
  child.stdout.on('data',chunk=>{output+=chunk.toString();if(!sent&&output.includes('READY\n')){sent=true;process.kill(-child.pid,'SIGTERM');}});child.stderr.on('data',chunk=>{errors+=chunk.toString()});
  const result=await done;assert.equal(sent,true);assert.equal(result.code,0,errors);assert.ok(output.includes('"exitCode":0'));
 }finally{clearTimeout(guard);try{process.kill(-child.pid,'SIGKILL')}catch{}}
});
test('generic unit/drop-in/cleanup templates pass offline systemd syntax verification',options,()=>temporary(async root=>{
 const bin=path.join(root,'cloudflared');await writeFile(bin,'#!/bin/sh\nexit 0\n',{mode:0o700});
 const units=path.join(root,'units');await mkdir(units,{mode:0o700});
 const name='cloudflared-tunnel.service',dropDir=path.join(units,name+'.d');await mkdir(dropDir,{mode:0o700});
 const tokenReference='/nonexistent/synthetic-reference';
 await writeFile(path.join(units,name),'[Unit]\nDescription=Synthetic isolated tunnel\n[Service]\nType=exec\nExecStart='+bin+' tunnel run --token-file '+tokenReference+'\nKillMode=control-group\nRestart=on-failure\nRestartSec=5s\nTimeoutStopSec=20s\n');
 const replacements={NODE_EXECUTABLE:process.execPath,RUNNER_PATH:path.join(here,'runner.mjs'),LOG_DIRECTORY:path.join(root,'logs'),CLOUDFLARED_EXECUTABLE:bin,EXISTING_TOKEN_FILE:tokenReference};
 const render=async name=>{
  const source=await readFile(path.join(here,'..','examples',name),'utf8');
  return source.replace(/@([A-Z_]+)@/g,(full,key)=>{if(key==='PLACEHOLDERS')return 'placeholder paths';assert.ok(Object.hasOwn(replacements,key));return replacements[key]});
 };
 const drop=await render('tunnel-safe-log.conf.example');await writeFile(path.join(dropDir,'30-safe-log.conf'),drop);
 await writeFile(path.join(dropDir,'40-http2.conf'),await render('tunnel-http2.conf.example'));
 for(const file of ['tunnel-safe-clean.service','tunnel-safe-clean.timer'])await writeFile(path.join(units,file),await render(file+'.example'));
 const runtime=path.join(root,'runtime');await mkdir(runtime,{mode:0o700});
 const result=spawnSync('/usr/bin/systemd-analyze',['--user','verify','--man=no',path.join(units,name),path.join(units,'tunnel-safe-clean.service'),path.join(units,'tunnel-safe-clean.timer')],{encoding:'utf8',timeout:7000,env:{...process.env,XDG_RUNTIME_DIR:runtime,SYSTEMD_UNIT_PATH:units+':/usr/lib/systemd/user'}});
 assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
 assert.ok(drop.includes('StandardError=null'));assert.ok(drop.includes('LimitCORE=0'));assert.ok(drop.includes(tokenReference));
}));
