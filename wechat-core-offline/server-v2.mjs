// Authenticated Node HTTP wrapper; caller controls listener and private event manager.
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {jwtVerify} from 'jose';
import {makeHandler} from './mcp-events.mjs';
import {recordRequest,recordMetadata,recordStage,recordAuthOutcome} from './safe-diagnostics.mjs';
async function authenticate(token,audience,keys,issuer,owner){if(!audience||typeof token!=='string'||token.length>16384){recordStage('auth_missing');return false;}const transient={ERR_JWKS_TIMEOUT:'jwks_timeout',XDW_JWKS_NETWORK:'jwks_network',XDW_JWKS_HTTP_TEMP:'jwks_http_temp'};for(let attempt=0;attempt<2;attempt++){try{const {payload}=await jwtVerify(token,keys,{issuer,audience,algorithms:['RS256'],requiredClaims:['exp','iss','aud','email']});const ok=payload.email===owner&&typeof payload.exp==='number';recordStage(ok?'auth_ok':'auth_owner');if(attempt&&ok)recordStage('auth_jwks_retry_ok');return ok;}catch(e){const code=e?.code,reason=transient[code];if(reason){recordStage('auth_'+reason);if(!attempt){recordStage('auth_jwks_retry');continue;}recordStage('auth_jwks_retry_failed');return reason;}if(code==='XDW_JWKS_HTTP_PERMANENT'){recordStage('auth_jwks_http_permanent');return 'jwks_http_permanent';}const stage=code==='ERR_JWT_EXPIRED'?'auth_expired':code==='ERR_JWT_CLAIM_VALIDATION_FAILED'?'auth_claim':code==='ERR_JWS_SIGNATURE_VERIFICATION_FAILED'?'auth_signature':code==='ERR_JWKS_NO_MATCHING_KEY'?'auth_jwks_key_missing':(code==='ERR_JWT_INVALID'||code==='ERR_JWS_INVALID')?'auth_invalid':'auth_other';recordStage(stage);return false;}}return 'jwks_timeout';}
export function createApp({events,keys,owner,issuer,audience,publicHost,localPort=4181,bridge,sendReply,authDiagnostic=recordAuthOutcome}){
 if(!events||!keys||!owner||!issuer||!audience||!publicHost)throw new Error('Private events, signing keys and access configuration required');
 const mcp=makeHandler({events,actor:owner,bridge,sendReply});
 const app=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try{
   const host=req.headers.host; const expectedPort=localPort===0?app.address()?.port:localPort; if(host!==publicHost&&host!==`127.0.0.1:${expectedPort}`){recordStage('auth_host');res.writeHead(403).end();return;}
   if(req.headers.origin&&req.headers.origin!==`https://${publicHost}`){recordStage('auth_origin');res.writeHead(403).end();return;}
   if(req.method==='GET'&&req.url==='/healthz'){res.writeHead(200,{'content-type':'application/json'}).end('{"status":"ok"}\n');return;}
   if(req.url!=='/mcp'){res.writeHead(404).end();return;}
   const requestId=randomBytes(8).toString('hex');res.setHeader('X-Xiaodi-Request-Id',requestId);const auth=await authenticate(req.headers['cf-access-jwt-assertion'],audience,keys,issuer,owner);const unavailable=typeof auth==='string';authDiagnostic(requestId,req.headers['mcp-method'],auth===true?'ok':unavailable?'unavailable':'rejected',unavailable?auth:undefined);if(auth!==true){res.writeHead(unavailable?(auth==='jwks_http_permanent'?502:503):403,{'content-type':'application/json'}).end(JSON.stringify({error:unavailable?'authentication_service_unavailable':'authentication_failed',pre_execution:true,request_id:requestId}));return;}
   if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'}).end();return;}
   const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>262144){res.writeHead(413).end();return;}chunks.push(chunk);}
   const headers=new Headers();for(const [name,value] of Object.entries(req.headers)){if(value&&(['content-type','accept','mcp-protocol-version','mcp-method','mcp-name'].includes(name)||name.startsWith('mcp-param-')))headers.set(name,Array.isArray(value)?value.join(', '):value);}
   const body=Buffer.concat(chunks);let rpc='other';try{rpc=JSON.parse(body.toString('utf8')).method}catch{}recordRequest(res,rpc,req.headers['mcp-protocol-version']);if(rpc==='events/subscribe')recordStage('request_received');const request=new Request(`http://127.0.0.1:${localPort}/mcp`,{method:'POST',headers,body});const response=await mcp.fetch(request);void recordMetadata(rpc,response,req.headers['mcp-protocol-version']).catch(()=>{});res.statusCode=response.status;
   for(const [name,value] of response.headers)if(!['set-cookie','transfer-encoding','connection'].includes(name))res.setHeader(name,value);
   if(response.body){for await(const chunk of response.body)res.write(chunk);}res.end();
  }catch{if(!res.headersSent)res.writeHead(500).end();else res.destroy();}
 });
 return {app,close:()=>mcp.close()};
}
