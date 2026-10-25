import { api, ApiError } from '../lib/api.js';
import { badge, field, fmtDate, h, pre, table } from '../lib/dom.js';
import { action } from '../lib/ui.js';
import { traceView } from './playground.js';

const KINDS = [
  ['crawl', '/v2/crawl/'],
  ['batch', '/v2/batch/scrape/'],
  ['extract', '/v2/extract/'],
  ['agent', '/v2/agent/'],
];

const statusKind = (s) => (s === 'completed' ? 'good' : s === 'failed' || s === 'cancelled' ? 'bad' : 'warn');

/** Finds a job by id by asking each endpoint in turn (ids are random, so at most one answers). */
async function lookup(id) {
  for (const [kind, base] of KINDS) {
    try {
      return { kind, job: await api.get(`${base}${encodeURIComponent(id)}`) };
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 404 || err.status === 400))) throw err;
    }
  }
  throw new Error('No crawl, batch, extract or agent job with that id belongs to this key (jobs expire after a day).');
}

async function show(id) {
  const { kind, job } = await lookup(id);
  const parts = [
    h('h2', {}, `${kind} job`),
    h('div', { class: 'panel' }, table([
      ['Status', badge(job.status, statusKind(job.status))],
      ...(job.total !== undefined ? [['Pages', `${job.completed ?? 0} of ${job.total} (${job.creditsUsed ?? '-'} metered)`]] : []),
      ...(job.expiresAt ? [['Expires', fmtDate(job.expiresAt)]] : []),
      ...(job.error ? [['Error', `${job.code ?? ''} ${job.error}`]] : []),
    ])),
  ];
  if (kind === 'agent') {
    const trace = await api.get(`/v2/agent/${encodeURIComponent(id)}/trace`);
    if (job.data) parts.push(h('h2', {}, 'Answer'), pre(job.data));
    parts.push(traceView(trace.events));
  } else if (kind === 'extract' && job.data) {
    parts.push(h('h2', {}, 'Data'), pre(job.data));
  } else if (Array.isArray(job.data)) {
    parts.push(
      h('h2', {}, `Pages (${job.data.length} loaded)`),
      h('table', {}, ...job.data.slice(0, 100).map((d) => h('tr', {}, h('td', {}, d.metadata?.sourceURL ?? ''), h('td', {}, d.trust?.verdict ?? ''), h('td', {}, d.trust?.receiptId ? h('a', { href: `#/receipts/${d.trust.receiptId}` }, 'receipt') : '')))),
    );
    const errors = await api.get(`/v2/${kind === 'batch' ? 'batch/scrape' : 'crawl'}/${encodeURIComponent(id)}/errors`).catch(() => null);
    if (errors?.errors?.length) parts.push(h('h2', {}, 'Errors'), h('table', {}, ...errors.errors.slice(0, 50).map((e) => h('tr', {}, h('td', {}, e.url), h('td', {}, e.error)))));
  }
  parts.push(h('details', {}, h('summary', {}, 'Raw response'), pre({ ...job, data: Array.isArray(job.data) ? `[${job.data.length} pages]` : job.data })));
  return parts;
}

export async function jobsPage({ args }) {
  const filter = h('select', {}, ...['', 'scrape', 'crawl', 'batch_scrape', 'extract'].map((e) => h('option', { value: e }, e || 'all endpoints')));
  const list = h('div', {});
  const loadList = async () => {
    const q = filter.value ? `&endpoint=${filter.value}` : '';
    const res = await api.get(`/v2/team/activity?limit=30${q}`);
    list.replaceChildren(
      res.data.length === 0
        ? h('p', { class: 'muted' }, 'No activity.')
        : h('table', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Endpoint'), h('th', {}, 'Page'), h('th', {}, 'Id')), ...res.data.map((r) => h('tr', {}, h('td', {}, fmtDate(r.created_at)), h('td', {}, r.endpoint), h('td', {}, r.target), h('td', {}, h('a', { href: `#/receipts/${r.id}` }, r.id.slice(0, 8)))))),
    );
  };
  filter.addEventListener('change', () => void loadList());
  await loadList();

  const input = h('input', { type: 'text', value: args[0] ?? '', placeholder: 'job id from a crawl, batch, extract or agent start' });
  const out = h('div', {});
  const run = h('button', {}, 'Look up');
  action(run, out, () => show(input.value.trim()));
  if (args[0]) queueMicrotask(() => run.click());

  return h('div', {}, h('h1', {}, 'Jobs'), h('div', { class: 'panel' }, field('Job id', input), run, out), h('h2', {}, 'Recent scrapes'), h('div', { class: 'row' }, filter), h('div', { class: 'panel' }, list));
}
