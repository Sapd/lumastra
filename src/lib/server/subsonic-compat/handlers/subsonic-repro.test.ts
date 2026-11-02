// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repro tests for:
 *   F8 — Subsonic unscoped media queries (missing age rating)
 *   F9 — Subsonic completed-play scrobbles never update user_music_state
 *
 * F8 Finding: Three Subsonic handlers return radio stations, random songs, and
 * songs-by-genre without applying ageRating filtering. Age-restricted users can
 * receive tracks whose rating exceeds their limit.
 *
 * F8 Citations: src/lib/server/subsonic-compat/handlers/stubs.ts:109,
 *               src/lib/server/subsonic-compat/handlers/search.ts:411,
 *               src/lib/server/subsonic-compat/handlers/search.ts:436
 *
 * F9 Finding: The submission=true path and the stopped playback path both call
 * completion logic but omit recordPlayEnd(). complete_count, skip_count, and
 * total_listen_ms are never updated for Subsonic-tracked plays.
 *
 * F9 Citations: src/lib/server/subsonic-compat/handlers/ratings.ts:277-283,
 *               src/lib/server/subsonic-compat/handlers/playback.ts:112-119
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { Sql } from 'postgres';

const mockLogger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLogger),
    },
}));

const mockMusicInteractionManager = vi.hoisted(() => ({
    complete: vi.fn().mockReturnValue(Promise.resolve(undefined)),
    recordPlayEnd: vi.fn().mockReturnValue(Promise.resolve(undefined)),
    recordExternalPlayEnd: vi.fn().mockReturnValue(Promise.resolve(undefined)),
    start: vi.fn().mockReturnValue(Promise.resolve(undefined)),
}));

vi.mock('$lib/server/services/music-interaction-manager.service.js', () => ({
    musicInteractionManager: mockMusicInteractionManager,
}));

const mockStopExternalSession = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'session-1' }));
const mockRefreshExternalSessionPresence = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('$lib/server/database/queries/play-sessions.queries.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/database/queries/play-sessions.queries.js')>()),
    getSessionBySourceKey: vi.fn().mockResolvedValue({ id: 'session-1', status: 'ACTIVE' }),
    stopExternalSession: mockStopExternalSession,
    refreshExternalSessionPresence: mockRefreshExternalSessionPresence,
}));

describe('F8 — Subsonic handlers omit age-rating scoping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('handleGetInternetRadioStations includes age_rating filter for restricted users', async () => {
        const { handleGetInternetRadioStations } =
            await import('$lib/server/subsonic-compat/handlers/stubs.js');

        // Accumulate all SQL calls so we can inspect both the age-filter
        // sub-fragment and the main SELECT.
        const allQueries: string[] = [];
        const mockSql = Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => {
                const q = strings.reduce((acc, str, i) => {
                    const val = values[i] ?? '';
                    return acc + str + (typeof val === 'string' ? `'${val}'` : String(val));
                }, '');
                allQueries.push(q);
                return Promise.resolve([]);
            },
            { json: (v: unknown) => v },
        ) as unknown as Sql;

        // Age-restricted user: should trigger the age_rating WHERE clause.
        const auth = {
            username: 'testuser',
            userId: 'aaaaaaaa-0000-4000-a000-000000000001',
            clientName: 'SubsonicTest',
            format: 'json',
            isAgeRestricted: true,
            maxAgeRating: 13,
        };

        await handleGetInternetRadioStations({} as RequestEvent, auth as never, mockSql);

        // After the fix the combined SQL calls must include both the
        // media_type guard and the age_rating filter for age-restricted users.
        const combined = allQueries.join('\n').toLowerCase();
        expect(combined).toContain("media_type = 'radio'");
        expect(combined).toContain('age_rating');
    });
});

describe('F9 — Subsonic scrobble/stop records external play-end', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockMusicInteractionManager.complete.mockResolvedValue(undefined);
        mockMusicInteractionManager.recordPlayEnd.mockResolvedValue(undefined);
        mockMusicInteractionManager.recordExternalPlayEnd.mockResolvedValue(undefined);
        mockStopExternalSession.mockResolvedValue({ id: 'session-1' });
    });

    it('submission=true path records external play-end (complete + play-end in one call)', async () => {
        const { handleScrobble } = await import('$lib/server/subsonic-compat/handlers/ratings.js');

        const mockSql = vi.fn().mockResolvedValue([]) as unknown as Sql;

        const auth = {
            username: 'testuser',
            userId: 'aaaaaaaa-0000-4000-a000-000000000001',
            clientName: 'SubsonicTest',
            format: 'json',
        };

        // Build a minimal event with submission=true
        const event = {
            url: new URL('http://localhost/subsonic/rest/scrobble?submission=true&id=track-123'),
            request: { method: 'GET' },
            locals: { subsonicBodyParams: undefined },
        } as unknown as RequestEvent;

        await handleScrobble(event, auth as never, mockSql);

        // CORRECT behavior: a single transactional recordExternalPlayEnd writes
        // both the complete signal and the no-timing play-end (one cache
        // invalidation) so complete_count + total_listen_ms stay consistent for
        // Subsonic-tracked plays.
        expect(mockMusicInteractionManager.recordExternalPlayEnd).toHaveBeenCalled();
    });

    it('stopped playback path records external play-end', async () => {
        const { handleReportPlayback } =
            await import('$lib/server/subsonic-compat/handlers/playback.js');

        // The sql mock must return a non-empty row so checkSubsonicMediaAccess
        // resolves to true (access allowed → proceeds to the stopped path).
        const mockSql = vi
            .fn()
            .mockResolvedValue([{ id: 'track-123', has_files: true }]) as unknown as Sql;

        const auth = {
            username: 'testuser',
            userId: 'aaaaaaaa-0000-4000-a000-000000000001',
            clientName: 'SubsonicTest',
            format: 'json',
        };

        // handleReportPlayback requires mediaId, mediaType, positionMs, state.
        const event = {
            url: new URL(
                'http://localhost/subsonic/rest/playbackReport?mediaId=track-123&mediaType=track&positionMs=0&state=stopped',
            ),
            request: { method: 'GET' },
            locals: { subsonicBodyParams: undefined },
        } as unknown as RequestEvent;

        await handleReportPlayback(event, auth as never, mockSql);

        // CORRECT behavior: recordExternalPlayEnd should be called so that
        // listen-time statistics are updated for stopped Subsonic plays.
        expect(mockMusicInteractionManager.recordExternalPlayEnd).toHaveBeenCalled();
    });
});
