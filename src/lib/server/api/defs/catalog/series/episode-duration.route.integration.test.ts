// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Endpoint-seam test for the duration of an episode on a combined file.
 *
 * One episode, one duration: the durationMs that GET /episodes/{id} and
 * GET /series/{id}/episodes return for an episode must equal
 * findPlaybackDurationMs for that episode, which is also what GET /media/{id}
 * and the play-session start use. Here E03 and E04 share a 145.092 s file with
 * unequal segment windows (70000 + 75092), so an even split or the
 * runtime_seconds value (73000) cannot pass by coincidence.
 *
 * Both go through the real mounted handlers against the real test database.
 */

import { EpisodeNodeSchema } from '$lib/schemas/api-series-responses.js';
import type { RequestEvent } from '@sveltejs/kit';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../../../tests/integration/helpers/users.js';
import { findPlaybackDurationMs } from '$lib/server/database/queries/media-items.queries.js';

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

interface EpisodeBody {
    id: string;
    durationMs?: number;
    progress?: { durationMs: number | null };
}

interface EpisodesPageBody {
    items: EpisodeBody[];
}

function buildEvent(
    userId: string,
    params: Record<string, string>,
    path: string,
    routeId: string,
): RequestEvent<Record<string, string>, never> {
    const url = new URL(`http://localhost${path}`);
    return {
        url,
        request: new Request(url),
        locals: {
            user: {
                username: `dur-${randomUUID().slice(0, 8)}`,
                userId: toUserId(userId),
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
            },
        },
        params,
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
    } as unknown as RequestEvent<Record<string, string>, never>;
}

describe.runIf(RUN)('episode durationMs at the endpoint seam (real DB)', () => {
    let sql: postgres.Sql;
    let seriesId: string;
    let ep3Id: string;
    let ep4Id: string;
    let userId: string;
    let cleanupIds: { table: 'media_items' | 'media_files'; ids: string[] }[] = [];

    beforeAll(async () => {
        sql = getTestDb();
        userId = (await createTestUser(sql)).id;

        seriesId = randomUUID();
        const seasonId = randomUUID();
        ep3Id = randomUUID();
        ep4Id = randomUUID();
        const fileId = randomUUID();

        await sql`INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${seriesId}::uuid, 'Duration Seam Series', 'tv', 'active', true)`;
        await sql`INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
            VALUES (${seasonId}::uuid, 'Season 1', 'season', 'active', true, ${seriesId}::uuid, 1)`;
        for (const [id, number] of [
            [ep3Id, 3],
            [ep4Id, 4],
        ] as const) {
            await sql`INSERT INTO media_items
                (id, title, media_type, status, has_files, parent_id, season_number, episode_number, runtime_seconds)
                VALUES (${id}::uuid, ${`Episode ${number}`}, 'episode', 'active', true,
                        ${seasonId}::uuid, 1, ${number}, 73)`;
        }
        await sql`INSERT INTO media_files (id, file_path, duration_seconds)
            VALUES (${fileId}::uuid, ${`/test/duration-seam/${fileId}/S01E03-E04 - Two Lanterns.mkv`}, 145.092)`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, start_offset_ms, end_offset_ms, offset_source)
            VALUES (${fileId}::uuid, ${ep3Id}::uuid, true, 0, 70000, 'chapter')`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, start_offset_ms, end_offset_ms, offset_source)
            VALUES (${fileId}::uuid, ${ep4Id}::uuid, true, 70000, 145092, 'chapter')`;

        cleanupIds = [
            { table: 'media_files', ids: [fileId] },
            { table: 'media_items', ids: [ep3Id, ep4Id, seasonId, seriesId] },
        ];
    });

    afterAll(async () => {
        for (const group of cleanupIds) {
            if (group.table === 'media_files') {
                await sql`DELETE FROM media_file_items WHERE file_id = ANY(${group.ids}::uuid[])`;
                await sql`DELETE FROM media_files WHERE id = ANY(${group.ids}::uuid[])`;
            } else {
                await sql`DELETE FROM media_items WHERE id = ANY(${group.ids}::uuid[])`;
            }
        }
        await closeTestDb();
    });

    it('GET /episodes/{id} returns the findPlaybackDurationMs value for E03 and E04', async () => {
        const { GET } = await import('../../../../../../routes/api/v1/episodes/[id]/+server.js');
        if (!GET) throw new Error('GET handler is not defined');

        for (const [id, expected] of [
            [ep3Id, 70000],
            [ep4Id, 75092],
        ] as const) {
            const res = await GET(
                buildEvent(
                    userId,
                    { id },
                    `/api/v1/episodes/${id}`,
                    '/api/v1/episodes/[id]',
                ) as Parameters<typeof GET>[0],
            );
            expect(res.status).toBe(200);
            const body = (await res.json()) as EpisodeBody;
            expect(EpisodeNodeSchema.parse(body)).toEqual(body);
            expect(body).toHaveProperty('context.series.id', seriesId);
            expect(body).not.toHaveProperty('audiobook');
            expect(body).not.toHaveProperty('score');
            expect(body).not.toHaveProperty('reason');
            expect(body.durationMs).toBe(expected);
            expect(body.durationMs).toBe(await findPlaybackDurationMs(sql, id));
            // progress.durationMs is the same number as the node's durationMs.
            expect(body.progress?.durationMs).toBe(body.durationMs);
        }
    });

    it('GET /series/{id}/episodes returns the same durationMs as findPlaybackDurationMs', async () => {
        const { GET } =
            await import('../../../../../../routes/api/v1/series/[id]/episodes/+server.js');
        if (!GET) throw new Error('GET handler is not defined');

        const res = await GET(
            buildEvent(
                userId,
                { id: seriesId },
                `/api/v1/series/${seriesId}/episodes`,
                '/api/v1/series/[id]/episodes',
            ) as Parameters<typeof GET>[0],
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as EpisodesPageBody;
        const byId = new Map(body.items.map((item) => [item.id, item]));

        expect(byId.get(ep3Id)?.durationMs).toBe(70000);
        expect(byId.get(ep3Id)?.durationMs).toBe(await findPlaybackDurationMs(sql, ep3Id));
        expect(byId.get(ep4Id)?.durationMs).toBe(75092);
        expect(byId.get(ep4Id)?.progress?.durationMs).toBe(byId.get(ep4Id)?.durationMs);
    });

    it('GET /series/{id}/next-episode gives a combined-file episode its own window, not its runtime', async () => {
        const { GET } =
            await import('../../../../../../routes/api/v1/series/[id]/next-episode/+server.js');
        if (!GET) throw new Error('GET handler is not defined');

        // Explicit lookup of E03 (runtime 73 s): the window (70000) wins over runtime_seconds.
        const res = await GET(
            buildEvent(
                userId,
                { id: seriesId },
                `/api/v1/series/${seriesId}/next-episode?season=1&episode=3`,
                '/api/v1/series/[id]/next-episode',
            ) as Parameters<typeof GET>[0],
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as EpisodeBody;
        expect(body.id).toBe(ep3Id);
        expect(body.durationMs).toBe(70000);
    });
});
