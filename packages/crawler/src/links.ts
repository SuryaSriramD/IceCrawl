import { hostRelation, isAssetPath } from './url';

export interface CrawlScope {
  baseUrl: URL;
  includePaths: RegExp[];
  excludePaths: RegExp[];
  regexOnFullURL: boolean;
  crawlEntireDomain: boolean;
  allowExternalLinks: boolean;
  allowSubdomains: boolean;
  maxDiscoveryDepth?: number;
}

export function buildScope(
  baseUrl: string,
  o: {
    includePaths?: string[];
    excludePaths?: string[];
    regexOnFullURL?: boolean;
    crawlEntireDomain?: boolean;
    allowExternalLinks?: boolean;
    allowSubdomains?: boolean;
    maxDiscoveryDepth?: number;
  } = {},
): CrawlScope {
  return {
    baseUrl: new URL(baseUrl),
    includePaths: (o.includePaths ?? []).map((p) => new RegExp(p)),
    excludePaths: (o.excludePaths ?? []).map((p) => new RegExp(p)),
    regexOnFullURL: o.regexOnFullURL ?? false,
    crawlEntireDomain: o.crawlEntireDomain ?? false,
    allowExternalLinks: o.allowExternalLinks ?? false,
    allowSubdomains: o.allowSubdomains ?? false,
    maxDiscoveryDepth: o.maxDiscoveryDepth,
  };
}

export type LinkDecision =
  | { follow: true; external: boolean }
  | { follow: false; reason: 'scheme' | 'asset' | 'depth' | 'external' | 'subdomain' | 'out-of-scope' | 'excluded' | 'not-included' };

const no = (reason: Extract<LinkDecision, { follow: false }>['reason']): LinkDecision => ({ follow: false, reason });

function inChildScope(path: string, basePath: string): boolean {
  const base = basePath.replace(/\/+$/, '');
  const p = path.replace(/\/+$/, '');
  return base === '' || p === base || p.startsWith(`${base}/`);
}

export function decideLink(link: string, depth: number, scope: CrawlScope): LinkDecision {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return no('scheme');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return no('scheme');
  if (isAssetPath(u.pathname)) return no('asset');
  if (scope.maxDiscoveryDepth !== undefined && depth > scope.maxDiscoveryDepth) return no('depth');

  const relation = hostRelation(u.hostname, scope.baseUrl.hostname);
  let external = false;
  if (relation === 'subdomain' && !scope.allowSubdomains) {
    if (!scope.allowExternalLinks) return no('subdomain');
    external = true;
  } else if (relation === 'external') {
    if (!scope.allowExternalLinks) return no('external');
    external = true;
  }

  if (relation === 'same' && !scope.crawlEntireDomain && !inChildScope(u.pathname, scope.baseUrl.pathname)) {
    return no('out-of-scope');
  }

  const target = scope.regexOnFullURL ? u.toString() : u.pathname;
  if (scope.excludePaths.some((r) => r.test(target))) return no('excluded');
  if (scope.includePaths.length > 0 && !scope.includePaths.some((r) => r.test(target))) return no('not-included');
  return { follow: true, external };
}
