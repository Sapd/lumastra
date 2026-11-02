// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { CONVERTIBLE_CONTENT_TYPES, convertCoverToPng } from './album-artwork-convert.js';

describe('convertCoverToPng', () => {
    it('re-encodes a GIF cover to a PNG of the same size', async () => {
        // Two prod albums sat at failed_permanent because their cover was a GIF.
        const gif = await sharp({
            create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 10, b: 10 } },
        })
            .gif()
            .toBuffer();

        const result = await convertCoverToPng(gif);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const meta = await sharp(result.buffer).metadata();
        expect(meta.format).toBe('png');
        expect([meta.width, meta.height]).toEqual([40, 30]);
    });

    it('reports bytes that are not an image as undecodable', async () => {
        const result = await convertCoverToPng(Buffer.from('<html>not an image</html>'));
        expect(result).toMatchObject({ ok: false });
        expect(!result.ok && result.reason).toMatch(/^undecodable_image: /);
    });

    it('never converts SVG, which can carry script', () => {
        expect(CONVERTIBLE_CONTENT_TYPES.has('image/svg+xml')).toBe(false);
        expect(CONVERTIBLE_CONTENT_TYPES.has('image/gif')).toBe(true);
    });
});
