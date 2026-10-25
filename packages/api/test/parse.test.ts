import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { makeApp } from './helpers';

/** Multipart body and header for an upload, built with the platform's FormData. */
async function upload(name: string, bytes: Uint8Array, type: string, options?: Record<string, unknown>) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(bytes)], { type }), name);
  if (options) form.append('options', JSON.stringify(options));
  const res = new Response(form);
  return { payload: Buffer.from(await res.arrayBuffer()), headers: { 'content-type': res.headers.get('content-type') ?? '' } };
}

const csv = strToU8('name,qty\napples,3\npears,5\n');
const docx = zipSync({
  '[Content_Types].xml': strToU8(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  ),
  '_rels/.rels': strToU8(
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  ),
  'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${'<w:p><w:r><w:t>Uploaded words in a sentence that is long enough to count as real content for the trust check.</w:t></w:r></w:p>'.repeat(8)}</w:body></w:document>`),
});

describe('POST /v2/parse', () => {
  it('turns an uploaded csv into a markdown table with a receipt', async () => {
    const { app, auth } = await makeApp();
    const u = await upload('fruit.csv', csv, 'text/csv');
    const res = await app.inject({ method: 'POST', url: '/v2/parse', headers: { ...auth, ...u.headers }, payload: u.payload });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.markdown).toContain('| name | qty |');
    expect(body.data.metadata.sourceURL).toMatch(/^upload:\/\/[0-9a-f]{64}\/fruit\.csv$/);
    expect(body.data.trust.verdict).toBe('ok');
    const receipt = await app.inject({ method: 'GET', url: `/v2/receipts/${body.data.trust.receiptId}`, headers: auth });
    expect(receipt.statusCode).toBe(200);
  });

  it('reads a docx whose content type is generic', async () => {
    const { app, auth } = await makeApp();
    const u = await upload('memo.docx', docx, 'application/octet-stream', { formats: ['markdown'] });
    const res = await app.inject({ method: 'POST', url: '/v2/parse', headers: { ...auth, ...u.headers }, payload: u.payload });
    expect(res.json().data.markdown).toContain('Uploaded words');
  });

  it('parses an html upload with the same options as a scrape', async () => {
    const { app, auth } = await makeApp();
    const sentence = 'The kept paragraph has enough words to be real content for the trust check. ';
    const html = strToU8(`<html><body><nav>menu</nav><p>${sentence.repeat(6)}</p></body></html>`);
    const u = await upload('page.html', html, 'text/html', { onlyMainContent: false, excludeTags: ['nav'] });
    const res = await app.inject({ method: 'POST', url: '/v2/parse', headers: { ...auth, ...u.headers }, payload: u.payload });
    expect(res.json().data.markdown).not.toContain('menu');
    expect(res.json().data.markdown).toContain('kept paragraph');
  });

  it('rejects unsupported file types, a missing file and bad options', async () => {
    const { app, auth } = await makeApp();
    const exe = await upload('tool.exe', strToU8('MZ'), 'application/octet-stream');
    const r1 = await app.inject({ method: 'POST', url: '/v2/parse', headers: { ...auth, ...exe.headers }, payload: exe.payload });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error).toContain('/v2/parse/formats');

    const none = new Response(new FormData());
    const r2 = await app.inject({ method: 'POST', url: '/v2/parse', headers: { ...auth, 'content-type': none.headers.get('content-type') ?? '' }, payload: Buffer.from(await none.arrayBuffer()) });
    expect(r2.statusCode).toBe(400);

    const bad = await upload('a.csv', csv, 'text/csv');
    const form = new FormData();
    form.append('options', '[1]');
    form.append('file', new Blob([Buffer.from(csv)]), 'a.csv');
    const res = new Response(form);
    const r3 = await app.inject({ method: 'POST', url: '/v2/parse', headers: { ...auth, 'content-type': res.headers.get('content-type') ?? '' }, payload: Buffer.from(await res.arrayBuffer()) });
    expect(r3.statusCode).toBe(400);
    expect(bad.payload.length).toBeGreaterThan(0);
  });

  it('reports an unreadable pdf as an error verdict', async () => {
    const { app, auth } = await makeApp();
    const u = await upload('broken.pdf', strToU8('%PDF-1.4 broken'), 'application/pdf');
    const res = await app.inject({ method: 'POST', url: '/v2/parse', headers: { ...auth, ...u.headers }, payload: u.payload });
    expect(res.json().success).toBe(false);
    expect(res.json().trust.verdict).toBe('error');
  });

  it('refuses files above the upload limit', async () => {
    const { app, auth } = await makeApp({ maxUploadBytes: 100 });
    const u = await upload('big.csv', new Uint8Array(500).fill(97), 'text/csv');
    const res = await app.inject({ method: 'POST', url: '/v2/parse', headers: { ...auth, ...u.headers }, payload: u.payload });
    expect(res.statusCode).toBe(413);
  });

  it('requires an API key', async () => {
    const { app } = await makeApp();
    const u = await upload('a.csv', csv, 'text/csv');
    const res = await app.inject({ method: 'POST', url: '/v2/parse', headers: u.headers, payload: u.payload });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v2/parse/formats', () => {
  it('lists readable formats and marks legacy ones unavailable', async () => {
    const { app, auth } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v2/parse/formats', headers: auth });
    const formats = res.json().data.formats as Array<{ format: string; available: boolean }>;
    expect(formats.find((f) => f.format === 'pdf')?.available).toBe(true);
    expect(formats.find((f) => f.format === 'doc')?.available).toBe(false);
  });
});
