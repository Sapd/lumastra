// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Real-Postgres coverage for Important 3 of the final watchlist-as-system-
 * playlist review: this route calls `upsertWatchlistItem` directly with an
 * arbitrary caller-supplied media UUID, gated only by `checkMediaAccess`
 * (existence + visibility, NOT media type). Before this fix, favoriting an
 * episode via a Jellyfin client silently wrote it onto the watchlist
 * playlist — which now renders it in the pinned Watchlist card. This proves
 * the fix end-to-end through the real route handler and a real DB: an
 * episode is rejected with a clean 4xx and creates no playlist_items row; a
 * movie still succeeds exactly as before.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../../../../tests/integration/helpers/users.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../../../../tests/integration/fixtures/index.js';

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database')>();
    const { getTestDb: getSql } =
        await import('../../../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

vi.mock('$lib/server/cache', () => ({
    cacheInvalidation: {
        onWatchlistChange: vi.fn().mockResolvedValue(undefined),
    },
}));

const { POST } = await import('./+server.js');

function buildEvent(itemId: string, userId: string, username: string): RequestEvent {
    return {
        params: { itemId, userId },
        locals: {
            user: {
                userId,
                username,
                hasLiveTvPermission: false,
                ownerIsAdmin: true, // short-circuits the library-access check — not what this test is about
                userGroups: [],
                isAgeRestricted: false,
                maxAgeRating: null,
            },
        },
    } as unknown as RequestEvent;
}

describe('/j/Users/{userId}/FavoriteItems/{itemId} — watchlist kind-policy enforcement', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    it('rejects favoriting an episode with a clean 4xx and writes no playlist_items row', async () => {
        const user = await createTestUser(sql);
        const episode = createTestMediaItem({ media_type: 'episode', has_files: true });
        const episodeId = await insertTestMediaItem(sql, episode);

        const res = await (POST as (event: RequestEvent) => Promise<Response>)(
            buildEvent(episodeId, user.id, user.username),
        );

        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);

        const rows = await sql<{ id: number }[]>`
            SELECT pi.id FROM playlist_items pi
            JOIN playlists p ON p.id = pi.playlist_id
            WHERE p.user_id = ${user.id}::uuid AND p.is_system = true AND pi.media_id = ${episodeId}::uuid
        `;
        expect(rows).toHaveLength(0);
    });

    // N8 (2026-09-22 edge-case pass): before this fix, a non-existent
    // media_items id (e.g. a Live TV / EPG program GUID, which
    // `checkMediaAccess` does not reject) reached a dead `23503` FK-violation
    // catch branch — dead because `upsertWatchlistItem`'s INSERT is
    // `INSERT ... SELECT FROM media_items WHERE id = ...`, which can never
    // violate a foreign key; it just selects zero rows. Proves the no-op
    // behaviour survives on the success path instead: no throw, 200,
    // IsFavorite: true, and no playlist_items row is created.
    it('acknowledges a non-media id (e.g. an EPG program) as a no-op, not an error', async () => {
        const user = await createTestUser(sql);
        const nonMediaId = '00000000-0000-4000-8000-000000000001'; // not in media_items

        const res = await (POST as (event: RequestEvent) => Promise<Response>)(
            buildEvent(nonMediaId, user.id, user.username),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { IsFavorite?: boolean };
        expect(body.IsFavorite).toBe(true);

        const rows = await sql<{ id: number }[]>`
            SELECT pi.id FROM playlist_items pi
            JOIN playlists p ON p.id = pi.playlist_id
            WHERE p.user_id = ${user.id}::uuid AND p.is_system = true AND pi.media_id = ${nonMediaId}::uuid
        `;
        expect(rows).toHaveLength(0);
    });

    it('still favorites a movie onto the watchlist', async () => {
        const user = await createTestUser(sql);
        const movie = createTestMediaItem({ media_type: 'movie', has_files: true });
        const movieId = await insertTestMediaItem(sql, movie);

        const res = await (POST as (event: RequestEvent) => Promise<Response>)(
            buildEvent(movieId, user.id, user.username),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { IsFavorite?: boolean };
        expect(body.IsFavorite).toBe(true);

        const rows = await sql<{ id: number }[]>`
            SELECT pi.id FROM playlist_items pi
            JOIN playlists p ON p.id = pi.playlist_id
            WHERE p.user_id = ${user.id}::uuid AND p.is_system = true AND pi.media_id = ${movieId}::uuid
        `;
        expect(rows).toHaveLength(1);
    });
});
