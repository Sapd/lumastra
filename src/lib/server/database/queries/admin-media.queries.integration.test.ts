// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration Tests for Admin Media Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { registerImageCandidate } from './image-candidates.queries.js';
import { effectivePosterSql } from './image-descriptor.queries.js';
import { resolveImageSet } from '$lib/server/services/image-descriptor/resolver.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createTestExternalIds,
    insertTestExternalIds,
} from '../../../../../tests/integration/fixtures/index.js';

// The preview endpoint's own response schema and media-type remap, imported so
// the malformed-health_issues cases below assert at the real endpoint seam
// rather than at the query's raw return — half that hazard is a Zod rejection,
// which the query alone cannot show.
import { AdminPreviewResponseSchema } from '../../api/defs/admin/media/[id]/preview.js';
import { toPublicMediaType } from '../../../shared/media-type-domain.js';
import { issuesForAdminRow } from '../../services/admin-media-issues.js';
import { createCatalogService } from '../../services/catalog.service.js';

import {
    listAdminMediaItems,
    countAdminMediaItems,
    getMediaItemById,
    getMediaItemChildCounts,
    resolveAncestorChain,
    getMediaBrowserStats,
    getMediaPreview,
    findDuplicateMediaItems,
    countFilelessDuplicatePairs,
    findFilelessDuplicatePairs,
    findFilelessDuplicatePairsWithTotal,
    countAdminMediaViews,
} from './admin-media.queries.js';
import {
    VIEW_ISSUE,
    viewQueryOptions,
    viewsForScope,
    type MediaBrowserView,
} from '../../../shared/media-issues.js';

