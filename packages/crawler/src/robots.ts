import robotsParser from 'robots-parser';

export type Fetcher = (url: string) => Promise<{ status: number; body: Uint8Array }>;

export interface RobotsRules {
  allowed(url: string): boolean;
  crawlDelaySeconds: number | null;
  sitemaps: string[];
}

export const ALLOW_ALL: RobotsRules = { allowed: () => true, crawlDelaySeconds: null, sitemaps: [] };
export const DISALLOW_ALL: RobotsRules = { allowed: () => false, crawlDelaySeconds: null, sitemaps: [] };

export function parseRobots(text: string, robotsUrl: string, userAgent: string): RobotsRules {
  const robots = robotsParser(robotsUrl, text);
  return {
    allowed: (url) => robots.isAllowed(url, userAgent) !== false,
    crawlDelaySeconds: robots.getCrawlDelay(userAgent) ?? null,
    sitemaps: robots.getSitemaps(),
  };
}

/** RFC 9309: 2xx parse, 4xx means no restrictions, 5xx or an unreachable server means assume everything is disallowed. */
export async function loadRobots(origin: string, fetcher: Fetcher, userAgent: string): Promise<RobotsRules> {
  const robotsUrl = new URL('/robots.txt', origin).toString();
  let res: { status: number; body: Uint8Array };
  try {
    res = await fetcher(robotsUrl);
  } catch {
    return DISALLOW_ALL;
  }
  if (res.status >= 500) return DISALLOW_ALL;
  if (res.status >= 400) return ALLOW_ALL;
  return parseRobots(Buffer.from(res.body).toString('utf8'), robotsUrl, userAgent);
}
