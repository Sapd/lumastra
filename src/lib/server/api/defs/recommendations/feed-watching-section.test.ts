// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { ContinueWatchingItem } from '$lib/server/utils/section-builder.js';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { fetchExactWatchingCandidates, watchingItemToFeedItem } from './feed-watching-section.js';
import { filterByPublicMediaType } from './continue-watching.js';
import type { WatchingFeedItem } from '$lib/schemas/api-feed-responses.js';

/**
 * `watchingItemToFeedItem` + assert the row was publishable. It returns null for
 * a row whose `mediaType` has no public representation (covered in its own test
 * below); the mapping tests all use episode rows, so a null there is a genuine
 * failure rather than something every assertion should re-narrow.
 */
function mapped(item: ContinueWatchingItem, origin: 'cw' | 'nextup'): WatchingFeedItem {
    const out = watchingItemToFeedItem(item, origin, 'internal');
    if (out === null) {
        throw new Error(`watchingItemToFeedItem unexpectedly dropped a '${item.mediaType}' row`);
    }
    return out;
}

function cwItem(over: Partial<ContinueWatchingItem>): ContinueWatchingItem {
    return {
        id: '123e4567-e89b-42d3-a456-426614174000',
        title: 'Ep',
        mediaType: 'episode',
        watchProgress: 40,
        duration: 1000,
        externalIds: { internal: '123e4567-e89b-42d3-a456-426614174000' },
        updatedAt: '2026-07-22T00:00:00.000Z',
        ...over,
    } as ContinueWatchingItem;
}

describe('watchingItemToFeedItem', () => {
    it('maps a continue-watching item to the envelope with origin=cw + render state', () => {
        const out = mapped(
            cwItem({
                resumeRatio: 0.4,
                source: 'continue-watching',
                livePlaybackState: 'paused',
                isSuspicious: true,
            }),
            'cw',
        );
        expect(out.origin).toBe('cw');
        expect(out.id).toBe('123e4567-e89b-42d3-a456-426614174000');
        expect(out.progress?.fraction).toBeCloseTo(0.4, 5);
        expect(out.progress?.durationMs).toBe(1000000);
        expect(out.progress?.positionMs).toBe(400000);
        expect(out.progress?.updatedAt).toBe('2026-07-22T00:00:00.000Z');
        expect(out.lastPlayedAt).toBe('2026-07-22T00:00:00.000Z');
        // Render-state parity with the web card.
        expect(out.livePlaybackState).toBe('paused');
        expect(out.isSuspicious).toBe(true);
        expect(out.reason?.kind).toBe('continue-watching');
    });

    it('omits render-state fields when absent (no false isSuspicious/livePlaybackState)', () => {
        const out = mapped(cwItem({ resumeRatio: 0.4 }), 'cw');
        expect(out.livePlaybackState).toBeUndefined();
        expect(out.isSuspicious).toBeUndefined();
    });

    it('maps a next-up item with origin=nextup, progress 0, and episode context', () => {
        const out = mapped(
            cwItem({
                watchProgress: 0,
                resumeRatio: undefined,
                source: 'next-up',
                seriesId: '123e4567-e89b-42d3-a456-426614174001',
                seriesName: 'Show',
                seasonNumber: 2,
                episodeNumber: 5,
            }),
            'nextup',
        );
        expect(out.origin).toBe('nextup');
        expect(out.progress?.positionMs).toBe(0);
        expect(out.context?.series?.id).toBe('123e4567-e89b-42d3-a456-426614174001');
        expect(out.context?.seasonNumber).toBe(2);
        expect(out.reason?.kind).toBe('next-up');
    });

    // `media.type` is a real enum (publicMediaTypeSchema) and is what the client
    // routes playback off. An internal-only media_type therefore must NOT be
    // relabelled or leaked verbatim — the row is dropped.
    it.each(['tvchannel', 'home_video', 'music'])(
        'drops a row whose internal media_type has no public representation (%s)',
        (mediaType) => {
            expect(watchingItemToFeedItem(cwItem({ mediaType }), 'cw', 'internal')).toBeNull();
        },
    );

    it('maps the types it CAN represent (guard is a drop, not a blanket reject)', () => {
        expect(mapped(cwItem({ mediaType: 'tv' }), 'cw').type).toBe('series');
        expect(mapped(cwItem({ mediaType: 'movie' }), 'cw').type).toBe('movie');
        expect(mapped(cwItem({ mediaType: 'audiobook' }), 'cw').type).toBe('audiobook');
    });

    it('publishes poster-only image roles for audiobooks', () => {
        const out = mapped(cwItem({ mediaType: 'audiobook' }), 'cw');

        expect(out.images).toEqual({});
        expect(out.type).toBe('audiobook');
        expect(out.images.backdrop).toBeUndefined();
        expect(out.images.thumb).toBeUndefined();
    });
});

describe('watching media-type filter', () => {
    it('filters Continue Watching and Next Up shapes by public type', () => {
        const items = [
            cwItem({ id: 'movie-1', mediaType: 'movie' }),
            cwItem({ id: 'book-1', mediaType: 'audiobook' }),
            cwItem({ id: '123e4567-e89b-42d3-a456-426614174001', mediaType: 'tv' }),
        ];

        expect(
            filterByPublicMediaType(items, new Set(['movie', 'series']), (item) => item.mediaType),
        ).toEqual([items[0], items[2]]);
    });
});

describe('fetchExactWatchingCandidates', () => {
    it('expands beyond the former 300-row cap and stops once the filtered page is known', async () => {
        const rows = [
            ...Array.from({ length: 320 }, (_, i) =>
                cwItem({ id: `book-${i}`, mediaType: 'audiobook' }),
            ),
            ...Array.from({ length: 4 }, (_, i) =>
                cwItem({ id: `movie-${i}`, mediaType: 'movie' }),
            ),
        ];
        const fetch = vi.fn(async (limit: number) => ({
            continueWatching: rows.slice(0, limit),
            nextUp: [],
            sourceExhausted: rows.length < limit,
        }));

        const result = await fetchExactWatchingCandidates(fetch, 4, ({ continueWatching }) =>
            continueWatching
                .filter((item) => item.mediaType === 'movie')
                .map((item) => ({ item, origin: 'cw' as const, activityAt: 0 })),
        );

        expect(result.map((anchor) => anchor.item.id)).toEqual([
            'movie-0',
            'movie-1',
            'movie-2',
            'movie-3',
        ]);
        expect(fetch.mock.calls.some(([limit]) => limit > 300)).toBe(true);
    });

    it('guards a capped non-growing source', async () => {
        const row = cwItem({ id: 'book', mediaType: 'audiobook' });
        const fetch = vi.fn(async () => ({
            continueWatching: [row],
            nextUp: [],
            sourceExhausted: true,
        }));

        const result = await fetchExactWatchingCandidates(fetch, 2, () => []);

        expect(result).toEqual([]);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('continues across an access-filtered plateau until the raw source is exhausted', async () => {
        const movie = cwItem({ id: 'movie', mediaType: 'movie' });
        const fetch = vi.fn(async (limit: number) => ({
            continueWatching: limit >= 16 ? [movie] : [],
            nextUp: [],
            sourceExhausted: false,
        }));

        const result = await fetchExactWatchingCandidates(fetch, 1, ({ continueWatching }) =>
            continueWatching.map((item) => ({ item, origin: 'cw' as const, activityAt: 0 })),
        );

        expect(result.map((anchor) => anchor.item.id)).toEqual(['movie']);
        expect(fetch.mock.calls.map(([limit]) => limit)).toEqual([1, 2, 4, 8, 16]);
    });
});
