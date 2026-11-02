// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "Jump back in" must not reorder itself while the page stays open.
 *
 * The SSR paint runs the live overlay under a small budget and usually misses it, so it
 * renders the SQL `sort_date` order; the next poll waits for the overlay and used to
 * re-rank every card by `updatedAt` (= `last_event_at` alone). Rows whose `sort_date`
 * (GREATEST of last_event_at, premiere date, season activity) differs from their
 * `last_event_at` therefore swapped places between the two renders. The order of rows
 * the overlay did not touch must be the same with and without it, and ties must break
 * by media id, not by input order.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ContinueWatchingRow } from '$lib/server/database/queries/watch-state.queries.js';
import type { ActiveSessionView } from '$lib/server/services/session-read-model.service.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import type postgres from 'postgres';
import { buildMergedWatchingSection } from '$lib/server/utils/section-builder.js';

const USER = 'alice';
const USER_ID = toUserId('11111111-1111-4111-8111-111111111111');
const NOW = Date.parse('2026-10-21T10:00:00.000Z');

const mockGetContinueWatching = vi.fn<() => Promise<ContinueWatchingRow[]>>();
const mockGetNextUp = vi.fn();
vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: {
        getContinueWatching: (...args: unknown[]) => mockGetContinueWatching(...(args as [])),
        getNextUp: (...args: unknown[]) => mockGetNextUp(...args),
    },
}));

const mockGetActiveSessionsForUser = vi.fn<(userId: UserId) => Promise<ActiveSessionView[]>>();
const mockGetNewEpisodesForUser = vi.fn();
const mockFindNextSequentialEpisode = vi.fn();
vi.mock('$lib/server/services/session-read-model.service.js', () => ({
    getSessionReadModel: vi.fn().mockReturnValue({
        getActiveSessionsForUser: mockGetActiveSessionsForUser,
    }),
}));

vi.mock('$lib/server/database/index.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/database/queries/user-media-events.queries.js', () => ({
    detectBulkMarkWindows: { all: vi.fn().mockResolvedValue([]) },
}));
vi.mock('$lib/server/database/queries/episode-search.queries.js', () => ({
    findNextSequentialEpisode: (...args: unknown[]) => mockFindNextSequentialEpisode(...args),
}));
vi.mock('$lib/server/services/new-episodes.service.js', () => ({
    getNewEpisodesForUser: (...args: unknown[]) => mockGetNewEpisodesForUser(...args),
}));
vi.mock('$lib/server/database/queries/user-media-flags.queries.js', () => ({
    getActiveFlagTargets: vi.fn().mockResolvedValue([]),
}));

const { effectiveWatchingFor } = await import('./effective-watching.service.js');

function row(id: string, lastEventAt: string, sortDate: string): ContinueWatchingRow {
    return {
        media_id: id,
        has_files: true,
        media_type: 'movie',
        title: id,
        overview: null,
        resume_position_ms: 1_000_000,
        runtime_ms: 6_000_000,
        last_event_at: lastEventAt,
        last_event_source: 'lumastra-player',
        parent_id: null,
        series_id: null,
        series_name: null,
        season_number: null,
        episode_number: null,
        tmdb_id: null,
        imdb_id: null,
        sort_date: sortDate,
    };
}

function liveSession(mediaId: string): ActiveSessionView {
    return {
        sessionId: `sess-${mediaId}`,
        source: 'lumastra',
        sourceSessionId: null,
        userId: USER_ID,
        username: USER,
        displayName: null,
        mediaId,
        hasFiles: true,
        seriesId: null,
        mediaType: 'movie',
        positionMs: 1_000_000,
        runtimeMs: 6_000_000,
        status: 'ACTIVE',
        isPlaying: true,
        startedAt: new Date(NOW - 60_000),
        lastHeartbeatAt: new Date(NOW),
        lastSeenAt: new Date(NOW),
        device: undefined,
        heartbeatAgeMs: 1_000,
        isFresh: true,
        isBuffering: false,
    };
}

const run = (liveOverlayBudgetMs?: number) =>
    effectiveWatchingFor({
        username: USER,
        userId: USER_ID,
        limit: 10,
        skipSuspicion: true,
        nowMs: NOW,
        liveOverlayBudgetMs,
    });

beforeEach(() => {
    mockGetContinueWatching.mockReset();
    mockGetNextUp.mockReset().mockResolvedValue([]);
    mockGetActiveSessionsForUser.mockReset();
    mockGetActiveSessionsForUser.mockResolvedValue([]);
    mockGetNewEpisodesForUser.mockReset().mockResolvedValue([]);
    mockFindNextSequentialEpisode.mockReset().mockResolvedValue(null);
});

