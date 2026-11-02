// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for C14 (2026-09-18 fix plan 4 task 6) — GET
 * /api/for-you/similar's UUID-form seed resolution (`resolveUuidToProvider`)
 * had no library/age gate: a caller holding an out-of-band UUID for an item
 * they're denied could confirm it exists and learn its TMDB id and media
 * type, even though the "similar" RESULTS list was correctly access-scoped.
 * The fix adds a `checkMediaAccess` gate right after resolution, before any
 * of that data reaches the response, 404ing with the exact same body as an
 * unresolvable UUID.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createTestExternalIds,
    insertTestExternalIds,
} from '../../../../../../tests/integration/fixtures/index.js';
import {
    ensureTestUser,
    derivedUsername,
    generateTestUserId,
} from '../../../../../../tests/integration/fixtures/user.fixtures.js';
import {
    upsertLibraryGroupPermission,
    deleteLibraryGroupPermission,
} from '$lib/server/database/queries/library-group-permissions.queries.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

function buildLocalsUser(username: string, userGroups: string[]): RequestEvent['locals']['user'] {
    return {
        username,
        userId: undefined as never, // set per-call below via generateTestUserId; see toUserId cast
        groups: '',
        userGroups,
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        isAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

describe.runIf(RUN)('GET /api/for-you/similar — UUID seed access gate (C14)', () => {
    let sql: postgres.Sql;
    let deniedGroupId: string;
    const mediaIds: string[] = [];
    const fileIds: string[] = [];

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await closeTestDb();
    });

    async function cleanup(): Promise<void> {
        if (fileIds.length > 0) {
            await sql`DELETE FROM media_files WHERE id = ANY(${fileIds}::uuid[])`;
            fileIds.length = 0;
        }
        if (mediaIds.length > 0) {
            await sql`DELETE FROM media_items WHERE id = ANY(${mediaIds}::uuid[])`;
            mediaIds.length = 0;
        }
        if (deniedGroupId) {
            await deleteLibraryGroupPermission(sql, deniedGroupId);
            await sql`DELETE FROM library_groups WHERE id = ${deniedGroupId}::uuid`;
        }
        invalidateLibraryGroupPermissionsCache();
    }

    it('a denied seed UUID gets the byte-identical 404 an unresolvable UUID gets, and an allowed one passes the gate', async () => {
        const movieId = randomUUID();
        mediaIds.push(movieId);
        deniedGroupId = randomUUID();
        const userId = generateTestUserId();
        const username = derivedUsername(userId);

        try {
            await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'Route C14 Denied Group')`;
            await upsertLibraryGroupPermission(sql, {
                libraryGroupId: deniedGroupId,
                allowedGroups: ['adults'],
            });
            invalidateLibraryGroupPermissionsCache();
            await ensureTestUser(sql, userId);

            await insertTestMediaItem(
                sql,
                createTestMediaItem({ id: movieId, title: 'Route C14 Movie', media_type: 'movie' }),
            );
            await insertTestExternalIds(
                sql,
                createTestExternalIds(movieId, { tmdbId: 990321, mediaType: 'movie' }),
            );
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
                VALUES (${'/test/route-c14/movie.mkv'}, ${deniedGroupId}::uuid, NOW(), NOW()) RETURNING id
            `;
            fileIds.push(file.id);
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file.id}::uuid, ${movieId}::uuid)`;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movieId}::uuid`;

            const { def } = await import('./similar.js');
            const GET = def.handlers.GET!;

            function makeEvent(key: string, userGroups: string[]): RequestEvent {
                const url = new URL(`http://localhost/api/for-you/similar?key=${key}`);
                return {
                    url,
                    request: new Request(url),
                    locals: { user: { ...buildLocalsUser(username, userGroups), userId } },
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any;
            }

            // Unresolvable UUID — the baseline "not found" shape.
            const unknownId = randomUUID();
            const unknownResp = await GET(makeEvent(unknownId, ['kids']), {} as never);
            const unknownBody = await unknownResp.text();

            // Denied caller against a seed UUID that DOES resolve.
            const deniedResp = await GET(makeEvent(movieId, ['kids']), {} as never);
            const deniedBody = await deniedResp.text();

            expect(deniedResp.status).toBe(unknownResp.status);
            expect(deniedResp.status).toBe(404);
            expect(deniedBody).toBe(unknownBody);

            // Allowed caller — passes the gate (does not get the "Media not
            // found" 404 the denied/unknown cases get). What happens after the
            // gate depends on AI/embedding availability in this harness, which
            // this test does not assert on.
            const allowedResp = await GET(makeEvent(movieId, ['adults']), {} as never);
            expect(allowedResp.status).not.toBe(404);
        } finally {
            await cleanup();
        }
    });
});
