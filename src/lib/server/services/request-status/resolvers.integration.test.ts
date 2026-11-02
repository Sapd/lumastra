// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/server/services/request-status/resolvers.integration.test.ts
//
// Integration tests for request-status resolvers against a real PostgreSQL database.
// Verifies that has_files is the sole availability source when no Jellyfin external IDs exist.
//
// Run locally:
//   npm run test:integration src/lib/server/services/request-status/resolvers.integration.test.ts
//
// Run against preprod:
//   npm run test:integration -- src/lib/server/services/request-status/resolvers.integration.test.ts

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const MOVIE_WITH_FILES_ID = '00000000-0001-4000-a000-000000000001';
const MOVIE_NO_FILES_ID = '00000000-0001-4000-a000-000000000002';
const SERIES_ID = '00000000-0001-4000-a000-000000000003';
const SEASON_WITH_FILES_ID = '00000000-0001-4000-a000-000000000004';
const SEASON_NO_FILES_ID = '00000000-0001-4000-a000-000000000005';

const TMDB_MOVIE_WITH_FILES = '99001';
const TMDB_MOVIE_NO_FILES = '99002';
const TMDB_SERIES = '99003';

// ---------------------------------------------------------------------------
// Mocks — deterministic stubs so network calls never fire
// ---------------------------------------------------------------------------

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn().mockReturnValue(null),
}));

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));

vi.mock('$lib/server/sonarr.js', () => ({
    radarrClient: {
        getMovieByTmdbId: vi.fn().mockResolvedValue(null),
        getQueue: vi.fn().mockResolvedValue({ records: [] }),
    },
    sonarrClient: {
        getQueue: vi.fn().mockResolvedValue({ records: [] }),
        getSeriesByTvdbId: vi.fn().mockResolvedValue(null),
    },
}));

