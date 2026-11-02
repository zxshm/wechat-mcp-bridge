import {createHash} from 'node:crypto';
import {CONTEXT_NOTICE_SUFFIX,formatContextText} from './context-budget.mjs';

function matchesQueuedReply(reply,text){
  const digest=value=>createHash('sha256').update(value).digest('hex');
  if(typeof text!=='string')return false;
  if(reply.budgetIndex!==undefined){
    if(!Number.isSafeInteger(reply.budgetIndex)||reply.budgetIndex<1||reply.budgetIndex>9)return false;
    return reply.hash===digest(formatContextText(text,reply.budgetIndex,reply.budgetNotice===true));
  }
  return reply.hash===digest(text)||(reply.budgetNotice===true&&reply.hash===digest(text+CONTEXT_NOTICE_SUFFIX));
}

// Reply records expire with their events (normally within 24h); legacy or
// expired history may be missing. The longer event dedupe period is not a
// per-reply audit log. A missing match must never authorize a send.
export function summarizeReplyHistory(state, actor, idempotencyKey, now = Date.now()) {
  if (!state || !actor || state.owner !== actor || state.phase !== 'armed' ||
      typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(idempotencyKey) ||
      !Number.isSafeInteger(now)) throw new Error('History unavailable');
  const keyHash = createHash('sha256').update(idempotencyKey).digest('hex');
  const observed=[];
  for (const record of Object.values(state.queue?.records || {})) {
    const replyLive=Number.isSafeInteger(record.textUntil) && now < record.textUntil;
    const tombstoneLive=Number.isSafeInteger(record.dedupeUntil) && now < record.dedupeUntil;
    const entry=replyLive ? record.replies?.[keyHash] : undefined;
    if (entry) observed.push(entry.state === 'sent' ? 'upstream_accepted' : 'unknown');
    if ((replyLive || tombstoneLive) && record.sendState && record.idempotencyKey === idempotencyKey) observed.push('legacy');
  }
  const globalHistoryStatus=observed.length === 0 ? 'not_observed_in_retained_records' :
    observed.length > 1 ? 'multiple_or_conflicting_records' :
    observed[0] === 'upstream_accepted' ? 'recorded_upstream_accepted' :
    observed[0] === 'legacy' ? 'recorded_legacy_attempt' : 'recorded_unknown_attempt';
  return {globalHistoryStatus,historyCoverage:'incomplete',retainedAttemptCount:observed.length};
}

// Read-only projection. Absence is never evidence that a call was not executed.
export function lookupReplyStatus(state, actor, idempotencyKey, now = Date.now()) {
  if (!state || !actor || state.owner !== actor || state.phase !== 'armed' ||
      typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(idempotencyKey) ||
      !Number.isSafeInteger(now)) throw new Error('Status unavailable');
  const keyHash = createHash('sha256').update(idempotencyKey).digest('hex');
  const records = Object.values(state.queue?.records || {});
  const replies = records.flatMap(record => {
    if (!Number.isSafeInteger(record.textUntil) || now >= record.textUntil) return [];
    const reply = record.replies?.[keyHash];
    return reply ? [reply] : [];
  });
  const queued = Object.values(state.syncOutbox?.records || {}).flatMap(record => {
    if (!Number.isSafeInteger(record.expiresAt) || now >= record.expiresAt || !Array.isArray(record.parts)) return [];
    return record.parts.filter(part => part.key === idempotencyKey).map(part => ({record, part}));
  });
  // Multiple or conflicting observations cannot safely establish a result.
  if (replies.length > 1 || queued.length > 1) return {state:'unknown', retrySafe:false};
  const reply = replies[0], item = queued[0];
  if (reply && item && (!/^[a-f0-9]{64}$/.test(item.part.partId || '') || reply.syncPartId !== item.part.partId ||
      !matchesQueuedReply(reply,item.part.text)))
    return {state:'unknown', retrySafe:false};
  if (reply?.state === 'sent' && (!item || item.part.state !== 'user_confirmed_received'))
    return {state:'upstream_accepted', retrySafe:false, phoneDelivery:'unverified'};
  if (reply) return {state:'unknown', retrySafe:false};
  if (item?.part.state === 'user_confirmed_received')
    return {state:'user_confirmed_received', retrySafe:false};
  if (item?.record.state === 'queued' && item.part.state === 'queued' &&
      !records.some(r => r.sendState && (r.idempotencyKey === idempotencyKey || r.sendState !== 'sent')))
    // The queue has not claimed this part; older direct-send evidence may have
    // expired, so this cannot authorize an independent send or retry.
    return {state:'not_attempted_by_queue', retrySafe:false, queueManaged:true};
  return {state:'unknown', retrySafe:false};
}

export function registerReplyStatusTool(m, {z, owner, bridge, clock=Date.now}) {
  m.registerTool('get_wechat_reply_status', {
    description:'Read retained owner-only reply status by its stable idempotency key. Unknown or missing records do not prove non-delivery. Upstream acceptance does not establish phone delivery. Never automatically resend an unknown or accepted reply.',
    inputSchema:z.object({idempotencyKey:z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)}).strict(),
    annotations:{readOnlyHint:true, destructiveHint:false, openWorldHint:false}
  }, async ({idempotencyKey}) => {
    try {
      const active=typeof bridge==='function'?bridge():bridge;
      if (!active || active.owner!==owner || typeof active.locked!=='function') throw new Error('Status unavailable');
      // Serialize with durable queue transitions; an in-progress commit must not
      // be observed as an old queued state that is incorrectly called unattempted.
      const result=await active.locked(async()=>{
        const now=clock();
        return {...lookupReplyStatus(active.state,owner,idempotencyKey,now),
          ...summarizeReplyHistory(active.state,owner,idempotencyKey,now)};
      });
      return {content:[{type:'text',text:JSON.stringify(result)}]};
    } catch {
      return {content:[{type:'text',text:'Reply status unavailable.'}],isError:true};
    }
  });
}
