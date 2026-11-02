// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    getNowPlaying,
    peekNowPlaying,
    clearRadioCache,
    __setIcyForTests,
    previewNowPlaying,
} from '../service';

const STATION = {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    streamUrl: 'https://example.com/stream',
    metadataSource: {
        url: 'https://example.com/np.json',
        format: 'json' as const,
        jsonPaths: {
            title: '$.song.title',
            artist: '$.song.artist',
        },
    },
};

beforeEach(async () => {
    await clearRadioCache(STATION.id);
    vi.restoreAllMocks();
});

function mockFetchJson(obj: unknown): void {
    globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(obj), {
            headers: { 'Content-Type': 'application/json' },
        }),
    );
}

describe('radio-metadata service', () => {
    it('projects upstream duration and elapsed seconds to integer milliseconds', async () => {
        mockFetchJson({ song: { duration: 213.4567, elapsed: 12.3456 } });
        const result = await getNowPlaying({
            ...STATION,
            metadataSource: {
                ...STATION.metadataSource,
                jsonPaths: {
                    trackDurationSeconds: '$.song.duration',
                    trackElapsedSeconds: '$.song.elapsed',
                },
            },
        });
        expect(result.track.durationMs).toBe(213457);
        expect(result.track.elapsedMs).toBe(12346);
        expect(result.track).not.toHaveProperty('durationSeconds');
        expect(result.track).not.toHaveProperty('elapsedSeconds');
    });

    it('fetches, parses, caches, and returns nested RadioNowPlaying', async () => {
        mockFetchJson({ song: { title: 'Lantern-Tale', artist: 'Lanter' } });
        const result = await getNowPlaying(STATION);
        expect(result.source).toBe('url');
        expect(result.track.title).toBe('Lantern-Tale');
        expect(result.track.artist).toBe('Lanter');
        expect(result.stationId).toBe(STATION.id);
    });

    it('serves second call from cache without re-fetching', async () => {
        const spy = vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ song: { title: 'A', artist: 'B' } }), {
                headers: { 'Content-Type': 'application/json' },
            }),
        );
        globalThis.fetch = spy;
        await getNowPlaying(STATION);
        await getNowPlaying(STATION);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('substitutes proxy URLs for image fields', async () => {
        mockFetchJson({
            song: { title: 'A', artist: 'B' },
            dj: { avatar: 'https://cdn.example.com/dj.png' },
        });
        const station = {
            ...STATION,
            metadataSource: {
                ...STATION.metadataSource,
                jsonPaths: {
                    ...STATION.metadataSource.jsonPaths,
                    djImageUrl: '$.dj.avatar',
                },
            },
        };
        const result = await getNowPlaying(station);
        expect(result.dj.imageUrl).toBe(`/api/music/radio/${STATION.id}/image/dj`);
    });

    it('peekNowPlaying returns null on cache miss', async () => {
        const result = await peekNowPlaying(STATION);
        expect(result).toBeNull();
    });

    it('peekNowPlaying returns cache after getNowPlaying has warmed it', async () => {
        mockFetchJson({ song: { title: 'A', artist: 'B' } });
        await getNowPlaying(STATION);
        const peek = await peekNowPlaying(STATION);
        expect(peek?.track.title).toBe('A');
    });

    it('falls back to ICY when URL fetch fails', async () => {
        globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('boom'));
        __setIcyForTests(async () => 'Lanter - Lantern-Tale');

        const result = await getNowPlaying(STATION);
        expect(result.source).toBe('icy');
        expect(result.track.title).toBe('Lanter - Lantern-Tale');
    });

    it('returns source=null with empty fields when both URL + ICY fail', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom'));
        __setIcyForTests(async () => null);

        const result = await getNowPlaying(STATION);
        expect(result.source).toBeNull();
        expect(result.track.title).toBeUndefined();
    });

    it('serves stale data with source=stale when both URL and ICY fail after a prior success', async () => {
        // First: succeed to seed the cache
        mockFetchJson({ song: { title: 'Lantern-Tale', artist: 'Lanter' } });
        await getNowPlaying(STATION);

        // Age the record so it's past FRESH_MS (30s). We can't time-travel,
        // so force a cache re-read path: clear is too aggressive. Instead,
        // use the test seam — directly manipulate the cache entry's fetchedAt.
        const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache');
        const c = cacheManager.for(CACHE_NAMESPACES.radioNowPlaying);
        const stored = await c.get<Record<string, unknown>>(`station:v2:${STATION.id}`);
        expect(stored).toBeTruthy();
        // Rewrite with fetchedAt 1 min ago (within STALE_MS)
        await c.set(`station:v2:${STATION.id}`, {
            ...stored,
            fetchedAt: new Date(Date.now() - 60_000).toISOString(),
        });

        // Now both sources fail
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom'));
        __setIcyForTests(async () => null);

        const result = await getNowPlaying(STATION);
        expect(result.source).toBe('stale');
        expect(result.track.title).toBe('Lantern-Tale');
    });

    it('writes _lastError on URL failure (visible via peekCacheRecord)', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('upstream kaboom'));
        __setIcyForTests(async () => null);

        await getNowPlaying(STATION);

        const { peekCacheRecord } = await import('../service');
        const rec = await peekCacheRecord(STATION.id);
        expect(rec?._lastError?.message).toContain('upstream kaboom');
    });

    it('clears _lastError after a successful URL fetch', async () => {
        // First fail
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('first fail'));
        __setIcyForTests(async () => null);
        await getNowPlaying(STATION);

        // Clear cache TTL freshness by resetting in the cache
        await clearRadioCache(STATION.id);

        // Then succeed
        mockFetchJson({ song: { title: 'OK', artist: 'Me' } });
        __setIcyForTests(async () => null);
        await getNowPlaying(STATION);

        const { peekCacheRecord } = await import('../service');
        const rec = await peekCacheRecord(STATION.id);
        expect(rec?._lastError).toBeUndefined();
    });

    it('previewNowPlaying does not write to cache', async () => {
        mockFetchJson({ song: { title: 'Preview', artist: 'NoCache' } });
        await previewNowPlaying(STATION);
        const peek = await peekNowPlaying(STATION);
        expect(peek).toBeNull();
    });

    // The create form previews before a stream URL is entered.
    it('previewNowPlaying skips the ICY fallback when there is no stream URL', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
        const icy = vi.fn(async () => 'Should not be asked');
        __setIcyForTests(icy);
        const result = await previewNowPlaying({ ...STATION, streamUrl: '' });
        expect(icy).not.toHaveBeenCalled();
        expect(result.source).toBeNull();
    });
});

