import {createHmac,randomBytes} from 'node:crypto';
const TTL=86400000,MAX_GROUPS=128;
const OUTCOMES=['upstream_accepted','upstream_prepare_failed','upstream_rate_limited','upstream_other','network_unknown','http_unknown','response_unknown','local_unknown'];
// In-memory and process-local only: no secrets, hashes or message identifiers are returned.
export class ContextDiagnostics {
 #key;#groups=new Map();#startedAt;#clock;#evicted=0;#timer=null;
 constructor({clock=Date.now}={}){this.#clock=clock;this.#key=randomBytes(32);this.#startedAt=clock();}
 #purge(now){for(const [key,g] of this.#groups)if(now>=g.expiresAt)this.#groups.delete(key)}
 #schedule(){if(this.#timer!==null)clearTimeout(this.#timer);this.#timer=null;if(!this.#groups.size)return;const next=Math.min(...[...this.#groups.values()].map(g=>g.expiresAt));this.#timer=setTimeout(()=>{this.#timer=null;this.#purge(this.#clock());this.#schedule()},Math.max(1,next-this.#clock()));this.#timer?.unref?.()}
 #group(record,now){this.#purge(now);const c=record?.privateReplyContext,e=record?.event;if(!e||e.data?.conversation_id!=='weixin-self'||e.data?.simulation!==false||!['weixin.owner_text','weixin.owner_media'].includes(e.name)||!c?.to_user_id||!c?.accountScope||!c?.context_token||!Number.isSafeInteger(record.textUntil)||now>=record.textUntil)return null;
  const key=createHmac('sha256',this.#key).update(JSON.stringify([c.accountScope,c.to_user_id,c.context_token])).digest('hex');let g=this.#groups.get(key);if(!g){if(this.#groups.size>=MAX_GROUPS){const first=this.#groups.keys().next().value;this.#groups.delete(first);this.#evicted++}g={label:'g_'+randomBytes(12).toString('hex'),firstObservedAt:now,expiresAt:now+TTL,lastInboundAt:null,inboundEvents:0,textRequests:0,mediaOperations:0,inflight:0,results:Object.fromEntries(OUTCOMES.map(x=>[x,0]))};this.#groups.set(key,g);this.#schedule()}
  const t=Date.parse(e.timestamp);if(Number.isFinite(t)&&t<=now&&now-t<TTL&&(g.lastInboundAt===null||t>g.lastInboundAt))g.lastInboundAt=t;return g;
 }
 observeInbound(record,now=this.#clock()){const g=this.#group(record,now);if(g)g.inboundEvents++;}
 begin(record,kind,now=this.#clock()){if(!['text','media'].includes(kind))return null;const g=this.#group(record,now);if(!g)return null;g[kind==='text'?'textRequests':'mediaOperations']++;g.inflight++;return {group:g,done:false};}
 complete(attempt,result,now=this.#clock()){if(!attempt||attempt.done)return;attempt.done=true;const g=attempt.group;if(now>=g.expiresAt)return;g.inflight=Math.max(0,g.inflight-1);g.results[OUTCOMES.includes(result)?result:'local_unknown']++;}
 snapshot(now=this.#clock()){this.#purge(now);this.#schedule();return {processStartedAt:this.#startedAt,retentionMs:TTL,maxGroups:MAX_GROUPS,evictedGroups:this.#evicted,groups:[...this.#groups.values()].map(g=>({label:g.label,observationAgeSeconds:Math.floor(Math.max(0,now-g.firstObservedAt)/1000),lastObservedInboundAgeSeconds:g.lastInboundAt===null?null:Math.floor(Math.max(0,now-g.lastInboundAt)/1000),inboundEvents:g.inboundEvents,textRequests:g.textRequests,mediaOperations:g.mediaOperations,inflight:g.inflight,results:{...g.results}}))};}
}
export const contextDiagnostics=new ContextDiagnostics();
