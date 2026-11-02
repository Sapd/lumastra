// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /requests/status — public response-contract tests.
 *
 * This def had no colocated tests and no `docs` block, so nothing checked its
 * output against RequestStatusResultSchema. Two things went unnoticed as a
 * result and are pinned here:
 *
 *  1. `mediaType` was emitted as the internal `tv` for series, contradicting
 *     both the def's own doc comment and the schema's `movie | series` enum.
 *  2. `download` is the only place a client can read progress — the fields must
 *     survive serialization, minus the server-internal `download.state`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockCheckRateLimit = vi.fn();
const mockGetClientIp = vi.fn();
const mockResolveToTmdb = vi.fn();
const mockGetUserByUsername = vi.fn();
const mockGetRequests = vi.fn();
const mockGetMediaByTmdbId = vi.fn();
const mockGetSeasonRequestStatus = vi.fn();
const mockGetAllQueueRecordsSonarr = vi.fn();
const mockGetAllQueueRecordsRadarr = vi.fn();
const mockGetSeriesByTvdbId = vi.fn();
const mockCheckLocalAvailability = vi.fn();
const mockCheckIfWatched = vi.fn();
const mockDetermineTvAggregateStatus = vi.fn();
const mockDetermineMovieStatus = vi.fn();

vi.mock('$lib/server/jellyseerr.js', () => ({
    jellyseerrClient: {
        getUserByUsername: (...a: unknown[]) => mockGetUserByUsername(...a),
        getRequests: (...a: unknown[]) => mockGetRequests(...a),
        getMediaByTmdbId: (...a: unknown[]) => mockGetMediaByTmdbId(...a),
        getSeasonRequestStatus: (...a: unknown[]) => mockGetSeasonRequestStatus(...a),
    },
    MediaStatus: { AVAILABLE: 5, PARTIALLY_AVAILABLE: 4, PROCESSING: 3, PENDING: 2, UNKNOWN: 1 },
}));

vi.mock('$lib/server/sonarr.js', () => ({
    sonarrClient: {
        getAllQueueRecords: (...a: unknown[]) => mockGetAllQueueRecordsSonarr(...a),
        getSeriesByTvdbId: (...a: unknown[]) => mockGetSeriesByTvdbId(...a),
    },
    radarrClient: {
        getAllQueueRecords: (...a: unknown[]) => mockGetAllQueueRecordsRadarr(...a),
    },
}));

vi.mock('$lib/server/services/request-status/index.js', () => ({
    checkLocalAvailability: (...a: unknown[]) => mockCheckLocalAvailability(...a),
    checkIfWatched: (...a: unknown[]) => mockCheckIfWatched(...a),
    validateRequestQuery: (r: Record<string, unknown>) => ({ valid: true, data: r }),
    determineSeasonStatus: vi.fn(),
    determineMovieStatus: (...a: unknown[]) => mockDetermineMovieStatus(...a),
    determineTvAggregateStatus: (...a: unknown[]) => mockDetermineTvAggregateStatus(...a),
}));

vi.mock('$lib/server/services/provider-resolution.service.js', () => ({
    providerResolutionService: { resolveToTmdb: (...a: unknown[]) => mockResolveToTmdb(...a) },
}));

vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a),
}));

vi.mock('$lib/server/utils/client-ip.js', () => ({
    getClientIp: (...a: unknown[]) => mockGetClientIp(...a),
}));

vi.mock('$lib/server/database/index.js', () => ({ getDb: () => null }));

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
const { RequestStatusResponseSchema } = await import('$lib/schemas/api-content-responses.js');

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
        locals: { user: { username: 'alice' } },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIp.mockReturnValue('1.2.3.4');
    mockCheckRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
    mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 1396 });
    mockGetUserByUsername.mockResolvedValue(null);
    mockGetRequests.mockResolvedValue([]);
    mockGetMediaByTmdbId.mockResolvedValue({ title: 'Drifting Clouds', tvdbId: 81189 });
    mockGetAllQueueRecordsSonarr.mockResolvedValue([]);
    mockGetAllQueueRecordsRadarr.mockResolvedValue([]);
    mockGetSeriesByTvdbId.mockResolvedValue(null);
    mockCheckLocalAvailability.mockResolvedValue({ isAvailable: false });
    mockCheckIfWatched.mockResolvedValue(false);
});

