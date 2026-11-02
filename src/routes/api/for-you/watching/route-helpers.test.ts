// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    createSequentialNextUpItem,
    upsertSequentialNextUp,
} from '$lib/server/utils/live-next-up-fallback.js';
import type { ContinueWatchingItem } from '$lib/server/utils/section-builder.js';
import type { NextSequentialEpisodeRow } from '$lib/server/database/queries/episode-search.queries.js';

function makeWatchingItem(
    overrides: Partial<ContinueWatchingItem> & {
        id: string;
        title: string;
        mediaType: ContinueWatchingItem['mediaType'];
    },
): ContinueWatchingItem {
    return {
        watchProgress: 0,
        externalIds: { internal: overrides.id },
        ...overrides,
    };
}

function makeNextSequentialEpisode(
    overrides: Partial<NextSequentialEpisodeRow> = {},
): NextSequentialEpisodeRow {
    return {
        id: 'ep-s3e8',
        title: 'Dammerung',
        season_number: 3,
        episode_number: 8,
        is_new_season: false,
        has_primary_image: true,
        has_files: true,
        overview: null,
        ...overrides,
    };
}

describe('/api/for-you/watching sequential live fallback helpers', () => {
    it('creates a fresh next-up item from a near-complete live episode', () => {
        const liveItem = makeWatchingItem({
            id: 'ep-s3e7',
            title: 'Die Ladung',
            mediaType: 'episode',
            seriesId: 'series-enterprise',
            seriesName: 'Star Harbor: Enterprise',
            seasonNumber: 3,
            episodeNumber: 7,
            lastEventSource: 'jellyfin-session',
        });

        const out = createSequentialNextUpItem(
            makeNextSequentialEpisode(),
            liveItem,
            'series-enterprise',
            '2026-04-26T18:30:00.000Z',
        );

        expect(out.id).toBe('ep-s3e8');
        expect(out.seriesId).toBe('series-enterprise');
        expect(out).not.toHaveProperty('jellyfinSeriesId');
        expect(out.seriesName).toBe('Star Harbor: Enterprise');
        expect(out.watchProgress).toBe(0);
        expect(out.updatedAt).toBe('2026-04-26T18:30:00.000Z');
        expect(out.itemType).toBe('nextup');
        expect(out.hasFiles).toBe(true);
        expect(out.preserveSortDate).toBe(true);
        expect(out.externalIds).toEqual({ internal: 'ep-s3e8' });
    });

    it('replaces an existing same-series next-up card with the synthetic one', () => {
        const staleNextUp = createSequentialNextUpItem(
            makeNextSequentialEpisode({
                id: 'ep-s3e9',
                title: 'North Star',
                season_number: 3,
                episode_number: 9,
            }),
            makeWatchingItem({
                id: 'ep-s3e7',
                title: 'Die Ladung',
                mediaType: 'episode',
                seriesId: 'series-enterprise',
                seriesName: 'Star Harbor: Enterprise',
                seasonNumber: 3,
                episodeNumber: 7,
            }),
            'series-enterprise',
            '2026-04-25T18:30:00.000Z',
        );
        const otherSeries = createSequentialNextUpItem(
            makeNextSequentialEpisode({
                id: 'voy-s1e2',
                title: 'Parallax',
                season_number: 1,
                episode_number: 2,
            }),
            makeWatchingItem({
                id: 'voy-s1e1',
                title: 'Caretaker',
                mediaType: 'episode',
                seriesId: 'series-voyager',
                seriesName: 'Star Harbor: Voyager',
                seasonNumber: 1,
                episodeNumber: 1,
            }),
            'series-voyager',
            '2026-04-25T18:30:00.000Z',
        );
        const freshCandidate = createSequentialNextUpItem(
            makeNextSequentialEpisode(),
            makeWatchingItem({
                id: 'ep-s3e7',
                title: 'Die Ladung',
                mediaType: 'episode',
                seriesId: 'series-enterprise',
                seriesName: 'Star Harbor: Enterprise',
                seasonNumber: 3,
                episodeNumber: 7,
            }),
            'series-enterprise',
            '2026-04-26T18:30:00.000Z',
        );

        const out = upsertSequentialNextUp([staleNextUp, otherSeries], freshCandidate);

        expect(out).toHaveLength(2);
        expect(out[0].id).toBe('ep-s3e8');
        expect(out[0].updatedAt).toBe('2026-04-26T18:30:00.000Z');
        expect(out[1].id).toBe('voy-s1e2');
    });
});
