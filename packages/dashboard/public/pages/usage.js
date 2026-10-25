import { api } from '../lib/api.js';
import { fmtDate, h } from '../lib/dom.js';

const stat = (label, value, hint = '') => h('div', { class: 'panel stat' }, h('span', { class: 'muted' }, label), h('b', {}, value), h('span', { class: 'muted' }, hint));
const month = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });

export async function usagePage() {
  const [queue, credits, tokens, history, activity] = await Promise.all([
    api.get('/v2/team/queue-status'),
    api.get('/v2/team/credit-usage'),
    api.get('/v2/team/token-usage'),
    api.get('/v2/team/credit-usage/historical'),
    api.get('/v2/team/activity?limit=15'),
  ]);
  const periods = history.periods ?? [];
  const max = Math.max(1, ...periods.map((p) => p.totalCredits));

  return h(
    'div',
    {},
    h('h1', {}, 'Overview'),
    h(
      'div',
      { class: 'grid' },
      stat('Scrapes this month', credits.data.usedCredits, 'IceCrawl only meters; nothing is billed'),
      stat('Model tokens this month', tokens.data.usedTokens, 'spent by extract jobs'),
      stat('Jobs running', queue.activeJobsInQueue, `workers run ${queue.maxConcurrency || '?'} at once`),
      stat('Last successful scrape', queue.mostRecentSuccess ? fmtDate(queue.mostRecentSuccess) : 'none yet'),
    ),
    h('h2', {}, 'Scrapes per month'),
    h(
      'div',
      { class: 'panel' },
      h(
        'table',
        {},
        ...periods.map((p) => {
          const bar = h('div', { class: 'bar' });
          bar.style.width = `${Math.round((p.totalCredits / max) * 100)}%`;
          return h('tr', {}, h('td', {}, month(p.startDate)), h('td', { style: undefined }, bar), h('td', {}, p.totalCredits));
        }),
      ),
    ),
    h('h2', {}, 'Recent activity'),
    h(
      'div',
      { class: 'panel' },
      activity.data.length === 0
        ? h('p', { class: 'muted' }, 'Nothing has been scraped with this key yet. Try the Playground.')
        : h(
            'table',
            {},
            h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Endpoint'), h('th', {}, 'Page'), h('th', {}, 'Receipt')),
            ...activity.data.map((r) =>
              h('tr', {}, h('td', {}, fmtDate(r.created_at)), h('td', {}, r.endpoint), h('td', {}, r.target), h('td', {}, h('a', { href: `#/receipts/${r.id}` }, r.id.slice(0, 8)))),
            ),
          ),
    ),
    h('h2', {}, 'API keys'),
    h(
      'div',
      { class: 'panel' },
      h('p', {}, 'Keys are created on the server so that no key can mint more keys. Run one of these where IceCrawl runs:'),
      h('pre', {}, 'pnpm --filter @icecrawl/api keys:create my-key   # prints the key once; only its hash is stored'),
      h('p', { class: 'muted' }, 'This dashboard keeps the key you enter only for this browser tab (session storage) and sends it only to this server.'),
    ),
  );
}
