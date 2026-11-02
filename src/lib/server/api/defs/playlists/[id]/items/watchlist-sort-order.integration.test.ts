// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-Postgres coverage for `GET /playlists/{id}/items` newest-first
 * ordering on a watchlist playlist (`policy.sort === 'added_at_desc'`), and
 * for the CRITICAL 1 review finding on Task 4 of the
 * watchlist-as-system-playlist project.
 *
 * Before this file, `grep -rn "added_at_desc" src/` returned only the
 * implementation, its comments, and a policy-constant assertion in
 * `playlist-kind-policy.test.ts` — nothing exercised `getPlaylistItems(...,
 * 'added_at_desc')` against a database, and nothing asserted the GET handler
 * actually passes `policy.sort` through for a watchlist. Worse, the two unit
 * suites that DO touch this route (`items/index.test.ts`,
 * `playlists-items-cursor.def.test.ts`) mock `getPlaylistType` to `null`,
 * which routes them onto the OLD position-ordering path by design — so the
 * only existing route-level coverage actively excludes the new path.
 *
 * CRITICAL 1 (the reason for the second `describe` below): the GET handler
 * used to mint an offset->cursor "bootstrap" cursor
 * (`encodeItemsCursor(last.position, last.id)`) unconditionally whenever
 * `hasMore` was true — including on an `added_at DESC` watchlist page. A
 * client that followed that cursor would silently re-enter cursor mode,
 * which always pages `(position ASC, id ASC)` regardless of `sort`. Because a
 * watchlist's positions ascend WITH `added_at` (append-only, `MAX(position) +
 * 1`), the LAST row of an `added_at DESC` page holds the LOWEST position on
 * that page — so the minted cursor pointed the client at exactly the rows it
 * had already just seen, and the rows with lower `added_at` (further down the
 * list) became unreachable. The fix suppresses the bootstrap cursor for any
 * playlist whose `policy.sort !== 'position'`, so a non-position playlist
 * stays offset-paged only (`cursor` is optional in `PageBlockSchema`, so this
 * is not a contract break).
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
        username: 'watchlist-sort-order-test',
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

function buildGetEvent(playlistId: number, user: UserContext, url: URL): RequestEvent {
    return {
        params: { id: String(playlistId) },
        locals: { user },
        url,
        request: new Request(url, { method: 'GET' }),
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

interface ItemsResponseBody {
    items: { mediaId: string }[];
    page: { hasMore: boolean; nextCursor?: string };
}

async function getItemsPage(
    playlistId: number,
    user: UserContext,
    params: { limit: number; offset?: number; cursor?: string },
): Promise<ItemsResponseBody> {
    const url = new URL(`http://localhost/api/playlists/${playlistId}/items`);
    url.searchParams.set('limit', String(params.limit));
    if (params.cursor) {
        url.searchParams.set('cursor', params.cursor);
    } else {
        url.searchParams.set('offset', String(params.offset ?? 0));
    }
    const event = buildGetEvent(playlistId, user, url);
    const res = await itemsDef.handlers.GET!(event, ctx);
    expect(res.status).toBe(200);
    return (await res.json()) as ItemsResponseBody;
}

/**
 * Walks every page of a playlist's items the way a well-behaved client would:
 * stay on offset paging until the server offers a `page.nextCursor`, then switch
 * to cursor mode and follow it. Returns the media ids in the exact order and
 * repetition they were served, so callers can assert on duplicates directly
 * rather than after deduping.
 */
async function walkAllItems(
    playlistId: number,
    user: UserContext,
    limit: number,
): Promise<string[]> {
    const ids: string[] = [];
    let offset = 0;
    let cursor: string | undefined;

    // Bounded loop: real playlists here never exceed a handful of pages: a
    // runaway walk (an infinite hasMore) fails loudly instead of hanging.
    for (let i = 0; i < 20; i++) {
        const body = await getItemsPage(playlistId, user, { limit, offset, cursor });
        for (const item of body.items) {
            ids.push(item.mediaId);
        }
        if (!body.page.hasMore) return ids;
        if (body.page.nextCursor) {
            cursor = body.page.nextCursor;
        } else {
            cursor = undefined;
            offset += limit;
        }
    }
    throw new Error('walkAllItems: did not terminate within 20 pages');
}

