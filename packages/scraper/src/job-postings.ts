import { parseHTML } from 'linkedom';

/** One job, in the same shape whether it came from a page's JSON-LD or from a company's applicant-tracking system. */
export interface JobPosting {
  title: string;
  company?: string;
  location?: string;
  remote?: boolean;
  employmentType?: string;
  salary?: string;
  postedAt?: string;
  validThrough?: string;
  description?: string;
  url?: string;
  applyUrl?: string;
  source: 'json-ld' | 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'smartrecruiters' | 'recruitee';
}

const text = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object' && 'name' in v) return text((v as { name: unknown }).name);
  return undefined;
};

/** HTML to plain text, for descriptions that schema.org says are HTML. */
export function htmlToText(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function place(loc: unknown): string | undefined {
  const parts = (Array.isArray(loc) ? loc : [loc]).map((l) => {
    const a = (l as { address?: unknown } | undefined)?.address;
    if (typeof a === 'string') return a.trim();
    if (a && typeof a === 'object') {
      const o = a as Record<string, unknown>;
      return [text(o.addressLocality), text(o.addressRegion), text(o.addressCountry)].filter(Boolean).join(', ');
    }
    return text(l);
  });
  return parts.filter(Boolean).join('; ') || undefined;
}

function pay(base: unknown): string | undefined {
  const b = base as { currency?: unknown; value?: unknown } | undefined;
  if (!b || typeof b !== 'object') return undefined;
  const v = b.value as { minValue?: unknown; maxValue?: unknown; value?: unknown; unitText?: unknown } | number | string | undefined;
  const amount = typeof v === 'object' && v !== null ? (v.minValue !== undefined && v.maxValue !== undefined ? `${v.minValue}-${v.maxValue}` : text(v.value ?? v.minValue ?? v.maxValue)) : text(v);
  if (!amount) return undefined;
  const unit = typeof v === 'object' && v !== null ? text(v.unitText) : undefined;
  return [text(b.currency), amount, unit && `per ${unit.toLowerCase()}`].filter(Boolean).join(' ');
}

function toPosting(o: Record<string, unknown>, baseUrl: string): JobPosting | null {
  const title = text(o.title);
  if (!title) return null;
  const description = typeof o.description === 'string' ? htmlToText(o.description) : undefined;
  const url = text(o.url);
  const apply = text(o.directApply) ? undefined : text((o.potentialAction as { target?: unknown } | undefined)?.target);
  const abs = (u?: string) => {
    if (!u) return undefined;
    try {
      return new URL(u, baseUrl).href;
    } catch {
      return undefined;
    }
  };
  const employment = o.employmentType;
  return {
    title,
    company: text(o.hiringOrganization),
    location: place(o.jobLocation),
    ...(text(o.jobLocationType)?.toUpperCase() === 'TELECOMMUTE' ? { remote: true } : {}),
    employmentType: (Array.isArray(employment) ? employment.map(text).filter(Boolean).join(', ') : text(employment)) || undefined,
    salary: pay(o.baseSalary),
    postedAt: text(o.datePosted),
    validThrough: text(o.validThrough),
    description: description?.slice(0, 20_000),
    url: abs(url) ?? baseUrl,
    applyUrl: abs(apply),
    source: 'json-ld',
  };
}

function walk(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, out));
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  const type = o['@type'];
  if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) out.push(o);
  for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity']) walk(o[key], out);
}

/** The schema.org JobPosting records embedded in a page (`<script type="application/ld+json">`), as plain data. */
export function jobPostingsFromHtml(html: string, baseUrl: string): JobPosting[] {
  const { document } = parseHTML(html);
  const found: Record<string, unknown>[] = [];
  for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      walk(JSON.parse(s.textContent ?? ''), found);
    } catch {
      // a script with broken JSON is skipped, the rest of the page is still read
    }
  }
  const seen = new Set<string>();
  return found
    .map((o) => toPosting(o, baseUrl))
    .filter((p): p is JobPosting => p !== null)
    .filter((p) => {
      const key = `${p.title}|${p.location ?? ''}|${p.url}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
}
