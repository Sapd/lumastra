// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for effectiveSeriesMarker. Every collaborator is injected via the
 * `deps` parameter, so no module mocking is needed.
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { effectiveSeriesMarker, type SeriesMarkerDeps } from './effective-series-marker.service.js';
import type { ActiveSessionView } from './session-read-model.service.js';
import type {
    ContinueWatchingRow,
    EpisodeOrderKeyRow,
} from '$lib/server/database/queries/watch-state.queries.js';
import { toUserId } from '$lib/shared/user-id.js';

const USER = toUserId('11111111-1111-4111-8111-111111111111');
const SERIES = 'series-1';
const FAKE_SQL = {} as unknown as postgres.Sql;
const RUNTIME_MS = 45 * 60_000;

function epKey(n: number, season = 1, seriesId = SERIES): EpisodeOrderKeyRow {
    return {
        id: `e${n}`,
        title: `Episode ${n}`,
        season_number: season,
        episode_number: n,
        order_key: season * 10_000 + n,
        series_id: seriesId,
    };
}

const KEYS = new Map<string, EpisodeOrderKeyRow>(
    Array.from({ length: 12 }, (_, i) => epKey(i + 1)).map((k) => [k.id, k]),
);

function makeSession(overrides: Partial<ActiveSessionView> = {}): ActiveSessionView {
    return {
        sessionId: 'sess-other',
        source: 'lumastra',
        sourceSessionId: null,
        userId: USER,
        username: 'alice',
        displayName: null,
        mediaId: 'e10',
        hasFiles: true,
        seriesId: SERIES,
        mediaType: 'episode',
        positionMs: 1_320_000,
        runtimeMs: RUNTIME_MS,
        status: 'PAUSED',
        isPlaying: false,
        isBuffering: false,
        startedAt: new Date('2026-09-23T10:00:00Z'),
        lastHeartbeatAt: new Date('2026-09-23T10:22:00Z'),
        lastSeenAt: new Date('2026-09-23T10:22:00Z'),
        heartbeatAgeMs: 5_000,
        isFresh: true,
        seasonNumber: 1,
        episodeNumber: 10,
        device: { name: 'Mozilla/5.0 (iPhone)', client: 'Lumastra iOS' },
        ...overrides,
    };
}

function cwRow(mediaId: string, resumeMs: number, lastEventAt: string): ContinueWatchingRow {
    return {
        media_id: mediaId,
        media_type: 'episode',
        resume_position_ms: resumeMs,
        last_event_at: lastEventAt,
    } as unknown as ContinueWatchingRow;
}

function makeDeps(overrides: Partial<SeriesMarkerDeps> = {}): SeriesMarkerDeps {
    return {
        getLiveSessions: vi.fn().mockResolvedValue([]),
        findNextEpisode: vi.fn().mockResolvedValue(null),
        getInProgressRows: vi.fn().mockResolvedValue([]),
        getNextUp: vi
            .fn()
            .mockResolvedValue({ episode: null, source: 'none', liveOverlayApplied: true }),
        getMainlineSummary: vi.fn().mockResolvedValue(null),
        getFirstEpisode: vi.fn().mockResolvedValue(null),
        getEpisodeOrderKeys: vi.fn(
            async (_sql: postgres.Sql, ids: string[]): Promise<EpisodeOrderKeyRow[]> =>
                ids.flatMap((id) => {
                    const k = KEYS.get(id);
                    return k ? [k] : [];
                }),
        ),
        getLatestClientName: vi.fn().mockResolvedValue(null),
        getSessionDeviceId: vi.fn().mockResolvedValue(null),
        episodesShareFile: vi.fn().mockResolvedValue(false),
        getEpisodeWindowStartMs: vi.fn().mockResolvedValue(null),
        getAnchorConfig: vi
            .fn()
            .mockResolvedValue({ substantialPercent: 0.2, phantomStalenessDays: 3 }),
        ...overrides,
    };
}

