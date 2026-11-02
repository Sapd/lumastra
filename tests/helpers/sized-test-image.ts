// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import sharp from 'sharp';

export type TestImageFormat = 'jpeg' | 'png' | 'webp';

const cache = new Map<string, Buffer>();

function encode(format: TestImageFormat, side: number, seed: number): Promise<Buffer> {
    // Noise does not compress, so the encoded size tracks the pixel count.
    const pixels = Buffer.alloc(side * side * 3);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < pixels.length; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        pixels[i] = x & 0xff;
    }
    const img = sharp(pixels, { raw: { width: side, height: side, channels: 3 } });
    if (format === 'jpeg') return img.jpeg({ quality: 100 }).toBuffer();
    if (format === 'png') return img.png({ compressionLevel: 0 }).toBuffer();
    return img.webp({ lossless: true }).toBuffer();
}

/**
 * A real, decodable image whose encoded size is within 4% below `targetBytes`
 * (never above it, so "1.9 MiB" stays under a 2 MiB cap).
 */
export async function makeImageOfSize(
    format: TestImageFormat,
    targetBytes: number,
): Promise<Buffer> {
    const key = `${format}:${targetBytes}`;
    const hit = cache.get(key);
    if (hit) return hit;

    let side = Math.max(16, Math.round(Math.sqrt(targetBytes / 3)));
    for (let attempt = 0; attempt < 12; attempt++) {
        const buf = await encode(format, side, side);
        if (buf.length <= targetBytes && buf.length >= targetBytes * 0.96) {
            cache.set(key, buf);
            return buf;
        }
        const next = Math.round(side * Math.sqrt((targetBytes * 0.98) / buf.length));
        side = next === side ? side + (buf.length > targetBytes ? -1 : 1) : next;
    }
    throw new Error(`could not hit ${targetBytes} bytes for ${format}`);
}
