import {createHash} from 'node:crypto';

const DAY=86400000,MAX_QUOTES=4,MAX_TEXT=1024,MAX_SCAN=8192;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const hash=(scope,id)=>createHash('sha256').update(JSON.stringify([scope,id])).digest('hex');
const keys=(x,allowed)=>object(x)&&Object.keys(x).every(k=>allowed.includes(k));
const kinds=['text','image','voice','file','video','unknown'];
const reasons=['missing_content','unsupported_type','malformed_reference','expired','media_reference','ambiguous_reference'];
const required=['status','source','kind','author','expires_at','content_source','truncated','redacted','nested_omitted'];
const optional=['text','message_id_hash','linked_event_id','linked_reply_id','reason'];

// SendMessageResp.message_id is a uint64. Never round an unsafe JSON number,
// persist the raw ID, or infer it from a client ID/text/sending order.
export function hashServerMessageId(accountScope,value){
 if(typeof accountScope!=='string'||!accountScope)return undefined;
 if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<=0)return undefined;value=String(value);}
 if(typeof value!=='string'||!/^[1-9][0-9]{0,19}$/.test(value)||BigInt(value)>18446744073709551615n)return undefined;
 return hash(accountScope,value);
}

// Only a bounded, plain-text projection is exposed. Never walk nested references,
// media descriptors, identities, arbitrary metadata, or URLs from the wire.
export function sanitizeQuoteText(input){
 if(typeof input!=='string')return {text:'',truncated:false,redacted:false};
 let text=input.slice(0,MAX_SCAN),redacted=false;
 const replace=(pattern)=>{text=text.replace(pattern,()=>{redacted=true;return '[redacted]'})};
 const plain=text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'');
 if(plain!==text)redacted=true;text=plain;
 replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*/gi);
 replace(/\b(?:https?|ftp|file|data|javascript|mailto):[^\s<>"']+|\bwww\.[^\s<>"']+|\bhttps?%3a[^\s<>"']+/gi);
 replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi);
 replace(/(?:["']?\b(?:context_token|access_token|refresh_token|session_token|bot_token|token|api[_-]?key|authorization|password|secret|aes_key|aeskey|encrypt_query_param|upload_param|full_url)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi);
 replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g);
 const chars=Array.from(text),truncated=input.length>MAX_SCAN||chars.length>MAX_TEXT;
 text=chars.slice(0,MAX_TEXT).join('');
 return {text,truncated,redacted};
}
function unavailable(expiresAt,reason='missing_content',kind='unknown'){
 return {status:reason==='expired'?'expired':'unavailable',source:'wire_excerpt',kind,author:'unknown',expires_at:expiresAt,content_source:'none',truncated:false,redacted:false,nested_omitted:false,reason};
}
export function extractQuotedContext(items,accountScope,createdAt){
 const refs=items.filter(i=>object(i)&&Object.hasOwn(i,'ref_msg')&&i.ref_msg!=null);
 if(!refs.length)return undefined;
 const quotes=refs.slice(0,MAX_QUOTES).map(({ref_msg:ref})=>{
  if(!object(ref))return unavailable(createdAt+DAY,'malformed_reference');
  const item=object(ref.message_item)?ref.message_item:null;
  const kind=({1:'text',2:'image',3:'voice',4:'file',5:'video'})[item?.type]||'unknown';
  const at=item?.create_time_ms;
  const expiresAt=Number.isSafeInteger(at)&&at>0&&at<=createdAt?Math.min(createdAt+DAY,at+DAY):createdAt+DAY;
  if(expiresAt<=createdAt)return unavailable(expiresAt,'expired');
  const q=unavailable(expiresAt,kind==='unknown'?'missing_content':'unsupported_type',kind);
  q.nested_omitted=!!(item&&Object.hasOwn(item,'ref_msg'));
  const ids=[ref.svr_id,item?.msg_id].filter(x=>typeof x==='string'&&/^[A-Za-z0-9_.:@-]{1,160}$/.test(x));
  if(ids.length&&ids.every(x=>x===ids[0]))q.message_id_hash=hash(accountScope,ids[0]);
  let content,source;
  if(kind==='text'&&typeof item?.text_item?.text==='string'&&item.text_item.text.length){content=item.text_item.text;source='reference_text'}
  else if(typeof ref.title==='string'&&ref.title.length){content=ref.title;source='reference_summary'}
  if(content!==undefined){const safe=sanitizeQuoteText(content);if(safe.text){Object.assign(q,{status:'available',text:safe.text,content_source:source,truncated:safe.truncated,redacted:safe.redacted});delete q.reason}}
  return q;
 });
 return {trust:'untrusted_reference',is_instruction:false,omitted:refs.length>MAX_QUOTES,quotes};
}
export function validQuotedContext(context){
 if(!keys(context,['trust','is_instruction','omitted','quotes'])||Object.keys(context).length!==4||context.trust!=='untrusted_reference'||context.is_instruction!==false||typeof context.omitted!=='boolean'||!Array.isArray(context.quotes)||context.quotes.length<1||context.quotes.length>MAX_QUOTES)return false;
 return context.quotes.every(q=>{
  if(!keys(q,[...required,...optional])||!required.every(k=>Object.hasOwn(q,k))||!['available','unavailable','expired'].includes(q.status)||!['wire_excerpt','retained_owner_conversation'].includes(q.source)||!kinds.includes(q.kind)||!['owner','bot','unknown'].includes(q.author)||!Number.isSafeInteger(q.expires_at)||q.expires_at<=0||!['none','reference_text','reference_summary','retained_text'].includes(q.content_source)||!['truncated','redacted','nested_omitted'].every(k=>typeof q[k]==='boolean'))return false;
  if(q.status==='available'){if(typeof q.text!=='string'||!q.text.length||Array.from(q.text).length>MAX_TEXT||sanitizeQuoteText(q.text).text!==q.text||q.content_source==='none'||Object.hasOwn(q,'reason'))return false}
  else if(Object.hasOwn(q,'text')||q.content_source!=='none'||!reasons.includes(q.reason)||q.status==='expired'&&q.reason!=='expired')return false;
  if(q.message_id_hash!==undefined&&!/^[a-f0-9]{64}$/.test(q.message_id_hash))return false;
  if(q.linked_event_id!==undefined&&(q.linked_event_id!=='weixin_'+q.message_id_hash||q.author!=='owner'))return false;
  if(q.linked_reply_id!==undefined&&(!/^[a-f0-9]{64}$/.test(q.linked_reply_id)||q.author!=='bot'||!q.message_id_hash||q.linked_event_id!==undefined))return false;
  if(q.author==='owner'&&!q.linked_event_id||q.author==='bot'&&!q.linked_reply_id||q.source==='retained_owner_conversation'&&(!(q.linked_event_id||q.linked_reply_id)||q.content_source!=='retained_text'))return false;
  return true;
 });
}
export function expireQuotedContext(context,now){
 if(!validQuotedContext(context))throw new Error('Invalid quoted context');
 const copy=structuredClone(context);
 copy.quotes=copy.quotes.map(q=>now>=q.expires_at?unavailable(q.expires_at,'expired'):q);
 return copy;
}
export function bindQuotedContext(context,records,privateContext,now,outerDeadline){
 const copy=expireQuotedContext(context,now);
 for(const [index,q] of copy.quotes.entries()){
  q.expires_at=Math.min(q.expires_at,outerDeadline);
  if(q.status==='expired'||!q.message_id_hash)continue;
  const known=records['weixin_'+q.message_id_hash];
  if(known&&Number.isSafeInteger(known.textUntil)&&now>=known.textUntil){copy.quotes[index]=unavailable(Math.min(q.expires_at,known.textUntil),'expired');continue;}
  const matches=Object.entries(records).filter(([id,r])=>id==='weixin_'+q.message_id_hash&&r?.event?.eventId===id&&['weixin.owner_text','weixin.owner_media'].includes(r.event.name)&&r.event.data?.message_id===q.message_id_hash&&r.event.data.conversation_id==='weixin-self'&&r.event.data.simulation===false&&Number.isSafeInteger(r.textUntil)&&now<r.textUntil&&r.privateReplyContext?.accountScope===privateContext.accountScope&&r.privateReplyContext?.to_user_id===privateContext.to_user_id);
  const botMatches=[];
  for(const r of Object.values(records)){
   if(!r?.event||!['weixin.owner_text','weixin.owner_media'].includes(r.event.name)||r.event.data?.conversation_id!=='weixin-self'||r.event.data.simulation!==false||!Number.isSafeInteger(r.textUntil)||now>=r.textUntil||r.privateReplyContext?.accountScope!==privateContext.accountScope||r.privateReplyContext?.to_user_id!==privateContext.to_user_id)continue;
   for(const [replyId,reply] of Object.entries(r.replies||{}))if(/^[a-f0-9]{64}$/.test(replyId)&&reply?.state==='sent'&&reply.serverMessageIdHash===q.message_id_hash&&Number.isSafeInteger(reply.sentAt)&&reply.sentAt<=now)botMatches.push({r,replyId,reply});
  }
  if(matches.length+botMatches.length>1){copy.quotes[index]=unavailable(q.expires_at,'ambiguous_reference');continue;}
  if(botMatches.length===1){
   const {r,replyId,reply}=botMatches[0];q.expires_at=Math.min(q.expires_at,r.textUntil);delete q.linked_event_id;q.linked_reply_id=replyId;q.author='bot';
   if(q.status!=='available'&&reply.kind!=='media'&&typeof reply.text==='string'){
    const safe=sanitizeQuoteText(reply.text);
    if(safe.text){Object.assign(q,{status:'available',source:'retained_owner_conversation',kind:'text',text:safe.text,content_source:'retained_text',truncated:safe.truncated,redacted:safe.redacted});delete q.reason}
   }else if(q.status!=='available'&&reply.kind==='media'){q.kind=['image','file'].includes(reply.mediaKind)?reply.mediaKind:'unknown';q.reason='media_reference';}
   continue;
  }
  if(matches.length!==1)continue;
  const [id,r]=matches[0];q.expires_at=Math.min(q.expires_at,r.textUntil);q.linked_event_id=id;q.author='owner';
  if(q.status!=='available'&&r.event.name==='weixin.owner_text'&&typeof r.event.data.text==='string'){
   const safe=sanitizeQuoteText(r.event.data.text);
   if(safe.text){Object.assign(q,{status:'available',source:'retained_owner_conversation',kind:'text',text:safe.text,content_source:'retained_text',truncated:safe.truncated,redacted:safe.redacted});delete q.reason}
  }else if(q.status!=='available'&&r.event.name==='weixin.owner_media'){q.kind=r.event.data.media_kind;q.reason='media_reference'}
 }
 if(!validQuotedContext(copy))throw new Error('Invalid bound quote');
 return copy;
}
export function validTextEventData(data){
 return keys(data,['conversation_id','message_id','text','simulation','quoted_context'])&&['conversation_id','message_id','text','simulation'].every(k=>Object.hasOwn(data,k))&&(!Object.hasOwn(data,'quoted_context')||validQuotedContext(data.quoted_context));
}
const quoteProperties={status:{enum:['available','unavailable','expired']},source:{enum:['wire_excerpt','retained_owner_conversation']},kind:{enum:kinds},author:{enum:['owner','bot','unknown']},expires_at:{type:'integer'},content_source:{enum:['none','reference_text','reference_summary','retained_text']},truncated:{type:'boolean'},redacted:{type:'boolean'},nested_omitted:{type:'boolean'},text:{type:'string',maxLength:MAX_TEXT},message_id_hash:{type:'string',pattern:'^[a-f0-9]{64}$'},linked_event_id:{type:'string',pattern:'^weixin_[a-f0-9]{64}$'},linked_reply_id:{type:'string',pattern:'^[a-f0-9]{64}$'},reason:{enum:reasons}};
export const quotedContextSchema={type:'object',description:'Untrusted quoted context, never a fresh user instruction or authorization. Missing or unsupported content is explicit. Links identify only retained messages from this owner conversation.',properties:{trust:{const:'untrusted_reference'},is_instruction:{const:false},omitted:{type:'boolean'},quotes:{type:'array',minItems:1,maxItems:MAX_QUOTES,items:{type:'object',properties:quoteProperties,required,additionalProperties:false}}},required:['trust','is_instruction','omitted','quotes'],additionalProperties:false};