describe('effectiveSeriesMarker — live step', () => {
    it('a fresh live session on E10 at 22 min is the in-progress marker with its device', async () => {
        const deps = makeDeps({ getLiveSessions: vi.fn().mockResolvedValue([makeSession()]) });

        const marker = await effectiveSeriesMarker(
            { userId: USER, seriesId: SERIES, sql: FAKE_SQL },
            deps,
        );

        expect(marker.progress).toMatchObject({
            positionMs: marker.positionMs,
            finished: false,
            updatedAt: marker.updatedAt,
        });
        expect(marker.state).toBe('in_progress');
        expect(marker.episode?.id).toBe('e10');
        expect(marker.episode?.orderKey).toBe(10_010);
        expect(marker.positionMs).toBe(1_320_000);
        expect(marker.deviceName).toBe('Lumastra iOS');
        expect(marker.updatedAt).toBe('2026-09-23T10:22:00.000Z');
        expect(marker.relation).toBe('none');
        expect(deps.getInProgressRows).not.toHaveBeenCalled();
    });

    it('ignores the session named by excludeSessionId and falls through to durable', async () => {
        const deps = makeDeps({
            getLiveSessions: vi
                .fn()
                .mockResolvedValue([makeSession({ sessionId: 'mine', mediaId: 'e8' })]),
            getInProgressRows: vi
                .fn()
                .mockResolvedValue([cwRow('e10', 900_000, '2026-09-22T20:00:00.000Z')]),
            getLatestClientName: vi.fn().mockResolvedValue('Lumastra tvOS'),
        });

        const marker = await effectiveSeriesMarker(
            { userId: USER, seriesId: SERIES, excludeSessionId: 'mine', sql: FAKE_SQL },
            deps,
        );

        expect(marker.state).toBe('in_progress');
        expect(marker.episode?.id).toBe('e10');
        expect(marker.positionMs).toBe(900_000);
        expect(marker.updatedAt).toBe('2026-09-22T20:00:00.000Z');
        expect(marker.deviceName).toBe('Lumastra tvOS');
        expect(deps.getLatestClientName).toHaveBeenCalledWith(FAKE_SQL, USER, 'e10', 'mine');
    });

    it('ignores a live session on `from` at the caller position (the caller itself)', async () => {
        const deps = makeDeps({
            getLiveSessions: vi
                .fn()
                .mockResolvedValue([makeSession({ mediaId: 'e8', positionMs: 600_400 })]),
            getInProgressRows: vi
                .fn()
                .mockResolvedValue([cwRow('e10', 900_000, '2026-09-22T20:00:00.000Z')]),
        });

        const marker = await effectiveSeriesMarker(
            {
                userId: USER,
                seriesId: SERIES,
                fromEpisodeId: 'e8',
                fromPositionMs: 600_000,
                sql: FAKE_SQL,
            },
            deps,
        );

        expect(marker.episode?.id).toBe('e10');
        expect(marker.relation).toBe('forward');
    });

    it('with excludeSessionId, another device paused at the caller position still counts', async () => {
        const deps = makeDeps({
            getLiveSessions: vi
                .fn()
                .mockResolvedValue([
                    makeSession({ sessionId: 'mine', mediaId: 'e8', positionMs: 600_000 }),
                    makeSession({ sessionId: 'tv', mediaId: 'e8', positionMs: 600_300 }),
                ]),
        });

        const marker = await effectiveSeriesMarker(
            {
                userId: USER,
                seriesId: SERIES,
                fromEpisodeId: 'e8',
                fromPositionMs: 600_000,
                excludeSessionId: 'mine',
                sql: FAKE_SQL,
            },
            deps,
        );

        expect(marker.state).toBe('in_progress');
        expect(marker.episode?.id).toBe('e8');
        expect(marker.positionMs).toBe(600_300);
    });

    it("a live session on the caller's own device carries no device name", async () => {
        const deps = makeDeps({
            getLiveSessions: vi.fn().mockResolvedValue([
                makeSession({
                    sessionId: 'other-tab',
                    device: { client: 'Lumastra Web', deviceId: 'browser-1' },
                }),
            ]),
            getSessionDeviceId: vi.fn().mockResolvedValue('browser-1'),
        });

        const marker = await effectiveSeriesMarker(
            { userId: USER, seriesId: SERIES, excludeSessionId: 'mine', sql: FAKE_SQL },
            deps,
        );

        expect(marker.episode?.id).toBe('e10');
        expect(marker.deviceName).toBeNull();
        expect(deps.getSessionDeviceId).toHaveBeenCalledWith(FAKE_SQL, 'mine');
    });

    it('a live session on another device keeps its device name', async () => {
        const deps = makeDeps({
            getLiveSessions: vi.fn().mockResolvedValue([
                makeSession({
                    sessionId: 'mine',
                    mediaId: 'e8',
                    isFresh: true,
                    device: { client: 'Lumastra Web', deviceId: 'browser-1' },
                }),
                makeSession({ device: { client: 'Lumastra iOS', deviceId: 'iphone-1' } }),
            ]),
        });

        const marker = await effectiveSeriesMarker(
            { userId: USER, seriesId: SERIES, excludeSessionId: 'mine', sql: FAKE_SQL },
            deps,
        );

        expect(marker.deviceName).toBe('Lumastra iOS');
        // The caller's device came from its own live session: no extra lookup.
        expect(deps.getSessionDeviceId).not.toHaveBeenCalled();
    });

    it('a live session past completion yields the following episode as `next`', async () => {
        const deps = makeDeps({
            getLiveSessions: vi
                .fn()
                .mockResolvedValue([makeSession({ positionMs: Math.floor(RUNTIME_MS * 0.97) })]),
            findNextEpisode: vi.fn().mockResolvedValue({ id: 'e11' }),
        });

        const marker = await effectiveSeriesMarker(
            { userId: USER, seriesId: SERIES, sql: FAKE_SQL },
            deps,
        );

        expect(marker.state).toBe('next');
        expect(marker.episode?.id).toBe('e11');
        expect(marker.positionMs).toBe(0);
        expect(deps.findNextEpisode).toHaveBeenCalledWith(FAKE_SQL, SERIES, 'e10');
    });

    it('prefers a playing session over a fresher paused one', async () => {
        const deps = makeDeps({
            getLiveSessions: vi.fn().mockResolvedValue([
                makeSession({ sessionId: 'a', mediaId: 'e9', heartbeatAgeMs: 1_000 }),
                makeSession({
                    sessionId: 'b',
                    mediaId: 'e10',
                    heartbeatAgeMs: 20_000,
                    isPlaying: true,
                    status: 'ACTIVE',
                }),
            ]),
        });

        const marker = await effectiveSeriesMarker(
            { userId: USER, seriesId: SERIES, sql: FAKE_SQL },
            deps,
        );

        expect(marker.episode?.id).toBe('e10');
    });
});

