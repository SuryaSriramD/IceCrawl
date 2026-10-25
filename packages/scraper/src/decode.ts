function sniffMetaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1');
  const m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return m ? m[1] : null;
}

export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const m = /charset=["']?([\w-]+)/i.exec(contentType);
  const label = m?.[1] ?? sniffMetaCharset(bytes) ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export type ContentKind = 'html' | 'text' | 'json' | 'document' | 'unsupported';

export function contentKind(contentType: string, bytes: Uint8Array): ContentKind {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (ct === '') {
    const head = Buffer.from(bytes.subarray(0, 512)).toString('utf8').trimStart().toLowerCase();
    return head.startsWith('<') ? 'html' : 'text';
  }
  if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'html';
  if (ct === 'application/json' || ct.endsWith('+json')) return 'json';
  if (ct.startsWith('text/')) return 'text';
  return 'unsupported';
}
