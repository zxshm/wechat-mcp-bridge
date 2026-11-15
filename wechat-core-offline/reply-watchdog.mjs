import {createHash} from 'node:crypto';

// Pure state transitions. The bridge must persist the same cloned state before
// performing any side effect. No network, credentials, message text, or timers.
export const WATCHDOG_EVENT = 'weixin.reply_overdue';
const DAY = 86400000, WINDOW = 600000;
const idOk = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
export function validateWatchPurpose(purpose = 'final', nextUpdateAt, now, expiresAt) {
  if (!['final', 'progress'].includes(purpose)) throw new Error('Invalid reply purpose');
  if (purpose === 'progress' && (!Number.isSafeInteger(nextUpdateAt) ||
      nextUpdateAt <= now || nextUpdateAt >= expiresAt))
    throw new Error('Progress deadline must be within the original reference expiry');
  if (purpose === 'final' && nextUpdateAt !== undefined) throw new Error('Final reply has no progress deadline');
}
function time(now) { if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid clock'); }
function authorized(s, actor) {
  if (!actor || s?.owner !== actor || s.phase !== 'armed') throw new Error('Owner authorization required');
}
function active(s, actor, now) {
  authorized(s, actor); time(now);
  if (s.replyWatchdog?.version !== 1) throw new Error('Watchdog not enabled');
  return s.replyWatchdog;
}

export function enableReplyWatchdog(s, actor, now, {ackTimeoutMs = 120000} = {}) {
  authorized(s, actor); time(now);
  if (!Number.isSafeInteger(ackTimeoutMs) || ackTimeoutMs < 1000 || ackTimeoutMs > WINDOW)
    throw new Error('Invalid acknowledgment timeout');
  if (s.replyWatchdog) return false; // Never reset the activation boundary or ledger.
  s.replyWatchdog = {version: 1, activatedAt: now, ackTimeoutMs, records: {},
    notification: null, expiredUnresolved: 0};
  return true;
}

// Call only for IDs newly admitted by authenticated ingest, in that same commit.
// Existing retained records must not be swept in or assumed to have no reply.
export function registerReplyWatch(s, actor, eventId, now) {
  const w = reconcileReplyWatches(s, actor, now), r = s.queue?.records?.[eventId], e = r?.event;
  if (!idOk(eventId) || !e || e.eventId !== eventId || e.data?.simulation !== false ||
      e.data.conversation_id !== 'weixin-self' ||
      !['weixin.owner_text', 'weixin.owner_media'].includes(e.name) ||
      e.name === 'weixin.owner_media' && !['image', 'file'].includes(e.data.media_kind) ||
      !Number.isSafeInteger(r.textUntil) || r.textUntil <= now || r.textUntil > now + DAY ||
      now < w.activatedAt) throw new Error('Invalid newly accepted owner event');
  if (Object.hasOwn(w.records, eventId)) return false;
  if (Object.keys(w.records).length >= 128) {
    // Monitoring must never reject an otherwise valid inbound event. Retain only
    // a bounded aggregate; no dropped event IDs, body, or extended references.
    w.coverageGapCount=Math.min(Number.MAX_SAFE_INTEGER,(w.coverageGapCount||0)+1);
    w.coverageGapRevision=hash(JSON.stringify([w.coverageGapRevision||null,eventId,now]));
    return false;
  }
  w.records[eventId] = {receivedAt: now, expiresAt: r.textUntil,
    dueAt: Math.min(now + w.ackTimeoutMs, r.textUntil), phase: 'awaiting_reply',
    replies: {}};
  return true;
}

// This binds intent to the actual persisted draft, not to text supplied by a
// webhook or a tool receipt. Context use by an unrelated ChatGPT sync is ignored.
export function recordWatchReply(s, actor, eventId, idempotencyKey, now,
  {purpose = 'final', nextUpdateAt, obligationEventId = eventId} = {}) {
  const w = active(s, actor, now), watch = w.records[obligationEventId];
  if (!watch) return false;
  if (!idOk(obligationEventId) || !s.queue?.records?.[obligationEventId]?.event)
    throw new Error('Original obligation unavailable');
  const key = idOk(idempotencyKey) ? hash(idempotencyKey) : null;
  const reply = key && s.queue?.records?.[eventId]?.replies?.[key];
  if (!reply || !['uncertain', 'sent'].includes(reply.state) || now >= watch.expiresAt)
    throw new Error('Persisted reply draft required');
  if (reply.syncPartId) return false;
  validateWatchPurpose(purpose, nextUpdateAt, now, watch.expiresAt);
  if (Object.entries(w.records).some(([otherId,other]) => otherId !== obligationEventId &&
      other.replies[key]?.targetEventId === eventId))
    throw new Error('Reply receipt already belongs to another obligation');
  const prior = watch.replies[key];
  if (prior) {
    if (prior.purpose !== purpose || prior.nextUpdateAt !== nextUpdateAt || prior.targetEventId !== eventId)
      throw new Error('Watch intent conflict');
    return false;
  }
  // An accepted final closes the obligation; unrelated later replies cannot
  // reopen it. Long tasks must use progress purpose on their first response.
  if (watch.phase === 'upstream_accepted') return false;
  watch.replies[key] = {purpose, targetEventId:eventId, ...(purpose === 'progress' ? {nextUpdateAt} : {})};
  return true;
}

export function reconcileReplyWatches(s, actor, now) {
  const w = active(s, actor, now);
  for (const [eventId, watch] of Object.entries(w.records)) {
    if (now >= watch.expiresAt) {
      if (watch.phase !== 'upstream_accepted') w.expiredUnresolved++;
      delete w.records[eventId]; // No event reference survives its original TTL.
      continue;
    }
    if (watch.phase === 'upstream_accepted') continue;
    const record = s.queue?.records?.[eventId];
    if (!record?.event) { watch.phase = 'history_unavailable'; continue; }
    const accepted = Object.entries(watch.replies)
      .filter(([key,intent]) => s.queue?.records?.[intent.targetEventId]?.replies?.[key]?.state === 'sent');
    if (accepted.some(([, intent]) => intent.purpose === 'final')) {
      watch.phase = 'upstream_accepted';
      watch.phoneDelivery = 'unverified';
      continue;
    }
    const progress = accepted.filter(([, intent]) => intent.purpose === 'progress');
    if (progress.length) {
      watch.phase = 'in_progress';
      watch.dueAt = Math.max(...progress.map(([, intent]) => intent.nextUpdateAt));
    } else if (Object.keys(watch.replies).length) watch.phase = 'reply_uncertain';
    else if (record.sendState || Object.keys(record.replies || {}).length)
      // Do not mistake an unlinked/legacy/unrelated send for fulfillment.
      watch.phase = 'unlinked_attempt';
  }
  return w;
}

export function replyWatchdogStatus(s, actor, now) {
  const w = reconcileReplyWatches(s, actor, now);
  const pending = Object.entries(w.records).filter(([, r]) => r.phase !== 'upstream_accepted');
  const overdue = pending.filter(([, r]) => now >= r.dueAt);
  const stages = [...new Set([...overdue.map(([, r]) => r.phase),...(w.coverageGapCount?['history_unavailable']:[])])].sort();
  return {activatedAt: w.activatedAt, pendingCount: pending.length,
    overdueCount: overdue.length, expiredUnresolved: w.expiredUnresolved, stages,
    coverageGapCount:w.coverageGapCount||0, coverageGapRevision:w.coverageGapRevision||null, phoneDelivery: 'unverified',
    coverage: 'only_new_events_registered_after_activation',
    notificationState: w.notification?.state || 'none'};
}

// Aggregated low-sensitivity event: no text, event IDs, tokens, URLs, or secrets.
// A single notification in flight/unknown blocks further notifications until
// reviewed. Never regenerate a key to bypass an uncertain dispatch.
export function claimWatchdogAlert(s, actor, now) {
  const status = replyWatchdogStatus(s, actor, now), w = s.replyWatchdog;
  if (!status.overdueCount && !status.expiredUnresolved && !status.coverageGapCount) return null;
  if (w.notification && !['accepted','reviewed_not_sent'].includes(w.notification.state)) return null;
  const window = Math.floor(now / WINDOW);
  if (w.notification?.window >= window) return null;
  const fingerprint = hash(JSON.stringify([status.overdueCount, status.expiredUnresolved, status.stages, status.coverageGapCount]));
  const changed = w.notification?.fingerprint !== fingerprint;
  const eventId = 'watchdog_' + hash(JSON.stringify([w.activatedAt, window]));
  const claim = {eventId, name: WATCHDOG_EVENT, timestamp: new Date(now).toISOString(),
    data: {checkedAt: new Date(now).toISOString(), overdueCount: status.overdueCount,
      expiredUnresolved: status.expiredUnresolved, stages: status.stages, changed,
      simulation: false}};
  w.notification = {eventId, window, fingerprint, state: 'claimed'};
  return claim;
}

export function finishWatchdogAlert(s, actor, eventId, outcome, now) {
  const w = active(s, actor, now), n = w.notification;
  if (!n || n.eventId !== eventId || n.state !== 'claimed' ||
      !['accepted', 'failed', 'uncertain'].includes(outcome)) throw new Error('Invalid alert outcome');
  n.state = outcome;
}

export function recoverWatchdogAlert(s, actor, now) {
  const w = active(s, actor, now);
  if (w.notification?.state === 'claimed') w.notification.state = 'uncertain';
}

// Review operations change only alert accounting, never delivery facts. They
// must not be exposed as automatic retry/recovery and are not called by runtime.
export function acknowledgeExpiredWatches(s, actor, expectedCount, now) {
  const w = reconcileReplyWatches(s, actor, now);
  if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0 || expectedCount !== w.expiredUnresolved)
    throw new Error('Expired review changed; inspect again');
  w.expiredUnresolved=0;
  return {acknowledged:expectedCount, delivery:'unknown', resent:false};
}
export function reviewUnsentWatchdogAlert(s, actor, eventId, now) {
  const w=active(s,actor,now),n=w.notification;
  if(!n||n.eventId!==eventId||n.state!=='failed')throw new Error('Only confirmed not-accepted alerts may be reviewed');
  n.state='reviewed_not_sent';
}

// Explicit local operator review only: no MCP exposure or automatic invocation.
// Exact revision guard prevents acknowledging newly missed admissions unseen by reviewer.
export function acknowledgeCoverageGap(s,actor,{expectedCount,expectedRevision},now){
 const w=active(s,actor,now);
 if(!Number.isSafeInteger(expectedCount)||expectedCount<=0||expectedCount!==w.coverageGapCount||typeof expectedRevision!=='string'||expectedRevision!==w.coverageGapRevision)throw new Error('Coverage review changed; inspect again');
 w.coverageGapCount=0;delete w.coverageGapRevision;
 return {acknowledged:expectedCount,delivery:'unknown',resent:false};
}
