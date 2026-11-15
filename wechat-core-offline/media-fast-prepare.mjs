// 小文件仅合并上传准备，不执行微信发送。
export function registerFastMediaPrepare(m,{z,owner,transfers}) {
 const id=z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
 const hash=z.string().regex(/^[a-f0-9]{64}$/);
 const schema=z.object({eventId:id,idempotencyKey:id,kind:z.enum(['image','file']),fileName:z.string().min(1).max(512),size:z.number().int().min(1).max(131072),sha256:hash,dataBase64:z.string().min(1).max(174764)}).strict();
 const pending=new Set();
 const result=value=>({content:[{type:'text',text:JSON.stringify(value)}]});
 m.registerTool('prepare_small_wechat_media_upload',{
  description:'Prepare one new owner image or file of at most 128 KiB in one call, validating the exact byte count, SHA-256 and image format. This does not send. Use one stable key; preserve the returned uploadId. If any send result is unknown, never retry or change keys.',
  inputSchema:schema,
 },async ({dataBase64,...args})=>{
  const key=JSON.stringify([args.eventId,args.idempotencyKey]);
  if(pending.has(key))return {...result({state:'preparation_in_progress'}),isError:true};
  pending.add(key);
  try {
   const begun=await transfers.begin(owner,args);
   if(begun.state==='sent'||begun.state==='uncertain')return result({uploadId:begun.uploadId,state:begun.state});
   if(begun.state==='ready')return result({uploadId:begun.uploadId,state:'ready'});
   if(begun.state!=='uploading')throw new Error('invalid_state');
   const part=transfers.append(owner,{uploadId:begun.uploadId,offset:0,dataBase64});
   if(part.nextOffset!==args.size)throw new Error('invalid_size');
   const complete=await transfers.finish(owner,{uploadId:begun.uploadId});
   return result({uploadId:complete.uploadId,state:complete.state,expiresAt:begun.expiresAt});
  } catch {
   return {...result({state:'preparation_failed',message:'文件准备失败；未调用微信发送。'}),isError:true};
  } finally { pending.delete(key); }
 });
}
