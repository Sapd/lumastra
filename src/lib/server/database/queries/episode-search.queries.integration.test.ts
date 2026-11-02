// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration Tests for Episode Search Queries
 *
 * Covers:
 * - prepareSearchTerms (pure function)
 * - searchEpisodesFullText — provider-agnostic LATERAL JOIN
 * - searchEpisodesTrigram — provider-agnostic LATERAL JOIN
 * - searchEpisodes — fallback from full-text to trigram
 * - Provider priority: tmdb > tvdb > imdb > trakt
 * - Graceful null when series has no external IDs
 * - findEpisodeByNumber
 * - getSeriesEpisodesList / getSeasonEpisodesList
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestSeries,
    createTestEpisode,
    insertTestEpisode,
    insertTestSeason,
    placeInLibraryGroup,
} from '../../../../../tests/integration/fixtures/index.js';

// Required access-filter options for the search helpers; tests run as an
// unrestricted user so both filters are null.
const TEST_ACCESS_OPTS = { deniedGroupIds: null, ageRating: null } as const;

import {
    prepareSearchTerms,
    searchEpisodesFullText,
    searchEpisodesTrigram,
    searchEpisodes,
    findEpisodeByNumber,
    findNextSequentialEpisode,
    getSeriesEpisodesList,
    getSeasonEpisodesList,
    findSeriesIdByExternalId,
} from './episode-search.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

// Required-by-shape boundary for the migrated queries. Tests run as an
// unrestricted caller unless a case explicitly builds a restricted boundary.
const UNRESTRICTED: MediaAccessBoundary = unrestrictedAccess();

// =============================================================================
// Helpers
// =============================================================================

/** Insert a series-only media item (no external IDs) and return its UUID. */
async function insertBareSeries(sql: postgres.Sql, title: string): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status)
        VALUES (${id}::uuid, ${title}, 'tv', 'active')
    `;
    return id;
}

/** Insert a single external ID directly for a given series UUID. */
async function insertSeriesExternalId(
    sql: postgres.Sql,
    seriesId: string,
    provider: string,
    externalId: string,
): Promise<void> {
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
        VALUES (${seriesId}::uuid, ${provider}, ${externalId}, 'tv', false)
    `;
}

/**
 * Insert a season + one episode under a series.
 * Returns the episode's UUID and its Jellyfin ID.
 */
async function insertSeriesWithEpisode(
    sql: postgres.Sql,
    seriesId: string,
    options: { title: string; overview?: string } = { title: 'Test Episode' },
): Promise<{ episodeId: string; jellyfinId: string }> {
    // Reuse an existing season 1 if it already exists (avoids uq_media_items_season conflict)
    const existing = await sql<{ id: string }[]>`
        SELECT id FROM media_items
        WHERE parent_id = ${seriesId}::uuid AND media_type = 'season' AND season_number = 1
        LIMIT 1
    `;
    let seasonId: string;
    if (existing.length > 0) {
        seasonId = existing[0].id;
    } else {
        const seasonJellyfinId = `jf-season-${crypto.randomUUID().slice(0, 8)}`;
        const season = {
            jellyfin_id: seasonJellyfinId,
            series_jellyfin_id: 'ignored-here',
            season_number: 1,
            episode_count: 1,
        };
        seasonId = await insertTestSeason(sql, season, seriesId);
    }

    const ep = createTestEpisode('ignored', 1, 1, {
        title: options.title,
        overview: options.overview,
    });
    const episodeId = await insertTestEpisode(sql, ep, seasonId);
    // These are playable search controls; unaired metadata is seeded separately.
    await sql`UPDATE media_items SET has_files = true WHERE id = ${episodeId}::uuid`;
    return { episodeId, jellyfinId: ep.jellyfin_id };
}

// =============================================================================
// Tests
// =============================================================================

