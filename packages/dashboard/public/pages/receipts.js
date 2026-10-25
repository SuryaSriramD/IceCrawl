import { api, ApiError } from '../lib/api.js';
import { verifyReceipt } from '../lib/receipt.js';
import { badge, copyable, field, fmtDate, h, pre, table, verdictBadge } from '../lib/dom.js';
import { action } from '../lib/ui.js';

const statusBadge = (c) => badge(c.status, c.status === 'pass' ? 'good' : c.status === 'fail' ? 'bad' : 'warn');
const optionalBytes = async (path) => {
  try {
    return await api.bytes(path);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
};

async function load(id) {
  const [r, keys] = await Promise.all([api.get(`/v2/receipts/${id}`), fetch('/.well-known/icecrawl-keys.json').then((x) => x.json())]);
  const signed = { receipt: r.data, signature: r.signature };
  const [snapshot, screenshot] = await Promise.all([optionalBytes(`/v2/receipts/${id}/snapshot`), r.data.screenshotSha256 ? optionalBytes(`/v2/receipts/${id}/screenshot`) : null]);
  const report = await verifyReceipt(signed, keys.keys, snapshot, screenshot);
  const rc = r.data;
  return [
    h('h2', {}, report.ok ? 'Checks passed' : 'A check failed'),
    h(
      'div',
      { class: 'panel' },
      table([
        ['Signature', h('span', {}, statusBadge(report.signature), ' ', report.signature.detail)],
        ['Snapshot', h('span', {}, statusBadge(report.snapshot), ' ', report.snapshot.detail)],
        ['Screenshot', h('span', {}, statusBadge(report.screenshot), ' ', report.screenshot.detail)],
        ['Converter replay', 'not run in the browser; run the command below'],
      ]),
      h('pre', {}, `icecrawl verify ${id} --api ${location.origin} --key YOUR_KEY`),
    ),
    h('h2', {}, 'Receipt'),
    h(
      'div',
      { class: 'panel' },
      table([
        ['Requested', rc.requestedUrl],
        ['Final URL', rc.finalUrl],
        ['Status code', rc.statusCode],
        ['Fetched', fmtDate(rc.fetchedAt)],
        ['Content type', rc.contentType ?? '-'],
        ['Snapshot sha256', copyable(rc.htmlSha256 ?? '-')],
        ['Output sha256', copyable(rc.outputSha256 ?? '-')],
        ['Converter', `${rc.converter?.name}@${rc.converter?.version}`],
        ['Injection scan', rc.scan === undefined ? 'predates scanning' : rc.scan === null ? 'off' : rc.scan.flagged ? badge(`flagged (${rc.scan.highest}, ${rc.scan.count})`, 'bad') : badge('clean', 'good')],
      ]),
      h('h2', {}, 'Engine attempts'),
      h(
        'table',
        {},
        h('tr', {}, h('th', {}, 'Engine'), h('th', {}, 'Verdict'), h('th', {}, 'Reasons'), h('th', {}, 'Proxy tier'), h('th', {}, 'ms')),
        ...rc.engineChain.map((a) => h('tr', {}, h('td', {}, a.engine), h('td', {}, verdictBadge(a.verdict)), h('td', {}, (a.reasons ?? []).join(', ')), h('td', {}, a.proxyTier ?? 'direct'), h('td', {}, a.durationMs))),
      ),
    ),
    h('details', {}, h('summary', {}, 'Raw receipt'), pre({ receipt: rc, signature: signed.signature })),
  ];
}

export async function receiptsPage({ args, navigate }) {
  const input = h('input', { type: 'text', value: args[0] ?? '', placeholder: 'receipt id (shown in every scrape result)' });
  const out = h('div', {});
  const run = h('button', {}, 'Open and verify');
  action(run, out, async () => {
    const id = input.value.trim();
    if (!id) throw new Error('Enter a receipt id.');
    if (args[0] !== id) navigate(`receipts/${encodeURIComponent(id)}`);
    return load(id);
  });
  if (args[0]) queueMicrotask(() => run.click());
  return h('div', {}, h('h1', {}, 'Receipts'), h('p', { class: 'muted' }, 'Every scrape has a signed receipt. This page re-checks the signature and the stored page against it in your browser.'), field('Receipt id', input), run, out);
}
