// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route-level integration test for GET /j/Shows/{seriesId}/Seasons (C8, task 4
 * fix round 1).
 *
 * The first fix round only had QUERY-level coverage (`getSeriesSeasons` called
 * directly with a hand-built `access` argument) — nothing asserted that the
 * ROUTE actually derives a restrictive boundary from `locals.user` rather than
 * a permissive one. `withJellyfinAuth` is bypassed via `vi.mock` (its own
 * behaviour is covered in middleware.test.ts) and `getDb` points at the real
 * test database, so the handler's own `buildJellyfinAccessContext(sql,
 * locals.user)` call runs for real end to end — a regression that hands the
 * query `unrestrictedAccess()` instead of the derived boundary would still be
 * caught here even though every mocked unit test stays green.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
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

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    // No-op wrapper so the route exports the inner handler directly — its own
    // behaviour is covered by middleware.test.ts.
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

interface JellyfinItemDto {
    Id: string;
    Name: string;
    ChildCount?: number;
    RecursiveItemCount?: number;
    UserData?: { UnplayedItemCount?: number; Played?: boolean };
}

function buildEvent(
    seriesId: string,
    user: {
        userGroups: string[];
        isAdmin?: boolean;
    },
    query = '',
): RequestEvent<{ seriesId: string }, '/(proprietary)/j/Shows/[seriesId]/Seasons'> {
    return {
        url: new URL(`http://localhost/j/Shows/${seriesId}/Seasons${query}`),
        request: new Request(`http://localhost/j/Shows/${seriesId}/Seasons`),
        locals: {
            user: {
                username: 'route-c8-test',
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
        route: { id: '/(proprietary)/j/Shows/[seriesId]/Seasons' },
        cookies: {} as never,
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
        depends: () => undefined,
        untrack: <T>(fn: () => T) => fn(),
    } as unknown as RequestEvent<{ seriesId: string }, '/(proprietary)/j/Shows/[seriesId]/Seasons'>;
}

