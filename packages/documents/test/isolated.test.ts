import { describe, expect, it } from 'vitest';
import { convertDocument, convertDocumentIsolated } from '../src';

const csv = new TextEncoder().encode('name,qty\napples,3\n');

describe('convertDocumentIsolated', () => {
  it('gives the same result as converting in-process', async () => {
    expect(await convertDocumentIsolated(csv, 'csv')).toEqual(await convertDocument(csv, 'csv'));
  }, 30_000);

  it('reports a document error with its code and message', async () => {
    await expect(convertDocumentIsolated(new TextEncoder().encode('not a zip'), 'xlsx')).rejects.toMatchObject({ code: 'UNREADABLE', name: 'DocumentError' });
    await expect(convertDocumentIsolated(csv, 'csv', { maxBytes: 3 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  }, 30_000);

  it('stops a conversion that takes too long', async () => {
    await expect(convertDocumentIsolated(csv, 'csv', {}, { timeoutMs: 1 })).rejects.toMatchObject({ code: 'UNREADABLE', message: expect.stringContaining('too long') });
  }, 30_000);
});
