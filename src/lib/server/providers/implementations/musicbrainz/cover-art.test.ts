// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The cover-art cache holds decoded image bytes in module state, and both of
 * its callers walk an entire music library. It was previously unbounded: entries
 * expired but were only ever dropped when something looked the SAME key up
 * again, and a bulk pass keys by MusicBrainz release ID, so it visits each key
 * exactly once and never comes back. Every cover fetched stayed resident.
 *
 * These cover the bound itself, not the fetching — one oversized image must not
 * empty the cache, and eviction must keep the byte counter honest, or the cache
 * shrinks to nothing (counter drifts high) or stops evicting (counter drifts low).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/tasks/url-safety.js', () => ({
    safeFetch: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

vi.mock('$lib/server/utils/ssrf-guard.js', () => ({
    assertNotPrivateUrl: vi.fn().mockResolvedValue(undefined),
}));

import { safeFetch } from '$lib/server/tasks/url-safety.js';
import { getAlbumArt, __cacheStatsForTest, __clearCacheForTest } from './cover-art.js';

const mockFetch = vi.mocked(safeFetch);

const MB = 1024 * 1024;

/** CAA is two hops: a JSON index, then the image itself. */
function mockArtOfSize(bytes: number): void {
    mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/image.jpg')) {
            return Promise.resolve(
                new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/jpeg' } }),
            );
        }
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    images: [
                        {
                            front: true,
                            back: false,
                            types: ['Front'],
                            image: 'https://coverartarchive.org/image.jpg',
                            thumbnails: {},
                        },
                    ],
                }),
            ),
        );
    });
}

describe('musicbrainz/cover-art cache bounds', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __clearCacheForTest();
    });

    it('evicts once resident image bytes exceed the budget', async () => {
        mockArtOfSize(8 * MB);

        // 16 distinct albums x 8 MB = 128 MB fetched against a 64 MB budget.
        for (let i = 0; i < 16; i++) {
            await getAlbumArt(`release-${i}`);
        }

        const { bytes, entries } = __cacheStatsForTest();
        expect(bytes).toBeLessThanOrEqual(64 * MB);
        // Bounded, but not emptied — over-eviction would technically satisfy the
        // bound while destroying the cache, so pin the count the budget implies.
        expect(entries).toBe(8);
    });

    it('keeps the byte counter consistent with what is actually resident', async () => {
        mockArtOfSize(4 * MB);

        for (let i = 0; i < 8; i++) {
            await getAlbumArt(`release-${i}`);
        }

        const { bytes, entries } = __cacheStatsForTest();
        // A drifting counter is the silent failure: too high and the cache
        // evicts itself down to nothing, too low and the bound stops applying.
        expect(bytes).toBe(entries * 4 * MB);
    });

    it('caps entries even when every result is a zero-byte negative', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 404 } as unknown as Response);

        for (let i = 0; i < 600; i++) {
            await getAlbumArt(`missing-${i}`);
        }

        const { entries, bytes } = __cacheStatsForTest();
        expect(bytes).toBe(0);
        expect(entries).toBeLessThanOrEqual(512);
    });

    it('refuses an image past the download cap without touching the cache', async () => {
        mockArtOfSize(1 * MB);
        await getAlbumArt('small-album');
        expect(__cacheStatsForTest().entries).toBe(1);

        mockArtOfSize(65 * MB);
        const oversized = await getAlbumArt('huge-album');

        // The body is cut off at the download cap, so nothing comes back and the
        // cache keeps what it had.
        expect(oversized).toBeNull();
        const { entries, bytes } = __cacheStatsForTest();
        // The refusal is remembered as a miss; no image bytes were added.
        expect(entries).toBe(2);
        expect(bytes).toBe(1 * MB);
    });

    it('serves a repeat lookup from cache rather than re-downloading', async () => {
        // The scanner runs per TRACK, so every track of one album hits the same
        // release key. Losing this makes a 12-track album 12 downloads.
        mockArtOfSize(1 * MB);

        await getAlbumArt('release-a');
        const callsAfterFirst = mockFetch.mock.calls.length;
        await getAlbumArt('release-a');

        expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
    });
});

/**
 * Each release group answers with its own one-byte cover (the byte is the
 * group's index), so a returned buffer says which album it belongs to.
 */
function mockArtPerReleaseGroup(groups: string[]): void {
    mockFetch.mockImplementation((url: string) => {
        const image = /\/image-(\d+)\.jpg$/.exec(url);
        if (image) {
            return Promise.resolve(
                new Response(new Uint8Array([Number(image[1])]), {
                    headers: { 'content-type': 'image/jpeg' },
                }),
            );
        }
        const index = groups.findIndex((g) => url.endsWith(`/release-group/${g}`));
        if (index < 0) return Promise.resolve(new Response(null, { status: 404 }));
        return Promise.resolve(
            new Response(
                JSON.stringify({
                    images: [
                        {
                            front: true,
                            back: false,
                            types: ['Front'],
                            image: `https://coverartarchive.org/image-${index}.jpg`,
                            thumbnails: {},
                        },
                    ],
                }),
            ),
        );
    });
}

describe('musicbrainz/cover-art release-group-only lookups', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __clearCacheForTest();
    });

    // Prod 2026-10-01: album-enrichment passed '' as the release id for albums
    // that only had a release group, they all shared the cache key `release:`,
    // and ~30 albums in a row got the first one's cover.
    it.each([
        ['an empty string', ''],
        ['null', null],
        ['undefined', undefined],
    ])('gives each album its own cover when the release id is %s', async (_label, release) => {
        mockArtPerReleaseGroup(['rg-in-the-closet', 'rg-promiscuous']);

        const first = await getAlbumArt(release, 'rg-in-the-closet');
        const second = await getAlbumArt(release, 'rg-promiscuous');

        expect([...(first?.buffer ?? [])]).toEqual([0]);
        expect([...(second?.buffer ?? [])]).toEqual([1]);
    });

    it('never asks CAA for a release without an id', async () => {
        mockArtPerReleaseGroup(['rg-a']);

        await getAlbumArt('', 'rg-a');

        const urls = mockFetch.mock.calls.map((call) => String(call[0]));
        expect(urls.some((u) => /\/release\/?$/.test(u))).toBe(false);
    });

    it('still caches by release group', async () => {
        mockArtPerReleaseGroup(['rg-a']);

        await getAlbumArt(null, 'rg-a');
        const callsAfterFirst = mockFetch.mock.calls.length;
        const again = await getAlbumArt(null, 'rg-a');

        expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
        expect([...(again?.buffer ?? [])]).toEqual([0]);
    });

    it('returns null without fetching when neither id is given', async () => {
        await expect(getAlbumArt('', null)).resolves.toBeNull();
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
