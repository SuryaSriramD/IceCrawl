export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the current window ends. */
  resetMs: number;
}

export interface RateLimiter {
  hit(key: string): Promise<RateLimitResult>;
}

/** Fixed-window limiter for one process (tests, single-node setups without Redis). */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async hit(key: string): Promise<RateLimitResult> {
    const t = this.now();
    if (this.windows.size > 10_000) {
      for (const [k, w] of this.windows) if (w.resetAt <= t) this.windows.delete(k);
    }
    let w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + this.windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    return { allowed: w.count <= this.limit, limit: this.limit, remaining: Math.max(0, this.limit - w.count), resetMs: w.resetAt - t };
  }
}

/** The one Redis command the limiter needs; ioredis satisfies it. */
export interface RedisEval {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

// INCR and the expiry in one atomic step: a crash between the two must not leave a key that never expires.
const WINDOW_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('PTTL', KEYS[1])}
`;

/** Fixed-window limiter shared by every API and worker process through Redis. */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisEval,
    private readonly prefix: string,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  async hit(key: string): Promise<RateLimitResult> {
    const [count, ttl] = (await this.redis.eval(WINDOW_SCRIPT, 1, `${this.prefix}:rl:${key}`, this.windowMs)) as [number, number];
    return {
      allowed: count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - count),
      resetMs: ttl > 0 ? ttl : this.windowMs,
    };
  }
}
