// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route-level integration test for GET /series/{id}/seasons on BOTH mounts
 * (internal `/api/series/{id}/seasons` and public `/api/v1/series/{id}/seasons`)
 * (C8, task 4 fix round 1).
 *
 * The first fix round's coverage for this def was query-level only
 * (`getSeasonsByInternalId` called directly) plus a fully-mocked unit test
 * (`seasons.test.ts`) that mocks BOTH `search-access-context.js` (the
 * boundary derivation) AND `season-detail.queries.js` (the query itself) — a
 * regression that hands `getSeasonsByInternalId` an `unrestrictedAccess()`
 * boundary instead of the real derived one would stay green in every test
 * that existed before this file. This test mocks only `getDb` (pointed at the
 * real test database) and the logger, so `buildSearchAccessContext` /
 * `searchAccessBoundary` and the query itself all run for real, on both
 * mounted `+server.ts` files.
 */

import type { RequestEvent } from '@sveltejs/kit';
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

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    },
}));

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    const { getTestDb: getSql } =
        await import('../../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

interface SeasonNodeDto {
    id: string;
    seasonNumber: number;
}

function buildEvent(
    seriesId: string,
    userGroups: string[],
    routeId: string,
): RequestEvent<{ id: string }, never> {
    const url = new URL(`http://localhost/api/series/${seriesId}/seasons`);
    return {
        url,
        request: new Request(url),
        locals: {
            user: {
                username: `route-c8-v1-${randomUUID().slice(0, 8)}`,
                userId: toUserId(randomUUID()),
                groups: '',
                userGroups,
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                ownerIsAdmin: false,
                maxAgeRating: null,
                isAgeRestricted: false,
                isModerator: false,
                liveTvPriority: 'low',
            },
        },
        params: { id: seriesId },
        route: { id: routeId },
        cookies: {} as never,
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
        depends: () => undefined,
        untrack: <T>(fn: () => T) => fn(),
    } as unknown as RequestEvent<{ id: string }, never>;
}

describe.runIf(RUN)('GET /series/{id}/seasons (route-level, C8, both mounts)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    async function seedMixedGroupSeries(): Promise<{
        seriesId: string;
        season1Id: string;
        season2Id: string;
        deniedGroupId: string;
        cleanup: () => Promise<void>;
    }> {
        const seriesId = randomUUID();
        const season1Id = randomUUID();
        const season2Id = randomUUID();
        const ep1Id = randomUUID();
        const ep2Id = randomUUID();
        const deniedGroupId = randomUUID();

        await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'Route C8 v1 Denied Group')`;
        await upsertLibraryGroupPermission(sql, {
            libraryGroupId: deniedGroupId,
            allowedGroups: ['adults'],
        });
        invalidateLibraryGroupPermissionsCache();

        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status) VALUES (${seriesId}::uuid, 'Route C8 v1 Series', 'tv', NULL, 'active')`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number) VALUES (${season1Id}::uuid, 'Season 1', 'season', ${seriesId}::uuid, 'active', 1)`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number) VALUES (${season2Id}::uuid, 'Season 2', 'season', ${seriesId}::uuid, 'active', 2)`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${ep1Id}::uuid, 'Ep 1', 'episode', ${season1Id}::uuid, 'active', 1, 1)`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${ep2Id}::uuid, 'Ep 2', 'episode', ${season2Id}::uuid, 'active', 2, 1)`;

        const [allowedFile] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, created_at, updated_at)
            VALUES (${'/test/route-c8-v1/s01e01.mkv'}, NOW(), NOW()) RETURNING id
        `;
        const [deniedFile] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
            VALUES (${'/test/route-c8-v1/s02e01.mkv'}, ${deniedGroupId}::uuid, NOW(), NOW()) RETURNING id
        `;
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${allowedFile.id}::uuid, ${ep1Id}::uuid)`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${deniedFile.id}::uuid, ${ep2Id}::uuid)`;
        await sql`UPDATE media_items SET has_files = true WHERE id = ANY(${[seriesId, season1Id, season2Id, ep1Id, ep2Id]}::uuid[])`;

        return {
            seriesId,
            season1Id,
            season2Id,
            deniedGroupId,
            cleanup: async () => {
                await sql`DELETE FROM media_items WHERE id = ANY(${[seriesId, season1Id, season2Id, ep1Id, ep2Id]}::uuid[])`;
                await sql`DELETE FROM media_files WHERE id = ANY(${[allowedFile.id, deniedFile.id]}::uuid[])`;
                await deleteLibraryGroupPermission(sql, deniedGroupId);
                await sql`DELETE FROM library_groups WHERE id = ${deniedGroupId}::uuid`;
                invalidateLibraryGroupPermissionsCache();
            },
        };
    }

    it('GET /api/series/{id}/seasons (internal mount) excludes the denied season', async () => {
        const { seriesId, season1Id, season2Id, cleanup } = await seedMixedGroupSeries();
        try {
            const { GET } =
                await import('../../../../../../routes/api/series/[id]/seasons/+server.js');
            if (!GET) throw new Error('GET handler is not defined');

            const restricted = await GET(
                buildEvent(seriesId, ['kids'], '/api/series/[id]/seasons'),
            );
            expect(restricted.status).toBe(200);
            const restrictedBody = (await restricted.json()) as { items: SeasonNodeDto[] };
            expect(restrictedBody.items.map((s) => s.id)).toEqual([season1Id]);

            const open = await GET(buildEvent(seriesId, ['adults'], '/api/series/[id]/seasons'));
            const openBody = (await open.json()) as { items: SeasonNodeDto[] };
            expect(openBody.items.map((s) => s.id).sort()).toEqual([season1Id, season2Id].sort());
        } finally {
            await cleanup();
        }
    });

    it('lists only seasons that have an episode with a file', async () => {
        const seriesId = randomUUID();
        const withFilesId = randomUUID();
        const withoutFilesId = randomUUID();
        const ep1Id = randomUUID();
        const ep2Id = randomUUID();
        const ids = [seriesId, withFilesId, withoutFilesId, ep1Id, ep2Id];
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status) VALUES (${seriesId}::uuid, 'Fileless Season Series', 'tv', NULL, 'active')`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number) VALUES (${withFilesId}::uuid, 'Season 1', 'season', ${seriesId}::uuid, 'active', 1)`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number) VALUES (${withoutFilesId}::uuid, 'Season 2', 'season', ${seriesId}::uuid, 'active', 2)`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${ep1Id}::uuid, 'Ep 1', 'episode', ${withFilesId}::uuid, 'active', 1, 1)`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${ep2Id}::uuid, 'Ep 1', 'episode', ${withoutFilesId}::uuid, 'active', 2, 1)`;
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, created_at, updated_at)
            VALUES (${`/test/fileless-season/${seriesId}/s01e01.mkv`}, NOW(), NOW()) RETURNING id
        `;
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file.id}::uuid, ${ep1Id}::uuid)`;
        await sql`UPDATE media_items SET has_files = true WHERE id = ANY(${[seriesId, withFilesId, ep1Id]}::uuid[])`;
        try {
            const { GET } =
                await import('../../../../../../routes/api/series/[id]/seasons/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(buildEvent(seriesId, ['adults'], '/api/series/[id]/seasons'));
            expect(res.status).toBe(200);
            const body = (await res.json()) as {
                items: SeasonNodeDto[];
                page: { total: number };
            };
            expect(body.items.map((s) => s.id)).toEqual([withFilesId]);
            expect(body.page.total).toBe(1);
        } finally {
            await sql`DELETE FROM media_items WHERE id = ANY(${ids}::uuid[])`;
            await sql`DELETE FROM media_files WHERE id = ${file.id}::uuid`;
        }
    });

    it('GET /api/v1/series/{id}/seasons (public mount) excludes the denied season', async () => {
        const { seriesId, season1Id, season2Id, cleanup } = await seedMixedGroupSeries();
        try {
            const { GET } =
                await import('../../../../../../routes/api/v1/series/[id]/seasons/+server.js');
            if (!GET) throw new Error('GET handler is not defined');

            const restricted = await GET(
                buildEvent(seriesId, ['kids'], '/api/v1/series/[id]/seasons'),
            );
            expect(restricted.status).toBe(200);
            const restrictedBody = (await restricted.json()) as { items: SeasonNodeDto[] };
            expect(restrictedBody.items.map((s) => s.id)).toEqual([season1Id]);

            const open = await GET(buildEvent(seriesId, ['adults'], '/api/v1/series/[id]/seasons'));
            const openBody = (await open.json()) as { items: SeasonNodeDto[] };
            expect(openBody.items.map((s) => s.id).sort()).toEqual([season1Id, season2Id].sort());
        } finally {
            await cleanup();
        }
    });
});
