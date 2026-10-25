import { describe, expect, it } from 'vitest';
import { attributeSources, checkGrounding } from '../src';

const only = (data: unknown, source: string | string[]) => checkGrounding(data, Array.isArray(source) ? source : [source]);

describe('strings', () => {
  it('finds a value regardless of case, spacing and markdown emphasis', () => {
    const r = only({ name: 'Acme Corporation' }, '# **Acme  Corporation** is based in Paris.');
    expect(r).toMatchObject({ checked: 1, grounded: 1, partial: 0, ungrounded: 0, truncated: false });
    expect(r.fields).toEqual([{ path: '$.name', status: 'grounded', source: 0 }]);
  });

  it('ignores punctuation differences', () => {
    expect(only({ n: 'Acme Corp.' }, 'Acme Corp is great').grounded).toBe(1);
  });

  it('sees through fullwidth letters, curly quotes and zero-width characters', () => {
    expect(only({ n: '\uff21\uff23\uff2d\uff25' }, 'acme').grounded).toBe(1);
    expect(only({ n: 'it\u2019s fine' }, "It's fine").grounded).toBe(1);
    expect(only({ n: 'ac\u200bme' }, 'acme').grounded).toBe(1);
  });

  it('marks a value that is not in the source as ungrounded', () => {
    const r = only({ name: 'Globex' }, 'Acme Corporation');
    expect(r).toMatchObject({ checked: 1, grounded: 0, ungrounded: 1 });
    expect(r.fields).toEqual([{ path: '$.name', status: 'ungrounded', source: null }]);
  });

  it('marks a long reordered or lightly paraphrased value as partial', () => {
    const r = only(
      { about: 'The company was founded in Paris in 1999 by two engineers' },
      'Founded in Paris in 1999 by two engineers, the company grew quickly.',
    );
    expect(r).toMatchObject({ grounded: 0, partial: 1, ungrounded: 0 });
    expect(r.fields[0]).toEqual({ path: '$.about', status: 'partial', source: 0 });
  });

  it('does not call a short wrong value partial', () => {
    expect(only({ a: 'blue green' }, 'blue sky and green grass').ungrounded).toBe(1);
  });

  it('skips strings that are too short to mean anything', () => {
    expect(only({ a: '', b: 'x', c: ' ' }, 'x').checked).toBe(0);
  });

  it('keeps leading-zero numbers as text', () => {
    expect(only({ zip: '02134' }, 'ZIP 02134, Boston').grounded).toBe(1);
    expect(only({ zip: '02134' }, 'ZIP 2134').ungrounded).toBe(1);
  });
});

describe('numbers', () => {
  it('matches whole numbers with or without separators and trailing zeros', () => {
    expect(only({ price: 1234.5 }, 'Price: $1,234.50 today').grounded).toBe(1);
    expect(only({ n: 42 }, 'See page 42.').grounded).toBe(1);
    expect(only({ n: 3 }, 'Rated 3.00 stars').grounded).toBe(1);
    expect(only({ n: -5 }, 'a change of -5%').grounded).toBe(1);
    expect(only({ n: '1,234' }, 'Total 1,234 units').grounded).toBe(1);
    expect(only({ n: 1234567 }, 'sold 1,234,567 copies').grounded).toBe(1);
  });

  it('does not match inside other numbers', () => {
    expect(only({ n: 3 }, 'Rated 3.5 stars').ungrounded).toBe(1);
    expect(only({ n: 42 }, 'Item 1420 sold').ungrounded).toBe(1);
    expect(only({ n: 1234.5 }, 'Price 1234.56').ungrounded).toBe(1);
    expect(only({ n: 5 }, 'v1.5').ungrounded).toBe(1);
  });

  it('does not check numbers it cannot search for literally', () => {
    expect(only({ big: 1e21, nan: Number.NaN }, 'anything').checked).toBe(0);
  });
});

describe('structure', () => {
  it('skips booleans and null, and reports JSON paths', () => {
    const r = only(
      { ok: true, none: null, items: [{ name: 'Acme' }, { name: 'Zzzz' }], 'first name': 'Acme' },
      'Acme',
    );
    expect(r.checked).toBe(3);
    expect(r.fields).toEqual([
      { path: '$.items[1].name', status: 'ungrounded', source: null },
      { path: '$.items[0].name', status: 'grounded', source: 0 },
      { path: '$["first name"]', status: 'grounded', source: 0 },
    ]);
  });

  it('reports which source contains each value', () => {
    const r = only({ a: 'Alpha', b: 'Beta', c: 'Both' }, ['Alpha page and Both', 'Beta page and Both']);
    expect(r.fields).toEqual([
      { path: '$.a', status: 'grounded', source: 0 },
      { path: '$.b', status: 'grounded', source: 1 },
      { path: '$.c', status: 'grounded', source: 0 },
    ]);
    expect(attributeSources(r.fields, ['https://u0', 'https://u1'])).toEqual({
      '$.a': ['https://u0'],
      '$.b': ['https://u1'],
      '$.c': ['https://u0'],
    });
  });

  it('does not attribute values that were not found', () => {
    const r = only({ a: 'nowhere at all' }, 'something else');
    expect(attributeSources(r.fields, ['https://u0'])).toEqual({});
  });

  it('checks scalars at the root and arrays of strings', () => {
    expect(only('Acme', 'Acme Inc').fields[0].path).toBe('$');
    expect(only({ tags: ['red', 'blue'] }, 'red and blue').grounded).toBe(2);
  });
});

describe('limits', () => {
  it('examines at most 2000 values and lists at most 500', () => {
    const data = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`k${i}`, `value-${i} nowhere`]));
    const r = only(data, 'x');
    expect(r.checked).toBe(2000);
    expect(r.ungrounded).toBe(2000);
    expect(r.fields).toHaveLength(500);
    expect(r.truncated).toBe(true);
  });

  it('stops at deep nesting instead of recursing forever', () => {
    let deep: unknown = 'deep string';
    for (let i = 0; i < 40; i++) deep = { a: deep };
    const r = only(deep, 'deep string');
    expect(r.truncated).toBe(true);
    expect(r.checked).toBe(0);
  });

  it('stays fast on a large source', () => {
    const source = 'lorem ipsum dolor sit amet '.repeat(8000);
    const data = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i % 2 ? 'lorem ipsum' : `zzz unmatched ${i}`]));
    const started = Date.now();
    const r = only(data, source);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.checked).toBe(300);
  });
});
