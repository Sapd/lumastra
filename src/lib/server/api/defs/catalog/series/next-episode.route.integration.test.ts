// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route-level integration test for the runtime of GET /series/{id}/next-episode
 * and the `nextEpisode` section of GET /media/{id}/context.
 *
 * Both go through the real mounted handler against the real test database, so
 * mount()'s test-mode conformance gate throws ResponseContractViolation when a
 * body stops matching its declared schema (a missing `durationMs` did, on
 * prod, for episodes whose metadata carries no runtime yet).
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
import { createTestUser } from '../../../../../../../tests/integration/helpers/users.js';
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

// No live sessions: the durable next-up decides.
vi.mock('$lib/server/services/session-read-model.service.js', () => ({
    getSessionReadModel: () => ({ getActiveSessionsForUser: async () => [] }),
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

interface NextEpisodeBody {
    id: string;
    seasonNumber: number;
    episodeNumber: number;
    durationMs: number | null;
    playable?: boolean;
}

interface ContextBody {
    nextEpisode?: {
        id: string;
        durationMs: number | null;
    };
}

function buildEvent(
    userId: string,
    seriesId: string,
    path: string,
    routeId: string,
): RequestEvent<{ id: string }, never> {
    const url = new URL(`http://localhost${path}`);
    return {
        url,
        request: new Request(url),
        locals: {
            user: {
                username: `rt-${randomUUID().slice(0, 8)}`,
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

describe.runIf(RUN)('next-episode runtime (route-level, real DB)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    /**
     * Series with S1E1 (watched, runtime 1300 s, file), S1E2 (no runtime,
     * file of `secondFileDuration` s or no probed duration) and S1E3 (unaired:
     * no runtime, no file).
     */
    async function seedSeries(secondFileDuration: number | null): Promise<{
        userId: string;
        seriesId: string;
        ep2Id: string;
        ep3Id: string;
        cleanup: () => Promise<void>;
    }> {
        const user = await createTestUser(sql);
        const seriesId = randomUUID();
        const seasonId = randomUUID();
        const ep1Id = randomUUID();
        const ep2Id = randomUUID();
        const ep3Id = randomUUID();
        const all = [seriesId, seasonId, ep1Id, ep2Id, ep3Id];

        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status) VALUES (${seriesId}::uuid, 'Runtime Series', 'tv', NULL, 'active')`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number) VALUES (${seasonId}::uuid, 'Season 1', 'season', ${seriesId}::uuid, 'active', 1)`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number, runtime_seconds) VALUES (${ep1Id}::uuid, 'Ep 1', 'episode', ${seasonId}::uuid, 'active', 1, 1, 1300)`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${ep2Id}::uuid, 'Ep 2', 'episode', ${seasonId}::uuid, 'active', 1, 2)`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${ep3Id}::uuid, 'Ep 3', 'episode', ${seasonId}::uuid, 'active', 1, 3)`;

        const [file1] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, duration_seconds, created_at, updated_at)
            VALUES (${`/test/runtime/${seriesId}/s01e01.mkv`}, 1300, NOW(), NOW()) RETURNING id
        `;
        const [file2] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, duration_seconds, created_at, updated_at)
            VALUES (${`/test/runtime/${seriesId}/s01e02.mkv`}, ${secondFileDuration}, NOW(), NOW()) RETURNING id
        `;
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file1.id}::uuid, ${ep1Id}::uuid)`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file2.id}::uuid, ${ep2Id}::uuid)`;
        await sql`UPDATE media_items SET has_files = true WHERE id = ANY(${[seriesId, seasonId, ep1Id, ep2Id]}::uuid[])`;

        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at, last_event_at)
            VALUES (${user.id}::uuid, ${ep1Id}::uuid, true, NOW(), NOW())
        `;

        return {
            userId: user.id,
            seriesId,
            ep2Id,
            ep3Id,
            cleanup: async () => {
                await sql`DELETE FROM user_media_state WHERE user_id = ${user.id}::uuid`;
                await sql`DELETE FROM media_items WHERE id = ANY(${all}::uuid[])`;
                await sql`DELETE FROM media_files WHERE id = ANY(${[file1.id, file2.id]}::uuid[])`;
            },
        };
    }

    /** Links a fresh playable default file to the episode; returns the file id. */
    async function linkPlayableFile(episodeId: string): Promise<string> {
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path)
            VALUES (${'/test/next-episode-extra/' + episodeId + '.mkv'}) RETURNING id
        `;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${file.id}, ${episodeId}, true)`;
        await sql`UPDATE media_items SET has_files = true WHERE id = ${episodeId}::uuid`;
        return file.id;
    }

    /**
     * Moves the episode's files into a library group the (group-less) test
     * user is denied. Returns the cleanup for the group and its permission.
     */
    async function denyEpisodeFiles(episodeId: string): Promise<() => Promise<void>> {
        const deniedGroup = randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroup}, ${'Next denied ' + deniedGroup})`;
        await upsertLibraryGroupPermission(sql, {
            libraryGroupId: deniedGroup,
            allowedGroups: ['adults'],
        });
        await sql`UPDATE media_files SET library_group_id = ${deniedGroup} WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${episodeId})`;
        invalidateLibraryGroupPermissionsCache();
        return async () => {
            await sql`UPDATE media_files SET library_group_id = NULL WHERE library_group_id = ${deniedGroup}`;
            await deleteLibraryGroupPermission(sql, deniedGroup);
            await sql`DELETE FROM library_groups WHERE id = ${deniedGroup}`;
            invalidateLibraryGroupPermissionsCache();
        };
    }

    async function getNextEpisode(
        userId: string,
        seriesId: string,
        query: string,
    ): Promise<{ status: number; body: NextEpisodeBody }> {
        const { GET } =
            await import('../../../../../../routes/api/v1/series/[id]/next-episode/+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const res = await GET(
            buildEvent(
                userId,
                seriesId,
                `/api/v1/series/${seriesId}/next-episode${query}`,
                '/api/v1/series/[id]/next-episode',
            ),
        );
        return { status: res.status, body: (await res.json()) as NextEpisodeBody };
    }

    async function getContext(userId: string, seriesId: string): Promise<ContextBody> {
        const { GET } =
            await import('../../../../../../routes/api/v1/media/[id]/context/+server.js');
        if (!GET) throw new Error('GET handler is not defined');
        const res = await GET(
            buildEvent(
                userId,
                seriesId,
                `/api/v1/media/${seriesId}/context?include=nextEpisode`,
                '/api/v1/media/[id]/context',
            ),
        );
        expect(res.status).toBe(200);
        return (await res.json()) as ContextBody;
    }

    it('playback cursor skips the entire combined file independently of watch history', async () => {
        const s = await seedSeries(1300);
        try {
            const [first] = await sql<
                { id: string }[]
            >`SELECT id FROM media_items WHERE parent_id = (SELECT parent_id FROM media_items WHERE id = ${s.ep2Id}) AND episode_number = 1`;
            const [file] = await sql<
                { file_id: string }[]
            >`SELECT file_id FROM media_file_items WHERE media_item_id = ${s.ep2Id}`;
            // Repoint the existing default atomically; never leave a linked item
            // with files but no default between statements.
            await sql`UPDATE media_file_items SET file_id = ${file.file_id} WHERE media_item_id = ${first.id} AND is_default = true`;
            // Third episode has a separate file, and is unwatched like the second.
            const [lastFile] = await sql<
                { id: string }[]
            >`INSERT INTO media_files (file_path) VALUES (${'/test/playback-last-' + s.ep3Id}) RETURNING id`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${lastFile.id}, ${s.ep3Id}, true)`;
            for (const entry of [first.id, s.ep2Id]) {
                const { status, body } = await getNextEpisode(
                    s.userId,
                    s.seriesId,
                    `?afterPlayback=${entry}`,
                );
                expect(status).toBe(200);
                expect(body).toMatchObject({ id: s.ep3Id, episodeNumber: 3, seasonNumber: 1 });
            }
            expect(
                (await getNextEpisode(s.userId, s.seriesId, `?afterPlayback=${s.ep3Id}`)).status,
            ).toBe(404);
            await sql`DELETE FROM media_files WHERE id = ${lastFile.id}`;
        } finally {
            await s.cleanup();
        }
    });

    it('playback cursor after a hand-linked file holding E1 + E3 continues at E2', async () => {
        const s = await seedSeries(1300);
        try {
            const [first] = await sql<
                { id: string; file_id: string }[]
            >`SELECT mi.id, mfi.file_id FROM media_items mi JOIN media_file_items mfi ON mfi.media_item_id = mi.id
              WHERE mi.parent_id = (SELECT parent_id FROM media_items WHERE id = ${s.ep2Id}) AND mi.episode_number = 1`;
            // The file of E1 also holds E3 (E2 has a file of its own).
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order, offset_source)
                VALUES (${first.file_id}, ${s.ep3Id}, true, 1, 'manual')`;
            for (const [entry, expected] of [
                [first.id, s.ep2Id],
                [s.ep3Id, null],
            ] as const) {
                const res = await getNextEpisode(s.userId, s.seriesId, `?afterPlayback=${entry}`);
                if (expected === null) expect(res.status).toBe(404);
                else expect(res.body).toMatchObject({ id: expected, episodeNumber: 2 });
            }
        } finally {
            await s.cleanup();
        }
    });

    it('playback cursor after a hand-linked cross-season file stays in the entry season', async () => {
        const s = await seedSeries(1300);
        try {
            const [first] = await sql<
                { id: string; file_id: string; season_id: string }[]
            >`SELECT mi.id, mfi.file_id, mi.parent_id AS season_id FROM media_items mi
              JOIN media_file_items mfi ON mfi.media_item_id = mi.id
              WHERE mi.parent_id = (SELECT parent_id FROM media_items WHERE id = ${s.ep2Id}) AND mi.episode_number = 1`;
            const season2 = randomUUID();
            const s2e1 = randomUUID();
            const s2e2 = randomUUID();
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number) VALUES (${season2}::uuid, 'Season 2', 'season', ${s.seriesId}::uuid, 'active', 2)`;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${s2e1}::uuid, 'S2 Ep 1', 'episode', ${season2}::uuid, 'active', 2, 1)`;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${s2e2}::uuid, 'S2 Ep 2', 'episode', ${season2}::uuid, 'active', 2, 2)`;
            // The file plays S2E1 first, then S1E1.
            await sql`UPDATE media_file_items SET sort_order = 1, offset_source = 'manual' WHERE file_id = ${first.file_id}`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order, offset_source)
                VALUES (${first.file_id}, ${s2e1}::uuid, true, 0, 'manual')`;
            const s2e2File = await linkPlayableFile(s2e2);
            try {
                expect(
                    (await getNextEpisode(s.userId, s.seriesId, `?afterPlayback=${s2e1}`)).body,
                ).toMatchObject({ id: s2e2, seasonNumber: 2, episodeNumber: 2 });
                expect(
                    (await getNextEpisode(s.userId, s.seriesId, `?afterPlayback=${first.id}`)).body,
                ).toMatchObject({ id: s.ep2Id, seasonNumber: 1, episodeNumber: 2 });
            } finally {
                await sql`DELETE FROM media_items WHERE id = ANY(${[season2, s2e1, s2e2]}::uuid[])`;
                await sql`DELETE FROM media_files WHERE id = ${s2e2File}`;
            }
        } finally {
            await s.cleanup();
        }
    });

    it('playback cursor rejects foreign series anchors and malformed IDs', async () => {
        const s = await seedSeries(1300);
        const other = await seedSeries(1300);
        try {
            expect(
                (await getNextEpisode(s.userId, s.seriesId, `?afterPlayback=${other.ep2Id}`))
                    .status,
            ).toBe(404);
            expect(
                (await getNextEpisode(s.userId, s.seriesId, '?afterPlayback=not-a-uuid')).status,
            ).toBeGreaterThanOrEqual(400);
        } finally {
            await s.cleanup();
            await other.cleanup();
        }
    });

    it.each(['anchor', 'successor'] as const)(
        'playback cursor fails closed for a denied %s episode',
        async (deniedRole) => {
            const s = await seedSeries(1300);
            const deniedGroup = randomUUID();
            let lastFile: string | undefined;
            try {
                const [first] = await sql<
                    { id: string }[]
                >`SELECT id FROM media_items WHERE parent_id = (SELECT parent_id FROM media_items WHERE id = ${s.ep2Id}) AND episode_number = 1`;
                const [file] = await sql<
                    { id: string }[]
                >`INSERT INTO media_files (file_path) VALUES (${'/test/playback-access-' + s.ep3Id}) RETURNING id`;
                lastFile = file.id;
                await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${file.id}, ${s.ep3Id}, true)`;
                const anchor = deniedRole === 'anchor' ? s.ep2Id : first.id;
                const successor = deniedRole === 'anchor' ? s.ep3Id : s.ep2Id;
                // Establish a real continuation first: removing either new access
                // check must turn the final 404 into a 200 for this same lookup.
                expect(
                    await getNextEpisode(s.userId, s.seriesId, `?afterPlayback=${anchor}`),
                ).toMatchObject({
                    status: 200,
                    body: { id: successor },
                });
                if (deniedRole === 'successor') {
                    // Fail-closed case: ep2 is the denied successor and NO later
                    // visible playable episode may exist, otherwise the cursor would
                    // legitimately skip ahead to it (see the skip-ahead test below).
                    // Unlink ep3's file so the 404 can only come from the denial.
                    await sql`DELETE FROM media_file_items WHERE media_item_id = ${s.ep3Id}`;
                    await sql`UPDATE media_items SET has_files = false WHERE id = ${s.ep3Id}::uuid`;
                }
                await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroup}, ${'Playback denied ' + deniedGroup})`;
                await upsertLibraryGroupPermission(sql, {
                    libraryGroupId: deniedGroup,
                    allowedGroups: ['adults'],
                });
                await sql`UPDATE media_files SET library_group_id = ${deniedGroup} WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${s.ep2Id})`;
                invalidateLibraryGroupPermissionsCache();
                const result = await getNextEpisode(
                    s.userId,
                    s.seriesId,
                    `?afterPlayback=${anchor}`,
                );
                expect(result.status).toBe(404);
                expect(result.body).not.toHaveProperty('id');
            } finally {
                await s.cleanup();
                if (lastFile) await sql`DELETE FROM media_files WHERE id = ${lastFile}`;
                await deleteLibraryGroupPermission(sql, deniedGroup);
                await sql`DELETE FROM library_groups WHERE id = ${deniedGroup}`;
                invalidateLibraryGroupPermissionsCache();
            }
        },
    );

    it('playback cursor skips a denied successor and returns the next visible playable episode', async () => {
        const s = await seedSeries(1300);
        const files: string[] = [];
        let undeny: (() => Promise<void>) | undefined;
        try {
            const [first] = await sql<
                { id: string }[]
            >`SELECT id FROM media_items WHERE parent_id = (SELECT parent_id FROM media_items WHERE id = ${s.ep2Id}) AND episode_number = 1`;
            // ep3 is visible, has_files = true and has a linked playable file.
            files.push(await linkPlayableFile(s.ep3Id));
            expect(
                await getNextEpisode(s.userId, s.seriesId, `?afterPlayback=${first.id}`),
            ).toMatchObject({ status: 200, body: { id: s.ep2Id } });

            undeny = await denyEpisodeFiles(s.ep2Id);
            const { status, body } = await getNextEpisode(
                s.userId,
                s.seriesId,
                `?afterPlayback=${first.id}`,
            );
            expect(status).toBe(200);
            expect(body.id).toBe(s.ep3Id);
            expect(body.episodeNumber).toBe(3);
        } finally {
            await s.cleanup();
            if (undeny) await undeny();
            if (files.length) await sql`DELETE FROM media_files WHERE id = ANY(${files}::uuid[])`;
        }
    });

    it('explicit lookup: an episode in a denied library group is 404, an accessible one is 200', async () => {
        const s = await seedSeries(1300);
        let undeny: (() => Promise<void>) | undefined;
        try {
            expect((await getNextEpisode(s.userId, s.seriesId, '?season=1&episode=2')).status).toBe(
                200,
            );

            undeny = await denyEpisodeFiles(s.ep2Id);

            const denied = await getNextEpisode(s.userId, s.seriesId, '?season=1&episode=2');
            expect(denied.status).toBe(404);
            expect(denied.body).not.toHaveProperty('id');

            const visible = await getNextEpisode(s.userId, s.seriesId, '?season=1&episode=1');
            expect(visible.status).toBe(200);
            expect(visible.body).toMatchObject({ seasonNumber: 1, episodeNumber: 1 });
        } finally {
            await s.cleanup();
            if (undeny) await undeny();
        }
    });

    it('playback cursor after the last special does not jump to S01E01', async () => {
        const s = await seedSeries(1300);
        const specialSeasonId = randomUUID();
        const special1 = randomUUID();
        const special2 = randomUUID();
        const files: string[] = [];
        try {
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number) VALUES (${specialSeasonId}::uuid, 'Specials', 'season', ${s.seriesId}::uuid, 'active', 0)`;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${special1}::uuid, 'Special 1', 'episode', ${specialSeasonId}::uuid, 'active', 0, 1)`;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${special2}::uuid, 'Special 2', 'episode', ${specialSeasonId}::uuid, 'active', 0, 2)`;
            files.push(await linkPlayableFile(special1), await linkPlayableFile(special2));
            await sql`UPDATE media_items SET has_files = true WHERE id = ${specialSeasonId}::uuid`;

            // Within the specials the cursor still advances...
            expect(
                await getNextEpisode(s.userId, s.seriesId, `?afterPlayback=${special1}`),
            ).toMatchObject({ status: 200, body: { id: special2 } });
            // ...but after the LAST special it ends instead of wrapping to S01E01
            // (which is visible and playable in this fixture).
            const after = await getNextEpisode(s.userId, s.seriesId, `?afterPlayback=${special2}`);
            expect(after.status).toBe(404);
            expect(after.body).not.toHaveProperty('id');
        } finally {
            await s.cleanup();
            await sql`DELETE FROM media_items WHERE id = ANY(${[special1, special2, specialSeasonId]}::uuid[])`;
            if (files.length) await sql`DELETE FROM media_files WHERE id = ANY(${files}::uuid[])`;
        }
    });

    it('explicit lookup: null runtime_seconds falls back to the probed file duration', async () => {
        const s = await seedSeries(1299.776);
        try {
            const { status, body } = await getNextEpisode(
                s.userId,
                s.seriesId,
                '?season=1&episode=2',
            );
            expect(status).toBe(200);
            expect(body.id).toBe(s.ep2Id);
            // The probed length in ms, the same value /media/{id} reports.
            expect(body.durationMs).toBe(1299776);
            expect(body.playable).toBe(true);
        } finally {
            await s.cleanup();
        }
    });

    it('explicit lookup: a duplicate S/E row picks the active one with a file, like new-episode alerts', async () => {
        const s = await seedSeries(1299.776);
        const [season] = await sql<{ id: string }[]>`
            SELECT parent_id::text AS id FROM media_items WHERE id = ${s.ep2Id}::uuid
        `;
        // Lower ids than ep2 so the old `ORDER BY ep.id` would have picked them.
        // The lookup matches on the parent season's number; a row without its
        // own season_number escapes uq_media_items_episode, which is how a
        // duplicate S/E pair arises in practice.
        const stubId = '00000000-0000-4000-8000-000000000001';
        const deletedId = '00000000-0000-4000-8000-000000000002';
        try {
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number) VALUES (${stubId}::uuid, 'Ep 2 stub', 'episode', ${season.id}::uuid, 'active', NULL, 2)`;
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number, has_files) VALUES (${deletedId}::uuid, 'Ep 2 old', 'episode', ${season.id}::uuid, 'deleted', NULL, 2, true)`;
            const { status, body } = await getNextEpisode(
                s.userId,
                s.seriesId,
                '?season=1&episode=2',
            );
            expect(status).toBe(200);
            expect(body.id).toBe(s.ep2Id);
            expect(body.playable).toBe(true);
        } finally {
            await sql`DELETE FROM media_items WHERE id = ANY(${[stubId, deletedId]}::uuid[])`;
            await s.cleanup();
        }
    });

    it('explicit lookup: an unaired episode without runtime or file reports durationMs null', async () => {
        const s = await seedSeries(1299.776);
        try {
            const { status, body } = await getNextEpisode(
                s.userId,
                s.seriesId,
                '?season=1&episode=3',
            );
            expect(status).toBe(200);
            expect(body.id).toBe(s.ep3Id);
            expect(body.durationMs).toBeNull();
            expect(body.playable).toBe(false);
        } finally {
            await s.cleanup();
        }
    });

    it('automatic next-up: runtime comes from the probed file when metadata has none', async () => {
        const s = await seedSeries(1299.776);
        try {
            const { status, body } = await getNextEpisode(s.userId, s.seriesId, '');
            expect(status).toBe(200);
            expect(body.id).toBe(s.ep2Id);
            expect(body.durationMs).toBe(1299776);
        } finally {
            await s.cleanup();
        }
    });

    it('automatic next-up: no metadata runtime and no probed duration gives durationMs null', async () => {
        const s = await seedSeries(null);
        try {
            const { status, body } = await getNextEpisode(s.userId, s.seriesId, '');
            expect(status).toBe(200);
            expect(body.id).toBe(s.ep2Id);
            expect(body.durationMs).toBeNull();
        } finally {
            await s.cleanup();
        }
    });

    it('context nextEpisode: runtime comes from the probed file', async () => {
        const s = await seedSeries(1299.776);
        try {
            const body = await getContext(s.userId, s.seriesId);
            expect(body.nextEpisode?.id).toBe(s.ep2Id);
            expect(body.nextEpisode?.durationMs).toBe(1299776);
        } finally {
            await s.cleanup();
        }
    });

    it('context nextEpisode: no known runtime gives durationMs null', async () => {
        const s = await seedSeries(null);
        try {
            const body = await getContext(s.userId, s.seriesId);
            expect(body.nextEpisode?.id).toBe(s.ep2Id);
            expect(body.nextEpisode?.durationMs).toBeNull();
        } finally {
            await s.cleanup();
        }
    });
});

