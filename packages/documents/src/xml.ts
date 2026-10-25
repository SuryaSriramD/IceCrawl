import { XMLParser } from 'fast-xml-parser';
import { DocumentError } from './types';

export type XNode = Record<string, unknown> & { ':@'?: Record<string, string> };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

/** Parses XML into an ordered tree. Documents that declare entities are refused (entity expansion bombs). */
export function parseXml(text: string): XNode[] {
  if (/<!ENTITY/i.test(text)) throw new DocumentError('UNREADABLE', 'The document declares XML entities');
  try {
    return parser.parse(text) as XNode[];
  } catch {
    throw new DocumentError('UNREADABLE', 'A part of the document is not valid XML');
  }
}

export const tagOf = (n: XNode): string | undefined => Object.keys(n).find((k) => k !== ':@');
export const childrenOf = (n: XNode): XNode[] => {
  const t = tagOf(n);
  const v = t ? n[t] : undefined;
  return Array.isArray(v) ? (v as XNode[]) : [];
};
export const attrOf = (n: XNode, name: string): string | undefined => n[':@']?.[`@_${name}`];

/** All text below a node, in document order. */
export function textOf(nodes: XNode[]): string {
  let out = '';
  for (const n of nodes) {
    if ('#text' in n) out += String(n['#text']);
    else out += textOf(childrenOf(n));
  }
  return out;
}

/** Depth first search for elements by (prefixed) tag name, in document order. */
export function findAll(nodes: XNode[], tag: string, into: XNode[] = []): XNode[] {
  for (const n of nodes) {
    if (tagOf(n) === tag) into.push(n);
    findAll(childrenOf(n), tag, into);
  }
  return into;
}

export const findFirst = (nodes: XNode[], tag: string): XNode | undefined => findAll(nodes, tag)[0];
