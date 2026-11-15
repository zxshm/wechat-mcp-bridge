import test from 'node:test';
import assert from 'node:assert/strict';
import {startJwksBackgroundRefresh} from './jwks-background-refresh.mjs';

test('公开密钥预取不阻塞调用方且同一时刻只发一次请求',async()=>{
 let release,calls=0,tick,cleared=false;const results=[];
 const keys={reload:()=>{calls++;return new Promise(r=>release=r)}};
 const job=startJwksBackgroundRefresh(keys,{onResult:x=>results.push(x),setTimer:fn=>{tick=fn;return{unref(){}}},clearTimer:()=>{cleared=true}});
 tick();tick();await Promise.resolve();assert.equal(calls,1);
 const pending=job.refresh();release();await pending;assert.equal(results[0].ok,true);
 job.stop();tick();await job.refresh();assert.equal(calls,1);assert.equal(cleared,true);
});
test('刷新失败不替换验证器或改变过期策略，下周期可重新取得公开密钥',async()=>{
 let calls=0;const errors=[];const original=async()=>{if(++calls===1)throw Error('秘密不得输出')};
 const keys={reload:original};
 const job=startJwksBackgroundRefresh(keys,{onResult:x=>errors.push(x)});
 try{await job.refresh();await job.refresh();assert.equal(keys.reload,original);assert.deepEqual(errors.map(x=>x.ok),[false,true]);assert.ok(!JSON.stringify(errors).includes('秘密'))}finally{job.stop()}
});
test('拒绝超出预取区间的配置',()=>{
 for(const intervalMs of [0,29999,300001,Infinity])assert.throws(()=>startJwksBackgroundRefresh({reload(){}},{intervalMs}));
});
test('预取失败三十秒后恢复，停止后不能继续联网',async()=>{
 let retry,delay,calls=0,cleared=0;
 const job=startJwksBackgroundRefresh({reload:async()=>{calls++;throw Error('断网')}},{setRetry:(fn,ms)=>{retry=fn;delay=ms;return{unref(){}}},clearRetry:()=>cleared++});
 await job.refresh();assert.equal(delay,30000);retry();await job.refresh();assert.equal(calls,2);
 job.stop();assert.equal(cleared,1);retry();await job.refresh();assert.equal(calls,2);
});
