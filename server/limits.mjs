import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const japanDay = (now = Date.now()) => new Date(now + 9 * 3600000).toISOString().slice(0, 10);

// One Node process owns this file. Reserve synchronously before any network await.
// A failed upstream attempt also consumes a slot; there are no automatic retries.
export class UsageLedger {
  constructor(directory, { sessionLimit = 10, globalLimit = 500, clock = Date.now } = {}) {
    mkdirSync(directory, { recursive: true });
    this.file = join(directory, 'usage.json');
    this.sessionLimit = sessionLimit;
    this.globalLimit = globalLimit;
    this.clock = clock;
    try { this.state = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Usage ledger could not be loaded. Refusing to reset quotas.');
      this.state = { day: japanDay(clock()), total: 0, sessions: {} };
    }
    if (typeof this.state.day !== 'string' || !Number.isInteger(this.state.total) || this.state.total < 0 || !this.state.sessions || typeof this.state.sessions !== 'object' || Array.isArray(this.state.sessions)) throw new Error('Invalid usage ledger.');
  }
  refresh() {
    if (this.state.day !== japanDay(this.clock())) this.state = { day: japanDay(this.clock()), total: 0, sessions: {} };
  }
  status(id) {
    this.refresh();
    return {
      remaining: Math.max(0, this.sessionLimit - (this.state.sessions[id]?.count || 0)),
      limit: this.sessionLimit,
      globalAvailable: this.state.total < this.globalLimit,
      day: this.state.day,
    };
  }
  reserve(id) {
    const status = this.status(id);
    if (!status.globalAvailable) return { ok: false, code: 'DAILY_LIMIT', ...status };
    if (!status.remaining) return { ok: false, code: 'SESSION_LIMIT', ...status };
    const now = this.clock();
    const session = this.state.sessions[id] || { count: 0, recent: [] };
    const recent = session.recent.filter(time => now - time < 60000);
    if (recent.length >= 3) return { ok: false, code: 'TOO_FAST', ...status };
    const next = { ...this.state, total: this.state.total + 1, sessions: { ...this.state.sessions, [id]: { count: session.count + 1, recent: [...recent, now] } } };
    writeFileSync(this.file + '.tmp', JSON.stringify(next), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
    this.state = next;
    return { ok: true, ...this.status(id) };
  }
}
