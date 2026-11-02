// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Differential access-boundary tests for `search.queries.ts`.
 *
 * Every exported search function now takes a required {@link MediaAccessBoundary}.
 * Types guarantee the argument ARRIVES; they cannot guarantee it is USED, that
 * it is applied to the right table alias, or that it lands in the outer WHERE
 * rather than inside a CTE that has already materialized denied ids. That is
 * what this suite is for.
 *
 * Per the access-boundary design spec, each query is run three ways against one
 * fixture:
 *
 *   1. `unrestrictedAccess()`  — POSITIVE CONTROL. Must be non-empty.
 *   2. a restricted boundary   — must be a STRICT SUBSET of (1).
 *   3. `denyAllAccess()`       — must be EMPTY.
 *
 * The positive control is load-bearing, not decoration: every function in
 * `search.queries.ts` catches its own errors and returns `[]`. Without (1), a
 * `denyAll` assertion would pass just as happily when the SQL threw as when the
 * predicate worked.
 *
 * Run with:
 *   npm run test:integration -- src/lib/server/database/queries/search-access-boundary.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createAndInsertTestSeries,
    insertTestSeason,
    createTestEpisode,
    insertTestEpisode,
    createTestArtist,
    createTestAlbum,
    createTestTrack,
    insertTestArtist,
    insertTestAlbum,
    insertTestTrack,
    placeInLibraryGroup,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    searchMedia,
    searchMediaFulltext,
    searchMediaTrigram,
    searchMusic,
    searchEpisode,
    searchAdminQuickNav,
    findSeriesContext,
} from './search.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

// =============================================================================
// Shared assertion
// =============================================================================

/**
 * Assert a query actually honours its access boundary.
 *
 * @param run - runs the query under the supplied boundary
 * @param keyOf - stable identity for a returned row
 * @param restricted - a boundary that must hide at least the seeded row
 */
async function expectAccessFiltered<T>(
    run: (access: MediaAccessBoundary) => Promise<T[]>,
    keyOf: (row: T) => string,
    restricted: MediaAccessBoundary,
): Promise<{ open: string[]; narrowed: string[] }> {
    const open = (await run(unrestrictedAccess())).map(keyOf);
    // POSITIVE CONTROL — proves the fixture is reachable and the SQL runs. A
    // swallowed error would surface here as an empty set.
    expect(open.length, 'unrestricted boundary must return rows').toBeGreaterThan(0);

    const narrowed = (await run(restricted)).map(keyOf);
    // STRICT SUBSET: nothing new appears, and at least one row disappears.
    const openSet = new Set(open);
    expect(narrowed.every((k) => openSet.has(k))).toBe(true);
    expect(narrowed.length).toBeLessThan(open.length);

    const denied = (await run(denyAllAccess())).map(keyOf);
    expect(denied).toEqual([]);

    return { open, narrowed };
}

/** Boundary denying exactly the given library groups; age unrestricted. */
function denyGroups(...ids: string[]): MediaAccessBoundary {
    return restrictedAccess({ deniedGroupIds: ids, maxAgeRating: null, allowUnrated: true });
}

/** Boundary capping the age rating; library unrestricted. */
function ageLimit(maxAgeRating: number): MediaAccessBoundary {
    return restrictedAccess({ deniedGroupIds: [], maxAgeRating, allowUnrated: false });
}

// =============================================================================
// Fixture helpers
// =============================================================================

async function createLibraryGroup(sql: postgres.Sql, name: string): Promise<string> {
    const id = crypto.randomUUID();
    await sql`INSERT INTO library_groups (id, name) VALUES (${id}::uuid, ${name})`;
    return id;
}

/**
 * Insert a movie/tv item with a media_files row in `libraryGroupId`, so the
 * library-access predicate has a non-NULL group to exclude.
 */
async function insertItemInGroup(
    sql: postgres.Sql,
    opts: {
        title: string;
        mediaType: 'movie' | 'tv';
        libraryGroupId: string | null;
        ageRating?: number | null;
    },
): Promise<string> {
    const item = createTestMediaItem({
        title: opts.title,
        media_type: opts.mediaType,
        has_files: true,
    });
    await insertTestMediaItem(sql, item);
    if (opts.ageRating !== undefined) {
        await sql`
            UPDATE media_items SET age_rating = ${opts.ageRating} WHERE id = ${item.id}::uuid
        `;
    }
    await attachFile(sql, item.id, opts.libraryGroupId);
    return item.id;
}

