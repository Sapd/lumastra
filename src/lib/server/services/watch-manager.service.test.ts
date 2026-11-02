// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/watch-manager.service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { ContinueWatchingRow } from '$lib/server/database/queries/watch-state.queries.js';

// vi.hoisted ensures these are available when vi.mock factories run (hoisted)
const { mockSql, mockLogger } = vi.hoisted(() => ({
    mockSql: {} as postgres.Sql,
    mockLogger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('$lib/server/database/queries/season-detail.queries.js', () => ({
    getSeriesOrdering: vi.fn().mockResolvedValue('dvd'),
}));
vi.mock('$lib/server/database/queries/episode-detail.queries.js', () => ({
    getSeriesEpisodesWithWatchState: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: {
        getSql: vi.fn(async () => mockSql),
    },
}));

vi.mock('$lib/server/database/queries/watch-state.queries.js', () => ({
    getUserWatchState: { one: vi.fn() },
    batchGetUserWatchStates: { all: vi.fn().mockResolvedValue([]) },
    getResumePositions: { all: vi.fn() },
    getContinueWatchingFromDb: { all: vi.fn() },
    getNextUpFromDb: { all: vi.fn() },
    getNextUpForSeriesFromDb: { one: vi.fn() },
    getFirstEpisodeForSeries: { one: vi.fn() },
    getWatchedTmdbIdsFromDb: vi.fn(),
    getWatchedMediaUuidsFromDb: vi.fn(),
    computeSeriesProgress: vi.fn(),
}));

vi.mock('$lib/server/database/queries/user-media-state.queries.js', () => ({
    getResumeStates: { all: vi.fn().mockResolvedValue([]) },
    getResumePositionForMedia: { one: vi.fn().mockResolvedValue(null) },
}));

vi.mock('$lib/server/services/watch-state-rebuilder.service.js', () => ({
    appendEventAndRebuild: vi.fn().mockResolvedValue(true),
    // reportProgress writes the PRIMARY progress event through the outcome
    // form so it can tell a supersede apart from a duplicate; derived
    // completions still go through the boolean form.
    appendEventAndRebuildWithOutcome: vi.fn().mockResolvedValue('accepted'),
}));

// Only the once-per-session completion probe touches SQL; everything else in
// the module stays real.
vi.mock('$lib/server/database/queries/user-media-events.queries.js', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('$lib/server/database/queries/user-media-events.queries.js')
    >()),
    hasSessionCompletion: vi.fn().mockResolvedValue(false),
}));

vi.mock('$lib/server/services/watch-state-events.service.js', () => ({
    watchStateEvents: {
        emit: vi.fn(),
    },
}));

vi.mock('$lib/server/database/queries/watch-status.queries.js', () => ({
    getSeriesEpisodeIds: vi.fn(),
    getSeasonEpisodeIds: vi.fn(),
}));

