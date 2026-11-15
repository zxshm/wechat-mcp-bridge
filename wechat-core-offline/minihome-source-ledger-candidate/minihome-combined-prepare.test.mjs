import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {createMinihomeSourceLedger} from './minihome-source-ledger.mjs';

function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'combined-sync-')),file=join(dir,'ledger.sqlite');
 const ledger=createMinihomeSourceLedger({file,roomId:'fixture'}),handlers=new Map();let serial=Promise.resolve();
 t.after(()=>{ledger.close();rmSync(dir,{recursive:true,force:true})});
 const bridge={owner:'owner',state:{phase:'armed'},locked(fn){const p=serial.then(fn);serial=p.catch(()=>{});return p},check(actor){assert.equal(actor,this.owner)}};
 const submission={status:'not_recorded',coverage:{historyCoverage:'complete_for_source_window'}};
 const direct={historyCoverage:'complete_for_source_window',reservationCount:0,status:'none_observed',attributionComplete:true,hasMore:false};
 let inspections=0;
 ledger.register({server:{registerTool(n,o,h){handlers.set(n,{o,h})}},z,ownerAuthenticated:true,actor:'owner',bridge,
  inspectSubmission(){inspections++;return structuredClone(submission)},inspectDirect(){return structuredClone(direct)}});
 const started=ledger.capabilities().enabledSince;
 const p={sourceId:'new_source',role:'assistant',sourceCreatedAt:started,sourceExpiresAt:started+86400000,eventId:'event',sourceText:'测试正文不可落盘'};
 const call=async(args=p)=>{const {o,h}=handlers.get('minihome_inspect_and_prepare_sync_submission');const r=await h(o.inputSchema.parse(args));return {...JSON.parse(r.content[0].text),isError:r.isError}};
 return {dir,ledger,handlers,bridge,submission,direct,p,call,get inspections(){return inspections}};
}
test('合并首次取得资格，完整证据及耗时返回，正文不落盘',async t=>{
 const f=fixture(t),r=await f.call();assert.equal(r.acquired,true);assert.equal(r.firstSubmissionClaim,true);
 assert.equal(r.observation.durableReadBack,true);assert.equal(r.history.status,'not_recorded');
 assert.equal(r.submission.contentDigest,r.contentDigest);assert.equal(r.submission.eventId,f.p.eventId);
 assert.ok(r.timing.processingMs>=0);assert.ok(r.timing.totalMs>=r.timing.processingMs);
 for(const name of readdirSync(f.dir))assert.equal(readFileSync(join(f.dir,name)).includes(Buffer.from(f.p.sourceText)),false);
});
for(const scenario of ['已有提交','历史缺口','已有直发','归因不足','尚有下一页','历史字段缺失'])test(scenario+'不预占且回滚新观察',async t=>{
 const f=fixture(t);
 if(scenario==='已有提交')f.submission.status='sent';
 if(scenario==='历史缺口')f.submission.coverage.historyCoverage='incomplete';
 if(scenario==='已有直发')f.direct.reservationCount=1;
 if(scenario==='归因不足')f.direct.attributionComplete=false;
 if(scenario==='尚有下一页')f.direct.hasMore=true;
 if(scenario==='历史字段缺失')delete f.submission.status;
 const r=await f.call();assert.equal(r.acquired,false);assert.equal(r.reason,'source_history_not_clear');
 assert.equal(f.ledger.get(f.p).record,null);assert.equal(f.ledger.get(f.p).observedMetadata,null);
});
test('并发新入口与原入口共用唯一预占，响应丢失不恢复资格',async t=>{
 const f=fixture(t),results=await Promise.all([f.call(),f.call()]);
 assert.equal(results.filter(r=>r.acquired).length,1);assert.equal(f.inspections,1);
 const old=f.handlers.get('minihome_prepare_verified_sync_submission');
 const r=JSON.parse((await old.h(f.p)).content[0].text);assert.equal(r.firstSubmissionClaim,false);
 assert.equal(f.ledger.get(f.p).record.phase,'reserved_unknown');
});
test('旧入口先预占时新入口不能恢复，原观察冲突不改写',async t=>{
 const f=fixture(t),{eventId,...observation}=f.p;
 await f.handlers.get('minihome_capture_sync_source_observation').h(observation);
 const conflict=await f.call({...f.p,sourceText:'另一正文'});assert.equal(conflict.isError,true);assert.equal(f.ledger.get(f.p).record,null);
 await f.handlers.get('minihome_prepare_verified_sync_submission').h(f.p);
 assert.equal((await f.call()).acquired,false);
});
test('桥锁内再次检查状态，停用与身份错误均不写账本',async t=>{
 const f=fixture(t);let release;const held=f.bridge.locked(()=>new Promise(r=>release=r));await Promise.resolve();
 const pending=f.call();f.bridge.state.phase='stopped';release();await held;
 assert.equal((await pending).isError,true);assert.equal(f.ledger.get(f.p).observedMetadata,null);
 f.bridge.state.phase='armed';f.bridge.owner='other';assert.equal((await f.call()).isError,true);
});
test('客户端不能注入历史，错误后整个事务回滚',async t=>{
 const f=fixture(t);await assert.rejects(f.call({...f.p,history:f.submission}));
 const r=await f.call({...f.p,eventId:'bad:event'}).catch(()=>null);assert.equal(r,null);
 assert.equal(f.ledger.get(f.p).observedMetadata,null);
});
