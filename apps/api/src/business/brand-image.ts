import type { BrandImageType } from '@1pos/database';

export interface ImageInfo {
  contentType: BrandImageType;
  width: number;
  height: number;
}

/**
 * The image's type and size, read from its bytes (never from what the client says it is). PNG, JPEG
 * and WebP only: SVG can carry script, and the admin and the till show these images inline. Null when
 * the bytes are none of those or their header is cut short.
 */
export function readImage(b: Buffer): ImageInfo | null {
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG) && b.toString('latin1', 12, 16) === 'IHDR') {
    return sized('image/png', b.readUInt32BE(16), b.readUInt32BE(20));
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpeg(b);
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return webp(b);
  return null;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sized(contentType: BrandImageType, width: number, height: number): ImageInfo | null {
  return width >= 1 && height >= 1 && width <= 8192 && height <= 8192 ? { contentType, width, height } : null;
}

/** The first start-of-frame segment holds the size (SOF0–SOF15, except DHT C4, JPG C8 and DAC CC). */
function jpeg(b: Buffer): ImageInfo | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return sized('image/jpeg', b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function webp(b: Buffer): ImageInfo | null {
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') return sized('image/webp', b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  if (chunk === 'VP8L' && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return sized('image/webp', (bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') return sized('image/webp', b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  return null;
}
