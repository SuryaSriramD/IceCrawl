import type { Baseline, CheckRecord, CheckStatus, MonitorRecord, MonitorStore, NewMonitor, PageRecord, PageStatus } from '../monitor/types';

const now = () => new Date().toISOString();

export class MemoryMonitorStore implements MonitorStore {
  private readonly monitors = new Map<string, MonitorRecord>();
  private readonly checks = new Map<string, CheckRecord>();
  private readonly pages: PageRecord[] = [];
  private readonly baselines = new Map<string, Baseline>();

  async createMonitor(m: NewMonitor): Promise<MonitorRecord> {
    const rec: MonitorRecord = { ...structuredClone(m), lastRunAt: null, currentCheckId: null, lastCheckSummary: null, createdAt: now(), updatedAt: now() };
    this.monitors.set(rec.id, rec);
    return structuredClone(rec);
  }
  async getMonitor(id: string) {
    const m = this.monitors.get(id);
    return m ? structuredClone(m) : null;
  }
  async listMonitors(apiKeyId: string | null, limit: number, offset: number) {
    return [...this.monitors.values()]
      .filter((m) => m.apiKeyId === apiKeyId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(offset, offset + limit)
      .map((m) => structuredClone(m));
  }
  async updateMonitor(id: string, patch: Partial<MonitorRecord>) {
    const m = this.monitors.get(id);
    if (!m) return null;
    Object.assign(m, structuredClone(patch), { updatedAt: now() });
    return structuredClone(m);
  }
  async deleteMonitor(id: string) {
    for (const [cid, c] of this.checks) if (c.monitorId === id) this.dropCheck(cid);
    for (const k of [...this.baselines.keys()]) if (k.startsWith(`${id}|`)) this.baselines.delete(k);
    return this.monitors.delete(id);
  }
  async claimDue(at: Date, limit: number, advance: (m: MonitorRecord) => Date | null) {
    const due = [...this.monitors.values()]
      .filter((m) => m.status === 'active' && m.nextRunAt !== null && Date.parse(m.nextRunAt) <= at.getTime())
      .sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!))
      .slice(0, limit);
    const claimed = due.map((m) => structuredClone(m));
    for (const m of due) m.nextRunAt = advance(structuredClone(m))?.toISOString() ?? null;
    return claimed;
  }

  async createCheck(c: Omit<CheckRecord, 'createdAt' | 'updatedAt'>) {
    const rec: CheckRecord = { ...structuredClone(c), createdAt: now(), updatedAt: now() };
    this.checks.set(rec.id, rec);
    return structuredClone(rec);
  }
  async getCheck(monitorId: string, checkId: string) {
    const c = this.checks.get(checkId);
    return c && c.monitorId === monitorId ? structuredClone(c) : null;
  }
  async findCheck(checkId: string) {
    const c = this.checks.get(checkId);
    return c ? structuredClone(c) : null;
  }
  async listChecks(monitorId: string, o: { limit: number; offset: number; status?: CheckStatus }) {
    return [...this.checks.values()]
      .filter((c) => c.monitorId === monitorId && (!o.status || c.status === o.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(o.offset, o.offset + o.limit)
      .map((c) => structuredClone(c));
  }
  async updateCheck(id: string, patch: Partial<CheckRecord>) {
    const c = this.checks.get(id);
    if (c) Object.assign(c, structuredClone(patch), { updatedAt: now() });
  }

  async addPage(p: Omit<PageRecord, 'createdAt'>) {
    this.pages.push({ ...structuredClone(p), createdAt: now() });
  }
  async listPages(checkId: string, o: { skip: number; limit: number; status?: PageStatus }) {
    return this.pages
      .filter((p) => p.checkId === checkId && (!o.status || p.status === o.status))
      .slice(o.skip, o.skip + o.limit)
      .map((p) => structuredClone(p));
  }

  async listBaselines(monitorId: string) {
    return [...this.baselines.values()].filter((b) => b.monitorId === monitorId).map((b) => structuredClone(b));
  }
  async upsertBaseline(b: Baseline) {
    this.baselines.set(`${b.monitorId}|${b.url}`, structuredClone(b));
  }
  async deleteBaselines(monitorId: string, urls: string[]) {
    for (const u of urls) this.baselines.delete(`${monitorId}|${u}`);
  }

  private dropCheck(id: string) {
    this.checks.delete(id);
    for (let i = this.pages.length - 1; i >= 0; i--) if (this.pages[i].checkId === id) this.pages.splice(i, 1);
  }
  async deleteExpiredChecks(at: Date) {
    let n = 0;
    for (const c of [...this.checks.values()]) {
      const days = this.monitors.get(c.monitorId)?.retentionDays ?? 30;
      if (Date.parse(c.createdAt) < at.getTime() - days * 86_400_000) {
        this.dropCheck(c.id);
        n++;
      }
    }
    return n;
  }
  async failStaleChecks(olderThan: Date) {
    let n = 0;
    for (const c of this.checks.values()) {
      if ((c.status === 'queued' || c.status === 'running') && Date.parse(c.createdAt) < olderThan.getTime()) {
        Object.assign(c, { status: 'failed', error: 'The check did not finish in time and was stopped.', finishedAt: now(), updatedAt: now() });
        const m = this.monitors.get(c.monitorId);
        if (m?.currentCheckId === c.id) m.currentCheckId = null;
        n++;
      }
    }
    return n;
  }
}