vi.mock('$lib/server/services/watched-cache.service.js', () => ({
    invalidateAllWatchedCaches: vi.fn().mockResolvedValue(undefined),
    invalidateContinueWatchingCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('$lib/server/database/queries/media-type-cache.queries.js', () => ({
    getMediaType: vi.fn().mockResolvedValue('movie'),
    isMusicMediaType: vi.fn().mockReturnValue(false),
}));

// Empty by default — matches production's `.catch(() => [])` fallback, so
// existing tests (single-episode files) see no combined-file windows. Tests
// exercising the combined-file sibling-completion path override this with
// mockResolvedValueOnce.
vi.mock('$lib/server/database/queries/file-segments.queries.js', () => ({
    getEpisodeWindowsForFile: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLogger),
    },
}));

import { aiDbService } from '$lib/server/services/database.service.js';
import { getContinueWatchingFromDb } from '$lib/server/database/queries/watch-state.queries.js';
import {
    getSeasonEpisodeIds,
    getSeriesEpisodeIds,
} from '$lib/server/database/queries/watch-status.queries.js';
import { invalidateAllWatchedCaches } from '$lib/server/services/watched-cache.service.js';
import { watchStateEvents } from '$lib/server/services/watch-state-events.service.js';
import {
    appendEventAndRebuild,
    appendEventAndRebuildWithOutcome,
} from '$lib/server/services/watch-state-rebuilder.service.js';
import { getMediaType } from '$lib/server/database/queries/media-type-cache.queries.js';
import { getResumePositionForMedia } from '$lib/server/database/queries/user-media-state.queries.js';
import { getEpisodeWindowsForFile } from '$lib/server/database/queries/file-segments.queries.js';
import { getSeriesOrdering } from '$lib/server/database/queries/season-detail.queries.js';
import { getSeriesEpisodesWithWatchState } from '$lib/server/database/queries/episode-detail.queries.js';
import { watchManager } from './watch-manager.service.js';
import { hasSessionCompletion } from '$lib/server/database/queries/user-media-events.queries.js';
import { toUserId } from '$lib/shared/user-id.js';
import type { UserId } from '$lib/shared/user-id.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';

// Fixed valid users.id UUID for branded-UserId params (mig 16.46.0).
const TEST_USER_ID = toUserId('11111111-1111-4111-8111-111111111111');

describe('WatchManager', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        // Provide a minimal sql.begin that runs the callback with the same
        // mockSql so tests can assert on appendEventAndRebuild call args.
        (mockSql as unknown as Record<string, unknown>).begin = vi.fn(
            async (cb: (tx: postgres.Sql) => Promise<void>) => cb(mockSql),
        );
        vi.mocked(aiDbService.getSql).mockResolvedValue(mockSql);
        // clearAllMocks wipes call history; restore the default outcome so each
        // test starts from "the progress event landed".
        vi.mocked(appendEventAndRebuildWithOutcome).mockResolvedValue('accepted');
        vi.mocked(appendEventAndRebuild).mockResolvedValue(true);
        vi.mocked(hasSessionCompletion).mockResolvedValue(false);
        // getContinueWatching / getNextUp now use a short-TTL L1 result cache
        // (CACHE_NAMESPACES.continueWatchingRows). Clear it between tests so a
        // cached list from one case can't satisfy the next case's DB-mock
        // assertions (test isolation).
        await cacheManager.for(CACHE_NAMESPACES.continueWatchingRows).clear();
    });

    // =========================================================================
    // reportProgress
    // =========================================================================

    describe('reportProgress', () => {
        it.skip('delegates to updateWatchProgress with correct params — replaced by appendEventAndRebuild', async () => {
            // Old test checked SQL function args directly. New architecture emits events via
            // appendEventAndRebuild. Triage: remove or rewrite against new event shape.
        });

        it.skip('passes undefined runtimeMs when omitted — replaced by event-driven write', async () => {
            // Same as above.
        });

        it('throws when database is unavailable', async () => {
            vi.mocked(aiDbService.getSql).mockResolvedValue(null);

            await expect(
                watchManager.reportProgress({
                    userId: TEST_USER_ID,
                    mediaId: 'media-uuid-1',
                    positionMs: 60000,
                    sessionId: 'test-session',
                    eventSeq: 1,
                }),
            ).rejects.toThrow('Database unavailable');

            expect(appendEventAndRebuild).not.toHaveBeenCalled();
        });

        it('calls appendEventAndRebuildWithOutcome with a progress event', async () => {
            await watchManager.reportProgress({
                userId: TEST_USER_ID,
                mediaId: 'media-uuid-1',
                positionMs: 60000,
                runtimeMs: 120000,
                sessionId: 'test-session',
                eventSeq: 1,
            });

            expect(appendEventAndRebuildWithOutcome).toHaveBeenCalledWith(
                mockSql,
                expect.objectContaining({
                    user_id: TEST_USER_ID,
                    media_id: 'media-uuid-1',
                    event_type: 'progress',
                    source: 'lumastra-player',
                    session_id: 'test-session',
                    event_seq: 1,
                }),
            );
        });

        it('also emits a completed event when position crosses completion threshold', async () => {
            await watchManager.reportProgress({
                userId: TEST_USER_ID,
                mediaId: 'media-uuid-1',
                positionMs: 108000,
                runtimeMs: 120000,
                sessionId: 'test-session',
                eventSeq: 1,
            });

            const calls = [
                ...vi.mocked(appendEventAndRebuildWithOutcome).mock.calls,
                ...vi.mocked(appendEventAndRebuild).mock.calls,
            ];
            const completedCall = calls.find(([, ev]) => ev.event_type === 'completed');
            expect(completedCall).toBeDefined();
        });

        it('does not complete again when this session already completed the item', async () => {
            // Heartbeats keep coming through the credits; each extra completion
            // used to be another +1 on watch_count.
            vi.mocked(hasSessionCompletion).mockResolvedValue(true);

            await watchManager.reportProgress({
                userId: TEST_USER_ID,
                mediaId: 'media-uuid-1',
                positionMs: 114000,
                runtimeMs: 120000,
                sessionId: 'test-session',
                eventSeq: 7,
            });

            const calls = [
                ...vi.mocked(appendEventAndRebuildWithOutcome).mock.calls,
                ...vi.mocked(appendEventAndRebuild).mock.calls,
            ];
            expect(calls.map(([, ev]) => ev.event_type)).toEqual(['progress']);
            expect(watchStateEvents.emit).not.toHaveBeenCalled();
        });

        it('does NOT emit watch_state_set_changed for non-completing progress', async () => {
            // Heartbeat-driven progress writes must not bump set membership —
            // CW eligibility only flips on auto-complete or explicit mark/clear.
            await watchManager.reportProgress({
                userId: TEST_USER_ID,
                mediaId: 'media-uuid-1',
                positionMs: 60000,
                runtimeMs: 120000,
                sessionId: 'test-session',
                eventSeq: 1,
            });

            expect(watchStateEvents.emit).not.toHaveBeenCalled();
        });

        it('emits watch_state_set_changed when progress crosses completion threshold', async () => {
            await watchManager.reportProgress({
                userId: TEST_USER_ID,
                mediaId: 'media-uuid-1',
                positionMs: 108000, // 90% of 120000
                runtimeMs: 120000,
                sessionId: 'test-session',
                eventSeq: 1,
            });

            expect(watchStateEvents.emit).toHaveBeenCalledWith(TEST_USER_ID, {
                type: 'watch_state_set_changed',
                mediaId: 'media-uuid-1',
                reason: 'auto_complete',
            });
        });

        it('emits a completed event when the completionThreshold override is crossed', async () => {
            vi.mocked(appendEventAndRebuild).mockClear();
            vi.mocked(appendEventAndRebuild).mockResolvedValue(true);
            vi.mocked(appendEventAndRebuildWithOutcome).mockClear();
            vi.mocked(appendEventAndRebuildWithOutcome).mockResolvedValue('accepted');
            const runtimeMs = 60 * 60 * 1000;
            await watchManager.reportProgress({
                userId: 'u1' as unknown as UserId,
                mediaId: 'm1',
                positionMs: Math.floor(runtimeMs * 0.91), // above the explicit 0.9 override
                runtimeMs,
                sessionId: 's1',
                eventSeq: 1,
                mediaType: 'episode',
                completionThreshold: 0.9,
            });
            const eventTypes = [
                ...vi.mocked(appendEventAndRebuildWithOutcome).mock.calls,
                ...vi.mocked(appendEventAndRebuild).mock.calls,
            ].map((c) => c[1].event_type);
            expect(eventTypes).toContain('completed');
        });

        it('does NOT auto-complete at 0.91 without the override (default 0.95 tier at 2h runtime)', async () => {
            vi.mocked(appendEventAndRebuild).mockClear();
            vi.mocked(appendEventAndRebuild).mockResolvedValue(true);
            vi.mocked(appendEventAndRebuildWithOutcome).mockClear();
            vi.mocked(appendEventAndRebuildWithOutcome).mockResolvedValue('accepted');
            const runtimeMs = 2 * 60 * 60 * 1000;
            await watchManager.reportProgress({
                userId: 'u1' as unknown as UserId,
                mediaId: 'm1',
                positionMs: Math.floor(runtimeMs * 0.91),
                runtimeMs,
                sessionId: 's1',
                eventSeq: 1,
                mediaType: 'episode',
            });
            const eventTypes = [
                ...vi.mocked(appendEventAndRebuildWithOutcome).mock.calls,
                ...vi.mocked(appendEventAndRebuild).mock.calls,
            ].map((c) => c[1].event_type);
            expect(eventTypes).not.toContain('completed');
        });

        it('preserves occurrence time and source with session keys for primary and sibling completions', async () => {
            // Regression coverage for the offline-sync wiring: a caller-side
            // regression that dropped `occurred_at: now` or `source:
            // eventSource` at any one of the three emission sites would not be
            // caught by the pure-function arbitration test in
            // watch-state-rebuilder.service.test.ts, since that test builds its
            // events by hand and never calls reportProgress. This test asserts
            // the actual objects reportProgress hands to appendEventAndRebuild.
            vi.mocked(appendEventAndRebuild).mockClear();
            vi.mocked(appendEventAndRebuild).mockResolvedValue(true);
            vi.mocked(appendEventAndRebuildWithOutcome).mockClear();
            vi.mocked(appendEventAndRebuildWithOutcome).mockResolvedValue('accepted');
            // Combined file: 'm1' is the opened episode (0-100s), 'm2' is its
            // sibling (100-200s). positionMs is file-absolute, past both
            // windows' thresholds, so both the primary and the sibling
            // complete from the one reportProgress call.
            vi.mocked(getEpisodeWindowsForFile).mockResolvedValueOnce([
                { mediaItemId: 'm1', startMs: 0, endMs: 100_000 },
                { mediaItemId: 'm2', startMs: 100_000, endMs: 200_000 },
            ]);

            const occurredAt = '2026-08-17T08:00:00.000Z';

            await watchManager.reportProgress({
                userId: TEST_USER_ID,
                mediaId: 'm1',
                positionMs: 150_000,
                runtimeMs: 100_000,
                sessionId: 'offline-session',
                eventSeq: 1,
                completionThreshold: 0.5,
                occurredAt,
                source: 'lumastra-offline',
                sourceEventId: 'sync-1',
            });

            const calls = [
                ...vi.mocked(appendEventAndRebuildWithOutcome).mock.calls,
                ...vi.mocked(appendEventAndRebuild).mock.calls,
            ];

            const progressCall = calls.find(([, ev]) => ev.event_type === 'progress');
            expect(progressCall?.[1]).toMatchObject({
                occurred_at: occurredAt,
                source: 'lumastra-offline',
                source_event_id: 'sync-1',
            });

            const primaryCompleted = calls.find(
                ([, ev]) => ev.event_type === 'completed' && ev.media_id === 'm1',
            );
            expect(primaryCompleted?.[1]).toMatchObject({
                occurred_at: occurredAt,
                source: 'lumastra-offline',
                source_event_id: 'session:offline-session:completed',
            });

            const siblingCompleted = calls.find(
                ([, ev]) => ev.event_type === 'completed' && ev.media_id === 'm2',
            );
            expect(siblingCompleted?.[1]).toMatchObject({
                occurred_at: occurredAt,
                source: 'lumastra-offline',
                source_event_id: 'session:offline-session:completed',
            });
        });
    });

    // =========================================================================
    // clearWatchProgress
    // =========================================================================

    describe('clearWatchProgress', () => {
        it('calls appendEventAndRebuild with progress=0 for specific mediaId', async () => {
            await watchManager.clearWatchProgress({
                userId: TEST_USER_ID,
                mediaId: 'media-uuid-1',
            });

            expect(appendEventAndRebuild).toHaveBeenCalledWith(
                mockSql,
                expect.objectContaining({
                    user_id: TEST_USER_ID,
                    media_id: 'media-uuid-1',
                    event_type: 'progress',
                    source: 'lumastra-user-mark',
                    position_ms: 0,
                }),
            );
        });

        it.skip('delegates to clearWatchProgress query with no mediaId for bulk clear — replaced by per-item events', async () => {
            // New bulk clear emits one progress=0 event per resume row via getResumeStates.
            // Triage: rewrite against new architecture if coverage needed.
        });

        it('emits watch_state_set_changed with mediaId when provided', async () => {
            await watchManager.clearWatchProgress({
                userId: TEST_USER_ID,
                mediaId: 'media-uuid-1',
            });

            expect(watchStateEvents.emit).toHaveBeenCalledWith(TEST_USER_ID, {
                type: 'watch_state_set_changed',
                mediaId: 'media-uuid-1',
                reason: 'clear_progress',
            });
        });

        it('emits watch_state_set_changed with wildcard when no mediaId', async () => {
            await watchManager.clearWatchProgress({ userId: TEST_USER_ID });

            expect(watchStateEvents.emit).toHaveBeenCalledWith(TEST_USER_ID, {
                type: 'watch_state_set_changed',
                mediaId: '*',
                reason: 'clear_progress',
            });
        });

        it('throws when database is unavailable', async () => {
            vi.mocked(aiDbService.getSql).mockResolvedValue(null);

            await expect(
                watchManager.clearWatchProgress({
                    userId: TEST_USER_ID,
                    mediaId: 'media-uuid-1',
                }),
            ).rejects.toThrow('Database unavailable');

            expect(appendEventAndRebuild).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // markWatched
    // =========================================================================

    describe('markWatched', () => {
        it('emits a mark_watched event via appendEventAndRebuild', async () => {
            await watchManager.markWatched({
                userId: TEST_USER_ID,
                mediaId: 'media-uuid-1',
            });

            expect(appendEventAndRebuild).toHaveBeenCalledWith(
                mockSql,
                expect.objectContaining({
                    user_id: TEST_USER_ID,
                    media_id: 'media-uuid-1',
                    event_type: 'mark_watched',
                    source: 'lumastra-user-mark',
                }),
            );
        });

        it('invalidates watched caches after marking', async () => {
            await watchManager.markWatched({
                userId: TEST_USER_ID,
                mediaId: 'media-uuid-1',
            });

            expect(invalidateAllWatchedCaches).toHaveBeenCalledWith(TEST_USER_ID);
        });

        it('throws when database is unavailable', async () => {
            vi.mocked(aiDbService.getSql).mockResolvedValue(null);

            await expect(
                watchManager.markWatched({
                    userId: TEST_USER_ID,
                    mediaId: 'media-uuid-1',
                }),
            ).rejects.toThrow('Database unavailable');

            expect(appendEventAndRebuild).not.toHaveBeenCalled();
        });

        it('logs warning when cache invalidation fails', async () => {
            vi.mocked(invalidateAllWatchedCaches).mockRejectedValueOnce(
                new Error('Cache unavailable'),
            );

            // Should not throw — cache invalidation failure is non-fatal
            await expect(
                watchManager.markWatched({
                    userId: TEST_USER_ID,
                    mediaId: 'media-uuid-1',
                }),
            ).resolves.not.toThrow();

            expect(mockLogger.warn).toHaveBeenCalledWith(
                'Failed to invalidate watched caches',
                expect.any(Error),
            );
        });

        // ─────────────────────────────────────────────────────────────────
        // Series fan-out — the modal confirms "mark all episodes of {title}"
        // and the dispatch must honour that promise (regression: previously
        // wrote a single series-level event, leaving episodes unmarked).
        // ─────────────────────────────────────────────────────────────────

        it('fans out to every episode when target is a series (media_type=tv)', async () => {
            vi.mocked(getMediaType).mockResolvedValueOnce('tv');
            vi.mocked(getSeriesEpisodeIds).mockResolvedValue(['ep-1', 'ep-2', 'ep-3']);

            await watchManager.markWatched({
                userId: TEST_USER_ID,
                mediaId: 'series-uuid-1',
            });

            // 1 series-level event + 3 episode events = 4 calls
            expect(appendEventAndRebuild).toHaveBeenCalledTimes(4);
            const mediaIds = vi
                .mocked(appendEventAndRebuild)
                .mock.calls.map((c) => (c[1] as { media_id: string }).media_id);
            expect(mediaIds).toEqual(['series-uuid-1', 'ep-1', 'ep-2', 'ep-3']);
            expect(watchStateEvents.emit).toHaveBeenCalledWith(
                TEST_USER_ID,
                expect.objectContaining({
                    type: 'watch_state_set_changed',
                    mediaId: '*',
                    reason: 'mark_series_watched',
                }),
            );
        });

        it('also fans out for legacy media_type=series', async () => {
            vi.mocked(getMediaType).mockResolvedValueOnce('series');
            vi.mocked(getSeriesEpisodeIds).mockResolvedValue(['ep-only']);

            await watchManager.markWatched({
                userId: TEST_USER_ID,
                mediaId: 'series-uuid-1',
            });

            expect(appendEventAndRebuild).toHaveBeenCalledTimes(2);
        });

        // Phase A migrated existing rows to lowercase but the codebase
        // still occasionally sees PascalCase ('Series') from Jellyfin
        // sync paths. Strict literal equality would silently fall through
        // to the single-event path, restoring the original modal-promise
        // bug. Use the case-insensitive `isSeries` / `isSeason` guards.
        it('routes PascalCase Jellyfin media_type=Series via the canonical guard', async () => {
            vi.mocked(getMediaType).mockResolvedValueOnce('Series');
            vi.mocked(getSeriesEpisodeIds).mockResolvedValue(['ep-1']);

            await watchManager.markWatched({
                userId: TEST_USER_ID,
                mediaId: 'series-uuid-1',
            });

            expect(appendEventAndRebuild).toHaveBeenCalledTimes(2);
        });

        it('routes UPPERCASE legacy media_type=TV via the canonical guard', async () => {
            vi.mocked(getMediaType).mockResolvedValueOnce('TV');
            vi.mocked(getSeriesEpisodeIds).mockResolvedValue(['ep-1', 'ep-2']);

            await watchManager.markWatched({
                userId: TEST_USER_ID,
                mediaId: 'series-uuid-1',
            });

            expect(appendEventAndRebuild).toHaveBeenCalledTimes(3);
        });

        it('keeps single-event semantics for episodes (no recursion)', async () => {
            vi.mocked(getMediaType).mockResolvedValueOnce('episode');

            await watchManager.markWatched({
                userId: TEST_USER_ID,
                mediaId: 'ep-uuid-1',
            });

            expect(appendEventAndRebuild).toHaveBeenCalledTimes(1);
            expect(appendEventAndRebuild).toHaveBeenCalledWith(
                mockSql,
                expect.objectContaining({
                    media_id: 'ep-uuid-1',
                    event_type: 'mark_watched',
                }),
            );
        });
    });

    // =========================================================================
    // markUnwatched
    // =========================================================================

    describe('markUnwatched', () => {
        it('fans out to every episode when target is a series', async () => {
            vi.mocked(getMediaType).mockResolvedValueOnce('tv');
            vi.mocked(getSeriesEpisodeIds).mockResolvedValue(['ep-1', 'ep-2']);

            await watchManager.markUnwatched({
                userId: TEST_USER_ID,
                mediaId: 'series-uuid-1',
            });

            // 1 series + 2 episodes = 3 calls
            expect(appendEventAndRebuild).toHaveBeenCalledTimes(3);
            const events = vi
                .mocked(appendEventAndRebuild)
                .mock.calls.map((c) => c[1] as { event_type: string });
            for (const e of events) {
                expect(e.event_type).toBe('mark_unwatched');
            }
            expect(watchStateEvents.emit).toHaveBeenCalledWith(
                TEST_USER_ID,
                expect.objectContaining({
                    reason: 'mark_series_unwatched',
                }),
            );
        });

        it('keeps single-event semantics for movies', async () => {
            vi.mocked(getMediaType).mockResolvedValueOnce('movie');

            await watchManager.markUnwatched({
                userId: TEST_USER_ID,
                mediaId: 'movie-uuid-1',
            });

            expect(appendEventAndRebuild).toHaveBeenCalledTimes(1);
            expect(appendEventAndRebuild).toHaveBeenCalledWith(
                mockSql,
                expect.objectContaining({
                    media_id: 'movie-uuid-1',
                    event_type: 'mark_unwatched',
                    // Video still discards the position — "I have not seen this".
                    position_ms: null,
                }),
            );
        });

        it('carries the listening position onto the event for an audiobook', async () => {
            // Un-finishing a book exists to RECOVER the position, so the event
            // must carry it — the rebuild derives resume from the log, and a
            // null here zeroes it. Prod 2026-08-27: this zeroed 20h12m and the
            // push propagated the zero to AudiobookShelf, destroying it there
            // too (history-free progress row).
            const listenedMs = 72_746_184;
            vi.mocked(getMediaType).mockResolvedValueOnce('audiobook');
            vi.mocked(getResumePositionForMedia.one).mockResolvedValueOnce({
                resume_position_ms: listenedMs,
            });

            await watchManager.markUnwatched({
                userId: TEST_USER_ID,
                mediaId: 'audiobook-uuid-1',
            });

            expect(appendEventAndRebuild).toHaveBeenCalledWith(
                mockSql,
                expect.objectContaining({
                    media_id: 'audiobook-uuid-1',
                    event_type: 'mark_unwatched',
                    position_ms: listenedMs,
                }),
            );
        });
    });

    // =========================================================================
    // markSeasonWatched
    // =========================================================================

    describe('markSeasonWatched', () => {
        it('writes a season-level event plus one per episode', async () => {
            const episodeIds = ['ep-uuid-1', 'ep-uuid-2', 'ep-uuid-3'];
            vi.mocked(getSeriesEpisodesWithWatchState).mockResolvedValue(
                episodeIds.map((id) => ({ id })) as never,
            );

            const count = await watchManager.markSeasonWatched({
                userId: TEST_USER_ID,
                seriesId: 'series-uuid-1',
                seasonNumber: 1,
                seasonMediaId: 'season-uuid-1',
            });

            expect(getSeriesEpisodesWithWatchState).toHaveBeenCalledWith(
                mockSql,
                'series-uuid-1',
                TEST_USER_ID,
                undefined,
                { physicalSeasonId: 'season-uuid-1' },
            );
            // 1 season parent + 3 episodes = 4 calls
            expect(appendEventAndRebuild).toHaveBeenCalledTimes(4);
            const ids = vi
                .mocked(appendEventAndRebuild)
                .mock.calls.map((c) => (c[1] as { media_id: string }).media_id);
            expect(ids).toEqual(['season-uuid-1', 'ep-uuid-1', 'ep-uuid-2', 'ep-uuid-3']);
            // Return value is still the episode count (caller-visible),
            // not the total event count.
            expect(count).toBe(3);
        });

        it('omits the parent event when seasonMediaId is missing (no series flip)', async () => {
            // When the season UUID isn't known (legacy direct callers, future
            // partial metadata), the helper must NOT substitute the series
            // UUID as a stand-in parent event — that would flip
            // getWatchState(seriesId) even though only one season was
            // marked. Cache + SSE still fire from fanOutMark; only episode
            // events get written.
            vi.mocked(getSeasonEpisodeIds).mockResolvedValue(['ep-1', 'ep-2']);

            await watchManager.markSeasonWatched({
                userId: TEST_USER_ID,
                seriesId: 'series-uuid-1',
                seasonNumber: 2,
            });

            const ids = vi
                .mocked(appendEventAndRebuild)
                .mock.calls.map((c) => (c[1] as { media_id: string }).media_id);
            expect(ids).toEqual(['ep-1', 'ep-2']);
            expect(ids).not.toContain('series-uuid-1');
            // Cache invalidation + SSE still fan out.
            expect(invalidateAllWatchedCaches).toHaveBeenCalledWith(TEST_USER_ID);
            expect(watchStateEvents.emit).toHaveBeenCalledWith(
                TEST_USER_ID,
                expect.objectContaining({ reason: 'mark_season_watched' }),
            );
        });

        it('invalidates watched caches after bulk marking', async () => {
            vi.mocked(getSeasonEpisodeIds).mockResolvedValue(['ep-uuid-1']);

            await watchManager.markSeasonWatched({
                userId: TEST_USER_ID,
                seriesId: 'series-uuid-1',
                seasonNumber: 2,
            });

            expect(invalidateAllWatchedCaches).toHaveBeenCalledWith(TEST_USER_ID);
        });

        it('still writes the parent event for an empty season', async () => {
            // The parent event guarantees the modal badge stays correct even
            // when a season is being marked watched without any episodes
            // (e.g. metadata still loading). Episode count returned is 0.
            vi.mocked(getSeriesEpisodesWithWatchState).mockResolvedValue([]);

            const count = await watchManager.markSeasonWatched({
                userId: TEST_USER_ID,
                seriesId: 'series-uuid-1',
                seasonNumber: 99,
                seasonMediaId: 'season-uuid-1',
            });

            expect(appendEventAndRebuild).toHaveBeenCalledTimes(1);
            expect(appendEventAndRebuild).toHaveBeenCalledWith(
                mockSql,
                expect.objectContaining({ media_id: 'season-uuid-1' }),
            );
            expect(count).toBe(0);
        });

        it('throws when database is unavailable', async () => {
            vi.mocked(aiDbService.getSql).mockResolvedValue(null);

            await expect(
                watchManager.markSeasonWatched({
                    userId: TEST_USER_ID,
                    seriesId: 'series-uuid-1',
                    seasonNumber: 1,
                }),
            ).rejects.toThrow('Database unavailable');

            expect(getSeasonEpisodeIds).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // getContinueWatching
    // =========================================================================

    describe('getContinueWatching', () => {
        it('returns items with position > 0 and not watched', async () => {
            const mockRows: ContinueWatchingRow[] = [
                {
                    media_id: 'uuid-1',
                    has_files: true,
                    media_type: 'movie',
                    title: 'The Lantern',
                    overview: null,
                    resume_position_ms: 60000,
                    runtime_ms: 8160000,
                    last_event_at: '2026-03-01T10:00:00Z',
                    last_event_source: null,
                    parent_id: null,
                    series_id: null,
                    series_name: null,
                    season_number: null,
                    episode_number: null,
                    tmdb_id: '603',
                    imdb_id: 'tt0133093',
                    sort_date: '2026-03-01T10:00:00Z',
                },
                {
                    media_id: 'uuid-2',
                    has_files: true,
                    media_type: 'episode',
                    title: 'Pilot',
                    overview: null,
                    resume_position_ms: 120000,
                    runtime_ms: 3600000,
                    last_event_at: '2026-03-02T10:00:00Z',
                    last_event_source: null,
                    parent_id: 'series-uuid-1',
                    series_id: 'series-uuid-1',
                    series_name: 'Drifting Clouds',
                    season_number: 1,
                    episode_number: 1,
                    tmdb_id: null,
                    imdb_id: null,
                    sort_date: '2026-03-02T10:00:00Z',
                },
            ];
            vi.mocked(getContinueWatchingFromDb.all).mockResolvedValue(mockRows);

            const result = await watchManager.getContinueWatching(TEST_USER_ID, 10);

            expect(getContinueWatchingFromDb.all).toHaveBeenCalledWith(
                mockSql,
                expect.objectContaining({ userId: TEST_USER_ID, limit: 10 }),
            );
            // The result is served through a JSON-round-tripped cache layer, so
            // it is a structural clone of the DB rows (not the same reference).
            expect(result).toEqual(mockRows);
        });

        it('returns empty array when database is unavailable', async () => {
            vi.mocked(aiDbService.getSql).mockResolvedValue(null);

            const result = await watchManager.getContinueWatching(TEST_USER_ID, 10);

            expect(result).toEqual([]);
            expect(getContinueWatchingFromDb.all).not.toHaveBeenCalled();
        });

        it('returns empty array when no items in progress', async () => {
            vi.mocked(getContinueWatchingFromDb.all).mockResolvedValue([]);

            const result = await watchManager.getContinueWatching(TEST_USER_ID, 10);

            expect(result).toEqual([]);
        });

        it('passes limit parameter correctly', async () => {
            vi.mocked(getContinueWatchingFromDb.all).mockResolvedValue([]);

            await watchManager.getContinueWatching(TEST_USER_ID, 5);

            expect(getContinueWatchingFromDb.all).toHaveBeenCalledWith(
                mockSql,
                expect.objectContaining({ userId: TEST_USER_ID, limit: 5 }),
            );
        });
    });

    // =========================================================================
    // Error propagation when SQL unavailable
    // =========================================================================

    describe('error propagation when SQL unavailable', () => {
        beforeEach(() => {
            vi.mocked(aiDbService.getSql).mockResolvedValue(null);
        });

        it('reportProgress throws', async () => {
            await expect(
                watchManager.reportProgress({
                    userId: TEST_USER_ID,
                    mediaId: 'uuid',
                    positionMs: 0,
                    sessionId: 'test-session',
                    eventSeq: 1,
                }),
            ).rejects.toThrow('Database unavailable');
        });

        it('markWatched throws', async () => {
            await expect(
                watchManager.markWatched({ userId: TEST_USER_ID, mediaId: 'uuid' }),
            ).rejects.toThrow('Database unavailable');
        });

        it('markSeasonWatched throws', async () => {
            await expect(
                watchManager.markSeasonWatched({
                    userId: TEST_USER_ID,
                    seriesId: 'uuid',
                    seasonNumber: 1,
                }),
            ).rejects.toThrow('Database unavailable');
        });

        it('getContinueWatching returns empty array (graceful)', async () => {
            const result = await watchManager.getContinueWatching(TEST_USER_ID, 10);
            expect(result).toEqual([]);
        });

        it('getWatchState returns null (graceful)', async () => {
            const result = await watchManager.getWatchState(TEST_USER_ID, 'uuid');
            expect(result).toBeNull();
        });

        it('batchGetWatchStates returns empty map (graceful)', async () => {
            const result = await watchManager.batchGetWatchStates(TEST_USER_ID, [
                'uuid-1',
                'uuid-2',
            ]);
            expect(result).toEqual(new Map());
        });
    });
});

describe('virtual season fan-out', () => {
    const seriesId = '22222222-2222-4222-8222-222222222222';
    const handle = `vseason:${seriesId}:dvd:3`;
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(aiDbService.getSql).mockResolvedValue(mockSql);
        (mockSql as unknown as { begin: unknown }).begin = vi.fn(
            async (cb: (sql: postgres.Sql) => Promise<void>) => cb(mockSql),
        );
        vi.mocked(getSeriesOrdering).mockResolvedValue('dvd');
        vi.mocked(getSeriesEpisodesWithWatchState).mockResolvedValue([
            { id: 'episode-a' },
            { id: 'episode-b' },
            { id: 'episode-a' },
        ] as never);
    });
    it.each([true, false])(
        'marks only the logical season episode UUIDs, watched=%s',
        async (watched) => {
            if (watched) await watchManager.markWatched({ userId: TEST_USER_ID, mediaId: handle });
            else await watchManager.markUnwatched({ userId: TEST_USER_ID, mediaId: handle });
            expect(getSeriesEpisodesWithWatchState).toHaveBeenCalledWith(
                mockSql,
                seriesId,
                TEST_USER_ID,
                3,
            );
            expect(
                vi.mocked(appendEventAndRebuild).mock.calls.map(([, event]) => event.media_id),
            ).toEqual(['episode-a', 'episode-b']);
            expect(
                vi
                    .mocked(appendEventAndRebuild)
                    .mock.calls.every(
                        ([, event]) =>
                            event.event_type === (watched ? 'mark_watched' : 'mark_unwatched'),
                    ),
            ).toBe(true);
            expect(getMediaType).not.toHaveBeenCalled();
        },
    );
    it('rejects handles for an inactive ordering before writing', async () => {
        vi.mocked(getSeriesOrdering).mockResolvedValue('absolute');
        await expect(
            watchManager.markWatched({ userId: TEST_USER_ID, mediaId: handle }),
        ).rejects.toThrow('Virtual season not found');
        expect(appendEventAndRebuild).not.toHaveBeenCalled();
    });
});

describe('virtual season watch marking', () => {
    const seriesId = '22222222-2222-4222-8222-222222222222';
    const episodeIds = [
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
    ];
    beforeEach(async () => {
        vi.clearAllMocks();
        (mockSql as unknown as Record<string, unknown>).begin = vi.fn(
            async (cb: (tx: postgres.Sql) => Promise<void>) => cb(mockSql),
        );
        vi.mocked(aiDbService.getSql).mockResolvedValue(mockSql);
        const { getSeriesOrdering } =
            await import('$lib/server/database/queries/season-detail.queries.js');
        vi.mocked(getSeriesOrdering).mockResolvedValue('dvd');
        const { getSeriesEpisodesWithWatchState } =
            await import('$lib/server/database/queries/episode-detail.queries.js');
        vi.mocked(getSeriesEpisodesWithWatchState).mockResolvedValue(
            episodeIds.map((id) => ({ id })) as Awaited<
                ReturnType<typeof getSeriesEpisodesWithWatchState>
            >,
        );
    });
    it.each([true, false])(
        'marks exactly the logical season episodes (watched=%s), with no parent event',
        async (watched) => {
            const handle = `vseason:${seriesId}:dvd:2`;
            if (watched) await watchManager.markWatched({ userId: TEST_USER_ID, mediaId: handle });
            else await watchManager.markUnwatched({ userId: TEST_USER_ID, mediaId: handle });
            const { getSeriesEpisodesWithWatchState } =
                await import('$lib/server/database/queries/episode-detail.queries.js');
            expect(getSeriesEpisodesWithWatchState).toHaveBeenCalledWith(
                mockSql,
                seriesId,
                TEST_USER_ID,
                2,
            );
            expect(
                vi.mocked(appendEventAndRebuild).mock.calls.map((call) => call[1].media_id),
            ).toEqual(episodeIds);
            for (const call of vi.mocked(appendEventAndRebuild).mock.calls)
                expect(call[1].event_type).toBe(watched ? 'mark_watched' : 'mark_unwatched');
            expect(getSeasonEpisodeIds).not.toHaveBeenCalled();
        },
    );
    it('rejects a stale ordering without marking anything', async () => {
        const { getSeriesOrdering } =
            await import('$lib/server/database/queries/season-detail.queries.js');
        vi.mocked(getSeriesOrdering).mockResolvedValue('absolute');
        await expect(
            watchManager.markWatched({
                userId: TEST_USER_ID,
                mediaId: `vseason:${seriesId}:dvd:2`,
            }),
        ).rejects.toThrow('Virtual season not found');
        expect(appendEventAndRebuild).not.toHaveBeenCalled();
    });
});
