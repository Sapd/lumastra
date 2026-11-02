// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for getCalendarItemsFromDb (calendar.queries.ts).
 *
 * Requires a running PostgreSQL test database (`lumastra_tests`) with all
 * migrations applied. Run with:
 *   NODE_OPTIONS='--max-old-space-size=8192' npx vitest run \
 *     --config vitest.integration.config.ts \
 *     src/lib/server/database/queries/calendar.queries.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { getCalendarItemsFromDb } from './calendar.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** ISO date string (YYYY-MM-DD) for a day relative to today. */
function relativeDate(deltaDays: number): string {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return d.toISOString().split('T')[0];
}

function dateObj(deltaDays: number): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + deltaDays);
    return d;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function insertMovie(
    sql: postgres.Sql,
    title: string,
    premiereDate: string | null,
    hasFiles = false,
    ageRating: number | null = null,
): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items
            (id, title, media_type, status, parent_id, premiere_date, has_files, age_rating)
        VALUES (
            ${id}::uuid, ${title}, 'movie', 'active', NULL,
            ${premiereDate}, ${hasFiles}, ${ageRating}
        )
    `;
    return id;
}

/**
 * Attach a file in `libraryGroupId` to a media item, making it visible only to
 * users who are NOT denied that group. Items with no file rows at all pass the
 * library filter unconditionally, so this is what puts an item on the library
 * axis in the first place.
 */
async function attachFileInGroup(
    sql: postgres.Sql,
    mediaItemId: string,
    libraryGroupId: string,
    path: string,
): Promise<void> {
    const fileId = crypto.randomUUID();
    await sql`
        INSERT INTO media_files (id, file_path, library_group_id)
        VALUES (${fileId}::uuid, ${path}, ${libraryGroupId}::uuid)
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
        VALUES (${fileId}::uuid, ${mediaItemId}::uuid, true, 0)
    `;
}

/**
 * Insert a series → season → episode hierarchy and return the episode UUID.
 * `premiereDate` controls whether the episode appears in the calendar window.
 */
async function insertEpisode(
    sql: postgres.Sql,
    title: string,
    premiereDate: string | null,
    hasFiles = false,
    ageRating: number | null = null,
): Promise<{ episodeId: string; seriesId: string }> {
    const seriesId = crypto.randomUUID();
    await sql`
        INSERT INTO media_items
            (id, title, media_type, status, parent_id, has_files, age_rating)
        VALUES (
            ${seriesId}::uuid, ${title + ' Series'}, 'tv', 'active', NULL, ${hasFiles}, ${ageRating}
        )
    `;
    const seasonId = crypto.randomUUID();
    await sql`
        INSERT INTO media_items
            (id, title, media_type, status, parent_id, season_number, has_files)
        VALUES (
            ${seasonId}::uuid, ${title + ' S1'}, 'season', 'active',
            ${seriesId}::uuid, 1, ${hasFiles}
        )
    `;
    const episodeId = crypto.randomUUID();
    await sql`
        INSERT INTO media_items
            (id, title, media_type, status, parent_id, season_number, episode_number,
             premiere_date, has_files)
        VALUES (
            ${episodeId}::uuid, ${title + ' S1E1'}, 'episode', 'active',
            ${seasonId}::uuid, 1, 1,
            ${premiereDate}, ${hasFiles}
        )
    `;
    return { episodeId, seriesId };
}

/** Link a media_items row to an external provider id (composite key). */
async function insertExternalId(
    sql: postgres.Sql,
    mediaId: string,
    provider: string,
    externalId: string,
    mediaType: string,
): Promise<void> {
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type)
        VALUES (${mediaId}::uuid, ${provider}, ${externalId}, ${mediaType})
    `;
}

