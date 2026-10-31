// Owner-scoped WeChat media primitives. No network operation occurs on import.
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';

export const MAX_MEDIA_BYTES=20*1024*1024;
const CDN='https://novac2c.cdn.weixin.qq.com';
const API='https://ilinkai.weixin.qq.com';
const validOpaque=x=>typeof x==='string'&&x.length>0&&x.length<=4096&&!/[\x00-\x1f\x7f]/.test(x);
const sha=x=>createHash('sha256').update(x).digest('hex');
export function safeFilename(value){
 let name=typeof value==='string'?value.normalize('NFKC').replace(/[\x00-\x1f\x7f/\\:<>"|?*\p{Cf}]/gu,'_').trim():'';
 name=name.replace(/^\.+/,'').replace(/[. ]+$/,'');if(!name||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name))name='attachment.bin';
 while(Buffer.byteLength(name,'utf8')>120)name=[...name].slice(0,-1).join('');return name||'attachment.bin';
}
export function strictBase64(value){if(typeof value!=='string'||!value.length||value.length>Math.ceil(MAX_MEDIA_BYTES/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error('Invalid media');const data=Buffer.from(value,'base64');if(!data.length||data.length>MAX_MEDIA_BYTES||data.toString('base64')!==value)throw new Error('Invalid media');return data;}
export function parseMediaKey({aeskey,aes_key}={}){
 if(typeof aeskey==='string'&&/^[0-9a-fA-F]{32}$/.test(aeskey))return Buffer.from(aeskey,'hex');
 if(typeof aes_key!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(aes_key))throw new Error('Invalid media key');
 const d=Buffer.from(aes_key,'base64');if(d.toString('base64')!==aes_key)throw new Error('Invalid media key');if(d.length===16)return d;if(d.length===32&&/^[0-9a-fA-F]{32}$/.test(d.toString('ascii')))return Buffer.from(d.toString('ascii'),'hex');throw new Error('Invalid media key');
}
function mediaRef(input){if(!input||typeof input!=='object')return null;const param=input.encrypt_query_param,full=input.full_url;if(!validOpaque(param)&&!validOpaque(full))return null;return {param:validOpaque(param)?param:undefined,fullUrl:validOpaque(full)?full:undefined,aes_key:input.aes_key};}
export function normalizeIncomingMedia(raw,{allowedSender,accountScope,armedAt,now}){
 if(!raw||!allowedSender||!accountScope||raw.from_user_id!==allowedSender||raw.to_user_id!==accountScope||(raw.group_id!==undefined&&raw.group_id!==null&&raw.group_id!=='')||raw.message_type!==1||raw.message_state!==2||typeof raw.message_id!=='string'||!raw.message_id||typeof raw.context_token!=='string'||!raw.context_token||!Number.isSafeInteger(raw.create_time_ms)||raw.create_time_ms<=armedAt||raw.create_time_ms>now+60000||now-raw.create_time_ms>=86400000||!Array.isArray(raw.item_list))return [];
 const result=[];for(const [index,item] of raw.item_list.entries()){
  if(!item||![2,4].includes(item.type))continue;const kind=item.type===2?'image':'file',data=kind==='image'?item.image_item:item.file_item;if(!data||typeof data!=='object')continue;const ref=mediaRef(data.media);if(!ref)continue;
  if(kind==='file'&&!ref.aes_key)continue;
  if(data.aeskey||ref.aes_key)try{parseMediaKey({aeskey:data.aeskey,aes_key:ref.aes_key});}catch{continue}
  const fileName=kind==='file'?safeFilename(data.file_name):'wechat-image';const messageId=sha(JSON.stringify([accountScope,raw.message_id,index]));const eventId='weixin_media_'+messageId;
  result.push({event:{eventId,name:'weixin.owner_media',timestamp:new Date(raw.create_time_ms).toISOString(),data:{conversation_id:'weixin-self',message_id:messageId,media_kind:kind,file_name:fileName,simulation:false}},context:{to_user_id:allowedSender,context_token:raw.context_token,source_message_id:raw.message_id,accountScope},media:{...ref,aeskey:data.aeskey,mediaKind:kind,fileName,declaredLength:kind==='file'&&/^\d{1,10}$/.test(String(data.len??''))?Number(data.len):undefined}});
 }
 return result;
}
function allowedUrl(value,operation){let u;try{u=new URL(value)}catch{throw new Error('Unsafe CDN location')}if(u.protocol!=='https:'||u.origin!==CDN||u.username||u.password||u.hash||u.pathname!==`/c2c/${operation}`)throw new Error('Unsafe CDN location');return u.toString();}
export function cdnDownloadUrl(ref){if(ref.fullUrl)return allowedUrl(ref.fullUrl,'download');if(!validOpaque(ref.param))throw new Error('Missing CDN location');const u=new URL('/c2c/download',CDN);u.searchParams.set('encrypted_query_param',ref.param);return u.toString();}
export function cdnUploadUrl({fullUrl,param,filekey}){if(fullUrl)return allowedUrl(fullUrl,'upload');if(!validOpaque(param)||!/^[a-f0-9]{32}$/.test(filekey))throw new Error('Missing CDN location');const u=new URL('/c2c/upload',CDN);u.searchParams.set('encrypted_query_param',param);u.searchParams.set('filekey',filekey);return u.toString();}
async function boundedResponse(res,max){if(!res?.ok||!res.body)throw new Error('Media transfer failed');const size=Number(res.headers.get('content-length'));if(Number.isFinite(size)&&size>max)throw new Error('Media too large');let n=0;const chunks=[];for await(const chunk of res.body){n+=chunk.length;if(n>max)throw new Error('Media too large');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);}
const py=String.raw`import sys,io,json,warnings,resource
resource.setrlimit(resource.RLIMIT_CPU,(3,3))
resource.setrlimit(resource.RLIMIT_AS,(268435456,268435456))
from PIL import Image
Image.MAX_IMAGE_PIXELS=16000000
warnings.simplefilter('error',Image.DecompressionBombWarning)
b=sys.stdin.buffer.read(20971521)
if not b or len(b)>20971520: raise ValueError('size')
im=Image.open(io.BytesIO(b))
fmt=im.format
if fmt not in ('PNG','JPEG','WEBP') or getattr(im,'n_frames',1)!=1: raise ValueError('format')
w,h=im.size
if w<1 or h<1 or w*h>16000000: raise ValueError('dimensions')
im.verify()
im=Image.open(io.BytesIO(b));im.load()
print(json.dumps({'format':fmt,'width':w,'height':h}))`;
export function validateImage(bytes,{spawnProcess=spawn}={}){return new Promise((resolve,reject)=>{
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_MEDIA_BYTES)return reject(new Error('Invalid image'));
 let p;try{p=spawnProcess('/usr/bin/python3',['-I','-c',py],{stdio:['pipe','pipe','ignore']});}catch{return reject(new Error('Image validation unavailable'))}let output='',done=false;const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);if(err)reject(new Error('Invalid image'));else resolve(value)};const timer=setTimeout(()=>{p.kill('SIGKILL');finish(true)},6000);p.stdout.on('data',d=>{output+=d;if(output.length>256){p.kill('SIGKILL');finish(true)}});p.on('error',()=>finish(true));p.on('close',code=>{if(code!==0)return finish(true);try{const v=JSON.parse(output);const mime={PNG:'image/png',JPEG:'image/jpeg',WEBP:'image/webp'}[v.format];if(!mime||!Number.isInteger(v.width)||!Number.isInteger(v.height))throw 0;finish(false,{mimeType:mime,width:v.width,height:v.height})}catch{finish(true)}});p.stdin.on('error',()=>{});p.stdin.end(bytes);
 });}
