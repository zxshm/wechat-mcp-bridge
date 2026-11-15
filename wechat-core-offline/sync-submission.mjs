import {createHash,randomBytes} from 'node:crypto';

export const SUBMISSION_DAY=86400000;
const idOk=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(x);
const hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const roles=new Set(['user','assistant','progress']);
export function submissionError(code){return Object.assign(new Error(code==='sync_capacity'?'Sync storage capacity reached':'Sync submission unavailable'),{code});}
export function submissionIdentity({sourceId,role,contentDigest}){
 if(!idOk(sourceId)||!roles.has(role)||!hex(contentDigest))throw submissionError('invalid_submission');
 return createHash('sha256').update(JSON.stringify(['chatgpt',sourceId])).digest('hex');
}
export const contentDigest=text=>createHash('sha256').update(text,'utf8').digest('hex');

// Optional only for compatibility with the existing tool. New reliable callers
// must persist this pair before their first attempt and never change it.
export function submissionDeadline(args,now,{creating=false}={}){
 const {sourceCreatedAt,sourceExpiresAt}=args;
 if(sourceCreatedAt===undefined&&sourceExpiresAt===undefined)return null;
 if(!Number.isSafeInteger(now)||!Number.isSafeInteger(sourceCreatedAt)||sourceCreatedAt<0||!Number.isSafeInteger(sourceExpiresAt)||sourceExpiresAt<=sourceCreatedAt||sourceExpiresAt-sourceCreatedAt>SUBMISSION_DAY||sourceCreatedAt>now)throw submissionError('invalid_source_deadline');
 if(creating&&now>=sourceExpiresAt)throw submissionError('source_expired');
 return {sourceCreatedAt,sourceExpiresAt};
}

export function newSubmissionCoverage(now){
 if(!Number.isSafeInteger(now)||now<0)throw submissionError('invalid_submission_clock');
 return {epoch:randomBytes(16).toString('hex'),since:now,last:now,valid:true,revision:0};
}
export function observeSubmissionCoverage(coverage,now){
 if(!coverage)return;
 if(!Number.isSafeInteger(now)||now<coverage.last)coverage.valid=false;
 else coverage.last=now;
}
function coverageView(coverage,now,deadline,found){
 observeSubmissionCoverage(coverage,now);
 const base={scope:'single_writer_current_process',historyCoverage:'incomplete',snapshotOnly:true};
 if(coverage){base.epoch=coverage.epoch;base.since=coverage.since;base.observedAt=now;base.revision=coverage.revision;}
 if(found)return {...base,historyCoverage:'record_present',reason:'retained_record'};
 if(!coverage?.valid)return {...base,reason:'process_coverage_unavailable'};
 if(!deadline)return {...base,reason:'original_source_window_missing'};
 if(now>=deadline.sourceExpiresAt)return {...base,reason:'source_window_expired'};
 if(deadline.sourceCreatedAt<coverage.since)return {...base,reason:'source_predates_process_coverage'};
 // This is a serialized point-in-time absence, not a fence against a request
// still in transit. The enqueue path must recheck the same ID atomically.
 return {...base,historyCoverage:'complete_for_source_window',reason:'current_process_source_window'};
}
function nextAction(r){
 if(r.deliveryIntent==='cancelled')return 'stop_cancelled';
 if(['sent','user_confirmed_received'].includes(r.state))return 'stop_completed';
 if(r.state==='expired')return 'stop_expired';
 if(['uncertain','failed'].includes(r.state)||r.parts.some(p=>['uncertain','failed'].includes(p.state)))return 'review_delivery';
 return 'wait_existing_delivery';
}
export function inspectSyncSubmission(s,args,now,coverage){
 const syncId=submissionIdentity(args),deadline=submissionDeadline(args,now),r=s.syncOutbox?.records?.[syncId];
 const visible=r&&Number.isSafeInteger(r.dedupeUntil)&&now<r.dedupeUntil;
 if(!visible){
  const proof=coverageView(coverage,now,deadline,false),complete=proof.historyCoverage==='complete_for_source_window';
  return {syncId,status:complete?'not_recorded':'not_observed',coverage:proof,action:complete?'submit_same_identity':'review_submission',retrySendAllowed:false};
 }
 const proof=coverageView(coverage,now,deadline,true);
 if(r.digest!==args.contentDigest||r.role!==args.role)return {syncId,status:'identity_conflict',contentMatches:false,coverage:proof,action:'stop_conflict',retrySendAllowed:false};
 if(deadline&&r.sourceCreatedAt!==undefined&&(deadline.sourceCreatedAt!==r.sourceCreatedAt||deadline.sourceExpiresAt!==r.sourceExpiresAt))return {syncId,status:'identity_conflict',contentMatches:true,deadlineMatches:false,coverage:proof,action:'stop_conflict',retrySendAllowed:false};
 const row={...r,parts:r.parts.map(p=>({...p}))};
 if(now>=row.expiresAt){if(row.state==='queued')row.state='expired';else if(row.state==='inflight')row.state='uncertain';}
 return {syncId,status:'recorded',commitStatus:'confirmed',contentMatches:true,sequence:row.sequence,role:row.role,eventId:row.eventId,state:row.state,deliveryIntent:row.deliveryIntent==='cancelled'?'cancelled':'active',...(row.deliveryIntent==='cancelled'?{cancelledAt:row.cancelledAt}:{}),createdAt:row.createdAt,expiresAt:row.expiresAt,dedupeUntil:row.dedupeUntil,sourceWindow:row.sourceCreatedAt===undefined?{binding:'legacy_unbound'}:{binding:'fixed',sourceCreatedAt:row.sourceCreatedAt,sourceExpiresAt:row.sourceExpiresAt},parts:row.parts.map(({index,state})=>({index,state})),coverage:proof,action:nextAction(row),retrySendAllowed:false};
}

const preExecution=new Set(['invalid_submission','invalid_source_deadline','source_expired','source_identity_conflict','source_deadline_conflict','target_unavailable','sync_capacity','owner_context_unavailable']);
export function submissionFailure(error,syncId){
 if(error?.code==='state_save_not_committed')return {syncId,scope:'current_submission_invocation',status:'not_committed',commitStatus:'not_committed',code:'storage_write_failed',coverage:{historyCoverage:'incomplete'},action:'reconcile_before_submit',retrySendAllowed:false};
 if(preExecution.has(error?.code))return {syncId,scope:'current_submission_invocation',status:'rejected',commitStatus:'not_started',code:error.code,coverage:{historyCoverage:'incomplete'},action:'review_submission',retrySendAllowed:false};
 return {syncId,scope:'current_submission_invocation',status:'unknown',commitStatus:'unknown',code:error?.code==='state_storage_unavailable'?'storage_unavailable':'submission_commit_unknown',coverage:{historyCoverage:'incomplete'},action:'reconcile_before_submit',retrySendAllowed:false};
}
