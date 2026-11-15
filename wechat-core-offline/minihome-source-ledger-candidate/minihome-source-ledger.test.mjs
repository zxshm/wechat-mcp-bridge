import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {createMinihomeSourceLedger} from './minihome-source-ledger.mjs';

test('本人鉴权后才挂载，重启不恢复首次资格且不保存正文',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'xiaodi-ledger-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'sources.sqlite'),handlers=new Map(),descriptions=new Map();
 const server={registerTool(name,options,handler){handlers.set(name,handler);descriptions.set(name,options.description)}};
 let store=createMinihomeSourceLedger({file,roomId:'room'});
 assert.throws(()=>store.register({server,z,ownerAuthenticated:false}),/auth_required/);
 store.register({server,z,ownerAuthenticated:true});
 assert.match(descriptions.get('minihome_prepare_verified_sync_submission'),/不包含旧 Windows 账本/);
 const start=store.capabilities().enabledSince;
 const p={sourceId:'new_message',role:'assistant',sourceCreatedAt:start,sourceExpiresAt:start+86400000,sourceText:'仅用于测试的正文',eventId:'event'};
 const call=async(name,args)=>JSON.parse((await handlers.get('minihome_'+name)(args)).content[0].text);
 await call('capture_sync_source_observation',(({eventId,...v})=>v)(p));
 assert.equal((await call('prepare_verified_sync_submission',p)).firstSubmissionClaim,true);
 store.close();
 store=createMinihomeSourceLedger({file,roomId:'room'});
 store.register({server,z,ownerAuthenticated:true});
 assert.equal((await call('prepare_verified_sync_submission',p)).firstSubmissionClaim,false);
 assert.equal(store.get({sourceId:p.sourceId}).record.phase,'reserved_unknown');
 assert.equal(store.capabilities().allOutboundPathsCoordinated,false);
 store.close();
 for(const name of readdirSync(dir))assert.equal(readFileSync(join(dir,name)).includes(Buffer.from(p.sourceText)),false);
});

test('长期账本可超过原试验上限，同时拒绝启用前的消息',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'xiaodi-capacity-'));
 let store;
 try{
  store=createMinihomeSourceLedger({file:join(dir,'sources.sqlite'),roomId:'room'});
  const start=store.capabilities().enabledSince;
  const handlers=new Map(),server={registerTool(name,options,handler){handlers.set(name,handler)}};
  store.register({server,z,ownerAuthenticated:true});
  const register=handlers.get('minihome_register_sync_source_window');
  for(let i=0;i<513;i++)assert.equal((await register({sourceId:`source_${i}`,role:'user',sourceCreatedAt:start,sourceExpiresAt:start+86400000})).isError,undefined);
  assert.equal((await register({sourceId:'old',role:'user',sourceCreatedAt:start-1,sourceExpiresAt:start+86400000-1})).isError,true);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true})}
});
