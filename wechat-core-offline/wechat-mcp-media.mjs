import {IncomingFileStore} from '../large-media/incoming-file-store.mjs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {registerFastMediaPrepare} from './media-fast-prepare.mjs';
import {createHash} from 'node:crypto';
import {replyOnce} from './transport-live.mjs';
import {MediaTransfers} from './media-transfer.mjs';
import {contextDiagnostics} from './context-diagnostics.mjs';
import {downloadMedia,uploadAndSendMedia,validateImage,MAX_MEDIA_BYTES,cdnDownloadUrl,parseMediaKey,safeFilename} from './media-codec.mjs';

export function createWechatMediaTools({z,owner,bridge,download=downloadMedia,upload=uploadAndSendMedia,notify=replyOnce,validate=validateImage,clock=Date.now,schedule=setTimeout,cancel=clearTimeout}){
 const active=()=>{const b=typeof bridge==='function'?bridge():bridge;if(!b||b.owner!==owner||b.state?.phase!=='armed')throw new Error('WeChat unavailable');return b;};
 const incomingFiles=new IncomingFileStore({
  root:process.env.BRIDGE_INCOMING_MEDIA_ROOT||join(process.env.BRIDGE_LARGE_MEDIA_ROOT||join(homedir(),'.local/share/wechat-mcp/large-media'),'incoming'),
  origin:process.env.BRIDGE_FILE_UPLOAD_ORIGIN,resolveUrl:cdnDownloadUrl,parseKey:parseMediaKey,safeFilename,clock
 });
 const transfers=new MediaTransfers({owner,clock,schedule,cancel,validate,
  readIncoming:async(actor,eventId)=>{const {media,expiresAt}=await active().mediaContext(actor,eventId,clock);if(download===downloadMedia&&media.mediaKind==='file')return incomingFiles.prepare({eventId,media,expiresAt});const value=await download(media);if(clock()>=expiresAt){value.bytes.fill(0);throw new Error('Media unavailable')}return {...value,expiresAt};},
  checkTarget:async(actor,eventId)=>{const {expiresAt}=await active().readEvent(actor,eventId,clock);return {expiresAt};},
  waitForNewContext:async(actor,{eventId,idempotencyKey})=>{const b=active();if(typeof b.resolveUnattemptedMediaTarget!=='function')return false;return !!(await b.resolveUnattemptedMediaTarget(actor,eventId,idempotencyKey,clock));},
  sendMedia:async(actor,args)=>{
   const b=active();let targetId=args.eventId,draft,started=false,contextAttempt;
   const contextDone=category=>{try{contextDiagnostics.complete(contextAttempt,category,clock())}catch{}};
   const start=reserved=>{
    targetId=reserved.effectiveEventId||args.eventId;const deadline=Math.min(reserved.expiresAt,args.expiresAt);
    if(clock()>=deadline)throw Object.assign(new Error('No upload started'),{code:'pre_execution_failure'});
    try{contextAttempt=contextDiagnostics.begin(b.state?.queue?.records?.[targetId],'media',clock())}catch{}
    // Image validation inside upload may yield before its first network request. Never migrate after launch.
    started=true;return upload({bytes:args.bytes,kind:args.kind,fileName:args.fileName,sessionToken:b.state.sessionToken,toUserId:reserved.to_user_id,contextToken:reserved.context_token,clientId:reserved.clientId,deadline,clock});
   };
   try{draft=await b.mediaReplyDraft(actor,args,clock,{start});}
   catch(e){
    targetId=e?.blockedEventId||targetId;
    if(e?.code==='context_notice_requires_text'){
     const noticeKey='media-notice-v1-'+createHash('sha256').update(JSON.stringify([targetId,args.idempotencyKey])).digest('hex');let noticeState='not_started';
     try{const n=await notify({bridge:b,actor,eventId:targetId,text:'媒体仅在暂存有效期内续发，过期需重新提交。',idempotencyKey:noticeKey,now:clock(),clock});noticeState=n?.state==='sent'?'upstream_accepted':n?.state==='uncertain'?'uncertain':'not_started';}catch{noticeState='uncertain';}
     throw Object.assign(new Error('Media waits for a new owner context'),{code:'context_budget_exhausted',blockedEventId:targetId,noticeState});
    }
    if(e?.code==='context_budget_exhausted')throw Object.assign(e,{blockedEventId:targetId});
    throw e;
   }
   if(draft.state)return {state:draft.state};targetId=draft.effectiveEventId||args.eventId;
   try{if(draft.execution){const outcome=await draft.execution;if(Object.hasOwn(outcome,'error'))throw outcome.error;}else await start(draft);contextDone('upstream_accepted');await b.replySent(actor,targetId,args.idempotencyKey,clock());return {state:'sent'};}
   catch(e){if(!started){await b.discardUnstartedReply(actor,targetId,args.idempotencyKey,draft.clientId);throw Object.assign(new Error('No upload started'),{code:'pre_execution_failure'});}contextDone(e?.code==='upstream_media_rejected'?'upstream_other':'local_unknown');if(e?.code==='upstream_media_rejected'&&typeof b.replyRejected==='function'){try{await b.replyRejected(actor,targetId,args.idempotencyKey,clock());}catch{}}return {state:'uncertain'};}
  }
 });
 const id=z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),uploadId=z.string().regex(/^[a-f0-9]{64}$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
 const result=x=>({content:[{type:'text',text:JSON.stringify(x)}]});const failed=error=>{const code=/^incoming_media_[a-z_]+$/.test(error?.code||'')?error.code:'media_unavailable';return {content:[{type:'text',text:JSON.stringify({error_code:code,message:code==='incoming_media_no_space'?'Minihome 文件暂存空间不足。':code==='incoming_media_length_mismatch'?'文件实际长度与微信声明不一致。':code==='incoming_media_download_failed'?'微信 CDN 文件下载未完成。':code==='incoming_media_decrypt_failed'?'文件下载或解密未完成。':'媒体读取失败，请根据错误代码核查。'})}],isError:true};};
 function register(m){
  registerFastMediaPrepare(m,{z,owner,transfers});
  m.registerTool('prepare_wechat_file_download',{description:'为本人微信新普通文件准备 Linux 流式下载与解密，返回文件大小、SHA-256 和短期 HTTPS 原始字节下载凭证。云端通过 Authorization Bearer 下载并校验完整大小和摘要，支持 Range 续传。文件按可用磁盘空间准入。凭证仅在请求内使用，不打印、不写入聊天或公开文件。',inputSchema:z.object({eventId:id}).strict(),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async args=>{try{return result(await transfers.prepareDownload(owner,args))}catch(error){return failed(error)}});
  m.registerTool('read_wechat_media_chunk',{description:'Read one authenticated 128 KiB chunk of an accepted owner image or file, within its retention period. Reuse sha256 as expectedSha256 after offset zero; decode and verify the final digest before saving.',inputSchema:z.object({eventId:id,offset:z.number().int().min(0).optional(),expectedSha256:hash.nullable().optional()}).strict(),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async args=>{try{return result(await transfers.read(owner,args))}catch(error){return failed(error)}});
  m.registerTool('view_wechat_image',{description:'View an accepted owner image up to 4 MiB within its retention period. ImageContent is not automatically a user attachment; use chunk reading and Library to save it. Larger images are available through the chunk reader.',inputSchema:z.object({eventId:id}).strict(),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async args=>{try{return {content:[await transfers.image(owner,args)]}}catch(error){return failed(error)}});
  m.registerTool('begin_wechat_media_upload',{description:'Prepare an owner-only in-memory transfer for a new image or file to the original conversation of an accepted event; no WeChat message is sent. Use a unique idempotency key and exact SHA-256.',inputSchema:z.object({eventId:id,idempotencyKey:id,kind:z.enum(['image','file']),fileName:z.string().min(1).max(512),size:z.number().int().min(1).max(MAX_MEDIA_BYTES),sha256:hash}).strict()},async args=>{try{return result(await transfers.begin(owner,args))}catch(error){return failed(error)}});
  m.registerTool('append_wechat_media_upload',{description:'Append up to 128 KiB of base64-decoded bytes at the exact offset; replaying an identical chunk is safe. This does not send a message.',inputSchema:z.object({uploadId,offset:z.number().int().min(0),dataBase64:z.string().min(1).max(174764)}).strict()},async args=>{try{return result(transfers.append(owner,args))}catch(error){return failed(error)}});
  m.registerTool('finish_wechat_media_upload',{description:'Verify exact size and SHA-256 and decode-check images before enabling a media send. This does not send a message.',inputSchema:z.object({uploadId}).strict()},async args=>{try{return result(await transfers.finish(owner,args))}catch(error){return failed(error)}});
  m.registerTool('send_wechat_media_upload',{description:'Send the verified upload once using the latest verified context in its bound owner conversation. Preserve its key and original expiry; never retry an uncertain send.',inputSchema:z.object({uploadId}).strict(),annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},async args=>{try{const r=await transfers.send(owner,args);return r.state==='sent'?result(r):r.state==='not_sent'?{...result(r),isError:true}:{...result({state:'uncertain',instruction:'Do not automatically retry this send.'}),isError:true}}catch(error){return failed(error)}});
 }
 return {register,close:()=>{incomingFiles.close();transfers.close()}};
}