describe.runIf(RUN)('GET /j/Shows/{seriesId}/Seasons (route-level, C8)', () => {
    let sql: postgres.Sql;
    const mediaIds: string[] = [];
    const fileIds: string[] = [];
    let deniedGroupId: string;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        mediaIds.length = 0;
        fileIds.length = 0;
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

    it('excludes a season whose only episode file is in a denied library group', async () => {
        const seriesId = randomUUID();
        const season1Id = randomUUID();
        const season2Id = randomUUID();
        const ep1Id = randomUUID();
        const ep2Id = randomUUID();
        mediaIds.push(seriesId, season1Id, season2Id, ep1Id, ep2Id);

        deniedGroupId = randomUUID();
        try {
            await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'Route C8 Denied Group')`;
            await upsertLibraryGroupPermission(sql, {
                libraryGroupId: deniedGroupId,
                allowedGroups: ['adults'],
            });
            invalidateLibraryGroupPermissionsCache();

            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status) VALUES (${seriesId}::uuid, 'Route C8 Series', 'tv', NULL, 'active')`;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number) VALUES (${season1Id}::uuid, 'Season 1', 'season', ${seriesId}::uuid, 'active', 1)`;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number) VALUES (${season2Id}::uuid, 'Season 2', 'season', ${seriesId}::uuid, 'active', 2)`;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${ep1Id}::uuid, 'Ep 1', 'episode', ${season1Id}::uuid, 'active', 1, 1)`;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${ep2Id}::uuid, 'Ep 2', 'episode', ${season2Id}::uuid, 'active', 2, 1)`;

            const [allowedFile] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, created_at, updated_at)
                VALUES (${'/test/route-c8/s01e01.mkv'}, NOW(), NOW()) RETURNING id
            `;
            const [deniedFile] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
                VALUES (${'/test/route-c8/s02e01.mkv'}, ${deniedGroupId}::uuid, NOW(), NOW()) RETURNING id
            `;
            fileIds.push(allowedFile.id, deniedFile.id);
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${allowedFile.id}::uuid, ${ep1Id}::uuid)`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${deniedFile.id}::uuid, ${ep2Id}::uuid)`;
            await sql`UPDATE media_items SET has_files = true WHERE id = ANY(${[seriesId, season1Id, season2Id, ep1Id, ep2Id]}::uuid[])`;

            const { GET } = await import('./+server.js');

            const restrictedResp = await GET(buildEvent(seriesId, { userGroups: ['kids'] }));
            expect(restrictedResp.status).toBe(200);
            const restrictedBody = (await restrictedResp.json()) as { Items: JellyfinItemDto[] };
            expect(restrictedBody.Items.map((i) => i.Id)).toEqual([season1Id]);

            const openResp = await GET(buildEvent(seriesId, { userGroups: ['adults'] }));
            const openBody = (await openResp.json()) as { Items: JellyfinItemDto[] };
            expect(openBody.Items.map((i) => i.Id).sort()).toEqual([season1Id, season2Id].sort());
        } finally {
            await cleanup();
        }
    });

    it('ChildCount never counts denied-library episodes, also with EnableUserData=false', async () => {
        const seriesId = randomUUID();
        const seasonId = randomUUID();
        const epOk = randomUUID();
        const epDenied = randomUUID();
        mediaIds.push(seriesId, seasonId, epOk, epDenied);
        deniedGroupId = randomUUID();
        try {
            await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'Route G2 Denied Group')`;
            await upsertLibraryGroupPermission(sql, {
                libraryGroupId: deniedGroupId,
                allowedGroups: ['adults'],
            });
            invalidateLibraryGroupPermissionsCache();
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status) VALUES (${seriesId}::uuid, 'Route G2 Series', 'tv', NULL, 'active')`;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number) VALUES (${seasonId}::uuid, 'Season 1', 'season', ${seriesId}::uuid, 'active', 1)`;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${epOk}::uuid, 'Ep 1', 'episode', ${seasonId}::uuid, 'active', 1, 1)`;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${epDenied}::uuid, 'Ep 2', 'episode', ${seasonId}::uuid, 'active', 1, 2)`;
            const [okFile] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, created_at, updated_at)
                VALUES (${'/test/route-g2/s01e01.mkv'}, NOW(), NOW()) RETURNING id`;
            const [deniedFile] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
                VALUES (${'/test/route-g2/s01e02.mkv'}, ${deniedGroupId}::uuid, NOW(), NOW()) RETURNING id`;
            fileIds.push(okFile.id, deniedFile.id);
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${okFile.id}::uuid, ${epOk}::uuid)`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${deniedFile.id}::uuid, ${epDenied}::uuid)`;
            await sql`UPDATE media_items SET has_files = true WHERE id = ANY(${[seriesId, seasonId, epOk, epDenied]}::uuid[])`;

            const { GET } = await import('./+server.js');
            for (const query of ['', '?EnableUserData=false']) {
                const kids = (await (
                    await GET(buildEvent(seriesId, { userGroups: ['kids'] }, query))
                ).json()) as { Items: JellyfinItemDto[] };
                expect(kids.Items[0], query).toMatchObject({
                    ChildCount: 1,
                    RecursiveItemCount: 1,
                });
                if (query === '') {
                    expect(kids.Items[0].UserData, query).toMatchObject({ UnplayedItemCount: 1 });
                } else {
                    // Jellyfin sends no UserData at all with EnableUserData=false.
                    expect(kids.Items[0].UserData, query).toBeUndefined();
                }
                const adults = (await (
                    await GET(buildEvent(seriesId, { userGroups: ['adults'] }, query))
                ).json()) as { Items: JellyfinItemDto[] };
                expect(adults.Items[0], query).toMatchObject({ ChildCount: 2 });
            }
        } finally {
            await cleanup();
        }
    });
});
