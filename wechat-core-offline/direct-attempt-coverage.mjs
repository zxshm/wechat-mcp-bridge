import {randomBytes} from 'node:crypto';

const DAY=86400000;
// 保存本进程固定时间窗内的直发尝试及回复关联元数据，不保存正文或密钥。
export function newDirectAttemptCoverage(now,{maxEntries=4096}={}){
 if(!Number.isSafeInteger(now)||now<0||!Number.isInteger(maxEntries)||maxEntries<1)throw Error('invalid_coverage_clock');
 return {epoch:randomBytes(16).toString('hex'),since:now,last:now,valid:true,maxEntries,attempts:[]};
}
function observe(coverage,now){
 if(!coverage)return false;
 if(!Number.isSafeInteger(now)||now<coverage.last){coverage.valid=false;return false;}
 coverage.last=now;
 coverage.attempts=coverage.attempts.filter(item=>(typeof item==='number'?item:item.attemptedAt)>now-DAY);
 return coverage.valid;
}
export function recordDirectAttempt(coverage,now,identity){
 if(!observe(coverage,now))return;
 if(coverage.attempts.length>=coverage.maxEntries){coverage.valid=false;return;}
 // 在持久预占之前记录，失败也保守计数，绝不把“可能尝试”变成“没有尝试”。
 const validIdentity=identity&&typeof identity.eventId==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(identity.eventId)&&typeof identity.replyId==='string'&&/^[a-f0-9]{64}$/.test(identity.replyId)&&typeof identity.contentDigest==='string'&&/^[a-f0-9]{64}$/.test(identity.contentDigest);
 coverage.attempts.push(validIdentity?{attemptedAt:now,eventId:identity.eventId,replyId:identity.replyId,contentDigest:identity.contentDigest}:now);
}
export function inspectDirectAttemptCoverage(coverage,{sourceCreatedAt,sourceExpiresAt},now){
 const valid=observe(coverage,now);
 const base={scope:'single_writer_current_process_direct_text',snapshotOnly:true,historyCoverage:'incomplete',retrySendAllowed:false};
 if(coverage)Object.assign(base,{epoch:coverage.epoch,since:coverage.since,observedAt:now});
 if(!valid)return {...base,reason:'coverage_unavailable'};
 if(!Number.isSafeInteger(sourceCreatedAt)||sourceCreatedAt<0||!Number.isSafeInteger(sourceExpiresAt)||sourceExpiresAt<=sourceCreatedAt||sourceExpiresAt-sourceCreatedAt>DAY||sourceCreatedAt>now)return {...base,reason:'original_source_window_invalid'};
 if(now>=sourceExpiresAt)return {...base,reason:'source_window_expired'};
 if(sourceCreatedAt<coverage.since)return {...base,reason:'source_predates_process_coverage'};
 const matching=coverage.attempts.filter(item=>{const at=typeof item==='number'?item:item.attemptedAt;return at>=sourceCreatedAt&&at<=now});
 const reservationCount=matching.length,limit=128;
 // 旧记录不补造关联；截断与缺口均明确返回。关联证明尝试身份，不证明发送成功或重试资格。
 const reservations=matching.slice(0,limit).map(item=>typeof item==='number'?{attemptedAt:item,identityAvailable:false}:{...item,identityAvailable:true});
 return {...base,historyCoverage:'complete_for_source_window',reservationCount,status:reservationCount?'observed_needs_review':'none_observed',reason:'all_direct_text_reservations_in_window',absenceProvesNeverSent:false,reservations,attributionComplete:matching.length<=limit&&matching.every(item=>typeof item!=='number'),hasMore:matching.length>limit,attributionMeaning:'attempt_identity_not_send_result'};
}
