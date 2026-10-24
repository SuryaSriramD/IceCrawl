import { getDomain } from 'tldts';

export function normalizeUrl(raw: string, o: { ignoreQueryParameters: boolean }): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  if (o.ignoreQueryParameters) u.search = '';
  else u.searchParams.sort();
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.toString();
}

export type HostRelation = 'same' | 'subdomain' | 'external';

const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, '');

export function hostRelation(host: string, baseHost: string): HostRelation {
  const a = stripWww(host);
  const b = stripWww(baseHost);
  if (a === b) return 'same';
  const da = getDomain(a, { allowPrivateDomains: true });
  const db = getDomain(b, { allowPrivateDomains: true });
  return da !== null && da === db ? 'subdomain' : 'external';
}

const ASSET = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|map|woff2?|ttf|otf|eot|mp4|webm|mov|avi|mp3|wav|ogg|zip|gz|tgz|tar|rar|7z|exe|dmg|iso|apk)$/i;

export function isAssetPath(pathname: string): boolean {
  return ASSET.test(pathname);
}