/** Attach a media_files row (optionally in a library group) to a media item. */
async function attachFile(
    sql: postgres.Sql,
    mediaItemId: string,
    libraryGroupId: string | null,
): Promise<void> {
    const [{ id: fileId }] = await sql<[{ id: string }]>`
        INSERT INTO media_files (file_path, library_group_id)
        VALUES (${`/data/${mediaItemId}.mkv`}, ${libraryGroupId}::uuid)
        ON CONFLICT (file_path) DO UPDATE SET library_group_id = EXCLUDED.library_group_id
        RETURNING id
    `;
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id)
        VALUES (${fileId}::uuid, ${mediaItemId}::uuid)
        ON CONFLICT DO NOTHING
    `;
    await sql`UPDATE media_items SET has_files = true WHERE id = ${mediaItemId}::uuid`;
}

// A token unique enough that FTS/trigram cannot collide with other fixtures.
const TAG = 'Zylvorak';

// =============================================================================

describe('search.queries — access boundary is honoured (differential)', () => {
    let sql: postgres.Sql;
    let groupA: string;
    let groupB: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        groupA = await createLibraryGroup(sql, 'Group A');
        groupB = await createLibraryGroup(sql, 'Group B');
    });

    // -------------------------------------------------------------------------
    // searchMedia — builders on the `mi` alias, outer WHERE
    // -------------------------------------------------------------------------

    it('searchMedia: library scope hides denied-group rows, denyAll returns empty', async () => {
        await insertItemInGroup(sql, {
            title: `${TAG} Alpha`,
            mediaType: 'movie',
            libraryGroupId: groupA,
        });
        await insertItemInGroup(sql, {
            title: `${TAG} Beta`,
            mediaType: 'movie',
            libraryGroupId: groupB,
        });

        const { narrowed } = await expectAccessFiltered(
            (access) => searchMedia(sql, TAG, access, { availableOnly: true }),
            (r) => String(r.internal_id),
            denyGroups(groupA),
        );
        expect(narrowed).toHaveLength(1);
    });

    it('searchMedia: age scope hides over-age rows', async () => {
        await insertItemInGroup(sql, {
            title: `${TAG} Kids`,
            mediaType: 'movie',
            libraryGroupId: groupA,
            ageRating: 6,
        });
        await insertItemInGroup(sql, {
            title: `${TAG} Adults`,
            mediaType: 'movie',
            libraryGroupId: groupA,
            ageRating: 18,
        });

        const { narrowed } = await expectAccessFiltered(
            (access) => searchMedia(sql, TAG, access, { availableOnly: true }),
            (r) => String(r.internal_id),
            ageLimit(12),
        );
        expect(narrowed).toHaveLength(1);
    });

    // -------------------------------------------------------------------------
    // searchMediaFulltext
    // -------------------------------------------------------------------------

    it('searchMediaFulltext: library scope hides denied-group rows', async () => {
        await insertItemInGroup(sql, {
            title: `${TAG} Alpha`,
            mediaType: 'movie',
            libraryGroupId: groupA,
        });
        await insertItemInGroup(sql, {
            title: `${TAG} Beta`,
            mediaType: 'movie',
            libraryGroupId: groupB,
        });

        await expectAccessFiltered(
            (access) => searchMediaFulltext(sql, TAG, access, { availableOnly: true }),
            (r) => String(r.internal_id),
            denyGroups(groupA),
        );
    });

    // -------------------------------------------------------------------------
    // searchMediaTrigram — fragments must be built on the `tx` handle, not `sql`
    // -------------------------------------------------------------------------

    it('searchMediaTrigram: library scope hides denied-group rows inside the tx', async () => {
        // Trigram needs a >= 3-char query, and the query must be a near-miss of
        // the titles rather than an exact prefix.
        await insertItemInGroup(sql, {
            title: `${TAG}a`,
            mediaType: 'movie',
            libraryGroupId: groupA,
        });
        await insertItemInGroup(sql, {
            title: `${TAG}b`,
            mediaType: 'movie',
            libraryGroupId: groupB,
        });

        await expectAccessFiltered(
            (access) =>
                searchMediaTrigram(sql, TAG, access, {
                    mediaTypes: ['movie'],
                    availableOnly: true,
                }),
            (r) => String(r.internal_id),
            denyGroups(groupA),
        );
    });

    // -------------------------------------------------------------------------
    // searchMusic — hand-rolled hierarchy-aware predicate, MATERIALIZED CTE
    // -------------------------------------------------------------------------

    it('searchMusic: library scope hides tracks whose file sits in a denied group', async () => {
        const artist = createTestArtist({ title: `${TAG} Band` });
        await insertTestArtist(sql, artist);
        const album = createTestAlbum(artist.id, { title: `${TAG} Record` });
        await insertTestAlbum(sql, album);

        const inA = createTestTrack(album.id, 1, { title: `${TAG} Song One` });
        await insertTestTrack(sql, inA);
        const inB = createTestTrack(album.id, 2, { title: `${TAG} Song Two` });
        await insertTestTrack(sql, inB);

        // Fixtures create a media_files row per track; move each into a group.
        await moveTrackFileToGroup(sql, inA.id, groupA);
        await moveTrackFileToGroup(sql, inB.id, groupB);

        const { open, narrowed } = await expectAccessFiltered(
            (access) => searchMusic(sql, `${TAG} Song`, 50, access, { offset: 0 }),
            (r) => r.id,
            denyGroups(groupA),
        );
        expect(open).toContain(inA.id);
        expect(narrowed).not.toContain(inA.id);
        expect(narrowed).toContain(inB.id);
    });

    // -------------------------------------------------------------------------
    // searchEpisode — predicates are hand-inlined against the `series` alias
    // -------------------------------------------------------------------------

    it("searchEpisode: the library axis judges the EPISODE's own file, age the series", async () => {
        // searchEpisode RETURNS episode rows, so the precise library rule is the
        // episode's own file — the leaf that actually carries library_group_id.
        // The old hand-inlined predicate correlated to `series.id`, and no `tv`
        // row owns media_file_items (0 of 6,570 on production, 2026-09-15), so
        // its `NOT EXISTS (own files)` arm was ALWAYS true and the library axis
        // did nothing. Placing the file on the episode is what a real scan does.
        const seriesTag = `${TAG} Colony`;
        const seeded: Array<{ episodeId: string; group: string }> = [];
        let tmdbSeq = 980_100;
        for (const [suffix, group] of [
            ['North', groupA],
            ['South', groupB],
        ] as const) {
            const series = await createAndInsertTestSeries(sql, {
                title: `${seriesTag} ${suffix}`,
                // createAndInsertTestSeries defaults tmdbId to a RANDOMLY picked
                // SAMPLE_TV_SHOWS entry, so two series seeded in one test collide
                // on external_ids_provider_external_id_media_type_key about half
                // the time. Pin them.
                tmdbId: tmdbSeq++,
                seasonCount: 1,
                episodesPerSeason: 0,
            });
            const seasonId = await insertTestSeason(
                sql,
                {
                    jellyfin_id: `jf-season-${crypto.randomUUID().slice(0, 8)}`,
                    series_jellyfin_id: series.seriesJellyfinId,
                    season_number: 2,
                    episode_count: 1,
                },
                series.seriesId,
            );
            const ep = createTestEpisode(series.seriesJellyfinId, 2, 5, { title: 'Episode Five' });
            const episodeId = await insertTestEpisode(sql, ep, seasonId);
            await placeInLibraryGroup(sql, {
                mediaItemId: episodeId,
                mediaType: 'episode',
                libraryGroupId: group,
            });
            seeded.push({ episodeId, group });
        }
        const [inA, inB] = seeded;

        const { open, narrowed } = await expectAccessFiltered(
            (access) => searchEpisode(sql, seriesTag, 2, 5, access),
            (r) => r.id,
            denyGroups(groupA),
        );
        expect(open).toContain(inA.episodeId);
        expect(narrowed).not.toContain(inA.episodeId);
        expect(narrowed).toContain(inB.episodeId);

        // Age axis, applied via buildAgeRatingFilter with the `series` alias —
        // unchanged, and still evaluated against the SERIES row.
        await sql`
            UPDATE media_items SET age_rating = 18
            WHERE media_type = 'tv' AND title LIKE ${`${seriesTag}%`}
        `;
        expect(await searchEpisode(sql, seriesTag, 2, 5, ageLimit(12))).toEqual([]);
        expect((await searchEpisode(sql, seriesTag, 2, 5, ageLimit(18))).length).toBeGreaterThan(0);
    });

    it('searchEpisode: an episode with NO file at all stays visible (Jellyfin-only fail-open)', async () => {
        const seriesTitle = `${TAG} Ghostline`;
        const series = await createAndInsertTestSeries(sql, {
            title: seriesTitle,
            tmdbId: 980_200,
            seasonCount: 1,
            episodesPerSeason: 0,
        });
        const seasonId = await insertTestSeason(
            sql,
            {
                jellyfin_id: `jf-season-${crypto.randomUUID().slice(0, 8)}`,
                series_jellyfin_id: series.seriesJellyfinId,
                season_number: 3,
                episode_count: 1,
            },
            series.seriesId,
        );
        const ep = createTestEpisode(series.seriesJellyfinId, 3, 1, { title: 'Catalog Only' });
        const episodeId = await insertTestEpisode(sql, ep, seasonId);

        const narrowed = await searchEpisode(sql, seriesTitle, 3, 1, denyGroups(groupA, groupB));
        expect(narrowed.map((r) => r.id)).toContain(episodeId);
    });

    // -------------------------------------------------------------------------
    // findSeriesContext — previously coerced `deniedGroupIds ?? []`
    // -------------------------------------------------------------------------

    it('findSeriesContext: library scope hides the series, denyAll returns not-found', async () => {
        const seriesTitle = `${TAG} Lineage`;
        const series = await createAndInsertTestSeries(sql, {
            title: seriesTitle,
            seasonCount: 1,
            episodesPerSeason: 0,
        });
        // findSeriesContext filters the `tv` row through buildLibraryAccessFilter,
        // whose container branch judges a series by its SEASON -> EPISODE
        // descendants' files — never by a file attached to the series row itself.
        // `attachFile(series.seriesId, ...)` would therefore leave the series an
        // empty stub the predicate admits, and the restriction would do nothing.
        await placeInLibraryGroup(sql, {
            mediaItemId: series.seriesId,
            mediaType: 'tv',
            libraryGroupId: groupA,
        });

        const open = await findSeriesContext(sql, seriesTitle, unrestrictedAccess());
        expect(open.found).toBe(true);

        const narrowed = await findSeriesContext(sql, seriesTitle, denyGroups(groupA));
        expect(narrowed.found).toBe(false);

        const denied = await findSeriesContext(sql, seriesTitle, denyAllAccess());
        expect(denied.found).toBe(false);
    });

    // -------------------------------------------------------------------------
    // searchAdminQuickNav — admin surface; unrestricted must be unchanged, but
    // the boundary must still be wired (denyAll closes it).
    // -------------------------------------------------------------------------

    it('searchAdminQuickNav: unrestricted returns rows, denyAll returns empty', async () => {
        await insertItemInGroup(sql, {
            title: `${TAG} Admin Movie`,
            mediaType: 'movie',
            libraryGroupId: groupA,
        });

        const open = await searchAdminQuickNav(sql, `${TAG} Admin`, unrestrictedAccess());
        expect(open.length).toBeGreaterThan(0);

        const denied = await searchAdminQuickNav(sql, `${TAG} Admin`, denyAllAccess());
        expect(denied).toEqual([]);
    });
});

/** Point a track's fixture-created media_files row at a library group. */
async function moveTrackFileToGroup(
    sql: postgres.Sql,
    trackId: string,
    libraryGroupId: string,
): Promise<void> {
    await sql`
        UPDATE media_files mf
        SET library_group_id = ${libraryGroupId}::uuid
        FROM media_file_items mfi
        WHERE mfi.file_id = mf.id
          AND mfi.media_item_id = ${trackId}::uuid
    `;
}
