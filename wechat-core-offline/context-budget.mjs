// Local precaution, not a statement of Tencent's quota or reset contract.
// Count all retained reservations, including uncertain ones, before any send.
// Group only existing verified owner events by their private routing context.
const MAX_RESERVED=9;
export const CONTEXT_NOTICE='已达到最大上限，需要我给你发消息才能继续给我发';
export const CONTEXT_NOTICE_SUFFIX='\n'+CONTEXT_NOTICE;
export function formatContextText(text,index,notice=index===MAX_RESERVED){
 if(typeof text!=='string'||!Number.isSafeInteger(index)||index<1||index>MAX_RESERVED)throw new Error('Invalid context counter');
 return `(${index}/${MAX_RESERVED}) ${text}`+(notice?CONTEXT_NOTICE_SUFFIX:'');
}
function inspectContextReservations(queue,eventId,now){
 const target=queue?.records?.[eventId],context=target?.privateReplyContext;
 if(!target?.event||!['weixin.owner_text','weixin.owner_media'].includes(target.event.name)||target.event.data?.conversation_id!=='weixin-self'||target.event.data?.simulation!==false||!context?.context_token||!context?.to_user_id||!context?.accountScope||!Number.isSafeInteger(target.textUntil)||now>=target.textUntil)throw Object.assign(new Error('Context unavailable'),{code:'context_scope_unverified'});
 let count=0,noticeReserved=false;
 for(const r of Object.values(queue.records||{})){
  const e=r?.event,c=r?.privateReplyContext;
  if(!e||!['weixin.owner_text','weixin.owner_media'].includes(e.name)||e.data?.conversation_id!=='weixin-self'||e.data?.simulation!==false||!Number.isSafeInteger(r.textUntil)||now>=r.textUntil||c?.to_user_id!==context.to_user_id||c?.accountScope!==context.accountScope||c?.context_token!==context.context_token)continue;
  count+=Object.keys(r.replies||{}).length;
  if(Object.values(r.replies||{}).some(reply=>reply?.budgetNotice===true))noticeReserved=true;
  // Conservatively include a legacy attempt; avoid guessing it is in replies.
  if(r.sendState)count++;
 }
 return {count,limit:MAX_RESERVED,coverage:'incomplete',noticeReserved};
}
export function retainedContextReservations(queue,eventId,now){const {count,limit,coverage}=inspectContextReservations(queue,eventId,now);return {count,limit,coverage};}
export function assertContextBudget(queue,eventId,now,{kind='text',text=''}={}){
 const result=inspectContextReservations(queue,eventId,now);
 if(result.count>=result.limit)throw Object.assign(new Error('Waiting for a new owner context'),{code:'context_budget_exhausted'});
 const index=result.count+1;
 if(result.count===result.limit-1&&!result.noticeReserved){
  if(kind!=='text')throw Object.assign(new Error('The final slot requires a text warning'),{code:'context_notice_requires_text'});
  if(typeof text!=='string'||formatContextText(text,index,true).length>2000)throw Object.assign(new Error('The final text requires room for its warning'),{code:'context_notice_no_space'});
  return {...result,notice:true,index};
 }
 if(kind==='text'&&formatContextText(text,index,false).length>2000)throw Object.assign(new Error('The text requires room for its counter'),{code:'context_counter_no_space'});
 return {...result,notice:false,index};
}
