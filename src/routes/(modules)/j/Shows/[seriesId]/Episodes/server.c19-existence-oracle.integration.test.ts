// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route-level integration test for GET /j/Shows/{seriesId}/Episodes (C19,
 * 2026-09-18 fix plan 4 task 6).
 *
 * Unlike its sibling `Seasons/+server.ts` (which calls `checkMediaAccess`
 * before touching anything else and 404s uniformly on denial), this handler
 * had no access gate on the resolved series at all: a caller denied every
 * library group the series belongs to got a 200 with an empty `Items` array
 * — a response shape distinct from the 404 a nonexistent series id gets,
 * making the endpoint an existence oracle. The fix adds the same
 * `checkMediaAccess` gate `Seasons` already has, returning the byte-identical
 * 404 body for both a denied and a nonexistent series.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import {
    upsertLibraryGroupPermission,
    deleteLibraryGroupPermission,
} from '$lib/server/database/queries/library-group-permissions.queries.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';

vi.setConfig({ testTimeout: 30_000 });

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database')>();
    const { getTestDb: getSql } =
        await import('../../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

function buildEvent(
    seriesId: string,
    user: { userGroups: string[]; isAdmin?: boolean },
): RequestEvent<{ seriesId: string }, '/(modules)/j/Shows/[seriesId]/Episodes'> {
    return {
        url: new URL(`http://localhost/j/Shows/${seriesId}/Episodes`),
        request: new Request(`http://localhost/j/Shows/${seriesId}/Episodes`),
        locals: {
            user: {
                username: 'route-c19-test',
                userId: toUserId(randomUUID()),
                groups: '',
                userGroups: user.userGroups,
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                ownerIsAdmin: user.isAdmin ?? false,
                maxAgeRating: null,
                isAgeRestricted: false,
                isModerator: false,
                liveTvPriority: 'low',
            },
        },
        params: { seriesId },
        route: { id: '/(modules)/j/Shows/[seriesId]/Episodes' },
        cookies: {} as never,
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
        depends: () => undefined,
        untrack: <T>(fn: () => T) => fn(),
    } as unknown as RequestEvent<
        { seriesId: string },
        '/(modules)/j/Shows/[seriesId]/Episodes'
    >;
}

describe.runIf(RUN)('GET /j/Shows/{seriesId}/Episodes existence oracle (C19)', () => {
    let sql: postgres.Sql;
    const mediaIds: string[] = [];
    const fileIds: string[] = [];
    let deniedGroupId: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    async function cleanup(): Promise<void> {
        if (mediaIds.length > 0) {
            await sql`DELETE FROM media_items WHERE id = ANY(${mediaIds}::uuid[])`;
        }
        if (fileIds.length > 0) {
            await sql`DELETE FROM media_files WHERE id = ANY(${fileIds}::uuid[])`;
        }
        if (deniedGroupId) {
            await deleteLibraryGroupPermission(sql, deniedGroupId);
            await sql`DELETE FROM library_groups WHERE id = ${deniedGroupId}::uuid`;
        }
        invalidateLibraryGroupPermissionsCache();
    }

    it('returns a body/status byte-identical to an unknown series id for a fully-denied series, and real data when allowed', async () => {
        const seriesId = randomUUID();
        const seasonId = randomUUID();
        const episodeId = randomUUID();
        mediaIds.push(seriesId, seasonId, episodeId);

        deniedGroupId = randomUUID();
        try {
            await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'Route C19 Denied Group')`;
            await upsertLibraryGroupPermission(sql, {
                libraryGroupId: deniedGroupId,
                allowedGroups: ['adults'],
            });
            invalidateLibraryGroupPermissionsCache();

            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status) VALUES (${seriesId}::uuid, 'Route C19 Series', 'tv', NULL, 'active')`;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number) VALUES (${seasonId}::uuid, 'Season 1', 'season', ${seriesId}::uuid, 'active', 1)`;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${episodeId}::uuid, 'Ep 1', 'episode', ${seasonId}::uuid, 'active', 1, 1)`;

            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
                VALUES (${'/test/route-c19/s01e01.mkv'}, ${deniedGroupId}::uuid, NOW(), NOW()) RETURNING id
            `;
            fileIds.push(file.id);
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file.id}::uuid, ${episodeId}::uuid)`;
            await sql`UPDATE media_items SET has_files = true WHERE id = ANY(${[seriesId, seasonId, episodeId]}::uuid[])`;

            const { GET } = await import('./+server.js');

            // Nonexistent series id — the baseline "not found" shape.
            const unknownId = randomUUID();
            const unknownResp = await GET(buildEvent(unknownId, { userGroups: ['kids'] }));
            const unknownBody = await unknownResp.text();

            // Denied caller against a series that DOES exist but every episode's
            // file is in the one library group they're denied — the series has
            // no accessible descendant, so checkMediaAccess denies it entirely.
            const deniedResp = await GET(buildEvent(seriesId, { userGroups: ['kids'] }));
            const deniedBody = await deniedResp.text();

            expect(deniedResp.status).toBe(unknownResp.status);
            expect(deniedResp.status).toBe(404);
            expect(deniedBody).toBe(unknownBody);
            expect([...deniedResp.headers].sort()).toEqual([...unknownResp.headers].sort());

            // Allowed caller — real episode data still flows through.
            const allowedResp = await GET(buildEvent(seriesId, { userGroups: ['adults'] }));
            expect(allowedResp.status).toBe(200);
            const allowedBody = (await allowedResp.json()) as {
                Items: { Id: string }[];
                TotalRecordCount: number;
            };
            expect(allowedBody.Items.map((i) => i.Id)).toEqual([episodeId]);
            expect(allowedBody.TotalRecordCount).toBe(1);
        } finally {
            await cleanup();
        }
    });

    it('a wrong-type id (e.g. a movie) gets the same 404 an unknown id gets, not a distinguishing 400', async () => {
        // Review round 1 (2026-09-18 fix plan 4 task 6): the original fix only
        // collapsed "exists but denied" into "doesn't exist" — the third
        // outcome the finding named, "exists but is some other type," still
        // 400'd ('ID does not identify a series or season'), which is itself
        // an existence oracle independent of access: it reveals the id exists
        // at all, for ANY caller, regardless of whether they could access it
        // as its real type. Must collapse to the identical 404 too.
        const movieId = randomUUID();
        mediaIds.push(movieId);
        try {
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status) VALUES (${movieId}::uuid, 'Route C19 Movie', 'movie', NULL, 'active')`;

            const { GET } = await import('./+server.js');

            const unknownId = randomUUID();
            const unknownResp = await GET(buildEvent(unknownId, { userGroups: [] }));
            const unknownBody = await unknownResp.text();

            const wrongTypeResp = await GET(buildEvent(movieId, { userGroups: [] }));
            const wrongTypeBody = await wrongTypeResp.text();

            expect(wrongTypeResp.status).toBe(unknownResp.status);
            expect(wrongTypeResp.status).toBe(404);
            expect(wrongTypeBody).toBe(unknownBody);
            expect([...wrongTypeResp.headers].sort()).toEqual([...unknownResp.headers].sort());
        } finally {
            await cleanup();
        }
    });
});
