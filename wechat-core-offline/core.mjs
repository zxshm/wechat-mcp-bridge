// Offline pure logic adapted from the prior Windows bridge; no I/O or network.
import { createHash } from 'node:crypto';
const MAX_TEXT = 2000;
const safeId = value => typeof value === 'string' && value.length > 0;
const nonempty = value => value !== undefined && value !== null && value !== '';
const hashId = (scope, id) => createHash('sha256').update(JSON.stringify([scope,id])).digest('hex');
const own = (object,key) => Object.prototype.hasOwnProperty.call(object,key);

export function newState({ownerSubject, accountScope, allowFrom, armedAt, initialCursor}) {
 if (!safeId(ownerSubject) || !safeId(accountScope) || !Array.isArray(allowFrom) || allowFrom.length !== 1 || !safeId(allowFrom[0])) throw new Error('Explicit owner and exactly one allowed sender required');
 if (!Number.isSafeInteger(armedAt) || armedAt <= 0 || !safeId(initialCursor)) throw new Error('Explicit cutoff and established non-empty baseline cursor required');
 return {ownerSubject,accountScope,allowFrom:[...allowFrom],armedAt,cursor:initialCursor,records:Object.create(null)};
}
function owner(state,actor) { if (!safeId(actor) || actor !== state.ownerSubject) throw new Error('Owner authentication required'); }
function normalize(message,state) {
 if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
 // Adapter must positively identify a typed message; unknown or speech transcription fails closed.
 if (message.textOrigin !== 'typed' || message.chatKind !== 'direct' || nonempty(message.group_id) || message.from_user_id !== state.allowFrom[0]) return null;
 if (message.message_type !== 1 || message.message_state !== 2 || !safeId(message.message_id) || !safeId(message.context_token)) return null;
 if (!Number.isSafeInteger(message.create_time_ms) || message.create_time_ms <= state.armedAt) return null;
 if (!Array.isArray(message.item_list) || message.item_list.length === 0) return null;
 const text=[];
 for (const item of message.item_list) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || item.type !== 1 || Object.keys(item).some(k => !['type','text_item'].includes(k))) return null;
  const t=item.text_item;
  if (!t || typeof t !== 'object' || Array.isArray(t) || Object.keys(t).some(k => k !== 'text') || typeof t.text !== 'string') return null;
  text.push(t.text);
 }
 const joined=text.join('\n'); if (!joined.length || joined.length > MAX_TEXT) return null;
 const messageId=hashId(state.accountScope,message.message_id);
 return {event:{eventId:'weixin_'+messageId,name:'weixin.owner_text',timestamp:new Date(message.create_time_ms).toISOString(),data:{conversation_id:'weixin-self',message_id:messageId,text:joined,simulation:false}},context:{to_user_id:state.allowFrom[0],context_token:message.context_token,source_message_id:message.message_id,accountScope:state.accountScope}};
}
export function acceptBatch(state,actor,batch) {
 owner(state,actor);
 if (!safeId(state.cursor)) throw new Error('Baseline cursor missing; no history may be fetched');
 if (!batch || batch.ret !== 0 || (batch.errcode != null && batch.errcode !== 0) || !Array.isArray(batch.msgs) || typeof batch.get_updates_buf !== 'string' || !batch.get_updates_buf) throw new Error('Invalid update batch');
 const created=[];
 for (const m of batch.msgs) {
  const result=normalize(m,state);if(!result)continue;
  const id=result.event.eventId;
  if (own(state.records,id)) continue;
  state.records[id]={event:result.event,privateReplyContext:result.context,sendState:null};
  created.push(structuredClone(result.event));
 }
 state.cursor=batch.get_updates_buf;
 return created;
}
// Internal only: caller must derive actor from verified Access identity, never request body.
export function prepareReply(state,actor,eventId,text) {
 owner(state,actor);
 if (!safeId(eventId) || !own(state.records,eventId)) throw new Error('Unknown accepted event');
 const record=state.records[eventId];if(record.sendState)throw new Error('Reply already attempted or uncertain');
 if(typeof text!=='string' || !text.length || text.length>MAX_TEXT)throw new Error('Invalid reply text');
 const context=record.privateReplyContext;
 return {eventId,to_user_id:context.to_user_id,context_token:context.context_token,client_id:'reply_'+hashId(context.accountScope,context.source_message_id),text};
}
// Persistence must complete before a real external send; this pure marker makes the state transition explicit.
export function markSendAttempt(state,actor,eventId) {
 owner(state,actor);if(!own(state.records,eventId) || state.records[eventId].sendState)throw new Error('Invalid or repeated send');
 state.records[eventId].sendState='uncertain';
}