// Security review 2026-09-12, C7 — a quadratic regex over a hostile upstream
// body used to stall the whole event loop, once per poll tick.
describe('radio-metadata service regex budget (C7)', () => {
    const REGEX_STATION = {
        id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        streamUrl: 'https://example.com/stream',
        metadataSource: {
            url: 'https://example.com/np.txt',
            format: 'regex' as const,
            regexPattern: '(?<artist>.+) - (?<title>.+)',
        },
    };

    function mockFetchPathologicalText(): ReturnType<typeof vi.fn> {
        const spy = vi.fn().mockImplementation(
            async () =>
                new Response('a'.repeat(200_000), {
                    headers: { 'Content-Type': 'text/plain' },
                }),
        );
        globalThis.fetch = spy;
        return spy;
    }

    beforeEach(async () => {
        await clearRadioCache(REGEX_STATION.id);
        vi.restoreAllMocks();
    });

    it('returns a failure result quickly instead of hanging', async () => {
        mockFetchPathologicalText();
        __setIcyForTests(async () => null);

        const started = Date.now();
        const result = await getNowPlaying(REGEX_STATION);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(result.source).toBeNull();

        const { peekCacheRecord } = await import('../service');
        const rec = await peekCacheRecord(REGEX_STATION.id);
        expect(rec?._lastError?.message).toMatch(/budget|timed out/i);
    });

    it('does not re-run the doomed match on the next poll tick', async () => {
        const spy = mockFetchPathologicalText();
        __setIcyForTests(async () => null);

        await getNowPlaying(REGEX_STATION);
        expect(spy).toHaveBeenCalledTimes(1);

        // Age the negative record past FRESH_MS so the poller would normally
        // re-fetch and re-run the match.
        const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache');
        const c = cacheManager.for(CACHE_NAMESPACES.radioNowPlaying);
        const stored = await c.get<Record<string, unknown>>(`station:v2:${REGEX_STATION.id}`);
        await c.set(`station:v2:${REGEX_STATION.id}`, {
            ...stored,
            fetchedAt: new Date(Date.now() - 60_000).toISOString(),
        });

        await getNowPlaying(REGEX_STATION);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does not poison the shared cache from the admin preview path', async () => {
        mockFetchPathologicalText();
        __setIcyForTests(async () => null);

        const started = Date.now();
        const result = await previewNowPlaying(REGEX_STATION);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(result.source).toBeNull();
        expect(await peekNowPlaying(REGEX_STATION)).toBeNull();
    });
});
