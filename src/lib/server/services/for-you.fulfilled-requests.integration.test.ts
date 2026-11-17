// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * fetchFulfilledRequests — the "Your requests are ready" rail drops titles the
 * user has already watched. A movie marked watched without a completed play
 * (manual "Mark as watched", Jellyfin sync) only sets
 * `user_media_state.is_watched`; it has no `watch_history` row and used to stay
 * on the rail for good.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import { derivedUsername } from '../../../../tests/integration/fixtures/user.fixtures.js';
import { unrestrictedAccess } from '../database/queries/builders/media-access-boundary.js';

const fulfilled = vi.hoisted(() => ({ tmdbIds: [] as number[] }));
vi.mock('$lib/server/jellyseerr.js', () => ({
    jellyseerrClient: {
        getFulfilledRequestsForUser: async () =>
            fulfilled.tmdbIds.map((tmdbId, i) => ({ id: i + 1, type: 'movie', media: { tmdbId } })),
        getMediaByTmdbId: async (tmdbId: number) => ({ title: `Movie ${tmdbId}` }),
    },
}));

const { fetchFulfilledRequests } = await import('./for-you.service.js');

describe('fetchFulfilledRequests watched filter', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
    });

    it('drops a movie marked watched in user_media_state and keeps an unwatched one', async () => {
        const userId = randomUUID();
        await ensureTestUser(sql, userId);
        const watched = await createAndInsertTestMovie(sql, { tmdbId: 910001, withFileItem: true });
        const unwatched = await createAndInsertTestMovie(sql, {
            tmdbId: 910002,
            withFileItem: true,
        });
        fulfilled.tmdbIds = [watched.tmdbId, unwatched.tmdbId];

        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched)
            VALUES (${userId}::uuid, ${watched.id}::uuid, true)
        `;

        const rows = await fetchFulfilledRequests(
            sql,
            derivedUsername(userId),
            {},
            unrestrictedAccess(),
        );
        const tmdbIds = rows.map((r) => String((r.externalIds as Record<string, unknown>).tmdb));
        expect(tmdbIds).toEqual([String(unwatched.tmdbId)]);
    });

    it('keeps a movie whose watched flag is false', async () => {
        const userId = randomUUID();
        await ensureTestUser(sql, userId);
        const movie = await createAndInsertTestMovie(sql, { tmdbId: 910003, withFileItem: true });
        fulfilled.tmdbIds = [movie.tmdbId];

        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched)
            VALUES (${userId}::uuid, ${movie.id}::uuid, false)
        `;

        const rows = await fetchFulfilledRequests(
            sql,
            derivedUsername(userId),
            {},
            unrestrictedAccess(),
        );
        expect(rows).toHaveLength(1);
    });
});