describe.runIf(RUN)('next-episode runtime fallback rules (explicit lookup, real DB)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    interface EpisodeSeed {
        runtimeSeconds: number | null;
    }

    /**
     * Seeds a series whose episodes 1..n carry the given metadata runtimes,
     * links each `files` entry (duration, episode numbers) and asks the
     * explicit lookup for S1E`ask`.
     */
    async function lookup(
        episodes: EpisodeSeed[],
        files: Array<{ duration: number; episodes: number[] }>,
        ask: number,
    ): Promise<NextEpisodeBody> {
        const user = await createTestUser(sql);
        const seriesId = randomUUID();
        const seasonId = randomUUID();
        const epIds = episodes.map(() => randomUUID());
        const fileIds: string[] = [];
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status) VALUES (${seriesId}::uuid, 'Fallback Series', 'tv', NULL, 'active')`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number) VALUES (${seasonId}::uuid, 'Season 1', 'season', ${seriesId}::uuid, 'active', 1)`;
        for (const [i, ep] of episodes.entries()) {
            await sql`INSERT INTO media_items (id, title, media_type, parent_id, status, season_number, episode_number, runtime_seconds) VALUES (${epIds[i]}::uuid, ${`Ep ${i + 1}`}, 'episode', ${seasonId}::uuid, 'active', 1, ${i + 1}, ${ep.runtimeSeconds})`;
        }
        try {
            for (const [fi, f] of files.entries()) {
                const [row] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path, duration_seconds, created_at, updated_at)
                    VALUES (${`/test/fallback/${seriesId}/${fi}.mkv`}, ${f.duration}, NOW(), NOW()) RETURNING id
                `;
                fileIds.push(row.id);
                for (const n of f.episodes) {
                    await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${row.id}::uuid, ${epIds[n - 1]}::uuid, ${fi === 0})`;
                }
            }
            await sql`UPDATE media_items SET has_files = true WHERE id = ANY(${[seriesId, seasonId, ...epIds]}::uuid[])`;

            const { GET } =
                await import('../../../../../../routes/api/v1/series/[id]/next-episode/+server.js');
            if (!GET) throw new Error('GET handler is not defined');
            const res = await GET(
                buildEvent(
                    user.id,
                    seriesId,
                    `/api/v1/series/${seriesId}/next-episode?season=1&episode=${ask}`,
                    '/api/v1/series/[id]/next-episode',
                ),
            );
            expect(res.status).toBe(200);
            return (await res.json()) as NextEpisodeBody;
        } finally {
            await sql`DELETE FROM media_items WHERE id = ANY(${[seriesId, seasonId, ...epIds]}::uuid[])`;
            if (fileIds.length) {
                await sql`DELETE FROM media_files WHERE id = ANY(${fileIds}::uuid[])`;
            }
        }
    }

    it('the probed file wins over the metadata runtime, as on /media/{id}', async () => {
        const body = await lookup(
            [{ runtimeSeconds: 1300 }],
            [{ duration: 2700, episodes: [1] }],
            1,
        );
        expect(body.durationMs).toBe(2700000);
    });

    it('the longest file variant wins when there is no metadata runtime', async () => {
        const body = await lookup(
            [{ runtimeSeconds: null }],
            [
                { duration: 600, episodes: [1] },
                { duration: 1500, episodes: [1] },
            ],
            1,
        );
        expect(body.durationMs).toBe(1500000);
    });

    it('a combined file linked to two episodes gives each its share', async () => {
        const body = await lookup(
            [{ runtimeSeconds: null }, { runtimeSeconds: null }],
            [{ duration: 2640, episodes: [1, 2] }],
            2,
        );
        expect(body.durationMs).toBe(1320000);
    });
});