describe('effectiveWatchingFor ordering', () => {
    it('does not inject a metadata-only sequential episode over durable playable E3', async () => {
        const episodeId = 'episode-e1';
        const seriesId = 'series-live';
        const continueRow = row(episodeId, '2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z');
        continueRow.media_type = 'episode';
        continueRow.series_id = seriesId;
        continueRow.series_name = 'Series Live';
        continueRow.season_number = 1;
        continueRow.episode_number = 1;
        continueRow.runtime_ms = 2_600_000;
        continueRow.resume_position_ms = 2_500_000;
        mockGetContinueWatching.mockResolvedValue([continueRow]);
        mockGetNextUp.mockResolvedValue([
            {
                media_id: 'playable-e3',
                title: 'Playable E3',
                has_files: true,
                season_number: 1,
                episode_number: 3,
                runtime_seconds: 2_600,
                premiere_date: null,
                overview: null,
                parent_id: 'season-live',
                series_id: seriesId,
                last_watched_at: new Date(NOW).toISOString(),
                last_event_source: 'lumastra-player',
                series_name: 'Series Live',
                series_tmdb_id: null,
                series_imdb_id: null,
                sort_date: new Date(NOW).toISOString(),
                backdrop_blurhash: null,
                trailer_url: null,
            },
        ]);
        mockGetActiveSessionsForUser.mockResolvedValue([
            {
                ...liveSession(episodeId),
                mediaType: 'episode',
                seriesId,
                positionMs: 2_500_000,
                runtimeMs: 2_600_000,
                seasonNumber: 1,
                episodeNumber: 1,
            },
        ]);
        mockFindNextSequentialEpisode.mockResolvedValue({
            id: 'metadata-only-e2',
            title: 'Metadata E2',
            has_files: false,
            season_number: 1,
            episode_number: 2,
            is_new_season: false,
            has_primary_image: false,
            overview: null,
        });

        const result = await effectiveWatchingFor({
            username: USER,
            userId: USER_ID,
            limit: 10,
            skipSuspicion: true,
            nowMs: NOW,
            sql: {} as postgres.Sql,
        });

        expect(mockFindNextSequentialEpisode).toHaveBeenCalledWith(
            expect.anything(),
            seriesId,
            episodeId,
            { playableOnly: true },
        );
        expect(result.nextUp.map((item) => item.id)).toContain('playable-e3');
        expect(result.nextUp.map((item) => item.id)).not.toContain('metadata-only-e2');
    });

    it('carries file-gated new-release evidence through the merged section', async () => {
        const episodeId = '33333333-3333-4333-8333-333333333333';
        const seriesId = '44444444-4444-4444-8444-444444444444';
        mockGetContinueWatching.mockResolvedValue([]);
        mockGetNextUp.mockResolvedValue([]);
        mockGetNewEpisodesForUser.mockResolvedValue([
            {
                episodeId,
                seriesId,
                seriesName: 'New Season',
                episodeTitle: 'The First Light',
                seasonNumber: 2,
                episodeNumber: 1,
                airDate: new Date(NOW),
                posterUrl: '',
                episodeCount: 1,
                userWatchCount: 4,
                lastWatchedDate: null,
                isSeasonPremiere: true,
                followReason: 'watched',
            },
        ]);

        const result = await effectiveWatchingFor({
            username: USER,
            userId: USER_ID,
            limit: 10,
            includeNewEpisodes: true,
            mergeSort: true,
            skipSuspicion: true,
            nowMs: NOW,
            sql: {} as postgres.Sql,
        });
        const section = buildMergedWatchingSection(result);

        expect(result.nextUp).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: episodeId, hasFiles: true })]),
        );
        expect(section?.items).toEqual(
            expect.arrayContaining([expect.objectContaining({ isAvailable: true })]),
        );
    });

    it('ranks untouched rows by the SQL sort_date, with or without the live overlay', async () => {
        // `old-premiere-recent-season` was last played earlier but belongs to a season that
        // was watched more recently: sort_date puts it first, last_event_at puts it last.
        mockGetContinueWatching.mockResolvedValue([
            row(
                'old-premiere-recent-season',
                '2026-10-20T10:00:00.000Z',
                '2026-10-21T08:00:00.000Z',
            ),
            row('plain', '2026-10-20T12:00:00.000Z', '2026-10-20T12:00:00.000Z'),
        ]);

        // Budget missed (the SSR paint): the overlay never lands.
        mockGetActiveSessionsForUser.mockImplementation(() => new Promise(() => {}));
        const ssr = await run(5);
        expect(ssr.liveOverlayApplied).toBe(false);

        // Overlay applied (the next poll), nothing playing.
        mockGetActiveSessionsForUser.mockResolvedValue([]);
        const poll = await run();
        expect(poll.liveOverlayApplied).toBe(true);

        const ids = (r: typeof ssr) => r.continueWatching.map((i) => i.id);
        expect(ids(ssr)).toEqual(['old-premiere-recent-season', 'plain']);
        expect(ids(poll)).toEqual(ids(ssr));
    });

    it('puts a title that is playing right now first, and leaves the rest in order', async () => {
        mockGetContinueWatching.mockResolvedValue([
            row('a', '2026-10-21T09:00:00.000Z', '2026-10-21T09:00:00.000Z'),
            row('b', '2026-10-20T09:00:00.000Z', '2026-10-20T09:00:00.000Z'),
            row('c', '2026-10-19T09:00:00.000Z', '2026-10-19T09:00:00.000Z'),
        ]);
        mockGetActiveSessionsForUser.mockResolvedValue([liveSession('c')]);
        const result = await run();
        expect(result.continueWatching.map((i) => i.id)).toEqual(['c', 'a', 'b']);
        expect(result.continueWatching[0].livePlaybackState).toBe('playing');
    });

    it('breaks equal dates by media id, whatever order the rows arrive in', async () => {
        const same = '2026-10-20T09:00:00.000Z';
        mockGetContinueWatching.mockResolvedValue([row('b', same, same), row('a', same, same)]);
        const first = await run();
        mockGetContinueWatching.mockResolvedValue([row('a', same, same), row('b', same, same)]);
        const second = await run();
        expect(first.continueWatching.map((i) => i.id)).toEqual(['a', 'b']);
        expect(second.continueWatching.map((i) => i.id)).toEqual(['a', 'b']);
    });
});
