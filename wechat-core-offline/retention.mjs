import {createHash} from 'node:crypto';
// Pure offline queue model. Real integration must persist each transition atomically before side effects.
const TEXT_TTL=24*60*60*1000, DEDUPE_TTL=7*24*60*60*1000, MAX_RETAINED_EVENTS=1024;
const idOk=x=>typeof x==='string' && /^[A-Za-z0-9_-]{1,160}$/.test(x);
function requireOwner(state,actor){if(!actor || actor!==state.owner)throw new Error('Owner required');}
export function createQueue(owner){if(typeof owner!=='string'||!owner)throw new Error('Owner required');return {owner,records:Object.create(null)};}
export function purge(state,now){if(!Number.isSafeInteger(now))throw new Error('Invalid clock');for(const [id,r] of Object.entries(state.records)){if(now>=r.dedupeUntil){delete state.records[id];continue;}if(now>=r.textUntil){delete r.event;delete r.privateReplyContext;delete r.privateMediaContext;delete r.replyText;delete r.replies;}}}
export function enqueue(state,actor,event,privateReplyContext,now){requireOwner(state,actor);purge(state,now);
 if(!event||!idOk(event.eventId)||event.name!=='weixin.owner_text'||!event.data||Object.keys(event.data).sort().join(',')!=='conversation_id,message_id,simulation,text'||event.data.conversation_id!=='weixin-self'||event.data.simulation!==false||typeof event.data.text!=='string'||!event.data.text.length||event.data.text.length>2000||!idOk(event.data.message_id))throw new Error('Invalid event');
 if(!privateReplyContext||!privateReplyContext.to_user_id||!privateReplyContext.context_token)throw new Error('Reply context required');
 if(Object.hasOwn(state.records,event.eventId))return false;
 if(Object.values(state.records).filter(r=>r.event).length>=MAX_RETAINED_EVENTS||Object.keys(state.records).length>=4096)throw Object.assign(new Error('Queue limit reached'),{code:'inbound_capacity'});
 state.records[event.eventId]={event:structuredClone(event),privateReplyContext:structuredClone(privateReplyContext),textUntil:now+TEXT_TTL,dedupeUntil:now+DEDUPE_TTL,sendState:null};return true;
}
export function eventForDelivery(state,actor,eventId,now){requireOwner(state,actor);purge(state,now);const r=state.records[eventId];if(!r?.event)throw new Error('Event expired or unknown');return structuredClone(r.event);}
export function enqueueMedia(state,actor,event,privateReplyContext,privateMediaContext,now){requireOwner(state,actor);purge(state,now);if(!event||!idOk(event.eventId)||event.name!=='weixin.owner_media'||!event.data||Object.keys(event.data).sort().join(',')!=='conversation_id,file_name,media_kind,message_id,simulation'||event.data.conversation_id!=='weixin-self'||event.data.simulation!==false||!['image','file'].includes(event.data.media_kind)||typeof event.data.file_name!=='string'||!event.data.file_name||event.data.file_name.length>160||!idOk(event.data.message_id)||!privateReplyContext?.to_user_id||!privateReplyContext?.context_token||!privateMediaContext||privateMediaContext.mediaKind!==event.data.media_kind)throw new Error('Invalid media event');if(Object.hasOwn(state.records,event.eventId))return false;if(Object.values(state.records).filter(r=>r.event).length>=MAX_RETAINED_EVENTS||Object.keys(state.records).length>=4096)throw Object.assign(new Error('Queue limit reached'),{code:'inbound_capacity'});state.records[event.eventId]={event:structuredClone(event),privateReplyContext:structuredClone(privateReplyContext),privateMediaContext:structuredClone(privateMediaContext),textUntil:now+TEXT_TTL,dedupeUntil:now+DEDUPE_TTL,sendState:null};return true;}
const digest=x=>createHash('sha256').update(x,'utf8').digest('hex');
export function beginReply(state,actor,eventId,text,idempotencyKey,now,{syncPartId}={}){
 requireOwner(state,actor);purge(state,now);const r=state.records[eventId];
 if(!r?.event||!r.privateReplyContext)throw new Error('Unknown or expired event');
 if(!idOk(idempotencyKey)||typeof text!=='string'||!text.length||text.length>2000||!(syncPartId===undefined||/^[a-f0-9]{64}$/.test(syncPartId)))throw new Error('Invalid reply');
 // A legacy attempt has no payload digest: never reinterpret its original key, and
 // when its outcome is uncertain disallow new keys because equivalence is unknowable.
 if(r.sendState && (r.idempotencyKey===idempotencyKey || r.sendState!=='sent'))throw new Error('Legacy attempt cannot be retried');
 const key=digest(idempotencyKey),hash=digest(text);r.replies ||= Object.create(null);
 if(Object.hasOwn(r.replies,key)){const prior=r.replies[key];if(prior.hash!==hash||(syncPartId&&prior.syncPartId!==syncPartId))throw new Error('Idempotency key conflict');return {state:prior.state==='sent'?'sent':'uncertain'};}
 if(Object.values(r.replies).some(x=>x.hash===hash&&(!syncPartId||!x.syncPartId||x.syncPartId===syncPartId)))throw new Error('Reply already attempted under another key');
 // Match the public Tencent client's prefix:timestamp-eight-hex shape. The
 // upstream protocol does not publish a complete client_id length limit.
 // Persist before sending; never regenerate for an existing attempt.
 const used=new Set(Object.values(state.records).flatMap(record=>Object.values(record.replies||{}).map(reply=>reply.clientId).filter(Boolean)));
 let clientId;for(let salt=0;salt<1024;salt++){const suffix=digest(JSON.stringify([eventId,key,salt])).slice(0,8);const candidate=`xiaodi:${now}-${suffix}`;if(!used.has(candidate)){clientId=candidate;break;}}
 if(!clientId)throw new Error('Reply ID unavailable');
 // Preserve every newly attempted reply until the original event expires.
 // The bridge applies a total encrypted-state admission bound before commit.
 r.replies[key]={hash,state:'uncertain',attemptedAt:now,clientId,text,...(syncPartId?{syncPartId}:{})};
 return {to_user_id:r.privateReplyContext.to_user_id,context_token:r.privateReplyContext.context_token,text,clientId};
}
export function markSent(state,actor,eventId,idempotencyKey,now){
 requireOwner(state,actor);purge(state,now);const r=state.records[eventId],key=digest(idempotencyKey);
 if(!r?.replies||!Object.hasOwn(r.replies,key)||r.replies[key].state!=='uncertain')throw new Error('Invalid send state');
 r.replies[key].state='sent';r.replies[key].sentAt=now;
}
export function recentConversation(state,actor,now,{after=null,limit=50}={}){
 requireOwner(state,actor);purge(state,now);
 if(!Number.isInteger(limit)||limit<1||limit>50||!(after===null||typeof after==='string'&&after.length<=512))throw new Error('Invalid page');
 const rows=[];
 for(const [eventId,r] of Object.entries(state.records)){
  if(!r.event)continue;
  const at=r.textUntil-TEXT_TTL;
  rows.push({sort:`${String(at).padStart(16,'0')}:0:${eventId}`,source:'wechat',eventId,messageId:r.event.data.message_id,timestamp:r.event.timestamp,receivedAt:at,...(r.event.name==='weixin.owner_media'?{mediaKind:r.event.data.media_kind,fileName:r.event.data.file_name}:{text:r.event.data.text})});
  for(const [replyId,reply] of Object.entries(r.replies||{})){
   if(!Number.isSafeInteger(reply.attemptedAt))continue; // Existing attempts lack reliable timestamps.
   rows.push({sort:`${String(reply.attemptedAt).padStart(16,'0')}:1:${eventId}:${replyId}`,source:'bridge_reply',eventId,replyId,attemptedAt:reply.attemptedAt,state:reply.state,...(Number.isSafeInteger(reply.sentAt)?{sentAt:reply.sentAt}:{}),...(reply.kind==='media'?{mediaKind:reply.mediaKind,fileName:reply.fileName,mediaSha256:reply.mediaHash}:typeof reply.text==='string'?{text:reply.text}:{textUnavailable:true})});
  }
 }
 rows.sort((a,b)=>a.sort<b.sort?-1:a.sort>b.sort?1:0);const filtered=after===null?rows:rows.filter(r=>r.sort>after);const page=filtered.slice(0,limit);const nextCursor=filtered.length>page.length?page.at(-1).sort:null;
 return {entries:page.map(({sort,...row})=>row),nextCursor,resumeCursor:page.length?page.at(-1).sort:after,legacyRepliesOmitted:true};
}
