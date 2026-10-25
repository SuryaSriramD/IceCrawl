import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { convertDocument, DocumentError } from '../src';

const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
const core = (title: string) => `<cp:coreProperties xmlns:cp="c" xmlns:dc="d"><dc:title>${title}</dc:title></cp:coreProperties>`;

describe('xlsx', () => {
  const book = zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><t>Day</t></si><si><t>Ada</t></si></sst>',
    'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2" s="1"><v>45000</v></c></row></sheetData></worksheet>',
    'docProps/core.xml': core('Q1'),
  });
  it('renders sheets as tables with dates as text', async () => {
    const r = await convertDocument(book, 'xlsx');
    expect(r.title).toBe('Q1');
    expect(r.html).toContain('<h2>Sales</h2>');
    expect(r.html).toContain('Ada');
    expect(r.html).toContain('2023-03-15');
  });
});

describe('pptx', () => {
  it('renders slides in order with titles', async () => {
    const slide = (title: string, body: string) =>
      `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` +
      `<p:sp><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const r = await convertDocument(
      zip({
        'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId r:id="b"/><p:sldId r:id="a"/></p:sldIdLst></p:presentation>',
        'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/></Relationships>',
        'ppt/slides/slide1.xml': slide('One', 'first body'),
        'ppt/slides/slide2.xml': slide('Two', 'second body'),
      }),
      'pptx',
    );
    expect(r.html.indexOf('Slide 1: Two')).toBeGreaterThan(-1);
    expect(r.html.indexOf('Slide 1: Two')).toBeLessThan(r.html.indexOf('Slide 2: One'));
    expect(r.html).toContain('second body');
  });
});

describe('odf', () => {
  const content = (body: string) => zip({ 'content.xml': `<office:document-content><office:body>${body}</office:body></office:document-content>`, 'meta.xml': '<m xmlns:dc="d"><dc:title>T</dc:title></m>' });
  it('reads odt headings, paragraphs and lists', async () => {
    const r = await convertDocument(content('<office:text><text:h text:outline-level="1">Head</text:h><text:p>a<text:s text:c="2"/>b</text:p><text:list><text:list-item><text:p>item</text:p></text:list-item></text:list></office:text>'), 'odt');
    expect(r.title).toBe('T');
    expect(r.html).toContain('<h1>Head</h1>');
    expect(r.html).toContain('a  b');
    expect(r.html).toContain('<li>item</li>');
  });
  it('reads ods tables', async () => {
    const r = await convertDocument(content('<office:spreadsheet><table:table table:name="S"><table:table-row><table:table-cell><text:p>x</text:p></table:table-cell><table:table-cell office:value="3"/></table:table-row></table:table></office:spreadsheet>'), 'ods');
    expect(r.html).toContain('<h2>S</h2>');
    expect(r.html).toContain('3');
  });
  it('reads odp slides', async () => {
    const r = await convertDocument(content('<office:presentation><draw:page draw:name="p1"><draw:frame><draw:text-box><text:p>slide text</text:p></draw:text-box></draw:frame></draw:page></office:presentation>'), 'odp');
    expect(r.html).toContain('Slide 1: p1');
    expect(r.html).toContain('slide text');
  });
});

describe('epub', () => {
  it('reads chapters in spine order', async () => {
    const r = await convertDocument(
      zip({
        'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
        'OEBPS/content.opf': '<package xmlns:dc="d"><metadata><dc:title>Book</dc:title></metadata><manifest><item id="c1" href="c1.xhtml"/><item id="c2" href="c2.xhtml"/></manifest><spine><itemref idref="c2"/><itemref idref="c1"/></spine></package>',
        'OEBPS/c1.xhtml': '<html><body><p>chapter one</p></body></html>',
        'OEBPS/c2.xhtml': '<html><body><p>chapter two</p></body></html>',
      }),
      'epub',
    );
    expect(r.title).toBe('Book');
    expect(r.html.indexOf('chapter two')).toBeLessThan(r.html.indexOf('chapter one'));
  });
});

describe('docx', () => {
  it('converts paragraphs through mammoth', async () => {
    const r = await convertDocument(
      zip({
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello docx</w:t></w:r></w:p></w:body></w:document>',
      }),
      'docx',
    );
    expect(r.html).toContain('Hello docx');
  });
});

describe('hostile archives', () => {
  it('rejects a zip whose declared size exceeds the limit', async () => {
    const big = zipSync({ 'xl/workbook.xml': new Uint8Array(2_000_000) });
    await expect(convertDocument(big, 'xlsx', { maxUnzippedBytes: 1_000_000 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });
  it('rejects xml that declares entities', async () => {
    const bomb = zip({ 'content.xml': '<!DOCTYPE x [<!ENTITY a "aaaa">]><office:document-content><office:body>&a;</office:body></office:document-content>' });
    await expect(convertDocument(bomb, 'odt')).rejects.toBeInstanceOf(DocumentError);
  });
  it('rejects garbage as unreadable', async () => {
    await expect(convertDocument(strToU8('not a zip'), 'xlsx')).rejects.toMatchObject({ code: 'UNREADABLE' });
  });
});