describe('Admin Media Queries', () => {
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

    describe('series Jellyfin linkage', () => {
        it('clears the series issue only when all local episodes are linked, across seasons', async () => {
            const series = createTestMediaItem({ title: 'File-paired series', media_type: 'tv' });
            const other = createTestMediaItem({ title: 'Other series', media_type: 'tv' });
            const season1 = createTestMediaItem({ media_type: 'season' });
            const season2 = createTestMediaItem({ media_type: 'season' });
            const otherSeason = createTestMediaItem({ media_type: 'season' });
            const ep1 = createTestMediaItem({ media_type: 'episode' });
            const ep2 = createTestMediaItem({ media_type: 'episode' });
            const fileless = createTestMediaItem({ media_type: 'episode' });
            const inactive = createTestMediaItem({ media_type: 'episode' });
            const unrelated = createTestMediaItem({ media_type: 'episode' });
            for (const item of [
                series,
                other,
                season1,
                season2,
                otherSeason,
                ep1,
                ep2,
                fileless,
                inactive,
                unrelated,
            ])
                await insertTestMediaItem(sql, item);
            await sql`UPDATE media_items SET has_files = true`;
            await sql`UPDATE media_items SET parent_id = ${series.id} WHERE id IN (${season1.id}, ${season2.id})`;
            await sql`UPDATE media_items SET parent_id = ${other.id} WHERE id = ${otherSeason.id}`;
            await sql`UPDATE media_items SET parent_id = ${season1.id} WHERE id IN (${ep1.id}, ${fileless.id}, ${inactive.id})`;
            await sql`UPDATE media_items SET parent_id = ${season2.id} WHERE id = ${ep2.id}`;
            await sql`UPDATE media_items SET parent_id = ${otherSeason.id} WHERE id = ${unrelated.id}`;
            await sql`UPDATE media_items SET has_files = false WHERE id = ${fileless.id}`;
            await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${inactive.id}`;
            const catalog = createCatalogService(sql, { skipLifecycleHooks: true });
            const options = { types: ['tv'], itemIds: [series.id] };
            async function assertIssue(expected: boolean): Promise<void> {
                for (const filter of [
                    { issue: 'not_in_jellyfin' as const },
                    { attentionKinds: ['not_in_jellyfin' as const] },
                    { missingJf: true },
                ]) {
                    const rows = await listAdminMediaItems(sql, {
                        ...options,
                        ...filter,
                        limit: 50,
                        offset: 0,
                    });
                    expect(rows.map((r) => r.id)).toEqual(expected ? [series.id] : []);
                    expect(await countAdminMediaItems(sql, { ...options, ...filter })).toBe(
                        Number(expected),
                    );
                }
                const counts = await countAdminMediaViews(sql, options, {
                    views: [{ id: 'jellyfin', issue: 'not_in_jellyfin' }, { id: 'attention' }],
                    attentionKinds: ['not_in_jellyfin'],
                    recentSince: new Date().toISOString(),
                });
                // Saved-view counts cover the whole scope, including the other series.
                expect(counts).toEqual({
                    jellyfin: 1 + Number(expected),
                    attention: 1 + Number(expected),
                });
                const [row] = await listAdminMediaItems(sql, { ...options, limit: 50, offset: 0 });
                expect(row.jellyfin_id).toBeNull();
                expect(issuesForAdminRow(row, true).some((i) => i.kind === 'not_in_jellyfin')).toBe(
                    expected,
                );
            }
            await assertIssue(true);
            for (const [index, episode] of [ep1, ep2].entries()) {
                await catalog.upsertExternalId(episode.id, {
                    provider: 'jellyfin',
                    id: `paired-episode-${index}`,
                    mediaType: 'episode',
                    source: 'watch-sync-file',
                });
                await assertIssue(index === 0);
            }
            // A sibling series' unpaired episode must not affect this series.
            expect(
                await countAdminMediaItems(sql, {
                    types: ['tv'],
                    itemIds: [other.id],
                    issue: 'not_in_jellyfin',
                }),
            ).toBe(1);
            await catalog.deleteExternalId(ep2.id, 'jellyfin', 'episode');
            await assertIssue(true);
            // No local episodes must not become a vacuous "all linked".
            await sql`UPDATE media_items SET has_files = false WHERE id IN (${ep1.id}, ${ep2.id})`;
            await assertIssue(true);
            // Existing explicit series links retain their meaning.
            await catalog.upsertExternalId(series.id, {
                provider: 'jellyfin',
                id: 'explicit-series',
                mediaType: 'tv',
            });
            expect(await countAdminMediaItems(sql, { ...options, issue: 'not_in_jellyfin' })).toBe(
                0,
            );
            const [linked] = await listAdminMediaItems(sql, { ...options, limit: 50, offset: 0 });
            expect(issuesForAdminRow(linked, true).map((issue) => issue.kind)).not.toContain(
                'not_in_jellyfin',
            );
        });
    });

    describe('effective artwork', () => {
        it('agrees with image selection and keeps counts, filters and visible row badges in sync', async () => {
            const movie = createTestMediaItem({ title: 'Selected poster', media_type: 'movie' });
            const absent = createTestMediaItem({ title: 'Placeholder only', media_type: 'movie' });
            const artist = createTestMediaItem({ title: 'Artist photo', media_type: 'artist' });
            const album = createTestMediaItem({ title: 'Inherited cover', media_type: 'album' });
            const series = createTestMediaItem({ title: 'Series poster', media_type: 'tv' });
            const season = createTestMediaItem({
                title: 'Inherited season poster',
                media_type: 'season',
            });
            for (const item of [movie, absent, artist, album, series, season])
                await insertTestMediaItem(sql, item);
            await sql`UPDATE media_items SET has_files = true, poster_blurhash = NULL`;
            await sql`UPDATE media_items SET poster_blurhash = 'placeholder' WHERE id = ${absent.id}`;
            await sql`UPDATE media_items SET parent_id = ${artist.id} WHERE id = ${album.id}`;
            await sql`UPDATE media_items SET parent_id = ${series.id} WHERE id = ${season.id}`;
            for (const item of [movie, artist, series]) {
                await registerImageCandidate(sql, {
                    mediaItemId: item.id,
                    role: 'poster',
                    provider: 'tmdb',
                    providerRef: '/poster.jpg',
                });
            }
            for (const item of [movie, absent, artist, album, series, season]) {
                const [row] = await sql<
                    { present: boolean }[]
                >`SELECT ${effectivePosterSql(sql, sql`${item.id}::uuid`)} AS present`;
                const images = await resolveImageSet(sql, 'internal', item.id);
                expect(row.present, item.title).toBe(Boolean(images.poster ?? images.primary));
            }
            const options = { types: ['movie', 'tv', 'artist', 'album'], showUnavailable: true };
            const all = await listAdminMediaItems(sql, { ...options, limit: 50, offset: 0 });
            expect(all.filter((r) => !r.has_poster).map((r) => r.id)).toEqual([absent.id]);
            for (const filter of [{ issue: 'no_poster' as const }, { missingPoster: true }]) {
                const rows = await listAdminMediaItems(sql, {
                    ...options,
                    ...filter,
                    limit: 50,
                    offset: 0,
                });
                expect(rows.map((r) => r.id)).toEqual([absent.id]);
                expect(await countAdminMediaItems(sql, { ...options, ...filter })).toBe(1);
            }
            const counts = await countAdminMediaViews(sql, options, {
                views: [{ id: 'artwork', issue: 'no_poster' }, { id: 'attention' }],
                attentionKinds: ['no_poster'],
                recentSince: new Date().toISOString(),
            });
            expect(counts.artwork).toBe(1);
            expect(counts.attention).toBe(1);
            // Various Artists is not a usable inherited cover for an album.
            await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${artist.id}`;
            const variedCounts = await countAdminMediaViews(sql, options, {
                views: [{ id: 'artwork', issue: 'no_poster' }, { id: 'attention' }],
                attentionKinds: ['no_poster'],
                recentSince: new Date().toISOString(),
            });
            expect(variedCounts).toEqual({ artwork: 2, attention: 2 });
            const [inherited] = await sql<{ present: boolean }[]>`
                SELECT ${effectivePosterSql(sql, sql`${album.id}::uuid`)} AS present`;
            expect(inherited.present).toBe(false);
            // An actual album cover takes precedence over the artist fallback.
            await registerImageCandidate(sql, {
                mediaItemId: album.id,
                role: 'poster',
                provider: 'tmdb',
                providerRef: '/album.jpg',
            });
            expect((await resolveImageSet(sql, 'internal', album.id)).primary?.source).toBe('self');
        });
    });

    describe('explicit search scope', () => {
        it('excludes synopsis-only matches from title search and maintains list/count parity', async () => {
            const titleHit = createTestMediaItem({ title: 'Lantern Fleet', media_type: 'movie' });
            const synopsisHit = createTestMediaItem({
                title: 'Quiet Harbor',
                media_type: 'movie',
            });
            await insertTestMediaItem(sql, titleHit);
            await insertTestMediaItem(sql, synopsisHit);
            await sql`UPDATE media_items SET overview = ${'The lantern fleet returns.'} WHERE id = ${synopsisHit.id}`;
            await sql`UPDATE media_items SET has_files = true WHERE id IN (${titleHit.id}, ${synopsisHit.id})`;
            for (const scope of ['title', 'metadata'] as const) {
                const options = { types: ['movie'], query: 'Lantern', searchScope: scope };
                const rows = await listAdminMediaItems(sql, { ...options, limit: 50, offset: 0 });
                expect(await countAdminMediaItems(sql, options)).toBe(rows.length);
                expect(rows.map((row) => row.id).sort()).toEqual(
                    (scope === 'title' ? [titleHit.id] : [titleHit.id, synopsisHit.id]).sort(),
                );
            }
        });
    });

    describe('getMediaItemById', () => {
        it('returns media item by UUID', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await getMediaItemById(sql, item.id);
            expect(result).toBeDefined();
            expect(result?.id).toBe(item.id);
            expect(result?.title).toBe(item.title);
        });

        it('returns undefined for non-existent UUID', async () => {
            const result = await getMediaItemById(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBeUndefined();
        });
    });

    describe('getMediaItemChildCounts', () => {
        it('returns zero counts for childless item', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);

            const result = await getMediaItemChildCounts(sql, series.id);
            expect(result.seasonCount).toBe(0);
            expect(result.episodeCount).toBe(0);
        });

        it('counts seasons and episodes', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            const season = createTestMediaItem({
                media_type: 'season',
                parent_id: series.id,
            });
            const episode = createTestMediaItem({
                media_type: 'episode',
                parent_id: season.id,
            });
            await insertTestMediaItem(sql, series);
            await insertTestMediaItem(sql, season);
            await insertTestMediaItem(sql, episode);

            // Fixture insertTestMediaItem does not persist parent_id or
            // episode/season numbers — update them manually.
            await sql`
                UPDATE media_items
                SET parent_id = ${series.id}::uuid,
                    season_number = 1
                WHERE id = ${season.id}::uuid
            `;
            await sql`
                UPDATE media_items
                SET parent_id = ${season.id}::uuid,
                    season_number = 1,
                    episode_number = 1
                WHERE id = ${episode.id}::uuid
            `;

            const result = await getMediaItemChildCounts(sql, series.id);
            expect(result.seasonCount).toBe(1);
            expect(result.episodeCount).toBe(1);
        });
    });

    describe('resolveAncestorChain', () => {
        it('returns empty array for top-level item', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);

            const result = await resolveAncestorChain(sql, movie.id);
            expect(result).toHaveLength(0);
        });

        it('returns parent chain for nested item', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            const season = createTestMediaItem({
                media_type: 'season',
                parent_id: series.id,
            });
            const episode = createTestMediaItem({
                media_type: 'episode',
                parent_id: season.id,
            });
            await insertTestMediaItem(sql, series);
            await insertTestMediaItem(sql, season);
            await insertTestMediaItem(sql, episode);

            // Fixture insertTestMediaItem does not persist parent_id —
            // update it manually so the ancestor chain can be resolved.
            await sql`
                UPDATE media_items
                SET parent_id = ${series.id}::uuid
                WHERE id = ${season.id}::uuid
            `;
            await sql`
                UPDATE media_items
                SET parent_id = ${season.id}::uuid
                WHERE id = ${episode.id}::uuid
            `;

            const result = await resolveAncestorChain(sql, episode.id);
            expect(result.length).toBe(2);
            expect(result[0].media_type).toBe('season');
            expect(result[1].media_type).toBe('tv');
        });
    });

    describe('getMediaBrowserStats', () => {
        it('returns zero stats for empty database', async () => {
            const result = await getMediaBrowserStats(sql);
            expect(result.total).toBe(0);
            expect(result.movies).toBe(0);
            expect(result.series).toBe(0);
        });

        it('counts media types correctly', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, movie);
            await insertTestMediaItem(sql, series);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${series.id}::uuid`;

            const result = await getMediaBrowserStats(sql);
            expect(result.total).toBe(2);
            expect(result.movies).toBe(1);
            expect(result.series).toBe(1);
        });

        it('counts audiobooks in their own bucket, not folded into another counter', async () => {
            // Without a dedicated counter the stats bar silently understates the
            // library: audiobooks land in `total` but in none of the per-type
            // tiles, so the tiles never add up.
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;

            const [bookA] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, status, has_files)
                VALUES ('Der Steppenwolf', 'audiobook', 'active', true)
                RETURNING id
            `;
            await sql`
                INSERT INTO media_items (title, media_type, status, has_files)
                VALUES ('Die sieben ??? und der Karpatenhund', 'audiobook', 'active', true)
            `;
            // isMissing upstream → has_files = false. Excluded from the counter by
            // the same availability filter every other per-type counter applies.
            await sql`
                INSERT INTO media_items (title, media_type, status, has_files)
                VALUES ('Vanished Book', 'audiobook', 'active', false)
            `;

            const result = await getMediaBrowserStats(sql);
            expect(result.audiobooks).toBe(2);
            expect(result.movies).toBe(1);
            expect(result.tracks).toBe(0);
            expect(result.total).toBe(4);
            expect(bookA.id).toBeTruthy();
        });
    });

    // =========================================================================
    // showDismissed — decoupled from the `unidentified` domain
    // =========================================================================

    describe('showDismissed is independent of the unidentified domain', () => {
        /**
         * Insert an ACTIVE, available, dismissed row of the given media type.
         *
         * The AudiobookShelf sweep produces exactly this shape: a book that
         * disappeared upstream is dismissed (an availability observation may
         * never write `status = 'deleted'`, which is a purge sentence), so the
         * row stays `status = 'active'` forever. If admin cannot list it, it is
         * unpurgeable except via psql.
         */
        async function insertDismissed(title: string, mediaType: string): Promise<string> {
            const [row] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, status, has_files, is_dismissed)
                VALUES (${title}, ${mediaType}, 'active', true, true)
                RETURNING id
            `;
            // An external_id keeps the row out of the `unidentified` bucket, so
            // these tests exercise the ordinary browse path only.
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${row.id}::uuid, 'audiobookshelf', ${`abs-${row.id}`}, ${mediaType}, true)
            `;
            return row.id;
        }

        async function insertVisible(title: string, mediaType: string): Promise<string> {
            const [row] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, status, has_files, is_dismissed)
                VALUES (${title}, ${mediaType}, 'active', true, false)
                RETURNING id
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${row.id}::uuid, 'audiobookshelf', ${`abs-${row.id}`}, ${mediaType}, true)
            `;
            return row.id;
        }

        const opts = {
            types: ['audiobook'],
            unidentified: false,
            limit: 50,
            offset: 0,
        };

        it('hides dismissed rows by default in a normal (non-unidentified) domain', async () => {
            const dismissed = await insertDismissed('Gone Upstream', 'audiobook');
            const kept = await insertVisible('Still There', 'audiobook');

            const rows = await listAdminMediaItems(sql, { ...opts, showDismissed: false });
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(kept);
            expect(ids).not.toContain(dismissed);
        });

        it('surfaces dismissed rows in a normal domain when showDismissed is set', async () => {
            // The regression this pins: the gate used to read
            // `unidentified && showDismissed`, so with unidentified = false the
            // flag was a no-op and dismissed rows were unreachable everywhere
            // except the unidentified tab (itself restricted to movie/tv).
            const dismissed = await insertDismissed('Gone Upstream', 'audiobook');
            const kept = await insertVisible('Still There', 'audiobook');

            const rows = await listAdminMediaItems(sql, { ...opts, showDismissed: true });
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(dismissed);
            expect(ids).toContain(kept);
        });

        it('keeps the count in step with the list', async () => {
            await insertDismissed('Gone Upstream', 'audiobook');
            await insertVisible('Still There', 'audiobook');

            const hiddenRows = await listAdminMediaItems(sql, { ...opts, showDismissed: false });
            const hiddenCount = await countAdminMediaItems(sql, {
                ...opts,
                showDismissed: false,
            });
            expect(hiddenCount).toBe(hiddenRows.length);
            expect(hiddenCount).toBe(1);

            const shownRows = await listAdminMediaItems(sql, { ...opts, showDismissed: true });
            const shownCount = await countAdminMediaItems(sql, { ...opts, showDismissed: true });
            expect(shownCount).toBe(shownRows.length);
            expect(shownCount).toBe(2);
        });

        it('applies to every media type, not just audiobooks', async () => {
            const dismissedMovie = await insertDismissed('Dismissed Film', 'movie');

            const hidden = await listAdminMediaItems(sql, {
                types: ['movie'],
                unidentified: false,
                showDismissed: false,
                limit: 50,
                offset: 0,
            });
            expect(hidden.map((r) => r.id)).not.toContain(dismissedMovie);

            const shown = await listAdminMediaItems(sql, {
                types: ['movie'],
                unidentified: false,
                showDismissed: true,
                limit: 50,
                offset: 0,
            });
            expect(shown.map((r) => r.id)).toContain(dismissedMovie);
        });

        it('still honours showDismissed inside the unidentified domain', async () => {
            // Regression guard for the pre-existing workflow: the unidentified
            // tab must keep behaving exactly as before.
            const [row] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year, status, has_files, is_dismissed)
                VALUES ('Unidentified Dismissed', 'movie', 2001, 'active', true, true)
                RETURNING id
            `;

            const hidden = await listAdminMediaItems(sql, {
                types: ['movie', 'tv'],
                unidentified: true,
                showDismissed: false,
                limit: 50,
                offset: 0,
            });
            expect(hidden.map((r) => r.id)).not.toContain(row.id);

            const shown = await listAdminMediaItems(sql, {
                types: ['movie', 'tv'],
                unidentified: true,
                showDismissed: true,
                limit: 50,
                offset: 0,
            });
            expect(shown.map((r) => r.id)).toContain(row.id);
        });

        it('lists an audiobook row at all — the admin browser is its only purge path', async () => {
            const book = await insertVisible('Der Name der Rose', 'audiobook');

            const rows = await listAdminMediaItems(sql, { ...opts, showDismissed: false });
            const found = rows.find((r) => r.id === book);
            expect(found).toBeDefined();
            expect(found?.media_type).toBe('audiobook');
            // Audiobooks have no media_files rows by design (bytes stay on ABS).
            expect(found?.file_count).toBe(0);
            expect(found?.has_files).toBe(true);
        });
    });

    describe('listAdminMediaItems', () => {
        it('returns paginated media items', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;

            const result = await listAdminMediaItems(sql, {
                types: ['movie'],
                limit: 10,
                offset: 0,
            });
            expect(result.length).toBeGreaterThanOrEqual(0);
        });

        /**
         * Revert-check: drop `COLLATE natural_sort` from the title sort and this
         * fails — the default collation compares digit by digit and puts
         * "28 Years Later" before "2 Fast 2 Furious".
         */
        /**
         * The A–Z jump counts the rows ahead of a letter with the same
         * collation the list sorts by; if the two disagreed, a jump would land
         * on a page that does not start at the letter.
         */
        it('titleBefore counts exactly the rows the title sort puts ahead of a letter', async () => {
            for (const title of ['2 Fast', 'alpha', 'Beta', 'bravo', 'Charlie', 'delta']) {
                await insertTestMediaItem(
                    sql,
                    createTestMediaItem({ media_type: 'movie', title, year: 2000 }),
                );
            }
            await sql`UPDATE media_items SET has_files = true`;

            const sorted = (
                await listAdminMediaItems(sql, { types: ['movie'], limit: 10, offset: 0 })
            ).map((r) => r.title);
            const before = await countAdminMediaItems(sql, { types: ['movie'], titleBefore: 'C' });

            expect(before).toBe(sorted.findIndex((t) => t === 'Charlie'));
            expect(before).toBe(4);
        });

        it('sorts titles numerically, not digit by digit', async () => {
            const titles = [
                '28 Years Later',
                '2 Fast 2 Furious',
                '300',
                '30 Rock',
                '3 Body Problem',
            ];
            for (const title of titles) {
                const item = createTestMediaItem({ media_type: 'movie', title, year: 2000 });
                await insertTestMediaItem(sql, item);
            }
            await sql`UPDATE media_items SET has_files = true`;

            const result = await listAdminMediaItems(sql, {
                types: ['movie'],
                sortBy: 'title',
                sortDir: 'asc',
                limit: 10,
                offset: 0,
            });
            expect(result.map((r) => r.title)).toEqual([
                '2 Fast 2 Furious',
                '3 Body Problem',
                '28 Years Later',
                '30 Rock',
                '300',
            ]);
        });

        // The audiobook domain's Author / Narrator / Series columns. These read
        // `custom_metadata.audiobookshelf`, which the AudiobookShelf connector
        // writes with no schema to enforce it — so the extraction must survive a
        // field of the wrong jsonb type rather than failing the whole statement
        // and blanking the browser for every other row on the page.
        describe('audiobook book columns', () => {
            async function insertBook(
                title: string,
                metadata: Record<string, unknown>,
            ): Promise<string> {
                const book = createTestMediaItem({ media_type: 'audiobook', title });
                await insertTestMediaItem(sql, book);
                // sql.json() with the OBJECT, never a pre-stringified one: passing
                // JSON.stringify(...) here writes a jsonb *string* containing the
                // JSON text, not an object, and every path read off it then returns
                // null with no error anywhere to say why.
                //
                // The cast is the point of these fixtures: `Record<string, unknown>`
                // is not a JSONValue precisely because it can hold the malformed
                // shapes the connector really writes, which is what the tests below
                // feed in.
                await sql`
                    UPDATE media_items
                       SET has_files       = true,
                           custom_metadata = ${sql.json({ audiobookshelf: metadata } as postgres.JSONValue)}
                     WHERE id = ${book.id}::uuid
                `;
                return book.id;
            }

            it('returns the first author, first narrator and derived series', async () => {
                const id = await insertBook('Words of Radiance', {
                    authors: ['Brandon Sanderson'],
                    narrators: ['Micah Fenwick', 'Kate Fenwick'],
                    derivedSeries: {
                        name: 'The Harborlight Archive',
                        sequence: 2,
                        source: 'abs-series',
                    },
                });

                const rows = await listAdminMediaItems(sql, {
                    types: ['audiobook'],
                    limit: 50,
                    offset: 0,
                });
                const row = rows.find((r) => r.id === id);

                expect(row?.book_author).toBe('Brandon Sanderson');
                expect(row?.book_narrator).toBe('Micah Fenwick');
                expect(row?.book_series).toBe('The Harborlight Archive');
                expect(row?.book_series_sequence).toBe('2');
            });

            it('reads no sequence when AudiobookShelf recorded a non-numeric one', async () => {
                const id = await insertBook('Guards! Guards!', {
                    authors: ['Terry Pratchett'],
                    derivedSeries: { name: 'Cloudrealm', sequence: '2.5', source: 'folder' },
                });

                const rows = await listAdminMediaItems(sql, {
                    types: ['audiobook'],
                    limit: 50,
                    offset: 0,
                });
                const row = rows.find((r) => r.id === id);

                expect(row?.book_series).toBe('Cloudrealm');
                // The jsonb_typeof guard: a decimal sequence arrives as a STRING
                // in the persisted shape, and a bare `::numeric` cast on it would
                // raise for the whole page, not just this row.
                expect(row?.book_series_sequence).toBeNull();
            });

            it('degrades one malformed field without losing the row or its siblings', async () => {
                const id = await insertBook('Broken Book', {
                    authors: 'Brandon Sanderson',
                    narrators: ['Micah Fenwick'],
                    derivedSeries: { name: '', sequence: 1, source: 'none' },
                });

                const rows = await listAdminMediaItems(sql, {
                    types: ['audiobook'],
                    limit: 50,
                    offset: 0,
                });
                const row = rows.find((r) => r.id === id);

                expect(row).toBeDefined();
                expect(row?.book_author).toBeNull();
                expect(row?.book_narrator).toBe('Micah Fenwick');
                // NULLIF on the empty string: an empty name is "no series", not a
                // blank chip in the Series column.
                expect(row?.book_series).toBeNull();
            });

            it('leaves the book columns null for a non-audiobook row', async () => {
                const movie = createTestMediaItem({ media_type: 'movie', title: 'A Film' });
                await insertTestMediaItem(sql, movie);
                await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;

                const rows = await listAdminMediaItems(sql, {
                    types: ['movie'],
                    limit: 50,
                    offset: 0,
                });
                const row = rows.find((r) => r.id === movie.id);

                expect(row?.book_author).toBeNull();
                expect(row?.book_narrator).toBeNull();
                expect(row?.book_series).toBeNull();
            });
        });

        it('filters by unidentified (no external_ids)', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            // listAdminMediaItems defaults to has_files = true unless
            // showUnavailable is set, so ensure the row has the flag.
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;

            const result = await listAdminMediaItems(sql, {
                types: ['movie'],
                unidentified: true,
                limit: 10,
                offset: 0,
            });
            const match = result.find((r) => r.id === movie.id);
            expect(match).toBeDefined();
        });

        // Admin IA redesign, spec §3.2 — the "has file issues" filter
        // (?filter=file-issues) that replaces the removed File Health /
        // Integrity tabs. Two independent producers must both match:
        // media_files.health_issues (via media_file_items) and open,
        // row-scoped integrity_violations.
        it('filters by fileIssues: matches an item whose file has health_issues', async () => {
            const healthy = createTestMediaItem({ media_type: 'movie', title: 'Healthy Movie' });
            const unhealthy = createTestMediaItem({
                media_type: 'movie',
                title: 'Truncated Movie',
            });
            await insertTestMediaItem(sql, healthy);
            await insertTestMediaItem(sql, unhealthy);
            await sql`UPDATE media_items SET has_files = true WHERE id IN (${healthy.id}::uuid, ${unhealthy.id}::uuid)`;

            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, health_issues)
                VALUES ('/movies/truncated.mkv', ${sql.json([
                    { type: 'truncated_video', detected_at: new Date().toISOString() },
                ] as unknown as postgres.JSONValue)})
                RETURNING id
            `;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file!.id}::uuid, ${unhealthy.id}::uuid)`;

            const result = await listAdminMediaItems(sql, {
                types: ['movie'],
                fileIssues: true,
                limit: 10,
                offset: 0,
            });
            const ids = result.map((r) => r.id);
            expect(ids).toContain(unhealthy.id);
            expect(ids).not.toContain(healthy.id);

            const count = await countAdminMediaItems(sql, { types: ['movie'], fileIssues: true });
            expect(count).toBe(1);
        });

        it('filters by fileIssues: matches an item with an open integrity violation', async () => {
            // media_type 'movie' (not 'tv') deliberately — buildUnmatchedStubFilter
            // excludes yearless, external-id-less 'tv' rows as scanner stubs, which
            // would confound this test with unrelated stub-filtering behavior.
            const clean = createTestMediaItem({ media_type: 'movie', title: 'Clean Movie' });
            const flagged = createTestMediaItem({ media_type: 'movie', title: 'Flagged Movie' });
            await insertTestMediaItem(sql, clean);
            await insertTestMediaItem(sql, flagged);
            await sql`UPDATE media_items SET has_files = true WHERE id IN (${clean.id}::uuid, ${flagged.id}::uuid)`;

            await sql`
                INSERT INTO integrity_violations (rule, severity, media_id, details)
                VALUES ('duplicate-content', 'medium', ${flagged.id}::uuid, '{}'::jsonb)
            `;

            const result = await listAdminMediaItems(sql, {
                types: ['movie'],
                fileIssues: true,
                limit: 10,
                offset: 0,
            });
            const ids = result.map((r) => r.id);
            expect(ids).toContain(flagged.id);
            expect(ids).not.toContain(clean.id);
        });
    });

    describe('countAdminMediaItems', () => {
        it('returns count matching filters', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;

            const count = await countAdminMediaItems(sql, {
                types: ['movie'],
            });
            expect(count).toBeGreaterThanOrEqual(0);
        });
    });

    /**
     * Saved views (triage spec §2): for every view, the count the pill shows
     * equals the list the pill opens. The fixture has one movie per problem
     * kind, a duplicate pair, an unavailable movie, a healthy movie, and an
     * episode whose missing poster/TMDB id is normal and must count nowhere.
     */
    describe('saved views: counts match lists', () => {
        const scope = { types: ['movie', 'tv', 'episode'], jellyfinEnabled: true };

        async function seed(
            title: string,
            o: {
                type?: 'movie' | 'episode';
                tmdb?: number;
                jf?: boolean;
                poster?: boolean;
                overview?: boolean;
                files?: boolean;
                lost?: boolean;
                fileIssue?: boolean;
            },
        ): Promise<string> {
            const type = o.type ?? 'movie';
            const item = createTestMediaItem({ media_type: type, title, year: 2020 });
            await insertTestMediaItem(sql, item);
            await sql`
                UPDATE media_items
                SET has_files = ${o.lost ? false : (o.files ?? true)},
                    files_lost_at = ${o.lost ? new Date().toISOString() : null},
                    poster_blurhash = ${o.poster === false ? null : 'LEHV6nWB2yk8'},
                    custom_poster_url = ${o.poster === false ? null : 'https://example.test/poster.jpg'},
                    overview = ${o.overview === false ? null : 'An overview.'}
                WHERE id = ${item.id}::uuid
            `;
            if (o.tmdb || o.jf !== false) {
                await insertTestExternalIds(
                    sql,
                    createTestExternalIds(item.id, {
                        tmdbId: o.tmdb,
                        jellyfinId: o.jf === false ? undefined : `jf-${item.id}`,
                        mediaType: type,
                    }),
                );
            }
            if (o.fileIssue) {
                const [file] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path, health_issues)
                    VALUES (${`/m/${item.id}.mkv`}, ${sql.json([
                        { type: 'truncated_video' },
                    ] as unknown as postgres.JSONValue)})
                    RETURNING id
                `;
                await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file!.id}::uuid, ${item.id}::uuid)`;
            }
            return item.id;
        }

        beforeEach(async () => {
            await seed('Healthy', { tmdb: 900001 });
            await seed('No TMDB', {});
            await seed('No Poster', { tmdb: 900003, poster: false });
            await seed('No Overview', { tmdb: 900004, overview: false });
            await seed('Broken File', { tmdb: 900005, fileIssue: true });
            // A file row with no external ids + its TMDB discovery twin.
            await seed('Dup Film', { jf: false });
            await seed('Dup Film', { tmdb: 900007, jf: false, files: false });
            // Catalog-only discovery row: no files, never had any — not a problem.
            // Catalog-only discovery row: no files, never had any, and no poster or
            // overview either — none of that is a library problem.
            await seed('Discovery Only', {
                tmdb: 900006,
                jf: false,
                files: false,
                poster: false,
                overview: false,
            });
            await seed('Gone', { tmdb: 900008, lost: true });
            await seed('No Jellyfin', { tmdb: 900009, jf: false });
            await seed('Normal Episode', { type: 'episode', poster: false });
        });

        async function listView(view: MediaBrowserView): Promise<string[]> {
            const v = viewQueryOptions(view, scope);
            const rows = await listAdminMediaItems(sql, {
                types: scope.types,
                showUnavailable: v.includeUnavailable,
                issue: v.issue,
                attentionKinds: v.attentionKinds,
                addedSince: v.addedSince,
                limit: 100,
                offset: 0,
            });
            return rows.map((r) => r.title ?? '');
        }

        it('every view count equals its list length and countAdminMediaItems', async () => {
            const views = viewsForScope(scope);
            const counts = await countAdminMediaViews(
                sql,
                { types: scope.types },
                {
                    views: views.map((id) => ({ id, issue: VIEW_ISSUE[id] })),
                    attentionKinds: viewQueryOptions('attention', scope).attentionKinds!,
                    recentSince: viewQueryOptions('recent', scope).addedSince!,
                },
            );
            for (const view of views) {
                const titles = await listView(view);
                const v = viewQueryOptions(view, scope);
                const total = await countAdminMediaItems(sql, {
                    types: scope.types,
                    showUnavailable: v.includeUnavailable,
                    issue: v.issue,
                    attentionKinds: v.attentionKinds,
                    addedSince: v.addedSince,
                });
                expect(counts[view], `count for ${view}`).toBe(titles.length);
                expect(total, `countAdminMediaItems for ${view}`).toBe(titles.length);
            }
        });

        it('lists exactly the rows with each problem', async () => {
            expect((await listView('unidentified')).sort()).toEqual(['Dup Film', 'No TMDB']);
            expect(await listView('artwork')).toEqual(['No Poster']);
            expect(await listView('overview')).toEqual(['No Overview']);
            expect(await listView('files')).toEqual(['Broken File']);
            expect(await listView('duplicates')).toEqual(['Dup Film']);
            expect((await listView('jellyfin')).sort()).toEqual(['Dup Film', 'No Jellyfin']);
            expect(await listView('lost')).toEqual(['Gone']);
        });

        it('Needs attention unions warnings and errors, skipping info and normal gaps', async () => {
            const titles = (await listView('attention')).sort();
            expect(titles).toEqual(
                ['Broken File', 'Dup Film', 'Gone', 'No Overview', 'No Poster', 'No TMDB'].sort(),
            );
            expect(titles).not.toContain('Normal Episode');
            expect(titles).not.toContain('Discovery Only');
            expect(titles).not.toContain('No Jellyfin');
        });

        it('flags the duplicate file row and the lost row on the list rows', async () => {
            const rows = await listAdminMediaItems(sql, {
                types: ['movie'],
                showUnavailable: true,
                limit: 100,
                offset: 0,
            });
            expect(rows.filter((r) => r.is_duplicate).map((r) => r.title)).toEqual(['Dup Film']);
            expect(rows.filter((r) => r.files_lost).map((r) => r.title)).toEqual(['Gone']);
        });
    });

    /**
     * Series drill-down + roll-up (triage spec §4). A series owns no files, so
     * a broken episode must surface on the series row (badge count) and in
     * the File problems view, from the same set — and the drill-down lists
     * the series' descendants through the list query.
     */
    describe('series roll-up and drill-down', () => {
        it('shows descendant file findings in the series and season inspector', async () => {
            const ids = await tree();
            for (const id of [ids.series, ids.s1]) {
                const preview = await getMediaPreview(sql, id);
                expect(preview?.healthIssues?.map((issue) => issue.type)).toEqual(['no_keyframes']);
                expect(preview?.fileCount).toBeGreaterThan(0);
            }
        });

        async function tree(): Promise<{
            series: string;
            s1: string;
            broken: string;
            fine: string;
        }> {
            const series = createTestMediaItem({
                media_type: 'tv',
                title: 'Rolled Up',
                year: 2020,
            });
            const s1 = createTestMediaItem({ media_type: 'season', title: 'Season 1', year: 2020 });
            const broken = createTestMediaItem({
                media_type: 'episode',
                title: 'Broken Ep',
                year: 2020,
            });
            const fine = createTestMediaItem({
                media_type: 'episode',
                title: 'Fine Ep',
                year: 2020,
            });
            for (const it of [series, s1, broken, fine]) await insertTestMediaItem(sql, it);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid, season_number = 1 WHERE id = ${s1.id}::uuid`;
            await sql`UPDATE media_items SET parent_id = ${s1.id}::uuid, season_number = 1, episode_number = 1 WHERE id = ${broken.id}::uuid`;
            await sql`UPDATE media_items SET parent_id = ${s1.id}::uuid, season_number = 1, episode_number = 2 WHERE id = ${fine.id}::uuid`;
            await sql`UPDATE media_items SET has_files = true, custom_poster_url = 'https://example.test/poster.jpg', poster_blurhash = 'LEHV', overview = 'x'`;
            await insertTestExternalIds(
                sql,
                createTestExternalIds(series.id, { tmdbId: 910001, mediaType: 'tv' }),
            );
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, health_issues)
                VALUES ('/tv/broken.mkv', ${sql.json([{ type: 'no_keyframes' }] as unknown as postgres.JSONValue)})
                RETURNING id
            `;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file!.id}::uuid, ${broken.id}::uuid)`;
            return { series: series.id, s1: s1.id, broken: broken.id, fine: fine.id };
        }

        it('counts the broken episode on the series row', async () => {
            const ids = await tree();
            const [row] = await listAdminMediaItems(sql, { types: ['tv'], limit: 10, offset: 0 });
            expect(row?.id).toBe(ids.series);
            expect(row?.episode_problem_count).toBe(1);
        });

        it('lists the series in File problems, and the count agrees', async () => {
            const ids = await tree();
            const rows = await listAdminMediaItems(sql, {
                types: ['movie', 'tv'],
                issue: 'file_problem',
                limit: 10,
                offset: 0,
            });
            expect(rows.map((r) => r.id)).toEqual([ids.series]);
            const counts = await countAdminMediaViews(
                sql,
                { types: ['movie', 'tv'] },
                {
                    views: [{ id: 'files', issue: 'file_problem' }],
                    attentionKinds: [],
                    recentSince: new Date().toISOString(),
                },
            );
            expect(counts.files).toBe(1);
        });

        it('itemIds reads exactly the requested row, with its roll-up', async () => {
            const ids = await tree();
            const rows = await listAdminMediaItems(sql, {
                types: ['tv'],
                itemIds: [ids.series],
                showUnavailable: true,
                showDismissed: true,
                limit: 1,
                offset: 0,
            });
            expect(rows.map((r) => r.id)).toEqual([ids.series]);
            expect(rows[0]?.episode_problem_count).toBe(1);
        });

        it('ancestorId lists exactly the series descendants', async () => {
            const ids = await tree();
            const rows = await listAdminMediaItems(sql, {
                types: ['season', 'episode'],
                ancestorId: ids.series,
                showUnavailable: true,
                sortBy: 'hierarchy',
                limit: 100,
                offset: 0,
            });
            expect(rows.map((r) => r.id).sort()).toEqual([ids.s1, ids.broken, ids.fine].sort());
            expect(rows.find((r) => r.id === ids.broken)?.health_issue_types).toEqual([
                'no_keyframes',
            ]);
        });
    });

    describe('getMediaPreview', () => {
        it('returns preview for existing item', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(movie.id, {
                    tmdbId: 123,
                    mediaType: 'movie',
                }),
            );

            const result = await getMediaPreview(sql, movie.id);
            expect(result).toBeDefined();
            expect(result?.id).toBe(movie.id);
        });

        /**
         * Container rows own no files; the episodes do. Revert-check: count only
         * the item's own `media_file_items` again and this reads 0.
         */
        it("counts a series' files through its seasons and episodes", async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            // insertTestMediaItem does not persist parent_id — set it by hand.
            const season = createTestMediaItem({ media_type: 'season' });
            await insertTestMediaItem(sql, season);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${season.id}::uuid`;
            for (const n of [1, 2]) {
                const ep = createTestMediaItem({ media_type: 'episode' });
                await insertTestMediaItem(sql, ep);
                await sql`UPDATE media_items SET parent_id = ${season.id}::uuid WHERE id = ${ep.id}::uuid`;
                const [file] = await sql<{ id: string }[]>`
                    INSERT INTO media_files (file_path) VALUES (${`/series/s01e0${n}.mkv`})
                    RETURNING id
                `;
                await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${file!.id}::uuid, ${ep.id}::uuid)`;
            }

            const result = await getMediaPreview(sql, series.id);
            expect(result?.fileCount).toBe(2);
        });

        it('returns undefined for missing item', async () => {
            const result = await getMediaPreview(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBeUndefined();
        });
    });

    describe('findDuplicateMediaItems', () => {
        it('returns empty array when no duplicates exist', async () => {
            const result = await findDuplicateMediaItems(sql);
            expect(Array.isArray(result)).toBe(true);
        });

        it('surfaces two active non-dismissed items sharing the same TMDB ID as a duplicate group', async () => {
            // Two media_items both have TMDB external_id '777001' but with
            // different ei.media_type values, which is permitted by the UNIQUE
            // constraint on (provider, external_id, media_type). The query
            // groups by (ei.external_id, mi.media_type) so both items appear
            // in the same duplicate group.
            const [rowA] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year, status, is_dismissed, has_files)
                VALUES ('Twin Movie', 'movie', 2020, 'active', false, true)
                RETURNING id
            `;
            const [rowB] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year, status, is_dismissed, has_files)
                VALUES ('Twin Movie', 'movie', 2020, 'active', false, false)
                RETURNING id
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${rowA.id}::uuid, 'tmdb', '777001', 'movie', true)
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${rowB.id}::uuid, 'tmdb', '777001', 'tv', true)
            `;

            const result = await findDuplicateMediaItems(sql);
            const group = result.find((r) => r.tmdb_id === '777001');
            expect(group).toBeDefined();
            expect(group?.items).toHaveLength(2);
        });

        it('excludes a dismissed item from duplicate groups (FIX #37)', async () => {
            const [active] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year, status, is_dismissed, has_files)
                VALUES ('Dismissed Pair', 'movie', 2021, 'active', false, true)
                RETURNING id
            `;
            const [dismissed] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year, status, is_dismissed, has_files)
                VALUES ('Dismissed Pair', 'movie', 2021, 'active', true, false)
                RETURNING id
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${active.id}::uuid, 'tmdb', '777002', 'movie', true)
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${dismissed.id}::uuid, 'tmdb', '777002', 'tv', true)
            `;

            const result = await findDuplicateMediaItems(sql);
            const group = result.find((r) => r.tmdb_id === '777002');
            expect(group).toBeUndefined();
        });

        it('excludes a merged-status item from duplicate groups (FIX #37)', async () => {
            const [active] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year, status, is_dismissed, has_files)
                VALUES ('Merged Pair', 'movie', 2022, 'active', false, true)
                RETURNING id
            `;
            const [merged] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year, status, is_dismissed, has_files)
                VALUES ('Merged Pair', 'movie', 2022, 'merged', false, false)
                RETURNING id
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${active.id}::uuid, 'tmdb', '777003', 'movie', true)
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${merged.id}::uuid, 'tmdb', '777003', 'tv', true)
            `;

            const result = await findDuplicateMediaItems(sql);
            const group = result.find((r) => r.tmdb_id === '777003');
            expect(group).toBeUndefined();
        });
    });

    describe('findFilelessDuplicatePairs', () => {
        async function insertMovie(opts: {
            title: string;
            year: number | null;
            hasFiles: boolean;
            tmdbId?: number;
        }): Promise<string> {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: opts.title,
                year: opts.year ?? undefined,
                has_files: opts.hasFiles,
            });
            await insertTestMediaItem(sql, item);
            if (opts.tmdbId) {
                await insertTestExternalIds(
                    sql,
                    createTestExternalIds(item.id, { tmdbId: opts.tmdbId, mediaType: 'movie' }),
                );
            }
            return item.id;
        }

        it('pairs an id-less file row with its tmdb discovery twin (whitespace-insensitive)', async () => {
            const fileId = await insertMovie({
                title: 'Obersalzberg der Film',
                year: 2010,
                hasFiles: true,
            });
            const discoveryId = await insertMovie({
                title: 'Obersalzberg - der Film',
                year: 2010,
                hasFiles: false,
                tmdbId: 121034,
            });

            const pairs = await findFilelessDuplicatePairs(sql);
            const match = pairs.find((p) => p.fileId === fileId);
            expect(match).toBeDefined();
            expect(match?.discoveryId).toBe(discoveryId);
            expect(match?.tmdbId).toBe('121034');
            expect(await countFilelessDuplicatePairs(sql)).toBe(1);
        });

        it('omits ambiguous buckets with more than one file row', async () => {
            await insertMovie({ title: 'Ambi', year: 2010, hasFiles: true });
            await insertMovie({ title: 'Ambi', year: 2010, hasFiles: true });
            await insertMovie({ title: 'Ambi', year: 2010, hasFiles: false, tmdbId: 5 });

            const pairs = await findFilelessDuplicatePairs(sql);
            expect(pairs.some((p) => p.discoveryTitle === 'Ambi')).toBe(false);
            expect(await countFilelessDuplicatePairs(sql)).toBe(0);
        });

        it('omits multiple discovery matches but ignores ineligible rows in a bucket', async () => {
            await insertMovie({ title: 'Ambiguous discovery', year: 2010, hasFiles: true });
            await insertMovie({
                title: 'Ambiguous discovery',
                year: 2010,
                hasFiles: false,
                tmdbId: 51,
            });
            await insertMovie({
                title: 'Ambiguous discovery',
                year: 2010,
                hasFiles: false,
                tmdbId: 52,
            });
            const fileId = await insertMovie({ title: 'Eligible', year: 2011, hasFiles: true });
            await insertMovie({ title: 'Eligible', year: 2011, hasFiles: false, tmdbId: 53 });
            await insertMovie({ title: 'Eligible', year: 2011, hasFiles: true, tmdbId: 54 });
            await insertMovie({ title: 'Eligible', year: 2011, hasFiles: false });
            const dismissed = await insertMovie({ title: 'Eligible', year: 2011, hasFiles: true });
            const deleted = await insertMovie({
                title: 'Eligible',
                year: 2011,
                hasFiles: false,
                tmdbId: 55,
            });
            await sql`UPDATE media_items SET is_dismissed=true WHERE id=${dismissed}`;
            await sql`UPDATE media_items SET status='deleted' WHERE id=${deleted}`;
            expect((await findFilelessDuplicatePairs(sql)).map((p) => p.fileId)).toEqual([fileId]);
            expect(await countFilelessDuplicatePairs(sql)).toBe(1);
        });

        it('does not pair when the file row already has external_ids', async () => {
            await insertMovie({ title: 'Linked', year: 2010, hasFiles: true, tmdbId: 7 });
            await insertMovie({ title: 'Linked', year: 2010, hasFiles: false, tmdbId: 8 });

            const pairs = await findFilelessDuplicatePairs(sql);
            expect(pairs.some((p) => p.fileTitle === 'Linked')).toBe(false);
        });

        it('does not pair rows with unknown (NULL) years (avoids remake collisions)', async () => {
            // Insert raw so year is a true SQL NULL (the fixture coalesces null
            // to a sample year). NULL = NULL is not true, so the self-join must
            // not pair these.
            const [fileRow] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year, has_files, status)
                VALUES ('Yearless', 'movie', NULL, true, 'active') RETURNING id
            `;
            const [discoveryRow] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year, has_files, status)
                VALUES ('Yearless', 'movie', NULL, false, 'active') RETURNING id
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${discoveryRow.id}::uuid, 'tmdb', '9', 'movie', true)
            `;

            const pairs = await findFilelessDuplicatePairs(sql);
            expect(pairs.some((p) => p.fileId === fileRow.id)).toBe(false);
            expect(pairs.some((p) => p.discoveryId === discoveryRow.id)).toBe(false);
        });
    });

    describe('findFilelessDuplicatePairsWithTotal', () => {
        async function insertQualifyingPair(
            title: string,
            year: number,
            tmdbId: number,
        ): Promise<void> {
            const [fileRow] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year, has_files, status, is_dismissed)
                VALUES (${title}, 'movie', ${year}, true, 'active', false)
                RETURNING id
            `;
            const [discoveryRow] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, year, has_files, status, is_dismissed)
                VALUES (${title}, 'movie', ${year}, false, 'active', false)
                RETURNING id
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${discoveryRow.id}::uuid, 'tmdb', ${String(tmdbId)}, 'movie', true)
            `;
            // Suppress unused variable warning
            void fileRow;
        }

        it('returns empty pairs and total 0 on a clean database (FIX #35)', async () => {
            const result = await findFilelessDuplicatePairsWithTotal(sql);
            expect(result.pairs).toHaveLength(0);
            expect(result.total).toBe(0);
        });

        it('total reflects uncapped count when limit is smaller than actual matches (FIX #35)', async () => {
            await insertQualifyingPair('Alpha Film', 2010, 800001);
            await insertQualifyingPair('Beta Film', 2011, 800002);
            await insertQualifyingPair('Gamma Film', 2012, 800003);

            const result = await findFilelessDuplicatePairsWithTotal(sql, 2);
            expect(result.pairs).toHaveLength(2);
            expect(result.total).toBe(3);
        });

        it('total equals pairs.length when all results fit within limit', async () => {
            await insertQualifyingPair('Delta Film', 2013, 800004);
            await insertQualifyingPair('Epsilon Film', 2014, 800005);

            const result = await findFilelessDuplicatePairsWithTotal(sql, 100);
            expect(result.pairs).toHaveLength(2);
            expect(result.total).toBe(2);
        });
    });

    // =========================================================================
    // Admin Search Parity Tests
    // =========================================================================

    describe('admin search parity', () => {
        /**
         * Seed a media_items row and wire up the minimum supporting records needed
         * so it survives all admin list filters (orphan-stub, unmatched-stub, etc.).
         *
         * - Inserts a tmdb external_id so TV items clear the orphan-stub filter.
         * - Sets english_title / original_title via UPDATE (re-fires search_vector trigger).
         * - Optionally sets parent_id via UPDATE (for episodes).
         * - Optionally inserts provider_metadata at provider = 'tmdb'.
         *
         * @returns The UUID of the inserted media_items row.
         */
        async function seedAdminMedia(opts: {
            title: string;
            media_type: 'movie' | 'tv' | 'episode' | 'season';
            has_files?: boolean;
            english_title?: string;
            original_title?: string;
            overview?: string;
            parent_id?: string;
            tmdbId?: number;
        }): Promise<string> {
            const hasFiles = opts.has_files ?? true;
            const tmdbId = opts.tmdbId ?? Math.floor(Math.random() * 8_000_000) + 1_000_000;

            const item = createTestMediaItem({
                title: opts.title,
                media_type: opts.media_type,
                has_files: hasFiles,
            });

            const reserved = await sql.reserve();
            try {
                const rSql = reserved as unknown as postgres.Sql;

                await insertTestMediaItem(rSql, item);

                // Set english_title / original_title if provided — the UPDATE re-fires the
                // search_vector trigger so both fields are indexed.
                if (opts.english_title !== undefined || opts.original_title !== undefined) {
                    await rSql`
                        UPDATE media_items
                        SET
                            english_title   = COALESCE(${opts.english_title ?? null}, english_title),
                            original_title  = COALESCE(${opts.original_title ?? null}, original_title)
                        WHERE id = ${item.id}::uuid
                    `;
                }

                if (opts.overview !== undefined) {
                    await rSql`
                        UPDATE media_items
                        SET overview = ${opts.overview}
                        WHERE id = ${item.id}::uuid
                    `;
                }

                // Set parent_id for child items (episode / season).
                if (opts.parent_id !== undefined) {
                    await rSql`
                        UPDATE media_items
                        SET parent_id = ${opts.parent_id}::uuid
                        WHERE id = ${item.id}::uuid
                    `;
                }

                // Insert a tmdb external_id — required for TV items to clear
                // buildOrphanStubFilter (tv + no children + no external_ids + no file_items).
                // Episodes and movies also benefit from this for realistic test data.
                const externalIds = createTestExternalIds(item.id, {
                    tmdbId,
                    mediaType: opts.media_type === 'season' ? 'tv' : opts.media_type,
                });
                await insertTestExternalIds(rSql, externalIds);
            } finally {
                reserved.release();
            }

            return item.id;
        }

        /**
         * Upsert provider_metadata for an existing media_items row.
         * Provider MUST be 'tmdb' — that is what buildMetadataLateralJoinFragment reads.
         */
        async function seedMetadata(
            mediaId: string,
            meta: {
                keywords?: string[];
                mdblist_keywords?: string[];
                actors?: string[];
                directors?: string[];
            },
        ): Promise<void> {
            const payload: Record<string, string[]> = {};
            if (meta.keywords !== undefined) payload.keywords = meta.keywords;
            if (meta.mdblist_keywords !== undefined)
                payload.mdblist_keywords = meta.mdblist_keywords;
            if (meta.actors !== undefined) payload.actors = meta.actors;
            if (meta.directors !== undefined) payload.directors = meta.directors;

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaId}::uuid, 'tmdb', ${sql.json(payload)})
                ON CONFLICT (media_id, provider) DO UPDATE
                    SET metadata = EXCLUDED.metadata
            `;
        }

        // Base options for listAdminMediaItems / countAdminMediaItems.
        // showUnavailable: true so has_files = false items are not hidden.
        // types must be non-empty when unidentified = false (empty → ANY({}) → no rows).
        const baseOpts = {
            searchScope: 'metadata' as const,
            types: ['movie', 'tv', 'episode', 'season'] as string[],
            libraryGroupId: undefined as string | undefined,
            showUnavailable: true,
            unidentified: false,
            showDismissed: false,
            limit: 50,
            offset: 0,
            sortBy: 'title' as const,
            sortDir: 'asc' as const,
        };

        it('finds an item by its english_title (hafentage -> Große Hafentage)', async () => {
            const id = await seedAdminMedia({
                title: 'Große Hafentage',
                english_title: 'Hafentage',
                media_type: 'tv',
                has_files: true,
            });
            const rows = await listAdminMediaItems(sql, { ...baseOpts, query: 'hafentage' });
            expect(rows.map((r) => r.id)).toContain(id);
        });

        it('finds an item by keyword (claymation)', async () => {
            const id = await seedAdminMedia({
                title: 'Some Animated Title',
                media_type: 'movie',
                has_files: true,
            });
            await seedMetadata(id, { keywords: ['Claymation', 'animation'] });
            const rows = await listAdminMediaItems(sql, {
                ...baseOpts,
                query: 'claymation',
                types: ['movie'],
            });
            expect(rows.map((r) => r.id)).toContain(id);
        });

        it('finds an item by actor', async () => {
            const id = await seedAdminMedia({
                title: 'Cast Movie',
                media_type: 'movie',
                has_files: true,
            });
            await seedMetadata(id, { actors: ['Tom Hanks'] });
            const rows = await listAdminMediaItems(sql, {
                ...baseOpts,
                query: 'hanks',
                types: ['movie'],
            });
            expect(rows.map((r) => r.id)).toContain(id);
        });

        it('finds an item by typo (trigram): hafentag -> Hafentage', async () => {
            const id = await seedAdminMedia({
                title: 'Hafentage',
                media_type: 'tv',
                has_files: true,
            });
            const rows = await listAdminMediaItems(sql, {
                ...baseOpts,
                query: 'hafentag',
            });
            expect(rows.map((r) => r.id)).toContain(id);
        });

        it('ranks title matches before overview-only matches in admin search', async () => {
            const overviewOnlyId = await seedAdminMedia({
                title: '1864',
                media_type: 'movie',
                has_files: true,
                overview: 'A historical drama where shutters rattle in the wind.',
            });
            const titleHitId = await seedAdminMedia({
                title: 'Shutter',
                media_type: 'movie',
                has_files: true,
            });

            const rows = await listAdminMediaItems(sql, {
                ...baseOpts,
                query: 'shutter',
                types: ['movie'],
            });

            const ids = rows.map((r) => r.id);
            expect(ids).toContain(titleHitId);
            expect(ids).toContain(overviewOnlyId);
            expect(ids.indexOf(titleHitId)).toBeLessThan(ids.indexOf(overviewOnlyId));
        });

        it('respects the type filter while searching by keyword', async () => {
            const movieId = await seedAdminMedia({
                title: 'Keyworded Movie',
                media_type: 'movie',
                has_files: true,
            });
            const tvId = await seedAdminMedia({
                title: 'Keyworded Show',
                media_type: 'tv',
                has_files: true,
            });
            await seedMetadata(movieId, { keywords: ['uniquekw99'] });
            await seedMetadata(tvId, { keywords: ['uniquekw99'] });

            const rows = await listAdminMediaItems(sql, {
                ...baseOpts,
                query: 'uniquekw99',
                types: ['movie'],
            });
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(movieId);
            expect(ids).not.toContain(tvId);
        });

        it('list total equals count total for the same query', async () => {
            await seedAdminMedia({ title: 'Hafentage', media_type: 'tv', has_files: true });
            const opts = { ...baseOpts, query: 'hafentage' };
            const rows = await listAdminMediaItems(sql, opts);
            const total = await countAdminMediaItems(sql, opts);
            // Both operate on the same filters; with a capped limit > seeded count they agree.
            expect(total).toBe(rows.length);
        });

        it('a fuzzy hit on a SERIES title returns the series but not its episodes (#3)', async () => {
            const seriesId = await seedAdminMedia({
                title: 'Hafentage',
                media_type: 'tv',
                has_files: true,
            });
            // Episode: parent = seriesId; trigram is "direct-only" so a trigram hit on
            // the series does NOT drag in its episodes via parent expansion.
            const epId = await seedAdminMedia({
                title: 'Episode One',
                media_type: 'episode',
                has_files: true,
                parent_id: seriesId,
            });
            const rows = await listAdminMediaItems(sql, {
                ...baseOpts,
                query: 'hafentge', // non-prefix typo → trigram path only (not a FTS prefix of 'hafentage')
                types: ['tv', 'episode'],
            });
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(seriesId);
            expect(ids).not.toContain(epId);
        });

        it('wildcard chars in a keyword query do not over-match (#6)', async () => {
            const hit = await seedAdminMedia({
                title: 'Pct Hit',
                media_type: 'movie',
                has_files: true,
            });
            const miss = await seedAdminMedia({
                title: 'Pct Miss',
                media_type: 'movie',
                has_files: true,
            });
            await seedMetadata(hit, { keywords: ['50%'] });
            await seedMetadata(miss, { keywords: ['fifty'] });

            const rows = await listAdminMediaItems(sql, {
                ...baseOpts,
                query: '50%',
                types: ['movie'],
            });
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(hit);
            expect(ids).not.toContain(miss);
        });
    });

    /**
     * `media_files.health_issues` is an UNVALIDATED jsonb column with two
     * independent producers (media-probe.ts and audio-processor.ts) plus the
     * decode path, so its shape is a runtime fact, not a schema guarantee. Every
     * read of it in this module is therefore total, and these are the cases that
     * prove it — the guards had only ever been asserted as SQL *text* before,
     * which cannot tell you whether Postgres raises.
     *
     * Three distinct failure modes, all of which used to fail the WHOLE
     * statement rather than degrading one issue:
     *   1. a bare `::float` on non-numeric text RAISES,
     *   2. an element with no `type` key yields SQL NULL for a field
     *      `AdminPreviewResponseSchema` requires, so `.parse()` throws (500),
     *   3. `jsonb_array_length`/`jsonb_array_elements` RAISE on a non-array.
     *
     * Losing one malformed issue is correct; losing the panel — or, in the list
     * query, the entire page — is not.
     */
    describe('malformed health_issues', () => {
        /**
         * Seed a movie with one file carrying `healthIssues` verbatim.
         *
         * Written straight into the column rather than through
         * `recordDecodeHealthIssue`: the point is precisely the shapes no
         * writer in this repo would produce today but that the column can
         * nonetheless hold — a scalar, an object, a non-numeric duration.
         */
        async function seedItemWithHealthIssues(
            title: string,
            healthIssues: unknown,
            filePath: string,
        ): Promise<string> {
            const item = createTestMediaItem({ media_type: 'movie', title, has_files: true });
            await insertTestMediaItem(sql, item);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, health_issues)
                VALUES (${filePath}, ${sql.json(healthIssues as postgres.JSONValue)})
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${file!.id}::uuid, ${item.id}::uuid)
            `;
            return item.id;
        }

        /** Attach a SECOND file to an existing item (only one link may be default). */
        async function attachSecondFile(
            mediaItemId: string,
            healthIssues: unknown,
            filePath: string,
        ): Promise<void> {
            const [file] = await sql<{ id: string }[]>`
                INSERT INTO media_files (file_path, health_issues)
                VALUES (${filePath}, ${sql.json(healthIssues as postgres.JSONValue)})
                RETURNING id
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
                VALUES (${file!.id}::uuid, ${mediaItemId}::uuid, false, 1)
            `;
        }

        /**
         * The exact seam the endpoint uses: `preview.ts`'s GET handler pipes
         * `getMediaPreview` straight into `AdminPreviewResponseSchema.parse()`
         * with the media type remapped. Asserting on the query's raw return
         * alone would miss the half of the hazard that is a Zod rejection.
         */
        function parseAtEndpointSeam(
            preview: NonNullable<Awaited<ReturnType<typeof getMediaPreview>>>,
        ) {
            return AdminPreviewResponseSchema.parse({
                ...preview,
                media_type: toPublicMediaType(preview.media_type) ?? preview.media_type,
            });
        }

        const movieList = {
            types: ['movie'] as string[],
            showUnavailable: true,
            unidentified: false,
            showDismissed: false,
            limit: 50,
            offset: 0,
        };

        // -------------------------------------------------------------------
        // getMediaPreview
        // -------------------------------------------------------------------

        it('keeps the well-formed issue when a non-numeric duration and a typeless element share the array', async () => {
            const id = await seedItemWithHealthIssues(
                'Malformed Mix',
                [
                    {
                        type: 'video_ends_early',
                        detail: 'container declares 90m',
                        expected_duration: 'unknown',
                        actual_duration: 'unknown',
                    },
                    { detail: 'this element never got a type key', expected_duration: 41 },
                    {
                        type: 'truncated_video',
                        detail: 'stops at 12s of a declared 41s',
                        expected_duration: 41,
                        actual_duration: 12,
                    },
                ],
                '/movies/malformed-mix.mkv',
            );

            const preview = await getMediaPreview(sql, id);
            expect(preview).toBeDefined();
            const parsed = parseAtEndpointSeam(preview!);

            const issues = parsed.healthIssues ?? [];
            // The typeless element remains visible as unknown evidence.
            expect([...issues.map((i) => i.type)].sort()).toEqual([
                'truncated_video',
                'unknown_recorded_evidence',
                'video_ends_early',
            ]);

            // The good issue survives INTACT — dropping the bad element must not
            // cost the panel the numbers it exists to show.
            const good = issues.find((i) => i.type === 'truncated_video');
            expect(good?.detail).toBe('stops at 12s of a declared 41s');
            expect(good?.filePath).toBe('/movies/malformed-mix.mkv');
            expect(good?.expectedDuration).toBe(41);
            expect(good?.actualDuration).toBe(12);

            // The one with "unknown" durations keeps its type and reason and
            // simply loses the two fields that were never numbers.
            const degraded = issues.find((i) => i.type === 'video_ends_early');
            expect(degraded?.detail).toBe('container declares 90m');
            expect(degraded?.expectedDuration).toBeUndefined();
            expect(degraded?.actualDuration).toBeUndefined();
        });

        it('treats a literal dot as a dot: "1x5" is not a number, "1.5" is', async () => {
            // Guards the `[.]` in the numeric regex. Written as `\.` inside a
            // tagged template, JS strips the backslash before Postgres ever sees
            // it, leaving `.` — which matches ANY character, so "1x5" would pass
            // the guard and `'1x5'::float` would then raise for the whole query.
            const id = await seedItemWithHealthIssues(
                'Dot Trap',
                [{ type: 'truncated_video', expected_duration: '1x5', actual_duration: '1.5' }],
                '/movies/dot-trap.mkv',
            );

            const parsed = parseAtEndpointSeam((await getMediaPreview(sql, id))!);
            const issue = (parsed.healthIssues ?? [])[0];
            expect(issue?.type).toBe('truncated_video');
            expect(issue?.expectedDuration).toBeUndefined();
            expect(issue?.actualDuration).toBe(1.5);
        });

        it('rejects "NaN" and "Infinity", which Postgres would cast but Zod would not accept', async () => {
            const id = await seedItemWithHealthIssues(
                'Float Specials',
                [
                    {
                        type: 'truncated_video',
                        expected_duration: 'NaN',
                        actual_duration: 'Infinity',
                    },
                ],
                '/movies/float-specials.mkv',
            );

            const parsed = parseAtEndpointSeam((await getMediaPreview(sql, id))!);
            const issue = (parsed.healthIssues ?? [])[0];
            expect(issue?.type).toBe('truncated_video');
            expect(issue?.expectedDuration).toBeUndefined();
            expect(issue?.actualDuration).toBeUndefined();
        });

        it('keeps the inspector and browser usable for JSONB 1e400 and a huge numeric string', async () => {
            const id = await seedItemWithHealthIssues(
                'Huge Duration Metadata',
                [{ type: 'truncated_video' }],
                '/movies/huge-duration-metadata.mkv',
            );
            await sql`UPDATE media_files SET health_issues = jsonb_build_array(jsonb_build_object(
                'type', 'truncated_video', 'detail', 'still actionable',
                'expected_duration', 1e400::numeric, 'actual_duration', repeat('9', 400)))
                WHERE file_path = '/movies/huge-duration-metadata.mkv'`;

            const parsed = parseAtEndpointSeam((await getMediaPreview(sql, id))!);
            expect(parsed.healthIssues?.[0]?.type).toBe('truncated_video');
            expect(parsed.healthIssues?.[0]?.expectedDuration).toBeUndefined();
            expect(parsed.healthIssues?.[0]?.actualDuration).toBeUndefined();
            const row = (await listAdminMediaItems(sql, movieList)).find(
                (entry) => entry.id === id,
            );
            expect(row?.health_issue_types).toEqual(['truncated_video']);
            expect(row?.health_issue_details[0]?.expected_duration).toBeNull();
            expect(row?.health_issue_details[0]?.actual_duration).toBeNull();
        });

        it('caps descendant findings across files and reports the remaining count', async () => {
            const album = createTestMediaItem({
                media_type: 'album',
                title: 'Large album',
                has_files: true,
            });
            await insertTestMediaItem(sql, album);
            for (let n = 0; n < 3; n++) {
                const childId = await seedItemWithHealthIssues(
                    `Track ${n}`,
                    Array.from({ length: 10 }, () => ({ type: 'no_keyframes' })),
                    `/test/bounded-preview/${n}.mkv`,
                );
                await sql`UPDATE media_items SET parent_id = ${album.id}, media_type = 'track' WHERE id = ${childId}`;
            }
            const preview = parseAtEndpointSeam((await getMediaPreview(sql, album.id))!);
            expect(preview.healthIssues).toHaveLength(20);
            expect(preview.healthIssuesOmitted).toBe(10);
            expect(preview.healthIssues?.[0]?.filePath).toBe('/test/bounded-preview/0.mkv');
        });

        it('survives health_issues written as an object instead of an array', async () => {
            // `jsonb_array_elements` raises on a non-array, and a WHERE qual is
            // no defence — the planner may evaluate the LATERAL first. The check
            // therefore lives INSIDE the LATERAL's argument.
            const id = await seedItemWithHealthIssues(
                'Object Not Array',
                { type: 'truncated_video', detail: 'a connector wrote a bare object' },
                '/movies/object-not-array.mkv',
            );

            const preview = await getMediaPreview(sql, id);
            expect(preview).toBeDefined();
            const parsed = parseAtEndpointSeam(preview!);
            expect(parsed.healthIssues?.map((i) => i.type)).toEqual(['unknown_recorded_evidence']);
            // The rest of the panel is unaffected — this is degradation, not loss.
            expect(parsed.id).toBe(id);
            expect(parsed.fileCount).toBe(1);
        });

        it('survives a scalar health_issues on one file without losing the other file’s issue', async () => {
            const id = await seedItemWithHealthIssues(
                'Scalar Plus Good',
                'corrupt',
                '/movies/scalar-plus-good/edition-a.mkv',
            );
            await attachSecondFile(
                id,
                [{ type: 'no_keyframes', detail: 'no keyframes in the first 30s' }],
                '/movies/scalar-plus-good/edition-b.mkv',
            );

            const parsed = parseAtEndpointSeam((await getMediaPreview(sql, id))!);
            const issues = parsed.healthIssues ?? [];
            expect(issues.map((i) => i.type).sort()).toEqual([
                'no_keyframes',
                'unknown_recorded_evidence',
            ]);
            expect(issues.find((i) => i.type === 'no_keyframes')?.filePath).toContain('edition-b');
        });

        it('an empty array yields no issues and no error', async () => {
            const id = await seedItemWithHealthIssues('Empty Array', [], '/movies/empty-array.mkv');
            const parsed = parseAtEndpointSeam((await getMediaPreview(sql, id))!);
            expect(parsed.healthIssues ?? []).toEqual([]);
        });

        // -------------------------------------------------------------------
        // listAdminMediaItems / countAdminMediaItems
        //
        // Far more exposed than the preview: this runs on every page load of the
        // media browser, so one malformed row used to take out the whole page
        // rather than one panel. Each of these asserts that a GOOD row still
        // comes back, which is only possible if the whole statement succeeded.
        // -------------------------------------------------------------------

        it('one non-array health_issues does not take down the whole media browser page', async () => {
            const badId = await seedItemWithHealthIssues(
                'List Object Blob',
                { type: 'truncated_video' },
                '/movies/list-object-blob.mkv',
            );
            const goodId = await seedItemWithHealthIssues(
                'List Good Row',
                [
                    {
                        type: 'truncated_video',
                        detail: 'stops at 12s of a declared 41s',
                        detected_at: '2026-08-27T00:00:00.000Z',
                        expected_duration: 41,
                        actual_duration: 12,
                    },
                ],
                '/movies/list-good-row.mkv',
            );

            const rows = await listAdminMediaItems(sql, movieList);
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(badId);
            expect(ids).toContain(goodId);

            const good = rows.find((r) => r.id === goodId);
            expect(good?.health_issue_types).toContain('truncated_video');
            const detail = good?.health_issue_details.find((d) => d.type === 'truncated_video');
            expect(detail?.detail).toBe('stops at 12s of a declared 41s');
            expect(detail?.file_path).toContain('list-good-row');

            // An unknown stored shape remains visible for operator review.
            const bad = rows.find((r) => r.id === badId);
            expect(bad?.health_issue_types).toEqual(['unknown_recorded_evidence']);
            expect(bad?.health_issue_details.map((d) => d.type)).toEqual([
                'unknown_recorded_evidence',
            ]);
        });

        it('the file-issues filter survives a non-array and still finds the real one', async () => {
            const badId = await seedItemWithHealthIssues(
                'Filter Object Blob',
                { type: 'truncated_video' },
                '/movies/filter-object-blob.mkv',
            );
            const goodId = await seedItemWithHealthIssues(
                'Filter Good Row',
                [{ type: 'container_unreadable', detail: 'invalid EBML at pos 8193' }],
                '/movies/filter-good-row.mkv',
            );

            const rows = await listAdminMediaItems(sql, { ...movieList, fileIssues: true });
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(goodId);
            // Unknown stored evidence remains actionable, with a visible label.
            expect(ids).toContain(badId);

            // The page and its total are one population by construction.
            const total = await countAdminMediaItems(sql, { ...movieList, fileIssues: true });
            expect(total).toBe(rows.length);
        });

        it('a typeless element contributes no null to the list row’s issue types', async () => {
            const id = await seedItemWithHealthIssues(
                'Typeless In List',
                [
                    { detail: 'this element never got a type key' },
                    { type: 'no_keyframes', detail: 'no keyframes in the first 30s' },
                ],
                '/movies/typeless-in-list.mkv',
            );

            const rows = await listAdminMediaItems(sql, movieList);
            const row = rows.find((r) => r.id === id);
            // `health_issue_types` is declared `string[]`; a typeless element
            // used to put a literal null in it, which then rendered as an empty
            // chip in the browser.
            expect(row?.health_issue_types).toEqual(['no_keyframes', 'unknown_recorded_evidence']);
            expect(row?.health_issue_types).not.toContain(null);
            expect(row?.health_issue_details.map((d) => d.type).sort()).toEqual([
                'no_keyframes',
                'unknown_recorded_evidence',
            ]);
        });

        it('a fractional disc_number does not take down the music hierarchy sort', async () => {
            // `jsonb_typeof(...) = 'number'` is true for 1.5, and `'1.5'::int`
            // raises — so the guard was only ever partial. Casting to numeric
            // makes it total for every value the type check admits.
            const track = createTestMediaItem({ media_type: 'track', title: 'Fractional Disc' });
            await insertTestMediaItem(sql, track);
            await sql`
                UPDATE media_items
                   SET has_files = true, custom_metadata = ${sql.json({ disc_number: 1.5 })}
                 WHERE id = ${track.id}::uuid
            `;

            const rows = await listAdminMediaItems(sql, {
                ...movieList,
                types: ['track', 'album', 'artist'],
                sortBy: 'hierarchy',
            });
            expect(rows.map((r) => r.id)).toContain(track.id);
        });
    });
});
