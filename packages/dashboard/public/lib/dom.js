// A tiny DOM builder. Strings become text nodes, never HTML, so text from scraped pages cannot inject markup.

/** @param {string} tag @param {Record<string, unknown>} [props] @param {...unknown} children */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), /** @type {EventListener} */ (v));
    else if (k === 'value') /** @type {HTMLInputElement} */ (el).value = String(v);
    else if (k === 'checked') /** @type {HTMLInputElement} */ (el).checked = Boolean(v);
    else if (k === 'href') el.setAttribute('href', safeHref(String(v)));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

/** @param {Node} el @param {unknown[]} children */
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** @param {Node} el @param {...unknown} children */
export function replace(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

/** Only http(s) links and in-app hash links are allowed as hrefs; anything else (javascript:, data:) becomes a dead link. */
export function safeHref(href) {
  if (href.startsWith('#/')) return href;
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '#';
  } catch {
    return '#';
  }
}

/** A link to an external page found on the web: opens in a new tab without referrer. */
export function extLink(href, label = href) {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow' }, label);
}

export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);

/** @param {string} verdict */
export const verdictBadge = (verdict) => badge(verdict, verdict === 'ok' ? 'good' : verdict === 'uncertain' ? 'warn' : 'bad');

export function pre(text) {
  return h('pre', {}, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
}

export function field(label, control) {
  return h('label', { class: 'field' }, h('span', {}, label), control);
}

/** @param {Array<[string, unknown]>} rows */
export function table(rows) {
  return h('table', { class: 'kv' }, ...rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))));
}

export function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '-';
}

export function copyable(text) {
  return h('code', { class: 'id' }, text);
}
