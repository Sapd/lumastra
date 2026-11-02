// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// With the REAL disk cache: near-identical boxes from a public client hit the
// derivative the first one wrote instead of encoding (and storing) their own.

import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { getCatalogImageInBox } from './box-resize';

describe('getCatalogImageInBox — shared derivative cache', () => {
    it('fillWidth=301 and fillWidth=315 share one cached derivative', async () => {
        const buffer = await sharp({
            create: { width: 480, height: 720, channels: 3, background: '#112233' },
        })
            .png()
            .toBuffer();
        const service = {
            getImageByCatalogId: vi
                .fn()
                .mockResolvedValue({ buffer, contentType: 'image/png', cacheControl: 'c' }),
        };
        // A fresh id per run: the cache directory outlives the test.
        const id = randomUUID();
        const first = await getCatalogImageInBox(
            service,
            id,
            'poster',
            { fillWidth: 301 },
            {
                quality: 88,
            },
        );
        expect(first?.cacheStatus).toBe('MISS');
        // ImageCache writes in the background: wait until the FIRST box reads
        // back as a hit, then ask once with the second box.
        for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 50));
            const again = await getCatalogImageInBox(
                service,
                id,
                'poster',
                { fillWidth: 301 },
                {
                    quality: 88,
                },
            );
            if (again?.cacheStatus === 'HIT') break;
        }
        const second = await getCatalogImageInBox(
            service,
            id,
            'poster',
            { fillWidth: 315 },
            {
                quality: 84,
            },
        );
        expect(second?.cacheStatus).toBe('HIT');
        expect(second?.buffer.equals(first!.buffer)).toBe(true);
        const meta = await sharp(second!.buffer).metadata();
        expect([meta.width, meta.height]).toEqual([320, 480]);
    });
});