export async function downloadMedia(ref,{fetcher=fetch,validate=validateImage,signal}={}){
 const url=cdnDownloadUrl(ref);const res=await fetcher(url,{method:'GET',redirect:'error',signal:signal??AbortSignal.timeout(30000)});const encrypted=await boundedResponse(res,MAX_MEDIA_BYTES+16);let bytes;if(ref.aeskey||ref.aes_key){const key=parseMediaKey(ref);try{const d=createDecipheriv('aes-128-ecb',key,null);bytes=Buffer.concat([d.update(encrypted),d.final()]);}catch{throw new Error('Media unavailable')}finally{key.fill(0)}}else if(ref.mediaKind==='image')bytes=encrypted;else throw new Error('Media unavailable');
 if(!bytes.length||bytes.length>MAX_MEDIA_BYTES||(Number.isSafeInteger(ref.declaredLength)&&ref.declaredLength!==bytes.length))throw new Error('Media unavailable');const image=ref.mediaKind==='image'?await validate(bytes):null;const ext={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'}[image?.mimeType];return {bytes,mimeType:image?.mimeType||'application/octet-stream',fileName:ext?'wechat-image'+ext:ref.fileName};
}
// This helper constructs protocol requests; callers must reserve idempotency
// before invoking it and never retry an uncertain upload or send.
export async function uploadAndSendMedia({bytes,kind,fileName,sessionToken,toUserId,contextToken,clientId,fetcher=fetch,validate=validateImage,deadline=Infinity,clock=Date.now}){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_MEDIA_BYTES||!['image','file'].includes(kind)||!sessionToken||!toUserId||!contextToken||!/^xiaodi:\d{1,16}-[0-9a-f]{8}$/.test(clientId))throw new Error('Invalid media request');if(kind==='image')await validate(bytes);
 const name=safeFilename(fileName),aes=randomBytes(16),filekey=randomBytes(16).toString('hex');const common={channel_version:'2.4.10',bot_agent:'XiaodiWeixinBridge/0.1.0'};const headers={'Content-Type':'application/json',AuthorizationType:'ilink_bot_token','X-WECHAT-UIN':Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),'iLink-App-Id':'bot','iLink-App-ClientVersion':String((2<<16)|(4<<8)|10),Authorization:'Bearer '+sessionToken};
 try{const signal=()=>{const left=deadline-clock();if(left<=0)throw new Error('Media expired');return AbortSignal.timeout(Math.max(1,Math.min(30000,left)))};const cipher=createCipheriv('aes-128-ecb',aes,null),encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);const body={filekey,media_type:kind==='image'?1:3,to_user_id:toUserId,rawsize:bytes.length,rawfilemd5:createHash('md5').update(bytes).digest('hex'),filesize:encrypted.length,no_need_thumb:true,aeskey:aes.toString('hex'),base_info:common};
  const uploadRes=await fetcher(API+'/ilink/bot/getuploadurl',{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:signal()});const upload=JSON.parse((await boundedResponse(uploadRes,65536)).toString('utf8'));if((upload.ret!==undefined&&upload.ret!==0)||(upload.errcode!=null&&upload.errcode!==0))throw new Error('Media upload unavailable');const url=cdnUploadUrl({fullUrl:upload.upload_full_url,param:upload.upload_param,filekey});
  const cdnRes=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:encrypted,redirect:'error',signal:signal()});if(!cdnRes?.ok)throw new Error('Media upload unavailable');const param=cdnRes.headers.get('x-encrypted-param');if(!validOpaque(param))throw new Error('Media upload unavailable');const media={encrypt_query_param:param,aes_key:Buffer.from(aes.toString('hex'),'utf8').toString('base64'),encrypt_type:1};const item=kind==='image'?{type:2,image_item:{media,mid_size:encrypted.length}}:{type:4,file_item:{media,file_name:name,len:String(bytes.length)}};
  const result=await fetcher(API+'/ilink/bot/sendmessage',{method:'POST',headers,body:JSON.stringify({msg:{from_user_id:'',to_user_id:toUserId,client_id:clientId,message_type:2,message_state:2,context_token:contextToken,item_list:[item]},base_info:common}),redirect:'error',signal:signal()});const response=JSON.parse((await boundedResponse(result,65536)).toString('utf8'));if(!response||typeof response!=='object'||Array.isArray(response)||(response.ret!==undefined&&response.ret!==0)||(response.errcode!=null&&response.errcode!==0))throw new Error('Media send unconfirmed');return {accepted:true};
 }finally{aes.fill(0)}
}