describe('effectiveSeriesMarker — durable fallbacks', () => {
    it("next-up's live overlay excludes the caller's session (paused in the credits)", async () => {
        const getNextUp = vi.fn().mockResolvedValue({
            episode: { media_id: 'e9' },
            source: 'durable',
            liveOverlayApplied: true,
        });
        const deps = makeDeps({
            getNextUp,
            getMainlineSummary: vi.fn().mockResolvedValue({
                total_episodes: 12,
                watched_episodes: 8,
                last_watched_episode_id: 'e8',
                last_watched_at: null,
            }),
        });

        await effectiveSeriesMarker(
            {
                userId: USER,
                seriesId: SERIES,
                fromEpisodeId: 'e9',
                fromPositionMs: 2_600_000,
                excludeSessionId: 'mine',
                sql: FAKE_SQL,
            },
            deps,
        );

        expect(getNextUp).toHaveBeenCalledWith(
            expect.objectContaining({
                seriesId: SERIES,
                excludeSessionId: 'mine',
                callerEpisodeId: 'e9',
                callerPositionMs: 2_600_000,
            }),
        );
    });

    it('no in-progress row falls to next-up with position 0', async () => {
        const deps = makeDeps({
            getNextUp: vi.fn().mockResolvedValue({
                episode: { media_id: 'e9' },
                source: 'durable',
                liveOverlayApplied: true,
            }),
            getMainlineSummary: vi.fn().mockResolvedValue({
                total_episodes: 12,
                watched_episodes: 8,
                last_watched_episode_id: 'e8',
                last_watched_at: new Date('2026-09-20T21:00:00Z'),
            }),
        });

        const marker = await effectiveSeriesMarker(
            { userId: USER, seriesId: SERIES, sql: FAKE_SQL },
            deps,
        );

        expect(marker).toMatchObject({ state: 'next', positionMs: 0, updatedAt: null });
        expect(marker.episode?.id).toBe('e9');
    });

    describe('in-progress row vs next-up (the rail anchor rule)', () => {
        const DAY_MS = 86_400_000;

        function backlogRow(resumeMs: number, ageMs: number): ContinueWatchingRow {
            return {
                ...cwRow('e3', resumeMs, new Date(Date.now() - ageMs).toISOString()),
                season_number: 1,
                episode_number: 3,
                runtime_ms: RUNTIME_MS,
            } as unknown as ContinueWatchingRow;
        }

        function depsWith(row: ContinueWatchingRow): SeriesMarkerDeps {
            return makeDeps({
                getInProgressRows: vi.fn().mockResolvedValue([row]),
                getNextUp: vi.fn().mockResolvedValue({
                    episode: { media_id: 'e9', season_number: 1, episode_number: 9 },
                    source: 'durable',
                    liveOverlayApplied: true,
                }),
                getMainlineSummary: vi.fn().mockResolvedValue({
                    total_episodes: 12,
                    watched_episodes: 8,
                    last_watched_episode_id: 'e8',
                    last_watched_at: new Date(),
                }),
            });
        }

        it('a stale, barely-started backlog row loses to next-up', async () => {
            const marker = await effectiveSeriesMarker(
                { userId: USER, seriesId: SERIES, sql: FAKE_SQL },
                depsWith(backlogRow(300_000, 50 * DAY_MS)),
            );

            expect(marker).toMatchObject({ state: 'next', positionMs: 0 });
            expect(marker.episode?.id).toBe('e9');
        });

        it('a substantial backlog row stays in progress', async () => {
            const marker = await effectiveSeriesMarker(
                { userId: USER, seriesId: SERIES, sql: FAKE_SQL },
                depsWith(backlogRow(1_200_000, 50 * DAY_MS)),
            );

            expect(marker).toMatchObject({ state: 'in_progress', positionMs: 1_200_000 });
            expect(marker.episode?.id).toBe('e3');
        });

        it('a fresh backlog row stays in progress', async () => {
            const marker = await effectiveSeriesMarker(
                { userId: USER, seriesId: SERIES, sql: FAKE_SQL },
                depsWith(backlogRow(300_000, DAY_MS)),
            );

            expect(marker.state).toBe('in_progress');
            expect(marker.episode?.id).toBe('e3');
        });
    });

    it('a fully watched main line is `finished` on the last watched episode', async () => {
        const deps = makeDeps({
            getMainlineSummary: vi.fn().mockResolvedValue({
                total_episodes: 12,
                watched_episodes: 12,
                last_watched_episode_id: 'e12',
                last_watched_at: new Date('2026-09-20T21:00:00Z'),
            }),
        });

        const marker = await effectiveSeriesMarker(
            { userId: USER, seriesId: SERIES, sql: FAKE_SQL },
            deps,
        );

        expect(marker.state).toBe('finished');
        expect(marker.episode?.id).toBe('e12');
        expect(marker.updatedAt).toBe('2026-09-20T21:00:00.000Z');
    });

    it('nothing watched is `not_started` with the first episode', async () => {
        const deps = makeDeps({
            getMainlineSummary: vi.fn().mockResolvedValue({
                total_episodes: 12,
                watched_episodes: 0,
                last_watched_episode_id: null,
                last_watched_at: null,
            }),
            getFirstEpisode: vi.fn().mockResolvedValue({ media_id: 'e1' }),
            // Next-up answers an untouched series with its first episode too.
            getNextUp: vi.fn().mockResolvedValue({
                episode: { media_id: 'e1' },
                source: 'durable',
                liveOverlayApplied: true,
            }),
        });

        const marker = await effectiveSeriesMarker(
            { userId: USER, seriesId: SERIES, sql: FAKE_SQL },
            deps,
        );

        expect(marker.state).toBe('not_started');
        expect(marker.episode?.id).toBe('e1');
    });

    it('no episode at all is `not_started` with a null episode', async () => {
        const marker = await effectiveSeriesMarker(
            { userId: USER, seriesId: SERIES, fromEpisodeId: 'e3', sql: FAKE_SQL },
            makeDeps(),
        );

        expect(marker).toEqual({
            progress: {
                positionMs: null,
                durationMs: null,
                fraction: null,
                finished: false,
                updatedAt: null,
            },
            state: 'not_started',
            episode: null,
            positionMs: 0,
            updatedAt: null,
            deviceName: null,
            relation: 'none',
            sameFileAsFrom: false,
        });
    });
});