/** Insert one upcoming_releases projection row. */
async function insertUpcomingRelease(
    sql: postgres.Sql,
    opts: {
        source: 'sonarr' | 'radarr';
        arrItemId: number;
        mediaType: 'episode' | 'movie';
        title: string;
        airDate: string | null;
        tmdbId?: number | null;
        tvdbId?: number | null;
        sourceSeriesId?: number | null;
        seasonNumber?: number | null;
        episodeNumber?: number | null;
        seriesTitle?: string | null;
        hasFile?: boolean;
    },
): Promise<void> {
    await sql`
        INSERT INTO upcoming_releases
            (source, source_item_id, source_series_id, media_type, tmdb_id, tvdb_id, series_title,
             title, season_number, episode_number, air_date, has_file)
        VALUES (
            ${opts.source}, ${opts.arrItemId}, ${opts.sourceSeriesId ?? null},
            ${opts.mediaType}, ${opts.tmdbId ?? null}, ${opts.tvdbId ?? null},
            ${opts.seriesTitle ?? null},
            ${opts.title}, ${opts.seasonNumber ?? null}, ${opts.episodeNumber ?? null},
            ${opts.airDate}, ${opts.hasFile ?? false}
        )
    `;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getCalendarItemsFromDb (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        // upcoming_releases is not part of TEST_TABLES.media — clean it here.
        await sql`DELETE FROM upcoming_releases`;
    });

    // -------------------------------------------------------------------------
    // UNION: episodes + movies
    // -------------------------------------------------------------------------

    it('returns both episodes and movies that premiere in range', async () => {
        const inRange = relativeDate(3); // 3 days in future — inside a 7-day window
        const start = dateObj(0);
        const end = dateObj(7);

        const { episodeId } = await insertEpisode(sql, 'Cal Episode', inRange);
        const movieId = await insertMovie(sql, 'Cal Movie', inRange);

        const rows = await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), false);
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(episodeId);
        expect(ids).toContain(movieId);
    });

    it('type discriminator: episodes have media_type=episode, movies have media_type=movie', async () => {
        const inRange = relativeDate(2);
        const start = dateObj(0);
        const end = dateObj(7);

        const { episodeId } = await insertEpisode(sql, 'Cal Type Ep', inRange);
        const movieId = await insertMovie(sql, 'Cal Type Mv', inRange);

        const rows = await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), false);
        const epRow = rows.find((r) => r.id === episodeId);
        const mvRow = rows.find((r) => r.id === movieId);

        expect(epRow?.media_type).toBe('episode');
        expect(mvRow?.media_type).toBe('movie');
    });

    it('episodes carry series_name and series_id; movies have them null', async () => {
        const inRange = relativeDate(1);
        const start = dateObj(0);
        const end = dateObj(7);

        const { episodeId, seriesId } = await insertEpisode(sql, 'Cal Series Meta', inRange);
        const movieId = await insertMovie(sql, 'Cal Movie Meta', inRange);

        const rows = await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), false);
        const epRow = rows.find((r) => r.id === episodeId);
        const mvRow = rows.find((r) => r.id === movieId);

        expect(epRow?.series_id).toBe(seriesId);
        expect(epRow?.series_name).toBe('Cal Series Meta Series');
        expect(mvRow?.series_name).toBeNull();
        expect(mvRow?.series_id).toBeNull();
    });

    // -------------------------------------------------------------------------
    // Date range filtering
    // -------------------------------------------------------------------------

    it('excludes items whose premiere_date is before the range start', async () => {
        const beforeStart = relativeDate(-3);
        const start = dateObj(0);
        const end = dateObj(7);

        const { episodeId } = await insertEpisode(sql, 'Cal Before Start', beforeStart);
        const movieId = await insertMovie(sql, 'Cal Movie Before', beforeStart);

        const rows = await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), false);
        const ids = rows.map((r) => r.id);
        expect(ids).not.toContain(episodeId);
        expect(ids).not.toContain(movieId);
    });

    it('excludes items whose premiere_date is after the range end', async () => {
        const afterEnd = relativeDate(10);
        const start = dateObj(0);
        const end = dateObj(7);

        const { episodeId } = await insertEpisode(sql, 'Cal After End', afterEnd);
        const movieId = await insertMovie(sql, 'Cal Movie After', afterEnd);

        const rows = await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), false);
        const ids = rows.map((r) => r.id);
        expect(ids).not.toContain(episodeId);
        expect(ids).not.toContain(movieId);
    });

    it('includes episodes on exactly the range boundary dates (inclusive)', async () => {
        const start = dateObj(0);
        const end = dateObj(7);
        const startStr = relativeDate(0);
        const endStr = relativeDate(7);

        const { episodeId: atStart } = await insertEpisode(sql, 'Cal Boundary Start', startStr);
        const { episodeId: atEnd } = await insertEpisode(sql, 'Cal Boundary End', endStr);

        const rows = await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), false);
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(atStart);
        expect(ids).toContain(atEnd);
    });

    it('excludes items with NULL premiere_date', async () => {
        const start = dateObj(-30);
        const end = dateObj(30);

        const { episodeId } = await insertEpisode(sql, 'Cal Null Date Ep', null);
        const movieId = await insertMovie(sql, 'Cal Null Date Mv', null);

        const rows = await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), false);
        const ids = rows.map((r) => r.id);
        expect(ids).not.toContain(episodeId);
        expect(ids).not.toContain(movieId);
    });

    // -------------------------------------------------------------------------
    // has_files: episodes can be stubs (has_files=false) — calendar includes them
    // -------------------------------------------------------------------------

    it('includes episode stubs (has_files=false) — TMDB sync pre-creates upcoming episodes', async () => {
        const inRange = relativeDate(5);
        const start = dateObj(0);
        const end = dateObj(7);

        const { episodeId: stubId } = await insertEpisode(sql, 'Cal Stub Ep', inRange, false);
        const { episodeId: fileId } = await insertEpisode(sql, 'Cal File Ep', inRange, true);

        const rows = await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), false);
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(stubId);
        expect(ids).toContain(fileId);
    });

    describe('catalog numbering duplicates', () => {
        afterEach(async () => {
            await sql`DELETE FROM library_groups WHERE name = 'Numbered Show Group'`;
        });

        it.each([
            { variant: 'orphan absolute-numbered stub', keepStub: false },
            { variant: 'file-backed stub', keepStub: true },
            { variant: 'linked file with stale has_files', keepStub: true },
            { variant: 'locked metadata', keepStub: true },
            { variant: 'provider-bound episode', keepStub: true },
            { variant: 'different ordinal on a batch day', keepStub: true },
            { variant: 'different air date', keepStub: true },
            { variant: 'special', keepStub: true },
            { variant: 'unbound replacement', keepStub: true },
            { variant: 'inactive replacement', keepStub: true },
            { variant: 'dismissed replacement', keepStub: true },
            { variant: 'replacement in another series', keepStub: true },
        ])('$variant', async ({ variant, keepStub }) => {
            const day = relativeDate(3);
            const { episodeId: stubId, seriesId } = await insertEpisode(sql, 'Numbered Show', day);
            // The stale flat row and the renumbered row preserve absolute ordinal 53.
            await sql`UPDATE media_items SET episode_number = 53, sort_order = 53
                      WHERE id = ${stubId}::uuid`;
            const seasonId = crypto.randomUUID();
            const canonicalId = crypto.randomUUID();
            await sql`INSERT INTO media_items
                (id, title, media_type, status, parent_id, season_number)
                VALUES (${seasonId}::uuid, 'Season 3', 'season', 'active', ${seriesId}::uuid, 3)`;
            await sql`INSERT INTO media_items
                (id, title, media_type, status, parent_id, season_number, episode_number,
                 sort_order, premiere_date)
                VALUES (${canonicalId}::uuid, 'Episode 53', 'episode', 'active',
                        ${seasonId}::uuid, 3, 5, 53, ${day})`;
            if (variant !== 'unbound replacement') {
                await insertExternalId(sql, canonicalId, 'tmdb', '7810342', 'episode');
            }
            if (variant === 'file-backed stub') {
                await sql`UPDATE media_items SET has_files = true WHERE id = ${stubId}::uuid`;
            } else if (variant === 'linked file with stale has_files') {
                const groupId = crypto.randomUUID();
                await sql`INSERT INTO library_groups (id, name)
                          VALUES (${groupId}::uuid, 'Numbered Show Group')`;
                await attachFileInGroup(sql, stubId, groupId, '/calendar/numbered-stub.mkv');
            } else if (variant === 'locked metadata') {
                await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${stubId}::uuid`;
            } else if (variant === 'provider-bound episode') {
                await insertExternalId(sql, stubId, 'tvdb', '123456', 'episode');
            } else if (variant === 'different ordinal on a batch day') {
                await sql`UPDATE media_items SET sort_order = 54 WHERE id = ${canonicalId}::uuid`;
            } else if (variant === 'different air date') {
                await sql`UPDATE media_items SET premiere_date = ${relativeDate(4)}
                          WHERE id = ${canonicalId}::uuid`;
            } else if (variant === 'inactive replacement') {
                await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${canonicalId}::uuid`;
            } else if (variant === 'dismissed replacement') {
                await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${canonicalId}::uuid`;
            } else if (variant === 'replacement in another series') {
                const { seriesId: otherSeriesId } = await insertEpisode(sql, 'Other Show', null);
                await sql`UPDATE media_items SET parent_id = ${otherSeriesId}::uuid
                          WHERE id = ${seasonId}::uuid`;
            } else if (variant === 'special') {
                await sql`UPDATE media_items SET season_number = 0 WHERE id = ${stubId}::uuid`;
                await sql`UPDATE media_items SET season_number = 0 WHERE id = (
                          SELECT parent_id FROM media_items WHERE id = ${stubId}::uuid)`;
            }

            // Both feed modes must agree: these are two CATALOG rows, not an arr gap-fill.
            for (const includeMonitored of [false, true]) {
                const rows = await getCalendarItemsFromDb(
                    sql,
                    dateObj(0),
                    dateObj(7),
                    unrestrictedAccess(),
                    includeMonitored,
                );
                if (!['inactive replacement', 'dismissed replacement'].includes(variant)) {
                    expect(rows.some((row) => row.id === canonicalId)).toBe(true);
                }
                expect(rows.some((row) => row.id === stubId)).toBe(keepStub);
            }
        });
    });

    // -------------------------------------------------------------------------
    // Access filters
    // -------------------------------------------------------------------------

    it('excludes episodes whose series is in a denied library group', async () => {
        const groupId = crypto.randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${groupId}::uuid, 'Cal Denied Group')`;

        const inRange = relativeDate(2);
        const start = dateObj(0);
        const end = dateObj(7);

        const { episodeId: deniedEpId } = await insertEpisode(sql, 'Cal Denied Series', inRange);
        // Wire a file in the denied group to the series (buildLibraryAccessFilter uses mi.id,
        // aliased to the episode; it also checks via media_file_items on the series row for
        // the episode branch — match the builder's check which is at mi=episode level).
        const fileId = crypto.randomUUID();
        await sql`INSERT INTO media_files (id, file_path, library_group_id) VALUES (${fileId}::uuid, '/cal/denied.mkv', ${groupId}::uuid)`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order) VALUES (${fileId}::uuid, ${deniedEpId}::uuid, true, 0)`;

        const { episodeId: allowedEpId } = await insertEpisode(sql, 'Cal Allowed Series', inRange);

        const rows = await getCalendarItemsFromDb(
            sql,
            start,
            end,
            restrictedAccess({
                deniedGroupIds: [groupId],
                maxAgeRating: null,
                allowUnrated: false,
            }),
            false,
        );
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(allowedEpId);
        expect(ids).not.toContain(deniedEpId);

        await sql`DELETE FROM library_groups WHERE id = ${groupId}::uuid`;
    });

    // -------------------------------------------------------------------------
    // Age-rating filter (applied at series level for episodes)
    // -------------------------------------------------------------------------

    it('excludes episodes whose series exceeds the age-rating limit', async () => {
        const inRange = relativeDate(3);
        const start = dateObj(0);
        const end = dateObj(7);

        // Series with age_rating=18 (too high for a limit of 12).
        const { episodeId: adultEpId } = await insertEpisode(
            sql,
            'Cal Adult Series',
            inRange,
            false,
            18,
        );
        // Series with age_rating=10 (within limit).
        const { episodeId: kidsEpId } = await insertEpisode(
            sql,
            'Cal Kids Series',
            inRange,
            false,
            10,
        );

        const rows = await getCalendarItemsFromDb(
            sql,
            start,
            end,
            restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: false }),
            false,
        );
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(kidsEpId);
        expect(ids).not.toContain(adultEpId);
    });

    it('includes episodes with null age_rating when allowUnrated=true', async () => {
        const inRange = relativeDate(3);
        const start = dateObj(0);
        const end = dateObj(7);

        const { episodeId: unratedEpId } = await insertEpisode(
            sql,
            'Cal Unrated Series',
            inRange,
            false,
            null, // null age_rating
        );

        const rows = await getCalendarItemsFromDb(
            sql,
            start,
            end,
            restrictedAccess({ deniedGroupIds: [], maxAgeRating: 12, allowUnrated: true }),
            false,
        );
        const ids = rows.map((r) => r.id);
        expect(ids).toContain(unratedEpId);
    });

    // -------------------------------------------------------------------------
    // Ordering
    // -------------------------------------------------------------------------

    it('orders results by premiere_date ASC', async () => {
        const start = dateObj(0);
        const end = dateObj(14);

        const { episodeId: ep3 } = await insertEpisode(sql, 'Cal Order 3', relativeDate(10));
        const { episodeId: ep1 } = await insertEpisode(sql, 'Cal Order 1', relativeDate(2));
        const { episodeId: ep2 } = await insertEpisode(sql, 'Cal Order 2', relativeDate(6));

        const rows = await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), false);
        const ourIds = rows
            .filter((r) => r.id !== null && [ep1, ep2, ep3].includes(r.id))
            .map((r) => r.id);

        expect(ourIds).toEqual([ep1, ep2, ep3]);
    });

    // -------------------------------------------------------------------------
    // Empty-range guard
    // -------------------------------------------------------------------------

    it('returns [] when no items fall in the range', async () => {
        const start = new Date('2000-01-01T00:00:00Z');
        const end = new Date('2000-01-07T00:00:00Z');

        const rows = await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), false);
        expect(rows).toEqual([]);
    });

    // -------------------------------------------------------------------------
    // Monitored gap-fill (Source 2 — upcoming_releases)
    // -------------------------------------------------------------------------

    describe('monitored gap-fill', () => {
        it('surfaces monitored arr-only episodes when includeMonitored=true', async () => {
            const inRange = relativeDate(3);
            const start = dateObj(0);
            const end = dateObj(7);

            await insertUpcomingRelease(sql, {
                source: 'sonarr',
                arrItemId: 5001,
                mediaType: 'episode',
                title: 'Monitored Ep',
                seriesTitle: 'Monitored Show',
                airDate: inRange,
                tmdbId: 999001,
                sourceSeriesId: 777,
                seasonNumber: 1,
                episodeNumber: 1,
            });

            const rows = await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), true);
            const monitored = rows.find((r) => r.title === 'Monitored Ep');
            expect(monitored).toBeDefined();
            expect(monitored?.id).toBeNull();
            expect(monitored?.source).toBe('monitored');
            expect(monitored?.series_name).toBe('Monitored Show');
            expect(monitored?.source_series_id).toBe(777);
            expect(monitored?.tmdb_id).toBe(999001);
        });

        // `includeMonitored` no longer has a default — it is a required parameter,
        // so "forgetting" it is a compile error rather than a silent catalog-only
        // read. This covers the explicit false.
        it('hides monitored arr-only entries when includeMonitored=false', async () => {
            const inRange = relativeDate(3);
            const start = dateObj(0);
            const end = dateObj(7);

            await insertUpcomingRelease(sql, {
                source: 'sonarr',
                arrItemId: 5002,
                mediaType: 'episode',
                title: 'Hidden Monitored Ep',
                airDate: inRange,
                tmdbId: 999002,
                seasonNumber: 1,
                episodeNumber: 1,
            });

            const rows = await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), false);
            expect(rows.some((r) => r.title === 'Hidden Monitored Ep')).toBe(false);
        });

        it('does not duplicate an arr entry that already exists in the catalog', async () => {
            const inRange = relativeDate(4);
            const start = dateObj(0);
            const end = dateObj(7);

            // Catalog series+episode (S1E1) with a TMDB id on the series.
            const { episodeId, seriesId } = await insertEpisode(sql, 'Dedup Show', inRange);
            await insertExternalId(sql, seriesId, 'tmdb', '424242', 'tv');

            // Same show/episode as a monitored arr entry — must be de-duped away.
            await insertUpcomingRelease(sql, {
                source: 'sonarr',
                arrItemId: 5003,
                mediaType: 'episode',
                title: 'Dedup Show S1E1',
                seriesTitle: 'Dedup Show Series',
                airDate: inRange,
                tmdbId: 424242,
                sourceSeriesId: 888,
                seasonNumber: 1,
                episodeNumber: 1,
            });

            const rows = await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), true);
            // The catalog row appears (with UUID); the monitored twin does not.
            const catalogRows = rows.filter((r) => r.id === episodeId);
            const monitoredTwins = rows.filter(
                (r) => r.source === 'monitored' && r.tmdb_id === 424242,
            );
            expect(catalogRows).toHaveLength(1);
            expect(monitoredTwins).toHaveLength(0);
        });

        it('matches the catalog series by TVDB id and de-dups by numbers', async () => {
            const inRange = relativeDate(4);
            const { seriesId } = await insertEpisode(sql, 'Tvdb Show', inRange);
            await insertExternalId(sql, seriesId, 'tvdb', '515151', 'tv');

            await insertUpcomingRelease(sql, {
                source: 'sonarr',
                arrItemId: 5101,
                mediaType: 'episode',
                title: 'Tvdb Show S1E1 (arr)',
                airDate: inRange,
                tvdbId: 515151,
                seasonNumber: 1,
                episodeNumber: 1,
            });

            const rows = await getCalendarItemsFromDb(
                sql,
                dateObj(0),
                dateObj(7),
                unrestrictedAccess(),
                true,
            );
            expect(rows.some((r) => r.title === 'Tvdb Show S1E1 (arr)')).toBe(false);
        });

        it('drops an arr entry numbered differently when the catalog series has an episode that day', async () => {
            // Sonarr numbers by TVDB (S2E3), the catalog by TMDB (S1E1 here).
            const inRange = relativeDate(5);
            const { seriesId } = await insertEpisode(sql, 'Renumbered Show', inRange);
            await insertExternalId(sql, seriesId, 'tmdb', '626262', 'tv');

            await insertUpcomingRelease(sql, {
                source: 'sonarr',
                arrItemId: 5102,
                mediaType: 'episode',
                title: 'Renumbered S2E3 (arr)',
                airDate: inRange,
                tmdbId: 626262,
                seasonNumber: 2,
                episodeNumber: 3,
            });

            const rows = await getCalendarItemsFromDb(
                sql,
                dateObj(0),
                dateObj(7),
                unrestrictedAccess(),
                true,
            );
            expect(rows.some((r) => r.title === 'Renumbered S2E3 (arr)')).toBe(false);
        });

        it('keeps the arr entries of a batch-release day the catalog covers only partly', async () => {
            // Catalog: one stub that day. Sonarr: two episodes. Neither number
            // matches, so the second episode must not vanish behind the date rule.
            const day = relativeDate(5);
            const { seriesId } = await insertEpisode(sql, 'Batch Show', day);
            await insertExternalId(sql, seriesId, 'tmdb', '959595', 'tv');
            for (const [arrItemId, episodeNumber] of [
                [5201, 7],
                [5202, 8],
            ]) {
                await insertUpcomingRelease(sql, {
                    source: 'sonarr',
                    arrItemId,
                    sourceSeriesId: 950,
                    mediaType: 'episode',
                    title: `Batch S2E${episodeNumber} (arr)`,
                    airDate: day,
                    tmdbId: 959595,
                    seasonNumber: 2,
                    episodeNumber,
                });
            }

            const rows = await getCalendarItemsFromDb(
                sql,
                dateObj(0),
                dateObj(7),
                unrestrictedAccess(),
                true,
            );
            expect(rows.filter((r) => r.title.startsWith('Batch S2E')).length).toBe(2);
        });

        it('a special on the same day does not cover a regular arr episode', async () => {
            const day = relativeDate(5);
            const { seriesId, episodeId } = await insertEpisode(sql, 'Special Day Show', day);
            await insertExternalId(sql, seriesId, 'tmdb', '969696', 'tv');
            // Turn the catalog episode into a season-0 special.
            await sql`UPDATE media_items SET season_number = 0 WHERE id = (
                SELECT parent_id FROM media_items WHERE id = ${episodeId}::uuid)`;
            await insertUpcomingRelease(sql, {
                source: 'sonarr',
                arrItemId: 5203,
                mediaType: 'episode',
                title: 'Special Day S3E1 (arr)',
                airDate: day,
                tmdbId: 969696,
                seasonNumber: 3,
                episodeNumber: 1,
            });

            const rows = await getCalendarItemsFromDb(
                sql,
                dateObj(0),
                dateObj(7),
                unrestrictedAccess(),
                true,
            );
            expect(rows.some((r) => r.title === 'Special Day S3E1 (arr)')).toBe(true);
        });

        it('keeps an arr entry of a catalog series on another day, with the series id attached', async () => {
            const { seriesId } = await insertEpisode(sql, 'Airing Show', relativeDate(1));
            await insertExternalId(sql, seriesId, 'tmdb', '737373', 'tv');

            await insertUpcomingRelease(sql, {
                source: 'sonarr',
                arrItemId: 5103,
                mediaType: 'episode',
                title: 'Airing Show S1E2 (arr)',
                airDate: relativeDate(6),
                tmdbId: 737373,
                seasonNumber: 1,
                episodeNumber: 2,
            });

            const rows = await getCalendarItemsFromDb(
                sql,
                dateObj(0),
                dateObj(7),
                unrestrictedAccess(),
                true,
            );
            const arr = rows.find((r) => r.title === 'Airing Show S1E2 (arr)');
            expect(arr?.source).toBe('monitored');
            expect(arr?.id).toBeNull();
            expect(arr?.series_id).toBe(seriesId);
        });

        it('attaches no series id when the matched catalog series is not active', async () => {
            const { seriesId } = await insertEpisode(sql, 'Retired Show', relativeDate(1));
            await insertExternalId(sql, seriesId, 'tmdb', '848484', 'tv');
            await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${seriesId}::uuid`;

            await insertUpcomingRelease(sql, {
                source: 'sonarr',
                arrItemId: 5104,
                mediaType: 'episode',
                title: 'Retired Show S1E2 (arr)',
                airDate: relativeDate(6),
                tmdbId: 848484,
                seasonNumber: 1,
                episodeNumber: 2,
            });

            const rows = await getCalendarItemsFromDb(
                sql,
                dateObj(0),
                dateObj(7),
                unrestrictedAccess(),
                true,
            );
            const arr = rows.find((r) => r.title === 'Retired Show S1E2 (arr)');
            expect(arr).toBeDefined();
            expect(arr?.series_id).toBeNull();
        });

        it('surfaces monitored arr-only movies when includeMonitored=true, hides when false', async () => {
            const inRange = relativeDate(2);
            const start = dateObj(0);
            const end = dateObj(7);

            await insertUpcomingRelease(sql, {
                source: 'radarr',
                arrItemId: 6001,
                mediaType: 'movie',
                title: 'Monitored Movie',
                airDate: inRange,
                tmdbId: 555001,
            });

            const withMonitored = await getCalendarItemsFromDb(
                sql,
                start,
                end,
                unrestrictedAccess(),
                true,
            );
            const mv = withMonitored.find((r) => r.title === 'Monitored Movie');
            expect(mv).toBeDefined();
            expect(mv?.media_type).toBe('movie');
            expect(mv?.source).toBe('monitored');
            expect(mv?.id).toBeNull();
            expect(mv?.tmdb_id).toBe(555001);

            const withoutMonitored = await getCalendarItemsFromDb(
                sql,
                start,
                end,
                unrestrictedAccess(),
                false,
            );
            expect(withoutMonitored.some((r) => r.title === 'Monitored Movie')).toBe(false);
        });

        it('respects the date window for monitored entries', async () => {
            const start = dateObj(0);
            const end = dateObj(7);

            await insertUpcomingRelease(sql, {
                source: 'sonarr',
                arrItemId: 5004,
                mediaType: 'episode',
                title: 'OutOfWindow Monitored',
                airDate: relativeDate(20),
                tmdbId: 999004,
                seasonNumber: 1,
                episodeNumber: 1,
            });

            const rows = await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), true);
            expect(rows.some((r) => r.title === 'OutOfWindow Monitored')).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // Access boundary — differential coverage
    //
    // Runs the SAME fixture twice, once unrestricted and once restricted, and
    // asserts the restricted result is a STRICT SUBSET. This is what catches a
    // boundary argument that arrived but was never used, or a predicate applied
    // to the wrong alias — both of which leave the "restricted" call returning
    // everything, which a per-case assertion on one hidden row can miss.
    //
    // The fixture deliberately isolates the two axes: each denied item fails
    // exactly ONE of them, on BOTH branches of the UNION. So dropping the
    // library fragment and dropping the age fragment produce different failures,
    // and neither axis can ride on the other. The episode cases specifically
    // pin the alias split — the library axis must land on the EPISODE row (which
    // owns the file rows) while the age axis must land on the SERIES row (which
    // owns age_rating); swapping either makes the corresponding row reappear.
    // -------------------------------------------------------------------------

    describe('access boundary', () => {
        const start = dateObj(0);
        const end = dateObj(7);

        // library_groups is not in TEST_TABLES.media, so it survives the shared
        // beforeEach truncate. Each seed uses a fresh UUID (no cross-test
        // interference) but clean up anyway so the table does not grow.
        afterEach(async () => {
            await sql`DELETE FROM library_groups WHERE name = 'Boundary Denied Group'`;
        });

        interface Fixture {
            groupId: string;
            epVisible: string;
            epDeniedByLibrary: string;
            epDeniedByAge: string;
            mvVisible: string;
            mvDeniedByLibrary: string;
            mvDeniedByAge: string;
        }

        async function seedBothAxes(): Promise<Fixture> {
            const inRange = relativeDate(3);
            const groupId = crypto.randomUUID();
            await sql`
                INSERT INTO library_groups (id, name)
                VALUES (${groupId}::uuid, 'Boundary Denied Group')
            `;

            // Episodes. age_rating lives on the SERIES row (insertEpisode's last
            // argument), never on the episode itself.
            const { episodeId: epVisible } = await insertEpisode(
                sql,
                'Bnd Ep Visible',
                inRange,
                false,
                10,
            );
            const { episodeId: epDeniedByLibrary } = await insertEpisode(
                sql,
                'Bnd Ep DeniedLib',
                inRange,
                false,
                10, // within the age limit — this row may fail ONLY the library axis
            );
            await attachFileInGroup(sql, epDeniedByLibrary, groupId, '/bnd/ep-denied.mkv');
            const { episodeId: epDeniedByAge } = await insertEpisode(
                sql,
                'Bnd Ep DeniedAge',
                inRange,
                false,
                18, // no file rows — this row may fail ONLY the age axis
            );

            // Movies. Both axes apply to the movie row itself.
            const mvVisible = await insertMovie(sql, 'Bnd Mv Visible', inRange, false, 10);
            const mvDeniedByLibrary = await insertMovie(
                sql,
                'Bnd Mv DeniedLib',
                inRange,
                false,
                10,
            );
            await attachFileInGroup(sql, mvDeniedByLibrary, groupId, '/bnd/mv-denied.mkv');
            const mvDeniedByAge = await insertMovie(sql, 'Bnd Mv DeniedAge', inRange, false, 18);

            return {
                groupId,
                epVisible,
                epDeniedByLibrary,
                epDeniedByAge,
                mvVisible,
                mvDeniedByLibrary,
                mvDeniedByAge,
            };
        }

        /** Boundary denying `groupId` AND limiting age to 12 — both axes active. */
        function bothAxesRestricted(groupId: string): MediaAccessBoundary {
            return restrictedAccess({
                deniedGroupIds: [groupId],
                maxAgeRating: 12,
                allowUnrated: false,
            });
        }

        it('restricted result is a strict subset of the unrestricted result', async () => {
            const f = await seedBothAxes();

            const unrestricted = await getCalendarItemsFromDb(
                sql,
                start,
                end,
                unrestrictedAccess(),
                false,
            );
            const restricted = await getCalendarItemsFromDb(
                sql,
                start,
                end,
                bothAxesRestricted(f.groupId),
                false,
            );

            const unrestrictedIds = new Set(unrestricted.map((r) => r.id));
            const restrictedIds = restricted.map((r) => r.id);

            // Subset: nothing appears under the restricted boundary that the
            // unrestricted boundary did not already return.
            for (const id of restrictedIds) {
                expect(unrestrictedIds.has(id)).toBe(true);
            }
            // Strict: the boundary actually removed rows. Without this a query
            // that ignores its boundary argument entirely still passes above.
            expect(restricted.length).toBeLessThan(unrestricted.length);
        });

        it('each axis independently removes rows on BOTH union branches', async () => {
            const f = await seedBothAxes();

            const unrestricted = new Set(
                (await getCalendarItemsFromDb(sql, start, end, unrestrictedAccess(), false)).map(
                    (r) => r.id,
                ),
            );
            // Every fixture row is visible without a boundary — otherwise the
            // exclusions below would prove nothing.
            expect(unrestricted).toContain(f.epVisible);
            expect(unrestricted).toContain(f.epDeniedByLibrary);
            expect(unrestricted).toContain(f.epDeniedByAge);
            expect(unrestricted).toContain(f.mvVisible);
            expect(unrestricted).toContain(f.mvDeniedByLibrary);
            expect(unrestricted).toContain(f.mvDeniedByAge);

            // Library axis only.
            const libOnly = new Set(
                (
                    await getCalendarItemsFromDb(
                        sql,
                        start,
                        end,
                        restrictedAccess({
                            deniedGroupIds: [f.groupId],
                            maxAgeRating: null,
                            allowUnrated: false,
                        }),
                        false,
                    )
                ).map((r) => r.id),
            );
            expect(libOnly).not.toContain(f.epDeniedByLibrary);
            expect(libOnly).not.toContain(f.mvDeniedByLibrary);
            // The age-denied rows survive — proves this is the library axis alone.
            expect(libOnly).toContain(f.epDeniedByAge);
            expect(libOnly).toContain(f.mvDeniedByAge);

            // Age axis only.
            const ageOnly = new Set(
                (
                    await getCalendarItemsFromDb(
                        sql,
                        start,
                        end,
                        restrictedAccess({
                            deniedGroupIds: [],
                            maxAgeRating: 12,
                            allowUnrated: false,
                        }),
                        false,
                    )
                ).map((r) => r.id),
            );
            expect(ageOnly).not.toContain(f.epDeniedByAge);
            expect(ageOnly).not.toContain(f.mvDeniedByAge);
            // The library-denied rows survive — proves this is the age axis alone.
            expect(ageOnly).toContain(f.epDeniedByLibrary);
            expect(ageOnly).toContain(f.mvDeniedByLibrary);

            // Both axes: only the two clean rows remain.
            const both = new Set(
                (
                    await getCalendarItemsFromDb(
                        sql,
                        start,
                        end,
                        bothAxesRestricted(f.groupId),
                        false,
                    )
                ).map((r) => r.id),
            );
            expect([...both].sort()).toEqual([f.epVisible, f.mvVisible].sort());
        });

        it('a denyAll boundary returns an empty result', async () => {
            await seedBothAxes();

            const rows = await getCalendarItemsFromDb(sql, start, end, denyAllAccess(), false);
            expect(rows).toEqual([]);
        });

        it('denyAll suppresses the monitored gap-fill even when it is requested', async () => {
            // Source 2 carries no library group and no content rating, so it has
            // nothing for either builder to attach to. Its suppression rests
            // entirely on the module's own short-circuit — if that regressed,
            // a deny-everything caller would still receive monitored titles.
            await insertUpcomingRelease(sql, {
                source: 'sonarr',
                arrItemId: 7001,
                mediaType: 'episode',
                title: 'DenyAll Monitored Ep',
                airDate: relativeDate(3),
                tmdbId: 991001,
                seasonNumber: 1,
                episodeNumber: 1,
            });

            const rows = await getCalendarItemsFromDb(sql, start, end, denyAllAccess(), true);
            expect(rows).toEqual([]);
        });

        it('a restricted boundary suppresses the monitored gap-fill even when requested', async () => {
            // The access half of the gap-fill gate is enforced INSIDE the module,
            // not trusted to the caller — a caller that computes its own
            // includeMonitored wrongly must not be able to leak arr titles to a
            // restricted user.
            const f = await seedBothAxes();
            await insertUpcomingRelease(sql, {
                source: 'sonarr',
                arrItemId: 7002,
                mediaType: 'episode',
                title: 'Restricted Monitored Ep',
                airDate: relativeDate(3),
                tmdbId: 991002,
                seasonNumber: 1,
                episodeNumber: 1,
            });

            const restricted = await getCalendarItemsFromDb(
                sql,
                start,
                end,
                bothAxesRestricted(f.groupId),
                true,
            );
            expect(restricted.some((r) => r.title === 'Restricted Monitored Ep')).toBe(false);

            // Sanity: the row IS reachable for an unrestricted boundary, so the
            // assertion above is about the boundary and not about the fixture.
            const unrestricted = await getCalendarItemsFromDb(
                sql,
                start,
                end,
                unrestrictedAccess(),
                true,
            );
            expect(unrestricted.some((r) => r.title === 'Restricted Monitored Ep')).toBe(true);
        });
    });
});
