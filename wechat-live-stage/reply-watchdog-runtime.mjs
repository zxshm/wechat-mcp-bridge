// Independent scheduler; never piggyback on a possibly stalled WeChat poll.
// sendAlert must be an approved, independently subscribed signed MCP event
// adapter. This module never creates subscriptions or sends email itself.
export class ReplyWatchdogRuntime {
  constructor({bridge, owner, sendAlert, clock = Date.now, schedule = setTimeout,
    cancel = clearTimeout, intervalMs = 30000, onError = () => {}}) {
    if (!bridge || bridge.owner !== owner || typeof sendAlert !== 'function' ||
        !Number.isSafeInteger(intervalMs) || intervalMs < 1000)
      throw new Error('Invalid watchdog runtime');
    Object.assign(this, {bridge, owner, sendAlert, clock, schedule, cancel, intervalMs, onError});
    this.running = false; this.timer = null; this.current = null;
  }
  async start() {
    if (this.running) throw new Error('Watchdog already running');
    // A previous process may have died after dispatching but before persisting.
    await this.bridge.recoverWatchdogAlert(this.owner, this.clock());
    this.running = true; this.scheduleNext(0);
  }
  scheduleNext(delay) {
    if (!this.running || this.timer !== null) return;
    this.timer = this.schedule(() => { this.timer = null; void this.step(); }, delay);
    this.timer?.unref?.();
  }
  step() {
    if (!this.running) return Promise.resolve();
    if (this.current) return this.current;
    this.current = this.run().catch(() => {
      // Only a fixed error code may leave this boundary.
      try { this.onError('reply_watchdog_step_failed'); } catch {}
    }).finally(() => { this.current = null; this.scheduleNext(this.intervalMs); });
    return this.current;
  }
  async run() {
    const claim = await this.bridge.claimWatchdogAlert(this.owner, this.clock());
    if (!claim) return;
    // No automatic retry, including throws, missing responses and HTTP failure.
    let outcome = 'uncertain';
    try {
      const result = await this.sendAlert(this.owner, claim);
      if (result?.accepted === true) outcome = 'accepted';
      else if (result?.definitelyNotAccepted === true) outcome = 'failed';
    } catch {}
    await this.bridge.finishWatchdogAlert(this.owner, claim.eventId, outcome, this.clock());
  }
  stop() {
    this.running = false;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }
  async stopAndWait() { this.stop(); if (this.current) await this.current; }
}
