import { api } from '../lib/api.js';
import { badge, extLink, field, fmtDate, h, pre, table } from '../lib/dom.js';
import { action } from '../lib/ui.js';

const PAGE_KIND = { new: 'good', same: '', changed: 'warn', removed: 'warn', error: 'bad' };
const CHECK_KIND = { completed: 'good', partial: 'warn', failed: 'bad', skipped_overlap: 'warn', queued: '', running: '' };

/** A unified diff, line by line, with additions and removals shaded. Lines are text, never markup. */
export function diffView(text) {
  return h(
    'pre',
    { class: 'diff' },
    ...text.split('\n').map((line) => h('span', { class: line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : '' }, line || ' ')),
  );
}

const summaryText = (s) => (s ? `${s.totalPages} pages: ${s.new} new, ${s.changed} changed, ${s.removed} removed, ${s.error} errors, ${s.same} same` : '-');

async function list(rerender) {
  const monitors = (await api.get('/v2/monitor?limit=100')).data;
  const name = h('input', { type: 'text', placeholder: 'Pricing page' });
  const cron = h('input', { type: 'text', value: '0 */6 * * *' });
  const urls = h('textarea', { placeholder: 'one URL per line' });
  const hook = h('input', { type: 'text', placeholder: 'optional webhook URL' });
  const out = h('div', {});
  const create = h('button', {}, 'Create monitor');
  action(create, out, async () => {
    const body = { name: name.value.trim(), schedule: { cron: cron.value.trim() }, targets: [{ type: 'scrape', urls: urls.value.split('\n').map((u) => u.trim()).filter(Boolean) }] };
    if (hook.value.trim()) body.webhook = { url: hook.value.trim() };
    const res = await api.post('/v2/monitor', body);
    location.hash = `#/monitors/${res.data.id}`;
    return h('p', {}, res.warning ?? 'Created.');
  });
  return h(
    'div',
    {},
    h('h1', {}, 'Monitors'),
    monitors.length === 0
      ? h('p', { class: 'muted' }, 'No monitors yet.')
      : h(
          'div',
          { class: 'panel' },
          h(
            'table',
            {},
            h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Status'), h('th', {}, 'Schedule'), h('th', {}, 'Next run'), h('th', {}, 'Last check')),
            ...monitors.map((m) =>
              h('tr', {}, h('td', {}, h('a', { href: `#/monitors/${m.id}` }, m.name)), h('td', {}, badge(m.status, m.status === 'active' ? 'good' : 'warn')), h('td', {}, `${m.schedule.cron} (${m.schedule.timezone})`), h('td', {}, fmtDate(m.nextRunAt)), h('td', {}, summaryText(m.lastCheckSummary))),
            ),
          ),
        ),
    h('h2', {}, 'New monitor'),
    h('div', { class: 'panel' }, field('Name', name), field('Cron schedule (minute hour day month weekday)', cron), field('Pages to watch', urls), field('Webhook', hook), create, out),
  );
}

async function detail(id, rerender) {
  const [m, checks] = await Promise.all([api.get(`/v2/monitor/${id}`), api.get(`/v2/monitor/${id}/checks?limit=20`)]);
  const mon = m.data;
  const out = h('div', {});
  const run = h('button', {}, 'Run now');
  action(run, out, async () => {
    const r = await api.post(`/v2/monitor/${id}/run`);
    location.hash = `#/monitors/${id}/${r.id}`;
    return h('p', {}, 'Started.');
  });
  const toggle = h('button', { class: 'secondary' }, mon.status === 'active' ? 'Pause' : 'Resume');
  action(toggle, out, async () => {
    await api.patch(`/v2/monitor/${id}`, { status: mon.status === 'active' ? 'paused' : 'active' });
    await rerender();
    return h('p', {}, 'Updated.');
  });
  const del = h('button', { class: 'danger' }, 'Delete');
  action(del, out, async () => {
    if (!confirm(`Delete "${mon.name}" with all its checks?`)) return h('p', { class: 'muted' }, 'Cancelled.');
    await api.del(`/v2/monitor/${id}`);
    location.hash = '#/monitors';
    return h('p', {}, 'Deleted.');
  });
  return h(
    'div',
    {},
    h('p', {}, h('a', { href: '#/monitors' }, '← all monitors')),
    h('h1', {}, mon.name),
    h('div', { class: 'panel' }, table([
      ['Status', badge(mon.status, mon.status === 'active' ? 'good' : 'warn')],
      ['Schedule', `${mon.schedule.cron} (${mon.schedule.timezone})`],
      ['Next run', fmtDate(mon.nextRunAt)],
      ['Last run', fmtDate(mon.lastRunAt)],
      ['Targets', pre(mon.targets)],
    ]), h('div', { class: 'row' }, run, toggle, del), out),
    h('h2', {}, 'Checks'),
    h(
      'div',
      { class: 'panel' },
      checks.data.length === 0
        ? h('p', { class: 'muted' }, 'No checks yet.')
        : h('table', {}, h('tr', {}, h('th', {}, 'Started'), h('th', {}, 'Trigger'), h('th', {}, 'Status'), h('th', {}, 'Result')), ...checks.data.map((c) => h('tr', {}, h('td', {}, h('a', { href: `#/monitors/${id}/${c.id}` }, fmtDate(c.startedAt ?? c.createdAt))), h('td', {}, c.trigger), h('td', {}, badge(c.status, CHECK_KIND[c.status])), h('td', {}, c.error ?? summaryText(c.summary))))),
    ),
  );
}

async function checkDetail(id, checkId, filter) {
  const r = await api.get(`/v2/monitor/${id}/checks/${checkId}?limit=50${filter ? `&status=${filter}` : ''}`);
  const c = r.data;
  return h(
    'div',
    {},
    h('p', {}, h('a', { href: `#/monitors/${id}` }, '← monitor')),
    h('h1', {}, 'Check'),
    h('div', { class: 'panel' }, table([['Status', badge(c.status, CHECK_KIND[c.status])], ['Trigger', c.trigger], ['Started', fmtDate(c.startedAt)], ['Finished', fmtDate(c.finishedAt)], ['Result', c.error ?? summaryText(c.summary)]])),
    h('h2', {}, `Pages${c.pages.length === 50 && r.next ? ' (first 50)' : ''}`),
    ...(c.pages.length === 0 ? [h('p', { class: 'muted' }, 'No pages.')] : c.pages.map((p) =>
      h(
        'div',
        { class: 'panel' },
        h('div', {}, badge(p.status, PAGE_KIND[p.status]), ' ', extLink(p.url)),
        p.error ? h('div', { class: 'error' }, p.error) : null,
        p.currentScrapeId ? h('div', { class: 'muted' }, 'receipt ', h('a', { href: `#/receipts/${p.currentScrapeId}` }, p.currentScrapeId.slice(0, 8)), p.previousScrapeId ? h('span', {}, ' · previous ', h('a', { href: `#/receipts/${p.previousScrapeId}` }, p.previousScrapeId.slice(0, 8))) : null) : null,
        p.diff?.text ? diffView(p.diff.text) : null,
      ),
    )),
  );
}

export async function monitorsPage({ args, rerender }) {
  if (args.length >= 2) return checkDetail(args[0], args[1]);
  if (args.length === 1) return detail(args[0], rerender);
  return list(rerender);
}
