import { api, ApiError, poll } from '../lib/api.js';
import { badge, extLink, field, h, pre, table, verdictBadge } from '../lib/dom.js';
import { action, errorBox } from '../lib/ui.js';

/** The trust block of a scrape: verdict, why, which engine, injection findings and a link to the receipt. */
export function trustPanel(trust) {
  if (!trust) return null;
  const inj = trust.injection;
  return h(
    'div',
    { class: 'panel' },
    table([
      ['Verdict', h('span', {}, verdictBadge(trust.verdict), ` confidence ${trust.confidence}`)],
      ['Reasons', trust.reasons?.length ? trust.reasons.join(', ') : 'none'],
      ['Engine', trust.engine],
      ['Receipt', trust.receiptId ? h('a', { href: `#/receipts/${trust.receiptId}` }, trust.receiptId) : '-'],
      [
        'Prompt injection',
        inj ? (inj.flagged ? badge(`flagged (${inj.highest}, ${inj.count})`, 'bad') : badge(`clean (${inj.count} note(s))`, 'good')) : 'not scanned',
      ],
    ]),
    inj?.flagged && inj.findings?.length
      ? h('ul', {}, ...inj.findings.slice(0, 8).map((f) => h('li', {}, `[${f.severity}] ${f.rule}${f.hidden ? ' (hidden)' : ''}: `, h('code', {}, f.excerpt))))
      : null,
  );
}

/** A scrape document as returned by /v2/scrape or /v2/parse. */
export function documentView(data) {
  const parts = [trustPanel(data.trust)];
  if (data.metadata) parts.push(table([['Title', data.metadata.title ?? '-'], ['URL', data.metadata.sourceURL ?? '-'], ['Status code', data.metadata.statusCode ?? '-']]));
  if (data.warning) parts.push(h('div', { class: 'notice' }, data.warning));
  if (data.markdown !== undefined) parts.push(h('h2', {}, 'Markdown'), pre(data.markdown));
  if (data.summary) parts.push(h('h2', {}, 'Summary'), pre(data.summary));
  if (data.json) parts.push(h('h2', {}, 'JSON'), pre(data.json));
  if (data.links?.length) parts.push(h('h2', {}, `Links (${data.links.length})`), h('ul', {}, ...data.links.slice(0, 50).map((l) => h('li', {}, extLink(l)))));
  if (data.html) parts.push(h('h2', {}, 'HTML'), pre(data.html));
  parts.push(h('details', {}, h('summary', {}, 'Raw response'), pre(data)));
  return parts;
}

/** A failed scrape is still informative: show the error and its trust block. */
function failureView(err) {
  if (err instanceof ApiError && err.body?.trust) return [errorBox(err), trustPanel(err.body.trust)];
  return [errorBox(err)];
}

const textInput = (id, value = '', placeholder = '') => h('input', { id, type: 'text', value, placeholder });
const checkbox = (id, label, checked = false) => h('label', { class: 'row' }, h('input', { id, type: 'checkbox', checked }), label);
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function scrapeTab() {
  const url = textInput('url', 'https://example.com/', 'https://…');
  const formats = ['markdown', 'html', 'links', 'screenshot', 'summary'].map((f) => checkbox(`f-${f}`, f, f === 'markdown'));
  const main = checkbox('main', 'only main content', true);
  const proxy = h('select', {}, ...['auto', 'basic', 'enhanced', 'stealth'].map((p) => h('option', { value: p }, p)));
  const out = h('div', {});
  const run = h('button', {}, 'Scrape');
  action(run, out, async () => {
    const chosen = formats.map((l) => l.firstChild).filter((i) => i.checked).map((i) => i.id.slice(2));
    try {
      const res = await api.post('/v2/scrape', { url: url.value.trim(), formats: chosen.length ? chosen : ['markdown'], onlyMainContent: main.firstChild.checked, proxy: proxy.value });
      const shot = res.data.screenshot;
      const view = documentView(res.data);
      if (shot) {
        if (/^data:image\/png;base64,/.test(shot)) {
          const img = h('img', { alt: 'screenshot' });
          img.src = shot;
          view.splice(1, 0, img);
        }
      }
      return view;
    } catch (err) {
      return failureView(err);
    }
  });
  return h('div', {}, field('URL', url), h('div', { class: 'row' }, ...formats, main), field('Proxy', proxy), run, out);
}

function parseTab() {
  const file = h('input', { type: 'file' });
  const out = h('div', {});
  const run = h('button', {}, 'Parse file');
  action(run, out, async () => {
    if (!file.files?.length) throw new Error('Choose a file first.');
    const form = new FormData();
    form.append('file', file.files[0], file.files[0].name);
    try {
      return documentView((await api.upload('/v2/parse', form)).data);
    } catch (err) {
      return failureView(err);
    }
  });
  return h('div', {}, h('p', { class: 'muted' }, 'pdf, docx, xlsx, pptx, odt, ods, odp, epub, rtf, csv, html, txt.'), field('File', file), run, out);
}

