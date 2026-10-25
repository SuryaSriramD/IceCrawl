export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A table as HTML. The first row is the header when `header` is true. */
export function tableHtml(rows: string[][], header = true): string {
  if (rows.length === 0) return '';
  const cell = (tag: 'th' | 'td') => (c: string) => `<${tag}>${esc(c).replace(/\n/g, '<br>')}</${tag}>`;
  const row = (tag: 'th' | 'td') => (r: string[]) => `<tr>${r.map(cell(tag)).join('')}</tr>`;
  const head = header ? `<thead>${row('th')(rows[0])}</thead>` : '';
  const body = (header ? rows.slice(1) : rows).map(row('td')).join('');
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

export const paragraph = (text: string): string => (text.trim() === '' ? '' : `<p>${esc(text).replace(/\n/g, '<br>')}</p>`);

export const heading = (level: number, text: string): string => {
  const l = Math.min(6, Math.max(1, level));
  return text.trim() === '' ? '' : `<h${l}>${esc(text)}</h${l}>`;
};

export const page = (title: string | null, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8">${title ? `<title>${esc(title)}</title>` : ''}</head><body>${body}</body></html>`;
