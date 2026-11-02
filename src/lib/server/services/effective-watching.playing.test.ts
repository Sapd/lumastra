// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit coverage for resolvePlayingMediaIds — the resolver the hero's
 * /api/recommendations?type=continue path uses to light up "Playing now".
 *
 * The session read model is mocked (no Valkey); the live overlay runs for
 * real, so this exercises the actual session→row matching + livePlaybackState
 * plumbing the fix depends on.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ContinueWatchingRow } from '$lib/server/database/queries/watch-state.queries.js';
import type { ActiveSessionView } from '$lib/server/services/session-read-model.service.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

const NOW_ISO = '2026-04-26T16:30:00.000Z';
const USER = 'alice';
const USER_ID = toUserId('11111111-1111-4111-8111-111111111111');

// Mocked so getActiveSessionsForUser returns whatever the current test queues.
const mockGetActiveSessionsForUser = vi.fn<(userId: UserId) => Promise<ActiveSessionView[]>>();
vi.mock('$lib/server/services/session-read-model.service.js', () => ({
    getSessionReadModel: vi.fn().mockReturnValue({
        getActiveSessionsForUser: mockGetActiveSessionsForUser,
    }),
}));

// Import AFTER the mock is registered.
const { resolvePlayingMediaIds } = await import('./effective-watching.service.js');

function makeMovieRow(id: string): ContinueWatchingRow {
    return {
        media_id: id,
        has_files: true,
        media_type: 'movie',
        title: 'Milo Farrow',
        overview: null,
        resume_position_ms: 1_000_000,
        runtime_ms: 6_000_000,
        last_event_at: NOW_ISO,
        last_event_source: 'lumastra-player',
        parent_id: null,
        series_id: null,
        series_name: null,
        season_number: null,
        episode_number: null,
        tmdb_id: null,
        imdb_id: null,
        sort_date: NOW_ISO,
    };
}

function makeSession(mediaId: string, isPlaying: boolean): ActiveSessionView {
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
        // Below the completion threshold so the overlay surfaces it as an
        // active CW row (not a past-completion suppression).
        positionMs: 1_000_000,
        runtimeMs: 6_000_000,
        status: isPlaying ? 'ACTIVE' : 'PAUSED',
        isPlaying,
        startedAt: new Date('2026-04-26T16:00:00.000Z'),
        lastHeartbeatAt: new Date(NOW_ISO),
        lastSeenAt: new Date(NOW_ISO),
        device: undefined,
        heartbeatAgeMs: 5_000,
        isFresh: true,
        isBuffering: false,
    };
}

beforeEach(() => {
    mockGetActiveSessionsForUser.mockReset();
});

describe('resolvePlayingMediaIds', () => {
    it('returns the media_id of an actively-playing session', async () => {
        mockGetActiveSessionsForUser.mockResolvedValue([makeSession('movie-1', true)]);
        const playing = await resolvePlayingMediaIds(USER, USER_ID, [makeMovieRow('movie-1')]);
        expect(playing.has('movie-1')).toBe(true);
    });

    it('does NOT mark a paused session as playing', async () => {
        mockGetActiveSessionsForUser.mockResolvedValue([makeSession('movie-1', false)]);
        const playing = await resolvePlayingMediaIds(USER, USER_ID, [makeMovieRow('movie-1')]);
        expect(playing.has('movie-1')).toBe(false);
    });

    it('returns an empty set when there are no active sessions', async () => {
        mockGetActiveSessionsForUser.mockResolvedValue([]);
        const playing = await resolvePlayingMediaIds(USER, USER_ID, [makeMovieRow('movie-1')]);
        expect(playing.size).toBe(0);
    });

    it('short-circuits (no session read) when there are no CW rows', async () => {
        const playing = await resolvePlayingMediaIds(USER, USER_ID, []);
        expect(playing.size).toBe(0);
        expect(mockGetActiveSessionsForUser).not.toHaveBeenCalled();
    });

    it('degrades to empty (never throws) when the session read fails', async () => {
        mockGetActiveSessionsForUser.mockRejectedValue(new Error('valkey down'));
        const playing = await resolvePlayingMediaIds(USER, USER_ID, [makeMovieRow('movie-1')]);
        expect(playing.size).toBe(0);
    });
});
