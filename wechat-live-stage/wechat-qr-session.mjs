import {randomBytes} from 'node:crypto';
const ORIGIN='https://ilinkai.weixin.qq.com';const MAX_BODY=262144,MAX_AGE=300000;
const fail=code=>Object.assign(new Error('WeChat login operation failed'),{code});
function apiHeaders(){return {'Content-Type':'application/json',AuthorizationType:'ilink_bot_token','X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),'iLink-App-Id':'bot','iLink-App-ClientVersion':String((2<<16)|(4<<8)|10)}}
async function fetchJson(fetcher,url,options,timeoutMs){
 const u=new URL(url);if(u.origin!==ORIGIN||u.username||u.password||u.hash)throw fail('login_target_invalid');let response;
 try{response=await fetcher(u.href,{...options,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}catch{throw fail('login_network_error');}
 if(!response?.ok||!response.body)throw fail('login_http_error');const chunks=[];let size=0;
 try{for await(const b of response.body){size+=b.length;if(size>MAX_BODY)throw fail('login_body_too_large');chunks.push(b)}}catch(e){throw fail(e?.code==='login_body_too_large'?'login_body_too_large':'login_response_error');}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw fail('login_invalid_response')}
}
export class QrSession {
 #login=null;#confirmed=null;
 constructor({bridge,owner,fetcher=fetch,clock=Date.now}){if(!bridge||typeof owner!=='string'||!owner||typeof fetcher!=='function')throw fail('login_configuration_error');this.bridge=bridge;this.owner=owner;this.fetcher=fetcher;this.clock=clock;}
 async begin(){if(this.#login||this.#confirmed)throw fail('login_already_pending');const u=new URL('/ilink/bot/get_bot_qrcode',ORIGIN);u.searchParams.set('bot_type','3');const r=await fetchJson(this.fetcher,u,{method:'POST',headers:apiHeaders(),body:JSON.stringify({local_token_list:[]})},15000);if(typeof r.qrcode!=='string'||!r.qrcode||r.qrcode.length>4096||typeof r.qrcode_img_content!=='string'||!r.qrcode_img_content||r.qrcode_img_content.length>8192)throw fail('login_invalid_response');this.#login={code:r.qrcode,started:this.clock()};return {qrContent:r.qrcode_img_content};}
 async poll(){if(!this.#login)throw fail('login_not_pending');if(this.clock()-this.#login.started>=MAX_AGE){this.#login=null;return {status:'expired'}}const u=new URL('/ilink/bot/get_qrcode_status',ORIGIN);u.searchParams.set('qrcode',this.#login.code);const r=await fetchJson(this.fetcher,u,{method:'GET',headers:apiHeaders()},35000);if(r.status==='wait'||r.status==='scaned')return {status:r.status};if(r.status==='expired'){this.#login=null;return {status:'expired'}}if(r.status==='need_verifycode'||r.status==='verify_code_blocked'||r.status==='scaned_but_redirect'||r.status==='binded_redirect')return {status:'additional_verification_required'};if(r.status!=='confirmed'||typeof r.bot_token!=='string'||!r.bot_token||typeof r.ilink_user_id!=='string'||!r.ilink_user_id||typeof r.ilink_bot_id!=='string'||!r.ilink_bot_id)throw fail('login_invalid_response');if(r.baseurl){let b;try{b=new URL(r.baseurl)}catch{throw fail('login_invalid_response')}if(b.origin!==ORIGIN||b.username||b.password||b.pathname!=='/'||b.search||b.hash)throw fail('login_target_invalid');}this.#confirmed={status:'confirmed',bot_token:r.bot_token,ilink_user_id:r.ilink_user_id,ilink_bot_id:r.ilink_bot_id,baseurl:r.baseurl};this.#login=null;return {status:'awaiting_owner_confirmation'};}
 async confirmOwner(confirmed){if(confirmed!==true||!this.#confirmed)throw fail('login_confirmation_required');const response=this.#confirmed;await this.bridge.bind(this.owner,response,true,this.clock());this.#confirmed=null;return {status:'bound_awaiting_challenge'};}
 cancel(){this.#login=null;this.#confirmed=null;}
}
