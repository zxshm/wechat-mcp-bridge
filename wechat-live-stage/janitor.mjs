// Purges expiring encrypted state while running and immediately after a restart.
export class Janitor {
 constructor({bridge,owner,clock=Date.now,schedule=setTimeout,cancel=clearTimeout}){if(!bridge||!owner)throw new Error('Bridge and owner required');this.bridge=bridge;this.owner=owner;this.clock=clock;this.schedule=schedule;this.cancel=cancel;this.timer=null;this.closed=false;this.healthy=true;}
 async start(){this.closed=false;await this.cleanup();}
 async cleanup(){if(this.closed)return;try{await this.bridge.clean(this.owner,this.clock());this.healthy=true;this.reschedule();}catch{this.healthy=false;this.#schedule(1000);throw new Error('Retention cleanup failed');}}
 #schedule(delay){if(this.timer!==null)this.cancel(this.timer);if(this.closed)return;this.timer=this.schedule(()=>{this.timer=null;void this.cleanup().catch(()=>{});},Math.max(0,Math.min(delay,2147483647)));this.timer?.unref?.();}
 reschedule(){if(this.closed)return;const now=this.clock();let next=Infinity;for(const r of Object.values(this.bridge.state?.queue?.records??{})){if(r.event&&Number.isSafeInteger(r.textUntil))next=Math.min(next,r.textUntil);if(Number.isSafeInteger(r.dedupeUntil))next=Math.min(next,r.dedupeUntil);}if(Number.isFinite(next))this.#schedule(next-now);else if(this.timer!==null){this.cancel(this.timer);this.timer=null;}}
 stop(){this.closed=true;if(this.timer!==null)this.cancel(this.timer);this.timer=null;}
}
