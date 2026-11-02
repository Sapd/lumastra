// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Size rules are Jellyfin's ImageHelper.GetNewImageSize (Resize → ResizeFill →
// ScaleDownToFit); the cases mirror Jellyfin's own DrawingUtils/ImageHelper
// tests where they exist.

import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

vi.mock('./cache', () => ({
    // Pass-through: no disk writes from unit tests.
    ImageCache: class {
        async getCachedOrFetch(_key: string, fetch: () => Promise<Buffer>) {
            return { buffer: await fetch(), wasHit: false };
        }
    },
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
    MAX_IMAGE_BOX_DIMENSION,
    boxDerivativeKey,
    boxTargetSize,
    snapBox,
    snapBoxQuality,
    getCatalogImageInBox,
    isEmptyBox,
    sourcePresetForBox,
} from './box-resize';
import type { ImageResponse } from './types';

const POSTER = { width: 1000, height: 1500 };

describe('boxTargetSize (Jellyfin GetNewImageSize)', () => {
    it('no box → the source size', () => {
        expect(boxTargetSize({}, POSTER)).toEqual(POSTER);
    });

    it('width + height → exactly that box, aspect not kept', () => {
        expect(boxTargetSize({ width: 300, height: 300 }, POSTER)).toEqual({
            width: 300,
            height: 300,
        });
    });

    it('width alone → height follows the aspect ratio', () => {
        expect(boxTargetSize({ width: 200 }, POSTER)).toEqual({ width: 200, height: 300 });
    });

    it('height alone → width follows the aspect ratio', () => {
        expect(boxTargetSize({ height: 300 }, POSTER)).toEqual({ width: 200, height: 300 });
    });

    it('maxWidth / maxHeight fit inside the box', () => {
        expect(boxTargetSize({ maxWidth: 400 }, POSTER)).toEqual({ width: 400, height: 600 });
        expect(boxTargetSize({ maxHeight: 600 }, POSTER)).toEqual({ width: 400, height: 600 });
        expect(boxTargetSize({ maxWidth: 400, maxHeight: 300 }, POSTER)).toEqual({
            width: 200,
            height: 300,
        });
        // Already smaller than the max: unchanged.
        expect(boxTargetSize({ maxWidth: 4000 }, POSTER)).toEqual(POSTER);
    });

    it('fillWidth / fillHeight cover the box with the aspect ratio kept (no crop)', () => {
        // A 2:3 poster filling a 16:9 box must be at least 400 wide.
        expect(boxTargetSize({ fillWidth: 400, fillHeight: 225 }, POSTER)).toEqual({
            width: 400,
            height: 600,
        });
        // Filling a tall box: height decides.
        expect(boxTargetSize({ fillWidth: 100, fillHeight: 450 }, POSTER)).toEqual({
            width: 300,
            height: 450,
        });
        expect(boxTargetSize({ fillWidth: 250 }, POSTER)).toEqual({ width: 250, height: 375 });
    });

    it('never larger than the source', () => {
        expect(boxTargetSize({ fillWidth: 3000, fillHeight: 3000 }, POSTER)).toEqual(POSTER);
        expect(boxTargetSize({ width: 2000, height: 3000 }, POSTER)).toEqual(POSTER);
        expect(boxTargetSize({ width: 2000 }, { width: 600, height: 336 })).toEqual({
            width: 600,
            height: 336,
        });
    });

    it(`caps every requested dimension at ${MAX_IMAGE_BOX_DIMENSION}`, () => {
        const huge = { width: 20000, height: 20000 };
        expect(boxTargetSize({ width: 999999, height: 999999 }, huge)).toEqual({
            width: MAX_IMAGE_BOX_DIMENSION,
            height: MAX_IMAGE_BOX_DIMENSION,
        });
        expect(boxTargetSize({ fillWidth: 999999 }, huge).width).toBe(MAX_IMAGE_BOX_DIMENSION);
    });

    it('zero / negative values are ignored like Jellyfin', () => {
        expect(boxTargetSize({ width: 0, maxHeight: -5 }, POSTER)).toEqual(POSTER);
    });
});

describe('sourcePresetForBox', () => {
    it('picks the smallest preset wide enough for the box', () => {
        expect(sourcePresetForBox({ fillWidth: 200, fillHeight: 300 }, 'poster')).toBe('medium');
        expect(sourcePresetForBox({ maxWidth: 240 }, 'poster')).toBe('thumb');
        expect(sourcePresetForBox({ fillWidth: 1280 }, 'backdrop')).toBe('hd');
        expect(sourcePresetForBox({ maxHeight: 1000 }, 'backdrop')).toBe('wide');
        expect(sourcePresetForBox({ width: 3000 }, 'backdrop')).toBe('full');
    });

    it('height-only boxes assume the widest plausible shape', () => {
        // A square cover at height 400 needs 400 wide → card (480), not thumb.
        expect(sourcePresetForBox({ fillHeight: 400 }, 'poster')).toBe('card');
    });

    it('isEmptyBox', () => {
        expect(isEmptyBox({})).toBe(true);
        expect(isEmptyBox({ fillWidth: 1 })).toBe(false);
    });
});

async function png(width: number, height: number): Promise<Buffer> {
    return sharp({
        create: { width, height, channels: 3, background: '#336699' },
    })
        .png()
        .toBuffer();
}

function serviceReturning(result: ImageResponse | null) {
    return { getImageByCatalogId: vi.fn().mockResolvedValue(result) };
}

describe('getCatalogImageInBox', () => {
    it('an empty box is a plain catalog call with the caller quality/format', async () => {
        const base = { buffer: Buffer.from('x'), contentType: 'image/webp', cacheControl: 'c' };
        const service = serviceReturning(base);
        const result = await getCatalogImageInBox(
            service,
            'id',
            'poster',
            {},
            {
                quality: 80,
                format: 'jpg',
            },
        );
        expect(result).toBe(base);
        expect(service.getImageByCatalogId).toHaveBeenCalledWith('id', 'poster', {
            quality: 80,
            format: 'jpg',
        });
    });

    it('fetches a bounded preset source and resizes it to the box', async () => {
        const service = serviceReturning({
            buffer: await png(480, 720),
            contentType: 'image/png',
            cacheControl: 'public, max-age=86400',
        });
        const result = await getCatalogImageInBox(
            service,
            'id',
            'poster',
            { fillWidth: 200, fillHeight: 280 },
            { format: 'jpg', quality: 85 },
        );
        expect(service.getImageByCatalogId).toHaveBeenCalledWith('id', 'poster', {
            size: 'medium',
            bounded: true,
        });
        expect(result?.contentType).toBe('image/jpeg');
        const meta = await sharp(result!.buffer).metadata();
        expect(meta.format).toBe('jpeg');
        expect([meta.width, meta.height]).toEqual([200, 300]);
        expect(result?.cacheControl).toBe('public, max-age=86400');
    });

    it('width + height stretches to the exact box', async () => {
        const service = serviceReturning({
            buffer: await png(480, 720),
            contentType: 'image/png',
            cacheControl: 'c',
        });
        const result = await getCatalogImageInBox(service, 'id', 'poster', {
            width: 80,
            height: 80,
        });
        const meta = await sharp(result!.buffer).metadata();
        expect([meta.width, meta.height]).toEqual([80, 80]);
        // PNG source with no requested format keeps PNG (logo transparency).
        expect(result?.contentType).toBe('image/png');
    });

    it('never upscales the source', async () => {
        const service = serviceReturning({
            buffer: await png(250, 375),
            contentType: 'image/png',
            cacheControl: 'c',
        });
        const result = await getCatalogImageInBox(service, 'id', 'poster', { maxWidth: 2000 });
        // Same size, same format, no quality: the source as is.
        const meta = await sharp(result!.buffer).metadata();
        expect([meta.width, meta.height]).toEqual([250, 375]);
    });

    it('no image → null (the route serves its placeholder)', async () => {
        const service = serviceReturning(null);
        expect(await getCatalogImageInBox(service, 'id', 'poster', { fillWidth: 100 })).toBeNull();
    });

    it('an undecodable source is served unresized', async () => {
        const base = {
            buffer: Buffer.from('not an image'),
            contentType: 'image/webp',
            cacheControl: 'c',
        };
        const service = serviceReturning(base);
        expect(await getCatalogImageInBox(service, 'id', 'poster', { fillWidth: 100 })).toBe(base);
    });
});

describe('variant ladder (public route: bounded derivative space)', () => {
    it('snaps every box value up to the 40 px step, capped', () => {
        expect(snapBox({ fillWidth: 301, fillHeight: 449 })).toEqual({
            fillWidth: 320,
            fillHeight: 480,
        });
        expect(snapBox({ maxWidth: 320 })).toEqual({ maxWidth: 320 });
        expect(snapBox({ width: 1, height: 99999 })).toEqual({
            width: 40,
            height: MAX_IMAGE_BOX_DIMENSION,
        });
        expect(snapBox({ maxHeight: 0, width: -3 })).toEqual({});
    });

    it('snaps quality to the nearest shared tier', () => {
        expect(snapBoxQuality(1)).toBe(50);
        expect(snapBoxQuality(74)).toBe(70);
        expect(snapBoxQuality(90)).toBe(85);
        expect(snapBoxQuality(100)).toBe(95);
    });

    it('two near-identical requests resolve to one derivative key', () => {
        const source = { width: 480, height: 720 };
        const key = (box: Parameters<typeof snapBox>[0], q: number): string =>
            boxDerivativeKey(
                'id',
                'poster',
                'srchash',
                boxTargetSize(snapBox(box), source),
                'webp',
                snapBoxQuality(q),
            );
        expect(key({ fillWidth: 301, fillHeight: 451 }, 88)).toBe(
            key({ fillWidth: 315, fillHeight: 470 }, 84),
        );
        expect(key({ fillWidth: 301 }, 88)).not.toBe(key({ fillWidth: 341 }, 88));
    });
});