function searchTab() {
  const query = textInput('q', '', 'what to search for');
  const out = h('div', {});
  const run = h('button', {}, 'Search the web');
  const idx = h('button', { class: 'secondary' }, 'Search stored pages');
  action(run, out, async () => {
    const res = await api.post('/v2/search', { query: query.value.trim(), limit: 8 });
    const web = res.data.web ?? [];
    return [res.warning ? h('div', { class: 'notice' }, res.warning) : null, web.length === 0 ? h('p', { class: 'muted' }, 'No results.') : h('ul', {}, ...web.map((r) => h('li', {}, extLink(r.url, r.title || r.url), h('div', { class: 'muted' }, r.description ?? ''))))];
  });
  action(idx, out, async () => {
    const res = await api.post('/v2/index/search', { query: query.value.trim(), limit: 10 });
    const items = res.data.results;
    return [
      res.warning ? h('div', { class: 'notice' }, res.warning) : null,
      items.length === 0
        ? h('p', { class: 'muted' }, 'Nothing stored matches.')
        : h('ul', {}, ...items.map((r) => h('li', {}, badge(r.source), ' ', extLink(r.url, r.title || r.url), r.receiptId ? h('span', {}, ' ', h('a', { href: `#/receipts/${r.receiptId}` }, 'receipt')) : null, h('div', { class: 'muted' }, r.snippet)))),
    ];
  });
  return h('div', {}, field('Query', query), h('div', { class: 'row' }, run, idx), out);
}

function extractTab() {
  const urls = h('textarea', { placeholder: 'one URL per line' });
  const prompt = textInput('p', '', 'what to extract');
  const schema = h('textarea', { placeholder: 'optional JSON Schema' });
  const out = h('div', {});
  const run = h('button', {}, 'Extract');
  action(run, out, async () => {
    const body = { urls: lines(urls.value), prompt: prompt.value.trim() || undefined, schema: schema.value.trim() ? JSON.parse(schema.value) : undefined };
    const { id } = await api.post('/v2/extract', body);
    const s = await poll(() => api.get(`/v2/extract/${id}`));
    if (s.status !== 'completed') return [errorBox(new Error(`${s.code ?? 'failed'}: ${s.error}`))];
    const g = s.trust?.extraction?.grounding;
    return [
      g ? h('div', { class: g.ungrounded > 0 ? 'notice' : 'panel' }, `Checked against the pages: ${g.grounded} found, ${g.partial} partly, ${g.ungrounded} not found.`) : null,
      pre(s.data),
      s.trust?.sources?.length ? h('ul', {}, ...s.trust.sources.map((p) => h('li', {}, p.url, ' ', verdictBadge(p.verdict), ' ', h('a', { href: `#/receipts/${p.receiptId}` }, 'receipt')))) : null,
    ];
  });
  return h('div', {}, field('URLs', urls), field('Prompt', prompt), field('Schema', schema), run, out);
}

function agentTab() {
  const prompt = h('textarea', { placeholder: 'What should the agent find out?' });
  const urls = textInput('au', '', 'optional starting URLs, separated by spaces');
  const strict = checkbox('strict', 'only read these URLs', false);
  const effort = h('select', {}, ...['low', 'medium', 'high'].map((p) => h('option', { value: p, selected: p === 'medium' }, p)));
  const out = h('div', {});
  const run = h('button', {}, 'Run agent');
  action(run, out, async () => {
    const { id } = await api.post('/v2/agent', {
      prompt: prompt.value.trim(),
      urls: urls.value.split(/\s+/).filter(Boolean),
      strictConstrainToURLs: strict.firstChild.checked,
      effort: effort.value,
    });
    const s = await poll(() => api.get(`/v2/agent/${id}`), { intervalMs: 2000 });
    const trace = await api.get(`/v2/agent/${id}/trace`);
    return [
      s.status === 'completed' ? h('div', {}, h('h2', {}, 'Answer'), pre(s.data)) : errorBox(new Error(`${s.code ?? 'failed'}: ${s.error}`)),
      s.sources?.length ? h('ul', {}, ...s.sources.map((p) => h('li', {}, p.url, ' ', h('a', { href: `#/receipts/${p.receiptId}` }, 'receipt')))) : null,
      traceView(trace.events),
    ];
  });
  return h('div', {}, field('Task', prompt), field('Start from', urls), h('div', { class: 'row' }, strict, field('Effort', effort)), run, out);
}

/** Steps of an agent run: what it thought and which tools it used. */
export function traceView(events) {
  const rows = events
    .filter((e) => ['reasoning.summary', 'tool_call.started', 'error.occurred', 'run.finished'].includes(e.type))
    .map((e) => {
      if (e.type === 'reasoning.summary') return ['thought', e.text];
      if (e.type === 'tool_call.started') return [e.toolName, JSON.stringify(e.parameters)];
      if (e.type === 'error.occurred') return ['error', e.error?.message ?? ''];
      return ['finished', e.outcome];
    });
  return h('details', { open: true }, h('summary', {}, `Trace (${rows.length} steps)`), h('table', {}, ...rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))));
}

const TABS = [['scrape', 'Scrape', scrapeTab], ['parse', 'Parse', parseTab], ['search', 'Search', searchTab], ['extract', 'Extract', extractTab], ['agent', 'Agent', agentTab]];

export async function playgroundPage({ args }) {
  const current = TABS.find((t) => t[0] === args[0]) ?? TABS[0];
  return h(
    'div',
    {},
    h('h1', {}, 'Playground'),
    h('div', { class: 'tabs' }, ...TABS.map(([id, label]) => h('button', { class: id === current[0] ? 'current' : '', onClick: () => (location.hash = `#/playground/${id}`) }, label))),
    h('div', { class: 'panel' }, current[2]()),
  );
}
