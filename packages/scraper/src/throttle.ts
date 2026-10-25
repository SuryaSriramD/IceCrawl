/**
 * Spaces requests to the same host at least `intervalMs` apart. Used for traffic that goes through the operator's
 * proxy pool, so that escalating to a proxy never turns into hammering a site.
 * shortcut: state is per process; with several API or worker processes each keeps its own pace. Upgrade to a Redis key per host.
 */
export class HostThrottle {
  private readonly nextSlot = new Map<string, number>();

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async wait(host: string): Promise<void> {
    if (this.intervalMs <= 0) return;
    const now = this.now();
    if (this.nextSlot.size > 1000) for (const [h, at] of this.nextSlot) if (at <= now) this.nextSlot.delete(h);
    const at = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, at + this.intervalMs);
    if (at > now) await this.sleep(at - now);
  }
}
