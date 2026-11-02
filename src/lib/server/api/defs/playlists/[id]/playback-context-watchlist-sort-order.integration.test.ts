// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-Postgres coverage for final-review Minor 1: `playback-context.ts`
 * called `getPlaylistItems` without the `sort` argument, so it always
 * defaulted to `position` — serving the watchlist oldest-first while
 * `GET /playlists/{id}/items` (see `watchlist-sort-order.integration.test.ts`)
 * serves it newest-first. Same playlist, two different orders depending
 * which endpoint the player asked. This proves both surfaces now agree.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import type { UserContext } from '$lib/server/types.js';
import { getTestDb } from '../../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../../tests/integration/helpers/cleanup.js';
import { createTestUser } from '../../../../../../../tests/integration/helpers/users.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestMusicHierarchy,
} from '../../../../../../../tests/integration/fixtures/index.js';
import { createPlaylist } from '$lib/server/database/queries/playlists.queries.js';
import { toUserId } from '$lib/shared/user-id';
import { ensureWatchlistPlaylist } from '$lib/server/database/queries/watchlist-playlist.queries.js';
import { upsertWatchlistItem } from '$lib/server/database/queries/watchlist.queries.js';
import type postgres from 'postgres';

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    const { getTestDb: getSql } =
        await import('../../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

const { def: playbackContextDef } = await import('./playback-context.js');

const ctx: ApiContext = { surface: 'internal' };

function fullUser(overrides: Partial<UserContext> = {}): UserContext {
    return {
        userId: toUserId('00000000-0000-0000-0000-000000000000'),
        username: 'playback-context-sort-order-test',
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

function buildEvent(playlistId: number, user: UserContext, url: URL): RequestEvent {
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

describe('GET /playlists/{id}/playback-context — watchlist newest-first ordering', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
    });

    it('serves the watchlist newest-first, matching GET /playlists/{id}/items', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const watchlistId = await ensureWatchlistPlaylist(sql, userId);
        const user = fullUser({ userId, username: owner.username });

        const movieA = await createAndInsertTestMovie(sql, { withFileItem: true, tmdbId: 920501 });
        const movieB = await createAndInsertTestMovie(sql, { withFileItem: true, tmdbId: 920502 });
        const movieC = await createAndInsertTestMovie(sql, { withFileItem: true, tmdbId: 920503 });

        await upsertWatchlistItem(sql, userId, movieA.id);
        await upsertWatchlistItem(sql, userId, movieB.id);
        await upsertWatchlistItem(sql, userId, movieC.id);

        // A oldest, C newest — deterministic added_at, not insert-order timing.
        const now = Date.now();
        await sql`UPDATE playlist_items SET added_at = ${new Date(now - 3 * 60_000)} WHERE playlist_id = ${watchlistId} AND media_id = ${movieA.id}::uuid`;
        await sql`UPDATE playlist_items SET added_at = ${new Date(now - 2 * 60_000)} WHERE playlist_id = ${watchlistId} AND media_id = ${movieB.id}::uuid`;
        await sql`UPDATE playlist_items SET added_at = ${new Date(now - 1 * 60_000)} WHERE playlist_id = ${watchlistId} AND media_id = ${movieC.id}::uuid`;

        const url = new URL(`http://localhost/api/playlists/${watchlistId}/playback-context`);
        url.searchParams.set('mediaId', movieC.id);
        const res = await playbackContextDef.handlers.GET!(buildEvent(watchlistId, user, url), ctx);

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            current: { mediaId: string };
            next: { mediaId: string };
            previous: { mediaId: string } | null;
        };

        // Newest-first: C, B, A. Before the fix this was oldest-first (A, B, C)
        // because getPlaylistItems was called without the kind policy's sort.
        expect(body.current.mediaId).toBe(movieC.id);
        expect(body.next.mediaId).toBe(movieB.id);
        expect(body.previous).toBeNull();
    });
    it('skips songs in both directions and preserves their slots in a mixed playlist', async () => {
        const owner = await createTestUser(sql);
        const userId = toUserId(owner.id);
        const user = fullUser({ userId, username: owner.username });
        const playlist = await createPlaylist(sql, userId, 'Mixed', null, 'private');
        const first = await createAndInsertTestMovie(sql, { withFileItem: true, tmdbId: 920601 });
        const last = await createAndInsertTestMovie(sql, { withFileItem: true, tmdbId: 920602 });
        const music = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
        for (const [position, mediaId] of [first.id, music.trackIds[0], last.id].entries()) {
            await sql`INSERT INTO playlist_items (playlist_id, media_id, title, position) VALUES (${playlist.id}, ${mediaId}::uuid, ${`Entry ${position}`}, ${position})`;
        }
        const readAt = async (position: number) => {
            const url = new URL(
                `http://localhost/api/playlists/${playlist.id}/playback-context?position=${position}`,
            );
            const response = await playbackContextDef.handlers.GET!(
                buildEvent(playlist.id, user, url),
                ctx,
            );
            expect(response.status).toBe(200);
            return response.json();
        };
        const start = await readAt(0);
        expect(start.next).toMatchObject({ mediaId: last.id, position: 2 });
        expect(start.previous).toBeNull();
        expect(start).not.toHaveProperty('items');
        const end = await readAt(2);
        expect(end.previous).toMatchObject({ mediaId: first.id, position: 0 });
        expect(end.next).toBeNull();
    });
});
