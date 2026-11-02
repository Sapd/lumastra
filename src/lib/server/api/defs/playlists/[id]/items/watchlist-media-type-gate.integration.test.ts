// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-Postgres coverage for the watchlist per-kind policy gate on
 * `POST /playlists/{id}/items` (Task 4 ADDED SCOPE of the
 * watchlist-as-system-playlist project).
 *
 * Task 2 built `getPlaylistKindPolicy` / `isMediaTypeAllowed` and wired them
 * into `PlaylistItemManager.addItems` (see
 * `playlist-item-manager.watchlist.integration.test.ts`, which drives
 * `addItems` directly). Nothing, however, called `addItems` with a
 * `playlistType` — so the route itself never consulted the policy, and a
 * direct `POST /playlists/{watchlistId}/items` with an episode would insert
 * a disallowed row. This file drives the actual route handler (the same
 * `def.handlers.*` pattern as `system-playlist-guard.integration.test.ts`)
 * to prove the wiring, not just the service underneath it.
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

const { def: itemsDef } = await import('./index.js');

const ctx: ApiContext = { surface: 'internal' };

function fullUser(overrides: Partial<UserContext> = {}): UserContext {
    return {
        userId: toUserId('00000000-0000-0000-0000-000000000000'),
        username: 'watchlist-media-type-gate-test',
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

describe('POST /playlists/{watchlistId}/items — per-kind policy gate', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
    });

    it('rejects an episode with a validation error and inserts no row', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const watchlistId = await ensureWatchlistPlaylist(sql, userId);

        const series = await createAndInsertTestSeries(sql, {
            tmdbId: 901101,
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

        const res = await itemsDef.handlers.POST!(event, ctx);

        expect(res.status).toBe(200);
        const responseBody = await res.json();
        expect(responseBody.results[0]).toMatchObject({
            status: 'rejected',
            reason: 'media_type_not_allowed',
            entries: [],
        });

        const rows = await sql`
            SELECT id FROM playlist_items WHERE playlist_id = ${watchlistId} AND media_id = ${episodeId}::uuid
        `;
        expect(rows).toHaveLength(0);
    });

    it('still accepts a movie', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const watchlistId = await ensureWatchlistPlaylist(sql, userId);

        const { id: movieId } = await createAndInsertTestMovie(sql, { tmdbId: 901102 });

        const event = buildPostEvent(watchlistId, fullUser({ userId, username: owner.username }), {
            mediaIds: [movieId],
        });

        const res = await itemsDef.handlers.POST!(event, ctx);

        expect(res.status).toBe(200);
        const responseBody = await res.json();
        expect(responseBody.results[0].status).toBe('added');

        const rows = await sql`
            SELECT id FROM playlist_items WHERE playlist_id = ${watchlistId} AND media_id = ${movieId}::uuid
        `;
        expect(rows).toHaveLength(1);
    });
});
