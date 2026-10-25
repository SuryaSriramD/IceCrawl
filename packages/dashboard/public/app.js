import { api, ApiError, keyStore } from './lib/api.js';
import { h, replace } from './lib/dom.js';
import { errorBox } from './lib/ui.js';
import { jobsPage } from './pages/jobs.js';
import { monitorsPage } from './pages/monitors.js';
import { playgroundPage } from './pages/playground.js';
import { receiptsPage } from './pages/receipts.js';
import { usagePage } from './pages/usage.js';

const pages = [
  ['usage', 'Overview', usagePage],
  ['playground', 'Playground', playgroundPage],
  ['jobs', 'Jobs', jobsPage],
  ['receipts', 'Receipts', receiptsPage],
  ['monitors', 'Monitors', monitorsPage],
];

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const keyInput = /** @type {HTMLInputElement} */ (document.getElementById('key'));
const keyState = document.getElementById('keystate');

/** Route is `#/page/arg/...`; the first part picks the page, the rest is handed to it. */
function route() {
  const [name, ...args] = location.hash.replace(/^#\//, '').split('/').filter(Boolean).map(decodeURIComponent);
  return { name: pages.some((p) => p[0] === name) ? name : 'usage', args };
}

async function render() {
  const { name, args } = route();
  replace(nav, ...pages.map(([id, label]) => h('a', { href: `#/${id}`, class: id === name ? 'current' : '' }, label)));
  const page = pages.find((p) => p[0] === name)[2];
  replace(view, h('p', { class: 'muted' }, 'Loading…'));
  try {
    replace(view, await page({ args, navigate: (path) => (location.hash = `#/${path}`), rerender: render }));
  } catch (err) {
    replace(view, errorBox(err));
  }
}

async function checkKey() {
  try {
    await api.get('/v2/team/queue-status');
    replace(keyState, keyStore.get() ? 'key accepted' : 'server has authentication off');
  } catch (err) {
    replace(keyState, err instanceof ApiError && err.status === 401 ? 'key needed' : 'server unreachable');
  }
}

document.getElementById('keyform').addEventListener('submit', async (e) => {
  e.preventDefault();
  keyStore.set(keyInput.value.trim());
  keyInput.value = '';
  await checkKey();
  await render();
});

window.addEventListener('hashchange', render);
if (keyStore.get()) keyInput.placeholder = 'API key (set for this tab)';
await checkKey();
await render();
