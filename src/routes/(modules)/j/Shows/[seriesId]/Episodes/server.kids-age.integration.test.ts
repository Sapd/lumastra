// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /j/Shows/{seriesId}/Episodes for an age-limited profile (cloud-parity
 * brief 13). Episode rows carry no `age_rating`; the series' rating decides.
 * A kid profile (max 12, unrated hidden) used to get a 200 with an empty
 * `Items` array and `TotalRecordCount: 0` for a series rated 6 whose card
 * said "3 unplayed". An 18-rated series stays a uniform 404.
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

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, config: { ...actual.config, UNRATED_CONTENT_VISIBLE: false } };
});

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

function kidEvent(
    seriesId: string,
    query = '',
): RequestEvent<{ seriesId: string }, '/(modules)/j/Shows/[seriesId]/Episodes'> {
    const href = `http://localhost/j/Shows/${seriesId}/Episodes${query}`;
    return {
        url: new URL(href),
        request: new Request(href),
        locals: {
            user: {
                username: 'route-kids-age-test',
                userId: toUserId(randomUUID()),
                groups: '',
                userGroups: ['kids'],
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                ownerIsAdmin: false,
                maxAgeRating: 12,
                isAgeRestricted: true,
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

describe.runIf(RUN)('GET /j/Shows/{seriesId}/Episodes for an age-limited profile', () => {
    let sql: postgres.Sql;
    const mediaIds: string[] = [];
    const fileIds: string[] = [];
    let deniedGroupId: string | undefined;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
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
        await closeTestDb();
    });

    /**
     * Series rated `ageRating` with file-backed episodes whose own rating is
     * NULL; `groups[i]` is the library group of episode i's file.
     */
    async function seed(
        ageRating: number,
        groups: (string | null)[] = [null, null],
    ): Promise<{ seriesId: string; episodeIds: string[] }> {
        const seriesId = randomUUID();
        const seasonId = randomUUID();
        const episodeIds = groups.map(() => randomUUID());
        mediaIds.push(seriesId, seasonId, ...episodeIds);
        await sql`INSERT INTO media_items (id, title, media_type, status, age_rating)
                  VALUES (${seriesId}::uuid, ${`Series ${ageRating}`}, 'tv', 'active', ${ageRating})`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number)
                  VALUES (${seasonId}::uuid, 'Season 1', 'season', ${seriesId}::uuid, 'active', 1)`;
        for (const [i, id] of episodeIds.entries()) {
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number,
                                               episode_number, has_files)
                      VALUES (${id}::uuid, ${`Ep ${i + 1}`}, 'episode', ${seasonId}::uuid, 'active', 1,
                              ${i + 1}, true)`;
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
                VALUES (${`/test/kids-age/${id}.mkv`}, ${groups[i]}, NOW(), NOW()) RETURNING id`;
            fileIds.push(file.id);
            await sql`INSERT INTO media_file_items (file_id, media_item_id)
                      VALUES (${file.id}::uuid, ${id}::uuid)`;
        }
        return { seriesId, episodeIds };
    }

    it('lists the episodes of a within-limit series, with a matching TotalRecordCount', async () => {
        const kids = await seed(6);
        const { GET } = await import('./+server.js');

        const resp = await GET(kidEvent(kids.seriesId));
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { Items: { Id: string }[]; TotalRecordCount: number };
        expect(body.Items.map((i) => i.Id)).toEqual(kids.episodeIds);
        expect(body.TotalRecordCount).toBe(2);
    });

    it('startItemId indexes the episodes the caller can see', async () => {
        deniedGroupId = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'Kids-age adults only')`;
        await upsertLibraryGroupPermission(sql, {
            libraryGroupId: deniedGroupId,
            allowedGroups: ['adults'],
        });
        invalidateLibraryGroupPermissionsCache();
        // Episode 1's file is in a group the kid cannot see.
        const kids = await seed(6, [deniedGroupId, null, null]);
        const { GET } = await import('./+server.js');

        const resp = await GET(kidEvent(kids.seriesId, `?startItemId=${kids.episodeIds[2]}`));
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { Items: { Id: string }[]; TotalRecordCount: number };
        expect(body.Items.map((i) => i.Id)).toEqual([kids.episodeIds[2]]);
        expect(body.TotalRecordCount).toBe(2);
    });

    it('startItemId is positioned within the requested Season', async () => {
        const seriesId = randomUUID();
        const seasonIds = [randomUUID(), randomUUID()];
        const episodeIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        mediaIds.push(seriesId, ...seasonIds, ...episodeIds);
        await sql`INSERT INTO media_items (id, title, media_type, status, age_rating)
                  VALUES (${seriesId}::uuid, 'Two seasons', 'tv', 'active', 6)`;
        for (const [i, id] of seasonIds.entries()) {
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number)
                      VALUES (${id}::uuid, ${`Season ${i + 1}`}, 'season', ${seriesId}::uuid, 'active', ${i + 1})`;
        }
        for (const [i, id] of episodeIds.entries()) {
            const season = Math.floor(i / 2);
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number,
                                               episode_number, has_files)
                      VALUES (${id}::uuid, ${`Ep ${i}`}, 'episode', ${seasonIds[season]}::uuid, 'active',
                              ${season + 1}, ${(i % 2) + 1}, true)`;
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, created_at, updated_at)
                VALUES (${`/test/kids-age/${id}.mkv`}, NOW(), NOW()) RETURNING id`;
            fileIds.push(file.id);
            await sql`INSERT INTO media_file_items (file_id, media_item_id)
                      VALUES (${file.id}::uuid, ${id}::uuid)`;
        }
        const { GET } = await import('./+server.js');

        const resp = await GET(kidEvent(seriesId, `?Season=2&startItemId=${episodeIds[3]}`));
        expect(resp.status).toBe(200);
        const body = (await resp.json()) as { Items: { Id: string }[]; TotalRecordCount: number };
        // Index 1 within season 2, not 3 across the whole show.
        expect(body.Items.map((i) => i.Id)).toEqual([episodeIds[3]]);
        expect(body.TotalRecordCount).toBe(2);
    });

    it('404s a series above the limit, like an unknown id', async () => {
        const adult = await seed(18);
        const { GET } = await import('./+server.js');

        const unknown = await GET(kidEvent(randomUUID()));
        const denied = await GET(kidEvent(adult.seriesId));
        expect(denied.status).toBe(404);
        expect(await denied.text()).toBe(await unknown.text());
    });
});
