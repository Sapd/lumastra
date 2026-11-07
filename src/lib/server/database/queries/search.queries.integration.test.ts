// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration Tests for Search Queries
 *
 * Tests run against real PostgreSQL with pg_trgm extension (ref: DL-007).
 * Query-level tests cover the most complex logic (SQL ranking, trigram matching, FTS)
 * with high confidence — the search endpoints have heavy external dependencies
 * (Jellyfin, Kavita, Audiobookshelf, Jellyseerr) that cannot be reliably mocked.
 *
 * Follow setup pattern from media-lookup.queries.integration.test.ts.
 *
 * Covers:
 * - searchMedia: exact title match, no-match, mediaTypes filter, yearMin/yearMax filter
 * - searchMediaFulltext: match_source values, title rank vs overview rank
 * - searchEpisode: season/episode number pattern
 * - findSeriesContext: series info retrieval
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    createTestExternalIds,
    insertTestMediaItem,
    insertTestExternalIds,
    createAndInsertTestSeries,
    insertTestSeason,
    insertTestEpisode,
    createTestEpisode,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    searchMedia,
    searchMediaFulltext,
    searchEpisode,
    findSeriesContext,
    getSeasonCountsBySeriesIds,
    searchAdminQuickNav,
    buildExactPrefixTitleBoost,
} from './search.queries.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Insert a row into media_files + media_file_items to mark a media item as available.
 * searchMedia, searchMediaFulltext, and findSeriesContext all use media_file_items for
 * the availableOnly filter.
 */
