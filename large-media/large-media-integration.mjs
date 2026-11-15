import http from 'node:http';
import {chmod,mkdir,readFile,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {once} from 'node:events';
import {createLargeMediaBridgeAdapter} from './large-media-bridge-adapter.mjs';

export function privateMediaCall(socketPath,operation,args) {
  return new Promise((resolve,reject)=>{
    const data=JSON.stringify(args),req=http.request({socketPath,path:operation,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)}},res=>{
      let size=0;const chunks=[];
      res.on('data',chunk=>{size+=chunk.length;if(size>65536)res.destroy(new Error('响应过大'));else chunks.push(chunk);});
      res.on('error',reject);res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks));if(res.statusCode!==200&&res.statusCode!==201)throw new Error(value.error||'本机接口不可用');resolve(value);}catch(e){reject(e);}});
    });req.on('error',reject);req.setTimeout(600000,()=>req.destroy(new Error('本机调用超时，不能据此重发')));req.end(data);
  });
}

// 由已经认证的原微信 MCP 工厂构造。私有套接字供本机同一用户执行明确授权的测试。
export function createLargeMediaIntegration({z,owner,bridge,safeFilename,cdnUploadUrl,root,receiverSocket,controlSocket,sendFile}) {
  const id=z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),hash=z.string().regex(/^[a-f0-9]{64}$/),uploadId=z.string().regex(/^[a-f0-9]{32}$/);
  const roomId=z.literal(process.env.BRIDGE_ROOM_ID||'example-room');
  const beginSchema=z.object({eventId:id,sourceId:id,roomId,fileName:z.string().min(1).max(255),size:z.number().int().positive().safe(),sha256:hash}).strict();
  const sendSchema=z.object({uploadId,eventId:id,sourceId:id,roomId,sha256:hash}).strict();
  const statusSchema=z.object({uploadId}).strict();
  const active=()=>{const b=typeof bridge==='function'?bridge():bridge;if(!b||b.owner!==owner||b.state?.phase!=='armed')throw new Error('原桥不可用');return b;};
  const operations={
    async begin(args) {
      const {eventId,...metadata}=beginSchema.parse(args);
      const target=await active().readEvent(owner,eventId,Date.now);
      const expiresAt=Math.min(target.expiresAt,Date.now()+3600000);
      const upload=await privateMediaCall(receiverSocket,'/uploads',{...metadata,boundEventId:eventId,expiresAt});
      return {...upload,transport:'https_binary_parts',uploadEndpoint:process.env.BRIDGE_FILE_UPLOAD_ORIGIN,linuxEndpoint:'http://127.0.0.1:4183',cloudUploadAvailable:Boolean(process.env.BRIDGE_FILE_UPLOAD_ORIGIN),
        protocol:{authorization:'Bearer token in Authorization header',status:'GET /uploads/{id}',part:'PUT /uploads/{id}/parts/{index}',partHeaders:['Content-Type: application/octet-stream','Content-Length: exact bytes','X-Part-SHA256: lowercase hex'],finish:'POST /uploads/{id}/finish',body:'raw binary, not base64',send:'send_large_wechat_file_upload after verified',redirects:'reject'}};
    },
    async status(args) {
      const {uploadId}=statusSchema.parse(args);active();
      const folder=join(root,uploadId),state=JSON.parse(await readFile(join(folder,'access.json'),'utf8'));
      let sendResult=null;try{sendResult=JSON.parse(await readFile(join(folder,'send-result.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
      return {state:state.state,size:state.size,sha256:state.sha256,sourceId:state.sourceId,expiresAt:state.expiresAt,sendResult};
    },
    async send(args) {
      args=sendSchema.parse(args);
      // 来源身份由已认证调用者从真实附件取得；与原上传的不可变绑定逐项核对。
      const send=createLargeMediaBridgeAdapter({root,owner,bridge,safeFilename,cdnUploadUrl,sendFile,
        verifySource:async source=>source.sourceId===args.sourceId&&source.roomId===args.roomId&&source.sha256===args.sha256});
      return send(args);
    }
  };
  function register(m) {
    const entries=[['begin_large_wechat_file_upload','begin',beginSchema,'为原小弟的新真实附件创建 HTTPS 二进制上传，返回独立短期凭证、uploadEndpoint、partBytes 和操作路径。核实原文件身份、大小和 SHA-256；在能访问原字节且能执行 HTTPS PUT 的环境中，按返回大小切段、逐段计算 SHA-256 并上传原始二进制，再 finish。不得打印凭证，不跟随重定向。此工具不上传内容、不发送微信；缺少文件读取或 HTTP 上传能力时如实报告，不假称上传完成。'],
      ['get_large_wechat_file_status','status',statusSchema,'只读查询一个已准备大文件的完整校验及发送回执，不返回凭证。'],
      ['send_large_wechat_file_upload','send',sendSchema,'把原小弟已核实的新附件首次发送到绑定的本人微信，复用原桥发送锁和账本。仅上传完整且摘要一致后执行；结果未知不得重试或换身份。']];
    for(const [name,op,inputSchema,description] of entries)m.registerTool(name,{description,inputSchema,annotations:{readOnlyHint:op==='status',destructiveHint:false,openWorldHint:op==='send'}},async args=>{
      try{return {content:[{type:'text',text:JSON.stringify(await operations[op](args))}]};}
      catch{return {content:[{type:'text',text:'大文件操作未确认；查询原上传状态，不重试未知发送。'}],isError:true};}
    });
  }
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.method!=='POST')throw new Error('方法无效');
      const op=req.url?.slice(1);if(!Object.hasOwn(operations,op))throw new Error('操作无效');
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8192)throw new Error('请求过大');chunks.push(chunk);}
      const value=await operations[op](JSON.parse(Buffer.concat(chunks)));
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(value));
    }catch{res.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({error:'large_media_operation_unconfirmed'}));}
  });
  const ready=(async()=>{await mkdir(dirname(controlSocket),{recursive:true,mode:0o700});await rm(controlSocket,{force:true});server.listen(controlSocket);await once(server,'listening');await chmod(controlSocket,0o600);})();
  // 新通道启动失败不终止现有文字同步，错误由独立健康检查发现。
  void ready.catch(()=>{});
  return {register,operations,ready,close:()=>new Promise(resolve=>{server.close(()=>resolve());server.closeIdleConnections();})};
}
