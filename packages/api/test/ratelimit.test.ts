import { randomUUID } from 'node:crypto';
import IORedis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryRateLimiter, RedisRateLimiter } from '../src/ratelimit';

describe('MemoryRateLimiter', () => {
  it('allows the limit, refuses the next request and reports the window', async () => {
    let now = 1_000_000;
    const limiter = new MemoryRateLimiter(2, 60_000, () => now);
    expect(await limiter.hit('k')).toEqual({ allowed: true, limit: 2, remaining: 1, resetMs: 60_000 });
    now += 10_000;
    expect(await limiter.hit('k')).toEqual({ allowed: true, limit: 2, remaining: 0, resetMs: 50_000 });
    expect(await limiter.hit('k')).toMatchObject({ allowed: false, remaining: 0, resetMs: 50_000 });
  });

  it('starts a new window when the old one ends, and keeps keys apart', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(1, 1000, () => now);
    expect((await limiter.hit('a')).allowed).toBe(true);
    expect((await limiter.hit('a')).allowed).toBe(false);
    expect((await limiter.hit('b')).allowed).toBe(true);
    now = 1000;
    expect((await limiter.hit('a')).allowed).toBe(true);
  });
});

const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)('RedisRateLimiter', () => {
  const redis = new IORedis(redisUrl ?? 'redis://unused', { lazyConnect: true, maxRetriesPerRequest: 1 });
  const prefix = `icecrawl-test-${randomUUID().slice(0, 8)}`;
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });

  it('counts across callers, refuses over the limit and expires the window', async () => {
    const a = new RedisRateLimiter(redis, prefix, 2, 400);
    const b = new RedisRateLimiter(redis, prefix, 2, 400);
    expect((await a.hit('k')).allowed).toBe(true);
    const second = await b.hit('k');
    expect(second).toMatchObject({ allowed: true, remaining: 0 });
    expect(second.resetMs).toBeGreaterThan(0);
    expect(second.resetMs).toBeLessThanOrEqual(400);
    expect(await a.hit('k')).toMatchObject({ allowed: false, remaining: 0 });
    expect((await a.hit('other')).allowed).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect((await a.hit('k')).allowed).toBe(true);
  });

  it('always leaves the counter with an expiry', async () => {
    const limiter = new RedisRateLimiter(redis, prefix, 5, 60_000);
    await limiter.hit('ttl');
    expect(await redis.pttl(`${prefix}:rl:ttl`)).toBeGreaterThan(0);
  });
});
