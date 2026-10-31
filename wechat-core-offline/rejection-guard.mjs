// The marker contains no context secret; the token stays in the existing 24-hour private record.
export function isRejectedContext(queue,eventId,now,volatile=new Set()){
 const target=queue?.records?.[eventId], c=target?.privateReplyContext;
 if(!target?.event||!c?.to_user_id||!c?.accountScope||!c?.context_token||now>=target.textUntil)return false;
 return Object.entries(queue.records||{}).some(([id,r])=>{const x=r.privateReplyContext;return r.event&&now<r.textUntil&&(r.contextRejected||volatile.has(id))&&x?.to_user_id===c.to_user_id&&x?.accountScope===c.accountScope&&x?.context_token===c.context_token;});
}
export function rejectedContextError(){return Object.assign(new Error('Owner context was rejected upstream'),{code:'upstream_context_rejected'});}
