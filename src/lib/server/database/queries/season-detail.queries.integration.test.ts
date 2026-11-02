// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Season Detail Query Module
 *
 * Tests hasNonStandardOrdering, getOrderingSeasons, getUnmappedPhysicalSeasons,
 * getSeasonsByInternalId.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestSeries,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    hasNonStandardOrdering,
    getOrderingSeasons,
    getUnmappedPhysicalSeasons,
    getSeasonsByInternalId,
} from './season-detail.queries.js';
import { restrictedAccess, unrestrictedAccess } from './builders/media-access-boundary.js';

describe('Season Detail Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'episode_orderings',
            'series_episode_ordering',
            ...TEST_TABLES.media,
            ...TEST_TABLES.userData,
        ]);
    });

    async function setupStandardSeries(options?: {
        seasonCount?: number;
        episodesPerSeason?: number;
    }) {
        return createAndInsertTestSeries(sql, {
            seasonCount: options?.seasonCount ?? 2,
            episodesPerSeason: options?.episodesPerSeason ?? 3,
        });
    }

    // ========================================================================
    // hasNonStandardOrdering
    // ========================================================================

    describe('hasNonStandardOrdering', () => {
        it('returns false for series without ordering override', async () => {
            const { seriesId } = await setupStandardSeries();

            const result = await hasNonStandardOrdering(sql, seriesId);
            expect(result).toBe(false);
        });

        it('returns true when non-standard ordering exists', async () => {
            const { seriesId } = await setupStandardSeries();
            await sql`
                INSERT INTO series_episode_ordering (media_id, ordering_type, ordering_group_id)
                VALUES (${seriesId}::uuid, 'dvd', 'group-1')
            `;

            const result = await hasNonStandardOrdering(sql, seriesId);
            expect(result).toBe(true);
        });
    });

    // ========================================================================
    // getSeasonsByInternalId
    // ========================================================================

    describe('getSeasonsByInternalId', () => {
        it('returns seasons for a series by UUID', async () => {
            const { seriesId } = await setupStandardSeries({
                seasonCount: 2,
                episodesPerSeason: 4,
            });
            const user: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, user);

            const rows = await getSeasonsByInternalId(sql, seriesId, user, unrestrictedAccess());

            expect(rows.length).toBe(2);
            expect(rows[0].season_number).toBe(1);
            expect(rows[1].season_number).toBe(2);
            expect(rows[0].episode_count).toBe(4);
        });

        it('emits an image_tag sentinel for a season with a custom_poster_url', async () => {
            // TMDB-only deployment: a season has no Jellyfin image_tag, but a
            // per-season TMDB poster lives in custom_poster_url. The query must
            // surface a non-null image_tag so the UI requests the catalog poster
            // instead of falling back to the "S1" placeholder.
            const { seriesId } = await setupStandardSeries({
                seasonCount: 2,
                episodesPerSeason: 1,
            });
            const user: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, user);

            await sql`
                UPDATE media_items
                SET custom_poster_url = 'https://image.tmdb.org/t/p/w342/poster.jpg'
                WHERE parent_id = ${seriesId}::uuid AND media_type = 'season' AND season_number = 1
            `;

            const rows = await getSeasonsByInternalId(sql, seriesId, user, unrestrictedAccess());
            const s1 = rows.find((r) => r.season_number === 1);
            const s2 = rows.find((r) => r.season_number === 2);
            expect(s1?.image_tag).toBe('catalog');
            expect(s2?.image_tag).toBeNull();
        });

        it('counts watched episodes', async () => {
            const { seriesId, seasons: _seasons } = await setupStandardSeries({
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            const user: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, user);

            // Mark all episodes in season 1 as watched
            const epRows = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id IN (
                    SELECT id FROM media_items WHERE parent_id = ${seriesId}::uuid AND media_type = 'season'
                ) AND media_type = 'episode'
            `;
            for (const ep of epRows) {
                await sql`
                    INSERT INTO user_media_state (user_id, media_id, is_watched, last_watched_at)
                    VALUES (${user}::uuid, ${ep.id}::uuid, true, NOW())
                    ON CONFLICT (user_id, media_id) DO UPDATE SET is_watched = true
                `;
            }

            const rows = await getSeasonsByInternalId(sql, seriesId, user, unrestrictedAccess());
            expect(rows[0].watched_count).toBe(2);
        });

        // C8 (2026-09-16 security review 3, task 4): this query applied NO
        // library/age predicate at all. The v1/internal `series/{id}/seasons`
        // route's `checkMediaAccess(seriesId)` gate only proves the SERIES is
        // visible, not every season under it — a mixed-group series (one
        // season allowed, one in a denied group) leaked the denied season's
        // metadata to a restricted user.
        it('excludes a season whose only episode file is in a denied library group (C8)', async () => {
            const { seriesId } = await setupStandardSeries({
                seasonCount: 2,
                episodesPerSeason: 1,
            });
            const user: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, user);

            const deniedGroupId = randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'C8 Denied Group')`;
            try {
                const season2Episode = await sql<{ id: string }[]>`
                    SELECT ep.id
                    FROM media_items season
                    JOIN media_items ep ON ep.parent_id = season.id
                    WHERE season.parent_id = ${seriesId}::uuid
                      AND season.media_type = 'season'
                      AND season.season_number = 2
                      AND ep.media_type = 'episode'
                    LIMIT 1
                `;
                const [file] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
                    VALUES (${'/test/c8-season.mkv'}, ${deniedGroupId}::uuid, NOW(), NOW())
                    RETURNING id
                `;
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id)
                    VALUES (${file.id}::uuid, ${season2Episode[0].id}::uuid)
                `;

                const open = await getSeasonsByInternalId(
                    sql,
                    seriesId,
                    user,
                    unrestrictedAccess(),
                );
                expect(open.map((r) => r.season_number)).toEqual([1, 2]);

                const restricted = await getSeasonsByInternalId(
                    sql,
                    seriesId,
                    user,
                    restrictedAccess({
                        deniedGroupIds: [deniedGroupId],
                        maxAgeRating: null,
                        allowUnrated: true,
                    }),
                );
                expect(restricted.map((r) => r.season_number)).toEqual([1]);
            } finally {
                await sql`DELETE FROM library_groups WHERE id = ${deniedGroupId}::uuid`;
            }
        });
    });

    // ========================================================================
    // getOrderingSeasons
    // ========================================================================

    describe('getOrderingSeasons', () => {
        it('returns virtual seasons for non-standard ordering', async () => {
            const { seriesId } = await setupStandardSeries({
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            const user: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, user);

            const episodeRows = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id IN (
                    SELECT id FROM media_items WHERE parent_id = ${seriesId}::uuid AND media_type = 'season'
                ) AND media_type = 'episode'
                ORDER BY episode_number
            `;

            // Create a non-standard ordering that splits episodes into 2 virtual seasons
            await sql`
                INSERT INTO series_episode_ordering (media_id, ordering_type, ordering_group_id)
                VALUES (${seriesId}::uuid, 'dvd', 'g1')
            `;
            for (let i = 0; i < episodeRows.length; i++) {
                await sql`
                    INSERT INTO episode_orderings (
                        series_media_id, episode_media_id, provider, provider_episode_id, ordering_type, ordering_group_id, original_season_number, original_episode_number, order_season_number, order_episode_number, fetched_at
                    ) VALUES (
                        ${seriesId}::uuid,
                        ${episodeRows[i].id}::uuid,
                        'tvdb',
                        ${'ep-' + (i + 1)},
                        'dvd',
                        'g1',
                        1,
                        ${i + 1},
                        ${i < 1 ? 1 : 2},
                        ${i + 1},
                        NOW()
                    )
                `;
            }

            const rows = await getOrderingSeasons(sql, seriesId, user, unrestrictedAccess());
            expect(rows.length).toBeGreaterThanOrEqual(1);
            const seasonNumbers = rows.map((r) => r.season_number).sort();
            expect(seasonNumbers).toContain(1);

            // Virtual seasons are addressed by the internal UUID of their
            // physical season, never by a Jellyfin id.
            const [physical] = await sql<{ id: string }[]>`
                SELECT id::text AS id FROM media_items
                WHERE parent_id = ${seriesId}::uuid AND media_type = 'season'
            `;
            for (const row of rows) {
                expect(row.physical_season_id).toBe(physical.id);
                expect(row).not.toHaveProperty('jellyfin_season_id');
            }
        });

        // C8 fix round 1 (2026-09-16 security review 3 review): the FIRST fix
        // round gated only `getSeasonsByInternalId` (the non-ordering branch of
        // `/series/{id}/seasons`) and missed this sibling entirely — a series
        // with a non-standard ordering configured still listed every virtual
        // season regardless of which library group its mapped episodes lived
        // in. `checkMediaAccess(seriesId)` upstream only proves the SERIES is
        // visible, exactly the C8 defect restated.
        it('excludes a virtual season whose only mapped episode file is in a denied library group (C8 fix round 1)', async () => {
            const { seriesId } = await setupStandardSeries({
                seasonCount: 1,
                episodesPerSeason: 2,
            });
            const user: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, user);

            const episodeRows = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id IN (
                    SELECT id FROM media_items WHERE parent_id = ${seriesId}::uuid AND media_type = 'season'
                ) AND media_type = 'episode'
                ORDER BY episode_number
            `;

            await sql`
                INSERT INTO series_episode_ordering (media_id, ordering_type, ordering_group_id)
                VALUES (${seriesId}::uuid, 'dvd', 'g1')
            `;
            for (let i = 0; i < episodeRows.length; i++) {
                await sql`
                    INSERT INTO episode_orderings (
                        series_media_id, episode_media_id, provider, provider_episode_id, ordering_type, ordering_group_id, original_season_number, original_episode_number, order_season_number, order_episode_number, fetched_at
                    ) VALUES (
                        ${seriesId}::uuid,
                        ${episodeRows[i].id}::uuid,
                        'tvdb',
                        ${'ep-' + (i + 1)},
                        'dvd',
                        'g1',
                        1,
                        ${i + 1},
                        ${i < 1 ? 1 : 2},
                        ${i + 1},
                        NOW()
                    )
                `;
            }

            // Virtual season 1 has exactly one mapped episode (episodeRows[0]);
            // put its file in a denied group. Virtual season 2's episode file
            // stays ungrouped (allowed).
            const deniedGroupId = randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'C8R1 Ordering Denied Group')`;
            try {
                const [file] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
                    VALUES (${'/test/c8r1-ordering.mkv'}, ${deniedGroupId}::uuid, NOW(), NOW())
                    RETURNING id
                `;
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id)
                    VALUES (${file.id}::uuid, ${episodeRows[0].id}::uuid)
                `;

                const open = await getOrderingSeasons(sql, seriesId, user, unrestrictedAccess());
                expect(open.map((r) => r.season_number).sort()).toEqual([1, 2]);

                const restricted = await getOrderingSeasons(
                    sql,
                    seriesId,
                    user,
                    restrictedAccess({
                        deniedGroupIds: [deniedGroupId],
                        maxAgeRating: null,
                        allowUnrated: true,
                    }),
                );
                expect(restricted.map((r) => r.season_number).sort()).toEqual([2]);
            } finally {
                await sql`DELETE FROM library_groups WHERE id = ${deniedGroupId}::uuid`;
            }
        });

        it('maps a virtual season to a physical season the caller may see, with a stable tiebreak', async () => {
            const { seriesId } = await setupStandardSeries({
                seasonCount: 2,
                episodesPerSeason: 2,
            });
            const user: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, user);

            const eps = await sql<{ id: string; season_id: string; season_number: number }[]>`
                SELECT ep.id::text AS id, ep.parent_id::text AS season_id, season.season_number
                FROM media_items ep
                JOIN media_items season ON season.id = ep.parent_id
                WHERE season.parent_id = ${seriesId}::uuid AND ep.media_type = 'episode'
                ORDER BY season.season_number, ep.episode_number
            `;
            const s1 = eps.filter((e) => e.season_number === 1);
            const s2 = eps.filter((e) => e.season_number === 2);
            // Virtual season 1 = both season-1 episodes + one season-2 episode, so
            // by count it maps to physical season 1.
            const mapped = [...s1, s2[0]];

            await sql`
                INSERT INTO series_episode_ordering (media_id, ordering_type, ordering_group_id)
                VALUES (${seriesId}::uuid, 'dvd', 'g1')
            `;
            for (const [i, ep] of mapped.entries()) {
                await sql`
                    INSERT INTO episode_orderings (
                        series_media_id, episode_media_id, provider, provider_episode_id, ordering_type, ordering_group_id, original_season_number, original_episode_number, order_season_number, order_episode_number, fetched_at
                    ) VALUES (
                        ${seriesId}::uuid, ${ep.id}::uuid, 'tvdb', ${'map-' + i}, 'dvd', 'g1',
                        ${ep.season_number}, ${i + 1}, 1, ${i + 1}, NOW()
                    )
                `;
            }

            const open = await getOrderingSeasons(sql, seriesId, user, unrestrictedAccess());
            expect(open.map((r) => r.physical_season_id)).toEqual([s1[0].season_id]);

            // Season 1's episode files are in a denied group: the caller sees
            // virtual season 1 (via the season-2 episode) and it must map to
            // physical season 2, not leak the denied season's id.
            const deniedGroupId = randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'F3 Mapping Denied Group')`;
            try {
                for (const [i, ep] of s1.entries()) {
                    const [file] = await sql<{ id: string }[]>`
                        INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
                        VALUES (${`/test/f3-mapping-${i}.mkv`}, ${deniedGroupId}::uuid, NOW(), NOW())
                        RETURNING id
                    `;
                    await sql`
                        INSERT INTO media_file_items (file_id, media_item_id)
                        VALUES (${file.id}::uuid, ${ep.id}::uuid)
                    `;
                }

                const restricted = await getOrderingSeasons(
                    sql,
                    seriesId,
                    user,
                    restrictedAccess({
                        deniedGroupIds: [deniedGroupId],
                        maxAgeRating: null,
                        allowUnrated: true,
                    }),
                );
                expect(restricted.map((r) => r.season_number)).toEqual([1]);
                expect(restricted[0].physical_season_id).toBe(s2[0].season_id);
            } finally {
                await sql`DELETE FROM library_groups WHERE id = ${deniedGroupId}::uuid`;
            }
        });
    });

    // ========================================================================
    // getUnmappedPhysicalSeasons
    // ========================================================================

    describe('getUnmappedPhysicalSeasons', () => {
        it('returns seasons not in the active ordering', async () => {
            const { seriesId } = await setupStandardSeries({
                seasonCount: 2,
                episodesPerSeason: 2,
            });
            const user: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, user);

            // Set up a non-standard ordering where only some episodes are mapped
            await sql`
                INSERT INTO series_episode_ordering (media_id, ordering_type, ordering_group_id)
                VALUES (${seriesId}::uuid, 'dvd', 'g1')
            `;

            const rows = await getUnmappedPhysicalSeasons(
                sql,
                seriesId,
                user,
                unrestrictedAccess(),
            );
            // All physical seasons should be unmapped since we only inserted the ordering header
            expect(rows.length).toBe(2);
        });

        // C8 fix round 1 — same rationale as the getOrderingSeasons case above,
        // for the "unmapped physical season" half of the ordering branch.
        it('excludes an unmapped physical season whose only episode file is in a denied library group (C8 fix round 1)', async () => {
            const { seriesId } = await setupStandardSeries({
                seasonCount: 2,
                episodesPerSeason: 1,
            });
            const user: UserId = toUserId(randomUUID());
            await ensureTestUser(sql, user);

            await sql`
                INSERT INTO series_episode_ordering (media_id, ordering_type, ordering_group_id)
                VALUES (${seriesId}::uuid, 'dvd', 'g1')
            `;

            const season2Episode = await sql<{ id: string }[]>`
                SELECT ep.id
                FROM media_items season
                JOIN media_items ep ON ep.parent_id = season.id
                WHERE season.parent_id = ${seriesId}::uuid
                  AND season.media_type = 'season'
                  AND season.season_number = 2
                  AND ep.media_type = 'episode'
                LIMIT 1
            `;

            const deniedGroupId = randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${deniedGroupId}::uuid, 'C8R1 Unmapped Denied Group')`;
            try {
                const [file] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path, library_group_id, created_at, updated_at)
                    VALUES (${'/test/c8r1-unmapped.mkv'}, ${deniedGroupId}::uuid, NOW(), NOW())
                    RETURNING id
                `;
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id)
                    VALUES (${file.id}::uuid, ${season2Episode[0].id}::uuid)
                `;

                const open = await getUnmappedPhysicalSeasons(
                    sql,
                    seriesId,
                    user,
                    unrestrictedAccess(),
                );
                expect(open.map((r) => r.season_number).sort()).toEqual([1, 2]);

                const restricted = await getUnmappedPhysicalSeasons(
                    sql,
                    seriesId,
                    user,
                    restrictedAccess({
                        deniedGroupIds: [deniedGroupId],
                        maxAgeRating: null,
                        allowUnrated: true,
                    }),
                );
                expect(restricted.map((r) => r.season_number).sort()).toEqual([1]);
            } finally {
                await sql`DELETE FROM library_groups WHERE id = ${deniedGroupId}::uuid`;
            }
        });
    });
});
