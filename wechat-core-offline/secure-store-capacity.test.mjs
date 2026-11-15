import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,readFile,writeFile,lstat,readdir,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createCipheriv,createHash} from 'node:crypto';
import {SecureStore} from './secure-store.mjs';
import {BridgeModel} from './bridge-model-live.mjs';
import {createQueue,enqueue} from './retention.mjs';
import {newState} from './core.mjs';
import {timing} from './latency-metrics.mjs';

assert.ok(process.execArgv.some(x=>/test-no-network\.cjs$/.test(x)), 'Run with --require test-no-network.cjs');
// Disable optional diagnostics in this test process, including when its parent
// has BRIDGE_STATE_DIR set. No real store.load or source of credentials is used.
timing.mark=()=>false;timing.markReply=()=>false;timing.purge=()=>false;
const MIB=1024*1024,HARD_LIMIT=8*MIB,ADMISSION=7*MIB;
const linuxOnly={skip:process.platform!=='linux'?'SecureStore requires Linux absolute paths and POSIX permissions':false};
const byteLength=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function exactPlaintext(size){
 const value={synthetic:''},overhead=byteLength(value),remaining=size-overhead;
 assert.ok(remaining>=0);
 value.synthetic='汉'.repeat(Math.floor(remaining/3))+'x'.repeat(remaining%3);
 assert.equal(byteLength(value),size);
 assert.ok(JSON.stringify(value).length<size);
 return value;
}
// Independent encoder for the existing XDW1/12-byte IV/GCM-tag envelope. This
// simulates an already stored legacy file; it never reads a provisioned key.
function legacyEnvelope(value,key){
 const magic=Buffer.from('XDW1'),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
 cipher.setAAD(magic);
 return Buffer.concat([magic,iv,cipher.update(Buffer.from(JSON.stringify(value),'utf8')),cipher.final(),cipher.getAuthTag()]);
}
async function temporaryStore(fn){
 const parent=await realpath(os.tmpdir()),directory=await mkdtemp(path.join(parent,'wechat-store-capacity-'));
 const key=randomBytes(32),instances=[];
 try{
  await chmod(directory,0o700);
  const openStore=()=>{const store=new SecureStore(directory,key);instances.push(store);return store};
  return await fn({directory,key,openStore,file:path.join(directory,'state.enc')});
 }finally{
  for(const store of instances)store.close();key.fill(0);
  assert.equal(path.dirname(path.resolve(directory)),parent);
  assert.ok(path.basename(directory).startsWith('wechat-store-capacity-'));
  await rm(directory,{recursive:true,force:true});
 }
}

test('capacity regression suite has real networking disabled',async()=>{
 await assert.rejects(fetch('https://example.invalid'),/TEST_NETWORK_DISABLED/);
});

test('SecureStore loads a legacy small XDW1 envelope',linuxOnly,()=>temporaryStore(async({file,key,openStore})=>{
 const prior={version:1,owner:'synthetic-owner',record:'synthetic-small-legacy-state'};
 await writeFile(file,legacyEnvelope(prior,key),{mode:0o600});
 assert.deepEqual(await openStore().load(),prior);
}));

test('SecureStore saves above 1 MiB and a new instance reads the same plaintext',linuxOnly,()=>temporaryStore(async({file,openStore})=>{
 const value=exactPlaintext(MIB+12345),writer=openStore();
 await writer.save(value);writer.close();
 const loaded=await openStore().load();
 assert.equal(byteLength(loaded),MIB+12345);
 assert.equal(digest(JSON.stringify(loaded)),digest(JSON.stringify(value)));
 assert.equal((await lstat(file)).size,MIB+12345+32);
}));

test('SecureStore accepts exactly 8 MiB UTF-8 plus 32 envelope bytes with 0700/0600 permissions',linuxOnly,()=>temporaryStore(async({directory,file,openStore})=>{
 const value=exactPlaintext(HARD_LIMIT);await openStore().save(value);
 const stat=await lstat(file);
 assert.equal(stat.size,HARD_LIMIT+32);
 assert.equal((await lstat(directory)).mode&0o777,0o700);
 assert.equal(stat.mode&0o777,0o600);
 const loaded=await openStore().load();
 assert.equal(byteLength(loaded),HARD_LIMIT);
 assert.equal(digest(JSON.stringify(loaded)),digest(JSON.stringify(value)));
}));

