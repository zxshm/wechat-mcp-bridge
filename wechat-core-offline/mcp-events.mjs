import {MCP_SERVER_VERSION} from './mcp-version.mjs';
import {registerWechatReadTool} from '../wechat-live-stage/wechat-mcp-read.mjs';
import {registerWechatReplyTool} from '../wechat-live-stage/wechat-mcp-reply-live.mjs';
import {createWechatMediaTools} from './wechat-mcp-media.mjs';
// MCP 2.0 factory; caller must authenticate and bind actor before invoking this factory.
import {McpServer,createMcpHandler,ProtocolError} from '@modelcontextprotocol/server';
import {parseCallback,validateSecret} from './webhook.mjs';
import * as z from 'zod/v4';
const EventInput=z.object({name:z.enum(['weixin.owner_text','weixin.owner_media']),arguments:z.object({}).strict(),delivery:z.object({mode:z.literal('webhook'),url:z.string().url(),secret:z.string().optional()}).strict(),cursor:z.string().nullable().optional(),ttlMs:z.number().int().positive().nullable().optional()}).passthrough();
const AnyResult=z.object({}).passthrough();
export function makeHandler({events,actor,bridge,sendReply,mediaOptions={}}) {
 if(!events||typeof actor!=='string'||!actor)throw new Error('Verified owner required');
 const media=createWechatMediaTools({...mediaOptions,z,owner:actor,bridge});
 const handler=createMcpHandler(()=>{
  const m=new McpServer({name:'xiaodi-wechat-mcp',version:MCP_SERVER_VERSION});
  m.server.registerCapabilities({events:{}});
  m.registerTool('get_bridge_test_status',{description:'Return test status without WeChat data.',inputSchema:z.object({}).strict()},async()=>({content:[{type:'text',text:'{"status":"test-only","wechatConnected":false}'}]}));
  m.registerTool('send_synthetic_event',{description:'Send one explicitly requested synthetic event without WeChat data to the active owner subscription.',inputSchema:z.object({}).strict()},async()=>{try{const r=await events.testDelivery(actor);return {content:[{type:'text',text:JSON.stringify({accepted:r.accepted,status:r.status})}]};}catch{return {content:[{type:'text',text:'Synthetic event not sent; check subscription.'}],isError:true};}});
  registerWechatReplyTool(m,{z,owner:actor,bridge,...(sendReply?{send:sendReply}:{})});
  registerWechatReadTool(m,{z,owner:actor,bridge});
  media.register(m);
  m.registerTool('list_recent_wechat_conversation',{description:'Read a bounded page of retained owner-only WeChat text and recorded reply attempts, ordered by bridge receipt or attempt time. Continue with nextCursor and retain resumeCursor for new entries. Re-scan retained pages and reconcile replyId to detect status changes. Expired text and older reply bodies cannot be recovered. Never retry uncertain sends.',inputSchema:z.object({after:z.string().max(512).nullable().optional(),limit:z.number().int().min(1).max(50).optional()}).strict(),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},async({after=null,limit=50})=>{
   const active=typeof bridge==='function'?bridge():bridge;if(!active||active.owner!==actor||active.state?.phase!=='armed')return {content:[{type:'text',text:'WeChat is not ready.'}],isError:true};
   try{return {content:[{type:'text',text:JSON.stringify(await active.recentConversation(actor,{after,limit}))}]};}catch{return {content:[{type:'text',text:'Conversation unavailable.'}],isError:true};}
  });
  m.server.setRequestHandler('events/list',{params:z.object({}).passthrough(),result:AnyResult},async()=>events.list(actor));
  m.server.setRequestHandler('events/subscribe',{params:EventInput,result:AnyResult},async(p)=>{try{parseCallback(p.delivery.url);validateSecret(p.delivery.secret);}catch{throw new ProtocolError(-32602,'Invalid subscription parameters');}try{return await events.subscribe(actor,p)}catch(e){const reason=["doh_timeout","doh_invalid","doh_private","doh_loop","doh_empty","doh_http_error","doh_response_large","doh_transport_error","doh_bootstrap_error","socks_error","socks_proxy_error","socks_method_error","socks_target_error","socks_protocol_error","socks_timeout","socks_reply_1","socks_reply_2","socks_reply_3","socks_reply_4","socks_reply_5","socks_reply_6","socks_reply_7","socks_reply_8","socks_reply_other","tls_cert_expired","tls_hostname_invalid","tls_cert_untrusted","tls_other",'dns_timeout','dns_error','destination_blocked','callback_timeout','callback_error','redirect_rejected','challenge_timeout','challenge_failed','store_error'].includes(e?.code)?e.code:'challenge_failed';throw new ProtocolError(-32015,'CallbackEndpointError',{reason});}});
  m.server.setRequestHandler('events/unsubscribe',{params:EventInput,result:AnyResult},async(p)=>events.unsubscribe(actor,p));
  return m;
 },{legacy:'stateless'});
 const close=handler.close.bind(handler);handler.close=async()=>{media.close();await close();};return handler;
}