describe('GET /playlists/{id}/items — watchlist newest-first ordering', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
    });

    it('returns watchlist items newest-first (added_at DESC)', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const watchlistId = await ensureWatchlistPlaylist(sql, userId);
        const user = fullUser({ userId, username: owner.username });

        const movieA = await createAndInsertTestMovie(sql, { withFileItem: true, tmdbId: 920201 });
        const movieB = await createAndInsertTestMovie(sql, { withFileItem: true, tmdbId: 920202 });
        const movieC = await createAndInsertTestMovie(sql, { withFileItem: true, tmdbId: 920203 });

        await upsertWatchlistItem(sql, userId, movieA.id);
        await upsertWatchlistItem(sql, userId, movieB.id);
        await upsertWatchlistItem(sql, userId, movieC.id);

        // Pin distinguishable `added_at` values so ordering is deterministic
        // rather than relying on real-clock insert timing. A oldest, C newest.
        const now = Date.now();
        await sql`UPDATE playlist_items SET added_at = ${new Date(now - 3 * 60_000)} WHERE playlist_id = ${watchlistId} AND media_id = ${movieA.id}::uuid`;
        await sql`UPDATE playlist_items SET added_at = ${new Date(now - 2 * 60_000)} WHERE playlist_id = ${watchlistId} AND media_id = ${movieB.id}::uuid`;
        await sql`UPDATE playlist_items SET added_at = ${new Date(now - 1 * 60_000)} WHERE playlist_id = ${watchlistId} AND media_id = ${movieC.id}::uuid`;

        const body = await getItemsPage(watchlistId, user, { limit: 200 });

        expect(body.items.map((i) => i.mediaId)).toEqual([movieC.id, movieB.id, movieA.id]);
    });

    // CRITICAL 1 regression test — see file header. This test FAILS against
    // the pre-fix route (verified: see task-4-report.md for the captured RED
    // output) because the offset page mints a bootstrap cursor from the last
    // row of an `added_at DESC` page, and following that cursor re-enters
    // `(position ASC, id ASC)` cursor mode, which re-serves the highest
    // positions already shown and never reaches the lowest ones.
    it('the offset->cursor handoff returns each watchlist item exactly once', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const watchlistId = await ensureWatchlistPlaylist(sql, userId);
        const user = fullUser({ userId, username: owner.username });

        const movies = [];
        for (let i = 0; i < 5; i++) {
            movies.push(
                await createAndInsertTestMovie(sql, { withFileItem: true, tmdbId: 920300 + i }),
            );
        }

        // Add in order so position ascends 0..4 exactly like a real watchlist
        // append (MAX(position) + 1), then pin `added_at` to ascend WITH
        // position (movies[0] oldest/position 0 .. movies[4] newest/position
        // 4) — the exact shape Critical 1 describes: the newest-first page's
        // LAST row holds the LOWEST position on that page.
        const now = Date.now();
        for (let i = 0; i < movies.length; i++) {
            await upsertWatchlistItem(sql, userId, movies[i].id);
            await sql`UPDATE playlist_items SET added_at = ${new Date(now - (movies.length - i) * 60_000)} WHERE playlist_id = ${watchlistId} AND media_id = ${movies[i].id}::uuid`;
        }

        const collected = await walkAllItems(watchlistId, user, 2);

        // No duplicates across the walk.
        expect(collected).toHaveLength(new Set(collected).size);
        // Every item reached exactly once, newest-first.
        expect(collected).toEqual(
            [movies[4], movies[3], movies[2], movies[1], movies[0]].map((m) => m.id),
        );
    });

    // N6 (2026-09-22 edge-case pass): `playlist_items.added_at` is nullable
    // (DEFAULT now(), no NOT NULL), and Postgres's default for `DESC` is
    // `NULLS FIRST` — so a NULL-added_at row would sort ahead of every real
    // timestamp instead of landing at the bottom where "we don't know when
    // this was added" belongs.
    it('a NULL added_at row sorts LAST, not first, on the watchlist', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const watchlistId = await ensureWatchlistPlaylist(sql, userId);
        const user = fullUser({ userId, username: owner.username });

        const movieA = await createAndInsertTestMovie(sql, { withFileItem: true, tmdbId: 920600 });
        const movieB = await createAndInsertTestMovie(sql, { withFileItem: true, tmdbId: 920601 });

        await upsertWatchlistItem(sql, userId, movieA.id);
        await upsertWatchlistItem(sql, userId, movieB.id);

        // B has a real, recent timestamp; A's is wiped to NULL.
        await sql`UPDATE playlist_items SET added_at = NULL WHERE playlist_id = ${watchlistId} AND media_id = ${movieA.id}::uuid`;

        const body = await getItemsPage(watchlistId, user, { limit: 200 });

        expect(body.items.map((i) => i.mediaId)).toEqual([movieB.id, movieA.id]);
    });

    // N5 (2026-09-22 edge-case pass): the bootstrap cursor is already
    // suppressed for a non-position-sorted playlist (see the walk above,
    // which never receives one) — but nothing stopped a caller from
    // hand-crafting a `?cursor=` value themselves. Cursor mode always pages
    // `(position ASC, id ASC)` regardless of `sort`, so a hand-crafted cursor
    // on the watchlist silently switched the SAME endpoint to a different
    // ordering than its own offset-mode response used.
    it('rejects a hand-crafted ?cursor= on the watchlist (added_at-sorted playlist)', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const watchlistId = await ensureWatchlistPlaylist(sql, userId);
        const user = fullUser({ userId, username: owner.username });

        const movie = await createAndInsertTestMovie(sql, { withFileItem: true, tmdbId: 920500 });
        await upsertWatchlistItem(sql, userId, movie.id);

        // The sort check runs BEFORE cursor decoding, so any non-empty
        // cursor param must be rejected — it never even needs to be
        // well-formed to prove the guard fires first.
        const url = new URL(`http://localhost/api/playlists/${watchlistId}/items`);
        url.searchParams.set('limit', '10');
        url.searchParams.set('cursor', 'anything');
        const event = buildGetEvent(watchlistId, user, url);

        const res = await itemsDef.handlers.GET!(event, ctx);
        expect(res.status).toBe(422);
    });

    it('an ordinary (non-watchlist) playlist still pages by position in both modes', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const user = fullUser({ userId, username: owner.username });
        const playlist = await createPlaylist(sql, userId, 'Ordinary', null, 'private', 'general');

        const movies = [];
        for (let i = 0; i < 5; i++) {
            movies.push(
                await createAndInsertTestMovie(sql, { withFileItem: true, tmdbId: 920400 + i }),
            );
        }
        for (let i = 0; i < movies.length; i++) {
            const inserted = await insertPlaylistItem(sql, {
                playlistId: playlist.id,
                mediaId: movies[i].id,
                seasonNumber: null,
                episodeNumber: null,
                title: `Ordinary item ${i}`,
                seriesName: null,
                overview: null,
                posterPath: null,
                position: i,
            });
            expect(inserted).not.toBeNull();
        }

        const collected = await walkAllItems(playlist.id, user, 2);

        expect(collected).toHaveLength(new Set(collected).size);
        expect(collected).toEqual(movies.map((m) => m.id));
    });
});
