// Request/normalization only. No requests are sent by this module.
import {randomBytes} from 'node:crypto';
const ORIGIN='https://ilinkai.weixin.qq.com';
function headers(token){return {'Content-Type':'application/json',AuthorizationType:'ilink_bot_token','X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),'iLink-App-Id':'bot','iLink-App-ClientVersion':String((2<<16)|(4<<8)|10),...(token?{Authorization:'Bearer '+token}:{})};}
const baseInfo={channel_version:'2.4.10',bot_agent:'XiaodiWeixinBridge/0.1.0'};
const ID_KEYS=new Set(['message_id','msg_id','svr_id']);
const str=x=>typeof x==='string'&&x.length>0;
export function parseWire(text){if(typeof text!=='string'||Buffer.byteLength(text)>262144)throw new Error('Invalid response');return JSON.parse(text,(key,value,context)=>ID_KEYS.has(key)&&typeof value==='number'&&/^\d+$/.test(context?.source??'')?context.source:value);}
export function normalizeWire(raw,{allowedSender,accountScope,armedAt}={}){
 if(!str(allowedSender)||!str(accountScope)||!Number.isSafeInteger(armedAt))throw new Error('Explicit scope required');
 if(!raw||raw.from_user_id!==allowedSender||raw.to_user_id!==accountScope||(raw.group_id!==undefined&&raw.group_id!==null&&raw.group_id!=='')||raw.message_type!==1||raw.message_state!==2||!str(raw.message_id)||!str(raw.context_token)||!Number.isSafeInteger(raw.create_time_ms)||raw.create_time_ms<=armedAt)return null;
 if(!Array.isArray(raw.item_list)||raw.item_list.length===0)return null;
 const items=[];for(const i of raw.item_list){if(!i||i.type!==1||!i.text_item||typeof i.text_item.text!=='string'||i.voice_item||i.image_item||i.file_item||i.video_item||i.ref_msg||i.tool_call_start_item||i.tool_call_result_item||Object.keys(i.text_item).some(k=>k!=='text'))return null;items.push({type:1,text_item:{text:i.text_item.text}});}
 return {chatKind:'direct',textOrigin:'typed',group_id:'',from_user_id:raw.from_user_id,message_type:1,message_state:2,message_id:raw.message_id,context_token:raw.context_token,create_time_ms:raw.create_time_ms,item_list:items};
}
export function updatesRequest({token,cursor,bootstrap=false}){
 if(!str(token)||typeof cursor!=='string'||(!bootstrap&&!cursor))throw new Error('Bound session and cursor required');
 return {url:ORIGIN+'/ilink/bot/getupdates',options:{method:'POST',redirect:'error',headers:headers(token),body:JSON.stringify({get_updates_buf:cursor,base_info:baseInfo})}};
}
// Bootstrap processing never emits or persists any message body; it only yields the cursor.
export function baselineFromBatch(batch){if(!batch||(batch.ret!==undefined&&batch.ret!==0)||(batch.errcode!=null&&batch.errcode!==0)||!str(batch.get_updates_buf))throw new Error('Baseline unavailable');return batch.get_updates_buf;}

// Internal only: draft is resolved from stored accepted event, never from external recipient input.
export function replyRequest({token,eventId,draft}){if(!str(token)||!str(eventId)||!draft||!str(draft.to_user_id)||!str(draft.context_token)||typeof draft.text!=='string'||!draft.text.length||draft.text.length>2000||typeof draft.clientId!=='string'||!/^xiaodi:\d{1,16}-[0-9a-f]{8}$/.test(draft.clientId))throw new Error('Stored reply context and ID required');const client_id=draft.clientId;return {url:ORIGIN+'/ilink/bot/sendmessage',options:{method:'POST',redirect:'error',headers:headers(token),body:JSON.stringify({msg:{from_user_id:'',to_user_id:draft.to_user_id,client_id,message_type:2,message_state:2,context_token:draft.context_token,item_list:[{type:1,text_item:{text:draft.text}}]},base_info:baseInfo})}};}
