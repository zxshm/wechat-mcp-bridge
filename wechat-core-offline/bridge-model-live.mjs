import {privatePath,stateDirectory,largeMediaPaths} from './config.mjs';
import {newDirectAttemptCoverage,recordDirectAttempt,inspectDirectAttemptCoverage} from './direct-attempt-coverage.mjs';
import {acknowledgeCoverageGap,enableReplyWatchdog, registerReplyWatch, recordWatchReply, validateWatchPurpose, reconcileReplyWatches, replyWatchdogStatus, claimWatchdogAlert, finishWatchdogAlert, recoverWatchdogAlert, acknowledgeExpiredWatches, reviewUnsentWatchdogAlert} from './reply-watchdog.mjs';
import {hashServerMessageId,bindQuotedContext} from './quoted-context.mjs';
import {newSubmissionCoverage,observeSubmissionCoverage,inspectSyncSubmission,contentDigest,submissionError} from './sync-submission.mjs';
import {assertContextBudget,CONTEXT_NOTICE_SUFFIX,formatContextText} from './context-budget.mjs';
import {syncDiagnostic} from './sync-diagnostic.mjs';
import {timing} from './latency-metrics.mjs';
import {summarizeReplyHistory} from './reply-status.mjs';
import {contextDiagnostics} from './context-diagnostics.mjs';
import {isRejectedContext,rejectedContextError} from './rejection-guard.mjs';
import {readSafeRejections,restoreRejectedContexts} from './rejection-restore.mjs';
import {createHash,randomBytes} from 'node:crypto';
import {normalizeIncomingMedia} from './media-codec.mjs';
// Synthetic integration model. Not connected to a network or running MCP server.
import {bindConfirmed,armWithChallenge} from './arming.mjs';
import {normalizeWire,baselineFromBatch} from './weixin-adapter.mjs';
import {acceptBatch} from './core.mjs';
import {createQueue,enqueue,enqueueMedia,purge,eventForDelivery,beginReply,markSent,recentConversation} from './retention.mjs';
import {cleanSync,enqueueSync,claimSync,finishSync,listSync,recoverSync,listInboundDelivery,confirmSyncReceived,retargetQueuedSync,cancelUncertainSyncIntent,cancelQueuedSyncIntents} from './sync-outbox.mjs';
import {latestOwnerContext as inspectLatestOwnerContext} from './latest-context.mjs';
function latestOwnerContext(...args){const route=inspectLatestOwnerContext(...args);if(route.scopeVerified&&!route.orderCertain)throw Object.assign(new Error('Owner context order is ambiguous'),{code:'context_order_ambiguous'});return route;}
// Only retained records are searchable; absence never proves complete history.
function hasRetainedKeyElsewhere(queue,eventId,idempotency){if(typeof idempotency!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(idempotency))return false;const digest=createHash('sha256').update(idempotency).digest('hex');return Object.entries(queue?.records||{}).some(([id,r])=>id!==eventId&&((r.replies&&Object.hasOwn(r.replies,digest))||(r.sendState&&r.idempotencyKey===idempotency)));}
export class BridgeModel {
 constructor({owner,store,syncLog=syncDiagnostic,submissionClock=Date.now}){if(!owner||!store?.save||!store?.load)throw new Error('Private store and owner required');this.logSync=item=>{try{syncLog(item)}catch{}};this.owner=owner;this.store=store;this.state=null;this.serial=Promise.resolve();this.volatileRejected=new Set();this.writeFailure=false;this.activeDeliveries=new Map();if(typeof submissionClock!=='function')throw new Error('Invalid submission clock');this.submissionClock=submissionClock;this.submissionCoverage=null;this.directAttemptCoverage=null;}
 locked(fn){const p=this.serial.then(fn);this.serial=p.catch(()=>{});return p;}
 check(actor){if(actor!==this.owner||!this.state)throw new Error('Owner required');if(this.writeFailure)throw Object.assign(new Error('State storage unavailable'),{code:'state_storage_unavailable'});}
 async commit(s){try{await this.store.save(s);this.state=s;if(this.submissionCoverage){this.submissionCoverage.revision++;observeSubmissionCoverage(this.submissionCoverage,this.submissionClock());}}catch(e){this.writeFailure=true;if(this.submissionCoverage)this.submissionCoverage.valid=false;throw e;}}
 initialize(){return this.locked(async()=>{const s={version:1,owner:this.owner,phase:'unconfigured',queue:createQueue(this.owner),delivery:{}};await this.commit(s);this.submissionCoverage=newSubmissionCoverage(this.submissionClock());this.directAttemptCoverage=newDirectAttemptCoverage(this.submissionClock());});}
 load(){return this.locked(async()=>{const s=await this.store.load();if(s?.owner!==this.owner||s.version!==1)throw new Error('Invalid private state');const recovered=restoreRejectedContexts(s.queue,readSafeRejections(privatePath('timing.ndjson')),Date.now());if(Object.values(s.syncOutbox?.records||{}).some(r=>r.state==='inflight')){recoverSync(s);await this.commit(s);}else if(recovered)await this.commit(s);else this.state=s;this.submissionCoverage=newSubmissionCoverage(this.submissionClock());this.directAttemptCoverage=newDirectAttemptCoverage(this.submissionClock());});}
 bind(actor,response,confirmedByOwner,now){return this.locked(async()=>{this.check(actor);if(this.state.phase!=='unconfigured'||typeof response?.bot_token!=='string'||!response.bot_token)throw new Error('Binding unavailable');if(response.baseurl){const u=new URL(response.baseurl);if(u.origin!=='https://ilinkai.weixin.qq.com'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('Base origin needs review');}const b=bindConfirmed({response,ownerSubject:actor,confirmedByOwner,confirmedAt:now});const s=structuredClone(this.state);s.binding=b;s.sessionToken=response.bot_token;s.phase='bound';await this.commit(s);});}
 baseline(actor,batch){return this.locked(async()=>{this.check(actor);if(this.state.phase!=='bound')throw new Error('Binding required');const cursor=baselineFromBatch(batch);const s=structuredClone(this.state);s.baselineCursor=cursor;s.phase='challenge';await this.commit(s);});}
 arm(actor,raw,challengeText,challengeCursor,now){return this.locked(async()=>{this.check(actor);if(this.state.phase!=='challenge')throw new Error('Baseline required');const b=this.state.binding;const m=normalizeWire(raw,{allowedSender:b.allowedSender,accountScope:b.accountScope,armedAt:b.confirmedAt});if(!m||m.create_time_ms>now+60000)throw new Error('Challenge rejected');const core=armWithChallenge({binding:b,actor,baselineCursor:this.state.baselineCursor,challengeCursor,challengeText,message:m});const s=structuredClone(this.state);s.core=core;s.phase='armed';delete s.baselineCursor;await this.commit(s);});}
 ingest(actor,batch,now,clock=()=>now){return this.locked(async()=>{this.check(actor);now=clock();if(!Number.isSafeInteger(now))throw new Error('Invalid receipt clock');if(this.state.phase!=='armed')throw new Error('Bridge not armed');if(!batch||batch.ret!==0||!Array.isArray(batch.msgs))throw new Error('Invalid batch');const s=structuredClone(this.state);purge(s.queue,now);const normalized=[],media=[];const scope={allowedSender:s.binding.allowedSender,accountScope:s.binding.accountScope,armedAt:s.core.armedAt,now};for(const raw of batch.msgs){media.push(...normalizeIncomingMedia(raw,scope));const rawText=Array.isArray(raw?.item_list)&&raw.item_list.some(x=>x?.type===2||x?.type===4)?{...raw,item_list:raw.item_list.filter(x=>x?.type===1)}:raw;const m=normalizeWire(rawText,scope);if(m && m.create_time_ms<=now+60000 && now-m.create_time_ms<86400000)normalized.push(m);}const events=acceptBatch(s.core,actor,{...batch,msgs:normalized});let n=0;const timingIds=[];for(const event of events){const record=s.core.records[event.eventId];if(enqueue(s.queue,actor,event,record.privateReplyContext,now)){s.delivery[event.eventId]={attempts:0,nextAt:now,done:false};n++;timingIds.push(event.eventId);}delete s.core.records[event.eventId];}for(const item of media)if(enqueueMedia(s.queue,actor,item.event,item.context,item.media,now)){s.delivery[item.event.eventId]={attempts:0,nextAt:now,done:false};n++;timingIds.push(item.event.eventId);}for(const id of Object.keys(s.delivery))if(!s.queue.records[id]?.event)delete s.delivery[id];if(s.replyWatchdog)for(const id of timingIds)registerReplyWatch(s,actor,id,now);if(Buffer.byteLength(JSON.stringify(s),'utf8')>7*1024*1024)throw Object.assign(new Error('Inbound storage capacity reached'),{code:'inbound_capacity'});await this.commit(s);for(const id of timingIds){timing.mark(id,'event_received');try{contextDiagnostics.observeInbound(this.state.queue.records[id],now)}catch{}}return {accepted:n};});}
 async attemptDelivery(actor,eventId,now,deliver,clock=()=>now){
  const ticket=await this.locked(async()=>{
   this.check(actor);if(this.state.phase!=='armed'||typeof deliver!=='function')throw new Error('Invalid bridge');
   if(this.activeDeliveries.has(eventId))return {result:{attempted:false,inFlight:true}};
   const current=clock(),s=structuredClone(this.state);purge(s.queue,current);const job=s.delivery[eventId],record=s.queue.records[eventId];
   if(!job||job.done||job.nextAt>current||!record?.event){if(job&&!record?.event)delete s.delivery[eventId];await this.commit(s);return {result:{attempted:false}};}
   if(job.inFlight){job.done=true;job.uncertain=true;delete job.inFlight;delete job.attemptId;await this.commit(s);return {result:{attempted:false,uncertain:true}};}
   const attemptId=randomBytes(16).toString('hex'),deadline=record.textUntil,event=structuredClone(record.event);job.inFlight=true;job.attemptId=attemptId;await this.commit(s);this.activeDeliveries.set(eventId,attemptId);return {attemptId,deadline,event,current};
  });
  if(ticket.result)return ticket.result;
  let started=false;
  try{
   let result;if(clock()>=ticket.deadline)result={accepted:false,expired:true,status:0};else{started=true;try{result=await deliver(actor,ticket.event,ticket.current,ticket.deadline,clock);}catch{result={accepted:false,status:0,terminal:true,uncertain:true};}if(!result||typeof result!=='object')result={accepted:false,status:0,terminal:true,uncertain:true};if(result.notStarted===true)started=false;}
   return await this.locked(async()=>{
    this.check(actor);const current=clock(),s=structuredClone(this.state);purge(s.queue,current);const job=s.delivery[eventId];
    if(!s.queue.records[eventId]?.event){if(job)delete s.delivery[eventId];await this.commit(s);return {attempted:started,accepted:!!result.accepted,uncertain:!!result.uncertain,expired:true};}
    if(!job||job.inFlight!==true||job.attemptId!==ticket.attemptId)return {attempted:started,uncertain:true};
    delete job.inFlight;delete job.attemptId;
    if(!started&&!result.expired){job.nextAt=current;}else{
     if(started)job.attempts++;
     if(result.accepted)job.done=true;else if(result.uncertain){job.done=true;job.uncertain=true;}else if(result.expired||current>=ticket.deadline){job.done=true;job.expired=true;}else if(result.terminal||(result.status>=400&&result.status<500&&result.status!==429)||job.attempts>=8){job.done=true;job.failed=true;}else job.nextAt=current+Math.min(3600000,1000*2**(job.attempts-1));
    }
    await this.commit(s);if(result.accepted)timing.mark(eventId,'outbox_ack');return {attempted:started,accepted:!!result.accepted,uncertain:!!result.uncertain,expired:!!result.expired};
   });
  }finally{if(this.activeDeliveries.get(eventId)===ticket.attemptId)this.activeDeliveries.delete(eventId);}
 }

 readEvent(actor,eventId,clock=Date.now){return this.locked(async()=>{this.check(actor);timing.mark(eventId,'read_start');const now=clock(),s=structuredClone(this.state);purge(s.queue,now);for(const id of Object.keys(s.delivery))if(!s.queue.records[id]?.event)delete s.delivery[id];let event;try{event=eventForDelivery(s.queue,actor,eventId,now)}catch{await this.commit(s);throw new Error('Event unavailable')}const expiresAt=s.queue.records[eventId].textUntil;await this.commit(s);if(clock()>=expiresAt){purge(s.queue,clock());for(const id of Object.keys(s.delivery))if(!s.queue.records[id]?.event)delete s.delivery[id];await this.commit(s);throw new Error('Event unavailable')}return {event,expiresAt};});}
 recentConversation(actor,options,clock=Date.now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state);purge(s.queue,clock());for(const id of Object.keys(s.delivery))if(!s.queue.records[id]?.event)delete s.delivery[id];await this.commit(s);return recentConversation(structuredClone(s.queue),actor,clock(),options);});}
 mediaContext(actor,eventId,clock=Date.now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state);purge(s.queue,clock());const r=s.queue.records[eventId];if(r?.event?.name!=='weixin.owner_media'||!r.privateMediaContext)throw new Error('Media unavailable');const expiresAt=r.textUntil,media=structuredClone(r.privateMediaContext);await this.commit(s);if(clock()>=expiresAt)throw new Error('Media unavailable');return {media,expiresAt};});}
 replyDraft(actor,eventId,text,idempotency,now,clock=()=>now,{syncPartId,syncId,start,replyPurpose='final',nextUpdateAt,replyToEventId=eventId}={}){return this.locked(async()=>{
  this.check(actor);if(start!==undefined&&typeof start!=='function')throw new Error('Invalid send launcher');
  const current=clock(),s=structuredClone(this.state);purge(s.queue,current);for(const id of Object.keys(s.delivery))if(!s.queue.records[id]?.event)delete s.delivery[id];let draft;
  try{
   const original=s.queue.records[eventId],validKey=typeof idempotency==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(idempotency),validText=typeof text==='string'&&text.length>0&&text.length<=2000,validPart=syncPartId===undefined||typeof syncPartId==='string'&&/^[a-f0-9]{64}$/.test(syncPartId),key=validKey?createHash('sha256').update(idempotency).digest('hex'):null,prior=key&&original?.replies?.[key],legacyBlocks=original?.sendState&&(original.idempotencyKey===idempotency||original.sendState!=='sent');
   if(!syncPartId){const obligation=s.queue.records[replyToEventId];if(!obligation?.event||current>=obligation.textUntil)throw new Error('Reply obligation expired');validateWatchPurpose(replyPurpose,nextUpdateAt,current,Math.min(original?.textUntil??0,obligation.textUntil));}
   const watchBindingHash=!syncPartId?createHash('sha256').update(JSON.stringify([replyToEventId,replyPurpose,nextUpdateAt??null])).digest('hex'):null;
   if(prior&&!syncPartId){if(prior.watchBindingHash&&prior.watchBindingHash!==watchBindingHash)throw new Error('Immutable reply obligation conflict');if(!prior.watchBindingHash&&s.replyWatchdog?.records[replyToEventId])throw new Error('Historical reply cannot acquire new obligation');}
   let candidateText=text,budgetIndex=null,appendNotice=false,effectiveEventId=eventId,expiresAt=original?.textUntil,syncRecord;
   if(prior){if(Number.isSafeInteger(prior.budgetIndex))candidateText=formatContextText(text,prior.budgetIndex,prior.budgetNotice===true);else if(prior.budgetNotice===true)candidateText+=CONTEXT_NOTICE_SUFFIX;}
   if(validKey&&hasRetainedKeyElsewhere(s.queue,eventId,idempotency))throw Object.assign(new Error('Key already used by another event'),{code:'key_seen_elsewhere',...summarizeReplyHistory(s,actor,idempotency,current)});
   if(validKey&&validText&&validPart&&!prior&&!legacyBlocks&&original?.event){
    effectiveEventId=this.unattemptedOwnerTarget(s.queue,eventId,current);const record=s.queue.records[effectiveEventId],logicalHash=createHash('sha256').update(text).digest('hex');
    for(const source of new Set([original,record]))for(const r of Object.values(source.replies||{}))if((r.logicalHash===logicalHash||r.hash===logicalHash||r.budgetNotice===true&&r.hash===createHash('sha256').update(text+CONTEXT_NOTICE_SUFFIX).digest('hex'))&&(!syncPartId||!r.syncPartId||r.syncPartId===syncPartId))throw new Error('Reply already attempted under another key');
    expiresAt=Math.min(expiresAt,record.textUntil);
    if(syncId!==undefined){syncRecord=s.syncOutbox?.records?.[syncId];const part=syncRecord?.parts?.find(p=>p.partId===syncPartId);if(typeof syncId!=='string'||!/^[a-f0-9]{64}$/.test(syncId)||syncRecord?.state!=='inflight'||syncRecord.deliveryIntent==='cancelled'||syncRecord.eventId!==eventId||!part||part.state!=='inflight'||part.key!==idempotency||part.text!==text||!Number.isSafeInteger(syncRecord.expiresAt)||current>=syncRecord.expiresAt)throw Object.assign(new Error('Sync claim unavailable'),{code:'sync_claim_unavailable'});expiresAt=Math.min(expiresAt,syncRecord.expiresAt);}
    const budget=assertContextBudget(s.queue,effectiveEventId,current,{kind:'text',text});budgetIndex=budget.index;appendNotice=budget.notice;candidateText=formatContextText(text,budgetIndex,appendNotice);
   }
   // 直发尝试覆盖先于持久预占，保留失败的不确定性；队列部分另有原始来源账本。
   if(validKey&&validText&&validPart&&!syncPartId)recordDirectAttempt(this.directAttemptCoverage,current,{eventId:effectiveEventId,replyId:key,contentDigest:createHash('sha256').update(text).digest('hex')});
   draft=beginReply(s.queue,actor,effectiveEventId,candidateText,idempotency,current,{syncPartId});
   if(!draft.state){draft.effectiveEventId=effectiveEventId;if(budgetIndex!==null){const reply=s.queue.records[effectiveEventId].replies[key];reply.budgetIndex=budgetIndex;reply.logicalHash=createHash('sha256').update(text).digest('hex');if(appendNotice)reply.budgetNotice=true;}if(syncRecord){syncRecord.eventId=effectiveEventId;syncRecord.expiresAt=expiresAt;}}
   draft.expiresAt=syncPartId?expiresAt:Math.min(expiresAt,s.queue.records[replyToEventId].textUntil);
   if(!syncPartId&&!draft.state){const r=s.queue.records[effectiveEventId].replies[key];r.watchBindingHash=watchBindingHash;r.watchExpiresAt=draft.expiresAt;}
   if(!syncPartId&&s.queue.records[effectiveEventId].replies[key]?.watchExpiresAt)draft.expiresAt=Math.min(draft.expiresAt,s.queue.records[effectiveEventId].replies[key].watchExpiresAt);
   if(s.replyWatchdog&&!syncPartId)recordWatchReply(s,actor,effectiveEventId,idempotency,current,{purpose:replyPurpose,nextUpdateAt,obligationEventId:replyToEventId});
  }catch(e){await this.commit(s);throw e;}
  if(!draft.state&&Buffer.byteLength(JSON.stringify(s),'utf8')>7*1024*1024)throw Object.assign(new Error('Reply storage capacity reached'),{code:'reply_capacity'});
  await this.commit(s);return this.launchReservedReply(draft,start);
 });}
 // Resolve only from an unexpired, verified owner anchor; never expose the private context.
 unattemptedOwnerTarget(queue,eventId,now){const route=latestOwnerContext(queue,eventId,now);if(!route.scopeVerified)throw Object.assign(new Error('Owner context cannot be verified'),{code:'context_scope_unverified'});if(!route.orderCertain)throw Object.assign(new Error('Owner context order is ambiguous'),{code:'context_order_ambiguous'});if(isRejectedContext(queue,route.eventId,now,this.volatileRejected))throw rejectedContextError();return route.eventId;}
 // Start synchronously while still holding the state lock. Await the outcome outside it.
 launchReservedReply(draft,start){if(!draft.state&&start){try{draft.execution=Promise.resolve(start(draft)).then(value=>({value}),error=>({error}));}catch(error){draft.execution=Promise.resolve({error});}}return draft;}
 mediaReplyDraft(actor,{eventId,idempotencyKey,kind,fileName,sha256},clock=Date.now,{start}={}){return this.locked(async()=>{
  this.check(actor);if(!['image','file'].includes(kind)||typeof fileName!=='string'||fileName.length>160||typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(idempotencyKey)||!/^[a-f0-9]{64}$/.test(sha256)||start!==undefined&&typeof start!=='function')throw new Error('Invalid media');
  const current=clock(),s=structuredClone(this.state);purge(s.queue,current);for(const id of Object.keys(s.delivery))if(!s.queue.records[id]?.event)delete s.delivery[id];
  const key=createHash('sha256').update(idempotencyKey).digest('hex'),original=s.queue.records[eventId],prior=original?.replies||{},marker=JSON.stringify(['media',kind,fileName,sha256]);let draft;
  try{
   const watchBindingHash=createHash('sha256').update(JSON.stringify([eventId,'final',null])).digest('hex');
   if(prior[key]){if(prior[key].watchBindingHash&&prior[key].watchBindingHash!==watchBindingHash)throw new Error('Immutable reply obligation conflict');if(!prior[key].watchBindingHash&&s.replyWatchdog?.records[eventId])throw new Error('Historical reply cannot acquire new obligation');}
   if(hasRetainedKeyElsewhere(s.queue,eventId,idempotencyKey))throw Object.assign(new Error('Key already used by another event'),{code:'key_seen_elsewhere'});
   let effectiveEventId=eventId;
   if(!Object.hasOwn(prior,key)&&!(original?.sendState&&(original.idempotencyKey===idempotencyKey||original.sendState!=='sent')))effectiveEventId=this.unattemptedOwnerTarget(s.queue,eventId,current);
   const record=s.queue.records[effectiveEventId];for(const source of new Set([original,record]))for(const [k,r] of Object.entries(source?.replies||{}))if(k!==key&&r.kind==='media'&&r.mediaHash===sha256)throw new Error('Media already attempted');
   if(!Object.hasOwn(prior,key))try{assertContextBudget(s.queue,effectiveEventId,current,{kind:'media'});}catch(e){if(['context_notice_requires_text','context_budget_exhausted'].includes(e?.code))e.blockedEventId=effectiveEventId;throw e;}
   draft=beginReply(s.queue,actor,effectiveEventId,marker,idempotencyKey,current);draft.expiresAt=Math.min(original.textUntil,record.textUntil);
   if(!draft.state){draft.effectiveEventId=effectiveEventId;const r=record.replies[key];r.kind='media';r.mediaKind=kind;r.fileName=fileName;r.mediaHash=sha256;r.watchBindingHash=watchBindingHash;r.watchExpiresAt=draft.expiresAt;delete r.text;}
   if(record.replies[key]?.watchExpiresAt)draft.expiresAt=Math.min(draft.expiresAt,record.replies[key].watchExpiresAt);
   if(s.replyWatchdog)recordWatchReply(s,actor,effectiveEventId,idempotencyKey,current,{obligationEventId:eventId});
  }catch(e){await this.commit(s);throw e;}
  if(!draft.state&&Buffer.byteLength(JSON.stringify(s),'utf8')>7*1024*1024)throw Object.assign(new Error('Reply storage capacity reached'),{code:'reply_capacity'});
  await this.commit(s);return this.launchReservedReply(draft,start);
 });}
 // 只为尚无任何记录的媒体身份选择更新的有效上下文。
 resolveUnattemptedMediaTarget(actor,eventId,idempotency,clock=Date.now,{requireChangedContext=true}={}){return this.locked(async()=>{this.check(actor);if(typeof idempotency!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(idempotency))throw new Error('Media identity unavailable');const key=createHash('sha256').update(idempotency).digest('hex'),queue=this.state.queue;for(const record of Object.values(queue?.records||{}))if((record.replies&&Object.hasOwn(record.replies,key))||(record.sendState&&record.idempotencyKey===idempotency))return null;const route=latestOwnerContext(queue,eventId,clock());if(!route.scopeVerified||!route.orderCertain||!route.hasNewer||(requireChangedContext&&!route.contextChanged))return null;return {eventId:route.eventId};});}
 // 仅在当前调用确定尚未开始网络请求时撤销预留。
 discardUnstartedReply(actor,eventId,idempotency,clientId){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state),key=createHash('sha256').update(idempotency).digest('hex'),r=s.queue?.records?.[eventId]?.replies?.[key];if(!r||r.state!=='uncertain'||r.clientId!==clientId)throw new Error('Unstarted reservation unavailable');delete s.queue.records[eventId].replies[key];for(const w of Object.values(s.replyWatchdog?.records||{}))if(w.replies[key]?.targetEventId===eventId){delete w.replies[key];if(!Object.keys(w.replies).length&&w.phase!=='upstream_accepted')w.phase='awaiting_reply';}await this.commit(s);});}
 replyRejected(actor,eventId,idempotency,now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state),r=s.queue.records[eventId],key=createHash('sha256').update(idempotency).digest('hex');if(!r?.event||r.replies?.[key]?.state!=='uncertain')throw new Error('Rejection marker unavailable');this.volatileRejected.add(eventId);r.contextRejected=true;await this.commit(s);});}
 replySent(actor,eventId,idempotency,now,{serverMessageId}={}){return this.locked(async()=>{
  this.check(actor);const s=structuredClone(this.state);markSent(s.queue,actor,eventId,idempotency,now);
  const record=s.queue.records[eventId],reply=record.replies[createHash('sha256').update(idempotency).digest('hex')],serverHash=hashServerMessageId(record.privateReplyContext?.accountScope,serverMessageId);
  if(serverHash){
   reply.serverMessageIdHash=serverHash;
   // A user can quote a delivered reply before its acknowledgement is stored.
   // Resolve already accepted, unexpired references under the same state lock;
   // do not replay webhooks, fetch history, extend TTL or change send evidence.
   for(const other of Object.values(s.queue.records))if(other?.event?.data?.quoted_context?.quotes.some(q=>q.message_id_hash===serverHash)&&other.privateReplyContext&&Number.isSafeInteger(other.textUntil)&&now<other.textUntil){
    const previous=other.event.data.quoted_context;
    other.event.data.quoted_context=bindQuotedContext(previous,s.queue.records,other.privateReplyContext,now,other.textUntil);
    // Late reference enrichment must not turn an accepted send into a failed
    // persistence operation because the optional copied quote exhausted space.
    if(Buffer.byteLength(JSON.stringify(s),'utf8')>7*1024*1024)other.event.data.quoted_context=previous;
   }
  }
  if(s.replyWatchdog)reconcileReplyWatches(s,actor,now);
  await this.commit(s);
 });}
 enqueueSync(actor,args,clock=Date.now){return this.locked(async()=>{
  this.check(actor);const s=structuredClone(this.state),now=clock();observeSubmissionCoverage(this.submissionCoverage,now);purge(s.queue,now);
  const result=enqueueSync(s,args,now);
  if(!result.duplicate){if(Buffer.byteLength(JSON.stringify(s),'utf8')>7*1024*1024)throw submissionError('sync_capacity');await this.commit(s);}
  const receipt=inspectSyncSubmission(result.duplicate?s:this.state,{sourceId:args.sourceId,role:args.role,contentDigest:contentDigest(args.text),sourceCreatedAt:args.sourceCreatedAt,sourceExpiresAt:args.sourceExpiresAt},clock(),this.submissionCoverage);
  if(!result.duplicate)try{this.syncDeliveryControl?.notifyQueued(actor)}catch{}
  return {...result,submission:receipt};
 });}
 getSyncSubmission(actor,args,clock=Date.now){return this.locked(()=>{this.check(actor);const now=clock();return {...inspectSyncSubmission(this.state,args,now,this.submissionCoverage),directAttemptCoverage:inspectDirectAttemptCoverage(this.directAttemptCoverage,args,now)};});}

 claimSync(actor,clock=Date.now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state),now=clock();purge(s.queue,now);const result=claimSync(s,now);if(result?.blocked)this.logSync({stage:'queue_blocked',syncId:result.syncId,reason:result.reason||'prior_attempt',sendStarted:false,historyCoverage:'incomplete'});else if(!result){const head=Object.values(s.syncOutbox?.records||{}).filter(r=>r.deliveryIntent!=='cancelled'&&!['sent','user_confirmed_received','expired'].includes(r.state)).sort((a,b)=>a.sequence-b.sequence)[0];if(head&&['uncertain','failed','inflight','queued'].includes(head.state))this.logSync({stage:'queue_blocked',syncId:head.syncId,reason:{uncertain:'uncertain_head',failed:'failed_head',inflight:'inflight_head',queued:'queued_part_unavailable'}[head.state],sendStarted:false,historyCoverage:'incomplete'});}if(result&&!result.waiting)await this.commit(s);return result;});}
 finishSync(actor,claim,result,clock=Date.now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state),ok=finishSync(s,claim,result,clock());if(ok)await this.commit(s);return ok;});}
 listSync(actor,options,clock=Date.now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state),result=listSync(s,options,clock());await this.commit(s);return result;});}
 listInboundDelivery(actor,options,clock=Date.now){return this.locked(async()=>{this.check(actor);return listInboundDelivery(this.state,options,clock());});}
 cancelQueuedSyncIntents(actor,options,clock=Date.now){return this.locked(async()=>{this.check(actor);const status=this.syncDeliveryControl?.status(actor);if(!status?.paused||status.inFlight||status.faulted||typeof options?.epoch!=='string'||options.epoch!==status.epoch)throw new Error('Sync pause unavailable');const s=structuredClone(this.state),result=cancelQueuedSyncIntents(s,options,clock());if(!result.duplicate)await this.commit(s);return result;});}
 // 仅供已持有桥接锁的进程内暂停门调用，避免两层恢复出现竞态。
 cancelUncertainSyncIntent(actor,options,clock=Date.now){return this.locked(async()=>{this.check(actor);const now=clock(),s=structuredClone(this.state);const result=cancelUncertainSyncIntent(s,options,now);await this.commit(s);return result;});}
 confirmSyncReceived(actor,args,clock=Date.now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state),result=confirmSyncReceived(s,args,clock());await this.commit(s);return result;});}
 retargetQueuedSync(actor,args,clock=Date.now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state),result=retargetQueuedSync(s,args,clock());await this.commit(s);return result;});}
 acknowledgeCoverageGap(actor,review,now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state);const result=acknowledgeCoverageGap(s,actor,review,now);await this.commit(s);return result;});}
 enableWatchdog(actor,now,options){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state);const changed=enableReplyWatchdog(s,actor,now,options);await this.commit(s);return {changed};});}
 watchdogStatus(actor,now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state);const result=replyWatchdogStatus(s,actor,now);await this.commit(s);return result;});}
 claimWatchdogAlert(actor,now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state);const result=claimWatchdogAlert(s,actor,now);await this.commit(s);return result;});}
 finishWatchdogAlert(actor,eventId,outcome,now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state);finishWatchdogAlert(s,actor,eventId,outcome,now);await this.commit(s);});}
 recoverWatchdogAlert(actor,now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state);recoverWatchdogAlert(s,actor,now);await this.commit(s);});}
 acknowledgeExpiredWatches(actor,count,now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state);const result=acknowledgeExpiredWatches(s,actor,count,now);await this.commit(s);return result;});}
 reviewUnsentWatchdogAlert(actor,eventId,now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state);reviewUnsentWatchdogAlert(s,actor,eventId,now);await this.commit(s);});}
 clean(actor,now){return this.locked(async()=>{this.check(actor);const s=structuredClone(this.state);purge(s.queue,now);cleanSync(s,now);if(s.replyWatchdog)reconcileReplyWatches(s,actor,now);for(const id of Object.keys(s.delivery))if(!s.queue.records[id]?.event)delete s.delivery[id];await this.commit(s);});}
}
