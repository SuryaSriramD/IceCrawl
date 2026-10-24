import { describe, expect, it } from 'vitest';
import { contentKind, decodeBody } from '../src/decode';

describe('decodeBody', () => {
  it('decodes utf-8 by default', () => {
    expect(decodeBody(Buffer.from('héllo'), 'text/html')).toBe('héllo');
  });

  it('honours the charset in the content type', () => {
    expect(decodeBody(Buffer.from([0x68, 0xe9]), 'text/html; charset=iso-8859-1')).toBe('hé');
  });

  it('falls back to a meta charset', () => {
    const bytes = Buffer.concat([Buffer.from('<meta charset="iso-8859-1">'), Buffer.from([0xe9])]);
    expect(decodeBody(bytes, 'text/html')).toContain('é');
  });

  it('survives an unknown charset label', () => {
    expect(decodeBody(Buffer.from('ok'), 'text/html; charset=bogus-999')).toBe('ok');
  });
});

describe('contentKind', () => {
  it.each([
    ['text/html; charset=utf-8', 'html'],
    ['application/xhtml+xml', 'html'],
    ['application/json', 'json'],
    ['application/vnd.api+json', 'json'],
    ['text/plain', 'text'],
    ['text/xml', 'text'],
    ['application/pdf', 'unsupported'],
    ['image/png', 'unsupported'],
  ] as const)('%s -> %s', (ct, kind) => expect(contentKind(ct, Buffer.from('x'))).toBe(kind));

  it('sniffs a missing content type', () => {
    expect(contentKind('', Buffer.from('  <!doctype html><html>'))).toBe('html');
    expect(contentKind('', Buffer.from('plain words'))).toBe('text');
  });
});
