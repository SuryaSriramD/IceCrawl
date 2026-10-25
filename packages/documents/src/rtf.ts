import { page, paragraph } from './html';
import { DocumentError, type ConvertedDocument, type DocumentLimits } from './types';

const MAX_DEPTH = 200;

/** Groups whose content is not text of the document. */
const SKIPPED_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'footnote', 'object', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'themedata', 'datastore', 'latentstyles', 'xmlnstbl',
  'fldinst', 'bkmkstart', 'bkmkend', 'private', 'revtbl', 'filetbl', 'expandedcolortbl',
]);

const SYMBOLS: Record<string, string> = {
  emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', tab: '\t', emspace: ' ', enspace: ' ',
};

interface State {
  skip: boolean;
  /** How many characters follow a \uN escape as its fallback. */
  uc: number;
}

/** RTF to paragraphs of text. Character formatting is dropped; text, line and paragraph breaks and special characters are kept. */
export function rtfToHtml(bytes: Uint8Array, limits: DocumentLimits): ConvertedDocument {
  if (bytes.length > limits.maxBytes) throw new DocumentError('TOO_LARGE', `The file is larger than ${limits.maxBytes} bytes`);
  const src = Buffer.from(bytes).toString('latin1');
  if (!src.trimStart().startsWith('{\\rtf')) throw new DocumentError('UNREADABLE', 'The file is not an RTF document');

  const win1252 = new TextDecoder('windows-1252');
  const paragraphs: string[] = [];
  let current = '';
  const stack: State[] = [];
  let state: State = { skip: false, uc: 1 };
  let skipChars = 0;
  const flush = () => {
    paragraphs.push(current);
    current = '';
  };
  const emit = (s: string) => {
    if (!state.skip) current += s;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      if (stack.length >= MAX_DEPTH) throw new DocumentError('UNREADABLE', 'The document is nested too deeply');
      stack.push(state);
      state = { ...state };
    } else if (ch === '}') {
      state = stack.pop() ?? state;
    } else if (ch === '\\') {
      const next = src[i + 1];
      if (next === undefined) break;
      if (next === '\\' || next === '{' || next === '}') {
        if (skipChars > 0) skipChars--;
        else emit(next);
        i++;
      } else if (next === "'") {
        const hex = src.slice(i + 2, i + 4);
        i += 3;
        if (skipChars > 0) skipChars--;
        else if (/^[0-9a-fA-F]{2}$/.test(hex)) emit(win1252.decode(Uint8Array.of(parseInt(hex, 16))));
      } else if (next === '*') {
        state.skip = true;
        i++;
      } else if (next === '~') {
        emit(' ');
        i++;
      } else if (next === '_' || next === '-') {
        if (next === '_') emit('-');
        i++;
      } else if (next === '\n' || next === '\r') {
        if (!state.skip) flush();
        i++;
      } else if (/[a-zA-Z]/.test(next)) {
        let j = i + 1;
        while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
        const word = src.slice(i + 1, j);
        let k = j;
        if (src[k] === '-') k++;
        while (k < src.length && /[0-9]/.test(src[k])) k++;
        const param = k > j ? Number(src.slice(j, k)) : null;
        if (src[k] === ' ') k++;
        i = k - 1;

        if (SKIPPED_DESTINATIONS.has(word)) state.skip = true;
        else if (word === 'par' || word === 'sect' || word === 'page') {
          if (!state.skip) flush();
        } else if (word === 'line') emit('\n');
        else if (word === 'u' && param !== null) {
          emit(String.fromCharCode(param < 0 ? param + 65536 : param));
          skipChars = state.uc;
        } else if (word === 'uc' && param !== null) state.uc = param;
        else if (word in SYMBOLS) emit(SYMBOLS[word]);
      } else {
        i++;
      }
    } else if (ch === '\r' || ch === '\n') {
      // line breaks inside the file are layout, not content
    } else if (skipChars > 0) {
      skipChars--;
    } else {
      emit(ch);
    }
  }
  flush();

  const body = paragraphs.map((p) => paragraph(p.replace(/[ \t]+/g, ' ').trim())).join('');
  if (body === '') throw new DocumentError('UNREADABLE', 'The document contains no text');
  return { html: page(null, body), title: null, warnings: [] };
}
