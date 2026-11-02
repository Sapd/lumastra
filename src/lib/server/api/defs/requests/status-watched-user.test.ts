// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * POST /requests/status — the `watched` flag must be looked up by user UUID.
 *
 * Regression: the def passed `effectiveUsername` (a login name) straight into
 * `checkIfWatched`, which filters `user_media_state.user_id` — a uuid column.
 * Postgres threw `invalid input syntax for type uuid: "leon"` on every call and
 * the service swallowed it into `false`, so nothing ever reported as watched.
 * Observed firing continuously on prod 2026-08-20.
 *
 * `status.test.ts` cannot cover this: it mocks `getDb()` to null, which skips
 * the resolve and the watch check entirely. These tests give it a live db.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const USER_UUID = '2d7ed4f4-3ac3-45f8-8d5f-9e3ccef6b3bd';

const mockCheckIfWatched = vi.fn();
const mockCheckLocalAvailability = vi.fn();
const mockDetermineMovieStatus = vi.fn();
const mockGetUserIdByUsername = vi.fn();
const mockResolveToTmdb = vi.fn();

vi.mock('$lib/server/jellyseerr.js', () => ({
    jellyseerrClient: {
        getUserByUsername: vi.fn().mockResolvedValue(null),
        getRequests: vi.fn().mockResolvedValue([]),
        getMediaByTmdbId: vi.fn().mockResolvedValue({ title: 'Awakening' }),
        getSeasonRequestStatus: vi.fn().mockResolvedValue(null),
    },
    MediaStatus: { AVAILABLE: 5, PARTIALLY_AVAILABLE: 4, PROCESSING: 3, PENDING: 2, UNKNOWN: 1 },
}));

vi.mock('$lib/server/sonarr.js', () => ({
    sonarrClient: {
        getAllQueueRecords: vi.fn().mockResolvedValue([]),
        getSeriesByTvdbId: vi.fn().mockResolvedValue(null),
    },
    radarrClient: { getAllQueueRecords: vi.fn().mockResolvedValue([]) },
}));

vi.mock('$lib/server/services/request-status/index.js', () => ({
    checkLocalAvailability: (...a: unknown[]) => mockCheckLocalAvailability(...a),
    checkIfWatched: (...a: unknown[]) => mockCheckIfWatched(...a),
    validateRequestQuery: (r: Record<string, unknown>) => ({ valid: true, data: r }),
    determineSeasonStatus: vi.fn(),
    determineMovieStatus: (...a: unknown[]) => mockDetermineMovieStatus(...a),
    determineTvAggregateStatus: vi.fn(),
}));

vi.mock('$lib/server/services/provider-resolution.service.js', () => ({
    providerResolutionService: { resolveToTmdb: (...a: unknown[]) => mockResolveToTmdb(...a) },
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, resetAt: 0 }),
}));

vi.mock('$lib/server/utils/client-ip.js', () => ({ getClientIp: () => '1.2.3.4' }));

// A non-null stand-in for the postgres tag — the def only forwards it.
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: (...a: unknown[]) => mockGetUserIdByUsername(...a),
}));

vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn().mockResolvedValue({
        username: 'leon',
        deniedGroupIds: null,
        ageRating: null,
        liveTvAllowed: false,
    }),
}));

vi.mock('$lib/server/dev-user.js', () => ({
    getEffectiveUser: (_: unknown, username: string) => username,
}));

vi.mock('$lib/server/config.js', () => ({ config: { DEFAULT_USER: 'default-user' } }));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

const { def: statusDef } = await import('./status.js');

const CTX_V1 = { surface: 'v1' as const };

function makeEvent(body: unknown): RequestEvent {
    const url = new URL('http://localhost/api/v1/requests/status');
    return {
        url,
        request: new Request(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }),
        params: {},
        route: { id: '/api/v1/requests/status' },
        locals: { user: { username: 'leon' } },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const AVAILABLE_MOVIE = {
    requests: [{ externalIds: { tmdb: '329865' }, mediaType: 'movie' as const }],
};

beforeEach(() => {
    vi.clearAllMocks();
    mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 329865 });
    mockGetUserIdByUsername.mockResolvedValue(USER_UUID);
    mockCheckIfWatched.mockResolvedValue(true);
    mockCheckLocalAvailability.mockResolvedValue({
        isAvailable: true,
        internalId: 'e0f3a1b2-0000-4000-8000-000000000001',
    });
});

describe('POST /requests/status — watch check is keyed by user UUID', () => {
    it('resolves the login name and passes the UUID to checkIfWatched', async () => {
        const res = await statusDef.handlers.POST!(makeEvent(AVAILABLE_MOVIE), CTX_V1);
        const body = (await res.json()) as Array<{ watched?: boolean }>;

        expect(mockGetUserIdByUsername).toHaveBeenCalledWith(expect.anything(), 'leon');
        expect(mockCheckIfWatched).toHaveBeenCalledTimes(1);
        expect(mockCheckIfWatched.mock.calls[0][0]).toBe(USER_UUID);
        expect(body[0].watched).toBe(true);
    });

    it('never passes the raw login name through', async () => {
        await statusDef.handlers.POST!(makeEvent(AVAILABLE_MOVIE), CTX_V1);

        for (const call of mockCheckIfWatched.mock.calls) {
            expect(call[0]).not.toBe('leon');
        }
    });

    it('skips the check instead of querying when the name resolves to no user', async () => {
        mockGetUserIdByUsername.mockResolvedValue(null);

        const res = await statusDef.handlers.POST!(makeEvent(AVAILABLE_MOVIE), CTX_V1);
        const body = (await res.json()) as Array<{ watched?: boolean }>;

        expect(mockCheckIfWatched).not.toHaveBeenCalled();
        expect(body[0].watched).toBe(false);
    });

    it('passes the UUID on the movie path too', async () => {
        mockCheckLocalAvailability.mockResolvedValue({ isAvailable: false });
        mockDetermineMovieStatus.mockResolvedValue({ status: 'available', mediaType: 'movie' });

        await statusDef.handlers.POST!(makeEvent(AVAILABLE_MOVIE), CTX_V1);

        expect(mockCheckIfWatched).toHaveBeenCalledTimes(1);
        expect(mockCheckIfWatched.mock.calls[0][0]).toBe(USER_UUID);
    });
});
