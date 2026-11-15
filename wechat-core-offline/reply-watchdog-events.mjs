import {parseCallback, validateSecret, verifyCallback, signedHeaders, postPinned} from './webhook.mjs';
import {createHash} from 'node:crypto';
import {WATCHDOG_EVENT} from './reply-watchdog.mjs';
const DAY=86400000;
const subscriptionId=(owner,url)=>'watchdog_sub_'+createHash('sha256').update(JSON.stringify([owner,url,WATCHDOG_EVENT])).digest('hex');
export const watchdogEventDefinition={name:WATCHDOG_EVENT,
  description:'Low-sensitivity notice that a newly registered owner message lacks a completed reply. Read authenticated status; never blindly resend.',
  delivery:['webhook'], inputSchema:{type:'object',properties:{},additionalProperties:false},
  payloadSchema:{type:'object',properties:{checkedAt:{type:'string'},overdueCount:{type:'integer'},expiredUnresolved:{type:'integer'},stages:{type:'array',items:{type:'string'}},changed:{type:'boolean'},simulation:{type:'boolean'}},
    required:['checkedAt','overdueCount','expiredUnresolved','stages','changed','simulation'],additionalProperties:false}};
const stages=new Set(['awaiting_reply','history_unavailable','in_progress','reply_uncertain','unlinked_attempt']);
function args(p){return p?.name===WATCHDOG_EVENT&&p.arguments&&Object.keys(p.arguments).length===0&&!Array.isArray(p.arguments)&&p.delivery?.mode==='webhook';}
function payload(e){const d=e?.data;return e?.name===WATCHDOG_EVENT&&/^watchdog_[a-f0-9]{64}$/.test(e.eventId)&&Number.isFinite(Date.parse(e.timestamp))&&d&&
  Object.keys(d).sort().join(',')==='changed,checkedAt,expiredUnresolved,overdueCount,simulation,stages'&&Number.isFinite(Date.parse(d.checkedAt))&&
  Number.isSafeInteger(d.overdueCount)&&d.overdueCount>=0&&Number.isSafeInteger(d.expiredUnresolved)&&d.expiredUnresolved>=0&&
  Array.isArray(d.stages)&&d.stages.length<=5&&d.stages.every(x=>stages.has(x))&&typeof d.changed==='boolean'&&d.simulation===false;}

// Independent store: never reads/writes existing owner_text/owner_media subscriptions.
export class ReplyWatchdogEvents {
  constructor({owner,store,isAuthorized,send=postPinned}){
    if(!owner||!store?.load||!store?.save||typeof isAuthorized!=='function')throw new Error('Explicit owner, independent store and authorization required');
    Object.assign(this,{owner,store,isAuthorized,send});this.state={subscription:null};this.serial=Promise.resolve();
  }
  locked(fn){const p=this.serial.then(fn);this.serial=p.catch(()=>{});return p;}
  async check(actor){if(actor!==this.owner||!await this.isAuthorized(actor))throw new Error('Owner authorization required');}
  async load(){const s=await this.store.load();if(!s||!Object.hasOwn(s,'subscription'))throw new Error('Invalid watchdog subscription state');this.state=s;}
  list(actor){return this.locked(async()=>{await this.check(actor);return {events:[watchdogEventDefinition]};});}
  ready(actor,now=Date.now()){return this.locked(async()=>{await this.check(actor);const s=this.state.subscription;return !!(s&&s.owner===actor&&s.name===WATCHDOG_EVENT&&Number.isSafeInteger(s.expiresAt)&&s.expiresAt>now);});}
  subscribe(actor,p,now=Date.now()){return this.locked(async()=>{
    await this.check(actor);if(!args(p))throw new Error('Invalid independent subscription');parseCallback(p.delivery.url);validateSecret(p.delivery.secret);
    const id=subscriptionId(actor,p.delivery.url,WATCHDOG_EVENT),old=this.state.subscription;
    if(old&&old.expiresAt>now&&old.id!==id)throw new Error('One watchdog subscriber allowed');
    const ttl=p.ttlMs??DAY;if(!Number.isSafeInteger(ttl)||ttl<=0)throw new Error('Invalid TTL');
    // Secret changes require their own reviewed rotation; do not silently overwrite.
    if(old&&old.expiresAt>now&&old.secret!==p.delivery.secret)throw new Error('Explicit subscription rotation required');
    const sub={id,owner:actor,url:p.delivery.url,secret:p.delivery.secret,name:WATCHDOG_EVENT,expiresAt:now+Math.min(ttl,7*DAY)};
    await verifyCallback(sub,this.send,{timeoutMs:12000});const next={subscription:sub};await this.store.save(next);this.state=next;
    return {id,refreshBefore:new Date(sub.expiresAt).toISOString(),cursor:null,truncated:false};
  });}
  // This only addresses the independent watchdog subscription, never the original webhook.
  unsubscribe(actor,p){return this.locked(async()=>{await this.check(actor);if(!args(p))throw new Error('Invalid independent subscription');
    if(this.state.subscription?.id!==subscriptionId(actor,p.delivery.url,WATCHDOG_EVENT))throw new Error('Subscription mismatch');
    const next={subscription:null};await this.store.save(next);this.state=next;return {};
  });}
  deliver(actor,event,now=Date.now()){return this.locked(async()=>{
    await this.check(actor);if(!payload(event))throw new Error('Invalid low-sensitivity watchdog event');
    const sub=this.state.subscription;if(!sub||sub.owner!==actor||sub.expiresAt<=now)return {accepted:false,definitelyNotAccepted:true};
    const body=JSON.stringify({name:event.name,eventId:event.eventId,timestamp:event.timestamp,data:event.data,cursor:null});
    const headers=signedHeaders(sub.secret,sub.id,event.eventId,body,new Date(now));
    try{const r=await this.send(sub.url,headers,body,{signal:AbortSignal.timeout(12000)});
      return {accepted:r.status>=200&&r.status<300}; // Other outcomes remain uncertain.
    }catch{return {accepted:false};}
  });}
}
