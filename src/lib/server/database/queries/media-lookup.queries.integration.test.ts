// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Media Lookup Query Module
 *
 * Tests UUID resolution, Jellyfin ID lookups, media details,
 * and external ID operations.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createTestExternalIds,
    insertTestExternalIds,
    placeInLibraryGroup,
} from '../../../../../tests/integration/fixtures/index.js';

// Import query functions to test
import {
    mediaItemExistsByUuid,
    getMediaDetailsById,
    getMediaItemById,
    getExternalIdsByMediaId,
    buildExternalIdsObject,
    findSeriesByName,
    getMediaFileDuration,
} from './media-lookup.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';

describe('Media Lookup Queries', () => {
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

    // ==========================================================================
    // UUID / Internal ID Lookups
    // ==========================================================================

    describe('mediaItemExistsByUuid', () => {
        it('returns id when media item exists', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await mediaItemExistsByUuid(sql, item.id);
            expect(result).toBe(item.id);
        });

        it('returns null for non-existent UUID', async () => {
            const result = await mediaItemExistsByUuid(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBeNull();
        });

        it('returns null for deleted items', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                status: 'deleted',
            });
            await insertTestMediaItem(sql, item);

            const result = await mediaItemExistsByUuid(sql, item.id);
            expect(result).toBeNull();
        });
    });

    // ==========================================================================
    // Media Details
    // ==========================================================================

    describe('getMediaDetailsById', () => {
        it('returns full media details with metadata', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // Add provider metadata
            const metadata = {
                poster_path: '/poster.jpg',
                backdrop_path: '/backdrop.jpg',
                overview: 'A test movie',
                runtime_minutes: 120,
                imdb_rating: 8.5,
                genres: ['Action', 'Sci-Fi'],
            };
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${item.id}::uuid, 'aggregated', ${sql.json(metadata)}, NOW())
            `;

            // Add Jellyfin external ID (dashless — normalization removes dashes)
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${item.id}::uuid, 'jellyfin', 'jfdetails001', 'movie', false)
            `;

            // Add media file to make is_available = true.
            // isAvailableExpr reads mi.has_files (O(1) column), not EXISTS(media_file_items).
            // We must insert the file record AND flip has_files = true on the media item.
            const [fileRow] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path) VALUES ('/test/details.mkv') RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileRow.id}::uuid, ${item.id}::uuid)
            `;
            await sql`
                UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid
            `;

            const details = await getMediaDetailsById(sql, item.id);

            expect(details).not.toBeNull();
            expect(details?.title).toBe(item.title);
            expect(details?.poster_path).toBe('/poster.jpg');
            expect(details?.overview).toBe('A test movie');
            expect(details?.runtime_minutes).toBe(120);
            // JSONB extraction returns string, compare as number
            expect(Number(details?.imdb_rating)).toBe(8.5);
            expect(details?.is_available).toBe(true);
            // Jellyfin ID returned from external_ids (stored dashless)
            // Jellyfin item ids are sync-only: not part of the details row.
            expect(details).not.toHaveProperty('jellyfin_id');
        });

        it('returns null for non-existent media', async () => {
            const details = await getMediaDetailsById(sql, '00000000-0000-0000-0000-000000000000');
            expect(details).toBeNull();
        });

        it('returns item without metadata', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const details = await getMediaDetailsById(sql, item.id);

            expect(details).not.toBeNull();
            expect(details?.title).toBe(item.title);
            expect(details?.poster_path).toBeNull();
            expect(details?.is_available).toBe(false);
        });

        it('prefers aggregated over tmdb metadata', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES
                    (${item.id}::uuid, 'aggregated', ${sql.json({ poster_path: '/aggregated.jpg' })}, NOW()),
                    (${item.id}::uuid, 'tmdb', ${sql.json({ poster_path: '/tmdb.jpg' })}, NOW())
            `;

            const details = await getMediaDetailsById(sql, item.id);
            expect(details?.poster_path).toBe('/aggregated.jpg');
        });

        it('fills fields the aggregated row is missing from a source provider', async () => {
            // Regression: a stale/partial 'aggregated' row (computed while tmdb
            // was sparse, then tmdb was enriched) must NOT blank overview/poster/
            // genres in the detail modal. The merged lateral join keeps the
            // aggregated value where it exists and fills the rest from tmdb.
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES
                    (${item.id}::uuid, 'aggregated', ${sql.json({ poster_path: '/aggregated.jpg' })}, NOW()),
                    (${item.id}::uuid, 'tmdb', ${sql.json({
                        poster_path: '/tmdb.jpg',
                        backdrop_path: '/tmdb-backdrop.jpg',
                        overview: 'Rich overview from tmdb',
                        genres: [{ name: 'Drama' }],
                    })}, NOW())
            `;

            const details = await getMediaDetailsById(sql, item.id);
            // aggregated wins for the one field it actually carries…
            expect(details?.poster_path).toBe('/aggregated.jpg');
            // …and every field it lacks falls through to tmdb instead of NULL.
            expect(details?.overview).toBe('Rich overview from tmdb');
            expect(details?.backdrop_path).toBe('/tmdb-backdrop.jpg');
            expect(details?.genres).toEqual(['Drama']);
        });

        it('falls back to the local overview/runtime when the provider carries empty ones', async () => {
            // Regression (iOS report, "Milo Farrow und der geheime Pornokeller"):
            // TMDB returns overview '' and runtime_minutes 0 for obscure titles.
            // Empty is not a value — it must not shadow the scanned local data,
            // or the detail endpoint serves no description and runtime 0 for an
            // item whose own row has both.
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                UPDATE media_items
                   SET overview = 'Local overview from the NFO',
                       runtime_seconds = 5745
                 WHERE id = ${item.id}::uuid
            `;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${item.id}::uuid, 'tmdb', ${sql.json({
                    overview: '',
                    runtime_minutes: 0,
                })}, NOW())
            `;

            const details = await getMediaDetailsById(sql, item.id);
            expect(details?.overview).toBe('Local overview from the NFO');
            expect(details?.runtime_minutes).toBe(96);
        });

        it('still prefers a non-empty provider overview over the local one', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                UPDATE media_items SET overview = 'Local overview' WHERE id = ${item.id}::uuid
            `;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${item.id}::uuid, 'tmdb', ${sql.json({
                    overview: 'Provider overview',
                })}, NOW())
            `;

            const details = await getMediaDetailsById(sql, item.id);
            expect(details?.overview).toBe('Provider overview');
        });
    });

    describe('getMediaItemById', () => {
        it('returns basic media item info', async () => {
            const item = createTestMediaItem({
                media_type: 'tv',
                title: 'Test Show',
                year: 2024,
            });
            await insertTestMediaItem(sql, item);

            const result = await getMediaItemById(sql, item.id);

            expect(result).not.toBeNull();
            expect(result?.id).toBe(item.id);
            expect(result?.title).toBe('Test Show');
            expect(result?.media_type).toBe('tv');
            expect(result?.year).toBe(2024);
        });

        it('returns null for non-existent item', async () => {
            const result = await getMediaItemById(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBeNull();
        });
    });

    // ==========================================================================
    // External IDs
    // ==========================================================================

    describe('getExternalIdsByMediaId', () => {
        it('returns all external IDs for media item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const externalIds = createTestExternalIds(item.id, {
                tmdbId: 550,
                imdbId: 'tt0137523',
                jellyfinId: 'jf-ext-001',
                mediaType: 'movie',
            });
            await insertTestExternalIds(sql, externalIds);

            const result = await getExternalIdsByMediaId(sql, item.id);

            expect(result.length).toBe(3);
            expect(result.some((r) => r.provider === 'tmdb')).toBe(true);
            expect(result.some((r) => r.provider === 'imdb')).toBe(true);
            expect(result.some((r) => r.provider === 'jellyfin')).toBe(true);
        });

        it('returns empty array when no external IDs', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await getExternalIdsByMediaId(sql, item.id);
            expect(result).toEqual([]);
        });
    });

    describe('buildExternalIdsObject', () => {
        it('converts records to object and leaves the sync-only Jellyfin id out', () => {
            const records = [
                { provider: 'tmdb', external_id: '550' },
                { provider: 'imdb', external_id: 'tt0137523' },
                { provider: 'jellyfin', external_id: 'jf-001' },
            ];

            const result = buildExternalIdsObject(records);

            expect(result).toEqual({
                tmdb: '550',
                imdb: 'tt0137523',
            });
        });

        it('returns empty object for empty array', () => {
            const result = buildExternalIdsObject([]);
            expect(result).toEqual({});
        });
    });

    // ==========================================================================
    // Genre extraction in getMediaDetailsById
    // (regression: "NULL NULL NULL" in ForYou modal)
    // ==========================================================================

    describe('getMediaDetailsById genre extraction', () => {
        /**
         * Insert a media item with specific genres metadata and return the
         * result of getMediaDetailsById so genre extraction can be asserted.
         */
        async function insertMovieAndGetDetails(localSql: postgres.Sql, genres: unknown) {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(localSql, item);

            await localSql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${item.id}::uuid, 'aggregated', ${localSql.json({ genres } as Parameters<typeof localSql.json>[0])}, NOW())
            `;

            return getMediaDetailsById(localSql, item.id);
        }

        it('returns genre names from JSONB object array [{"id":80,"name":"Crime"}]', async () => {
            // Object format: metadata synced via full TMDB fetch
            const details = await insertMovieAndGetDetails(sql, [
                { id: 80, name: 'Crime' },
                { id: 9648, name: 'Mystery' },
            ]);

            expect(details).not.toBeNull();
            expect(details?.genres).toBeDefined();
            expect(details?.genres).not.toBeNull();
            expect(details?.genres).toContain('Crime');
            expect(details?.genres).toContain('Mystery');
            // Must NOT contain literal "null" string
            expect(details?.genres).not.toContain('null');
        });

        it('returns null genres (not ["null","null"]) from bare integer array [80, 9648]', async () => {
            // Bare integer format: genres stored as integer IDs, not objects.
            // The query filters them out (only extracts from JSONB objects),
            // so genres should be null rather than ["null", "null"].
            const details = await insertMovieAndGetDetails(sql, [80, 9648]);

            expect(details).not.toBeNull();
            // Must be null/undefined — bare integers have no 'name' field to extract
            expect(details?.genres ?? null).toBeNull();
        });

        it('returns null genres when genres key is absent', async () => {
            const details = await insertMovieAndGetDetails(sql, null);

            expect(details).not.toBeNull();
            expect(details?.genres ?? null).toBeNull();
        });

        it('skips null entries in JSONB object arrays without crashing', async () => {
            // Defensive: some metadata might have sparse arrays
            const details = await insertMovieAndGetDetails(sql, [
                { id: 80, name: 'Crime' },
                null,
                { id: 9648, name: 'Mystery' },
            ]);

            expect(details).not.toBeNull();
            expect(details?.genres).toContain('Crime');
            expect(details?.genres).toContain('Mystery');
            expect(details?.genres).not.toContain('null');
        });
    });

    // ==========================================================================
    // findSeriesByName — UUID-first + trigram `%` rewrite (16.80.0)
    // ==========================================================================

    describe('findSeriesByName', () => {
        async function insertTvSeries(
            title: string,
            opts: { hasFiles?: boolean; originalTitle?: string } = {},
        ): Promise<string> {
            const item = createTestMediaItem({ title, media_type: 'tv', status: 'active' });
            await insertTestMediaItem(sql, item);
            if (opts.originalTitle) {
                await sql`UPDATE media_items SET original_title = ${opts.originalTitle} WHERE id = ${item.id}::uuid`;
            }
            if (opts.hasFiles !== false) {
                await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
            }
            return item.id;
        }

        const opts = unrestrictedAccess();

        it('finds a series by exact title and returns its internal UUID as identity', async () => {
            const id = await insertTvSeries('Quoria Frontier');
            const result = await findSeriesByName(sql, 'Quoria Frontier', opts);
            expect(result?.internal_id).toBe(id);
            expect(result?.title).toBe('Quoria Frontier');
        });

        it('matches case-insensitively (trigram % subsumes the dropped LOWER exact branch)', async () => {
            const id = await insertTvSeries('Zelvian Tides');
            const result = await findSeriesByName(sql, 'zelvian tides', opts);
            expect(result?.internal_id).toBe(id);
        });

        it('matches a close typo above the 0.5 confidence floor', async () => {
            const id = await insertTvSeries('Brindlewood Bay');
            const result = await findSeriesByName(sql, 'Brindlewood Baye', opts);
            expect(result?.internal_id).toBe(id);
        });

        it('does not return a series without local files (has_files gate)', async () => {
            await insertTvSeries('Ghostly Catalog Series', { hasFiles: false });
            const result = await findSeriesByName(sql, 'Ghostly Catalog Series', opts);
            expect(result).toBeNull();
        });

        it('returns null when nothing is similar enough', async () => {
            await insertTvSeries('Quoria Frontier');
            const result = await findSeriesByName(sql, 'Completely Unrelated Zzxq', opts);
            expect(result).toBeNull();
        });

        // ======================================================================
        // Access boundary — differential coverage
        //
        // findSeriesByName is LIMIT 1, so "restricted is a strict subset of
        // unrestricted" is asserted across a PAIR of series rather than within
        // one result list: both are findable unrestricted, only the allowed one
        // survives the restriction, and neither survives denyAll.
        //
        // The allowed control has NO media_file_items rows at all, which the
        // library predicate unconditionally admits — so a restriction that
        // wrongly nuked everything would fail step 3, and a boundary that
        // arrived but was never used would fail step 2.
        // ======================================================================
        describe('media access boundary', () => {
            const GROUP_NAME = 'Denied Series Search Group';
            let deniedGroup: string;

            beforeEach(async () => {
                deniedGroup = crypto.randomUUID();
                await sql`
                    INSERT INTO library_groups (id, name)
                    VALUES (${deniedGroup}::uuid, ${GROUP_NAME})
                `;
            });

            // Scoped by name: a blanket DELETE fails on the shared test DB,
            // where library_paths references library_groups ON DELETE RESTRICT.
            afterAll(async () => {
                await sql`DELETE FROM library_groups WHERE name = ${GROUP_NAME}`;
            });

            /**
             * Put a series in `groupId` so the library axis can exclude it.
             *
             * For a `tv` row the predicate walks SEASON -> EPISODE descendants
             * and never looks at files attached to the series row itself, so
             * this delegates to the shared helper that builds that chain — a
             * direct attach here would leave the restriction vacuous.
             */
            async function attachFileInGroup(mediaId: string, groupId: string): Promise<void> {
                await placeInLibraryGroup(sql, {
                    mediaItemId: mediaId,
                    mediaType: 'tv',
                    libraryGroupId: groupId,
                });
            }

            async function setAgeRating(mediaId: string, rating: number | null): Promise<void> {
                await sql`UPDATE media_items SET age_rating = ${rating} WHERE id = ${mediaId}::uuid`;
            }

            it('library axis: restricted result is a strict subset of unrestricted', async () => {
                const deniedId = await insertTvSeries('Vantablack Meridian');
                await attachFileInGroup(deniedId, deniedGroup);
                const allowedId = await insertTvSeries('Cindermoth Reach');

                // 1. Positive control — unrestricted finds BOTH.
                expect(
                    (await findSeriesByName(sql, 'Vantablack Meridian', unrestrictedAccess()))
                        ?.internal_id,
                ).toBe(deniedId);
                expect(
                    (await findSeriesByName(sql, 'Cindermoth Reach', unrestrictedAccess()))
                        ?.internal_id,
                ).toBe(allowedId);

                const restricted = restrictedAccess({
                    deniedGroupIds: [deniedGroup],
                    maxAgeRating: null,
                    allowUnrated: true,
                });

                // 2. The denied-group series drops out...
                expect(await findSeriesByName(sql, 'Vantablack Meridian', restricted)).toBeNull();
                // 3. ...but the allowed one survives, so this is a subset and not
                //    a predicate that empties the whole query.
                expect(
                    (await findSeriesByName(sql, 'Cindermoth Reach', restricted))?.internal_id,
                ).toBe(allowedId);
            });

            it('age axis: an over-limit series drops out while an unrated one survives', async () => {
                const adultId = await insertTvSeries('Nocturne Abattoir');
                await setAgeRating(adultId, 18);
                const unratedId = await insertTvSeries('Pelagic Lantern');
                await setAgeRating(unratedId, null);

                expect(
                    (await findSeriesByName(sql, 'Nocturne Abattoir', unrestrictedAccess()))
                        ?.internal_id,
                ).toBe(adultId);

                const teen = restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: true,
                });
                expect(await findSeriesByName(sql, 'Nocturne Abattoir', teen)).toBeNull();
                expect((await findSeriesByName(sql, 'Pelagic Lantern', teen))?.internal_id).toBe(
                    unratedId,
                );

                // allowUnrated flips independently — same ceiling, unrated now denied.
                const teenNoUnrated = restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: false,
                });
                expect(await findSeriesByName(sql, 'Pelagic Lantern', teenNoUnrated)).toBeNull();
            });

            it('denyAll returns nothing even for an otherwise unrestricted match', async () => {
                await insertTvSeries('Quoria Frontier');
                // Findable unrestricted...
                expect(
                    await findSeriesByName(sql, 'Quoria Frontier', unrestrictedAccess()),
                ).not.toBeNull();
                // ...and empty under deny-all, the state the legacy nullable pair
                // could not express at all.
                expect(await findSeriesByName(sql, 'Quoria Frontier', denyAllAccess())).toBeNull();
            });
        });
    });

    // ==========================================================================
    // File duration (reconciled against the keyframe scan)
    // ==========================================================================

    describe('getMediaFileDuration', () => {
        async function insertFile(
            durationSeconds: number | null,
            keyframes: number[] | null,
        ): Promise<string> {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds, keyframes)
                VALUES (
                    ${`/test/duration-${Math.random()}.mkv`},
                    ${durationSeconds},
                    ${keyframes === null ? null : sql.json(keyframes)}
                )
                RETURNING id
            `;
            return row.id;
        }

        it('returns the stored duration when the keyframes agree', async () => {
            const id = await insertFile(300, [0, 2, 4, 298]);
            expect(await getMediaFileDuration(sql, id)).toBeCloseTo(300, 3);
        });

        it('caps a bogus 2^32 ms container duration to the keyframe-derived end', async () => {
            // GPU transcode tests 2026-10-02: a dvd_subtitle's "infinite" end
            // time stored as the file duration; the video ends at ~300 s.
            const keyframes = Array.from({ length: 150 }, (_v, i) => i * 2); // 0..298
            const id = await insertFile(4295262.295, keyframes);
            expect(await getMediaFileDuration(sql, id)).toBeCloseTo(308, 3);
        });

        it('pads by the GOP so a sparse long-GOP scan does not cut a real file short', async () => {
            // Keyframes every 30 s: the video may run to ~90 s past 60, so a
            // 150 s container is plausible and stays.
            expect(await getMediaFileDuration(sql, await insertFile(150, [0, 30, 60]))).toBeCloseTo(
                150,
                3,
            );
        });

        it('ignores a scan with a single keyframe or a non-numeric tail', async () => {
            const single = await insertFile(3600, [0.5]);
            expect(await getMediaFileDuration(sql, single)).toBeCloseTo(3600, 3);
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, duration_seconds, keyframes)
                VALUES ('/test/duration-bad-tail.mkv', 3600, '[0, 2, null]'::jsonb)
                RETURNING id
            `;
            expect(await getMediaFileDuration(sql, row.id)).toBeCloseTo(3600, 3);
        });

        it('keeps the stored duration when the file has no keyframe scan', async () => {
            expect(
                await getMediaFileDuration(sql, await insertFile(4295262.295, null)),
            ).toBeCloseTo(4295262.295, -1);
            expect(await getMediaFileDuration(sql, await insertFile(120, []))).toBeCloseTo(120, 3);
        });

        it('returns null for an unknown file', async () => {
            expect(
                await getMediaFileDuration(sql, '00000000-0000-0000-0000-000000000000'),
            ).toBeNull();
        });
    });
});
