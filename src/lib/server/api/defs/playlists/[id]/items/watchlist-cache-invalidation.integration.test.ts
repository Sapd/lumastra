// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * N2 (2026-09-22 edge-case pass on the watchlist-as-system-playlist
 * project): `WatchlistManager` calls `cacheInvalidation.onWatchlistChange`
 * on every add/remove, but the FOUR generic playlist-item routes — which
 * also write to the watchlist whenever the target playlist happens to be
 * one — never did. Suggestion/similar-content caches kept pre-change
 * contents until their TTL for any watchlist write that went through
 * `POST /playlists/{id}/items`, `DELETE /playlists/{id}/items/{itemId}`,
 * `POST /playlists/{id}/items`, or `POST /playlists/{id}/items/bulk-delete`.
 *
 * This file drives each of the four route handlers against a real database,
 * with `$lib/server/cache`'s `cacheInvalidation.onWatchlistChange` mocked to
 * a spy (real Valkey I/O is not the point here — the call itself is), and
 * asserts it fires with the right (userId, mediaId) for a watchlist target,
 * and does NOT fire for an ordinary playlist (no needless cache traffic on
 * the hot path).
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
import { toUserId } from '$lib/shared/user-id';
import { ensureWatchlistPlaylist } from '$lib/server/database/queries/watchlist-playlist.queries.js';
import { upsertWatchlistItem } from '$lib/server/database/queries/watchlist.queries.js';
import {
    createPlaylist,
    insertPlaylistItem,
} from '$lib/server/database/queries/playlists.queries.js';
import type postgres from 'postgres';

const mockOnWatchlistChange = vi.fn().mockResolvedValue(undefined);

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    const { getTestDb: getSql } =
        await import('../../../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

vi.mock('$lib/server/cache', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/cache')>();
    return {
        ...actual,
        cacheInvalidation: {
            ...actual.cacheInvalidation,
            onWatchlistChange: (...args: unknown[]) => mockOnWatchlistChange(...args),
        },
    };
});

const { def: itemsDef } = await import('./index.js');
const { def: itemDeleteDef } = await import('./[entryId].js');
const { def: bulkDeleteDef } = await import('./bulk-delete.js');

const ctx: ApiContext = { surface: 'internal' };

function fullUser(overrides: Partial<UserContext> = {}): UserContext {
    return {
        userId: toUserId('00000000-0000-0000-0000-000000000000'),
        username: 'watchlist-cache-invalidation-test',
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

function buildEvent(
    playlistId: number,
    user: UserContext,
    init: { method: string; body?: unknown; pathSuffix?: string },
): RequestEvent {
    const url = new URL(
        `http://localhost/api/playlists/${playlistId}/items${init.pathSuffix ?? ''}`,
    );
    return {
        params: { id: String(playlistId) },
        locals: { user },
        url,
        request: new Request(url, {
            method: init.method,
            headers: init.body ? { 'content-type': 'application/json' } : undefined,
            body: init.body ? JSON.stringify(init.body) : undefined,
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

/** Builds a DELETE event with the playlist and entry path parameters. */
function buildItemDeleteEvent(playlistId: number, itemId: number, user: UserContext): RequestEvent {
    const url = new URL(`http://localhost/api/playlists/${playlistId}/items/${itemId}`);
    return {
        params: { id: String(playlistId), entryId: String(itemId) },
        locals: { user },
        url,
        request: new Request(url, { method: 'DELETE' }),
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

describe('watchlist cache invalidation across the generic playlist-item routes', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
        mockOnWatchlistChange.mockClear();
    });

    it('POST /playlists/{watchlistId}/items invalidates the cache', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const watchlistId = await ensureWatchlistPlaylist(sql, userId);
        const { id: movieId } = await createAndInsertTestMovie(sql, { tmdbId: 930101 });

        const event = buildEvent(watchlistId, fullUser({ userId, username: owner.username }), {
            method: 'POST',
            body: { mediaIds: [movieId] },
        });

        const res = await itemsDef.handlers.POST!(event, ctx);
        expect(res.status).toBe(200);
        expect(mockOnWatchlistChange).toHaveBeenCalledWith(userId, movieId);
    });

    it('POST /playlists/{ordinaryId}/items does NOT invalidate the watchlist cache', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const playlist = await createPlaylist(sql, userId, 'Ordinary', null, 'private', 'general');
        const { id: movieId } = await createAndInsertTestMovie(sql, { tmdbId: 930102 });

        const event = buildEvent(playlist.id, fullUser({ userId, username: owner.username }), {
            method: 'POST',
            body: { mediaIds: [movieId] },
        });

        const res = await itemsDef.handlers.POST!(event, ctx);
        expect(res.status).toBe(200);
        expect(mockOnWatchlistChange).not.toHaveBeenCalled();
    });

    it('DELETE /playlists/{watchlistId}/items/{itemId} invalidates the cache', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const watchlistId = await ensureWatchlistPlaylist(sql, userId);
        const { id: movieId } = await createAndInsertTestMovie(sql, { tmdbId: 930103 });
        const [{ id: rowId }] = await upsertWatchlistItem(sql, userId, movieId);

        const event = buildItemDeleteEvent(
            watchlistId,
            rowId,
            fullUser({ userId, username: owner.username }),
        );

        const res = await itemDeleteDef.handlers.DELETE!(event, ctx);
        expect(res.status).toBe(200);
        expect(mockOnWatchlistChange).toHaveBeenCalledWith(userId, movieId);
    });

    it('POST /playlists/{watchlistId}/items/bulk-delete invalidates the cache for each removed item', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const watchlistId = await ensureWatchlistPlaylist(sql, userId);
        const { id: movieId } = await createAndInsertTestMovie(sql, { tmdbId: 930104 });
        const [{ id: rowId }] = await upsertWatchlistItem(sql, userId, movieId);

        const event = buildEvent(watchlistId, fullUser({ userId, username: owner.username }), {
            method: 'POST',
            pathSuffix: '/bulk-delete',
            body: { entryIds: [rowId] },
        });

        const res = await bulkDeleteDef.handlers.POST!(event, ctx);
        expect(res.status).toBe(200);
        expect(mockOnWatchlistChange).toHaveBeenCalledWith(userId, movieId);
    });

    it('bulk-delete on an ordinary playlist does NOT invalidate the watchlist cache', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const playlist = await createPlaylist(sql, userId, 'Ordinary', null, 'private', 'general');
        const { id: movieId } = await createAndInsertTestMovie(sql, { tmdbId: 930105 });
        const row = await insertPlaylistItem(sql, {
            playlistId: playlist.id,
            mediaId: movieId,
            seasonNumber: null,
            episodeNumber: null,
            title: 'Ordinary item',
            seriesName: null,
            overview: null,
            posterPath: null,
            position: 0,
        });
        expect(row).not.toBeNull();

        const event = buildEvent(playlist.id, fullUser({ userId, username: owner.username }), {
            method: 'POST',
            pathSuffix: '/bulk-delete',
            body: { entryIds: [row!.id] },
        });

        const res = await bulkDeleteDef.handlers.POST!(event, ctx);
        expect(res.status).toBe(200);
        expect(mockOnWatchlistChange).not.toHaveBeenCalled();
    });
});
