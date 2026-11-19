import { adminStore, ApiError, admin } from '../lib/api.js';
import { badge, field, fmtDate, h } from '../lib/dom.js';
import { action, errorBox } from '../lib/ui.js';

/** The settings to paste into Claude or Codex for a new key. */
function connectBlock(key) {
  const text = `ICECRAWL_API_URL=${location.origin}\nICECRAWL_API_KEY=${key}`;
  return h('pre', {}, text);
}

function newKeyBox(created) {
  const copy = h('button', { class: 'secondary' }, 'Copy key');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(created.key);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Select the key and copy it by hand';
    }
  });
  return h(
    'div',
    { class: 'notice' },
    h('p', {}, h('b', {}, `Key "${created.name}" created. Copy it now: it is shown only once and cannot be looked up again.`)),
    h('pre', {}, created.key),
    h('div', { class: 'row' }, copy),
    h('p', { class: 'muted' }, 'Settings for the MCP server of Claude or Codex:'),
    connectBlock(created.key),
  );
}

async function manage(rerender) {
  const { keys } = (await admin.get('/admin/keys')).data;
  const out = h('div', {});
  const name = h('input', { type: 'text', placeholder: 'for example: claude-laptop' });
  const create = h('button', {}, 'Generate key');
  action(create, out, async () => {
    const res = await admin.post('/admin/keys', { name: name.value.trim() || 'default' });
    name.value = '';
    await refreshList();
    return newKeyBox(res.data);
  });

  const list = h('div', { class: 'panel' });
  async function refreshList() {
    const fresh = (await admin.get('/admin/keys')).data.keys;
    list.replaceChildren(
      fresh.length === 0
        ? h('p', { class: 'muted' }, 'No keys yet.')
        : h(
            'table',
            {},
            h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Created'), h('th', {}, 'Status'), h('th', {}, '')),
            ...fresh.map((k) => {
              const revoke = h('button', { class: 'danger' }, 'Revoke');
              revoke.addEventListener('click', async () => {
                if (!confirm(`Revoke "${k.name}"? Anything using it stops working.`)) return;
                revoke.disabled = true;
                try {
                  await admin.del(`/admin/keys/${k.id}`);
                  await refreshList();
                } catch (err) {
                  list.prepend(errorBox(err));
                }
              });
              return h('tr', {}, h('td', {}, k.name), h('td', {}, fmtDate(k.createdAt)), h('td', {}, k.revoked ? badge('revoked', 'bad') : badge('active', 'good')), h('td', {}, k.revoked ? '' : revoke));
            }),
          ),
    );
  }
  await refreshList();
  void keys;

  const lock = h('button', { class: 'secondary' }, 'Lock');
  lock.addEventListener('click', () => {
    adminStore.set('');
    void rerender();
  });
  return h(
    'div',
    {},
    h('div', { class: 'panel' }, field('Name for the new key', name), h('div', { class: 'row' }, create, lock), out),
    h('h2', {}, 'Keys'),
    list,
  );
}

export async function keysPage({ rerender }) {
  const intro = h('p', { class: 'muted' }, 'API keys let Claude, Codex and your own code use this server. Keys are made here with the admin token (the ICECRAWL_ADMIN_TOKEN setting of the server), which is not an API key.');
  if (adminStore.get()) {
    try {
      return h('div', {}, h('h1', {}, 'API keys'), intro, await manage(rerender));
    } catch (err) {
      adminStore.set('');
      if (!(err instanceof ApiError && err.status === 401)) return h('div', {}, h('h1', {}, 'API keys'), unavailable(err));
    }
  }
  const token = h('input', { type: 'password', placeholder: 'admin token', autocomplete: 'off' });
  const out = h('div', {});
  const unlock = h('button', {}, 'Unlock');
  action(unlock, out, async () => {
    adminStore.set(token.value.trim());
    token.value = '';
    try {
      await admin.get('/admin/keys');
    } catch (err) {
      adminStore.set('');
      throw err.status === 404 ? new Error('Key management is turned off on this server: set ICECRAWL_ADMIN_TOKEN (at least 16 characters) and restart it.') : err;
    }
    await rerender();
    return h('p', { class: 'muted' }, 'Unlocked.');
  });
  return h('div', {}, h('h1', {}, 'API keys'), intro, h('div', { class: 'panel' }, field('Admin token', token), unlock, out));
}

function unavailable(err) {
  return err instanceof ApiError && err.status === 404
    ? h('div', { class: 'error' }, 'Key management is turned off on this server: set ICECRAWL_ADMIN_TOKEN (at least 16 characters) and restart it.')
    : errorBox(err);
}