describe('Episode Search Queries', () => {
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
    // prepareSearchTerms (pure function, no DB needed)
    // =========================================================================

    describe('prepareSearchTerms', () => {
        it('converts a single word to prefix tsquery term', () => {
            expect(prepareSearchTerms('pilot')).toBe('pilot:*');
        });

        it('joins multiple words with & and adds prefix to each', () => {
            expect(prepareSearchTerms('the pilot')).toBe('the:* & pilot:*');
        });

        it('strips special tsquery characters', () => {
            expect(prepareSearchTerms('hello & world')).toBe('hello:* & world:*');
        });

        it('returns empty string for blank input', () => {
            expect(prepareSearchTerms('')).toBe('');
            expect(prepareSearchTerms('   ')).toBe('');
        });

        it('trims whitespace', () => {
            expect(prepareSearchTerms('  pilot  ')).toBe('pilot:*');
        });
    });

    // =========================================================================
    // searchEpisodesFullText — basic functionality
    // =========================================================================

    describe('searchEpisodesFullText', () => {
        it('returns episodes whose title matches the search terms', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Xenon Chronicles',
                seasonCount: 1,
                episodesPerSeason: 0,
            });
            await insertSeriesWithEpisode(sql, series.seriesId, {
                title: 'Zephyr Awakening',
            });

            const results = await searchEpisodesFullText(
                sql,
                'zephyr:*',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );

            expect(results.length).toBe(1);
            expect(results[0].title).toBe('Zephyr Awakening');
        });

        it('returns episodes whose overview matches when title does not', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Vortex Drama',
                seasonCount: 1,
                episodesPerSeason: 0,
            });
            await insertSeriesWithEpisode(sql, series.seriesId, {
                title: 'Plain Title',
                overview: 'A nebula forms near the collapsed star',
            });

            const results = await searchEpisodesFullText(
                sql,
                'nebula:*',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );

            expect(results.length).toBe(1);
            expect(results[0].title).toBe('Plain Title');
        });

        it('returns empty array when no episode matches', async () => {
            await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });

            const results = await searchEpisodesFullText(
                sql,
                'xyzzyqwerty:*',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );
            expect(results).toHaveLength(0);
        });

        it('filters by seriesId when provided', async () => {
            const seriesA = await createAndInsertTestSeries(sql, {
                title: 'Series Alpha',
                tmdbId: 999101,
                seasonCount: 1,
                episodesPerSeason: 0,
            });
            const seriesB = await createAndInsertTestSeries(sql, {
                title: 'Series Beta',
                tmdbId: 999102,
                seasonCount: 1,
                episodesPerSeason: 0,
            });

            await insertSeriesWithEpisode(sql, seriesA.seriesId, {
                title: 'Crimson Pilot',
            });
            await insertSeriesWithEpisode(sql, seriesB.seriesId, {
                title: 'Crimson Finale',
            });

            const results = await searchEpisodesFullText(
                sql,
                'crimson:*',
                10,
                seriesA.seriesId,
                TEST_ACCESS_OPTS,
            );

            expect(results).toHaveLength(1);
            expect(results[0].title).toBe('Crimson Pilot');
        });

        it('includes seriesId (parent series UUID)', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Orbit Station',
                seasonCount: 1,
                episodesPerSeason: 0,
            });
            await insertSeriesWithEpisode(sql, series.seriesId, {
                title: 'Launch Day',
            });

            const results = await searchEpisodesFullText(
                sql,
                'launch:*',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );

            expect(results).toHaveLength(1);
            expect(results[0].seriesId).toBe(series.seriesId);
        });

        it('matches an accented episode title from a plain-ASCII tsquery', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Accent FTS Series',
                seasonCount: 1,
                episodesPerSeason: 0,
            });
            await insertSeriesWithEpisode(sql, series.seriesId, {
                title: 'Aurélie Returns',
            });

            // tsquery built from plain ASCII 'aurelie' must match the unaccented
            // search_vector for 'Aurélie' (diacritics folded in the trigger).
            const results = await searchEpisodesFullText(
                sql,
                'aurelie:*',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );

            expect(results.map((r) => r.title)).toContain('Aurélie Returns');
        });
    });

    // =========================================================================
    // Provider priority — LATERAL JOIN picks best available provider
    // =========================================================================

    describe('provider priority in episode search results', () => {
        it('returns tmdb when both tmdb and tvdb IDs exist', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Priority Test — TMDB wins',
                seasonCount: 1,
                episodesPerSeason: 0,
            });
            // createAndInsertTestSeries already adds a TMDB ID; also add TVDB
            await insertSeriesExternalId(sql, series.seriesId, 'tvdb', '77701');

            await insertSeriesWithEpisode(sql, series.seriesId, {
                title: 'Tmdb Zenith Episode',
            });

            const results = await searchEpisodesFullText(
                sql,
                'tmdb:* & zenith:*',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );

            expect(results).toHaveLength(1);
            expect(results[0].seriesMetaProvider).toBe('tmdb');
            expect(results[0].seriesMetaId).toBe(String(series.tmdbId));
        });

        it('returns tvdb when series has only a tvdb ID', async () => {
            const seriesId = await insertBareSeries(sql, 'TVDB-only Series');
            await insertSeriesExternalId(sql, seriesId, 'tvdb', '99202');
            await insertSeriesWithEpisode(sql, seriesId, {
                title: 'TVDB Quasar Episode',
            });

            const results = await searchEpisodesFullText(
                sql,
                'tvdb:* & quasar:*',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );

            expect(results).toHaveLength(1);
            expect(results[0].seriesMetaProvider).toBe('tvdb');
            expect(results[0].seriesMetaId).toBe('99202');
        });

        it('returns imdb when series has only an imdb ID', async () => {
            const seriesId = await insertBareSeries(sql, 'IMDB-only Series');
            await insertSeriesExternalId(sql, seriesId, 'imdb', 'tt9876543');
            await insertSeriesWithEpisode(sql, seriesId, {
                title: 'IMDB Helix Episode',
            });

            const results = await searchEpisodesFullText(
                sql,
                'imdb:* & helix:*',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );

            expect(results).toHaveLength(1);
            expect(results[0].seriesMetaProvider).toBe('imdb');
            expect(results[0].seriesMetaId).toBe('tt9876543');
        });

        it('returns trakt when series has only a trakt ID', async () => {
            const seriesId = await insertBareSeries(sql, 'Trakt-only Series');
            await insertSeriesExternalId(sql, seriesId, 'trakt', '12345');
            await insertSeriesWithEpisode(sql, seriesId, {
                title: 'Trakt Aurora Episode',
            });

            const results = await searchEpisodesFullText(
                sql,
                'trakt:* & aurora:*',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );

            expect(results).toHaveLength(1);
            expect(results[0].seriesMetaProvider).toBe('trakt');
            expect(results[0].seriesMetaId).toBe('12345');
        });

        it('returns null seriesMetaId/Provider when series has no external IDs', async () => {
            const seriesId = await insertBareSeries(sql, 'No External IDs Series');
            await insertSeriesWithEpisode(sql, seriesId, {
                title: 'Orphan Episode',
            });

            const results = await searchEpisodesFullText(
                sql,
                'orphan:*',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );

            expect(results).toHaveLength(1);
            expect(results[0].seriesMetaId).toBeNull();
            expect(results[0].seriesMetaProvider).toBeNull();
        });

        it('tvdb > imdb when tmdb is absent', async () => {
            const seriesId = await insertBareSeries(sql, 'TVDB beats IMDB Series');
            await insertSeriesExternalId(sql, seriesId, 'imdb', 'tt1112223');
            await insertSeriesExternalId(sql, seriesId, 'tvdb', '55501');
            await insertSeriesWithEpisode(sql, seriesId, {
                title: 'Pulsar Nexus Episode',
            });

            const results = await searchEpisodesFullText(
                sql,
                'pulsar:* & nexus:*',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );

            expect(results).toHaveLength(1);
            expect(results[0].seriesMetaProvider).toBe('tvdb');
            expect(results[0].seriesMetaId).toBe('55501');
        });
    });

    // =========================================================================
    // searchEpisodesTrigram — basic functionality + provider provider-agnostic
    // =========================================================================

    describe('searchEpisodesTrigram', () => {
        it('returns episodes by trigram similarity', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Trig Test Series',
                seasonCount: 1,
                episodesPerSeason: 0,
            });
            await insertSeriesWithEpisode(sql, series.seriesId, {
                title: 'Galaxy Mission',
            });

            // 'Galxy' is close enough (similarity ≥ 0.3) to 'Galaxy'
            const results = await searchEpisodesTrigram(
                sql,
                'Galaxy',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );

            expect(results.length).toBeGreaterThanOrEqual(1);
            expect(results[0].title).toBe('Galaxy Mission');
        });

        it('filters by seriesId when provided', async () => {
            const seriesA = await createAndInsertTestSeries(sql, {
                title: 'Trig Series A',
                tmdbId: 999201,
                seasonCount: 1,
                episodesPerSeason: 0,
            });
            const seriesB = await createAndInsertTestSeries(sql, {
                title: 'Trig Series B',
                tmdbId: 999202,
                seasonCount: 1,
                episodesPerSeason: 0,
            });

            await insertSeriesWithEpisode(sql, seriesA.seriesId, {
                title: 'Crater Landing',
            });
            await insertSeriesWithEpisode(sql, seriesB.seriesId, {
                title: 'Crater Impact',
            });

            const results = await searchEpisodesTrigram(
                sql,
                'Crater',
                10,
                seriesA.seriesId,
                TEST_ACCESS_OPTS,
            );

            expect(results).toHaveLength(1);
            expect(results[0].title).toBe('Crater Landing');
        });

        it('includes seriesMetaId and seriesMetaProvider', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Trigram Provider Test',
                seasonCount: 1,
                episodesPerSeason: 0,
            });
            await insertSeriesWithEpisode(sql, series.seriesId, {
                title: 'Solar Flare',
            });

            const results = await searchEpisodesTrigram(
                sql,
                'Solar Flare',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );

            expect(results).toHaveLength(1);
            expect(results[0].seriesMetaProvider).toBe('tmdb');
            expect(results[0].seriesMetaId).toBe(String(series.tmdbId));
        });

        it('returns null seriesMetaId when series has no external IDs', async () => {
            const seriesId = await insertBareSeries(sql, 'Trig Bare Series');
            await insertSeriesWithEpisode(sql, seriesId, {
                title: 'Bare Trig Episode',
            });

            const results = await searchEpisodesTrigram(
                sql,
                'Bare Trig Episode',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );

            expect(results).toHaveLength(1);
            expect(results[0].seriesMetaId).toBeNull();
            expect(results[0].seriesMetaProvider).toBeNull();
        });

        it('matches accented episode titles from a plain-ASCII query (and reverse)', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Accent Trig Series',
                seasonCount: 1,
                episodesPerSeason: 0,
            });
            await insertSeriesWithEpisode(sql, series.seriesId, {
                title: 'Lumémon Showdown',
            });

            // Plain ASCII query finds the accented title.
            const ascii = await searchEpisodesTrigram(
                sql,
                'Lumemon Showdown',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );
            expect(ascii.map((r) => r.title)).toContain('Lumémon Showdown');

            // Accented query finds it too (diacritics folded on both sides).
            const accented = await searchEpisodesTrigram(
                sql,
                'Lumémon Showdown',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );
            expect(accented.map((r) => r.title)).toContain('Lumémon Showdown');
        });
    });

    // =========================================================================
    // searchEpisodes — full-text with trigram fallback
    // =========================================================================

    describe('searchEpisodes', () => {
        it('returns full-text results when they exist', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Fallback Test Series',
                seasonCount: 1,
                episodesPerSeason: 0,
            });
            await insertSeriesWithEpisode(sql, series.seriesId, {
                title: 'Magnetar Explosion',
            });

            const results = await searchEpisodes(sql, 'Magnetar', 10, undefined, TEST_ACCESS_OPTS);
            expect(results.length).toBeGreaterThanOrEqual(1);
            expect(results[0].title).toBe('Magnetar Explosion');
        });

        it('returns empty array for completely unmatched query', async () => {
            await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });

            const results = await searchEpisodes(
                sql,
                'zzzzqqqq99999',
                10,
                undefined,
                TEST_ACCESS_OPTS,
            );
            expect(results).toHaveLength(0);
        });

        it('returns empty array for blank query', async () => {
            const results = await searchEpisodes(sql, '', 10, undefined, TEST_ACCESS_OPTS);
            expect(results).toHaveLength(0);
        });
    });

    // =========================================================================
    // findEpisodeByNumber
    // =========================================================================

    describe('findEpisodeByNumber', () => {
        it('finds episode by series UUID, season, and episode number', async () => {
            // Use seasonCount: 0 to avoid creating season 1 automatically,
            // then insert season 1 manually below.
            const series = await createAndInsertTestSeries(sql, {
                title: 'Find By Number Series',
                seasonCount: 0,
                episodesPerSeason: 0,
            });

            // Insert season and episode manually
            const seasonJfId = `jf-s-${crypto.randomUUID().slice(0, 8)}`;
            const seasonId = await insertTestSeason(
                sql,
                {
                    jellyfin_id: seasonJfId,
                    series_jellyfin_id: series.seriesJellyfinId,
                    season_number: 1,
                    episode_count: 1,
                },
                series.seriesId,
            );

            const ep = createTestEpisode(series.seriesJellyfinId, 1, 3, {
                title: 'Third Episode',
            });
            const episodeId = await insertTestEpisode(sql, ep, seasonId);
            // These are playable search controls; unaired metadata is seeded separately.
            await sql`UPDATE media_items SET has_files = true WHERE id = ${episodeId}::uuid`;

            const result = await findEpisodeByNumber(sql, series.seriesId, 1, 3);

            expect(result).not.toBeNull();
            expect(result!.id).toBe(episodeId);
        });

        it('returns null for non-existent episode number', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });

            const result = await findEpisodeByNumber(sql, series.seriesId, 1, 99);
            expect(result).toBeNull();
        });

        it('returns null for non-existent series UUID', async () => {
            const result = await findEpisodeByNumber(
                sql,
                '00000000-0000-0000-0000-000000000000',
                1,
                1,
            );
            expect(result).toBeNull();
        });
    });

    describe('findSeriesIdByExternalId', () => {
        it('finds the series of a TMDB id, not a same-title series', async () => {
            const older = await insertBareSeries(sql, 'Lantern Ward');
            await insertSeriesExternalId(sql, older, 'tmdb', '4100');
            await insertSeriesWithEpisode(sql, older);
            const revival = await insertBareSeries(sql, 'Lantern Ward');
            await insertSeriesExternalId(sql, revival, 'tmdb', '4200');
            await insertSeriesWithEpisode(sql, revival);

            expect(await findSeriesIdByExternalId(sql, 'tmdb', '4200', TEST_ACCESS_OPTS)).toBe(
                revival,
            );
            expect(
                await findSeriesIdByExternalId(sql, 'tmdb', '4999', TEST_ACCESS_OPTS),
            ).toBeNull();
            expect(await findSeriesIdByExternalId(sql, 'tmdb', '0', TEST_ACCESS_OPTS)).toBeNull();
        });

        it('hides a series whose files are all in a denied library group', async () => {
            const groupId = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupId}::uuid, 'FSBEI Denied Group')`;
            const seriesId = await insertBareSeries(sql, 'Quillmoor Station');
            await insertSeriesExternalId(sql, seriesId, 'tvdb', '7700');
            const { episodeId } = await insertSeriesWithEpisode(sql, seriesId);
            await placeInLibraryGroup(sql, {
                mediaItemId: episodeId,
                mediaType: 'episode',
                libraryGroupId: groupId,
            });

            const denied = { deniedGroupIds: [groupId], ageRating: null };
            expect(await findSeriesIdByExternalId(sql, 'tvdb', '7700', denied)).toBeNull();
            const otherDenied = { deniedGroupIds: [crypto.randomUUID()], ageRating: null };
            expect(await findSeriesIdByExternalId(sql, 'tvdb', '7700', otherDenied)).toBe(seriesId);

            await sql`DELETE FROM library_groups WHERE id = ${groupId}::uuid`;
        });
    });

    // =========================================================================
    // getSeriesEpisodesList
    // =========================================================================

    describe('getSeriesEpisodesList', () => {
        it('returns all episodes for a series ordered by season then episode', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Episode List Series',
                seasonCount: 2,
                episodesPerSeason: 3,
            });

            const results = await getSeriesEpisodesList(sql, series.seriesId, UNRESTRICTED);

            expect(results.length).toBe(6); // 2 seasons × 3 episodes

            // Verify ordering: season 1 ep 1, 2, 3 then season 2 ep 1, 2, 3
            expect(results[0].season_number).toBe(1);
            expect(results[0].episode_number).toBe(1);
            expect(results[5].season_number).toBe(2);
            expect(results[5].episode_number).toBe(3);
        });

        it('returns empty array for series with no episodes', async () => {
            const seriesId = await insertBareSeries(sql, 'Empty Series');
            const results = await getSeriesEpisodesList(sql, seriesId, UNRESTRICTED);
            expect(results).toHaveLength(0);
        });

        it('returns empty array for non-existent series UUID', async () => {
            const results = await getSeriesEpisodesList(
                sql,
                '00000000-0000-0000-0000-000000000000',
                UNRESTRICTED,
            );
            expect(results).toHaveLength(0);
        });

        /**
         * The unfiltered list is correct for RENDERING a series (the modal shows
         * "not yet aired" rows). It is wrong for ADVERTISING one: the
         * new-episodes feed's "all recent episodes watched → find the next
         * unwatched" branch read this list and offered five unaired episodes of a
         * show whose only released episode the user had already watched, under a
         * "New episodes available" heading with a Watch button.
         */
        describe('playableOnly', () => {
            async function seriesWithOneReleasedEpisode() {
                const series = await createAndInsertTestSeries(sql, {
                    title: `Playable Gate ${crypto.randomUUID().slice(0, 8)}`,
                    seasonCount: 1,
                    episodesPerSeason: 4,
                });
                // Only E1 has a file; E2-E4 are metadata-only rows for episodes
                // that have not aired yet.
                await sql`
                    UPDATE media_items ep
                       SET has_files = (ep.episode_number = 1)
                      FROM media_items season
                     WHERE ep.parent_id = season.id
                       AND season.parent_id = ${series.seriesId}::uuid
                       AND ep.media_type = 'episode'
                `;
                return series;
            }

            it('returns ONLY episodes that exist as files', async () => {
                const series = await seriesWithOneReleasedEpisode();

                const results = await getSeriesEpisodesList(sql, series.seriesId, UNRESTRICTED, {
                    playableOnly: true,
                });

                expect(results).toHaveLength(1);
                expect(results[0].episode_number).toBe(1);
            });

            it('still returns every episode by default (the modal needs unaired rows)', async () => {
                const series = await seriesWithOneReleasedEpisode();

                const results = await getSeriesEpisodesList(sql, series.seriesId, UNRESTRICTED);

                expect(results).toHaveLength(4);
            });

            it('excludes a file-backed episode that is no longer active', async () => {
                const series = await seriesWithOneReleasedEpisode();
                await sql`
                    UPDATE media_items ep
                       SET status = 'deleted'
                      FROM media_items season
                     WHERE ep.parent_id = season.id
                       AND season.parent_id = ${series.seriesId}::uuid
                       AND ep.media_type = 'episode'
                       AND ep.episode_number = 1
                `;

                const results = await getSeriesEpisodesList(sql, series.seriesId, UNRESTRICTED, {
                    playableOnly: true,
                });

                expect(results).toHaveLength(0);
            });
        });

        it('carries the air date so callers need not stamp one', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: `Air Date Series ${crypto.randomUUID().slice(0, 8)}`,
                seasonCount: 1,
                episodesPerSeason: 1,
            });

            const results = await getSeriesEpisodesList(sql, series.seriesId, UNRESTRICTED);

            // The new-episodes alert builder substitutes `new Date()` for a null
            // air date, which is what made every alert from that branch read
            // "today" regardless of when the episode actually aired.
            expect(results[0].air_date).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
        });
    });

    // =========================================================================
    // getSeasonEpisodesList
    // =========================================================================

    describe('getSeasonEpisodesList', () => {
        it('returns only episodes for the specified season', async () => {
            const series = await createAndInsertTestSeries(sql, {
                title: 'Season Filter Series',
                seasonCount: 2,
                episodesPerSeason: 4,
            });

            const season1Results = await getSeasonEpisodesList(sql, series.seriesId, 1);
            const season2Results = await getSeasonEpisodesList(sql, series.seriesId, 2);

            expect(season1Results.length).toBe(4);
            expect(season2Results.length).toBe(4);

            // All results should have episode_number 1-4 in order
            expect(season1Results.map((e) => e.episode_number)).toEqual([1, 2, 3, 4]);
        });

        it('returns empty array for non-existent season number', async () => {
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 1,
                episodesPerSeason: 2,
            });

            const results = await getSeasonEpisodesList(sql, series.seriesId, 99);
            expect(results).toHaveLength(0);
        });
    });

    // =========================================================================
    // findNextSequentialEpisode — drives the in-player "up next" prompt,
    // including whether it renders a thumbnail (has_primary_image).
    // =========================================================================
    describe('findNextSequentialEpisode', () => {
        /** Series with season 1 holding episodes E01 and E02. Returns both UUIDs. */
        async function setupTwoEpisodeSeries(
            s: postgres.Sql,
        ): Promise<{ seriesId: string; ep1: string; ep2: string }> {
            const seriesId = await insertBareSeries(s, 'Next Ep Series');
            const seasonId = await insertTestSeason(
                s,
                {
                    jellyfin_id: `jf-season-${crypto.randomUUID().slice(0, 8)}`,
                    series_jellyfin_id: 'ignored-here',
                    season_number: 1,
                    episode_count: 2,
                },
                seriesId,
            );
            const ep1 = await insertTestEpisode(
                s,
                createTestEpisode('ignored', 1, 1, { title: 'E1' }),
                seasonId,
            );
            const ep2 = await insertTestEpisode(
                s,
                createTestEpisode('ignored', 1, 2, { title: 'E2' }),
                seasonId,
            );
            await s`
                UPDATE media_items
                SET has_files = true
                WHERE id = ${ep1}::uuid OR id = ${ep2}::uuid
            `;
            return { seriesId, ep1, ep2 };
        }

        it('does not advertise an archived local thumbnail on the next episode', async () => {
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            await sql`INSERT INTO media_artwork(media_item_id,artwork_type,file_path) VALUES (${ep2},'thumb','/frames/hidden.webp')`;
            expect((await findNextSequentialEpisode(sql, seriesId, ep1))?.has_primary_image).toBe(
                true,
            );
            await sql`UPDATE image_candidates SET suppressed=true,selected=false WHERE media_item_id=${ep2}`;
            expect((await findNextSequentialEpisode(sql, seriesId, ep1))?.has_primary_image).toBe(
                false,
            );
        });
        it('returns the next episode in sequence', async () => {
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            const next = await findNextSequentialEpisode(sql, seriesId, ep1);
            expect(next?.id).toBe(ep2);
            expect(next?.episode_number).toBe(2);
            expect(next?.has_files).toBe(true);
        });

        it('returns null when the current episode is the last in the series', async () => {
            const { seriesId, ep2 } = await setupTwoEpisodeSeries(sql);
            const next = await findNextSequentialEpisode(sql, seriesId, ep2);
            expect(next).toBeNull();
        });

        async function addEpisode(
            seriesId: string,
            number: number,
            seasonNumber = 1,
        ): Promise<string> {
            const [season] = await sql<{ id: string }[]>`
                SELECT id FROM media_items WHERE parent_id = ${seriesId} AND season_number = ${seasonNumber} AND media_type = 'season'
            `;
            const seasonId =
                season?.id ??
                (await insertTestSeason(
                    sql,
                    {
                        jellyfin_id: `jf-${crypto.randomUUID()}`,
                        series_jellyfin_id: 'ignored',
                        season_number: seasonNumber,
                        episode_count: 1,
                    },
                    seriesId,
                ));
            return insertTestEpisode(
                sql,
                createTestEpisode('ignored', seasonNumber, number),
                seasonId,
            );
        }

        async function shareFile(episodes: string[], offsets = false): Promise<string> {
            const fileId = crypto.randomUUID();
            await sql`INSERT INTO media_files (id, file_path) VALUES (${fileId}, ${'/test/combined-' + fileId})`;
            for (let i = 0; i < episodes.length; i++) {
                await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, start_offset_ms, end_offset_ms)
                    VALUES (${fileId}, ${episodes[i]}, true, ${offsets ? i * 1000 : null}, ${offsets ? (i + 1) * 1000 : null})`;
            }
            return fileId;
        }

        it.each([false, true])(
            'advances past both default-file siblings from either entry (offsets=%s)',
            async (offsets) => {
                const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
                const ep3 = await addEpisode(seriesId, 3);
                await shareFile([ep1, ep2], offsets);
                await shareFile([ep3]);
                for (const entry of [ep1, ep2]) {
                    expect(
                        (
                            await findNextSequentialEpisode(sql, seriesId, entry, {
                                afterCurrentFile: true,
                            })
                        )?.id,
                    ).toBe(ep3);
                }
                expect((await findNextSequentialEpisode(sql, seriesId, ep1))?.id).toBe(ep2);
            },
        );

        it('preserves ordinary sequence with separate files or no associations', async () => {
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            expect(
                (await findNextSequentialEpisode(sql, seriesId, ep1, { afterCurrentFile: true }))
                    ?.id,
            ).toBe(ep2);
            await shareFile([ep1]);
            await shareFile([ep2]);
            expect(
                (await findNextSequentialEpisode(sql, seriesId, ep1, { afterCurrentFile: true }))
                    ?.id,
            ).toBe(ep2);
        });

        it('audio playback skips unavailable and deleted candidates after a combined file', async () => {
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            await shareFile([ep1, ep2]);
            await addEpisode(seriesId, 3);
            const deleted = await addEpisode(seriesId, 4);
            await shareFile([deleted]);
            await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${deleted}`;
            const missing = await addEpisode(seriesId, 5);
            const missingFile = await shareFile([missing]);
            await sql`UPDATE media_files SET is_missing = true WHERE id = ${missingFile}`;
            const available = await addEpisode(seriesId, 6);
            await shareFile([available]);
            expect(
                (
                    await findNextSequentialEpisode(sql, seriesId, ep1, {
                        afterCurrentFile: true,
                        playableOnly: true,
                    })
                )?.id,
            ).toBe(available);
        });
        it.each(['season', 'episode'] as const)(
            'does not let a sibling with a null %s coordinate end autoplay',
            async (coordinate) => {
                const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
                const ep3 = await addEpisode(seriesId, 3);
                await shareFile([ep1, ep2]);
                await shareFile([ep3]);
                if (coordinate === 'season') {
                    await sql`UPDATE media_items SET season_number = NULL WHERE id = ${ep2}`;
                } else {
                    await sql`UPDATE media_items SET episode_number = NULL, sort_order = NULL WHERE id = ${ep2}`;
                }
                expect(
                    (
                        await findNextSequentialEpisode(sql, seriesId, ep1, {
                            afterCurrentFile: true,
                            playableOnly: true,
                        })
                    )?.id,
                ).toBe(ep3);
            },
        );

        it('ignores incomplete sibling coordinates in a later season', async () => {
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            const ep3 = await addEpisode(seriesId, 3);
            const incomplete = await addEpisode(seriesId, 1, 2);
            await shareFile([ep1, ep2, incomplete]);
            await shareFile([ep3]);
            await sql`UPDATE media_items SET episode_number = NULL, sort_order = NULL
                WHERE id = ${incomplete}`;
            expect(
                (
                    await findNextSequentialEpisode(sql, seriesId, ep1, {
                        afterCurrentFile: true,
                        playableOnly: true,
                    })
                )?.id,
            ).toBe(ep3);
        });

        it('skips a missing default even when an alternate file is present', async () => {
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            const ep3 = await addEpisode(seriesId, 3);
            const ep4 = await addEpisode(seriesId, 4);
            await shareFile([ep1, ep2]);
            const missing = await shareFile([ep3]);
            await sql`UPDATE media_files SET is_missing = true WHERE id = ${missing}`;
            const [alternate] = await sql<{ id: string }[]>`INSERT INTO media_files (file_path)
                VALUES (${'/test/alternate-' + crypto.randomUUID()}) RETURNING id`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${alternate.id}, ${ep3}, false)`;
            await shareFile([ep4]);
            expect(
                (
                    await findNextSequentialEpisode(sql, seriesId, ep1, {
                        afterCurrentFile: true,
                        playableOnly: true,
                    })
                )?.id,
            ).toBe(ep4);
        });

        it('returns null when all later files are missing', async () => {
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            const ep3 = await addEpisode(seriesId, 3);
            await shareFile([ep1, ep2]);
            const missing = await shareFile([ep3]);
            await sql`UPDATE media_files SET is_missing = true WHERE id = ${missing}`;
            expect(
                await findNextSequentialEpisode(sql, seriesId, ep1, {
                    afterCurrentFile: true,
                    playableOnly: true,
                }),
            ).toBeNull();
        });

        async function mapTestOrdering(
            seriesId: string,
            entries: Array<[string, number, number]>,
        ): Promise<void> {
            const group = crypto.randomUUID();
            await sql`INSERT INTO series_episode_ordering (media_id, ordering_type, ordering_source, ordering_provider, ordering_group_id)
                VALUES (${seriesId}, 'absolute', 'manual', 'test', ${group})`;
            for (const [id, physical, display] of entries) {
                await sql`INSERT INTO episode_orderings (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id, original_season_number, original_episode_number, order_season_number, order_episode_number, episode_media_id)
                    VALUES (${seriesId}, 'test', ${id}, 'absolute', ${group}, 1, ${physical}, 1, ${display}, ${id})`;
            }
        }

        it('does not extend a consumed range through an unmapped sibling', async () => {
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            const ep3 = await addEpisode(seriesId, 3);
            await sql`UPDATE media_items SET episode_number = 99 WHERE id = ${ep2}`;
            await shareFile([ep1, ep2]);
            await shareFile([ep3]);
            await mapTestOrdering(seriesId, [
                [ep1, 1, 1],
                [ep3, 3, 2],
            ]);
            expect(
                (
                    await findNextSequentialEpisode(sql, seriesId, ep1, {
                        afterCurrentFile: true,
                        playableOnly: true,
                    })
                )?.id,
            ).toBe(ep3);
        });

        it('retains the original cursor for a directly played unmapped episode', async () => {
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            const ep3 = await addEpisode(seriesId, 3);
            await shareFile([ep2]);
            await shareFile([ep3]);
            await mapTestOrdering(seriesId, [
                [ep1, 1, 1],
                [ep3, 3, 3],
            ]);
            expect(
                (
                    await findNextSequentialEpisode(sql, seriesId, ep2, {
                        afterCurrentFile: true,
                        playableOnly: true,
                    })
                )?.id,
            ).toBe(ep3);
        });

        describe('a file linked by hand to episodes no range describes', () => {
            async function series(n: number): Promise<{ seriesId: string; eps: string[] }> {
                const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
                const eps = [ep1, ep2];
                for (let i = 3; i <= n; i++) eps.push(await addEpisode(seriesId, i));
                return { seriesId, eps };
            }
            const next = async (seriesId: string, entry: string): Promise<string | undefined> =>
                (
                    await findNextSequentialEpisode(sql, seriesId, entry, {
                        afterCurrentFile: true,
                        playableOnly: true,
                    })
                )?.id;

            it('non-adjacent (E1 + E4): continues at E2, not past the gap', async () => {
                const { seriesId, eps } = await series(5);
                await shareFile([eps[0], eps[3]], true);
                for (const i of [1, 2, 4]) await shareFile([eps[i]]);
                expect(await next(seriesId, eps[0])).toBe(eps[1]);
                expect(await next(seriesId, eps[3])).toBe(eps[4]);
            });

            it('reversed (E3 then E2): continues at E4 from either entry', async () => {
                const { seriesId, eps } = await series(4);
                await shareFile([eps[2], eps[1]], true);
                for (const i of [0, 3]) await shareFile([eps[i]]);
                expect(await next(seriesId, eps[2])).toBe(eps[3]);
                expect(await next(seriesId, eps[1])).toBe(eps[3]);
            });

            it('cross-season (S2E1 then S1E3): each entry continues in its own season', async () => {
                const { seriesId, eps } = await series(4);
                const s2e1 = await addEpisode(seriesId, 1, 2);
                const s2e2 = await addEpisode(seriesId, 2, 2);
                await shareFile([s2e1, eps[2]], true);
                for (const id of [eps[0], eps[1], eps[3], s2e2]) await shareFile([id]);
                expect(await next(seriesId, s2e1)).toBe(s2e2);
                expect(await next(seriesId, eps[2])).toBe(eps[3]);
            });
        });

        describe('autoplay boundary, specials and duplicate positions', () => {
            async function deniedGroup(): Promise<string> {
                const id = crypto.randomUUID();
                await sql`INSERT INTO library_groups (id, name) VALUES (${id}, ${'denied-' + id})`;
                return id;
            }

            it('skips a library-restricted next episode and returns the next visible one', async () => {
                const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
                const ep3 = await addEpisode(seriesId, 3);
                await shareFile([ep1]);
                const hiddenFile = await shareFile([ep2]);
                await shareFile([ep3]);
                const group = await deniedGroup();
                await sql`UPDATE media_files SET library_group_id = ${group} WHERE id = ${hiddenFile}`;
                const access = restrictedAccess({
                    deniedGroupIds: [group],
                    maxAgeRating: null,
                    allowUnrated: true,
                });
                expect(
                    (
                        await findNextSequentialEpisode(sql, seriesId, ep1, {
                            afterCurrentFile: true,
                            playableOnly: true,
                            access,
                        })
                    )?.id,
                ).toBe(ep3);
                // Without the boundary the hidden episode is still the next one.
                expect(
                    (
                        await findNextSequentialEpisode(sql, seriesId, ep1, {
                            afterCurrentFile: true,
                            playableOnly: true,
                            access: UNRESTRICTED,
                        })
                    )?.id,
                ).toBe(ep2);
            });

            it('returns null when every later episode is hidden or access is denyAll', async () => {
                const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
                await shareFile([ep1]);
                const hiddenFile = await shareFile([ep2]);
                const group = await deniedGroup();
                await sql`UPDATE media_files SET library_group_id = ${group} WHERE id = ${hiddenFile}`;
                expect(
                    await findNextSequentialEpisode(sql, seriesId, ep1, {
                        playableOnly: true,
                        access: restrictedAccess({
                            deniedGroupIds: [group],
                            maxAgeRating: null,
                            allowUnrated: true,
                        }),
                    }),
                ).toBeNull();
                expect(
                    await findNextSequentialEpisode(sql, seriesId, ep1, {
                        access: denyAllAccess(),
                    }),
                ).toBeNull();
            });

            it('applies the series age rating to the candidate', async () => {
                const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
                await shareFile([ep1]);
                await shareFile([ep2]);
                await sql`UPDATE media_items SET age_rating = 18 WHERE id = ${seriesId}`;
                const limited = (max: number) =>
                    restrictedAccess({
                        deniedGroupIds: [],
                        maxAgeRating: max,
                        allowUnrated: false,
                    });
                expect(
                    await findNextSequentialEpisode(sql, seriesId, ep1, { access: limited(12) }),
                ).toBeNull();
                expect(
                    (await findNextSequentialEpisode(sql, seriesId, ep1, { access: limited(18) }))
                        ?.id,
                ).toBe(ep2);
            });

            it('does not chain playback from a special (season 0) into season 1', async () => {
                const { seriesId, ep1 } = await setupTwoEpisodeSeries(sql);
                const sp1 = await addEpisode(seriesId, 1, 0);
                const sp2 = await addEpisode(seriesId, 2, 0);
                const chain = { specialsStayInSeason: true } as const;
                expect((await findNextSequentialEpisode(sql, seriesId, sp1, chain))?.id).toBe(sp2);
                expect(await findNextSequentialEpisode(sql, seriesId, sp2, chain)).toBeNull();
                expect(
                    await findNextSequentialEpisode(sql, seriesId, sp2, {
                        ...chain,
                        afterCurrentFile: true,
                    }),
                ).toBeNull();
                // Next-up and continue-watching keep advancing out of the specials.
                expect((await findNextSequentialEpisode(sql, seriesId, sp2))?.id).toBe(ep1);
            });

            it('walks duplicate positions in a custom ordering without skipping', async () => {
                const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
                const ep3 = await addEpisode(seriesId, 3);
                await mapTestOrdering(seriesId, [
                    [ep1, 1, 1],
                    [ep2, 2, 2],
                    [ep3, 3, 2],
                ]);
                const [a, b] = [ep2, ep3].sort();
                expect((await findNextSequentialEpisode(sql, seriesId, ep1))?.id).toBe(a);
                expect((await findNextSequentialEpisode(sql, seriesId, a))?.id).toBe(b);
                expect(await findNextSequentialEpisode(sql, seriesId, b)).toBeNull();
            });

            it('still resolves past a combined file when the next episode is visible', async () => {
                const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
                const ep3 = await addEpisode(seriesId, 3);
                await shareFile([ep1, ep2]);
                await shareFile([ep3]);
                for (const entry of [ep1, ep2]) {
                    expect(
                        (
                            await findNextSequentialEpisode(sql, seriesId, entry, {
                                afterCurrentFile: true,
                                playableOnly: true,
                                access: restrictedAccess({
                                    deniedGroupIds: [],
                                    maxAgeRating: null,
                                    allowUnrated: true,
                                }),
                            })
                        )?.id,
                    ).toBe(ep3);
                }
            });
        });

        it('returns null at a final combined file', async () => {
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            await shareFile([ep1, ep2]);
            expect(
                await findNextSequentialEpisode(sql, seriesId, ep1, { afterCurrentFile: true }),
            ).toBeNull();
        });

        it('crosses to the next ordered season after a combined file', async () => {
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            const next = await addEpisode(seriesId, 1, 2);
            await shareFile([ep1, ep2]);
            expect(
                await findNextSequentialEpisode(sql, seriesId, ep1, { afterCurrentFile: true }),
            ).toMatchObject({ id: next, is_new_season: true, season_number: 2 });
        });

        it('advances from the entry in the active ordering, skipping the file siblings', async () => {
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            const ep3 = await addEpisode(seriesId, 3);
            const ep4 = await addEpisode(seriesId, 4);
            await shareFile([ep1, ep2]);
            const group = crypto.randomUUID();
            await sql`INSERT INTO series_episode_ordering (media_id, ordering_type, ordering_source, ordering_provider, ordering_group_id)
                VALUES (${seriesId}, 'absolute', 'manual', 'test', ${group})`;
            // File siblings are displayed at 1 and 3, with another file between them.
            for (const [id, physical, display] of [
                [ep1, 1, 3],
                [ep2, 2, 1],
                [ep3, 3, 2],
                [ep4, 4, 4],
            ] as const) {
                await sql`INSERT INTO episode_orderings (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id, original_season_number, original_episode_number, order_season_number, order_episode_number, episode_media_id)
                    VALUES (${seriesId}, 'test', ${id}, 'absolute', ${group}, 1, ${physical}, 5, ${display}, ${id})`;
            }
            // Entered at display 1 (E2): display 2 (E3) is a file of its own and
            // has not been played, so it comes next; display 3 (E1) was
            // consumed with the file and is skipped. Entered at display 3: 4.
            // (Until 2026-10-21 both entries jumped past the last sibling to 4,
            // skipping E3 — the same skip as a hand-linked E37 + E41.)
            expect(
                await findNextSequentialEpisode(sql, seriesId, ep2, { afterCurrentFile: true }),
            ).toMatchObject({ id: ep3, season_number: 5, episode_number: 2 });
            expect(
                await findNextSequentialEpisode(sql, seriesId, ep1, { afterCurrentFile: true }),
            ).toMatchObject({
                id: ep4,
                season_number: 5,
                episode_number: 4,
                is_new_season: false,
            });
            expect((await findNextSequentialEpisode(sql, seriesId, ep2))?.id).toBe(ep3);
        });

        it('does not consume non-default file associations on either side of the sibling join', async () => {
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            const ep3 = await addEpisode(seriesId, 3);
            const ep4 = await addEpisode(seriesId, 4);
            const combined = await shareFile([ep1, ep2]);
            await shareFile([ep3]);
            const laterFile = await shareFile([ep4]);
            // E3 has the consumed file only as an alternate; E1 has E4's file
            // only as an alternate. Neither link extends the consumed range.
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${combined}, ${ep3}, false), (${laterFile}, ${ep1}, false)`;
            expect(
                (await findNextSequentialEpisode(sql, seriesId, ep1, { afterCurrentFile: true }))
                    ?.id,
            ).toBe(ep3);
        });

        it('ignores siblings in other series and rejects foreign anchors', async () => {
            const first = await setupTwoEpisodeSeries(sql);
            const other = await setupTwoEpisodeSeries(sql);
            await sql`UPDATE media_items SET episode_number = 99 WHERE id = ${other.ep1}`;
            await shareFile([first.ep1, other.ep1]);
            expect(
                (
                    await findNextSequentialEpisode(sql, first.seriesId, first.ep1, {
                        afterCurrentFile: true,
                    })
                )?.id,
            ).toBe(first.ep2);
            expect(
                await findNextSequentialEpisode(sql, first.seriesId, other.ep1, {
                    afterCurrentFile: true,
                }),
            ).toBeNull();
        });

        it('reports has_primary_image=true when the next episode has a locally-extracted ffmpeg frame', async () => {
            // Regression: episodes typically have no provider still_path; their
            // thumbnail is a local frame stored as media_artwork (source 'local',
            // type 'backdrop'). The prompt must surface it as a thumbnail.
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            await sql`
                INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path, remote_url, language)
                VALUES (${ep2}::uuid, 'backdrop', 'local', '/frames/ep2.webp', null, '')
            `;
            const next = await findNextSequentialEpisode(sql, seriesId, ep1);
            expect(next?.id).toBe(ep2);
            expect(next?.has_primary_image).toBe(true);
        });

        it('reports has_primary_image=true when the next episode has a provider still_path', async () => {
            const { seriesId, ep1, ep2 } = await setupTwoEpisodeSeries(sql);
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${ep2}::uuid, 'tmdb', '{"still_path": "/x.jpg"}'::jsonb, NOW())
            `;
            const next = await findNextSequentialEpisode(sql, seriesId, ep1);
            expect(next?.has_primary_image).toBe(true);
        });

        it('reports has_primary_image=false when the next episode has neither a provider still nor a local frame', async () => {
            const { seriesId, ep1 } = await setupTwoEpisodeSeries(sql);
            const next = await findNextSequentialEpisode(sql, seriesId, ep1);
            expect(next?.has_primary_image).toBe(false);
        });
    });

    // =========================================================================
    // getSeriesEpisodesList — access boundary
    // =========================================================================
    describe('getSeriesEpisodesList access boundary', () => {
        it('drops a denied series entirely and returns empty for denyAll', async () => {
            const groupId = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupId}::uuid, 'GSEL Denied Group')`;

            const series = await createAndInsertTestSeries(sql, {
                title: 'Cinnabar Ferry Almanac',
                seasonCount: 1,
                episodesPerSeason: 2,
            });

            // The filter judges each EPISODE's own file — the leaf that carries
            // library_group_id in a real library. Both episodes go into the
            // denied group so the restricted result is empty.
            const episodeIds = await sql<{ id: string }[]>`
                SELECT ep.id::text FROM media_items ep
                JOIN media_items season ON season.id = ep.parent_id
                WHERE ep.media_type = 'episode' AND season.parent_id = ${series.seriesId}::uuid
            `;
            expect(episodeIds).toHaveLength(2);
            for (const { id } of episodeIds) {
                await placeInLibraryGroup(sql, {
                    mediaItemId: id,
                    mediaType: 'episode',
                    libraryGroupId: groupId,
                });
            }

            const unrestricted = await getSeriesEpisodesList(sql, series.seriesId, UNRESTRICTED);
            expect(unrestricted.length).toBe(2);

            const restricted = await getSeriesEpisodesList(
                sql,
                series.seriesId,
                restrictedAccess({
                    deniedGroupIds: [groupId],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            );
            const unrestrictedIds = new Set(unrestricted.map((e) => e.id));
            for (const ep of restricted) expect(unrestrictedIds.has(ep.id)).toBe(true);
            expect(restricted).toHaveLength(0);

            expect(await getSeriesEpisodesList(sql, series.seriesId, denyAllAccess())).toEqual([]);

            await sql`DELETE FROM library_groups WHERE id = ${groupId}::uuid`;
        });

        it('an unrelated denied group does not filter an accessible series', async () => {
            const otherGroupId = crypto.randomUUID();
            const series = await createAndInsertTestSeries(sql, {
                title: 'Peregrine Sundial Gazette',
                seasonCount: 1,
                episodesPerSeason: 2,
            });

            const restricted = await getSeriesEpisodesList(
                sql,
                series.seriesId,
                restrictedAccess({
                    deniedGroupIds: [otherGroupId],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            );
            expect(restricted.length).toBe(2);
        });
    });
});
