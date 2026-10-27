import { describe, expect, it } from 'vitest';
import { readImage } from '../../src/business/brand-image.js';
import { contactLines, receiptBranding, NO_BRANDING } from '../../src/business/branding.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** WebP heads: lossy (VP8), lossless (VP8L) and extended (VP8X), each 640×480. */
function webp(chunk: string, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), Buffer.from(chunk, 'latin1'), Buffer.from([0, 0, 0, 0]), body, Buffer.alloc(16)]);
}
const vp8 = webp('VP8 ', Buffer.from([0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]));
const vp8l = (() => {
  const bits = (640 - 1) | ((480 - 1) << 14);
  const b = Buffer.alloc(5);
  b[0] = 0x2f;
  b.writeUInt32LE(bits, 1);
  return webp('VP8L', b);
})();
const vp8x = (() => {
  const b = Buffer.alloc(10);
  b.writeUIntLE(640 - 1, 4, 3);
  b.writeUIntLE(480 - 1, 7, 3);
  return webp('VP8X', b);
})();

describe('brand images are read from their bytes', () => {
  it('knows PNG, JPEG and the three WebP kinds, with their size', () => {
    expect(readImage(PNG)).toEqual({ contentType: 'image/png', width: 1, height: 1 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(readImage(jpeg)).toEqual({ contentType: 'image/jpeg', width: 640, height: 480 });
    for (const w of [vp8, vp8l, vp8x]) expect(readImage(w)).toEqual({ contentType: 'image/webp', width: 640, height: 480 });
  });

  it('refuses SVG, GIF, cut-short heads and absurd sizes', () => {
    expect(readImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(readImage(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))).toBeNull();
    expect(readImage(PNG.subarray(0, 20))).toBeNull();
    expect(readImage(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    const wide = Buffer.from(PNG);
    wide.writeUInt32BE(100_000, 16);
    expect(readImage(wide)).toBeNull();
  });
});

describe('receipt branding', () => {
  it('splits the messages into lines and prints the contact details without schemes', () => {
    const b = { ...NO_BRANDING, receiptHeader: 'Open daily', receiptFooter: 'Salamat!\n\nSee you', contactPhone: '0917 000 0000', website: 'https://shop.example.ph/', instagram: 'shop' };
    expect(receiptBranding(b)).toEqual({ header: ['Open daily'], footer: ['Salamat!', 'See you'], contact: ['0917 000 0000', 'shop.example.ph', 'instagram.com/shop'], logoSha256: null });
    expect(contactLines(NO_BRANDING)).toEqual([]);
  });
});
