// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /j/Shows/{seriesId}/Episodes?AdjacentTo= (cloud-parity brief 09): the
 * previous, the given and the next episode, like Jellyfin's
 * FilterForAdjacency. Android TV, Streamyfin and Swiftfin use it for "next
 * episode" after playback; before, the parameter was ignored and they got the
 * whole season.
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

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
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

// Episodes in `virtualIds` come back without MediaSources ("Virtual").
const virtualIds = new Set<string>();
vi.mock(
    '$lib/server/proprietary/jellyfin-compat/media-source-enrichment',
    async (importOriginal) => {
        const actual =
            await importOriginal<
                typeof import('$lib/server/proprietary/jellyfin-compat/media-source-enrichment')
            >();
        return {
            ...actual,
            enrichItemsWithMediaSources: async (
                ...args: Parameters<typeof actual.enrichItemsWithMediaSources>
            ) => {
                await actual.enrichItemsWithMediaSources(...args);
                for (const item of args[1]) if (virtualIds.has(item.Id)) delete item.MediaSources;
            },
        };
    },
);

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

function kidEvent(
    seriesId: string,
    query = '',
): RequestEvent<{ seriesId: string }, '/(proprietary)/j/Shows/[seriesId]/Episodes'> {
    const href = `http://localhost/j/Shows/${seriesId}/Episodes${query}`;
    return {
        url: new URL(href),
        request: new Request(href),
        locals: {
            user: {
                username: 'route-adjacent-test',
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
        route: { id: '/(proprietary)/j/Shows/[seriesId]/Episodes' },
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
        '/(proprietary)/j/Shows/[seriesId]/Episodes'
    >;
}

describe.runIf(RUN)('GET /j/Shows/{seriesId}/Episodes?AdjacentTo=', () => {
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

    /** A series (rated 6) with one season; `groups[i]` is episode i's file library group. */
    async function seed(
        groups: (string | null)[],
    ): Promise<{ seriesId: string; seasonId: string; episodeIds: string[] }> {
        const seriesId = randomUUID();
        const seasonId = randomUUID();
        const episodeIds = groups.map(() => randomUUID());
        mediaIds.push(seriesId, seasonId, ...episodeIds);
        await sql`INSERT INTO media_items (id, title, media_type, status, age_rating)
                  VALUES (${seriesId}::uuid, 'Adjacent series', 'tv', 'active', 6)`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number)
                  VALUES (${seasonId}::uuid, 'Season 1', 'season', ${seriesId}::uuid, 'active', 1)`;
        for (const [i, id] of episodeIds.entries()) {
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number,
                                               episode_number, has_files)
                      VALUES (${id}::uuid, ${`Ep ${i + 1}`}, 'episode', ${seasonId}::uuid, 'active', 1,
                              ${i + 1}, true)`;
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
                VALUES (${`/test/adjacent/${id}.mkv`}, ${groups[i]}, NOW(), NOW()) RETURNING id`;
            fileIds.push(file.id);
            await sql`INSERT INTO media_file_items (file_id, media_item_id)
                      VALUES (${file.id}::uuid, ${id}::uuid)`;
        }
        return { seriesId, seasonId, episodeIds };
    }

    type Body = { Items: { Id: string }[]; TotalRecordCount: number; StartIndex: number };

    async function get(seriesId: string, query: string): Promise<{ status: number; body: Body }> {
        const { GET } = await import('./+server.js');
        const resp = await GET(kidEvent(seriesId, query));
        return {
            status: resp.status,
            body: resp.status === 200 ? ((await resp.json()) as Body) : (null as never),
        };
    }

    it('returns the previous, the given and the next episode', async () => {
        const s = await seed([null, null, null, null, null]);
        const { status, body } = await get(s.seriesId, `?AdjacentTo=${s.episodeIds[2]}`);
        expect(status).toBe(200);
        expect(body.Items.map((i) => i.Id)).toEqual(s.episodeIds.slice(1, 4));
        expect(body.TotalRecordCount).toBe(3);
        expect(body.StartIndex).toBe(0);
    });

    it('has no previous episode for the first and no next one for the last', async () => {
        const s = await seed([null, null, null]);
        const first = await get(s.seriesId, `?adjacentTo=${s.episodeIds[0]}`);
        expect(first.body.Items.map((i) => i.Id)).toEqual(s.episodeIds.slice(0, 2));
        expect(first.body.TotalRecordCount).toBe(2);
        const last = await get(s.seriesId, `?AdjacentTo=${s.episodeIds[2]}`);
        expect(last.body.Items.map((i) => i.Id)).toEqual(s.episodeIds.slice(1, 3));
    });

    it('works inside a SeasonId listing and pages over the window', async () => {
        const s = await seed([null, null, null, null]);
        const { body } = await get(
            s.seriesId,
            `?SeasonId=${s.seasonId}&AdjacentTo=${s.episodeIds[1]}&StartIndex=1&Limit=1`,
        );
        expect(body.Items.map((i) => i.Id)).toEqual([s.episodeIds[1]]);
        expect(body.TotalRecordCount).toBe(3);
        expect(body.StartIndex).toBe(1);
    });

    it('is empty for an episode that is not in the listing', async () => {
        const a = await seed([null, null]);
        const b = await seed([null]);
        const { status, body } = await get(a.seriesId, `?AdjacentTo=${b.episodeIds[0]}`);
        expect(status).toBe(200);
        expect(body.Items).toEqual([]);
        expect(body.TotalRecordCount).toBe(0);
    });

    it('skips a neighbour the caller cannot see and never returns a hidden target', async () => {
        deniedGroupId = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'Adjacent adults only')`;
        await upsertLibraryGroupPermission(sql, {
            libraryGroupId: deniedGroupId,
            allowedGroups: ['adults'],
        });
        invalidateLibraryGroupPermissionsCache();
        const s = await seed([null, deniedGroupId, null]);
        const visible = await get(s.seriesId, `?AdjacentTo=${s.episodeIds[2]}`);
        expect(visible.body.Items.map((i) => i.Id)).toEqual([s.episodeIds[0], s.episodeIds[2]]);
        const hidden = await get(s.seriesId, `?AdjacentTo=${s.episodeIds[1]}`);
        expect(hidden.body.Items).toEqual([]);
        expect(hidden.body.TotalRecordCount).toBe(0);
    });

    it('applies ExcludeLocationTypes=Virtual to the window and its total, like a normal listing', async () => {
        const s = await seed([null, null, null, null]);
        // Episode 3 gets no MediaSources: "Virtual".
        virtualIds.add(s.episodeIds[2]);
        const all = await get(s.seriesId, `?AdjacentTo=${s.episodeIds[1]}`);
        expect(all.body.Items.map((i) => i.Id)).toEqual(s.episodeIds.slice(0, 3));
        expect(all.body.TotalRecordCount).toBe(3);
        const real = await get(
            s.seriesId,
            `?AdjacentTo=${s.episodeIds[1]}&ExcludeLocationTypes=Virtual`,
        );
        expect(real.body.Items.map((i) => i.Id)).toEqual(s.episodeIds.slice(0, 2));
        expect(real.body.TotalRecordCount).toBe(2);
    });

    it('rejects a malformed AdjacentTo (validation_failed, 422 like every badRequest here)', async () => {
        const s = await seed([null]);
        const { status } = await get(s.seriesId, '?AdjacentTo=not-a-guid');
        expect(status).toBe(422);
    });

    it('answers 404 for a series that does not exist', async () => {
        const { status } = await get(randomUUID(), `?AdjacentTo=${randomUUID()}`);
        expect(status).toBe(404);
    });
});
