// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Catalog Operations Query Module
 *
 * Tests media item lookups, external ID resolution, provider metadata,
 * library availability, and image metadata queries.
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
} from '../../../../../tests/integration/fixtures/index.js';

// Import query functions to test
import {
    getMediaItemById,
    mediaItemExists,
    findMediaIdByExternalId,
    getExternalIdsForMedia,
    externalIdExists,
    batchResolveExternalIds,
    getProviderMetadata,
    hasProviderMetadata,
    isMediaAvailable,
    getLibraryAvailability,
    getImageMetadata,
    getInheritedImagePresence,
    getMediaItemForWatch,
} from './catalog-operations.queries.js';

describe('Catalog Operations Queries', () => {
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
    // Media Item Queries
    // ==========================================================================

    describe('getMediaItemById', () => {
        it('returns media item by UUID', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await getMediaItemById(sql, item.id);

            expect(result).not.toBeNull();
            expect(result?.id).toBe(item.id);
            expect(result?.title).toBe(item.title);
            expect(result?.media_type).toBe('movie');
        });

        it('returns null for non-existent UUID', async () => {
            const result = await getMediaItemById(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBeNull();
        });

        it('returns null for deleted media items', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                status: 'deleted',
            });
            await insertTestMediaItem(sql, item);

            const result = await getMediaItemById(sql, item.id);
            expect(result).toBeNull();
        });
    });

    describe('mediaItemExists', () => {
        it('returns true for existing active item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const exists = await mediaItemExists(sql, item.id);
            expect(exists).toBe(true);
        });

        it('returns false for non-existent item', async () => {
            const exists = await mediaItemExists(sql, '00000000-0000-0000-0000-000000000000');
            expect(exists).toBe(false);
        });
    });

    // ==========================================================================
    // External ID Queries
    // ==========================================================================

    describe('findMediaIdByExternalId', () => {
        it('finds media_id by TMDB ID and media_type', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const externalIds = createTestExternalIds(item.id, {
                tmdbId: 990001,
                mediaType: 'movie',
            });
            await insertTestExternalIds(sql, externalIds);

            const mediaId = await findMediaIdByExternalId(sql, {
                provider: 'tmdb',
                externalId: '990001',
                mediaType: 'movie',
            });

            expect(mediaId).toBe(item.id);
        });

        it('returns null when external ID not found', async () => {
            const mediaId = await findMediaIdByExternalId(sql, {
                provider: 'tmdb',
                externalId: '999999',
                mediaType: 'movie',
            });

            expect(mediaId).toBeNull();
        });
    });

    describe('getExternalIdsForMedia', () => {
        it('returns all external IDs for a media item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const externalIds = createTestExternalIds(item.id, {
                tmdbId: 990001,
                imdbId: 'tt9990001',
                jellyfinId: 'jf-test-001',
                mediaType: 'movie',
            });
            await insertTestExternalIds(sql, externalIds);

            const result = await getExternalIdsForMedia(sql, item.id);

            expect(result.length).toBe(3);
            expect(result.some((e) => e.provider === 'tmdb')).toBe(true);
            expect(result.some((e) => e.provider === 'imdb')).toBe(true);
            expect(result.some((e) => e.provider === 'jellyfin')).toBe(true);
        });

        it('returns empty array when no external IDs exist', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await getExternalIdsForMedia(sql, item.id);
            expect(result).toEqual([]);
        });
    });

    describe('externalIdExists', () => {
        it('returns true when external ID exists', async () => {
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);

            const externalIds = createTestExternalIds(item.id, {
                tmdbId: 880001,
                mediaType: 'tv',
            });
            await insertTestExternalIds(sql, externalIds);

            const exists = await externalIdExists(sql, {
                provider: 'tmdb',
                externalId: '880001',
                mediaType: 'tv',
            });

            expect(exists).toBe(true);
        });

        it('returns false when external ID does not exist', async () => {
            const exists = await externalIdExists(sql, {
                provider: 'tmdb',
                externalId: '999999',
                mediaType: 'movie',
            });

            expect(exists).toBe(false);
        });
    });

    describe('batchResolveExternalIds', () => {
        it('resolves multiple external IDs to media_ids', async () => {
            // Create two media items
            const movie = createTestMediaItem({ media_type: 'movie' });
            const tvShow = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, movie);
            await insertTestMediaItem(sql, tvShow);

            await insertTestExternalIds(
                sql,
                createTestExternalIds(movie.id, {
                    tmdbId: 990001,
                    mediaType: 'movie',
                }),
            );
            await insertTestExternalIds(
                sql,
                createTestExternalIds(tvShow.id, {
                    tmdbId: 880001,
                    mediaType: 'tv',
                }),
            );

            const result = await batchResolveExternalIds(sql, [
                { provider: 'tmdb', externalId: '990001', mediaType: 'movie' },
                { provider: 'tmdb', externalId: '880001', mediaType: 'tv' },
            ]);

            expect(result.size).toBe(2);
            expect(result.get('tmdb:990001:movie')).toBe(movie.id);
            expect(result.get('tmdb:880001:tv')).toBe(tvShow.id);
        });

        it('returns empty map for empty input', async () => {
            const result = await batchResolveExternalIds(sql, []);
            expect(result.size).toBe(0);
        });
    });

    // ==========================================================================
    // Provider Metadata Queries
    // ==========================================================================

    describe('getProviderMetadata', () => {
        it('returns metadata for a media item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // Insert provider metadata
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${item.id}::uuid,
                    'tmdb',
                    ${sql.json({ overview: 'Test overview', rating: 7.5 })},
                    NOW()
                )
            `;

            const result = await getProviderMetadata(sql, { mediaId: item.id });

            expect(result.length).toBe(1);
            expect(result[0].provider).toBe('tmdb');
            expect(result[0].metadata).toHaveProperty('overview');
        });

        it('filters by provider when specified', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES
                    (${item.id}::uuid, 'tmdb', '{"source": "tmdb"}'::jsonb, NOW()),
                    (${item.id}::uuid, 'aggregated', '{"source": "aggregated"}'::jsonb, NOW())
            `;

            const result = await getProviderMetadata(sql, {
                mediaId: item.id,
                provider: 'tmdb',
            });

            expect(result.length).toBe(1);
            expect(result[0].provider).toBe('tmdb');
        });
    });

    describe('hasProviderMetadata', () => {
        it('returns true when metadata exists', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${item.id}::uuid, 'tmdb', '{}'::jsonb, NOW())
            `;

            const has = await hasProviderMetadata(sql, { mediaId: item.id });
            expect(has).toBe(true);
        });

        it('returns false when no metadata exists', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const has = await hasProviderMetadata(sql, { mediaId: item.id });
            expect(has).toBe(false);
        });
    });

    // ==========================================================================
    // Library Availability Queries
    // ==========================================================================

    describe('isMediaAvailable', () => {
        it('returns true when media is available in a library', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO library_availability (media_id, library, library_item_id, available)
                VALUES (${item.id}::uuid, 'jellyfin', 'jf-123', true)
            `;

            const available = await isMediaAvailable(sql, item.id);
            expect(available).toBe(true);
        });

        it('returns false when media is not available', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const available = await isMediaAvailable(sql, item.id);
            expect(available).toBe(false);
        });

        it('returns false when availability is set to false', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO library_availability (media_id, library, library_item_id, available)
                VALUES (${item.id}::uuid, 'jellyfin', 'jf-123', false)
            `;

            const available = await isMediaAvailable(sql, item.id);
            expect(available).toBe(false);
        });
    });

    describe('getLibraryAvailability', () => {
        it('returns availability status for all libraries', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO library_availability (media_id, library, library_item_id, available, quality)
                VALUES (${item.id}::uuid, 'jellyfin', 'jf-123', true, '4K')
            `;

            const result = await getLibraryAvailability(sql, item.id);

            expect(result.length).toBe(1);
            expect(result[0].library).toBe('jellyfin');
            expect(result[0].libraryItemId).toBe('jf-123');
            expect(result[0].available).toBe(true);
            expect(result[0].quality).toBe('4K');
        });
    });

    // ==========================================================================
    // Image Metadata Queries
    // ==========================================================================

    describe('getImageMetadata', () => {
        it('returns image paths from aggregated provider metadata', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // Insert aggregated metadata with poster/backdrop paths
            const metadata = {
                poster_path: '/abc123.jpg',
                backdrop_path: '/xyz789.jpg',
            };
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${item.id}::uuid,
                    'aggregated',
                    ${sql.json(metadata)},
                    NOW()
                )
            `;

            const result = await getImageMetadata(sql, item.id);

            expect(result).not.toBeNull();
            expect(result?.poster_path).toBe('/abc123.jpg');
            expect(result?.backdrop_path).toBe('/xyz789.jpg');
            expect(result?.media_type).toBe('movie');
        });

        it('falls back to tmdb provider when aggregated not available', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // Insert TMDB metadata only
            const tmdbMetadata = {
                poster_path: '/tmdb-poster.jpg',
                backdrop_path: '/tmdb-backdrop.jpg',
            };
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (
                    ${item.id}::uuid,
                    'tmdb',
                    ${sql.json(tmdbMetadata)},
                    NOW()
                )
            `;

            const result = await getImageMetadata(sql, item.id);

            expect(result).not.toBeNull();
            expect(result?.poster_path).toBe('/tmdb-poster.jpg');
            expect(result?.backdrop_path).toBe('/tmdb-backdrop.jpg');
        });

        it('includes TMDB external ID for fallback', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const externalIds = createTestExternalIds(item.id, {
                tmdbId: 990001,
                mediaType: 'movie',
            });
            await insertTestExternalIds(sql, externalIds);

            const result = await getImageMetadata(sql, item.id);

            expect(result).not.toBeNull();
            expect(result?.primary_ext_id).toBe('990001');
        });

        it('includes Jellyfin external ID for fallback', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const externalIds = createTestExternalIds(item.id, {
                jellyfinId: 'jf-test-001',
                mediaType: 'movie',
            });
            await insertTestExternalIds(sql, externalIds);

            const result = await getImageMetadata(sql, item.id);

            expect(result).not.toBeNull();
            // Jellyfin IDs are stored dashless after normalization in insertTestExternalIds
            expect(result?.jellyfin_id).toBe('jftest001');
        });

        it('returns null for non-existent media', async () => {
            const result = await getImageMetadata(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBeNull();
        });

        it('returns null paths when no provider metadata exists', async () => {
            const item = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item);

            const result = await getImageMetadata(sql, item.id);

            expect(result).not.toBeNull();
            expect(result?.poster_path).toBeNull();
            expect(result?.backdrop_path).toBeNull();
            expect(result?.media_type).toBe('tv');
        });

        it('prefers aggregated over tmdb when both exist', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // Insert both aggregated and tmdb metadata
            const aggregatedMeta = { poster_path: '/aggregated.jpg' };
            const tmdbMeta = { poster_path: '/tmdb.jpg' };
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES
                    (${item.id}::uuid, 'aggregated', ${sql.json(aggregatedMeta)}, NOW()),
                    (${item.id}::uuid, 'tmdb', ${sql.json(tmdbMeta)}, NOW())
            `;

            const result = await getImageMetadata(sql, item.id);

            expect(result?.poster_path).toBe('/aggregated.jpg');
        });

        it('inherits episode still/thumb from the series via provider metadata', async () => {
            // series → season → episode chain; only the SERIES carries a
            // still-like image (custom_thumb_url). The episode has none.
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({ media_type: 'season' });
            await insertTestMediaItem(sql, season);
            const episode = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, episode);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season.id}::uuid`;
            await sql`UPDATE media_items SET parent_id = ${season.id}::uuid WHERE id = ${episode.id}::uuid`;
            await sql`UPDATE media_items SET custom_thumb_url = '/series-thumb.jpg' WHERE id = ${series.id}::uuid`;

            const result = await getImageMetadata(sql, episode.id, 'thumb');

            expect(result).not.toBeNull();
            // Inheritance must pick the SERIES ancestor (the one with the thumb),
            // not the depth-0 episode that has none.
            expect(result?.metadata_source_id).toBe(series.id);
            expect(result?.custom_thumb_url).toBe('/series-thumb.jpg');
            // origin media_type stays the episode's own type.
            expect(result?.media_type).toBe('episode');
        });

        it('inherits episode still from the season provider still_path before the series', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({ media_type: 'season' });
            await insertTestMediaItem(sql, season);
            const episode = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, episode);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season.id}::uuid`;
            await sql`UPDATE media_items SET parent_id = ${season.id}::uuid WHERE id = ${episode.id}::uuid`;
            // Both season and series carry a still_path; nearest ancestor (season) wins.
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES
                    (${season.id}::uuid, 'aggregated', ${sql.json({ still_path: '/season-still.jpg' })}, NOW()),
                    (${series.id}::uuid, 'aggregated', ${sql.json({ still_path: '/series-still.jpg' })}, NOW())
            `;

            const result = await getImageMetadata(sql, episode.id, 'still');

            expect(result).not.toBeNull();
            expect(result?.metadata_source_id).toBe(season.id);
            expect(result?.still_path).toBe('/season-still.jpg');
        });

        it('prefers the episode own still over an inherited one', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({ media_type: 'season' });
            await insertTestMediaItem(sql, season);
            const episode = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, episode);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season.id}::uuid`;
            await sql`UPDATE media_items SET parent_id = ${season.id}::uuid WHERE id = ${episode.id}::uuid`;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES
                    (${episode.id}::uuid, 'aggregated', ${sql.json({ still_path: '/episode-still.jpg' })}, NOW()),
                    (${series.id}::uuid, 'aggregated', ${sql.json({ still_path: '/series-still.jpg' })}, NOW())
            `;

            const result = await getImageMetadata(sql, episode.id, 'still');

            expect(result?.metadata_source_id).toBe(episode.id);
            expect(result?.still_path).toBe('/episode-still.jpg');
        });

        // -----------------------------------------------------------------------
        // Ranking: still_path vs custom_thumb_url at different ancestor depths
        //
        // The ranking expression is:
        //   (requestedPathPresent) DESC, depth ASC
        // meaning: presence wins first, then nearest ancestor. This prevents the
        // depth-0 episode row (no still) beating a season/series that actually
        // carries one, regardless of whether the source is a provider still_path
        // or a custom_thumb_url column.
        // -----------------------------------------------------------------------

        it('still/thumb: season custom_thumb_url beats series still_path (nearer ancestor with image wins)', async () => {
            // episode (no still) → season (custom_thumb_url) → series (still_path)
            // Season is nearer than series, both have presence → season wins.
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({ media_type: 'season' });
            await insertTestMediaItem(sql, season);
            const episode = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, episode);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season.id}::uuid`;
            await sql`UPDATE media_items SET parent_id = ${season.id}::uuid WHERE id = ${episode.id}::uuid`;

            // Season carries the thumb via custom_thumb_url column.
            await sql`UPDATE media_items SET custom_thumb_url = '/season-custom-thumb.jpg' WHERE id = ${season.id}::uuid`;
            // Series carries a still via provider metadata.
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${series.id}::uuid, 'aggregated', ${sql.json({ still_path: '/series-provider-still.jpg' })}, NOW())
            `;

            const result = await getImageMetadata(sql, episode.id, 'thumb');

            expect(result).not.toBeNull();
            // Season is depth 1, series is depth 2. Both have presence — season wins.
            expect(result?.metadata_source_id).toBe(season.id);
            expect(result?.custom_thumb_url).toBe('/season-custom-thumb.jpg');
        });

        it('still/thumb: season still_path beats series custom_thumb_url (nearer ancestor with image wins)', async () => {
            // episode (no still) → season (still_path via provider) → series (custom_thumb_url)
            // Season depth 1 vs series depth 2 — season's still_path wins.
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({ media_type: 'season' });
            await insertTestMediaItem(sql, season);
            const episode = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, episode);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season.id}::uuid`;
            await sql`UPDATE media_items SET parent_id = ${season.id}::uuid WHERE id = ${episode.id}::uuid`;

            // Season carries still_path via provider metadata.
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${season.id}::uuid, 'aggregated', ${sql.json({ still_path: '/season-provider-still.jpg' })}, NOW())
            `;
            // Series carries thumb via custom_thumb_url column.
            await sql`UPDATE media_items SET custom_thumb_url = '/series-custom-thumb.jpg' WHERE id = ${series.id}::uuid`;

            const result = await getImageMetadata(sql, episode.id, 'still');

            expect(result).not.toBeNull();
            // Season is the nearer ancestor with presence — it must win.
            expect(result?.metadata_source_id).toBe(season.id);
            expect(result?.still_path).toBe('/season-provider-still.jpg');
        });

        it('still/thumb: depth-0 episode with no still does NOT beat its season that has one', async () => {
            // Regression guard for the pre-fix bug where depth-0 wins unconditionally:
            // episode (no thumb/still at all) → season (custom_thumb_url) → series (nothing)
            // Without the presence term in ORDER BY, the episode row (depth 0) would
            // win over the season that actually has the image.
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({ media_type: 'season' });
            await insertTestMediaItem(sql, season);
            const episode = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, episode);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season.id}::uuid`;
            await sql`UPDATE media_items SET parent_id = ${season.id}::uuid WHERE id = ${episode.id}::uuid`;

            // Only the season has a thumb — episode and series have neither.
            await sql`UPDATE media_items SET custom_thumb_url = '/season-thumb-only.jpg' WHERE id = ${season.id}::uuid`;

            const result = await getImageMetadata(sql, episode.id, 'thumb');

            expect(result).not.toBeNull();
            // The season row must win — not the episode's empty depth-0 row.
            expect(result?.metadata_source_id).toBe(season.id);
            expect(result?.custom_thumb_url).toBe('/season-thumb-only.jpg');
        });

        // -----------------------------------------------------------------------
        // Poster role
        //
        // Episodes never carry a poster of their own — TMDB models episode art as
        // a still, not a poster — so the poster slot for an episode is ALWAYS an
        // inherited one. The cases above cover still/thumb; these cover poster,
        // which is the default arm of `requestedPathPresent` and was previously
        // untested despite being the role clients request most.
        //
        // Motivation: an episode reported a blank poster in the iOS/tvOS clients
        // while its backdrop (and its series' poster) resolved fine. These cases
        // pin down which part of the ranking is responsible.
        // -----------------------------------------------------------------------

        it('inherits episode poster from the series provider poster_path', async () => {
            // The baseline: episode carries no poster anywhere, series does.
            // episode → season → series, only the series has poster_path.
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({ media_type: 'season' });
            await insertTestMediaItem(sql, season);
            const episode = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, episode);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season.id}::uuid`;
            await sql`UPDATE media_items SET parent_id = ${season.id}::uuid WHERE id = ${episode.id}::uuid`;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${series.id}::uuid, 'aggregated', ${sql.json({ poster_path: '/series-poster.jpg' })}, NOW())
            `;

            const result = await getImageMetadata(sql, episode.id, 'poster');

            expect(result).not.toBeNull();
            // The series (depth 2) must win over the empty depth-0 episode row.
            expect(result?.metadata_source_id).toBe(series.id);
            expect(result?.poster_path).toBe('/series-poster.jpg');
            // origin media_type stays the episode's own type — the caller still
            // needs to know it asked about an episode.
            expect(result?.media_type).toBe('episode');
        });

        it('poster: season poster_path beats series poster_path (nearer ancestor with image wins)', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({ media_type: 'season' });
            await insertTestMediaItem(sql, season);
            const episode = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, episode);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season.id}::uuid`;
            await sql`UPDATE media_items SET parent_id = ${season.id}::uuid WHERE id = ${episode.id}::uuid`;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES
                    (${season.id}::uuid, 'aggregated', ${sql.json({ poster_path: '/season-poster.jpg' })}, NOW()),
                    (${series.id}::uuid, 'aggregated', ${sql.json({ poster_path: '/series-poster.jpg' })}, NOW())
            `;

            const result = await getImageMetadata(sql, episode.id, 'poster');

            expect(result?.metadata_source_id).toBe(season.id);
            expect(result?.poster_path).toBe('/season-poster.jpg');
        });

        it('prefers the episode own poster_path over an inherited one', async () => {
            // Control for the custom_poster_url case below: when the episode has a
            // REAL poster_path, depth-0 winning is correct, not a bug.
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const episode = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, episode);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${episode.id}::uuid`;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES
                    (${episode.id}::uuid, 'aggregated', ${sql.json({ poster_path: '/episode-poster.jpg' })}, NOW()),
                    (${series.id}::uuid, 'aggregated', ${sql.json({ poster_path: '/series-poster.jpg' })}, NOW())
            `;

            const result = await getImageMetadata(sql, episode.id, 'poster');

            expect(result?.metadata_source_id).toBe(episode.id);
            expect(result?.poster_path).toBe('/episode-poster.jpg');
        });

        it('poster: resolves via artwork->>"poster" when poster_path is absent', async () => {
            // getImageMetadata COALESCEs poster_path with artwork->>'poster', so
            // non-TMDB providers that use the artwork shape must inherit too.
            // NB: getInheritedImagePresence checks ONLY poster_path, so the
            // /images listing under-reports this case — the two CTEs disagree.
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const episode = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, episode);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${episode.id}::uuid`;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${series.id}::uuid, 'aggregated', ${sql.json({ artwork: { poster: '/series-artwork-poster.jpg' } })}, NOW())
            `;

            const result = await getImageMetadata(sql, episode.id, 'poster');

            expect(result).not.toBeNull();
            expect(result?.metadata_source_id).toBe(series.id);
            expect(result?.poster_path).toBe('/series-artwork-poster.jpg');
        });

        // CHARACTERIZATION TEST — documents current behavior, which is the leading
        // suspect for the reported blank episode poster.
        //
        // `requestedPathPresent` for poster is
        //   (poster_path IS NOT NULL OR custom_poster_url IS NOT NULL)
        // so a custom_poster_url on the EPISODE makes presence true at depth 0 and
        // the episode's own row wins — returning a NULL poster_path and the
        // episode's own external ids. Inheritance is not missing here, it is
        // SUPPRESSED. Downstream, local misses, TMDB has no episode poster, and the
        // `custom` provider (last in DEFAULT_IMAGE_PROVIDER_PRIORITY) fetches the
        // custom URL — so a stale or dead custom_poster_url yields no image at all
        // even though the series has perfectly good art one level up.
        //
        // If this is confirmed as the root cause and the ranking is changed, this
        // test must be updated to assert the new behavior.
        it('poster: a custom_poster_url on the episode suppresses inheritance from the series', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({ media_type: 'season' });
            await insertTestMediaItem(sql, season);
            const episode = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, episode);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season.id}::uuid`;
            await sql`UPDATE media_items SET parent_id = ${season.id}::uuid WHERE id = ${episode.id}::uuid`;

            // The series has real provider art.
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${series.id}::uuid, 'aggregated', ${sql.json({ poster_path: '/series-poster.jpg' })}, NOW())
            `;
            // The episode has only a custom poster URL — enough to win the rank.
            await sql`UPDATE media_items SET custom_poster_url = '/episode-custom.jpg' WHERE id = ${episode.id}::uuid`;

            const result = await getImageMetadata(sql, episode.id, 'poster');

            expect(result).not.toBeNull();
            // Depth 0 wins on presence — the series' poster is never reached.
            expect(result?.metadata_source_id).toBe(episode.id);
            expect(result?.custom_poster_url).toBe('/episode-custom.jpg');
            expect(result?.poster_path).toBeNull();
        });
    });

    // ==========================================================================
    // getInheritedImagePresence
    // ==========================================================================

    describe('getInheritedImagePresence', () => {
        it('returns null for a non-existent item', async () => {
            const result = await getInheritedImagePresence(
                sql,
                '00000000-0000-0000-0000-000000000000',
            );
            expect(result).toBeNull();
        });

        it('reports all-false for an item with no artwork at any level', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await getInheritedImagePresence(sql, item.id);
            expect(result).toEqual({
                poster: false,
                backdrop: false,
                logo: false,
                thumb: false,
            });
        });

        it('reports own provider-metadata presence', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${item.id}::uuid, 'aggregated', ${sql.json({ poster_path: '/p.jpg', backdrop_path: '/b.jpg' })}, NOW())
            `;

            const result = await getInheritedImagePresence(sql, item.id);
            expect(result).toEqual({
                poster: true,
                backdrop: true,
                logo: false,
                thumb: false,
            });
        });

        it('reports inherited presence walking the parent chain', async () => {
            // Episode inherits a poster from its series via provider metadata and
            // a thumb from its season via custom_thumb_url.
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const season = createTestMediaItem({ media_type: 'season' });
            await insertTestMediaItem(sql, season);
            const episode = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, episode);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season.id}::uuid`;
            await sql`UPDATE media_items SET parent_id = ${season.id}::uuid WHERE id = ${episode.id}::uuid`;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${series.id}::uuid, 'aggregated', ${sql.json({ poster_path: '/series-poster.jpg' })}, NOW())
            `;
            await sql`UPDATE media_items SET custom_thumb_url = '/season-thumb.jpg' WHERE id = ${season.id}::uuid`;

            const result = await getInheritedImagePresence(sql, episode.id);
            expect(result).toEqual({
                poster: true,
                backdrop: false,
                logo: false,
                thumb: true,
            });
        });
    });

    // ==========================================================================
    // getMediaItemForWatch — episode ordering overlay
    // ==========================================================================

    describe('getMediaItemForWatch episode ordering overlay', () => {
        it('returns ordering overlay season/episode numbers when an active non-standard ordering exists', async () => {
            // Build series → season → episode hierarchy
            const seriesId = crypto.randomUUID();
            const seasonId = crypto.randomUUID();
            const episodeId = crypto.randomUUID();

            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${seriesId}::uuid, 'Test Series', 'tv', 'active')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, season_number)
                VALUES (${seasonId}::uuid, 'Season 1', 'season', 'active', ${seriesId}::uuid, 1)
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, season_number, episode_number)
                VALUES (${episodeId}::uuid, 'Episode 1', 'episode', 'active', ${seasonId}::uuid, 1, 1)
            `;

            // Insert a non-standard ordering for the series
            const groupId = crypto.randomUUID();
            await sql`
                INSERT INTO series_episode_ordering (media_id, ordering_type, ordering_source, ordering_provider, ordering_group_id)
                VALUES (${seriesId}::uuid, 'absolute', 'manual', 'test', ${groupId})
            `;

            // Insert an episode_orderings row linking the episode to remapped numbers
            await sql`
                INSERT INTO episode_orderings (
                    series_media_id, provider, provider_episode_id,
                    ordering_type, ordering_group_id,
                    original_season_number, original_episode_number,
                    order_season_number, order_episode_number,
                    absolute_number, episode_media_id
                ) VALUES (
                    ${seriesId}::uuid, 'test', 'test-ep-1',
                    'absolute', ${groupId},
                    1, 1,
                    2, 5,
                    5, ${episodeId}::uuid
                )
            `;

            const result = await getMediaItemForWatch(sql, episodeId);

            expect(result).not.toBeNull();
            expect(result?.season_number).toBe(2);
            expect(result?.episode_number).toBe(5);
        });

        it('returns raw season/episode numbers when no active ordering exists', async () => {
            // Build series → season → episode hierarchy (no ordering rows)
            const seriesId = crypto.randomUUID();
            const seasonId = crypto.randomUUID();
            const episodeId = crypto.randomUUID();

            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${seriesId}::uuid, 'Plain Series', 'tv', 'active')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, season_number)
                VALUES (${seasonId}::uuid, 'Season 1', 'season', 'active', ${seriesId}::uuid, 1)
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, season_number, episode_number)
                VALUES (${episodeId}::uuid, 'Episode 3', 'episode', 'active', ${seasonId}::uuid, 1, 3)
            `;

            const result = await getMediaItemForWatch(sql, episodeId);

            expect(result).not.toBeNull();
            expect(result?.season_number).toBe(1);
            expect(result?.episode_number).toBe(3);
        });

        it('returns null for a non-UUID id instead of letting Postgres throw', async () => {
            const result = await getMediaItemForWatch(sql, 'not-a-uuid');

            expect(result).toBeNull();
        });
    });
});