describe('effectiveSeriesMarker — relation to `from`', () => {
    async function relationFor(
        markerEpisode: string,
        markerPositionMs: number,
        from: string | null,
        fromPositionMs: number | null,
    ): Promise<string> {
        const deps = makeDeps({
            getInProgressRows: vi
                .fn()
                .mockResolvedValue([
                    cwRow(markerEpisode, markerPositionMs, '2026-09-22T20:00:00.000Z'),
                ]),
        });
        const marker = await effectiveSeriesMarker(
            {
                userId: USER,
                seriesId: SERIES,
                fromEpisodeId: from,
                fromPositionMs,
                sql: FAKE_SQL,
            },
            deps,
        );
        return marker.relation;
    }

    it('from E8, marker E10 → forward', async () => {
        expect(await relationFor('e10', 1_320_000, 'e8', 600_000)).toBe('forward');
    });

    it('from E10, marker E3 → behind', async () => {
        expect(await relationFor('e3', 600_000, 'e10', 60_000)).toBe('behind');
    });

    it('from E10 at 60 s, marker E10 at 22 min → forward', async () => {
        expect(await relationFor('e10', 1_320_000, 'e10', 60_000)).toBe('forward');
    });

    it('from E10 at 21:50, marker E10 at 22:00 → same (within 30 s)', async () => {
        expect(await relationFor('e10', 1_320_000, 'e10', 1_310_000)).toBe('same');
    });

    it('no from → none', async () => {
        expect(await relationFor('e10', 1_320_000, null, null)).toBe('none');
    });

    it('a from episode of another series → none', async () => {
        const deps = makeDeps({
            getInProgressRows: vi
                .fn()
                .mockResolvedValue([cwRow('e10', 1_320_000, '2026-09-22T20:00:00.000Z')]),
            getEpisodeOrderKeys: vi
                .fn()
                .mockResolvedValue([epKey(10), { ...epKey(2, 1, 'other-series'), id: 'x2' }]),
        });
        const marker = await effectiveSeriesMarker(
            { userId: USER, seriesId: SERIES, fromEpisodeId: 'x2', sql: FAKE_SQL },
            deps,
        );
        expect(marker.relation).toBe('none');
    });

    it('combined file: a later episode behind the caller playhead is behind, not forward', async () => {
        // E9+E10 in one file, positions file-absolute: the caller is at 30:00,
        // the marker (E10's own resume row) at 25:00.
        const deps = makeDeps({
            getInProgressRows: vi
                .fn()
                .mockResolvedValue([cwRow('e10', 1_500_000, '2026-09-22T20:00:00.000Z')]),
            episodesShareFile: vi.fn().mockResolvedValue(true),
        });
        const marker = await effectiveSeriesMarker(
            {
                userId: USER,
                seriesId: SERIES,
                fromEpisodeId: 'e9',
                fromPositionMs: 1_800_000,
                sql: FAKE_SQL,
            },
            deps,
        );
        expect(marker.sameFileAsFrom).toBe(true);
        expect(marker.relation).toBe('behind');
    });

    it('combined file: a marker within 30 s of the caller playhead is same', async () => {
        const deps = makeDeps({
            getInProgressRows: vi
                .fn()
                .mockResolvedValue([cwRow('e10', 1_810_000, '2026-09-22T20:00:00.000Z')]),
            episodesShareFile: vi.fn().mockResolvedValue(true),
        });
        const marker = await effectiveSeriesMarker(
            {
                userId: USER,
                seriesId: SERIES,
                fromEpisodeId: 'e9',
                fromPositionMs: 1_800_000,
                sql: FAKE_SQL,
            },
            deps,
        );
        expect(marker.relation).toBe('same');
    });

    it('combined file: a `next` marker sits at its window start, not at 0', async () => {
        const deps = makeDeps({
            getNextUp: vi.fn().mockResolvedValue({
                episode: { media_id: 'e10' },
                source: 'durable',
                liveOverlayApplied: true,
            }),
            getMainlineSummary: vi.fn().mockResolvedValue({
                total_episodes: 12,
                watched_episodes: 9,
                last_watched_episode_id: 'e9',
                last_watched_at: null,
            }),
            episodesShareFile: vi.fn().mockResolvedValue(true),
            getEpisodeWindowStartMs: vi.fn().mockResolvedValue(1_380_000),
        });

        const before = await effectiveSeriesMarker(
            {
                userId: USER,
                seriesId: SERIES,
                fromEpisodeId: 'e9',
                fromPositionMs: 600_000,
                sql: FAKE_SQL,
            },
            deps,
        );
        expect(before.positionMs).toBe(1_380_000);
        expect(before.relation).toBe('forward');

        const past = await effectiveSeriesMarker(
            {
                userId: USER,
                seriesId: SERIES,
                fromEpisodeId: 'e9',
                fromPositionMs: 1_700_000,
                sql: FAKE_SQL,
            },
            deps,
        );
        expect(past.relation).toBe('behind');
    });

    it('reports sameFileAsFrom for a combined-file sibling', async () => {
        const deps = makeDeps({
            getInProgressRows: vi
                .fn()
                .mockResolvedValue([cwRow('e10', 1_320_000, '2026-09-22T20:00:00.000Z')]),
            episodesShareFile: vi.fn().mockResolvedValue(true),
        });
        const marker = await effectiveSeriesMarker(
            { userId: USER, seriesId: SERIES, fromEpisodeId: 'e9', sql: FAKE_SQL },
            deps,
        );
        expect(marker.sameFileAsFrom).toBe(true);
        expect(deps.episodesShareFile).toHaveBeenCalledWith(FAKE_SQL, 'e9', 'e10');
    });
});