vi.mock('$lib/paraglide/messages.js', () => ({
    req_available: () => 'Available',
    req_unavailable: () => 'Unavailable',
    req_downloading: () => 'Downloading',
    req_synching: () => 'Syncing to library',
    req_processing: () => 'Being processed',
    req_searching: () => 'Searching',
    request_sending: () => 'Pending',
    req_queued: () => 'Queued',
    req_paused: () => 'Paused',
    request_status_importing: () => 'Importing',
    request_status_monitored_searching: () => 'Monitored',
    request_status_searching: () => 'Searching for release',
    request_status_processing: () => 'Processing',
    request_status_processing_failed: () => 'Processing failed',
    request_status_no_release_found: () => 'No release found',
    request_status_download_failed: () => 'Download failed',
    request_status_available_from: ({ date }: { date: string }) => `Available from ${date}`,
    request_status_waiting_release: () => 'Waiting for release',
    request_status_waiting_release_date: () => 'Waiting for release date',
    request_status_in_cinema: () => 'In cinemas',
    request_status_series_starting: () => 'Series starting soon',
}));

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('resolvers integration — has_files availability, no Jellyfin', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        await sql`SELECT 1`;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['external_ids', 'media_items']);

        // Insert test media items — no Jellyfin external IDs anywhere
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES
                (${MOVIE_WITH_FILES_ID}::uuid, 'Test Movie Available', 'movie', 'active', true),
                (${MOVIE_NO_FILES_ID}::uuid, 'Test Movie Not Available', 'movie', 'active', false),
                (${SERIES_ID}::uuid, 'Test Series', 'tv', 'active', false),
                (${SEASON_WITH_FILES_ID}::uuid, 'Test Season 1 Available', 'season', 'active', true),
                (${SEASON_NO_FILES_ID}::uuid, 'Test Season 2 Not Available', 'season', 'active', false)
        `;

        // Link seasons to series via parent_id and season_number
        await sql`
            UPDATE media_items SET parent_id = ${SERIES_ID}::uuid, season_number = 1
            WHERE id = ${SEASON_WITH_FILES_ID}::uuid
        `;
        await sql`
            UPDATE media_items SET parent_id = ${SERIES_ID}::uuid, season_number = 2
            WHERE id = ${SEASON_NO_FILES_ID}::uuid
        `;

        // Insert TMDB external IDs only — zero rows with provider='jellyfin'
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type)
            VALUES
                (${MOVIE_WITH_FILES_ID}::uuid, 'tmdb', ${TMDB_MOVIE_WITH_FILES}, 'movie'),
                (${MOVIE_NO_FILES_ID}::uuid, 'tmdb', ${TMDB_MOVIE_NO_FILES}, 'movie'),
                (${SERIES_ID}::uuid, 'tmdb', ${TMDB_SERIES}, 'tv')
        `;
    });

    // -------------------------------------------------------------------------
    // Wire getDb() to return the test sql connection for each test invocation
    // -------------------------------------------------------------------------

    async function withTestDb<T>(fn: () => Promise<T>): Promise<T> {
        const mod = await import('$lib/server/database/connection.js');
        const getDbMock = vi.mocked(mod.getDb as () => postgres.Sql | null);
        getDbMock.mockReturnValue(sql);
        try {
            return await fn();
        } finally {
            getDbMock.mockReturnValue(null);
        }
    }

    const emptyArrQueue = {
        page: 1,
        pageSize: 0,
        sortKey: 'timeleft',
        sortDirection: 'ascending' as const,
        totalRecords: 0,
        records: [],
    };
    const emptyRadarrQueue = emptyArrQueue;
    const emptySonarrQueue = emptyArrQueue;

    it('(a) determineMovieStatus: movie with has_files=true returns available', async () => {
        const { determineMovieStatus } = await import('./resolvers.js');
        const result = await withTestDb(() =>
            determineMovieStatus({ tmdb: TMDB_MOVIE_WITH_FILES }, emptyRadarrQueue, 0, undefined, {
                deniedGroupIds: null,
                ageRating: null,
            }),
        );
        expect(result.status).toBe('available');
    });

    it('(b) determineMovieStatus: has_files=false + Jellyseerr PROCESSING returns searching', async () => {
        const { determineMovieStatus } = await import('./resolvers.js');
        const { MediaStatus } = await import('$lib/server/jellyseerr.js');
        const result = await withTestDb(() =>
            determineMovieStatus(
                { tmdb: TMDB_MOVIE_NO_FILES },
                emptyRadarrQueue,
                0,
                MediaStatus.PROCESSING,
                { deniedGroupIds: null, ageRating: null },
            ),
        );
        expect(result.status).toBe('searching');
    });

    it('(c) determineMovieStatus: has_files=false + Jellyseerr PENDING returns pending', async () => {
        const { determineMovieStatus } = await import('./resolvers.js');
        const { MediaStatus } = await import('$lib/server/jellyseerr.js');
        const result = await withTestDb(() =>
            determineMovieStatus(
                { tmdb: TMDB_MOVIE_NO_FILES },
                emptyRadarrQueue,
                0,
                MediaStatus.PENDING,
                { deniedGroupIds: null, ageRating: null },
            ),
        );
        expect(result.status).toBe('pending');
    });

    it('(d) determineMovieStatus: has_files=false + Jellyseerr AVAILABLE → synching with req_processing message', async () => {
        const { determineMovieStatus } = await import('./resolvers.js');
        const { MediaStatus } = await import('$lib/server/jellyseerr.js');
        const m = await import('$lib/paraglide/messages.js');
        const result = await withTestDb(() =>
            determineMovieStatus(
                { tmdb: TMDB_MOVIE_NO_FILES },
                emptyRadarrQueue,
                0,
                MediaStatus.AVAILABLE,
                { deniedGroupIds: null, ageRating: null },
            ),
        );
        expect(result.status).toBe('synching');
        expect(result.statusMessage).toBe(m.req_processing());
        expect(result.statusMessage).not.toBe(m.req_synching());
    });

    it('(e) determineSeasonStatus: season with all episode files returns available', async () => {
        await sql`INSERT INTO media_items (parent_id, title, media_type, status, has_files, episode_number)
            VALUES (${SEASON_WITH_FILES_ID}::uuid, 'Episode 1', 'episode', 'active', true, 1)`;
        const { determineSeasonStatus } = await import('./resolvers.js');
        const result = await withTestDb(() =>
            determineSeasonStatus({ tmdb: TMDB_SERIES }, 1, undefined, emptySonarrQueue, null, 0),
        );
        expect(result.status).toBe('available');
    });

    it('(f) determineSeasonStatus: season has_files=false + Jellyseerr AVAILABLE → synching with req_processing message', async () => {
        const { determineSeasonStatus } = await import('./resolvers.js');
        const m = await import('$lib/paraglide/messages.js');
        const result = await withTestDb(() =>
            determineSeasonStatus(
                { tmdb: TMDB_SERIES },
                2,
                undefined,
                emptySonarrQueue,
                [
                    {
                        seasonNumber: 2,
                        isAvailable: true,
                        isRequested: true,
                        requestStatus: 'approved',
                        status: 5,
                    },
                ],
                0,
            ),
        );
        expect(result.status).toBe('synching');
        expect(result.statusMessage).toBe(m.req_processing());
        expect(result.statusMessage).not.toBe(m.req_synching());
    });

    it('(g) determineTvAggregateStatus: Jellyseerr AVAILABLE no longer shortcuts to available', async () => {
        const { determineTvAggregateStatus } = await import('./resolvers.js');
        const { MediaStatus } = await import('$lib/server/jellyseerr.js');
        const m = await import('$lib/paraglide/messages.js');
        const result = determineTvAggregateStatus(
            MediaStatus.AVAILABLE,
            emptySonarrQueue,
            undefined,
            0,
            undefined,
        );
        expect(result.status).not.toBe('available');
        expect(result.status).toBe('synching');
        expect(result.statusMessage).toBe(m.req_processing());
    });
});
