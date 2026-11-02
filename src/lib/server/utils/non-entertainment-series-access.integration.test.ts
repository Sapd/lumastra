// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * getAccessibleSeriesWithEpisodes against the real access rules: a series whose
 * files sit in a library group the viewer is denied is invisible, and an episode
 * above the viewer's age rating drops out of an otherwise visible series. The
 * unit tests mock both checks; this pins what they actually decide.
 * (2026-10-07 entry-point review.)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import type { UserContext } from '$lib/server/types.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { createLibraryGroup } from '$lib/server/database/queries/library-groups.queries.js';
import { upsertLibraryGroupPermission } from '$lib/server/database/queries/library-group-permissions.queries.js';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';
import { getAccessibleSeriesWithEpisodes } from './non-entertainment-series-access.js';

const MEDIA_TYPE = 'home_video';

function user(overrides: Partial<UserContext> = {}): UserContext {
    return {
        userId: toUserId(randomUUID()),
        username: `series-access-${randomUUID()}`,
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
        ...overrides,
    };
}

let sql: postgres.Sql;

/** A series with one season and the given episodes, each backed by one file. */
async function series(
    groupId: string | null,
    episodes: Array<{ ageRating: number | null }>,
): Promise<{ seriesId: string; episodeIds: string[] }> {
    const seriesId = randomUUID();
    const seasonId = randomUUID();
    await sql`INSERT INTO media_items (id, title, media_type, status, has_files, created_at, updated_at)
              VALUES (${seriesId}::uuid, 'Series', ${MEDIA_TYPE}, 'active', true, NOW(), NOW())`;
    await sql`INSERT INTO media_items (id, title, media_type, parent_id, sort_order, status, created_at, updated_at)
              VALUES (${seasonId}::uuid, 'Season 1', 'season', ${seriesId}::uuid, 1, 'active', NOW(), NOW())`;
    const episodeIds: string[] = [];
    for (const [i, ep] of episodes.entries()) {
        const id = randomUUID();
        episodeIds.push(id);
        await sql`INSERT INTO media_items
                    (id, title, media_type, parent_id, episode_number, age_rating, has_files, status, created_at, updated_at)
                  VALUES (${id}::uuid, ${`Episode ${i + 1}`}, 'episode', ${seasonId}::uuid, ${i + 1},
                          ${ep.ageRating}, true, 'active', NOW(), NOW())`;
        const [{ id: fileId }] = await sql<[{ id: string }]>`
            INSERT INTO media_files (file_path, library_group_id)
            VALUES (${`/nonexistent/${id}.mkv`}, ${groupId}::uuid) RETURNING id`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${fileId}::uuid, ${id}::uuid)`;
    }
    await sql`UPDATE media_items SET age_rating = 6 WHERE id = ${seriesId}::uuid`;
    return { seriesId, episodeIds };
}

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(() => {
    invalidateLibraryGroupPermissionsCache();
});

describe('getAccessibleSeriesWithEpisodes — real access rules', () => {
    it('a series in a denied library group is invisible; the admin control sees it', async () => {
        const group = await createLibraryGroup(sql, { name: `Private ${randomUUID()}` });
        await upsertLibraryGroupPermission(sql, {
            libraryGroupId: group.id,
            allowedGroups: ['family'],
        });
        invalidateLibraryGroupPermissionsCache();
        const { seriesId } = await series(group.id, [{ ageRating: 6 }, { ageRating: 6 }]);

        const asAdmin = await getAccessibleSeriesWithEpisodes(
            sql,
            seriesId,
            user({ ownerIsAdmin: true }),
            {
                mediaType: MEDIA_TYPE,
            },
        );
        expect(asAdmin.series?.id).toBe(seriesId);
        expect(asAdmin.episodes).toHaveLength(2);

        const asOutsider = await getAccessibleSeriesWithEpisodes(
            sql,
            seriesId,
            user({ userGroups: ['guests'] }),
            { mediaType: MEDIA_TYPE },
        );
        expect(asOutsider).toEqual({ series: null, episodes: [] });

        const asMember = await getAccessibleSeriesWithEpisodes(
            sql,
            seriesId,
            user({ userGroups: ['family'] }),
            { mediaType: MEDIA_TYPE },
        );
        expect(asMember.series?.id).toBe(seriesId);
    });

    it("episodes follow their series' age rating, not their own row", async () => {
        // Seasons and episodes never get age_rating written; an episode is judged by its
        // series (2a986501c8). The series here is rated 6, so a stray 18 on one episode
        // row does not hide it from a viewer limited to 12.
        const { seriesId, episodeIds } = await series(null, [{ ageRating: 6 }, { ageRating: 18 }]);
        const limited = user({ maxAgeRating: 12, isAgeRestricted: true });

        const result = await getAccessibleSeriesWithEpisodes(sql, seriesId, limited, {
            mediaType: MEDIA_TYPE,
        });
        expect(result.series?.id).toBe(seriesId);
        expect(result.episodes.map((e) => e.id).sort()).toEqual([...episodeIds].sort());
    });
});
