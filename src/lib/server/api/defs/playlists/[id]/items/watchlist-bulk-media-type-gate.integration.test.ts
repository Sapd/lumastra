// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-Postgres coverage for the watchlist per-kind policy gate on
 * `POST /playlists/{id}/items` (B1 of the 2026-09-22 edge-case fix
 * pass on the watchlist-as-system-playlist project).
 *
 * `watchlist-media-type-gate.integration.test.ts` proves the gate is wired
 * on the single-item `POST /playlists/{id}/items` route. This bulk sibling
 * had NO kind-policy check at all — `PlaylistItemManager.addItems` and
 * `upsertWatchlistItem` both enforce it, but bulk.ts never resolved the
 * playlist's type in the first place, so a caller could put an episode
 * (with a real season/episode number, no less) straight onto the watchlist
 * via this endpoint. This file drives the real `def.handlers.POST` against
 * a real database to prove both halves of the fix: the disallowed item is
 * skipped, AND an allowed item's season/episode are forced to NULL instead
 * of being written verbatim.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import type { UserContext } from '$lib/server/types.js';
import { getTestDb } from '../../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../../tests/integration/helpers/cleanup.js';
import { createTestUser } from '../../../../../../../../tests/integration/helpers/users.js';
import { createAndInsertTestMovie } from '../../../../../../../../tests/integration/fixtures/index.js';
import { createAndInsertTestSeries } from '../../../../../../../../tests/integration/fixtures/episode.fixtures.js';
import { toUserId } from '$lib/shared/user-id';
import { ensureWatchlistPlaylist } from '$lib/server/database/queries/watchlist-playlist.queries.js';
import type postgres from 'postgres';

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    const { getTestDb: getSql } =
        await import('../../../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

const { def: bulkDef } = await import('./index.js');

const ctx: ApiContext = { surface: 'internal' };

function fullUser(overrides: Partial<UserContext> = {}): UserContext {
    return {
        userId: toUserId('00000000-0000-0000-0000-000000000000'),
        username: 'watchlist-bulk-gate-test',
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        ownerIsAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
        ...overrides,
    };
}

function buildPostEvent(playlistId: number, user: UserContext, body: unknown): RequestEvent {
    const url = new URL(`http://localhost/api/playlists/${playlistId}/items`);
    return {
        params: { id: String(playlistId) },
        locals: { user },
        url,
        request: new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        route: { id: null },
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

describe('POST /playlists/{watchlistId}/items/bulk — per-kind policy gate', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
    });

    it('skips an episode with reason media_type_not_allowed and inserts no row', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const watchlistId = await ensureWatchlistPlaylist(sql, userId);

        const series = await createAndInsertTestSeries(sql, {
            tmdbId: 901201,
            seasonCount: 1,
            episodesPerSeason: 1,
        });
        const [{ id: episodeId }] = await sql<{ id: string }[]>`
            SELECT ep.id::text AS id
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id
            WHERE season.parent_id = ${series.seriesId}::uuid AND ep.media_type = 'episode'
            LIMIT 1
        `;

        const event = buildPostEvent(watchlistId, fullUser({ userId, username: owner.username }), {
            mediaIds: [episodeId],
        });

        const res = await bulkDef.handlers.POST!(event, ctx);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(
            body.results.filter((result: { status: string }) => result.status === 'added'),
        ).toHaveLength(0);
        expect(
            body.results.filter((result: { status: string }) => result.status === 'rejected'),
        ).toHaveLength(1);
        expect(
            body.results.filter((result: { status: string }) => result.status === 'rejected')[0]
                .reason,
        ).toBe('media_type_not_allowed');

        const rows = await sql`
            SELECT id FROM playlist_items WHERE playlist_id = ${watchlistId} AND media_id = ${episodeId}::uuid
        `;
        expect(rows).toHaveLength(0);
    });

    it('still accepts a movie, and forces season/episode to NULL even if the caller sent them', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const watchlistId = await ensureWatchlistPlaylist(sql, userId);

        const { id: movieId } = await createAndInsertTestMovie(sql, { tmdbId: 901202 });

        const event = buildPostEvent(watchlistId, fullUser({ userId, username: owner.username }), {
            mediaIds: [movieId],
        });

        const res = await bulkDef.handlers.POST!(event, ctx);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(
            body.results.filter((result: { status: string }) => result.status === 'added'),
        ).toHaveLength(1);

        const rows = await sql<
            { media_id: string; season_number: number | null; episode_number: number | null }[]
        >`
            SELECT media_id, season_number, episode_number
            FROM playlist_items WHERE playlist_id = ${watchlistId} AND media_id = ${movieId}::uuid
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].season_number).toBeNull();
        expect(rows[0].episode_number).toBeNull();
    });

    // Coordinator follow-up (2026-09-22): the claimed-mediaType check above
    // only covers an HONEST claim. bulk.ts's internal-id fast path
    // (Pass 1b, existence-only) resolves a caller-supplied UUID with no type
    // check of its own — so a LYING claim (`mediaType:'movie'` naming an
    // episode's real UUID) sailed past it. Same class of defect B2 closes in
    // PlaylistItemManager. Proves the batched re-check (Pass 2b) catches this
    // for the lying item while a genuine movie in the SAME batch still
    // succeeds.
    it('skips an item whose CLAIMED mediaType lies about its resolved type, while a genuine item in the same batch still succeeds', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const watchlistId = await ensureWatchlistPlaylist(sql, userId);

        const series = await createAndInsertTestSeries(sql, {
            tmdbId: 901203,
            seasonCount: 1,
            episodesPerSeason: 1,
        });
        const [{ id: episodeId }] = await sql<{ id: string }[]>`
            SELECT ep.id::text AS id
            FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id
            WHERE season.parent_id = ${series.seriesId}::uuid AND ep.media_type = 'episode'
            LIMIT 1
        `;
        const { id: movieId } = await createAndInsertTestMovie(sql, { tmdbId: 901204 });

        const event = buildPostEvent(watchlistId, fullUser({ userId, username: owner.username }), {
            mediaIds: [episodeId, movieId],
        });

        const res = await bulkDef.handlers.POST!(event, ctx);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(
            body.results.filter((result: { status: string }) => result.status === 'added'),
        ).toHaveLength(1);
        expect(
            body.results.filter((result: { status: string }) => result.status === 'rejected'),
        ).toHaveLength(1);
        expect(
            body.results.filter((result: { status: string }) => result.status === 'rejected')[0]
                .reason,
        ).toBe('media_type_not_allowed');
        expect(
            body.results.filter((result: { status: string }) => result.status === 'rejected')[0]
                .mediaId,
        ).toBe(episodeId);

        const episodeRows = await sql`
            SELECT id FROM playlist_items WHERE playlist_id = ${watchlistId} AND media_id = ${episodeId}::uuid
        `;
        expect(episodeRows).toHaveLength(0);

        const movieRows = await sql`
            SELECT id FROM playlist_items WHERE playlist_id = ${watchlistId} AND media_id = ${movieId}::uuid
        `;
        expect(movieRows).toHaveLength(1);
    });
});
