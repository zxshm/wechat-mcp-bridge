// Strictly bounded categories only. Never return an exception message, stack,
// URL, header, JWT claim or other caller-controlled value.
const jose=new Map([
 ['ERR_JOSE_GENERIC','jose_generic'],['ERR_JWK_INVALID','jwk_invalid'],
 ['ERR_JWKS_INVALID','jwks_invalid'],['ERR_JWKS_MULTIPLE_MATCHING_KEYS','jwks_multiple_matching'],
 ['ERR_JOSE_ALG_NOT_ALLOWED','algorithm_not_allowed'],['ERR_JOSE_NOT_SUPPORTED','jose_not_supported']
]);
const tls=new Map([
 ['CERT_HAS_EXPIRED','tls_certificate'],['CERT_NOT_YET_VALID','tls_certificate'],
 ['DEPTH_ZERO_SELF_SIGNED_CERT','tls_certificate'],['UNABLE_TO_VERIFY_LEAF_SIGNATURE','tls_certificate'],
 ['ERR_TLS_CERT_ALTNAME_INVALID','tls_hostname']
]);
function tlsCategory(e,depth=0){if(!e||typeof e!=='object'||depth>3)return null;if(tls.has(e.code))return tls.get(e.code);const c=tlsCategory(e.cause,depth+1);if(c)return c;if(Array.isArray(e.errors))for(const x of e.errors.slice(0,8)){const y=tlsCategory(x,depth+1);if(y)return y;}return null;}
export function classifyAuthOther(e){return jose.get(e?.code)||tlsCategory(e)||'other_unclassified';}
const claims=new Map([['iss','claim_issuer'],['aud','claim_audience'],['exp','claim_expiration'],['nbf','claim_not_before'],['email','claim_email']]);
export function classifyAuthClaim(e){return claims.get(e?.claim)||'claim_other';}
