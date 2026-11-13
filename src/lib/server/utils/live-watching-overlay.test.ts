// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { applyLiveOverlay } from './live-watching-overlay.js';
import { buildMergedWatchingSection } from './section-builder.js';
import type { ContinueWatchingItem } from './section-builder.js';
import type {
    ActiveSessionView,
    SessionLiveStatus,
} from '$lib/server/services/session-read-model.service.js';
import { toUserId } from '$lib/shared/user-id.js';

const NOW_ISO = '2026-04-26T16:30:00.000Z';

// Fixed valid users.id UUID for the branded ActiveSessionView.userId (mig 16.46.0).
// The overlay matches sessions to the viewer by display `username`, so the UUID
// here is just a structurally-valid placeholder.
const TEST_USER_ID = toUserId('11111111-1111-4111-8111-111111111111');

function makeCwItem(
    overrides: Partial<ContinueWatchingItem> & {
        id: string;
        title: string;
        mediaType: string;
    },
): ContinueWatchingItem {
    return {
        watchProgress: 20,
        externalIds: { internal: overrides.id },
        ...overrides,
    };
}

function makeSession(
    overrides: Partial<ActiveSessionView> & {
        mediaId: string;
        mediaType: string;
        username: string;
    },
): ActiveSessionView {
    const status: SessionLiveStatus = overrides.status ?? 'ACTIVE';
    const base: ActiveSessionView = {
        sessionId: `sess-${overrides.mediaId}`,
        source: 'lumastra',
        sourceSessionId: null,
        userId: TEST_USER_ID,
        username: overrides.username,
        displayName: null,
        mediaId: overrides.mediaId,
        hasFiles: true,
        seriesId: null,
        mediaType: overrides.mediaType,
        positionMs: 1_424_000,
        runtimeMs: 2_584_000,
        status,
        isPlaying: status === 'ACTIVE',
        startedAt: new Date('2026-04-26T16:00:00.000Z'),
        lastHeartbeatAt: new Date(NOW_ISO),
        lastSeenAt: new Date(NOW_ISO),
        device: undefined,
        heartbeatAgeMs: 5_000,
        isFresh: true,
        isBuffering: false,
    };
    return { ...base, ...overrides };
}

