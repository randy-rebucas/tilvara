import { describe, expect, it } from 'vitest';
import { inStoreEan13 } from '../../src/catalog/catalog.service.js';
import { ExportLinks } from '../../src/exports/export-links.js';

const ids = { e: '01900000-0000-7000-8000-000000000001', t: '01900000-0000-7000-8000-000000000002', u: '01900000-0000-7000-8000-000000000003' };

describe('data export links (ADR-0016 slice 6)', () => {
  const links = new ExportLinks('x'.repeat(40));
  const now = 1_800_000_000_000;

  it('a genuine link verifies until it expires', () => {
    const token = links.sign({ ...ids, x: now / 1000 + 60 });
    expect(links.verify(token, now)).toEqual({ ...ids, x: now / 1000 + 60 });
    expect(links.verify(token, now + 61_000)).toBeNull();
  });

  it('anything changed, or signed with another key, is refused', () => {
    const token = links.sign({ ...ids, x: now / 1000 + 60 });
    const [body, sig] = token.split('.') as [string, string];
    const other = new ExportLinks('y'.repeat(40)).sign({ ...ids, x: now / 1000 + 60 });
    const swapped = Buffer.from(JSON.stringify({ ...ids, u: ids.t, x: now / 1000 + 60 })).toString('base64url');
    for (const bad of [other, `${swapped}.${sig}`, `${body}.${sig.slice(1)}`, `${body}.${sig}.x`, body, '', 'a.b']) {
      expect(links.verify(bad, now)).toBeNull();
    }
    const notUuid = links.sign({ ...ids, e: "'; DROP TABLE x", x: now / 1000 + 60 });
    expect(links.verify(notUuid, now)).toBeNull();
  });
});

describe('sample barcodes', () => {
  it('are valid EAN-13 in the in-store range', () => {
    expect(inStoreEan13(1)).toBe('2000000000015');
    for (let n = 1; n <= 8; n++) {
      const code = inStoreEan13(n);
      expect(code).toMatch(/^200\d{10}$/);
      const sum = [...code].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
      expect(sum % 10).toBe(0);
    }
  });
});