test('SecureStore refuses 8 MiB plus one byte, preserves the previous file, and later saves recover',linuxOnly,()=>temporaryStore(async({directory,file,openStore})=>{
 const store=openStore(),prior={version:1,synthetic:'prior'};await store.save(prior);
 const before=await readFile(file);
 await assert.rejects(store.save(exactPlaintext(HARD_LIMIT+1)),/State too large/);
 assert.deepEqual(await readFile(file),before);
 assert.deepEqual(await openStore().load(),prior);
 assert.deepEqual(await readdir(directory),['state.enc']);
 const later={version:1,synthetic:'successful recovery'};await store.save(later);
 assert.deepEqual(await openStore().load(),later);
}));

test('SecureStore refuses an authenticated ciphertext exceeding the 8 MiB plus 32-byte limit',linuxOnly,()=>temporaryStore(async({file,key,openStore})=>{
 const oversized=legacyEnvelope(exactPlaintext(HARD_LIMIT+1),key);
 assert.equal(oversized.length,HARD_LIMIT+33);
 await writeFile(file,oversized,{mode:0o600});
 await assert.rejects(openStore().load(),/Private state unavailable or invalid/);
}));

test('SecureStore rejects tampered authenticated ciphertext',linuxOnly,()=>temporaryStore(async({file,openStore})=>{
 await openStore().save({synthetic:'integrity fixture'});
 const blob=await readFile(file);blob[16]^=1;
 await writeFile(file,blob,{mode:0o600});
 await assert.rejects(openStore().load(),/Private state unavailable or invalid/);
}));

const OWNER='admission-synthetic-owner',BASE=1700000000000,EVENT='admission-event';
function admissionFixture(paddingBytes){
 let saves=0;
 const bridge=new BridgeModel({owner:OWNER,store:{load:async()=>{throw Error('Unexpected store.load')},save:async()=>{saves++}},syncLog:()=>{}});
 const queue=createQueue(OWNER);
 enqueue(queue,OWNER,{eventId:EVENT,name:'weixin.owner_text',timestamp:new Date(BASE).toISOString(),data:{conversation_id:'weixin-self',message_id:'synthetic-message',simulation:false,text:'synthetic incoming context'}},{to_user_id:'synthetic-sender',accountScope:'synthetic-account',context_token:'synthetic-context',source_message_id:'synthetic-message'},BASE);
 bridge.state=structuredClone({version:1,owner:OWNER,phase:'armed',sessionToken:'synthetic-token',binding:{allowedSender:'synthetic-sender',accountScope:'synthetic-account'},core:newState({ownerSubject:OWNER,accountScope:'synthetic-account',allowFrom:['synthetic-sender'],armedAt:BASE-1000,initialCursor:'synthetic-cursor'}),queue,delivery:{},syntheticPadding:'汉'.repeat(Math.floor(paddingBytes/3))+'x'.repeat(paddingBytes%3)});
 return {bridge,saves:()=>saves};
}
const admissionOperations={
 text:f=>f.bridge.replyDraft(OWNER,EVENT,'synthetic outgoing text','text-capacity-key',BASE,()=>BASE),
 media:f=>f.bridge.mediaReplyDraft(OWNER,{eventId:EVENT,idempotencyKey:'media-capacity-key',kind:'image',fileName:'synthetic.png',sha256:'e'.repeat(64)},()=>BASE),
 sync:f=>f.bridge.enqueueSync(OWNER,{sourceId:'sync-capacity-source',role:'assistant',text:'synthetic queued text',eventId:EVENT},()=>BASE),
};
for(const [kind,operation] of Object.entries(admissionOperations)){
 test(kind+' admission accepts retained state above 896 KiB and below 7 MiB without transport',async()=>{
  const f=admissionFixture(2*MIB);assert.ok(byteLength(f.bridge.state)>896*1024);
  await operation(f);
  assert.equal(f.saves(),1);assert.ok(byteLength(f.bridge.state)<ADMISSION);
  assert.equal(f.bridge.writeFailure,false);
  if(kind==='sync')assert.equal(Object.values(f.bridge.state.syncOutbox.records)[0].state,'queued');
  else assert.equal(Object.values(f.bridge.state.queue.records[EVENT].replies)[0].state,'uncertain');
 });
 test(kind+' admission refuses state above 7 MiB without save or failstop',async()=>{
  const f=admissionFixture(ADMISSION),original=f.bridge.state,before=digest(JSON.stringify(original));
  assert.ok(byteLength(original)>ADMISSION);
  await assert.rejects(operation(f),kind==='sync'?/Sync storage capacity reached/:e=>e.code==='reply_capacity');
  assert.equal(f.bridge.state,original);assert.equal(digest(JSON.stringify(f.bridge.state)),before);
  assert.equal(f.saves(),0);assert.equal(f.bridge.writeFailure,false);
  assert.doesNotThrow(()=>f.bridge.check(OWNER));
 });
}