describe('effectiveSeriesMarker — self-contamination guard', () => {
    it("a stale tab's own in-progress row does not mask a later in-progress episode", async () => {
        const getInProgressRows = vi.fn(
            async (
                _sql: postgres.Sql,
                params: { collapsePerSeries: boolean },
            ): Promise<ContinueWatchingRow[]> =>
                params.collapsePerSeries
                    ? [cwRow('e8', 600_000, '2026-09-23T10:00:00.000Z')]
                    : [
                          cwRow('e8', 600_000, '2026-09-23T10:00:00.000Z'),
                          cwRow('e10', 1_320_000, '2026-09-22T10:00:00.000Z'),
                          cwRow('e3', 300_000, '2026-09-21T10:00:00.000Z'),
                      ],
        );
        const deps = makeDeps({ getInProgressRows });

        const marker = await effectiveSeriesMarker(
            {
                userId: USER,
                seriesId: SERIES,
                fromEpisodeId: 'e8',
                fromPositionMs: 600_000,
                sql: FAKE_SQL,
            },
            deps,
        );

        expect(marker.episode?.id).toBe('e10');
        expect(marker.positionMs).toBe(1_320_000);
        expect(marker.relation).toBe('forward');
        expect(getInProgressRows).toHaveBeenLastCalledWith(
            FAKE_SQL,
            expect.objectContaining({ limit: 3, collapsePerSeries: false, seriesId: SERIES }),
        );
    });
});
