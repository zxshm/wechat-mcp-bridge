// Only errors arising inside the public JWKS HTTP fetch are classified here.
// The issuer URL and TLS verification are still controlled by jose and Node.
const networkCodes=new Set(['EAI_AGAIN','ENOTFOUND','ECONNRESET','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']);
const bodyFailure=Symbol('jwks-body-failure');
function classified(code){return Object.assign(new Error('Public key service unavailable'),{code});}
function knownNetwork(e,depth=0){if(!e||typeof e!=='object'||depth>3)return false;if(networkCodes.has(e.code))return true;if(knownNetwork(e.cause,depth+1))return true;return Array.isArray(e.errors)&&e.errors.slice(0,8).some(x=>knownNetwork(x,depth+1));}
function taggedBody(reason){const e=classified('XDW_JWKS_BODY_FAILURE');Object.defineProperty(e,bodyFailure,{value:reason});return e;}
// jose wraps response.json failures in ERR_JOSE_GENERIC; accept only our
// in-process tag from the JWKS response reader, never arbitrary causes.
export function classifyJwksBodyFailure(e){if(e?.code!=='ERR_JOSE_GENERIC')return null;const reason=e?.cause?.[bodyFailure];return reason==='jwks_timeout'||reason==='jwks_network'?reason:null;}
export function createJwksFetch(fetchImpl=fetch){
 if(typeof fetchImpl!=='function')throw new Error('Invalid fetch');
 return async(url,options)=>{
  let response;try{response=await fetchImpl(url,options);}catch(e){if(e?.name==='TimeoutError')throw e;if(knownNetwork(e))throw classified('XDW_JWKS_NETWORK');throw e;}
  if(response.status===429||response.status>=500&&response.status<=599)throw classified('XDW_JWKS_HTTP_TEMP');
  if(response.status>=400&&response.status<=499)throw classified('XDW_JWKS_HTTP_PERMANENT');
  if(typeof response.json==='function'){
   const read=response.json.bind(response);
   Object.defineProperty(response,'json',{configurable:true,value:async(...args)=>{try{return await read(...args)}catch(e){if(e?.name==='TimeoutError')throw taggedBody('jwks_timeout');if(knownNetwork(e))throw taggedBody('jwks_network');throw e;}}});
  }
  return response;
 };
}
