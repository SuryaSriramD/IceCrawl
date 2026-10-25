import mammoth from 'mammoth';
import { page } from './html';
import { checkZip, openZip } from './zip';
import { DocumentError, type ConvertedDocument, type DocumentLimits } from './types';
import { findFirst, parseXml, textOf } from './xml';

/** Title from docProps/core.xml (OOXML) or meta.xml (OpenDocument); null when absent. */
export function packageTitle(read: (name: string) => string | null): string | null {
  for (const part of ['docProps/core.xml', 'meta.xml']) {
    const xml = read(part);
    if (!xml) continue;
    try {
      const node = findFirst(parseXml(xml), 'dc:title');
      const title = node ? textOf([node]).trim() : '';
      if (title) return title;
    } catch {
      // a broken metadata part only costs the title
    }
  }
  return null;
}

export async function docxToHtml(bytes: Uint8Array, limits: DocumentLimits): Promise<ConvertedDocument> {
  checkZip(bytes, limits);
  const zip = openZip(bytes, limits, (n) => n === 'docProps/core.xml' || n === '[Content_Types].xml');
  if (!zip.has('word/document.xml')) throw new DocumentError('UNREADABLE', 'The file is not a Word document (word/document.xml is missing)');

  let result: { value: string; messages: Array<{ type: string; message: string }> };
  try {
    result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes) },
      {
        // images are not part of the text: leave them out instead of inlining megabytes of base64
        convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
        ignoreEmptyParagraphs: true,
      },
    );
  } catch {
    throw new DocumentError('UNREADABLE', 'The Word document could not be read');
  }
  const body = result.value.replace(/<img[^>]*src=""[^>]*\/?>/g, '');
  if (body.replace(/<[^>]*>/g, '').trim() === '') throw new DocumentError('UNREADABLE', 'The document contains no text');
  const title = packageTitle((n) => zip.text(n));
  const warnings = result.messages.filter((m) => m.type === 'warning').length > 0 ? ['Some formatting in the document was not recognised and was converted as plain text.'] : [];
  return { html: page(title, body), title, warnings };
}