describe('POST /requests/status — public mediaType projection', () => {
    it('emits `series`, never the internal `tv`, for a series query', async () => {
        mockDetermineTvAggregateStatus.mockReturnValue({
            status: 'downloading',
            statusMessage: 'Downloading season 5',
            download: { percentage: 42, state: 'downloading' },
        });

        const res = (await statusDef.handlers.POST!(
            makeEvent({ requests: [{ externalIds: { tmdb: '1396' }, mediaType: 'series' }] }),
            CTX_V1,
        )) as Response;

        expect(res.status).toBe(200);
        const body = (await res.json()) as Array<Record<string, unknown>>;
        expect(body[0].mediaType).toBe('series');
    });

    it('rejects the legacy `tv` input token', async () => {
        mockDetermineTvAggregateStatus.mockReturnValue({ status: 'pending' });

        const res = (await statusDef.handlers.POST!(
            makeEvent({ requests: [{ externalIds: { tmdb: '1396' }, mediaType: 'tv' }] }),
            CTX_V1,
        )) as Response;

        expect(res.status).toBe(422);
    });

    it('leaves `movie` untouched', async () => {
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 550 });
        mockDetermineMovieStatus.mockResolvedValue({
            mediaType: 'movie',
            status: 'available',
        });

        const res = (await statusDef.handlers.POST!(
            makeEvent({ requests: [{ externalIds: { tmdb: '550' }, mediaType: 'movie' }] }),
            CTX_V1,
        )) as Response;

        const body = (await res.json()) as Array<Record<string, unknown>>;
        expect(body[0].mediaType).toBe('movie');
    });
});

describe('POST /requests/status — externalIds.internal on fulfilment', () => {
    it('merges the resolved internal UUID in once the item is locally available', async () => {
        // This is the fulfilment signal a UUID-first client keys off: the
        // moment `status` flips to `available` the request has become a catalog
        // row and the UUID exists. The caller cannot have supplied `internal`
        // itself — before fulfilment there was nothing to reference.
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 550 });
        mockCheckLocalAvailability.mockResolvedValue({
            internalId: '11111111-2222-3333-4444-555555555555',
            isAvailable: true,
        });
        mockCheckIfWatched.mockResolvedValue(false);

        const res = (await statusDef.handlers.POST!(
            makeEvent({ requests: [{ externalIds: { tmdb: '550' }, mediaType: 'movie' }] }),
            CTX_V1,
        )) as Response;

        const body = (await res.json()) as Array<Record<string, unknown>>;
        expect(body[0].status).toBe('available');
        expect(body[0].externalIds).toMatchObject({
            tmdb: '550',
            internal: '11111111-2222-3333-4444-555555555555',
        });
    });

    it('still echoes the caller ids when the item is not locally available', async () => {
        mockResolveToTmdb.mockResolvedValue({ success: true, tmdbId: 550 });
        mockCheckLocalAvailability.mockResolvedValue({
            internalId: 'unused',
            isAvailable: false,
        });
        mockDetermineMovieStatus.mockResolvedValue({ mediaType: 'movie', status: 'downloading' });

        const res = (await statusDef.handlers.POST!(
            makeEvent({ requests: [{ externalIds: { tmdb: '550' }, mediaType: 'movie' }] }),
            CTX_V1,
        )) as Response;

        const body = (await res.json()) as Array<Record<string, unknown>>;
        expect(body[0].externalIds).toEqual({ tmdb: '550' });
    });
});

describe('POST /requests/status — download progress contract', () => {
    it('keeps the progress fields and strips the internal download.state', async () => {
        mockDetermineTvAggregateStatus.mockReturnValue({
            status: 'downloading',
            statusMessage: 'Downloading season 5',
            download: {
                percentage: 42,
                timeLeft: '00:12:00',
                size: '2 GB',
                sizeLeft: '1.2 GB',
                state: 'downloading',
            },
        });

        const res = (await statusDef.handlers.POST!(
            makeEvent({ requests: [{ externalIds: { tmdb: '1396' }, mediaType: 'series' }] }),
            CTX_V1,
        )) as Response;

        const body = (await res.json()) as Array<Record<string, unknown>>;
        const download = body[0].download as Record<string, unknown>;

        expect(download).toMatchObject({
            percentage: 42,
            timeLeft: '00:12:00',
            size: '2 GB',
            sizeLeft: '1.2 GB',
        });
        expect(download).not.toHaveProperty('state');
        expect(body[0].statusMessage).toBe('Downloading season 5');
    });

    it('validates against the published RequestStatusResponseSchema', async () => {
        mockDetermineTvAggregateStatus.mockReturnValue({
            status: 'downloading',
            statusMessage: 'Downloading season 5',
            download: { percentage: 42, state: 'downloading' },
        });

        const res = (await statusDef.handlers.POST!(
            makeEvent({ requests: [{ externalIds: { tmdb: '1396' }, mediaType: 'series' }] }),
            CTX_V1,
        )) as Response;

        const parsed = RequestStatusResponseSchema.safeParse(await res.json());
        expect(parsed.error?.issues ?? []).toEqual([]);
        expect(parsed.success).toBe(true);
    });
});
