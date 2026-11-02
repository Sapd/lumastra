// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    fetch: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    config: { AUDIOURL: 'http://abs.invalid', AUDIOAPIKEY: 'test-key' },
}));
vi.mock('$lib/server/config', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/config')>()),
    config: mocks.config,
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ error: mocks.error, debug: mocks.debug, warn: vi.fn() }) },
}));
vi.mock('$lib/server/utils/fetch-utils.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/fetch-utils.js')>()),
    fetchWithTimeout: mocks.fetch,
}));
// Disk caching/encoding is orthogonal to classifying a failed upstream request.
vi.mock('../cache', () => ({
    ImageCache: class {
        async getCachedOrFetch(_key: string, fetch: () => Promise<Buffer>) {
            return { buffer: await fetch(), wasHit: false };
        }
    },
}));

import { AudiobookshelfImageProvider } from './audiobookshelf.provider';
import sharp from 'sharp';

const request = { itemId: 'removed-book', revision: 1, options: { format: 'webp' as const } };

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.config.AUDIOURL = 'http://abs.invalid';
    mocks.fetch.mockImplementation(async () => new Response(null, { status: 404 }));
});
afterEach(() => {
    vi.useRealTimers();
});

describe('Audiobookshelf cover misses', () => {
    it('returns null for upstream 404 without an ERROR log', async () => {
        const provider = new AudiobookshelfImageProvider();
        expect(await provider.getCover(request)).toBeNull();
        expect(mocks.fetch).toHaveBeenCalledOnce();
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it('shares a short negative cache across output variants and retries after expiry', async () => {
        const provider = new AudiobookshelfImageProvider();
        expect(await provider.getCover(request)).toBeNull();
        vi.advanceTimersByTime(29_000);
        expect(
            await provider.getCover({ ...request, options: { format: 'avif', size: 'card' } }),
        ).toBeNull();
        expect(mocks.fetch).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(1_001);
        expect(await provider.getCover(request)).toBeNull();
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it('serves a restored cover after the negative cache expires', async () => {
        const provider = new AudiobookshelfImageProvider();
        await provider.getCover(request);
        const cover = await sharp({
            create: { width: 2, height: 2, channels: 3, background: 'red' },
        })
            .png()
            .toBuffer();
        mocks.fetch.mockImplementation(async () => new Response(new Uint8Array(cover)));
        vi.advanceTimersByTime(30_001);
        const result = await provider.getCover(request);
        expect(result?.contentType).toBe('image/webp');
        expect(result?.buffer.length).toBeGreaterThan(0);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(mocks.error).not.toHaveBeenCalled();
    });

    it('does not hide a changed cover revision, content identity, item or source', async () => {
        const provider = new AudiobookshelfImageProvider();
        await provider.getCover(request);
        await provider.getCover({ ...request, revision: 2 });
        await provider.getCover({ ...request, contentRevision: 'new-content' });
        await provider.getCover({ ...request, itemId: 'another-book' });
        mocks.config.AUDIOURL = 'http://another-abs.invalid';
        await provider.getCover(request);
        expect(mocks.fetch).toHaveBeenCalledTimes(5);
    });

    it.each([401, 403, 429, 500, 503])(
        'keeps HTTP %i at ERROR and does not negative-cache it',
        async (status) => {
            mocks.fetch.mockImplementation(async () => new Response(null, { status }));
            const provider = new AudiobookshelfImageProvider();
            expect(await provider.getCover(request)).toBeNull();
            expect(await provider.getCover(request)).toBeNull();
            expect(mocks.fetch).toHaveBeenCalledTimes(2);
            expect(mocks.error).toHaveBeenCalledTimes(2);
        },
    );

    it('keeps network failures at ERROR and retries them', async () => {
        mocks.fetch.mockRejectedValue(new Error('connection reset'));
        const provider = new AudiobookshelfImageProvider();
        await provider.getCover(request);
        await provider.getCover(request);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        expect(mocks.error).toHaveBeenCalledTimes(2);
    });
});
