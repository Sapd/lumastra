// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration Tests for Series Health Query Module
 *
 * Tests getEpisodeIdsForSeries, countEpisodesForSeries, countEpisodesForSeason,
 * getEpisodeGapsFromCatalog, getSeriesEpisodeCoverage.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestSeries } from '../../../../../tests/integration/fixtures/index.js';

import {
    getEpisodeIdsForSeries,
    countEpisodesForSeries,
    countEpisodesForSeason,
    getEpisodeGapsFromCatalog,
    getSeriesEpisodeCoverage,
    getSeasonCoverageBatch,
} from './series-health.queries.js';

describe('Series Health Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media]);
    });

    // ========================================================================
    // getEpisodeIdsForSeries
    // ========================================================================

    describe('getEpisodeIdsForSeries', () => {
        it('returns episode IDs for a series', async () => {
            const { seriesId, seasons: _seasons } = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 3,
            });

            const ids = await getEpisodeIdsForSeries(sql, seriesId);

            expect(ids.length).toBe(3);
        });

        it('returns empty array for series with no episodes', async () => {
            const { seriesId } = await createAndInsertTestSeries(sql, {
                seasonCount: 0,
                episodesPerSeason: 0,
            });

            const ids = await getEpisodeIdsForSeries(sql, seriesId);
            expect(ids).toEqual([]);
        });
    });

    // ========================================================================
    // countEpisodesForSeries
    // ========================================================================

    describe('countEpisodesForSeries', () => {
        it('counts episodes through season hierarchy', async () => {
            const { seriesId } = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 5,
            });

            const count = await countEpisodesForSeries(sql, seriesId);
            expect(count).toBe(10);
        });

        it('returns 0 for empty series', async () => {
            const { seriesId } = await createAndInsertTestSeries(sql, {
                seasonCount: 0,
                episodesPerSeason: 0,
            });

            const count = await countEpisodesForSeries(sql, seriesId);
            expect(count).toBe(0);
        });
    });

    // ========================================================================
    // countEpisodesForSeason
    // ========================================================================

    describe('countEpisodesForSeason', () => {
        it('counts episodes for a specific season', async () => {
            const { seriesId, seasons: _seasons } = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 4,
            });

            // Fetch season media_item UUIDs
            const seasonRows = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id = ${seriesId}::uuid AND media_type = 'season'
                ORDER BY season_number
            `;

            const count1 = await countEpisodesForSeason(sql, seasonRows[0].id);
            expect(count1).toBe(4);
        });

        it('returns 0 for season with no episodes', async () => {
            const { seriesId } = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 0,
            });

            const seasonRows = await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id = ${seriesId}::uuid AND media_type = 'season'
                LIMIT 1
            `;

            const count = await countEpisodesForSeason(sql, seasonRows[0].id);
            expect(count).toBe(0);
        });
    });

    // ========================================================================
    // getEpisodeGapsFromCatalog
    // ========================================================================

    describe('getEpisodeGapsFromCatalog', () => {
        let tmdbSeq = 900_000;

        interface Ep {
            season: number;
            episode: number;
            hasFiles: boolean;
            /** Provider id on the episode row — false models an unmatched scanner row. */
            identified?: boolean;
            /** Days from today; negative = aired. Null = undated. */
            airedInDays?: number | null;
        }

        async function series(title: string, episodes: Ep[]): Promise<string> {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES (${title}, 'tv', 'active') RETURNING id
            `;
            const seasonIds = new Map<number, string>();
            for (const ep of episodes) {
                let seasonId = seasonIds.get(ep.season);
                if (!seasonId) {
                    const [season] = await sql<{ id: string }[]>`
                        INSERT INTO media_items (title, media_type, status, parent_id, season_number)
                        VALUES (${`${title} S${ep.season}`}, 'season', 'active', ${row.id}, ${ep.season})
                        RETURNING id
                    `;
                    seasonId = season.id;
                    seasonIds.set(ep.season, seasonId);
                }
                const days = ep.airedInDays === undefined ? -30 : ep.airedInDays;
                const [e] = await sql<{ id: string }[]>`
                    INSERT INTO media_items
                        (title, media_type, status, parent_id, season_number, episode_number,
                         has_files, premiere_date)
                    VALUES (${`${title} ${ep.season}x${ep.episode}`}, 'episode', 'active', ${seasonId},
                            ${ep.season}, ${ep.episode}, ${ep.hasFiles},
                            ${days === null ? null : sql`CURRENT_DATE + ${days}::int`})
                    RETURNING id
                `;
                if (ep.identified !== false) {
                    await sql`
                        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                        VALUES (${e.id}::uuid, 'tmdb', ${String(tmdbSeq++)}, 'episode', true)
                    `;
                }
            }
            return row.id;
        }

        const eps = (
            season: number,
            from: number,
            to: number,
            rest: Omit<Ep, 'season' | 'episode'>,
        ): Ep[] =>
            Array.from({ length: to - from + 1 }, (_, i) => ({
                season,
                episode: from + i,
                ...rest,
            }));

        it('keeps unidentified empty-file seasons unknown and derives a missing episode season from its parent', async () => {
            const id = await series('Unidentified Harbor', [
                { season: 1, episode: 1, hasFiles: false, identified: false },
                { season: 2, episode: 1, hasFiles: true },
                { season: 3, episode: 1, hasFiles: false },
            ]);
            await sql`UPDATE media_items SET season_number=null WHERE media_type='episode' AND parent_id IN (SELECT id FROM media_items WHERE parent_id=${id})`;
            await sql`UPDATE media_items SET season_number=null WHERE parent_id=${id} AND season_number=3`;
            const rows = await getSeasonCoverageBatch(sql, 'tmdb', [id]);
            expect(rows.find((row) => row.seasonNumber === 1)).toMatchObject({
                identified: 0,
                missing: null,
            });
            expect(rows.find((row) => row.seasonNumber === 2)).toMatchObject({
                identified: 1,
                held: 1,
                missing: 0,
            });
            expect(rows.find((row) => row.seasonNumber === null)).toMatchObject({
                catalog: 1,
                missing: null,
            });
            expect(rows.some((row) => row.seasonNumber === 0)).toBe(false);
            expect(await getSeriesEpisodeCoverage(sql, 'tmdb', id)).toMatchObject({
                episodesHeld: 1,
                episodesListed: 1,
                seasonsHeld: 1,
                seasonsListed: 1,
                missing: 0,
            });
        });
        it('batches regular coverage, isolates specials, and keeps conflicted missing unknown', async () => {
            const id = await series('Lantern Harbor', [
                { season: 1, episode: 1, hasFiles: true },
                { season: 1, episode: 2, hasFiles: false },
                { season: 1, episode: 3, hasFiles: false, airedInDays: 30 },
                { season: 2, episode: 1, hasFiles: true, identified: false },
                { season: 0, episode: 1, hasFiles: true },
            ]);
            const rows = await getSeasonCoverageBatch(sql, 'tmdb', [id]);
            expect(rows.map((row) => row.seasonNumber)).toEqual([1, 2, 0]);
            expect(rows[0]).toMatchObject({
                held: 1,
                listed: 2,
                catalog: 3,
                missing: null,
                conflicted: true,
            });
            expect(rows[2]).toMatchObject({ held: 1, listed: 1, catalog: 1 });
            expect(await getSeasonCoverageBatch(sql, 'tmdb', [])).toEqual([]);
        });

        it('counts aired provider episodes without a file, ignoring specials and unaired', async () => {
            const id = await series('Gappy', [
                ...eps(1, 1, 8, { hasFiles: true }),
                ...eps(1, 9, 10, { hasFiles: false }),
                ...eps(2, 1, 3, { hasFiles: false }),
                ...eps(2, 4, 5, { hasFiles: false, airedInDays: 7 }),
                ...eps(2, 6, 6, { hasFiles: false, airedInDays: null }),
                ...eps(0, 1, 4, { hasFiles: false }),
            ]);

            const r = await getEpisodeGapsFromCatalog(sql, 'tmdb', 25);

            expect(r.seriesWithFiles).toBe(1);
            expect(r.seriesWithGaps).toBe(1);
            expect(r.missingTotal).toBe(5);
            expect(r.gaps).toEqual([
                { series_id: id, title: 'Gappy', held: 8, missing: 5, seasons_affected: 2 },
            ]);
        });

        it('never reports a series whose files the provider did not match (renumbered duplicates)', async () => {
            // Sky Harbor on prod: files S08E01-35 unmatched, TMDB rows S08E229-263 — all on disk.
            await series('Renumbered', [
                ...eps(8, 1, 5, { hasFiles: true, identified: false }),
                ...eps(8, 229, 233, { hasFiles: false }),
            ]);
            // Bleach on prod: the conflict spans seasons, not one season.
            await series('Relayout', [
                ...eps(1, 1, 10, { hasFiles: false }),
                ...eps(3, 1, 10, { hasFiles: true, identified: false }),
            ]);

            const r = await getEpisodeGapsFromCatalog(sql, 'tmdb', 25);

            expect(r.seriesWithFiles).toBe(2);
            expect(r.conflictedSeries).toBe(2);
            expect(r.seriesWithGaps).toBe(0);
            expect(r.missingTotal).toBe(0);
            expect(r.gaps).toEqual([]);
        });

        it('reports a series with files but no provider episode list as unmeasured, not healthy', async () => {
            await series('Home videos', eps(1, 1, 3, { hasFiles: true, identified: false }));
            await series('Wishlist only', eps(1, 1, 3, { hasFiles: false }));

            const r = await getEpisodeGapsFromCatalog(sql, 'tmdb', 25);

            // 'Wishlist only' holds nothing, so it is outside the denominator entirely.
            expect(r.seriesWithFiles).toBe(1);
            expect(r.unmeasuredSeries).toBe(1);
            expect(r.gaps).toEqual([]);
        });

        it('returns the totals with an empty list when nothing is missing', async () => {
            await series('Complete', eps(1, 1, 4, { hasFiles: true }));

            const r = await getEpisodeGapsFromCatalog(sql, 'tmdb', 25);

            expect(r).toMatchObject({
                seriesWithFiles: 1,
                unmeasuredSeries: 0,
                conflictedSeries: 0,
                seriesWithGaps: 0,
                missingTotal: 0,
                gaps: [],
            });
        });

        it('caps the list but not the totals, biggest gap first', async () => {
            await series('Small', [
                ...eps(1, 1, 1, { hasFiles: true }),
                ...eps(1, 2, 2, { hasFiles: false }),
            ]);
            await series('Big', [
                ...eps(1, 1, 1, { hasFiles: true }),
                ...eps(1, 2, 4, { hasFiles: false }),
            ]);

            const r = await getEpisodeGapsFromCatalog(sql, 'tmdb', 1);

            expect(r.seriesWithGaps).toBe(2);
            expect(r.missingTotal).toBe(4);
            expect(r.gaps.map((g) => g.title)).toEqual(['Big']);
        });

        // getSeriesEpisodeCoverage shares the CTEs, so it rides on the same fixtures.

        it('reads one series by the same rules, ignoring its neighbours', async () => {
            const id = await series('Gappy', [
                ...eps(1, 1, 8, { hasFiles: true }),
                ...eps(1, 9, 10, { hasFiles: false }),
                ...eps(2, 1, 3, { hasFiles: false }),
                ...eps(2, 4, 5, { hasFiles: false, airedInDays: 7 }),
                ...eps(0, 1, 4, { hasFiles: false }),
            ]);
            await series('Neighbour', eps(1, 1, 5, { hasFiles: false }));

            expect(await getSeriesEpisodeCoverage(sql, 'tmdb', id)).toEqual({
                episodesHeld: 8,
                episodesListed: 13,
                missing: 5,
                seasonsHeld: 1,
                seasonsListed: 2,
                identified: 19,
                conflicted: false,
            });
        });

        it('zeroes missing for a renumbered series and flags the conflict', async () => {
            const id = await series('Renumbered', [
                ...eps(8, 1, 5, { hasFiles: true, identified: false }),
                ...eps(8, 229, 233, { hasFiles: false }),
            ]);

            expect(await getSeriesEpisodeCoverage(sql, 'tmdb', id)).toMatchObject({
                missing: 0,
                conflicted: true,
            });
        });

        it('returns null for a series with no episode rows', async () => {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES ('Empty', 'tv', 'active') RETURNING id
            `;

            expect(await getSeriesEpisodeCoverage(sql, 'tmdb', row.id)).toBeNull();
        });
    });
});