describe('applyLiveOverlay', () => {
    it.each([
        { status: 'ACTIVE' as const, isPlaying: true },
        { status: 'PAUSED' as const, isPlaying: false },
    ])(
        'does not select a file-less $status session for the watching card',
        ({ status, isPlaying }) => {
            const result = applyLiveOverlay({
                username: 'denis',
                continueWatching: [],
                nextUp: [],
                activeSessions: [
                    makeSession({
                        mediaId: `no-file-${status.toLowerCase()}`,
                        mediaType: 'movie',
                        username: 'denis',
                        status,
                        isPlaying,
                        hasFiles: false,
                    }),
                ],
                nowIso: NOW_ISO,
            });

            expect(result.continueWatching).toHaveLength(0);
            expect(result.suppressedAnchors).toHaveLength(0);
        },
    );

    it('replaces an older same-series CW row with the active lumastra episode', () => {
        const oldEpisode = makeCwItem({
            id: 'ep-s3e2',
            title: 'Anomalie',
            mediaType: 'episode',
            seriesId: 'series-internal-enterprise',
            seriesName: 'Star Harbor: Voyager',
            seasonNumber: 3,
            episodeNumber: 2,
            updatedAt: '2026-04-25T10:00:00.000Z',
        });
        const liveSession = makeSession({
            mediaId: 'ep-s3e7',
            mediaType: 'episode',
            seriesId: 'series-internal-enterprise',
            username: 'denis',
            positionMs: 1_424_000,
            runtimeMs: 2_584_000,
        });

        const result = applyLiveOverlay({
            username: 'Denis',
            continueWatching: [oldEpisode],
            nextUp: [],
            activeSessions: [liveSession],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(1);
        const [row] = result.continueWatching;
        expect(row.id).toBe('ep-s3e7');
        expect(row.seriesId).toBe('series-internal-enterprise');
        expect(row.seriesName).toBe('Star Harbor: Voyager');
        expect(row.lastEventSource).toBe('lumastra-player');
        expect(row.livePlaybackState).toBe('playing');
        expect(row.updatedAt).toBe(NOW_ISO);
        expect(result.suppressedSeriesIds.size).toBe(0);
        expect(result.representedSeriesIds.has('series-internal-enterprise')).toBe(true);
        expect(result.continueWatching[0].isAvailable).toBe(true);

        const section = buildMergedWatchingSection({
            continueWatching: result.continueWatching,
            nextUp: result.nextUp,
        });
        expect(section?.items).toHaveLength(1);
        expect(section?.items[0].isAvailable).toBe(true);
    });

    it('leaves a CW row alone when no live session matches', () => {
        const cw = makeCwItem({
            id: 'ep-s3e5',
            title: 'Existing',
            mediaType: 'episode',
            seriesId: 'series-X',
            seriesName: 'Series X',
            updatedAt: '2026-04-25T10:00:00.000Z',
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [cw],
            nextUp: [],
            activeSessions: [],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toEqual([cw]);
        expect(result.representedSeriesIds.has('series-X')).toBe(true);
    });

    it('ignores sessions from other users', () => {
        const existing = makeCwItem({
            id: 'movie-1',
            title: '2001',
            mediaType: 'movie',
            updatedAt: '2026-04-25T10:00:00.000Z',
        });
        const otherUserSession = makeSession({
            mediaId: 'movie-2',
            mediaType: 'movie',
            username: 'someone-else',
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [existing],
            nextUp: [],
            activeSessions: [otherUserSession],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toEqual([existing]);
        expect(result.representedMediaIds.has('movie-1')).toBe(true);
    });

    it('suppresses same-series CW when the live session is past completion threshold', () => {
        const oldEpisode = makeCwItem({
            id: 'ep-s3e2',
            title: 'Anomalie',
            mediaType: 'episode',
            seriesId: 'series-internal-enterprise',
            seriesName: 'Star Harbor: Voyager',
            updatedAt: '2026-04-26T16:03:00.000Z',
        });
        const nearComplete = makeSession({
            mediaId: 'ep-s3e7',
            mediaType: 'episode',
            seriesId: 'series-internal-enterprise',
            username: 'denis',
            positionMs: 2_514_000,
            runtimeMs: 2_584_000,
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [oldEpisode],
            nextUp: [],
            activeSessions: [nearComplete],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toEqual([]);
        expect(result.suppressedSeriesIds.has('series-internal-enterprise')).toBe(true);
        expect(result.suppressedSessions).toHaveLength(1);
    });

    it('overlays a live movie session onto a movie CW row', () => {
        const cwMovie = makeCwItem({
            id: 'movie-uuid-1',
            title: '2001',
            mediaType: 'movie',
            updatedAt: '2026-04-25T10:00:00.000Z',
        });
        const liveMovie = makeSession({
            mediaId: 'movie-uuid-1',
            mediaType: 'movie',
            username: 'denis',
            seriesId: null,
            positionMs: 4_500_000,
            runtimeMs: 8_640_000,
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [cwMovie],
            nextUp: [],
            activeSessions: [liveMovie],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(1);
        const [row] = result.continueWatching;
        expect(row.id).toBe('movie-uuid-1');
        expect(row.title).toBe('2001');
        expect(row.livePlaybackState).toBe('playing');
        expect(row.updatedAt).toBe(NOW_ISO);
        expect(result.representedMediaIds.has('movie-uuid-1')).toBe(true);
    });

    it('ignores stale sessions', () => {
        const cw = makeCwItem({
            id: 'ep-X',
            title: 'old',
            mediaType: 'episode',
            seriesId: 'series-X',
            updatedAt: '2026-04-20T10:00:00.000Z',
        });
        const stale = makeSession({
            mediaId: 'ep-Y',
            mediaType: 'episode',
            seriesId: 'series-X',
            username: 'denis',
            isFresh: false,
            heartbeatAgeMs: 600_000,
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [cw],
            nextUp: [],
            activeSessions: [stale],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toEqual([cw]);
    });

    it('picks the freshest active session when multiple devices play the same series', () => {
        const liveOlder = makeSession({
            mediaId: 'ep-old',
            mediaType: 'episode',
            seriesId: 'series-X',
            username: 'denis',
            heartbeatAgeMs: 20_000,
        });
        const liveFresher = makeSession({
            mediaId: 'ep-new',
            mediaType: 'episode',
            seriesId: 'series-X',
            username: 'denis',
            heartbeatAgeMs: 2_000,
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [],
            nextUp: [],
            activeSessions: [liveOlder, liveFresher],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(1);
        expect(result.continueWatching[0].id).toBe('ep-new');
    });

    it('prefers ACTIVE over PAUSED even if PAUSED has a fresher heartbeat', () => {
        const paused = makeSession({
            mediaId: 'ep-paused',
            mediaType: 'episode',
            seriesId: 'series-X',
            username: 'denis',
            status: 'PAUSED',
            isPlaying: false,
            heartbeatAgeMs: 1_000,
        });
        const active = makeSession({
            mediaId: 'ep-active',
            mediaType: 'episode',
            seriesId: 'series-X',
            username: 'denis',
            status: 'ACTIVE',
            isPlaying: true,
            heartbeatAgeMs: 5_000,
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [],
            nextUp: [],
            activeSessions: [paused, active],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(1);
        expect(result.continueWatching[0].id).toBe('ep-active');
        expect(result.continueWatching[0].livePlaybackState).toBe('playing');
    });

    it('does not crash for an episode session with no seriesId (orphan)', () => {
        const liveOrphan = makeSession({
            mediaId: 'ep-orphan',
            mediaType: 'episode',
            seriesId: null,
            username: 'denis',
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [],
            nextUp: [],
            activeSessions: [liveOrphan],
            nowIso: NOW_ISO,
        });

        // Orphan-episode sessions are dropped (no key); CW unchanged.
        expect(result.continueWatching).toEqual([]);
        expect(result.suppressedSeriesIds.size).toBe(0);
    });

    it('inserts a new CW row when the durable list has nothing for the series', () => {
        const liveSession = makeSession({
            mediaId: 'ep-new',
            mediaType: 'episode',
            seriesId: 'series-NEW',
            username: 'denis',
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [],
            nextUp: [],
            activeSessions: [liveSession],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(1);
        expect(result.continueWatching[0].id).toBe('ep-new');
        expect(result.representedSeriesIds.has('series-NEW')).toBe(true);
    });

    it('uses live session episode metadata when durable row is from a different episode in the same series', () => {
        const durableS3E2 = makeCwItem({
            id: 'ep-s3e2',
            title: 'Anomaly',
            mediaType: 'episode',
            seriesId: 'series-enterprise',
            seriesName: 'Star Harbor: Voyager',
            seasonNumber: 3,
            episodeNumber: 2,
            updatedAt: '2026-04-25T10:00:00.000Z',
        });
        const liveS3E10 = makeSession({
            mediaId: 'ep-s3e10',
            mediaType: 'episode',
            seriesId: 'series-enterprise',
            username: 'denis',
            positionMs: 60_000,
            runtimeMs: 2_600_000,
            title: 'Mirror Image',
            seasonNumber: 3,
            episodeNumber: 10,
            seriesName: 'Star Harbor: Voyager',
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [durableS3E2],
            nextUp: [],
            activeSessions: [liveS3E10],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(1);
        const [row] = result.continueWatching;
        expect(row.id).toBe('ep-s3e10');
        expect(row.title).toBe('Mirror Image');
        expect(row.seasonNumber).toBe(3);
        expect(row.episodeNumber).toBe(10);
        expect(row.seriesName).toBe('Star Harbor: Voyager');
        expect(row.seriesId).toBe('series-enterprise');
    });

    it('inserts a new CW row with correct title for a series with no prior durable row', () => {
        const liveSession = makeSession({
            mediaId: 'ep-fresh',
            mediaType: 'episode',
            seriesId: 'series-FRESH',
            username: 'denis',
            positionMs: 30_000,
            runtimeMs: 2_600_000,
            title: 'Pilot',
            seasonNumber: 1,
            episodeNumber: 1,
            seriesName: 'Brand New Show',
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [],
            nextUp: [],
            activeSessions: [liveSession],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(1);
        const [row] = result.continueWatching;
        expect(row.id).toBe('ep-fresh');
        expect(row.title).toBe('Pilot');
        expect(row.seasonNumber).toBe(1);
        expect(row.episodeNumber).toBe(1);
        expect(row.seriesName).toBe('Brand New Show');
    });

    it('dedupes two unfinished durable episodes of the same series to the freshest by updatedAt', () => {
        const olderEp = makeCwItem({
            id: 'ep-s1e2',
            title: 'Old Episode',
            mediaType: 'episode',
            seriesId: 'series-A',
            seriesName: 'Series A',
            seasonNumber: 1,
            episodeNumber: 2,
            updatedAt: '2026-04-20T10:00:00.000Z',
        });
        const newerEp = makeCwItem({
            id: 'ep-s1e10',
            title: 'New Episode',
            mediaType: 'episode',
            seriesId: 'series-A',
            seriesName: 'Series A',
            seasonNumber: 1,
            episodeNumber: 10,
            updatedAt: '2026-04-25T10:00:00.000Z',
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [olderEp, newerEp],
            nextUp: [],
            activeSessions: [],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(1);
        expect(result.continueWatching[0].id).toBe('ep-s1e10');
        expect(result.representedSeriesIds.has('series-A')).toBe(true);
    });

    it('breaks updatedAt ties by greater episodeNumber', () => {
        const sameTime = '2026-04-25T10:00:00.000Z';
        const earlierEp = makeCwItem({
            id: 'ep-s1e2',
            title: 'Episode 2',
            mediaType: 'episode',
            seriesId: 'series-B',
            episodeNumber: 2,
            updatedAt: sameTime,
        });
        const laterEp = makeCwItem({
            id: 'ep-s1e10',
            title: 'Episode 10',
            mediaType: 'episode',
            seriesId: 'series-B',
            episodeNumber: 10,
            updatedAt: sameTime,
        });

        const result = applyLiveOverlay({
            username: 'denis',
            // Insertion order shouldn't matter; tiebreaker is comparator-driven.
            continueWatching: [laterEp, earlierEp],
            nextUp: [],
            activeSessions: [],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(1);
        expect(result.continueWatching[0].id).toBe('ep-s1e10');
    });

    it('breaks updatedAt ties season-aware: S2E2 wins over S1E10', () => {
        // Bulk-import sync writes both rows with identical updated_at. The
        // comparator MUST honor season order — S2E2 is later in the show
        // than S1E10 even though episodeNumber (10) > episodeNumber (2).
        const sameTime = '2026-04-25T10:00:00.000Z';
        const s1e10 = makeCwItem({
            id: 's1e10',
            title: 'Season 1 Finale',
            mediaType: 'episode',
            seriesId: 'series-Z',
            seasonNumber: 1,
            episodeNumber: 10,
            updatedAt: sameTime,
        });
        const s2e2 = makeCwItem({
            id: 's2e2',
            title: 'Season 2 Episode 2',
            mediaType: 'episode',
            seriesId: 'series-Z',
            seasonNumber: 2,
            episodeNumber: 2,
            updatedAt: sameTime,
        });

        const result = applyLiveOverlay({
            username: 'denis',
            // Insertion order shouldn't matter.
            continueWatching: [s1e10, s2e2],
            nextUp: [],
            activeSessions: [],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(1);
        expect(result.continueWatching[0].id).toBe('s2e2');
    });

    it('breaks updatedAt + episodeNumber ties by lexical mediaId asc', () => {
        const sameTime = '2026-04-25T10:00:00.000Z';
        const epA = makeCwItem({
            id: 'aaa-zzz',
            title: 'Episode A',
            mediaType: 'episode',
            seriesId: 'series-C',
            episodeNumber: 5,
            updatedAt: sameTime,
        });
        const epB = makeCwItem({
            id: 'bbb-aaa',
            title: 'Episode B',
            mediaType: 'episode',
            seriesId: 'series-C',
            episodeNumber: 5,
            updatedAt: sameTime,
        });

        // Order 1: [A, B]
        const result1 = applyLiveOverlay({
            username: 'denis',
            continueWatching: [epA, epB],
            nextUp: [],
            activeSessions: [],
            nowIso: NOW_ISO,
        });
        // Order 2: [B, A]
        const result2 = applyLiveOverlay({
            username: 'denis',
            continueWatching: [epB, epA],
            nextUp: [],
            activeSessions: [],
            nowIso: NOW_ISO,
        });

        expect(result1.continueWatching).toHaveLength(1);
        expect(result2.continueWatching).toHaveLength(1);
        // Lexical asc: 'aaa-zzz' < 'bbb-aaa' → epA wins both ways.
        expect(result1.continueWatching[0].id).toBe('aaa-zzz');
        expect(result2.continueWatching[0].id).toBe('aaa-zzz');
    });

    it('suppresses a freshest-durable episode that is past completion threshold', () => {
        // 95% of a 60-min episode → past the 0.90 tier threshold.
        const oldEp = makeCwItem({
            id: 'ep-s2e1',
            title: 'Older',
            mediaType: 'episode',
            seriesId: 'series-D',
            episodeNumber: 1,
            seasonNumber: 2,
            watchProgress: 10,
            duration: 60 * 60, // 60 min
            updatedAt: '2026-04-20T10:00:00.000Z',
        });
        const nearCompleteEp = makeCwItem({
            id: 'ep-s2e7',
            title: 'Near complete',
            mediaType: 'episode',
            seriesId: 'series-D',
            episodeNumber: 7,
            seasonNumber: 2,
            watchProgress: 95, // > 0.90 (60min tier)
            duration: 60 * 60,
            updatedAt: '2026-04-26T10:00:00.000Z',
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [oldEp, nearCompleteEp],
            nextUp: [],
            activeSessions: [],
            nowIso: NOW_ISO,
        });

        // The freshest durable was past completion → suppressed entirely.
        expect(result.continueWatching).toEqual([]);
        expect(result.suppressedSeriesIds.has('series-D')).toBe(true);
        expect(result.suppressedAnchors).toHaveLength(1);
        const [anchor] = result.suppressedAnchors;
        expect(anchor.origin).toBe('durable');
        expect(anchor.seriesId).toBe('series-D');
        expect(anchor.mediaId).toBe('ep-s2e7');
        expect(anchor.durableMatch?.id).toBe('ep-s2e7');
    });

    it('does NOT suppress a past-completion movie (no next-up to synthesize)', () => {
        // A movie at 96% would historically vanish from CW the moment the
        // threshold pass ran, then reappear-and-disappear as the durable
        // plane caught up via auto-complete. There's no "next sequential
        // episode" for movies, so suppression is just a UX glitch.
        const nearDoneMovie = makeCwItem({
            id: 'movie-1',
            title: 'Almost Done Movie',
            mediaType: 'movie',
            // No seriesId — the gate skips suppression.
            watchProgress: 96,
            duration: 60 * 60, // 1 hour, threshold 0.90 → 96% is past
            updatedAt: '2026-04-26T10:00:00.000Z',
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [nearDoneMovie],
            nextUp: [],
            activeSessions: [],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(1);
        expect(result.continueWatching[0].id).toBe('movie-1');
        expect(result.suppressedAnchors).toHaveLength(0);
        expect(result.suppressedMediaIds.size).toBe(0);
    });

    it('does NOT suppress a past-completion live MOVIE session', () => {
        // Symmetric to the durable test — live movie session past threshold
        // should also stay visible in CW until the durable plane catches up.
        const liveMovie = makeSession({
            mediaId: 'movie-2',
            mediaType: 'movie',
            username: 'denis',
            seriesId: null,
            positionMs: 96 * 60 * 1000, // 96 min of 100
            runtimeMs: 100 * 60 * 1000,
            isPlaying: true,
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [],
            nextUp: [],
            activeSessions: [liveMovie],
            nowIso: NOW_ISO,
        });

        // Movie shows as overlay row, not suppressed.
        expect(result.continueWatching).toHaveLength(1);
        expect(result.continueWatching[0].id).toBe('movie-2');
        expect(result.suppressedAnchors).toHaveLength(0);
    });

    it('does not suppress when the freshest durable is below completion even if older one is past', () => {
        // Sanity check: only the chosen anchor matters for suppression.
        const olderPastDone = makeCwItem({
            id: 'ep-old',
            mediaType: 'episode',
            title: 'old-past-done',
            seriesId: 'series-E',
            episodeNumber: 1,
            watchProgress: 99,
            duration: 60 * 60,
            updatedAt: '2026-04-20T10:00:00.000Z',
        });
        const newerInProgress = makeCwItem({
            id: 'ep-new',
            mediaType: 'episode',
            title: 'new-in-progress',
            seriesId: 'series-E',
            episodeNumber: 7,
            watchProgress: 25,
            duration: 60 * 60,
            updatedAt: '2026-04-26T10:00:00.000Z',
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [olderPastDone, newerInProgress],
            nextUp: [],
            activeSessions: [],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(1);
        expect(result.continueWatching[0].id).toBe('ep-new');
        expect(result.suppressedSeriesIds.size).toBe(0);
        expect(result.suppressedAnchors).toHaveLength(0);
    });

    it('live session wins over multiple unfinished durable rows for the same series', () => {
        const olderEp = makeCwItem({
            id: 'ep-old',
            title: 'Old',
            mediaType: 'episode',
            seriesId: 'series-F',
            seriesName: 'Series F',
            episodeNumber: 2,
            updatedAt: '2026-04-20T10:00:00.000Z',
        });
        const newerEp = makeCwItem({
            id: 'ep-new',
            title: 'New',
            mediaType: 'episode',
            seriesId: 'series-F',
            seriesName: 'Series F',
            episodeNumber: 10,
            updatedAt: '2026-04-25T10:00:00.000Z',
        });
        const liveSession = makeSession({
            mediaId: 'ep-live',
            mediaType: 'episode',
            seriesId: 'series-F',
            username: 'denis',
            // Mid-watch — well below completion.
            positionMs: 300_000,
            runtimeMs: 2_600_000,
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [olderEp, newerEp],
            nextUp: [],
            activeSessions: [liveSession],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(1);
        expect(result.continueWatching[0].id).toBe('ep-live');
        expect(result.continueWatching[0].seriesName).toBe('Series F');
        expect(result.suppressedSeriesIds.size).toBe(0);
    });

    it('keeps both durable movie rows (degenerate single-row case per movie)', () => {
        const movieA = makeCwItem({
            id: 'movie-A',
            title: 'Movie A',
            mediaType: 'movie',
            updatedAt: '2026-04-25T10:00:00.000Z',
        });
        const movieB = makeCwItem({
            id: 'movie-B',
            title: 'Movie B',
            mediaType: 'movie',
            updatedAt: '2026-04-26T10:00:00.000Z',
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [movieA, movieB],
            nextUp: [],
            activeSessions: [],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(2);
        const ids = result.continueWatching.map((i) => i.id).sort();
        expect(ids).toEqual(['movie-A', 'movie-B']);
        expect(result.representedMediaIds.has('movie-A')).toBe(true);
        expect(result.representedMediaIds.has('movie-B')).toBe(true);
    });

    it('exposes a unified suppressedAnchors list for live near-complete sessions', () => {
        const durable = makeCwItem({
            id: 'ep-s3e2',
            title: 'Earlier',
            mediaType: 'episode',
            seriesId: 'series-G',
            seriesName: 'Series G',
            episodeNumber: 2,
            updatedAt: '2026-04-25T10:00:00.000Z',
        });
        const nearComplete = makeSession({
            mediaId: 'ep-s3e7',
            mediaType: 'episode',
            seriesId: 'series-G',
            username: 'denis',
            positionMs: 2_514_000,
            runtimeMs: 2_584_000,
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [durable],
            nextUp: [],
            activeSessions: [nearComplete],
            nowIso: NOW_ISO,
        });

        expect(result.suppressedAnchors).toHaveLength(1);
        const [anchor] = result.suppressedAnchors;
        expect(anchor.origin).toBe('live');
        expect(anchor.seriesId).toBe('series-G');
        expect(anchor.mediaId).toBe('ep-s3e7');
        expect(anchor.durableMatch?.id).toBe('ep-s3e2');
    });

    it('returns nextUp unchanged through the result', () => {
        const nextUp = makeCwItem({
            id: 'next-1',
            title: 'Next',
            mediaType: 'episode',
            seriesId: 'series-Z',
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [],
            nextUp: [nextUp],
            activeSessions: [],
            nowIso: NOW_ISO,
        });

        expect(result.nextUp).toEqual([nextUp]);
    });
});

/**
 * Audiobooks reach `play_sessions` under their OWN source ('audiobookshelf'):
 * `openAudiobookSession` writes the row, our own web/iOS players heartbeat it.
 * `shouldOverlay` only ever admitted 'lumastra' and 'jellyfin', so a book being
 * listened to right now never carried `livePlaybackState` — the home rail
 * labelled a live listen "Paused just now" off the durable row's timestamp.
 */
describe('applyLiveOverlay: audiobookshelf sessions', () => {
    const BOOK_ID = '4993e963-4220-4f1e-adc0-fb475034149a';

    function makeBookRow(): ContinueWatchingItem {
        return makeCwItem({
            id: BOOK_ID,
            title: 'Milo Farrow and the Lantern of Dawn (Narrated by Simon Vale)',
            mediaType: 'audiobook',
            overview: 'Simon Vale brings the richness of these magical stories to life.',
            customMetadata: {
                audiobookshelf: { authors: ['M.K. Fenwick'], narrators: ['Simon Vale'] },
            },
            imageUrl: `/api/media/${BOOK_ID}/images/poster?size=thumb`,
            updatedAt: '2026-04-26T16:29:00.000Z',
        });
    }

    function makeBookSession(overrides: Partial<ActiveSessionView> = {}): ActiveSessionView {
        return makeSession({
            mediaId: BOOK_ID,
            mediaType: 'audiobook',
            username: 'denis',
            source: 'audiobookshelf',
            sourceSessionId: 'abs-session-1',
            positionMs: 2_405_746,
            runtimeMs: 75_423_791,
            ...overrides,
        });
    }

    it('marks a live audiobook session as playing', () => {
        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [makeBookRow()],
            nextUp: [],
            activeSessions: [makeBookSession()],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching).toHaveLength(1);
        expect(result.continueWatching[0].livePlaybackState).toBe('playing');
    });

    it('reports a paused audiobook session as paused', () => {
        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [makeBookRow()],
            nextUp: [],
            activeSessions: [makeBookSession({ status: 'PAUSED', isPlaying: false })],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching[0].livePlaybackState).toBe('paused');
    });

    /**
     * The live row is built from the session, which carries none of the fields
     * the audiobook card and modal need. For a `media:` key the session and the
     * durable row are the SAME item, so overlaying it must not amount to
     * throwing the row's own metadata away.
     */
    it('keeps the durable row fields the session does not carry', () => {
        const durable = makeBookRow();
        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [durable],
            nextUp: [],
            activeSessions: [makeBookSession()],
            nowIso: NOW_ISO,
        });

        const [row] = result.continueWatching;
        expect(row.mediaType).toBe('audiobook');
        expect(row.customMetadata).toEqual(durable.customMetadata);
        expect(row.overview).toBe(durable.overview);
        // …while the live plane still wins on everything it does know.
        expect(row.watchProgress).toBeCloseTo((2_405_746 / 75_423_791) * 100, 5);
        expect(row.updatedAt).toBe(NOW_ISO);
    });

    /**
     * A DIFFERENT episode of the same series is a different item — its live row
     * must NOT inherit the previous episode's synopsis.
     */
    it('does not leak a superseded episode’s fields onto the live episode', () => {
        const oldEpisode = makeCwItem({
            id: 'ep-s3e2',
            title: 'Anomalie',
            mediaType: 'episode',
            seriesId: 'series-E',
            overview: 'The old episode synopsis.',
            updatedAt: '2026-04-25T10:00:00.000Z',
        });
        const live = makeSession({
            mediaId: 'ep-s3e7',
            mediaType: 'episode',
            seriesId: 'series-E',
            username: 'denis',
            title: 'Zeitkrieg',
        });

        const result = applyLiveOverlay({
            username: 'denis',
            continueWatching: [oldEpisode],
            nextUp: [],
            activeSessions: [live],
            nowIso: NOW_ISO,
        });

        expect(result.continueWatching[0].id).toBe('ep-s3e7');
        expect(result.continueWatching[0].overview).toBeUndefined();
    });
});
