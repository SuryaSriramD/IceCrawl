import { ApiError } from './api.js';
import { h } from './dom.js';

export function errorBox(err) {
  if (err instanceof ApiError && err.status === 401) {
    return h('div', { class: 'error' }, 'The server did not accept the API key. Enter a valid key at the top right.');
  }
  return h('div', { class: 'error' }, err instanceof ApiError ? `${err.code}: ${err.message}` : String(err?.message ?? err));
}

/** Runs `work` when the button is pressed, shows what it returns (or the error) in `out`, and disables the button meanwhile. */
export function action(button, out, work) {
  button.addEventListener('click', async (e) => {
    e.preventDefault();
    button.disabled = true;
    out.replaceChildren(h('p', { class: 'muted' }, 'Working…'));
    try {
      const result = await work();
      out.replaceChildren(...(Array.isArray(result) ? result : [result]));
    } catch (err) {
      out.replaceChildren(errorBox(err));
    } finally {
      button.disabled = false;
    }
  });
}