async function insertMediaFileItem(
    sql: postgres.Sql,
    mediaItemId: string,
    filePath: string,
): Promise<void> {
    const reserved = await sql.reserve();
    try {
        const rSql = reserved as unknown as postgres.Sql;
        const [{ id: fileId }] = await rSql<[{ id: string }]>`
            INSERT INTO media_files (file_path)
            VALUES (${filePath})
            ON CONFLICT (file_path) DO UPDATE SET updated_at = NOW()
            RETURNING id
        `;
        await rSql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${fileId}::uuid, ${mediaItemId}::uuid)
            ON CONFLICT DO NOTHING
        `;
        await rSql`
            UPDATE media_items SET has_files = true WHERE id = ${mediaItemId}::uuid
        `;
    } finally {
        reserved.release();
    }
}

/**
 * Insert a media item with provider_metadata, media_file_items, and external IDs.
 * Used to satisfy all JOIN conditions in searchMedia and searchMediaFulltext.
 */
async function insertMediaWithMetadata(
    sql: postgres.Sql,
    options: {
        title: string;
        mediaType: 'movie' | 'tv';
        year?: number;
        tmdbId: number;
        jellyfinId: string;
        overview?: string;
        actors?: string[];
        directors?: string[];
        keywords?: string[];
        mdblistKeywords?: string[];
        popularity?: number;
    },
): Promise<string> {
    const item = createTestMediaItem({
        title: options.title,
        media_type: options.mediaType,
        year: options.year ?? 2024,
        status: 'active',
    });

    const metadata: Record<string, postgres.JSONValue> = {
        popularity: options.popularity ?? 50,
    };
    if (options.overview) metadata.overview = options.overview;
    if (options.actors) metadata.actors = options.actors;
    if (options.directors) metadata.directors = options.directors;
    if (options.keywords) metadata.keywords = options.keywords;
    if (options.mdblistKeywords) metadata.mdblist_keywords = options.mdblistKeywords;

    const reserved = await sql.reserve();
    try {
        const rSql = reserved as unknown as postgres.Sql;

        await insertTestMediaItem(rSql, item);

        if (options.overview) {
            await rSql`UPDATE media_items SET overview = ${options.overview} WHERE id = ${item.id}::uuid`;
        }

        const externalIds = createTestExternalIds(item.id, {
            tmdbId: options.tmdbId,
            jellyfinId: options.jellyfinId,
            mediaType: options.mediaType,
        });
        await insertTestExternalIds(rSql, externalIds);

        const [{ id: fileId }] = await rSql<[{ id: string }]>`
            INSERT INTO media_files (file_path)
            VALUES (${`/test/media/${options.jellyfinId}.mkv`})
            ON CONFLICT (file_path) DO UPDATE SET updated_at = NOW()
            RETURNING id
        `;
        await rSql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${fileId}::uuid, ${item.id}::uuid)
            ON CONFLICT DO NOTHING
        `;
        await rSql`
            UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid
        `;

        await rSql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${item.id}::uuid, 'tmdb', ${rSql.json(metadata)})
        `;
    } finally {
        reserved.release();
    }

    return item.id;
}

// =============================================================================
// Tests
// =============================================================================

describe('Search Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    // =========================================================================
    // searchMedia
    // =========================================================================

    describe('searchMedia', () => {
        it('supports filter-only searches and case-insensitive canonical genre filters', async () => {
            const action = await insertMediaWithMetadata(sql, {
                title: 'Search Filter Action',
                mediaType: 'movie',
                year: 2020,
                tmdbId: 7770980,
                jellyfinId: 'jf-filter-action',
            });
            const comedy = await insertMediaWithMetadata(sql, {
                title: 'Search Filter Comedy',
                mediaType: 'movie',
                year: 2019,
                tmdbId: 7770981,
                jellyfinId: 'jf-filter-comedy',
            });
            await sql`INSERT INTO media_genres (media_id, source, genre_id, genre_name)
                VALUES (${action}::uuid, 'tmdb', 28, 'Action'), (${comedy}::uuid, 'tmdb', 35, 'Komödie')`;
            for (const search of [searchMedia, searchMediaFulltext]) {
                const filtered = await search(sql, '*', unrestrictedAccess(), {
                    filters: { yearMin: 2020, yearMax: 2020, genres: ['action'] },
                });
                expect(filtered.map((row) => row.internal_id)).toEqual([action]);
                const named = await search(sql, 'Search Filter', unrestrictedAccess(), {
                    filters: { genres: ['comedy'] },
                });
                expect(named.map((row) => row.internal_id)).toEqual([comedy]);
            }
        });

        it('excludes description-only matches until explicitly enabled', async () => {
            const id = await insertMediaWithMetadata(sql, {
                title: 'Quiet Orbit',
                mediaType: 'movie',
                tmdbId: 7770990,
                jellyfinId: 'jf-description-toggle',
                overview: 'A mysterious spaceship arrives.',
            });
            expect(await searchMedia(sql, 'spaceship', unrestrictedAccess())).toHaveLength(0);
            expect(
                await searchMediaFulltext(sql, 'spaceship', unrestrictedAccess(), {
                    includeDescriptions: false,
                }),
            ).toHaveLength(0);
            const expanded = await searchMediaFulltext(sql, 'spaceship', unrestrictedAccess());
            expect(expanded.map((row) => row.internal_id)).toContain(id);
            expect(expanded[0].match_source).toBe('overview');
        });

        it('requires every query term in titles when descriptions are off', async () => {
            await insertMediaWithMetadata(sql, {
                title: 'Quiet Orbit',
                mediaType: 'movie',
                tmdbId: 7770991,
                jellyfinId: 'jf-mixed-description',
                overview: 'A mysterious spaceship arrives.',
            });
            expect(await searchMedia(sql, 'quiet spaceship', unrestrictedAccess())).toHaveLength(0);
            const expanded = await searchMediaFulltext(
                sql,
                'quiet spaceship',
                unrestrictedAccess(),
            );
            expect(expanded).toHaveLength(1);
            expect(expanded[0].match_source).toBe('overview');
        });
        it('returns results for an exact title match with rank > 0', async () => {
            await insertMediaWithMetadata(sql, {
                title: 'Zephyra Chronicles',
                mediaType: 'movie',
                tmdbId: 7770001,
                jellyfinId: 'jf-zephyra-001',
            });

            const results = await searchMedia(sql, 'Zephyra', unrestrictedAccess(), {
                availableOnly: true,
            });

            expect(results.length).toBeGreaterThan(0);
            expect(results[0].title).toBe('Zephyra Chronicles');
            expect(Number(results[0].rank)).toBeGreaterThan(0);
        });

        it('returns empty array for a query that matches nothing', async () => {
            await insertMediaWithMetadata(sql, {
                title: 'Mundane Entry',
                mediaType: 'movie',
                tmdbId: 7770002,
                jellyfinId: 'jf-mundane-002',
            });

            const results = await searchMedia(sql, 'Xyzplonk99', unrestrictedAccess(), {
                availableOnly: false,
            });

            expect(results).toHaveLength(0);
        });

        it('applies strict file-backed filtering before limit and offset', async () => {
            const stale = createTestMediaItem({
                title: 'Strict Search',
                media_type: 'movie',
                has_files: true,
                status: 'active',
            });
            await insertTestMediaItem(sql, stale);

            const availableId = await insertMediaWithMetadata(sql, {
                title: 'Strict Search Available',
                mediaType: 'movie',
                tmdbId: 7_770_099,
                jellyfinId: 'jf-strict-search-available',
            });

            const results = await searchMedia(sql, 'Strict Search', unrestrictedAccess(), {
                limit: 1,
                fileBackedOnly: true,
            });

            expect(results.map((result) => result.internal_id)).toEqual([availableId]);
        });

        it('respects mediaTypes filter: movie vs tv', async () => {
            await insertMediaWithMetadata(sql, {
                title: 'Veloria Quest',
                mediaType: 'movie',
                tmdbId: 7770003,
                jellyfinId: 'jf-veloria-movie-003',
            });
            await insertMediaWithMetadata(sql, {
                title: 'Veloria Quest',
                mediaType: 'tv',
                tmdbId: 7770004,
                jellyfinId: 'jf-veloria-tv-004',
            });

            const movieResults = await searchMedia(sql, 'Veloria Quest', unrestrictedAccess(), {
                mediaTypes: ['movie'],
                availableOnly: false,
            });
            const tvResults = await searchMedia(sql, 'Veloria Quest', unrestrictedAccess(), {
                mediaTypes: ['tv'],
                availableOnly: false,
            });

            expect(movieResults.every((r) => r.media_type === 'movie')).toBe(true);
            expect(tvResults.every((r) => r.media_type === 'tv')).toBe(true);
        });

        it('respects yearMin/yearMax filters', async () => {
            await insertMediaWithMetadata(sql, {
                title: 'Fenwick Early',
                mediaType: 'movie',
                year: 2010,
                tmdbId: 7770005,
                jellyfinId: 'jf-fenwick-2010-005',
            });
            await insertMediaWithMetadata(sql, {
                title: 'Fenwick Late',
                mediaType: 'movie',
                year: 2022,
                tmdbId: 7770006,
                jellyfinId: 'jf-fenwick-2022-006',
            });

            const recentResults = await searchMedia(sql, 'Fenwick', unrestrictedAccess(), {
                availableOnly: false,
                filters: { yearMin: 2015 },
            });

            expect(
                recentResults.every((r) => {
                    const year = r.release_date
                        ? new Date(String(r.release_date)).getFullYear()
                        : null;
                    return year === null || year >= 2015;
                }),
            ).toBe(true);
            expect(recentResults.some((r) => r.title === 'Fenwick Late')).toBe(true);
            expect(recentResults.some((r) => r.title === 'Fenwick Early')).toBe(false);
        });

        it('ranks an exact title match above a longer prefix match', async () => {
            // FTS prefix (up:*) matches both, but the exact-title boost must lift
            // the whole-title match above the longer "starts-with" match.
            await insertMediaWithMetadata(sql, {
                title: 'Up',
                mediaType: 'movie',
                tmdbId: 7790101,
                jellyfinId: 'jf-up-101',
            });
            await insertMediaWithMetadata(sql, {
                title: 'Uptown Funk Story',
                mediaType: 'movie',
                tmdbId: 7790102,
                jellyfinId: 'jf-up-102',
            });

            const results = await searchMedia(sql, 'Up', unrestrictedAccess(), {
                availableOnly: true,
            });
            const up = results.find((r) => r.title === 'Up');
            const uptown = results.find((r) => r.title === 'Uptown Funk Story');

            expect(up).toBeDefined();
            expect(results[0].title).toBe('Up');
            expect(Number(up?.rank)).toBeGreaterThan(Number(uptown?.rank ?? 0));
        });

        it('paginates with limit + offset without overlap', async () => {
            // Distinct popularity → deterministic rank order: One > Two > Three.
            await insertMediaWithMetadata(sql, {
                title: 'Paginas One',
                mediaType: 'movie',
                tmdbId: 7790201,
                jellyfinId: 'jf-pag-1',
                popularity: 90,
            });
            await insertMediaWithMetadata(sql, {
                title: 'Paginas Two',
                mediaType: 'movie',
                tmdbId: 7790202,
                jellyfinId: 'jf-pag-2',
                popularity: 60,
            });
            await insertMediaWithMetadata(sql, {
                title: 'Paginas Three',
                mediaType: 'movie',
                tmdbId: 7790203,
                jellyfinId: 'jf-pag-3',
                popularity: 30,
            });

            const page1 = await searchMedia(sql, 'Paginas', unrestrictedAccess(), {
                availableOnly: true,
                limit: 2,
            });
            const page2 = await searchMedia(sql, 'Paginas', unrestrictedAccess(), {
                availableOnly: true,
                limit: 2,
                offset: 2,
            });

            expect(page1).toHaveLength(2);
            expect(page2.length).toBeGreaterThanOrEqual(1);
            const page1Ids = new Set(page1.map((r) => r.title));
            // No overlap between the two pages.
            expect(page2.every((r) => !page1Ids.has(r.title))).toBe(true);
        });

        it('matches localized titles from media_titles with indexed substring search', async () => {
            const movieId = await insertMediaWithMetadata(sql, {
                title: 'The Keeper of the Lanterns: The Gathering of the Lantern',
                mediaType: 'movie',
                year: 2001,
                tmdbId: 12000101,
                jellyfinId: 'jf-lotr-localized-001',
                popularity: 100,
            });

            await sql`
                INSERT INTO media_titles (media_id, title, language, kind, source)
                VALUES (
                    ${movieId}::uuid,
                    'Der Hüter der Lichter: Die Begleiter',
                    'de',
                    'localized',
                    'test'
                )
            `;

            const results = await searchMedia(sql, 'hüter der lichter', unrestrictedAccess(), {
                mediaTypes: ['movie'],
                availableOnly: true,
            });

            expect(results.some((r) => r.internal_id === movieId)).toBe(true);
        });
    });

    // =========================================================================
    // Ranking of localized and exact titles (searchMedia + searchMediaFulltext)
    // =========================================================================

    describe('exact title ranking', () => {
        // Prod 2026-11-07: "haus des geldes" ranked "The Color of Money" (German
        // "Die Farbe des Geldes", a fuzzy lookalike) above "Money Heist" (whose
        // German title it is exactly), because every localized hit tied.
        async function seedHeistPair(): Promise<{ exactId: string; lookalikeId: string }> {
            const exactId = await insertMediaWithMetadata(sql, {
                title: 'Vault Robbers',
                mediaType: 'tv',
                year: 2017,
                tmdbId: 12000201,
                jellyfinId: 'jf-rank-exact-001',
                popularity: 10,
            });
            const lookalikeId = await insertMediaWithMetadata(sql, {
                title: 'Colour of Coins',
                mediaType: 'movie',
                year: 1986,
                tmdbId: 12000202,
                jellyfinId: 'jf-rank-lookalike-001',
                popularity: 500,
            });
            await sql`
                INSERT INTO media_titles (media_id, title, language, kind, source) VALUES
                    (${exactId}::uuid, 'Haus des Geldes', 'de', 'localized', 'test'),
                    (${lookalikeId}::uuid, 'Die Farbe des Geldes', 'de', 'localized', 'test')
            `;
            return { exactId, lookalikeId };
        }

        for (const [name, run] of [
            [
                'searchMedia',
                (q: string) =>
                    searchMedia(sql, q, unrestrictedAccess(), { mediaTypes: ['movie', 'tv'] }),
            ],
            [
                'searchMediaFulltext',
                (q: string) =>
                    searchMediaFulltext(sql, q, unrestrictedAccess(), {
                        mediaTypes: ['movie', 'tv'],
                    }),
            ],
        ] as const) {
            it(`${name}: an exact localized title outranks a more popular fuzzy lookalike`, async () => {
                const { exactId, lookalikeId } = await seedHeistPair();
                const ids = (await run('haus des geldes')).map((r) => r.internal_id);
                // The lookalike must really be in the result, or the order proves nothing.
                expect(ids).toContain(lookalikeId);
                expect(ids[0]).toBe(exactId);
            });

            it(`${name}: an exact primary title wins regardless of case`, async () => {
                const exactId = await insertMediaWithMetadata(sql, {
                    title: 'Zorblat',
                    mediaType: 'movie',
                    year: 2001,
                    tmdbId: 12000203,
                    jellyfinId: 'jf-rank-case-001',
                    popularity: 1,
                });
                const longerId = await insertMediaWithMetadata(sql, {
                    title: 'Zorblat Returns',
                    mediaType: 'movie',
                    year: 2004,
                    tmdbId: 12000204,
                    jellyfinId: 'jf-rank-case-002',
                    popularity: 900,
                });
                // Mixed case and a trailing space: neither may cost the exact boost.
                const ids = (await run('ZorBLAT ')).map((r) => r.internal_id);
                expect(ids).toContain(longerId);
                expect(ids[0]).toBe(exactId);
            });

            it(`${name}: a localized title that starts with the query outranks a lookalike`, async () => {
                const { exactId, lookalikeId } = await seedHeistPair();
                const ids = (await run('haus des gelde')).map((r) => r.internal_id);
                expect(ids).toContain(lookalikeId);
                expect(ids[0]).toBe(exactId);
            });
        }

        it('the boost treats % and _ in the query as literals, on both kinds of title', async () => {
            const { exactId } = await seedHeistPair();
            const boost = async (q: string, includeLocalized = true) => {
                const [row] = await sql<{ b: number }[]>`
                    SELECT (${buildExactPrefixTitleBoost(sql, q, { includeLocalized })})::float AS b
                    FROM media_items mi WHERE mi.id = ${exactId}::uuid
                `;
                return Number(row?.b);
            };
            expect(await boost('haus des geldes')).toBe(5); // localized exact
            expect(await boost('Haus des')).toBe(1); // localized prefix
            expect(await boost('haus des geldes', false)).toBe(0); // opt-out
            expect(await boost('ha')).toBe(0); // below the 3-character gate
            expect(await boost('haus%')).toBe(0); // literal %, not a wildcard
            expect(await boost('h_us des')).toBe(0); // literal _, not a wildcard
            expect(await boost('vault%')).toBe(0); // primary prefix escapes too
            expect(await boost(' VAULT ROBBERS ')).toBe(5); // primary exact: trim + case
        });

        it('searchAdminQuickNav: an exact localized title outranks a fuzzy lookalike', async () => {
            const { exactId, lookalikeId } = await seedHeistPair();
            const rows = await searchAdminQuickNav(
                sql,
                'haus des geldes',
                unrestrictedAccess(),
                30,
            );
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(lookalikeId);
            expect(ids.indexOf(exactId)).toBeLessThan(ids.indexOf(lookalikeId));
        });
    });

    // =========================================================================
    // searchMediaFulltext
    // =========================================================================

    describe('searchMediaFulltext', () => {
        it('returns results with match_source set to title for a title match', async () => {
            await insertMediaWithMetadata(sql, {
                title: 'Quarrix Saga',
                mediaType: 'movie',
                tmdbId: 7770010,
                jellyfinId: 'jf-quarrix-010',
            });

            const results = await searchMediaFulltext(sql, 'Quarrix', unrestrictedAccess(), {
                availableOnly: true,
            });

            expect(results.length).toBeGreaterThan(0);
            expect(results[0].title).toBe('Quarrix Saga');
            expect(results[0].match_source).toBe('title');
        });

        it('ranks title matches higher than overview matches', async () => {
            await insertMediaWithMetadata(sql, {
                title: 'Drendaxis',
                mediaType: 'movie',
                tmdbId: 7770011,
                jellyfinId: 'jf-drendaxis-title-011',
                overview: 'A story about something else entirely.',
            });
            await insertMediaWithMetadata(sql, {
                title: 'Unrelated Item',
                mediaType: 'movie',
                tmdbId: 7770012,
                jellyfinId: 'jf-drendaxis-overview-012',
                overview: 'A documentary about the Drendaxis phenomenon.',
                popularity: 10,
            });

            const results = await searchMediaFulltext(sql, 'Drendaxis', unrestrictedAccess(), {
                availableOnly: false,
            });

            const titleMatch = results.find((r) => r.title === 'Drendaxis');
            const overviewMatch = results.find((r) => r.title === 'Unrelated Item');
            expect(titleMatch).toBeDefined();
            expect(overviewMatch).toBeDefined();
            expect(Number(titleMatch!.rank)).toBeGreaterThan(Number(overviewMatch!.rank));
        });

        it('searchMediaFulltext keeps title > overview > keyword ordering (rank guardrail)', async () => {
            // Title hit: the search word IS the title
            const titleHitId = await insertMediaWithMetadata(sql, {
                title: 'Zephyr',
                mediaType: 'movie',
                tmdbId: 7779901,
                jellyfinId: 'jf-zephyr-title-9901',
            });
            // Overview hit: the search word appears only in the overview text
            const overviewHitId = await insertMediaWithMetadata(sql, {
                title: 'Other GuardrailA',
                mediaType: 'movie',
                tmdbId: 7779902,
                jellyfinId: 'jf-zephyr-overview-9902',
                overview: 'a tale of zephyr winds',
            });
            // Keyword hit: the search word appears only in provider_metadata keywords
            const keywordHitId = await insertMediaWithMetadata(sql, {
                title: 'Other GuardrailB',
                mediaType: 'movie',
                tmdbId: 7779903,
                jellyfinId: 'jf-zephyr-keyword-9903',
                keywords: ['zephyr'],
            });

            const results = await searchMediaFulltext(sql, 'zephyr', unrestrictedAccess(), {
                availableOnly: true,
            });
            const order = results.map((r) => r.internal_id);

            expect(order.indexOf(titleHitId)).toBeGreaterThanOrEqual(0);
            expect(order.indexOf(overviewHitId)).toBeGreaterThanOrEqual(0);
            expect(order.indexOf(keywordHitId)).toBeGreaterThanOrEqual(0);
            expect(order.indexOf(titleHitId)).toBeLessThan(order.indexOf(overviewHitId));
            expect(order.indexOf(overviewHitId)).toBeLessThan(order.indexOf(keywordHitId));
        });
    });

    // =========================================================================
    // searchEpisode
    // =========================================================================

    describe('searchEpisode', () => {
        it('returns episodes matching by series name and season/episode number', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Braxon Colony',
                seasonCount: 1,
                episodesPerSeason: 0,
            });

            const seasonJellyfinId = `jf-braxon-season-${crypto.randomUUID().slice(0, 8)}`;
            const seasonId = await insertTestSeason(
                sql,
                {
                    jellyfin_id: seasonJellyfinId,
                    series_jellyfin_id: series.seriesJellyfinId,
                    season_number: 2,
                    episode_count: 1,
                },
                series.seriesId,
            );

            const ep = createTestEpisode(series.seriesJellyfinId, 2, 5, {
                title: 'Braxon Colony S02E05',
            });
            await insertTestEpisode(sql, ep, seasonId);

            const results = await searchEpisode(sql, 'Braxon Colony', 2, 5, unrestrictedAccess());

            expect(results.length).toBeGreaterThan(0);
            expect(results[0].season_number).toBe(2);
            expect(results[0].episode_number).toBe(5);
            expect(results[0].series_name).toBe('Braxon Colony');
        });
    });

    // =========================================================================
    // findSeriesContext
    // =========================================================================

    describe('findSeriesContext', () => {
        it('returns series info when the series exists in the database', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Korrath Lineage',
                seasonCount: 2,
                episodesPerSeason: 3,
            });

            // findSeriesContext requires media_file_items entry for availability check
            await insertMediaFileItem(sql, series.seriesId, '/test/media/jf-korrath-series.mkv');

            const result = await findSeriesContext(sql, 'Korrath Lineage', unrestrictedAccess());

            expect(result.found).toBe(true);
            expect(result.title).toBe('Korrath Lineage');
            expect(result.internal_id).toBeDefined();
        });

        it('returns found=false when no series matches the name', async () => {
            const result = await findSeriesContext(
                sql,
                'Nonexistent Series Xyzabc',
                unrestrictedAccess(),
            );

            expect(result.found).toBe(false);
        });
    });

    // =========================================================================
    // getSeasonCountsBySeriesIds (UUID-first; regression: counts were keyed by
    // Jellyfin id but search results carry the internal UUID, so they never matched)
    // =========================================================================

    describe('getSeasonCountsBySeriesIds', () => {
        it('counts seasons keyed by the series internal UUID', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Vantyr Saga',
                tmdbId: 8880001,
                seasonCount: 3,
                episodesPerSeason: 0,
            });

            const counts = await getSeasonCountsBySeriesIds(sql, [series.seriesId]);

            // Keyed by the internal UUID, not the Jellyfin id.
            expect(counts.get(series.seriesId)).toBe(3);
            expect(counts.has(series.seriesJellyfinId)).toBe(false);
        });

        it('only counts the requested series, not others', async () => {
            // Explicit, distinct tmdbIds: the fixture otherwise picks a random
            // sample tmdb_id, which can collide on the external_ids unique key.
            const a = await createAndInsertTestSeries(sql, {
                title: 'Series Alpha Cnt',
                tmdbId: 8880002,
                seasonCount: 2,
                episodesPerSeason: 0,
            });
            const b = await createAndInsertTestSeries(sql, {
                title: 'Series Beta Cnt',
                tmdbId: 8880003,
                seasonCount: 4,
                episodesPerSeason: 0,
            });

            const counts = await getSeasonCountsBySeriesIds(sql, [a.seriesId]);

            expect(counts.get(a.seriesId)).toBe(2);
            expect(counts.has(b.seriesId)).toBe(false);
        });

        it('ignores non-UUID ids (composite discovery keys) without throwing', async () => {
            const counts = await getSeasonCountsBySeriesIds(sql, ['tmdb:550:tv', 'not-a-uuid']);
            expect(counts.size).toBe(0);
        });

        it('returns an empty map for an empty id list', async () => {
            const counts = await getSeasonCountsBySeriesIds(sql, []);
            expect(counts.size).toBe(0);
        });
    });

    // =========================================================================
    // Genre extraction SQL (regression: "NaN, NaN" / "null, null" in search results)
    //
    // These tests validate the EXACT SQL fragment used in searchMedia to extract
    // genre IDs from provider_metadata. We test the SQL directly rather than
    // through searchMedia to avoid coupling to trigram/FTS thresholds and the
    // provider chain configuration.
    // =========================================================================

    describe('searchMedia genre extraction SQL', () => {
        /**
         * Run the genre extraction CASE WHEN SQL (identical to searchMedia's fragment)
         * against a JSONB genres value, without going through the full search pipeline.
         */
        async function extractGenresFromJsonb(
            localSql: postgres.Sql,
            genresJsonb: unknown,
        ): Promise<number[] | null> {
            const genresJson = genresJsonb as Parameters<typeof localSql.json>[0];
            const rows = await localSql<[{ genres: number[] | null }]>`
                SELECT
                    CASE WHEN ${localSql.json(genresJson)} IS NOT NULL
                         AND jsonb_typeof(${localSql.json(genresJson)}::jsonb) = 'array'
                        THEN ARRAY(
                            SELECT COALESCE((elem->>'id')::integer, (elem#>>'{}')::integer)
                            FROM jsonb_array_elements(${localSql.json(genresJson)}::jsonb) AS elem
                            WHERE elem IS NOT NULL AND elem != 'null'::jsonb
                              AND (jsonb_typeof(elem) = 'object' OR jsonb_typeof(elem) = 'number' OR (jsonb_typeof(elem) = 'string' AND (elem#>>'{}') ~ '^[0-9]+$'))
                        )
                        ELSE NULL
                    END AS genres
            `;
            return rows[0]?.genres ?? null;
        }

        it('extracts integer IDs from JSONB object format [{"id":80,"name":"Crime"}]', async () => {
            // Genres stored as TMDB objects — synced via full TMDB metadata fetch
            const result = await extractGenresFromJsonb(sql, [
                { id: 80, name: 'Crime' },
                { id: 9648, name: 'Mystery' },
            ]);

            expect(result).not.toBeNull();
            expect(result).toContain(80);
            expect(result).toContain(9648);
        });

        it('extracts integer IDs from bare integer format [80, 9648]', async () => {
            // Genres stored as bare integers — synced via mdblist or embedding path
            // COALESCE fix: (elem->>'id')::integer returns NULL for bare ints,
            // so elem::integer is used as fallback
            const result = await extractGenresFromJsonb(sql, [80, 9648]);

            expect(result).not.toBeNull();
            expect(result).toContain(80);
            expect(result).toContain(9648);
        });

        it('extracts integer IDs from string format ["80", "9648"] (jsonb strings)', async () => {
            // Some metadata paths store genre IDs as JSON strings, not bare integers.
            // elem::integer fails for jsonb strings; (elem#>>'{}')::integer handles both.
            const result = await extractGenresFromJsonb(sql, ['80', '9648']);

            expect(result).not.toBeNull();
            expect(result).toContain(80);
            expect(result).toContain(9648);
        });

        it('returns null when genres metadata is null (no "null" strings in result)', async () => {
            const result = await extractGenresFromJsonb(sql, null);
            expect(result).toBeNull();
        });

        it('filters out null JSONB elements without crashing', async () => {
            // Some metadata paths may produce sparse arrays with null gaps
            const result = await extractGenresFromJsonb(sql, [
                { id: 80, name: 'Crime' },
                null,
                { id: 9648, name: 'Mystery' },
            ]);

            expect(result).not.toBeNull();
            expect(result).toContain(80);
            expect(result).toContain(9648);
        });

        it('searchMedia end-to-end: item with genres in metadata is findable', async () => {
            // Verify searchMedia can find an item that has genres metadata.
            // We check the item is found; genre correctness is covered above.
            await insertMediaWithMetadata(sql, {
                title: 'Zephyra Genres Film',
                mediaType: 'movie',
                tmdbId: 8810001,
                jellyfinId: 'jf-zephyra-genres-001',
                overview: 'A film with genre metadata',
            });

            const results = await searchMedia(sql, 'Zephyra Genres Film', unrestrictedAccess(), {
                availableOnly: true,
            });

            expect(results.length).toBeGreaterThan(0);
            expect(results[0].title).toBe('Zephyra Genres Film');
        });
    });
});
