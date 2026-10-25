import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { normalizeScrapeRequest } from '@icecrawl/core';
import { featureSet, type Engine } from '@icecrawl/engines';
import { sha256Hex } from '@icecrawl/trust';
import { buildFeatureFlags, convertHtml, replayMarkdown, runScrape } from '../src';

const engine = (body: Uint8Array, contentType: string, finalUrl: string): Engine => ({
  name: 'e',
  quality: 5,
  features: featureSet(['skipTlsVerification', 'pdf', 'document']),
  maxReasonableTimeMs: 1000,
  scrape: async () => ({ finalUrl, statusCode: 200, headers: {}, body, contentType, truncated: false }),
});

const cfg = { allowPrivateNetworks: false, maxResponseBytes: 1_000_000, strict: false };
const scrape = (body: Uint8Array, contentType: string, url: string) =>
  runScrape({ engines: [engine(body, contentType, url)], config: cfg }, normalizeScrapeRequest({ url }));

const xlsx = zipSync({
  'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>'),
  'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
  'xl/worksheets/sheet1.xml': strToU8(
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>name</t></is></c><c r="B1" t="inlineStr"><is><t>qty</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>apples</t></is></c><c r="B2"><v>3</v></c></row></sheetData></worksheet>',
  ),
});

describe('tables in markdown', () => {
  it('converts html tables to pipe tables', () => {
    const md = convertHtml('<html><body><table><tr><th>a</th><th>b|c</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>', {
      url: 'https://example.com/',
      onlyMainContent: false,
      removeBase64Images: true,
    }).markdown;
    expect(md).toBe('| a | b\\|c |\n| --- | --- |\n| 1 | 2 |');
  });
});

describe('documents through the pipeline', () => {
  it('scrapes an xlsx as markdown and replays it from the snapshot', async () => {
    const run = await scrape(xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'https://example.com/report.xlsx');
    expect(run.verdict).toBe('ok');
    expect(run.markdown).toContain('| name | qty |');
    expect(run.markdown).toContain('| apples | 3 |');
    const r = await replayMarkdown(run.receipt, run.snapshot.bytes);
    expect('markdown' in r && sha256Hex(r.markdown)).toBe(run.receipt.outputSha256);
  });

  it('recognises a document by file name when the server sends a generic type', async () => {
    const run = await scrape(xlsx, 'application/octet-stream', 'https://example.com/download/report.xlsx');
    expect(run.markdown).toContain('apples');
  });

  it('reports an unreadable document as an error verdict with the reason', async () => {
    const run = await scrape(strToU8('%PDF-1.4 not really'), 'application/pdf', 'https://example.com/a.pdf');
    expect(run.verdict).toBe('error');
    expect(run.reasons.join(' ')).toContain('not a readable PDF');
    expect(run.accepted).toBe(false);
  });

  it('asks for the document features for pdf and office urls', () => {
    const flags = (url: string) => buildFeatureFlags(normalizeScrapeRequest({ url }).request);
    expect(flags('https://example.com/a.pdf').has('pdf')).toBe(true);
    expect(flags('https://example.com/a.docx').has('document')).toBe(true);
    expect(flags('https://example.com/a.html').has('pdf')).toBe(false);
  });
});
