// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), cover: vi.fn(), error: vi.fn() }));
vi.mock('$lib/server/database/queries/external-ids.queries.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/external-ids.queries.js')
    >()),
    findMediaIdByProviderExternalId: mocks.lookup,
}));
vi.mock('$lib/server/audiobookshelf', () => ({
    audiobookshelfClient: { getBookImage: mocks.cover },
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ error: mocks.error, debug: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('./cache', () => ({
    ImageCache: class {
        async getCachedOrFetch(_key: string, fetch: () => Promise<Buffer>) {
            return { buffer: await fetch(), wasHit: false };
        }
    },
}));

import { ImageProxyService } from './service';
import sharp from 'sharp';

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.lookup.mockResolvedValue('00000000-0000-4000-8000-000000000001');
    mocks.cover.mockImplementation(async () => new Response(null, { status: 404 }));
});
afterEach(() => {
    vi.useRealTimers();
});

describe('legacy audiobook cover misses', () => {
    it('does not fetch an unknown/removed local item, and rechecks after a short miss TTL', async () => {
        mocks.lookup.mockResolvedValue(null);
        const sql = vi.fn();
        const service = new ImageProxyService(sql as never);
        expect(await service.getAudiobookImage('removed-book')).toBeNull();
        expect(await service.getAudiobookImage('removed-book')).toBeNull();
        expect(mocks.cover).not.toHaveBeenCalled();
        expect(mocks.lookup).toHaveBeenCalledOnce();
        expect(mocks.lookup).toHaveBeenCalledWith(sql, {
            provider: 'audiobookshelf',
            externalId: 'removed-book',
            mediaType: 'audiobook',
        });
        vi.advanceTimersByTime(30_001);
        mocks.lookup.mockResolvedValue('00000000-0000-4000-8000-000000000001');
        await service.getAudiobookImage('removed-book');
        expect(mocks.lookup).toHaveBeenCalledTimes(2);
        expect(mocks.cover).toHaveBeenCalledOnce();
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it('negative-caches an upstream 404 across output variants, then retries', async () => {
        const service = new ImageProxyService({} as never);
        expect(await service.getAudiobookImage('book')).toBeNull();
        expect(
            await service.getAudiobookImage('book', { size: 'card', format: 'avif' }),
        ).toBeNull();
        expect(mocks.cover).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(30_001);
        expect(await service.getAudiobookImage('book')).toBeNull();
        expect(mocks.cover).toHaveBeenCalledTimes(2);
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it('serves a restored cover after the negative cache expires', async () => {
        const service = new ImageProxyService({} as never);
        await service.getAudiobookImage('book');
        const cover = await sharp({
            create: { width: 2, height: 2, channels: 3, background: 'red' },
        })
            .png()
            .toBuffer();
        mocks.cover.mockImplementation(async () => new Response(new Uint8Array(cover)));
        vi.advanceTimersByTime(30_001);
        const result = await service.getAudiobookImage('book');
        expect(result?.contentType).toBe('image/webp');
        expect(result?.buffer.byteLength).toBeGreaterThan(0);
        expect(mocks.cover).toHaveBeenCalledTimes(2);
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it('logs database failures as ERROR without caching them as missing items', async () => {
        mocks.lookup.mockRejectedValue(new Error('database unavailable'));
        const service = new ImageProxyService({} as never);
        await service.getAudiobookImage('book');
        await service.getAudiobookImage('book');
        expect(mocks.lookup).toHaveBeenCalledTimes(2);
        expect(mocks.cover).not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalledTimes(2);
    });

    it.each([401, 403, 429, 500, 503])(
        'logs HTTP %i as ERROR without caching it',
        async (status) => {
            mocks.cover.mockImplementation(async () => new Response(null, { status }));
            const service = new ImageProxyService({} as never);
            await service.getAudiobookImage('book');
            await service.getAudiobookImage('book');
            expect(mocks.cover).toHaveBeenCalledTimes(2);
            expect(mocks.error).toHaveBeenCalledTimes(2);
        },
    );

    it('logs network failures as ERROR without caching them', async () => {
        mocks.cover.mockRejectedValue(new Error('connection reset'));
        const service = new ImageProxyService({} as never);
        await service.getAudiobookImage('book');
        await service.getAudiobookImage('book');
        expect(mocks.cover).toHaveBeenCalledTimes(2);
        expect(mocks.error).toHaveBeenCalledTimes(2);
    });
});
