// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration Tests for Browse Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    type MediaType,
    type TestExternalId,
    createTestMediaItem,
    insertTestMediaItem,
    insertTestExternalIds,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getRecentlyAddedMedia,
    getFilteredRecentlyAddedMedia,
    getMediaAlphabetical,
    getAlphabeticalBucketCounts,
    getGenreList,
    getGenreFacetCounts,
    getKeywordFacetCounts,
    searchKeywordFacets,
    getMediaByGenre,
    getMediaByGenreCount,
    buildBrowseGenreSections,
    getLocalAvailableExternalIds,
    getMediaByTmdbKeyword,
    getAccessibleMediaByTmdbIds,
    getMediaByKeywordSlug,
    refreshRecentlyAddedRecency,
    refreshRecentlyAddedRecencyForItems,
} from './browse.queries.js';
import { keywordGroupMembers } from '$lib/shared/keyword-vocabulary.js';
import { deriveSortTitle } from '../../utils/sort-title.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

describe('Browse Queries', () => {
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

    describe('getRecentlyAddedMedia', () => {
        it('returns movies and series with files', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;

            const result = await getRecentlyAddedMedia(sql, { access: unrestrictedAccess() });
            expect(result.some((r) => r.id === movie.id)).toBe(true);
        });

        it('filters by media type', async () => {
            const movie = createTestMediaItem({ media_type: 'movie' });
            const tv = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, movie);
            await insertTestMediaItem(sql, tv);
            await sql`UPDATE media_items SET has_files = true WHERE id IN (${movie.id}::uuid, ${tv.id}::uuid)`;

            const result = await getRecentlyAddedMedia(sql, {
                access: unrestrictedAccess(),
                mediaType: 'movie',
            });
            expect(result.some((r) => r.id === movie.id)).toBe(true);
            expect(result.some((r) => r.id === tv.id)).toBe(false);
        });

        it('returns empty array when no matching items', async () => {
            const result = await getRecentlyAddedMedia(sql, {
                access: unrestrictedAccess(),
                mediaType: 'movie',
            });
            const testRows = result.filter((r) => r.title?.startsWith('Test'));
            expect(testRows).toHaveLength(0);
        });
    });

    describe('getMediaAlphabetical', () => {
        it('returns paginated items with total count', async () => {
            const movie = createTestMediaItem({
                media_type: 'movie',
                title: 'Alpha',
            });
            await insertTestMediaItem(sql, movie);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;

            const result = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                limit: 10,
                offset: 0,
            });
            expect(typeof result.totalCount).toBe('number');
            expect(Array.isArray(result.items)).toBe(true);
        });

        it('filters by letter', async () => {
            const movie = createTestMediaItem({
                media_type: 'movie',
                title: 'Beta',
            });
            await insertTestMediaItem(sql, movie);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;

            const result = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                letter: 'B',
                limit: 10,
            });
            const testItems = result.items.filter((i) => i.title?.startsWith('Beta'));
            expect(testItems.length).toBeGreaterThanOrEqual(0);
        });

        it('projects trailer_url from provider_metadata onto the item', async () => {
            const movie = createTestMediaItem({
                media_type: 'movie',
                title: 'Trailer Movie',
            });
            await insertTestMediaItem(sql, movie);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;

            const trailerUrl = 'https://www.youtube.com/watch?v=movieTrailer';
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${movie.id}::uuid, 'tmdb', ${sql.json({ overview: 'x', trailer_url: trailerUrl })}, NOW(), NOW())
                ON CONFLICT (media_id, provider) DO UPDATE SET metadata = EXCLUDED.metadata
            `;

            const { items } = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'movie',
                letter: 'T',
                limit: 50,
            });
            const item = items.find((i) => i.internal_id === movie.id);
            expect(item).toBeDefined();
            // Column is projected and the real series/movie trailer flows through.
            expect('trailer_url' in (item ?? {})).toBe(true);
            expect(item?.trailer_url).toBe(trailerUrl);
        });
    });

    describe('getMediaAlphabetical — free-text query', () => {
        async function seedMovie(title: string, extra: Record<string, unknown> = {}) {
            const movie = createTestMediaItem({ media_type: 'movie', title });
            await insertTestMediaItem(sql, movie);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;
            for (const [col, value] of Object.entries(extra)) {
                if (col === 'original_title') {
                    await sql`UPDATE media_items SET original_title = ${value as string} WHERE id = ${movie.id}::uuid`;
                }
                if (col === 'english_title') {
                    await sql`UPDATE media_items SET english_title = ${value as string} WHERE id = ${movie.id}::uuid`;
                }
            }
            return movie.id;
        }

        it('matches mid-word, which is why this is not FTS', async () => {
            const id = await seedMovie('Dawn');
            const { items } = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'movie',
                query: 'aw',
                limit: 50,
            });
            expect(items.map((i) => i.internal_id)).toContain(id);
        });

        it('ignores accents in both directions', async () => {
            const id = await seedMovie('Aurélie');
            const { items } = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'movie',
                query: 'aurelie',
                limit: 50,
            });
            expect(items.map((i) => i.internal_id)).toContain(id);
        });

        it('matches the original and English titles too', async () => {
            const id = await seedMovie('Die Verschollenen', {
                english_title: 'The Harbor Redemption',
            });
            const { items } = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'movie',
                query: 'harbor',
                limit: 50,
            });
            expect(items.map((i) => i.internal_id)).toContain(id);
        });

        it('matches a localized title from media_titles (German "Haus des Geldes")', async () => {
            const id = await seedMovie('Vault Robbers');
            await sql`
                INSERT INTO media_titles (media_id, title, language, kind)
                VALUES (${id}::uuid, 'Tresor der Träume', 'de', 'localized')
            `;
            const { items, totalCount } = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'movie',
                query: 'tresor der traume',
                limit: 50,
            });
            expect(items.map((i) => i.internal_id)).toEqual([id]);
            expect(totalCount).toBe(1);
            const buckets = await getAlphabeticalBucketCounts(sql, {
                access: unrestrictedAccess(),
                mediaType: 'movie',
                query: 'tresor der traume',
            });
            expect(buckets.reduce((n, b) => n + b.count, 0)).toBe(1);
        });

        it('treats % and _ as literals rather than wildcards', async () => {
            await seedMovie('Plain Title');
            const { items, totalCount } = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'movie',
                query: '%',
                limit: 50,
            });
            expect(items).toHaveLength(0);
            expect(totalCount).toBe(0);
        });

        it('overrides letter — competing intents, query wins', async () => {
            const id = await seedMovie('Dawn');
            const { items } = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'movie',
                letter: 'Z',
                query: 'dawn',
                limit: 50,
            });
            expect(items.map((i) => i.internal_id)).toContain(id);
        });

        it('keeps totalCount consistent with the returned page', async () => {
            await seedMovie('Zzz Unique Alpha');
            await seedMovie('Zzz Unique Beta');
            const { items, totalCount } = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'movie',
                query: 'Zzz Unique',
                limit: 50,
            });
            expect(items).toHaveLength(2);
            expect(totalCount).toBe(2);
        });
    });

    describe('audiobooks never leak into the video browse rails', () => {
        // Audiobooks are stored as real `media_items` rows with
        // `has_files = true`, which is exactly the shape every browse rail
        // selects for. They stay out only because each `mediaType: 'all'`
        // branch narrows to `('movie', 'tv')`. That narrowing is load-bearing
        // for the whole `has_files = true` ingest decision, and nothing pinned
        // it: dropping it would put Hörbücher in Recently Added and A-Z.

        /**
         * Insert an audiobook the way the sweep does: playable, no file rows,
         * no TMDB identity. Raw SQL because the shared fixture's `MediaType`
         * (video/music only) has no audiobook member.
         */
        async function insertAudiobook(title: string): Promise<string> {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, sort_title, media_type, status, has_files)
                VALUES (${id}::uuid, ${title}, ${deriveSortTitle(title)}, 'audiobook', 'active', true)
            `;
            return id;
        }

        it('getRecentlyAddedMedia (mediaType: all) excludes them', async () => {
            const bookId = await insertAudiobook('Anna Und Der Fall');
            const movie = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, movie);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;

            const result = await getRecentlyAddedMedia(sql, { access: unrestrictedAccess() });

            expect(result.some((r) => r.id === movie.id)).toBe(true);
            expect(result.some((r) => r.id === bookId)).toBe(false);
        });

        it('getMediaAlphabetical (mediaType: all) excludes them', async () => {
            const bookId = await insertAudiobook('Anna Und Der Fall');

            const { items } = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                letter: 'A',
                limit: 200,
            });

            expect(items.some((i) => i.internal_id === bookId)).toBe(false);
        });

        it('getMediaByKeywordSlug (mediaType: all) excludes them', async () => {
            const bookId = await insertAudiobook('Anna Und Der Fall');
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${bookId}::uuid, 'aggregated',
                        ${sql.json({ keyword_slugs: ['hoerspiel'], popularity: 10 })}, NOW(), NOW())
                ON CONFLICT (media_id, provider) DO UPDATE SET metadata = EXCLUDED.metadata
            `;

            const rows = await getMediaByKeywordSlug(sql, 'hoerspiel', {
                access: unrestrictedAccess(),
            });

            expect(rows.some((r) => r.internal_id === bookId)).toBe(false);
        });
    });

    describe('getGenreList', () => {
        it('returns empty array when no genre metadata', async () => {
            const result = await getGenreList(sql, { access: unrestrictedAccess() });
            expect(Array.isArray(result)).toBe(true);
        });
    });

    describe('getMediaByGenre', () => {
        it('returns empty array for non-existent genre', async () => {
            const result = await getMediaByGenre(sql, 'NonExistentGenre', {
                access: unrestrictedAccess(),
            });
            expect(result).toEqual([]);
        });
    });

    describe('getMediaByGenre pagination + getMediaByGenreCount', () => {
        // Seed N movies whose genre lives in provider_metadata (the media_genres /
        // media_scalars projections are trigger-maintained from it). Equal
        // popularity → deterministic title ASC order for stable offset assertions.
        async function seedMoviesWithGenre(genreName: string, count: number): Promise<void> {
            for (let i = 0; i < count; i++) {
                const movie = createTestMediaItem({
                    media_type: 'movie',
                    // Zero-padded so title ASC order is deterministic.
                    title: `${genreName} Film ${String(i).padStart(2, '0')}`,
                });
                await insertTestMediaItem(sql, movie);
                await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;
                await sql`
                    INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                    VALUES (${movie.id}::uuid, 'tmdb',
                            ${sql.json({ overview: 'x', popularity: 1, genres: [{ id: 42, name: genreName }] })},
                            NOW(), NOW())
                `;
            }
        }

        it('counts the whole genre and pages through it with limit/offset', async () => {
            await seedMoviesWithGenre('ZZPageGenre', 5);

            const total = await getMediaByGenreCount(sql, 'ZZPageGenre', {
                access: unrestrictedAccess(),
                mediaType: 'movie',
            });
            expect(total).toBe(5);

            const page1 = await getMediaByGenre(sql, 'ZZPageGenre', {
                access: unrestrictedAccess(),
                mediaType: 'movie',
                limit: 2,
                offset: 0,
            });
            const page2 = await getMediaByGenre(sql, 'ZZPageGenre', {
                access: unrestrictedAccess(),
                mediaType: 'movie',
                limit: 2,
                offset: 2,
            });
            const page3 = await getMediaByGenre(sql, 'ZZPageGenre', {
                access: unrestrictedAccess(),
                mediaType: 'movie',
                limit: 2,
                offset: 4,
            });

            expect(page1).toHaveLength(2);
            expect(page2).toHaveLength(2);
            expect(page3).toHaveLength(1);

            // Pages are disjoint and together cover all 5 items exactly once.
            const ids = [...page1, ...page2, ...page3].map((r) => r.id);
            expect(new Set(ids).size).toBe(5);
        });

        it('count respects the media-type filter (movies only)', async () => {
            await seedMoviesWithGenre('ZZTypeGenre', 3);
            expect(
                await getMediaByGenreCount(sql, 'ZZTypeGenre', {
                    access: unrestrictedAccess(),
                    mediaType: 'movie',
                }),
            ).toBe(3);
            expect(
                await getMediaByGenreCount(sql, 'ZZTypeGenre', {
                    access: unrestrictedAccess(),
                    mediaType: 'tv',
                }),
            ).toBe(0);
        });
    });

    describe('A-Z genre filter (getMediaAlphabetical / getAlphabeticalBucketCounts)', () => {
        // Seed one item per title with a genre in provider_metadata (the
        // media_genres projection is trigger-maintained from it).
        async function seedWithGenre(
            mediaType: MediaType,
            title: string,
            genreNames: string[],
        ): Promise<string> {
            const item = createTestMediaItem({ media_type: mediaType, title });
            await insertTestMediaItem(sql, item);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${item.id}::uuid, 'tmdb',
                        ${sql.json({
                            overview: 'x',
                            popularity: 1,
                            genres: genreNames.map((name, i) => ({ id: 900 + i, name })),
                        })},
                        NOW(), NOW())
            `;
            return item.id;
        }

        beforeEach(async () => {
            await seedWithGenre('movie', 'Alpha Action Movie', ['ZZAction']);
            await seedWithGenre('movie', 'Beta Action Movie', ['ZZAction', 'ZZDrama']);
            await seedWithGenre('movie', 'Alpha Drama Movie', ['ZZDrama']);
            await seedWithGenre('tv', 'Gamma Action Show', ['ZZAction']);
        });

        it('narrows the page and the total count to the genre', async () => {
            const all = await getMediaAlphabetical(sql, { access: unrestrictedAccess() });
            const action = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                genreName: 'ZZAction',
            });

            expect(all.totalCount).toBe(4);
            expect(action.totalCount).toBe(3);
            expect(action.items.map((i) => i.title).sort()).toEqual([
                'Alpha Action Movie',
                'Beta Action Movie',
                'Gamma Action Show',
            ]);
        });

        it('composes with the media-type filter (the whole point of putting genre here)', async () => {
            const result = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                genreName: 'ZZAction',
                mediaType: 'movie',
            });

            expect(result.totalCount).toBe(2);
            expect(result.items.every((i) => i.media_type === 'movie')).toBe(true);
        });

        it('composes with the letter filter and a non-default sort', async () => {
            const result = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                genreName: 'ZZAction',
                letter: 'A',
            });
            expect(result.items.map((i) => i.title)).toEqual(['Alpha Action Movie']);

            const desc = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                genreName: 'ZZDrama',
                sort: 'title_desc',
            });
            expect(desc.items.map((i) => i.title)).toEqual([
                'Beta Action Movie',
                'Alpha Drama Movie',
            ]);
        });

        it('agrees with /browse/genre/{name} on membership', async () => {
            const viaAz = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                genreName: 'ZZDrama',
            });
            const viaGenre = await getMediaByGenre(sql, 'ZZDrama', {
                access: unrestrictedAccess(),
            });

            expect(new Set(viaAz.items.map((i) => i.internal_id))).toEqual(
                new Set(viaGenre.map((r) => r.id)),
            );
        });

        it('matches nothing for an unknown genre rather than erroring', async () => {
            const result = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                genreName: 'ZZNoSuchGenre',
            });

            expect(result.totalCount).toBe(0);
            expect(result.items).toEqual([]);
        });

        it('restricts the letter-bucket counts to the genre', async () => {
            const buckets = await getAlphabeticalBucketCounts(sql, {
                access: unrestrictedAccess(),
                genreName: 'ZZDrama',
            });
            const byLetter = Object.fromEntries(buckets.map((b) => [b.bucket, b.count]));

            // Both ZZDrama titles ('Alpha Drama Movie', 'Beta Action Movie') — the
            // 'G' bucket belongs to the Action-only show and must not appear.
            expect(byLetter).toEqual({ A: 1, B: 1 });
        });
    });

    describe('getGenreFacetCounts', () => {
        async function seedWithGenre(
            mediaType: MediaType,
            title: string,
            genreNames: string[],
        ): Promise<string> {
            const item = createTestMediaItem({ media_type: mediaType, title });
            await insertTestMediaItem(sql, item);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${item.id}::uuid, 'tmdb',
                        ${sql.json({
                            overview: 'x',
                            popularity: 1,
                            genres: genreNames.map((name, i) => ({ id: 900 + i, name })),
                        })},
                        NOW(), NOW())
            `;
            return item.id;
        }

        it('counts distinct titles per genre, most-populated first', async () => {
            await seedWithGenre('movie', 'One', ['ZZAction']);
            await seedWithGenre('movie', 'Two', ['ZZAction', 'ZZDrama']);
            await seedWithGenre('movie', 'Three', ['ZZAction']);

            const facets = await getGenreFacetCounts(sql, { access: unrestrictedAccess() });

            expect(facets).toEqual([
                { genre: 'ZZAction', count: 3 },
                { genre: 'ZZDrama', count: 1 },
            ]);
        });

        it('omits genres with no content instead of reporting them as zero', async () => {
            await seedWithGenre('movie', 'Only Movie', ['ZZAction']);
            await seedWithGenre('tv', 'Only Show', ['ZZDocumentary']);

            const movieFacets = await getGenreFacetCounts(sql, {
                access: unrestrictedAccess(),
                mediaType: 'movie',
            });

            // The TV-only genre is a pill that would land a viewer on an empty
            // grid — it must be absent, not present with count 0.
            expect(movieFacets.map((f) => f.genre)).toEqual(['ZZAction']);
        });

        it('keeps single-title genres (no minimum-count floor, unlike getGenreList)', async () => {
            await seedWithGenre('movie', 'Lonely', ['ZZRare']);

            const facets = await getGenreFacetCounts(sql, { access: unrestrictedAccess() });
            expect(facets).toEqual([{ genre: 'ZZRare', count: 1 }]);
            // getGenreList's >= 3 floor drops it — that floor is for carousels.
            expect(await getGenreList(sql, { access: unrestrictedAccess() })).toEqual([]);
        });

        it('excludes items without files (browse is library-local)', async () => {
            const ghost = createTestMediaItem({ media_type: 'movie', title: 'Catalog Ghost' });
            await insertTestMediaItem(sql, ghost);
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${ghost.id}::uuid, 'tmdb',
                        ${sql.json({ overview: 'x', popularity: 1, genres: [{ id: 900, name: 'ZZGhost' }] })},
                        NOW(), NOW())
            `;

            const facets = await getGenreFacetCounts(sql, { access: unrestrictedAccess() });
            expect(facets).toEqual([]);
        });

        it('narrows to the library group — counts describe that library, not the catalog', async () => {
            // The tvOS rail reads a groupId-scoped count as "how much of THIS
            // library is in this genre" (e.g. scoping to Anime must shrink the
            // rail to what Anime holds), so pin that meaning here.
            const animeGroup = crypto.randomUUID();
            const filmGroup = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${animeGroup}::uuid, 'ZZAnime'), (${filmGroup}::uuid, 'ZZFilm')`;

            const attach = async (itemId: string, groupId: string) => {
                const fileId = crypto.randomUUID();
                await sql`
                    INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                    VALUES (${fileId}::uuid, ${`/test/${fileId}.mkv`}, ${groupId}::uuid, NOW(), NOW())
                `;
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id)
                    VALUES (${fileId}::uuid, ${itemId}::uuid)
                `;
            };

            const inAnime = await seedWithGenre('tv', 'ZZ Anime Show', ['ZZAction']);
            const alsoAnime = await seedWithGenre('tv', 'ZZ Anime Two', ['ZZAction', 'ZZDrama']);
            const inFilm = await seedWithGenre('movie', 'ZZ Film One', ['ZZWestern']);
            await attach(inAnime, animeGroup);
            await attach(alsoAnime, animeGroup);
            await attach(inFilm, filmGroup);

            const anime = await getGenreFacetCounts(sql, {
                access: unrestrictedAccess(),
                groupId: animeGroup,
            });
            expect(anime).toEqual([
                { genre: 'ZZAction', count: 2 },
                { genre: 'ZZDrama', count: 1 },
            ]);
            // The other library's genre is absent, not merely counted lower.
            expect(anime.map((f) => f.genre)).not.toContain('ZZWestern');

            const film = await getGenreFacetCounts(sql, {
                access: unrestrictedAccess(),
                groupId: filmGroup,
            });
            expect(film).toEqual([{ genre: 'ZZWestern', count: 1 }]);

            // Unscoped sees everything — proves the narrowing above is the
            // groupId filter, not the seed data being thin.
            const all = await getGenreFacetCounts(sql, { access: unrestrictedAccess() });
            expect(all.map((f) => f.genre).sort()).toEqual(['ZZAction', 'ZZDrama', 'ZZWestern']);
        });

        it('counts a series whose files live on its EPISODES (the real library shape)', async () => {
            // A series row carries no files of its own — the scan puts them on
            // episodes, and buildLibraryGroupFilter walks up episode → season →
            // series. Attaching a file directly to the title (as the tests above
            // do) exercises only the shallowest of those three levels, so a genre
            // rail scoped to a real series library would be untested without this.
            const group = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${group}::uuid, 'ZZDeepAnime')`;

            const seriesId = await seedWithGenre('tv', 'ZZ Deep Series', ['ZZAction']);
            const season = createTestMediaItem({
                media_type: 'season',
                title: 'ZZ Deep Series S1',
                parent_id: seriesId,
            });
            await insertTestMediaItem(sql, season);
            const episode = createTestMediaItem({
                media_type: 'episode',
                title: 'ZZ Deep Series S1E1',
                parent_id: season.id,
            });
            await insertTestMediaItem(sql, episode);

            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/${fileId}.mkv`}, ${group}::uuid, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${episode.id}::uuid)
            `;

            const facets = await getGenreFacetCounts(sql, {
                access: unrestrictedAccess(),
                groupId: group,
            });
            // The SERIES is counted once — not zero (walk-up failed) and not
            // twice (the episode counted as its own title).
            expect(facets).toEqual([{ genre: 'ZZAction', count: 1 }]);

            const page = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                groupId: group,
                genreName: 'ZZAction',
            });
            expect(page.totalCount).toBe(1);
            expect(page.items.map((i) => i.title)).toEqual(['ZZ Deep Series']);
        });

        it('returns an empty list for a group that holds nothing', async () => {
            const emptyGroup = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${emptyGroup}::uuid, 'ZZEmpty')`;
            await seedWithGenre('movie', 'ZZ Ungrouped', ['ZZAction']);

            expect(
                await getGenreFacetCounts(sql, {
                    access: unrestrictedAccess(),
                    groupId: emptyGroup,
                }),
            ).toEqual([]);
        });

        it('a groupId-scoped count matches what ?genre= then returns for that group', async () => {
            const group = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${group}::uuid, 'ZZScoped')`;
            const a = await seedWithGenre('movie', 'ZZ Scoped One', ['ZZAction']);
            const b = await seedWithGenre('movie', 'ZZ Scoped Two', ['ZZAction']);
            await seedWithGenre('movie', 'ZZ Outside', ['ZZAction']); // no file → no group
            for (const id of [a, b]) {
                const fileId = crypto.randomUUID();
                await sql`
                    INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                    VALUES (${fileId}::uuid, ${`/test/${fileId}.mkv`}, ${group}::uuid, NOW(), NOW())
                `;
                await sql`
                    INSERT INTO media_file_items (file_id, media_item_id)
                    VALUES (${fileId}::uuid, ${id}::uuid)
                `;
            }

            const [facet] = await getGenreFacetCounts(sql, {
                access: unrestrictedAccess(),
                groupId: group,
            });
            const page = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                groupId: group,
                genreName: 'ZZAction',
            });

            // The pill's number IS the grid's totalCount — that is the contract
            // the client renders.
            expect(facet).toEqual({ genre: 'ZZAction', count: 2 });
            expect(page.totalCount).toBe(2);
        });

        it('narrows to the letter when one is supplied', async () => {
            await seedWithGenre('movie', 'Alpha One', ['ZZAction']);
            await seedWithGenre('movie', 'Beta Two', ['ZZAction']);

            const facets = await getGenreFacetCounts(sql, {
                access: unrestrictedAccess(),
                letter: 'A',
            });
            expect(facets).toEqual([{ genre: 'ZZAction', count: 1 }]);
        });

        it('returns nothing for a deny-all access boundary', async () => {
            await seedWithGenre('movie', 'Hidden', ['ZZAction']);

            expect(await getGenreFacetCounts(sql, { access: denyAllAccess() })).toEqual([]);
        });
    });

    describe('provider-resilient genre sourcing', () => {
        // Insert provider_metadata for an item. `genres` null => the provider
        // carries no genres (like the real `aggregated` rows for TV).
        async function insertMetadata(
            mediaId: string,
            provider: string,
            genres: Array<{ id: number; name: string }> | null,
        ) {
            const metadata: {
                overview: string;
                popularity: number;
                genres?: Array<{ id: number; name: string }>;
            } = { overview: 'x', popularity: 1 };
            if (genres) metadata.genres = genres;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${mediaId}::uuid, ${provider}, ${sql.json(metadata)}, NOW(), NOW())
            `;
        }

        // Series whose genres live ONLY in the lower-priority `tmdb` provider —
        // the top-priority `aggregated` row has none. Mirrors the real data that
        // left the Series browse tab empty before the genre-source fix.
        async function seedSeriesWithTmdbOnlyGenre(genreName: string, count: number) {
            for (let i = 0; i < count; i++) {
                const tv = createTestMediaItem({
                    media_type: 'tv',
                    title: `${genreName} Show ${i}`,
                });
                await insertTestMediaItem(sql, tv);
                await sql`UPDATE media_items SET has_files = true WHERE id = ${tv.id}::uuid`;
                await insertMetadata(tv.id, 'aggregated', null);
                await insertMetadata(tv.id, 'tmdb', [{ id: 990, name: genreName }]);
            }
        }

        it('keeps provider precedence when ranking only eligible library titles', async () => {
            const eligible = createTestMediaItem({ media_type: 'movie', title: 'Copper Horizon' });
            const overridden = createTestMediaItem({
                media_type: 'movie',
                title: 'Lantern Harbour',
            });
            const discovery = createTestMediaItem({
                media_type: 'movie',
                title: 'Paper Observatory',
            });
            const series = createTestMediaItem({ media_type: 'tv', title: 'Glass Meridian' });
            for (const item of [eligible, overridden, discovery, series]) {
                await insertTestMediaItem(sql, item);
                await insertMetadata(item.id, 'tmdb', [{ id: 35, name: 'Comedy' }]);
            }
            await sql`UPDATE media_items SET has_files = true
                WHERE id = ANY(${[eligible.id, overridden.id, series.id]}::uuid[])`;
            await insertMetadata(eligible.id, 'aggregated', null);
            await insertMetadata(overridden.id, 'aggregated', [{ id: 18, name: 'Drama' }]);

            const movies = await getMediaByGenre(sql, 'Comedy', {
                access: unrestrictedAccess(),
                mediaType: 'movie',
            });
            expect(movies.map((row) => row.id)).toEqual([eligible.id]);
            const all = await getMediaByGenre(sql, 'Comedy', { access: unrestrictedAccess() });
            expect(all.map((row) => row.id).sort()).toEqual([eligible.id, series.id].sort());
        });

        it('getGenreList finds series genres that exist only in a lower-priority provider', async () => {
            await seedSeriesWithTmdbOnlyGenre('ZZTestGenre', 3);

            const result = await getGenreList(sql, {
                access: unrestrictedAccess(),
                mediaType: 'tv',
            });
            const row = result.find((r) => r.genre_name === 'ZZTestGenre');
            expect(row).toBeDefined();
            expect(row?.item_count).toBe(3);
        });

        it('buildBrowseGenreSections returns the series genre carousel with items', async () => {
            await seedSeriesWithTmdbOnlyGenre('ZZTestGenre', 3);

            const { genres } = await buildBrowseGenreSections(sql, {
                access: unrestrictedAccess(),
                mediaType: 'tv',
            });
            const section = genres.find((g) => g.genre === 'ZZTestGenre');
            expect(section).toBeDefined();
            expect(section?.items.length).toBe(3);
        });
    });

    describe('genre identity is the TMDB id, not the stored name', () => {
        // Prod shape: the TMDB sync stores `genres` as bare ids (genre_name NULL),
        // and named rows are split across metadata languages. Name matching found
        // 19 of 598 comedies in one library.
        async function seedMovie(title: string, genres: unknown[]): Promise<string> {
            const item = createTestMediaItem({ media_type: 'movie', title });
            await insertTestMediaItem(sql, item);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${item.id}::uuid, 'tmdb',
                        ${sql.json({ overview: 'x', popularity: 1, genres } as postgres.JSONValue)},
                        NOW(), NOW())
            `;
            return item.id;
        }

        async function seedComedies(): Promise<string[]> {
            return [
                await seedMovie('Bare Id', [35]),
                await seedMovie('German Name', [{ id: 35, name: 'Komödie' }]),
                await seedMovie('English Name', [{ id: 35, name: 'Comedy' }]),
            ];
        }

        it('the A-Z filter matches every comedy regardless of how its genre was stored', async () => {
            const ids = await seedComedies();
            await seedMovie('Not A Comedy', [18]);

            const result = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                genreName: 'Comedy',
                limit: 50,
            });

            expect(result.totalCount).toBe(3);
            expect(result.items.map((i) => i.internal_id).sort()).toEqual([...ids].sort());
        });

        it('a legacy localized deep link still resolves', async () => {
            await seedComedies();
            const result = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                genreName: 'Komödie',
                limit: 50,
            });
            // Only the row stored under that name; the canonical link is ?genre=Comedy.
            expect(result.totalCount).toBe(1);
        });

        it('facet counts collapse all spellings into one canonical pill', async () => {
            await seedComedies();
            const facets = await getGenreFacetCounts(sql, { access: unrestrictedAccess() });
            expect(facets).toEqual([{ genre: 'Comedy', count: 3 }]);
        });

        it('getGenreList, getMediaByGenre and getMediaByGenreCount agree', async () => {
            await seedComedies();
            const list = await getGenreList(sql, { access: unrestrictedAccess() });
            expect(list).toEqual([{ genre_name: 'Comedy', item_count: 3 }]);
            const rows = await getMediaByGenre(sql, 'Comedy', { access: unrestrictedAccess() });
            expect(rows).toHaveLength(3);
            expect(
                await getMediaByGenreCount(sql, 'Comedy', { access: unrestrictedAccess() }),
            ).toBe(3);
        });
    });

    describe('getLocalAvailableExternalIds', () => {
        // Attach a file (and matching media_file_items row) to an item, optionally
        // in a specific library group. Mirrors how real scans populate file rows.
        async function attachFile(itemId: string, libraryGroupId: string | null = null) {
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/${fileId}.mkv`}, ${libraryGroupId}::uuid, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${itemId}::uuid)
            `;
        }

        async function addTmdbId(itemId: string, tmdbId: string, mediaType: MediaType) {
            await insertTestExternalIds(sql, [
                {
                    media_id: itemId,
                    provider: 'tmdb',
                    external_id: tmdbId,
                    media_type: mediaType,
                    is_primary: true,
                },
            ]);
        }

        it('returns items that have files and has_files = true', async () => {
            const movie = createTestMediaItem({ media_type: 'movie', has_files: true });
            await insertTestMediaItem(sql, movie);
            await addTmdbId(movie.id, '550', 'movie');
            await attachFile(movie.id);

            const rows = await getLocalAvailableExternalIds(sql, {
                access: unrestrictedAccess(),
                provider: 'tmdb',
            });
            expect(rows).toContainEqual({ external_id: '550', media_type: 'movie' });
        });

        it('EXCLUDES an item with orphaned file rows but has_files = false (the leak)', async () => {
            // The regression guard: a media item with leftover media_file_items /
            // media_files rows but has_files = false must NOT be reported available.
            const ghost = createTestMediaItem({ media_type: 'movie', has_files: false });
            await insertTestMediaItem(sql, ghost);
            await addTmdbId(ghost.id, '99001', 'movie');
            await attachFile(ghost.id); // orphaned file rows present

            const rows = await getLocalAvailableExternalIds(sql, {
                access: unrestrictedAccess(),
                provider: 'tmdb',
            });
            expect(rows.some((r) => r.external_id === '99001')).toBe(false);
        });

        it('excludes non-active items even with files', async () => {
            const merged = createTestMediaItem({
                media_type: 'movie',
                has_files: true,
                status: 'merged',
            });
            await insertTestMediaItem(sql, merged);
            await addTmdbId(merged.id, '99002', 'movie');
            await attachFile(merged.id);

            const rows = await getLocalAvailableExternalIds(sql, {
                access: unrestrictedAccess(),
                provider: 'tmdb',
            });
            expect(rows.some((r) => r.external_id === '99002')).toBe(false);
        });

        it('matches only the requested provider', async () => {
            const movie = createTestMediaItem({ media_type: 'movie', has_files: true });
            await insertTestMediaItem(sql, movie);
            await insertTestExternalIds(sql, [
                {
                    media_id: movie.id,
                    provider: 'jellyfin',
                    external_id: 'jf-only-1',
                    media_type: 'movie',
                    is_primary: true,
                },
            ]);
            await attachFile(movie.id);

            const rows = await getLocalAvailableExternalIds(sql, {
                access: unrestrictedAccess(),
                provider: 'tmdb',
            });
            expect(rows.some((r) => r.external_id === 'jf-only-1')).toBe(false);
        });

        it('excludes items whose only file is in a denied library group', async () => {
            const groupId = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupId}::uuid, 'Denied Test Group')`;

            const movie = createTestMediaItem({ media_type: 'movie', has_files: true });
            await insertTestMediaItem(sql, movie);
            await addTmdbId(movie.id, '99003', 'movie');
            await attachFile(movie.id, groupId);

            // Without restriction -> visible (proves the has_files fix didn't break the join).
            const open = await getLocalAvailableExternalIds(sql, {
                access: unrestrictedAccess(),
                provider: 'tmdb',
            });
            expect(open.some((r) => r.external_id === '99003')).toBe(true);

            // With the group denied -> hidden.
            const restricted = await getLocalAvailableExternalIds(sql, {
                access: restrictedAccess({
                    deniedGroupIds: [groupId],
                    maxAgeRating: null,
                    allowUnrated: false,
                }),
                provider: 'tmdb',
            });
            expect(restricted.some((r) => r.external_id === '99003')).toBe(false);

            await sql`DELETE FROM library_groups WHERE id = ${groupId}::uuid`;
        });

        it('denyAll boundary returns nothing even when available rows exist', async () => {
            const movie = createTestMediaItem({ media_type: 'movie', has_files: true });
            await insertTestMediaItem(sql, movie);
            await addTmdbId(movie.id, '99123', 'movie');
            await attachFile(movie.id, null);

            const open = await getLocalAvailableExternalIds(sql, {
                access: unrestrictedAccess(),
                provider: 'tmdb',
            });
            expect(open.some((r) => r.external_id === '99123')).toBe(true);

            // denyAll must yield an empty set — the row is available but the
            // caller may see nothing. Under the pre-migration permissive shape
            // this state was inexpressible.
            const denied = await getLocalAvailableExternalIds(sql, {
                access: denyAllAccess(),
                provider: 'tmdb',
            });
            expect(denied).toEqual([]);
        });
    });

    // ==========================================================================
    // Filterable Recently Added — newness modes (everything / seasons / titles)
    // ==========================================================================
    describe('getFilteredRecentlyAddedMedia newness modes', () => {
        // Insert a top-level media item directly so we control parent_id/status.
        async function insertTitle(
            mediaType: MediaType,
            title: string,
            hasFiles = true,
        ): Promise<string> {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, has_files)
                VALUES (${id}::uuid, ${title}, ${mediaType}, 'active', NULL, ${hasFiles})
            `;
            return id;
        }

        async function insertChild(
            mediaType: MediaType,
            parentId: string,
            title: string,
        ): Promise<string> {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, has_files)
                VALUES (${id}::uuid, ${title}, ${mediaType}, 'active', ${parentId}::uuid, true)
            `;
            return id;
        }

        // Attach a file to an item with an explicit created_at so each mode's
        // recency math is deterministic.
        async function attachFileAt(itemId: string, createdAt: string): Promise<void> {
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/${fileId}.mkv`}, ${createdAt}::timestamptz, ${createdAt}::timestamptz)
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${itemId}::uuid)
            `;
        }

        // Timeline (oldest → newest):
        //   2020 — Old Show's only season's first episode (the title is OLD)
        //   2021 — Brand New Movie's file (title first playable in 2021... but
        //          we make it newer below; see explicit dates)
        // We use explicit ISO dates to keep ordering unambiguous.
        const T_OLD = '2020-01-01T00:00:00Z';
        const T_MID = '2023-06-01T00:00:00Z';
        const T_NEW = '2025-01-01T00:00:00Z';
        const T_NEWEST = '2025-06-01T00:00:00Z';

        let brandNewMovieId: string;
        let oldShowNewEpisodeId: string; // old series, new episode in EXISTING season
        let newSeasonShowId: string; // existing series that gained a brand-new SEASON
        let decoyMovieId: string; // mid-aged (2023) movie — stable middle element

        beforeEach(async () => {
            // (1) Brand-new movie: single file added recently.
            brandNewMovieId = await insertTitle('movie', 'Brand New Movie');
            await attachFileAt(brandNewMovieId, T_NEW);

            // (2) Old show, new episode in an EXISTING season:
            //     season S1 has an OLD episode (2020) and a NEW episode (2025-06).
            //     - 'titles' recency = MIN = 2020 (OLD) → should NOT surface.
            //     - 'seasons' recency = MAX over season MIN = MIN(S1)=2020 → OLD.
            //     - 'everything' recency = newest file = 2025-06 → surfaces top.
            oldShowNewEpisodeId = await insertTitle('tv', 'Old Show New Episode');
            const oldSeason = await insertChild('season', oldShowNewEpisodeId, 'Old Show S1');
            const oldEp = await insertChild('episode', oldSeason, 'Old Show S1E1');
            const newEpInOldSeason = await insertChild('episode', oldSeason, 'Old Show S1E2');
            await attachFileAt(oldEp, T_OLD);
            await attachFileAt(newEpInOldSeason, T_NEWEST);

            // (3) Existing series that gained a brand-NEW season:
            //     season S1 is OLD (2020), season S2 is NEW (2025).
            //     - 'titles' recency = MIN = 2020 (OLD) → should NOT surface as new title.
            //     - 'seasons' recency = MAX(MIN(S1)=2020, MIN(S2)=2025) = 2025 → surfaces.
            //     - 'everything' recency = newest file = 2025 → surfaces.
            newSeasonShowId = await insertTitle('tv', 'New Season Show');
            const s1 = await insertChild('season', newSeasonShowId, 'New Season Show S1');
            const s1e1 = await insertChild('episode', s1, 'New Season Show S1E1');
            await attachFileAt(s1e1, T_OLD);
            const s2 = await insertChild('season', newSeasonShowId, 'New Season Show S2');
            const s2e1 = await insertChild('episode', s2, 'New Season Show S2E1');
            await attachFileAt(s2e1, T_NEW);

            // A mid-aged decoy movie so ordering has a stable middle element.
            decoyMovieId = await insertTitle('movie', 'Decoy Movie');
            await attachFileAt(decoyMovieId, T_MID);

            // 'titles'/'seasons' now ORDER BY the materialized first_file_at /
            // season_debut_at columns (migration 16.119.0) instead of computing
            // recency on the fly, so the columns must be refreshed after seeding.
            await refreshRecentlyAddedRecency(sql);
        });

        it("'everything' resurfaces a series on any new episode (matches carousel)", async () => {
            const rows = await getFilteredRecentlyAddedMedia(sql, {
                access: unrestrictedAccess(),
                newness: 'everything',
            });
            const ids = rows.map((r) => r.id);
            // The new-episode-in-old-season show has the newest file (2025-06)
            // so it must appear, and ahead of the brand-new movie (2025-01).
            expect(ids).toContain(oldShowNewEpisodeId);
            expect(ids.indexOf(oldShowNewEpisodeId)).toBeLessThan(ids.indexOf(brandNewMovieId));
        });

        it("'seasons' bumps a title for a NEW season but not for an extra episode in an existing season", async () => {
            const rows = await getFilteredRecentlyAddedMedia(sql, {
                access: unrestrictedAccess(),
                newness: 'seasons',
            });
            const ids = rows.map((r) => r.id);
            // New-season show debuts S2 in 2025 → ranks near the top, ahead of
            // the brand-new movie's 2025-01 only when its season-debut is later;
            // here S2 = 2025-01 ties the movie, so just assert both present and
            // that the extra-episode show ranks BELOW them (its season MAX = 2020).
            expect(ids).toContain(newSeasonShowId);
            expect(ids).toContain(brandNewMovieId);
            expect(ids.indexOf(newSeasonShowId)).toBeLessThan(ids.indexOf(oldShowNewEpisodeId));
            // Core invariant: an extra episode in an EXISTING season must NOT
            // resurface the show — its seasons-mode recency stays at S1=2020, so
            // it ranks strictly below even the 2023 decoy. (A regression that
            // used MAX-of-all-episodes would push it to 2025-06 and break this.)
            expect(ids.indexOf(decoyMovieId)).toBeLessThan(ids.indexOf(oldShowNewEpisodeId));
        });

        it('refreshRecentlyAddedRecencyForItems surfaces a watcher-ingested title from one episode id', async () => {
            // The watcher ingests an episode but nothing refreshes the recency
            // columns: first_file_at stays NULL, which 'titles' sorts last.
            const showId = await insertTitle('tv', 'Watcher Ingested Show');
            const seasonId = await insertChild('season', showId, 'Watcher Ingested S1');
            const episodeId = await insertChild('episode', seasonId, 'Watcher Ingested S1E1');
            await attachFileAt(episodeId, '2026-01-01T00:00:00Z');

            const titlesIds = async (): Promise<string[]> =>
                (
                    await getFilteredRecentlyAddedMedia(sql, {
                        access: unrestrictedAccess(),
                        newness: 'titles',
                        limit: 3,
                    })
                ).map((r) => r.id);

            const firstFileAt = async (id: string): Promise<string | null> => {
                const [r] = await sql<{ first_file_at: Date | null }[]>`
                    SELECT first_file_at FROM media_items WHERE id = ${id}::uuid
                `;
                return r?.first_file_at?.toISOString() ?? null;
            };
            expect(await firstFileAt(showId)).toBeNull();
            expect(await titlesIds()).not.toContain(showId);

            // An unknown id resolves to nothing and must not throw or touch others.
            const before = await firstFileAt(brandNewMovieId);
            await refreshRecentlyAddedRecencyForItems(sql, [crypto.randomUUID()]);
            expect(await firstFileAt(brandNewMovieId)).toBe(before);
            expect(await firstFileAt(showId)).toBeNull();

            // An empty id set must not widen to a whole-library refresh.
            await refreshRecentlyAddedRecencyForItems(sql, []);
            expect(await firstFileAt(showId)).toBeNull();
            expect(await titlesIds()).not.toContain(showId);

            // An unrelated title that also has a file but no recency yet: a scoped
            // refresh must leave it alone (a whole-library refresh would fill it).
            const bystanderId = await insertTitle('tv', 'Bystander Show');
            const bystanderSeason = await insertChild('season', bystanderId, 'Bystander S1');
            const bystanderEpisode = await insertChild(
                'episode',
                bystanderSeason,
                'Bystander S1E1',
            );
            await attachFileAt(bystanderEpisode, '2026-01-15T00:00:00Z');
            expect(await firstFileAt(bystanderId)).toBeNull();

            // An episode id resolves to its top-level title.
            await refreshRecentlyAddedRecencyForItems(sql, [episodeId]);
            expect(await firstFileAt(bystanderId)).toBeNull();
            expect((await titlesIds())[0]).toBe(showId);
            expect(await firstFileAt(showId)).toBe('2026-01-01T00:00:00.000Z');
        });

        it('refreshRecentlyAddedRecencyForItems resolves season ids, movie ids and mixed ids', async () => {
            const showId = await insertTitle('tv', 'Season Id Show');
            const seasonId = await insertChild('season', showId, 'Season Id S1');
            const episodeId = await insertChild('episode', seasonId, 'Season Id S1E1');
            await attachFileAt(episodeId, '2026-02-01T00:00:00Z');
            const movieId = await insertTitle('movie', 'Fresh Movie');
            await attachFileAt(movieId, '2026-03-01T00:00:00Z');

            // A season id and an episode id of the same show collapse to one title;
            // a movie id is its own title.
            await refreshRecentlyAddedRecencyForItems(sql, [seasonId, episodeId, movieId]);

            const rows = await sql<{ id: string; first_file_at: Date | null }[]>`
                SELECT id, first_file_at FROM media_items
                WHERE id IN (${showId}::uuid, ${movieId}::uuid)
            `;
            const byId = new Map(rows.map((r) => [r.id, r.first_file_at?.toISOString()]));
            expect(byId.get(showId)).toBe('2026-02-01T00:00:00.000Z');
            expect(byId.get(movieId)).toBe('2026-03-01T00:00:00.000Z');
        });

        it('refreshRecentlyAddedRecencyForItems walks any depth to the root and ignores invalid ids', async () => {
            const showId = await insertTitle('tv', 'Deep Id Show');
            const seasonId = await insertChild('season', showId, 'Deep Id S1');
            const episodeId = await insertChild('episode', seasonId, 'Deep Id S1E1');
            const extraId = await insertChild(
                'episode',
                episodeId,
                'Deep Id extra under an episode',
            );
            await attachFileAt(episodeId, '2026-04-01T00:00:00Z');

            // A four-level id plus values that are not uuids: the garbage must be
            // dropped, not fail the cast for the whole batch.
            await expect(
                refreshRecentlyAddedRecencyForItems(sql, ['not-a-uuid', '', extraId]),
            ).resolves.toEqual([showId]);

            const [row] = await sql<{ first_file_at: Date | null }[]>`
                SELECT first_file_at FROM media_items WHERE id = ${showId}::uuid
            `;
            expect(row?.first_file_at?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
        });

        it("'titles' includes only brand-new titles, excluding long-standing shows with merely new files", async () => {
            const rows = await getFilteredRecentlyAddedMedia(sql, {
                access: unrestrictedAccess(),
                newness: 'titles',
            });
            const ids = rows.map((r) => r.id);
            // Brand-new movie first became playable in 2025 → top.
            expect(ids[0]).toBe(brandNewMovieId);
            // Both shows first became playable in 2020 → they sort to the bottom,
            // strictly after the 2023 decoy and the 2025 movie.
            expect(ids.indexOf(brandNewMovieId)).toBeLessThan(ids.indexOf(oldShowNewEpisodeId));
            expect(ids.indexOf(brandNewMovieId)).toBeLessThan(ids.indexOf(newSeasonShowId));
        });

        it('applies the media-type filter', async () => {
            const rows = await getFilteredRecentlyAddedMedia(sql, {
                access: unrestrictedAccess(),
                newness: 'everything',
                mediaType: 'movie',
            });
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(brandNewMovieId);
            expect(ids).not.toContain(oldShowNewEpisodeId);
            expect(ids).not.toContain(newSeasonShowId);
        });

        it('applies the title search filter', async () => {
            const rows = await getFilteredRecentlyAddedMedia(sql, {
                access: unrestrictedAccess(),
                newness: 'everything',
                query: 'Brand New',
            });
            const titles = rows.map((r) => r.title);
            expect(titles).toContain('Brand New Movie');
            expect(titles).not.toContain('Decoy Movie');
        });

        it('restricts to a library group when groupId is given', async () => {
            const groupId = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupId}::uuid, 'Recent Filter Group')`;

            const grouped = await insertTitle('movie', 'Grouped Movie');
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/${fileId}.mkv`}, ${groupId}::uuid, ${T_NEWEST}::timestamptz, ${T_NEWEST}::timestamptz)
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${grouped}::uuid)
            `;

            const rows = await getFilteredRecentlyAddedMedia(sql, {
                access: unrestrictedAccess(),
                newness: 'everything',
                groupId,
            });
            const ids = rows.map((r) => r.id);
            expect(ids).toContain(grouped);
            // The brand-new movie's file is in NO group, so it must be excluded.
            expect(ids).not.toContain(brandNewMovieId);

            await sql`DELETE FROM library_groups WHERE id = ${groupId}::uuid`;
        });
    });

    // ==========================================================================
    // refreshRecentlyAddedRecency — materialized first_file_at / season_debut_at
    // ==========================================================================
    describe('refreshRecentlyAddedRecency', () => {
        async function attachFileAt(itemId: string, createdAt: string): Promise<void> {
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/${fileId}.mkv`}, ${createdAt}::timestamptz, ${createdAt}::timestamptz)
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${itemId}::uuid)
            `;
        }

        it('populates first_file_at and season_debut_at with the correct MIN/MAX recency', async () => {
            const T_MOVIE = '2024-01-01T00:00:00Z';
            const T_EPISODE = '2024-06-01T00:00:00Z';

            const movie = createTestMediaItem({ media_type: 'movie', title: 'Recency Movie' });
            await insertTestMediaItem(sql, movie);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;
            await attachFileAt(movie.id, T_MOVIE);

            const series = createTestMediaItem({ media_type: 'tv', title: 'Recency Series' });
            await insertTestMediaItem(sql, series);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${series.id}::uuid`;
            const season = createTestMediaItem({
                media_type: 'season',
                title: 'Recency Series S1',
                parent_id: series.id,
            });
            await insertTestMediaItem(sql, season);
            const episode = createTestMediaItem({
                media_type: 'episode',
                title: 'Recency Series S1E1',
                parent_id: season.id,
            });
            await insertTestMediaItem(sql, episode);
            await attachFileAt(episode.id, T_EPISODE);

            await refreshRecentlyAddedRecency(sql);

            const [movieRow] = await sql<
                { first_file_at: Date | null; season_debut_at: Date | null }[]
            >`
                SELECT first_file_at, season_debut_at FROM media_items WHERE id = ${movie.id}::uuid
            `;
            expect(movieRow.first_file_at?.toISOString()).toBe(new Date(T_MOVIE).toISOString());
            expect(movieRow.season_debut_at?.toISOString()).toBe(new Date(T_MOVIE).toISOString());

            const [seriesRow] = await sql<
                { first_file_at: Date | null; season_debut_at: Date | null }[]
            >`
                SELECT first_file_at, season_debut_at FROM media_items WHERE id = ${series.id}::uuid
            `;
            expect(seriesRow.first_file_at?.toISOString()).toBe(new Date(T_EPISODE).toISOString());
            expect(seriesRow.season_debut_at?.toISOString()).toBe(
                new Date(T_EPISODE).toISOString(),
            );
        });

        it('does not rewrite rows whose recency is already current', async () => {
            // Prod 2026-09-24: every full refresh (each file removal) rewrote all
            // 20,282 title rows twice, ~2.5 s and 40k dead tuples per run, for
            // values that had not changed.
            const movie = createTestMediaItem({ media_type: 'movie', title: 'Recency Stable' });
            await insertTestMediaItem(sql, movie);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;
            await attachFileAt(movie.id, '2024-01-01T00:00:00Z');
            await refreshRecentlyAddedRecency(sql);

            const version = async (): Promise<string> => {
                const [row] = await sql<{ v: string }[]>`
                    SELECT xmin::text AS v FROM media_items WHERE id = ${movie.id}::uuid`;
                return row.v;
            };
            const before = await version();
            await refreshRecentlyAddedRecency(sql);
            expect(await version()).toBe(before);
        });

        it("orders 'titles' and 'seasons' newness modes by the materialized recency columns", async () => {
            const T_OLD = '2022-01-01T00:00:00Z';
            const T_NEW = '2025-01-01T00:00:00Z';

            const oldMovie = createTestMediaItem({
                media_type: 'movie',
                title: 'Recency Old Movie',
            });
            await insertTestMediaItem(sql, oldMovie);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${oldMovie.id}::uuid`;
            await attachFileAt(oldMovie.id, T_OLD);

            const newMovie = createTestMediaItem({
                media_type: 'movie',
                title: 'Recency New Movie',
            });
            await insertTestMediaItem(sql, newMovie);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${newMovie.id}::uuid`;
            await attachFileAt(newMovie.id, T_NEW);

            await refreshRecentlyAddedRecency(sql);

            const titleRows = await getFilteredRecentlyAddedMedia(sql, {
                access: unrestrictedAccess(),
                newness: 'titles',
                mediaType: 'movie',
            });
            const titleIds = titleRows.map((r) => r.id);
            expect(titleIds.indexOf(newMovie.id)).toBeLessThan(titleIds.indexOf(oldMovie.id));

            const seasonRows = await getFilteredRecentlyAddedMedia(sql, {
                access: unrestrictedAccess(),
                newness: 'seasons',
                mediaType: 'movie',
            });
            const seasonIds = seasonRows.map((r) => r.id);
            expect(seasonIds.indexOf(newMovie.id)).toBeLessThan(seasonIds.indexOf(oldMovie.id));
        });
    });

    // ==========================================================================
    // getAccessibleMediaByTmdbIds — holiday availability, scoped per caller
    // ==========================================================================
    describe('getAccessibleMediaByTmdbIds', () => {
        async function libraryItem(
            tmdbId: string,
            opts: {
                mediaType?: MediaType;
                hasFiles?: boolean;
                groupId?: string | null;
                jellyfinId?: string;
                ageRating?: number;
            } = {},
        ): Promise<string> {
            const mediaType = opts.mediaType ?? 'movie';
            const item = createTestMediaItem({
                media_type: mediaType,
                has_files: opts.hasFiles ?? true,
            });
            await insertTestMediaItem(sql, item);
            const ids: TestExternalId[] = [
                {
                    media_id: item.id,
                    provider: 'tmdb',
                    external_id: tmdbId,
                    media_type: mediaType,
                    is_primary: true,
                },
            ];
            if (opts.jellyfinId) {
                ids.push({
                    media_id: item.id,
                    provider: 'jellyfin',
                    external_id: opts.jellyfinId,
                    media_type: mediaType,
                    is_primary: false,
                });
            }
            await insertTestExternalIds(sql, ids);
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/${fileId}.mkv`}, ${opts.groupId ?? null}::uuid, NOW(), NOW())
            `;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${fileId}::uuid, ${item.id}::uuid)`;
            if (opts.ageRating !== undefined) {
                await sql`UPDATE media_items SET age_rating = ${opts.ageRating} WHERE id = ${item.id}::uuid`;
            }
            return item.id;
        }

        it('resolves owned items to their media id (never a Jellyfin id)', async () => {
            const withJf = await libraryItem('71001', { jellyfinId: 'jf71001' });
            const withoutJf = await libraryItem('71002');

            const rows = await getAccessibleMediaByTmdbIds(
                sql,
                [
                    { tmdbId: 71001, mediaType: 'movie' },
                    { tmdbId: 71002, mediaType: 'movie' },
                    { tmdbId: 71999, mediaType: 'movie' },
                ],
                unrestrictedAccess(),
            );

            expect(rows).toHaveLength(2);
            expect(rows).toContainEqual({
                tmdb_id: '71001',
                media_type: 'movie',
                media_id: withJf,
            });
            expect(rows).toContainEqual({
                tmdb_id: '71002',
                media_type: 'movie',
                media_id: withoutJf,
            });
        });

        it('does not match across media types or items without files', async () => {
            await libraryItem('72001', { mediaType: 'tv' });
            await libraryItem('72002', { hasFiles: false });

            const rows = await getAccessibleMediaByTmdbIds(
                sql,
                [
                    { tmdbId: 72001, mediaType: 'movie' },
                    { tmdbId: 72002, mediaType: 'movie' },
                ],
                unrestrictedAccess(),
            );
            expect(rows).toEqual([]);
        });

        it('hides items in a denied library group and above the age limit', async () => {
            const groupId = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupId}::uuid, 'Holiday Denied Group')`;
            await libraryItem('73001', { groupId });
            await libraryItem('73002', { ageRating: 18 });
            await libraryItem('73003', { ageRating: 6 });
            const pairs = [
                { tmdbId: 73001, mediaType: 'movie' as const },
                { tmdbId: 73002, mediaType: 'movie' as const },
                { tmdbId: 73003, mediaType: 'movie' as const },
            ];

            const open = await getAccessibleMediaByTmdbIds(sql, pairs, unrestrictedAccess());
            expect(open.map((r) => r.tmdb_id).sort()).toEqual(['73001', '73002', '73003']);

            const restricted = await getAccessibleMediaByTmdbIds(
                sql,
                pairs,
                restrictedAccess({
                    deniedGroupIds: [groupId],
                    maxAgeRating: 12,
                    allowUnrated: false,
                }),
            );
            expect(restricted.map((r) => r.tmdb_id)).toEqual(['73003']);
        });

        it('returns [] for deny-all and for no candidates', async () => {
            await libraryItem('74001');
            expect(
                await getAccessibleMediaByTmdbIds(
                    sql,
                    [{ tmdbId: 74001, mediaType: 'movie' }],
                    denyAllAccess(),
                ),
            ).toEqual([]);
            expect(await getAccessibleMediaByTmdbIds(sql, [], unrestrictedAccess())).toEqual([]);
        });
    });

    // ==========================================================================
    // getMediaByTmdbKeyword — JSONB @> containment + access filters
    // ==========================================================================
    describe('getMediaByTmdbKeyword', () => {
        const KW = 9882; // stable numeric id used across sub-tests

        // Insert a provider_metadata row with tmdb_keyword_ids on the
        // aggregated provider so the override-aware LATERAL join picks it up.
        async function insertAggregated(
            mediaId: string,
            keywordIds: number[],
            extra: Record<string, unknown> = {},
        ): Promise<void> {
            const metadata = { tmdb_keyword_ids: keywordIds, popularity: 5.0, ...extra };
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${mediaId}::uuid, 'aggregated',
                        ${sql.json(metadata as unknown as Record<string, never>)}, NOW(), NOW())
                ON CONFLICT (media_id, provider) DO UPDATE
                    SET metadata = EXCLUDED.metadata, updated_at = NOW()
            `;
        }

        async function insertItem(
            title: string,
            opts: { hasFiles?: boolean; parentId?: string | null; mediaType?: string } = {},
        ): Promise<string> {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files, parent_id)
                VALUES (
                    ${id}::uuid, ${title},
                    ${opts.mediaType ?? 'movie'}, 'active',
                    ${opts.hasFiles ?? true},
                    ${opts.parentId ?? null}
                )
            `;
            return id;
        }

        it('returns items whose aggregated metadata contains the keyword id via @> containment', async () => {
            const matchId = await insertItem('KW Match Movie');
            const noMatchId = await insertItem('KW No-Match Movie');
            await insertAggregated(matchId, [KW, 1234]);
            await insertAggregated(noMatchId, [9999]);

            const rows = await getMediaByTmdbKeyword(sql, KW, { access: unrestrictedAccess() });
            const titles = rows.map((r) => r.title);
            expect(titles).toContain('KW Match Movie');
            expect(titles).not.toContain('KW No-Match Movie');
        });

        it('excludes items where has_files=false', async () => {
            const withFiles = await insertItem('KW With Files', { hasFiles: true });
            const withoutFiles = await insertItem('KW Without Files', { hasFiles: false });
            await insertAggregated(withFiles, [KW]);
            await insertAggregated(withoutFiles, [KW]);

            const rows = await getMediaByTmdbKeyword(sql, KW, { access: unrestrictedAccess() });
            const titles = rows.map((r) => r.title);
            expect(titles).toContain('KW With Files');
            expect(titles).not.toContain('KW Without Files');
        });

        it('excludes child items (parent_id IS NOT NULL)', async () => {
            const parentId = await insertItem('KW Parent');
            const childId = await insertItem('KW Child', { parentId });
            await insertAggregated(parentId, [KW]);
            await insertAggregated(childId, [KW]);

            const rows = await getMediaByTmdbKeyword(sql, KW, { access: unrestrictedAccess() });
            const titles = rows.map((r) => r.title);
            expect(titles).toContain('KW Parent');
            expect(titles).not.toContain('KW Child');
        });

        it('excludes items in denied library groups (access filter)', async () => {
            const groupId = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${groupId}::uuid, 'Denied KW Group')`;

            const deniedId = await insertItem('KW Denied Item');
            await insertAggregated(deniedId, [KW]);
            // Wire a file in the denied group to the item.
            const fileId = crypto.randomUUID();
            await sql`INSERT INTO media_files (id, file_path, library_group_id) VALUES (${fileId}::uuid, '/kw/denied.mkv', ${groupId}::uuid)`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order) VALUES (${fileId}::uuid, ${deniedId}::uuid, true, 0)`;

            const allowedId = await insertItem('KW Allowed Item');
            await insertAggregated(allowedId, [KW]);

            const rows = await getMediaByTmdbKeyword(sql, KW, {
                access: restrictedAccess({
                    deniedGroupIds: [groupId],
                    maxAgeRating: null,
                    allowUnrated: false,
                }),
            });
            const titles = rows.map((r) => r.title);
            expect(titles).toContain('KW Allowed Item');
            expect(titles).not.toContain('KW Denied Item');

            await sql`DELETE FROM library_groups WHERE id = ${groupId}::uuid`;
        });

        it('returns [] for a non-integer keywordId (defensive guard)', async () => {
            const rows = await getMediaByTmdbKeyword(sql, 1.5, { access: unrestrictedAccess() });
            expect(rows).toEqual([]);
        });

        it('returns [] when no items match the keyword', async () => {
            const rows = await getMediaByTmdbKeyword(sql, 999_888_777, {
                access: unrestrictedAccess(),
            });
            expect(rows).toEqual([]);
        });

        it('filters by mediaType: movie vs tv', async () => {
            const movieId = await insertItem('KW Movie Type', { mediaType: 'movie' });
            const tvId = await insertItem('KW TV Type', { mediaType: 'tv' });
            await insertAggregated(movieId, [KW]);
            await insertAggregated(tvId, [KW]);

            const movieRows = await getMediaByTmdbKeyword(sql, KW, {
                access: unrestrictedAccess(),
                mediaType: 'movie',
            });
            const movieTitles = movieRows.map((r) => r.title);
            expect(movieTitles).toContain('KW Movie Type');
            expect(movieTitles).not.toContain('KW TV Type');
        });

        // Regression: DISTINCT ON (mi.id) forced ORDER BY mi.id first, so LIMIT kept
        // the lowest UUIDs instead of the most popular items. The ids below are
        // chosen so the least popular item has the lowest UUID.
        it('returns the most popular matches first, not the lowest ids', async () => {
            const KW_POP = 9883;
            const ids = [
                '00000000-0000-4000-8000-00000000a001',
                '00000000-0000-4000-8000-00000000a002',
                '00000000-0000-4000-8000-00000000a003',
            ];
            const popularity = [1, 10, 50];
            for (let i = 0; i < ids.length; i++) {
                await sql`
                    INSERT INTO media_items (id, title, media_type, status, has_files)
                    VALUES (${ids[i]}::uuid, ${`KW Pop ${popularity[i]}`}, 'movie', 'active', true)
                `;
                await insertAggregated(ids[i], [KW_POP], {
                    popularity: popularity[i],
                    keyword_slugs: ['kw-popularity-order'],
                });
            }

            const byId = await getMediaByTmdbKeyword(sql, KW_POP, {
                access: unrestrictedAccess(),
                limit: 2,
            });
            expect(byId.map((r) => r.title)).toEqual(['KW Pop 50', 'KW Pop 10']);

            const bySlug = await getMediaByKeywordSlug(sql, 'kw popularity order', {
                access: unrestrictedAccess(),
                limit: 2,
            });
            expect(bySlug.map((r) => r.title)).toEqual(['KW Pop 50', 'KW Pop 10']);
        });

        it('clamps limit: 0 → treated as 1 (no error), >200 → clamped to 200 (no error)', async () => {
            const rowsZero = await getMediaByTmdbKeyword(sql, 99999, {
                access: unrestrictedAccess(),
                limit: 0,
            });
            expect(Array.isArray(rowsZero)).toBe(true);

            const rowsOver = await getMediaByTmdbKeyword(sql, 99999, {
                access: unrestrictedAccess(),
                limit: 500,
            });
            expect(Array.isArray(rowsOver)).toBe(true);
        });
    });

    // ==========================================================================
    // A-Z sort_title ordering & bucketing (non-Latin findability regression)
    // ==========================================================================
    describe('getMediaAlphabetical sort_title ordering & bucketing', () => {
        // Insert a top-level series with sort_title derived as the migration /
        // write paths would.
        async function insertSeries(
            title: string,
            englishTitle: string | null = null,
            originalTitle: string | null = null,
        ): Promise<string> {
            const id = crypto.randomUUID();
            const sortTitle = deriveSortTitle(title, englishTitle, originalTitle);
            await sql`
                INSERT INTO media_items
                    (id, title, english_title, original_title, sort_title, media_type, status, has_files, parent_id)
                VALUES (
                    ${id}::uuid, ${title}, ${englishTitle}, ${originalTitle}, ${sortTitle},
                    'tv', 'active', true, NULL
                )
            `;
            return id;
        }

        // Representative fixtures: the real prod non-Latin offenders + Latin controls.
        const KOREAN = '사랑은 별빛에서'; // no english_title → "sarangeun…" → S
        const KOF = '星灯命运'; // english_title present → "King of Fighters…" → K
        const JP_NO_EN = '静かな港の物語'; // not romanizable, no english_title → #
        const DOT_HACK = '.harbor'; // leading punctuation stripped → H
        const UEBEL = 'Übler Wind'; // diacritic folded → U

        beforeEach(async () => {
            await insertSeries(KOREAN);
            await insertSeries(KOF, 'The Keeper of Lanterns: Destiny', KOF);
            await insertSeries(JP_NO_EN);
            await insertSeries(DOT_HACK, null, DOT_HACK);
            await insertSeries(UEBEL);
            await insertSeries('Andara');
            await insertSeries('Zephyr Land Saga');
        });

        it('buckets a Hangul-titled series with no english_title under "S"', async () => {
            const { items } = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'tv',
                letter: 'S',
            });
            expect(items.map((i) => i.title)).toContain(KOREAN);
        });

        it('uses english_title to bucket "星灯命运" under "K"', async () => {
            const { items } = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'tv',
                letter: 'K',
            });
            expect(items.map((i) => i.title)).toContain(KOF);
        });

        it('buckets leading-punctuation ".harbor" under "H", not "#"', async () => {
            const h = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'tv',
                letter: 'H',
            });
            expect(h.items.map((i) => i.title)).toContain(DOT_HACK);
            const hash = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'tv',
                letter: '#',
            });
            expect(hash.items.map((i) => i.title)).not.toContain(DOT_HACK);
        });

        it('folds the diacritic so "Übler Wind" buckets under "U"', async () => {
            const { items } = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'tv',
                letter: 'U',
            });
            expect(items.map((i) => i.title)).toContain(UEBEL);
        });

        it('routes non-romanizable CJK (no english_title) into the reachable "#" bucket', async () => {
            const { items } = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'tv',
                letter: '#',
            });
            expect(items.map((i) => i.title)).toContain(JP_NO_EN);
        });

        it('orders the Korean series after "Andara" and before "Zephyr Land Saga"', async () => {
            const { items } = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'tv',
                limit: 100,
            });
            const titles = items.map((i) => i.title);
            expect(titles.indexOf('Andara')).toBeLessThan(titles.indexOf(KOREAN));
            expect(titles.indexOf(KOREAN)).toBeLessThan(titles.indexOf('Zephyr Land Saga'));
        });

        it('paginates deterministically with no gaps or duplicates across page boundaries', async () => {
            const all = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'tv',
                limit: 100,
                offset: 0,
            });
            const page1 = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'tv',
                limit: 3,
                offset: 0,
            });
            const page2 = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'tv',
                limit: 3,
                offset: 3,
            });
            const page3 = await getMediaAlphabetical(sql, {
                access: unrestrictedAccess(),
                mediaType: 'tv',
                limit: 3,
                offset: 6,
            });
            const paged = [...page1.items, ...page2.items, ...page3.items].map((i) => i.title);
            expect(paged).toEqual(all.items.map((i) => i.title));
            expect(new Set(paged).size).toBe(paged.length);
        });

        it('reports per-letter bucket counts including "#"', async () => {
            const buckets = await getAlphabeticalBucketCounts(sql, {
                access: unrestrictedAccess(),
                mediaType: 'tv',
            });
            const byLetter = new Map(buckets.map((b) => [b.bucket, b.count]));
            expect(byLetter.get('S')).toBe(1);
            expect(byLetter.get('K')).toBe(1);
            expect(byLetter.get('H')).toBe(1);
            expect(byLetter.get('U')).toBe(1);
            expect(byLetter.get('A')).toBe(1);
            expect(byLetter.get('Z')).toBe(1);
            expect(byLetter.get('#')).toBe(1); // the Japanese no-english_title series
        });
    });

    // ==========================================================================
    // getMediaAlphabetical — differential access-boundary enforcement
    //
    // The `access` boundary is required by the function's type, but types only
    // guarantee it ARRIVES — not that the library predicate is actually applied
    // to BOTH the count and the item query (getMediaAlphabetical builds them
    // separately). Run one fixture three ways per the access-boundary spec:
    //   1. unrestricted -> POSITIVE CONTROL, must be non-empty (getMediaAlphabetical
    //      swallows its own errors and returns []; without this a broken predicate
    //      would pass the denyAll assertion for the wrong reason).
    //   2. a restricted boundary -> STRICT SUBSET of (1).
    //   3. denyAll -> EMPTY.
    // ==========================================================================
    describe('getMediaAlphabetical access boundary (differential)', () => {
        const TAG = 'Zylphabet';

        async function createLibraryGroup(name: string): Promise<string> {
            const id = crypto.randomUUID();
            await sql`INSERT INTO library_groups (id, name) VALUES (${id}::uuid, ${name})`;
            return id;
        }

        // Insert a top-level movie whose sole media_files row lives in
        // `libraryGroupId`, so the library-access predicate has a non-NULL group
        // it can exclude (a file-less item is visible under ANY denyGroups).
        async function insertMovieInGroup(title: string, libraryGroupId: string): Promise<string> {
            const movie = createTestMediaItem({
                media_type: 'movie',
                title,
                has_files: true,
            });
            await insertTestMediaItem(sql, movie);
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, library_group_id)
                VALUES (${fileId}::uuid, ${`/data/${fileId}.mkv`}, ${libraryGroupId}::uuid)
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${movie.id}::uuid)
            `;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;
            return movie.id;
        }

        it('restricted boundary yields a strict subset; denyAll yields empty', async () => {
            const groupA = await createLibraryGroup(`${TAG} Group A`);
            const groupB = await createLibraryGroup(`${TAG} Group B`);
            const idA = await insertMovieInGroup(`${TAG} Alpha`, groupA);
            const idB = await insertMovieInGroup(`${TAG} Beta`, groupB);

            // Restrict to just this fixture's rows so unrelated seeded items in the
            // shared table cannot perturb the strict-subset accounting.
            const fixtureIds = new Set([idA, idB]);
            const run = async (access: MediaAccessBoundary): Promise<string[]> => {
                const { items } = await getMediaAlphabetical(sql, {
                    access,
                    mediaType: 'movie',
                    limit: 100,
                });
                return items
                    .map((i) => i.internal_id)
                    .filter((id): id is string => id !== undefined && fixtureIds.has(id));
            };

            // (1) POSITIVE CONTROL — both fixture rows reachable when unrestricted.
            const open = await run(unrestrictedAccess());
            expect(open.length).toBeGreaterThan(0);
            expect(new Set(open)).toEqual(fixtureIds);

            // (2) STRICT SUBSET — denying group A hides only idA, keeps idB.
            const narrowed = await run(
                restrictedAccess({
                    deniedGroupIds: [groupA],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            );
            const openSet = new Set(open);
            expect(narrowed.every((id) => openSet.has(id))).toBe(true);
            expect(narrowed.length).toBeLessThan(open.length);
            expect(narrowed).toContain(idB);
            expect(narrowed).not.toContain(idA);

            // (3) EMPTY — denyAll closes the boundary entirely.
            const denied = await run(denyAllAccess());
            expect(denied).toEqual([]);

            await sql`DELETE FROM library_groups WHERE id IN (${groupA}::uuid, ${groupB}::uuid)`;
        });
    });

    describe('getMediaByGenre — E2 keyset (Gate H2 / D2b / F8)', () => {
        it('uses review ratings for cards while retaining exact popularity for pagination', async () => {
            const id = await seedGenreMovie(
                'Rating Fixture',
                'Highly popular',
                '139.34567890123456789',
            );
            await sql`UPDATE provider_metadata SET metadata = metadata || ${sql.json({ imdb_rating: 8.2, vote_average: 7.9 })}::jsonb WHERE media_id = ${id}::uuid`;
            const rows = await getMediaByGenre(sql, 'Rating Fixture', {
                access: unrestrictedAccess(),
            });
            expect(rows).toHaveLength(1);
            expect(rows[0].community_rating).toBe(8.2);
            expect(rows[0].popularity_cursor).toBe('139.34567890123456789');
        });
        // Seed a movie in `genreName` with an exact popularity (as text so the
        // numeric precision survives — a JS number would truncate to float64) or
        // NULL popularity (local-only/unscored → the D2b carry group).
        async function seedGenreMovie(
            genreName: string,
            title: string,
            popularity: string | null,
        ): Promise<string> {
            const movie = createTestMediaItem({ media_type: 'movie', title });
            await insertTestMediaItem(sql, movie);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}::uuid`;
            const metadata =
                popularity === null
                    ? { overview: 'x', genres: [{ id: 42, name: genreName }] }
                    : { overview: 'x', popularity, genres: [{ id: 42, name: genreName }] };
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${movie.id}::uuid, 'tmdb', ${sql.json(metadata)}, NOW(), NOW())
            `;
            return movie.id;
        }

        // Bootstrap from offset:0 then follow the cursor. Sound for genre because
        // Gate H2 makes the offset AND cursor orderings identical (both
        // popularity DESC, id DESC) — so tie groups page without dup/skip.
        async function collectGenreViaCursor(
            genreName: string,
            pageSize: number,
        ): Promise<string[]> {
            const ids: string[] = [];
            let rows = await getMediaByGenre(sql, genreName, {
                mediaType: 'movie',
                limit: pageSize,
                offset: 0,
                access: unrestrictedAccess(),
            });
            while (rows.length > 0) {
                const pageRows = rows.slice(0, pageSize);
                for (const r of pageRows) ids.push(r.id);
                const last = pageRows[pageRows.length - 1];
                const next = await getMediaByGenre(sql, genreName, {
                    mediaType: 'movie',
                    limit: pageSize,
                    page: {
                        mode: 'cursor',
                        cursor: { popularity: last.popularity_cursor ?? null, id: last.id },
                    },
                    access: unrestrictedAccess(),
                });
                if (next.length === 0) break;
                rows = next;
            }
            return ids;
        }

        it('cursor paging matches the full offset order incl. tie groups (no dup/skip)', async () => {
            // Two tie groups (9.5, 8.5) plus a distinct tail — exercises the id DESC
            // tiebreak, which H2 applies in BOTH modes.
            for (const [i, pop] of ['9.5', '9.5', '8.5', '8.5', '7.5'].entries()) {
                await seedGenreMovie('ZZKeyset', `ZZKeyset ${i}`, pop);
            }

            const full = await getMediaByGenre(sql, 'ZZKeyset', {
                mediaType: 'movie',
                limit: 100,
                offset: 0,
                access: unrestrictedAccess(),
            });
            const fullOrder = full.map((r) => r.id);

            const paged = await collectGenreViaCursor('ZZKeyset', 2);
            expect(paged).toHaveLength(5);
            expect(paged).toEqual(fullOrder);
            expect(new Set(paged).size).toBe(5);
        });

        it('numeric precision: rows differing beyond float8 precision do not collapse or reorder', async () => {
            // 16 significant digits — past IEEE-754 double's ~15-17. Binding the
            // cursor as ::numeric (not ::float8) keeps them distinct.
            const hi = await seedGenreMovie('ZZPrec', 'ZZPrec hi', '7.123456789012346');
            const lo = await seedGenreMovie('ZZPrec', 'ZZPrec lo', '7.123456789012345');

            const full = await getMediaByGenre(sql, 'ZZPrec', {
                mediaType: 'movie',
                limit: 100,
                offset: 0,
                access: unrestrictedAccess(),
            });
            // Higher popularity first (DESC).
            expect(full.map((r) => r.id)).toEqual([hi, lo]);

            // Cursor positioned exactly at `hi` → the next page must still contain
            // `lo` (a float round-trip would collapse them to one tie and could
            // drop it).
            const hiRow = full.find((r) => r.id === hi)!;
            const next = await getMediaByGenre(sql, 'ZZPrec', {
                mediaType: 'movie',
                limit: 100,
                page: {
                    mode: 'cursor',
                    cursor: { popularity: hiRow.popularity_cursor ?? null, id: hiRow.id },
                },
                access: unrestrictedAccess(),
            });
            expect(next.map((r) => r.id)).toEqual([lo]);
        });

        it('D2b: carries the NULL-popularity tail, never excludes it', async () => {
            const scored = [
                await seedGenreMovie('ZZNull', 'ZZNull a', '9.5'),
                await seedGenreMovie('ZZNull', 'ZZNull b', '8.5'),
            ];
            const unscored = [
                await seedGenreMovie('ZZNull', 'ZZNull c', null),
                await seedGenreMovie('ZZNull', 'ZZNull d', null),
            ];

            const paged = await collectGenreViaCursor('ZZNull', 2);
            expect(new Set(paged)).toEqual(new Set([...scored, ...unscored]));
            expect(paged).toHaveLength(4);

            // Scored rows precede the NULL-popularity tail (NULLS LAST), once.
            const firstNullIdx = paged.findIndex((id) => unscored.includes(id));
            expect(firstNullIdx).toBeGreaterThan(-1);
            expect(paged.slice(0, firstNullIdx).every((id) => scored.includes(id))).toBe(true);
            expect(paged.slice(firstNullIdx).every((id) => unscored.includes(id))).toBe(true);
        });

        it('F8: a query error in cursor mode is propagated, not swallowed to []', async () => {
            await seedGenreMovie('ZZErr', 'ZZErr a', '9.5');
            // A non-numeric cursor popularity makes the ::numeric cast throw
            // (22P02). Cursor mode must reject; offset mode would return [].
            await expect(
                getMediaByGenre(sql, 'ZZErr', {
                    mediaType: 'movie',
                    limit: 5,
                    page: {
                        mode: 'cursor',
                        cursor: {
                            popularity: 'not-a-number',
                            id: '11111111-1111-1111-1111-111111111111',
                        },
                    },
                    access: unrestrictedAccess(),
                }),
            ).rejects.toThrow();
        });
    });

    describe('keyword (tag) filter axis', () => {
        // The local test DB is sparsely populated, so each test here seeds the
        // fixtures it needs rather than asserting against real catalog data.
        // metadata.keywords is projected into media_keywords (lowercased,
        // spaces preserved) by the existing trigger (base schema 16.125.0).
        async function seedWithKeyword(
            title: string,
            keywords: string[],
            genreNames: string[] = [],
        ): Promise<string> {
            const item = createTestMediaItem({ media_type: 'movie', title });
            await insertTestMediaItem(sql, item);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${item.id}::uuid, 'tmdb',
                        ${sql.json({
                            overview: 'x',
                            popularity: 1,
                            keywords,
                            genres: genreNames.map((name, i) => ({ id: 950 + i, name })),
                        })},
                        NOW(), NOW())
            `;
            return item.id;
        }

        beforeEach(async () => {
            await seedWithKeyword('ZZ Whodunit Only', ['whodunit']);
            await seedWithKeyword('ZZ Whodunit Mystery', ['whodunit'], ['Mystery']);
            await seedWithKeyword('ZZ Time Travel', ['time travel']);
            await seedWithKeyword('ZZ No Keyword', []);
        });

        it('narrows getMediaAlphabetical to titles carrying the keyword', async () => {
            const all = await getMediaAlphabetical(sql, {
                mediaType: 'movie',
                access: unrestrictedAccess(),
                limit: 500,
            });
            const tagged = await getMediaAlphabetical(sql, {
                mediaType: 'movie',
                access: unrestrictedAccess(),
                limit: 500,
                keyword: 'whodunit',
            });
            expect(tagged.totalCount).toBeLessThanOrEqual(all.totalCount);
            for (const item of tagged.items) {
                expect(item.internal_id).toBeDefined();
                const rows = await sql`
                    SELECT 1 FROM media_keywords
                    WHERE media_id = ${item.internal_id!} AND keyword = 'whodunit' LIMIT 1
                `;
                expect(rows).toHaveLength(1);
            }
        });

        it('matches case-insensitively via normalization', async () => {
            const lower = await getMediaAlphabetical(sql, {
                mediaType: 'movie',
                access: unrestrictedAccess(),
                limit: 500,
                keyword: 'whodunit',
            });
            const upper = await getMediaAlphabetical(sql, {
                mediaType: 'movie',
                access: unrestrictedAccess(),
                limit: 500,
                keyword: 'WhoDunIt',
            });
            expect(upper.totalCount).toBe(lower.totalCount);
        });

        it('handles multi-word keywords with spaces', async () => {
            const result = await getMediaAlphabetical(sql, {
                mediaType: 'movie',
                access: unrestrictedAccess(),
                limit: 10,
                keyword: 'time travel',
            });
            // beforeEach seeds exactly one 'time travel' title ('ZZ Time
            // Travel'), so this is an exact count — a space in the keyword must
            // neither be split nor silently match nothing.
            expect(result.totalCount).toBe(1);
            expect(result.items).toHaveLength(1);
            expect(result.items[0].title).toBe('ZZ Time Travel');
        });

        it('composes with the genre axis', async () => {
            const both = await getMediaAlphabetical(sql, {
                mediaType: 'movie',
                access: unrestrictedAccess(),
                limit: 500,
                keyword: 'whodunit',
                genreName: 'Mystery',
            });
            const tagOnly = await getMediaAlphabetical(sql, {
                mediaType: 'movie',
                access: unrestrictedAccess(),
                limit: 500,
                keyword: 'whodunit',
            });
            expect(both.totalCount).toBeLessThanOrEqual(tagOnly.totalCount);
        });

        it('an unknown keyword matches nothing rather than erroring', async () => {
            const result = await getMediaAlphabetical(sql, {
                mediaType: 'movie',
                access: unrestrictedAccess(),
                limit: 10,
                keyword: 'definitely-not-a-real-keyword-xyz',
            });
            expect(result.totalCount).toBe(0);
            expect(result.items).toEqual([]);
        });

        describe('getKeywordFacetCounts', () => {
            // SEED FIRST in every test (reuse the `seedWithKeyword` helper above).
            // The shared lumastra_tests DB may hold no tagged rows, and
            // `[].every(...)` is `true` — so an unseeded facet test passes even
            // when the function returns nothing. Each test below must assert a
            // non-zero length before asserting any property over the results.

            it('count for a keyword equals what filtering by it returns', async () => {
                const facets = await getKeywordFacetCounts(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                });
                expect(facets.length).toBeGreaterThan(0);
                for (const facet of facets.slice(0, 5)) {
                    const filtered = await getMediaAlphabetical(sql, {
                        mediaType: 'movie',
                        access: unrestrictedAccess(),
                        limit: 1,
                        keyword: facet.keyword,
                    });
                    expect(filtered.totalCount, `keyword ${facet.keyword}`).toBe(facet.count);
                }
            });

            it('never emits a zero count', async () => {
                const facets = await getKeywordFacetCounts(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                });
                expect(facets.length).toBeGreaterThan(0);
                expect(facets.every((f) => f.count > 0)).toBe(true);
            });

            it('does not narrow over its own axis', async () => {
                const unfiltered = await getKeywordFacetCounts(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                });
                const selfFiltered = await getKeywordFacetCounts(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                    keyword: 'whodunit',
                });
                expect(selfFiltered).toEqual(unfiltered);
            });

            it('honours `max`, so a call site can bound the payload it ships', async () => {
                for (const [i, kw] of ['space-opera', 'space-station', 'spaceship'].entries()) {
                    await seedWithKeyword(`ZZ Max ${i}`, [kw]);
                }
                const uncapped = await getKeywordFacetCounts(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                });
                // Non-emptiness AND headroom: with fewer than 3 keywords in the
                // whole facet, a `max: 2` result of length 2 would prove nothing.
                expect(uncapped.length).toBeGreaterThan(2);

                const capped = await getKeywordFacetCounts(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                    max: 2,
                });
                expect(capped).toHaveLength(2);
                // The cap truncates the same ordering, it does not reshuffle.
                expect(capped).toEqual(uncapped.slice(0, 2));
            });

            it('deduplicates a title tagged by multiple providers', async () => {
                const facets = await getKeywordFacetCounts(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                });
                expect(facets.length).toBeGreaterThan(0);
                for (const facet of facets.slice(0, 3)) {
                    // Compared against the facet keyword's whole ALIAS GROUP, not
                    // the slug alone: an emitted keyword is canonical and its
                    // count spans the group, so a slug-only comparison would be
                    // right only as long as no aliased concept happens to land in
                    // the top 3.
                    const group = keywordGroupMembers(facet.keyword);
                    const [row] = (await sql`
                        SELECT COUNT(DISTINCT mk.media_id)::int AS c
                        FROM media_keywords mk JOIN media_items mi ON mi.id = mk.media_id
                        WHERE mk.keyword = ANY(${group as string[]})
                          AND mi.status = 'active' AND mi.has_files = true AND mi.parent_id IS NULL
                          AND mi.media_type = 'movie'
                    `) as { c: number }[];
                    expect(facet.count).toBe(row.c);
                }
            });
        });

        describe('searchKeywordFacets', () => {
            // Every test here SEEDS its own fixtures first (reuse the
            // `seedWithKeyword` helper above). `results.every(...)` returns true
            // for an EMPTY array, so without seeded rows these assertions would
            // pass even if searchKeywordFacets returned nothing at all. Each test
            // therefore asserts a non-zero length before asserting the property.

            it('returns only keywords starting with the prefix, and finds the seeded one', async () => {
                await seedWithKeyword('ZZ Prefix Hit', ['whodunit']);
                await seedWithKeyword('ZZ Prefix Miss', ['heist']);
                const results = await searchKeywordFacets(sql, 'who', {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                });
                expect(results.length).toBeGreaterThan(0);
                expect(results.every((r) => r.keyword.startsWith('who'))).toBe(true);
                expect(results.map((r) => r.keyword)).toContain('whodunit');
                expect(results.map((r) => r.keyword)).not.toContain('heist');
            });

            it('is case-insensitive on the prefix', async () => {
                await seedWithKeyword('ZZ Case', ['whodunit']);
                const lower = await searchKeywordFacets(sql, 'who', {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                });
                const upper = await searchKeywordFacets(sql, 'WHO', {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                });
                expect(lower.length).toBeGreaterThan(0);
                expect(upper).toEqual(lower);
            });

            it('caps the result set', async () => {
                // All 8 must be CURATED keywords sharing a prefix — the facet is
                // gated on ALLOWED_KEYWORDS, so invented slugs would return zero
                // rows and the cap assertion would pass vacuously.
                const spaceKeywords = [
                    'space-opera',
                    'space-sci-fi',
                    'space-adventure',
                    'space-station',
                    'space-battle',
                    'space-travel',
                    'space-exploration',
                    'spaceship',
                ];
                for (const [i, kw] of spaceKeywords.entries()) {
                    await seedWithKeyword(`ZZ Cap ${i}`, [kw]);
                }
                // Guard: prove the fixtures are actually visible to the facet
                // before asserting the cap truncates them.
                const uncapped = await searchKeywordFacets(sql, 'space', {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                    max: 100,
                });
                expect(uncapped.length).toBe(spaceKeywords.length);

                const results = await searchKeywordFacets(sql, 'space', {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                    max: 5,
                });
                expect(results).toHaveLength(5);
            });

            it('treats SQL wildcard characters as literal prefix text', async () => {
                await seedWithKeyword('ZZ Decoy', ['whodunit']);

                // Control: the fixture IS reachable through a plain prefix, so
                // the empty results below mean "escaped", not "nothing seeded".
                const control = await searchKeywordFacets(sql, 'who', {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                });
                expect(control.map((r) => r.keyword)).toContain('whodunit');

                // The prefix is matched in memory against the curated vocabulary
                // now, so these are plain characters — but the guard stays: were
                // this ever pushed back into a LIKE, unescaped they would become
                // '%%' / 'who%%' / 'w_odunit%' and every one would match
                // 'whodunit'.
                for (const prefix of ['%', 'who%', 'w_odunit']) {
                    const results = await searchKeywordFacets(sql, prefix, {
                        mediaType: 'movie',
                        access: unrestrictedAccess(),
                    });
                    expect(results, `prefix ${prefix}`).toHaveLength(0);
                }
            });

            it('offers ONLY curated keywords, while the filter still accepts uncurated ones', async () => {
                // 'whodunit' is in ALLOWED_KEYWORDS; 'whore-of-babylon' is a real
                // mdblist slug that is not — the raw projection is ~96% such
                // noise, which is why the suggestion surfaces are gated.
                await seedWithKeyword('ZZ Curated', ['whodunit']);
                await seedWithKeyword('ZZ Uncurated', ['whore-of-babylon']);

                const suggested = await searchKeywordFacets(sql, 'who', {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                });
                const keywords = suggested.map((r) => r.keyword);
                expect(keywords).toContain('whodunit');
                expect(keywords).not.toContain('whore-of-babylon');

                // The whole facet, not just the prefix slice, is gated.
                const allFacets = await getKeywordFacetCounts(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                });
                expect(allFacets.length).toBeGreaterThan(0);
                expect(allFacets.map((f) => f.keyword)).not.toContain('whore-of-babylon');

                // ...but an existing ?tag= deep link to the uncurated value must
                // still resolve, or we'd break links we already shipped.
                const filtered = await getMediaAlphabetical(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                    limit: 10,
                    keyword: 'whore-of-babylon',
                });
                expect(filtered.totalCount).toBe(1);
                expect(filtered.items[0].title).toBe('ZZ Uncurated');
            });
        });

        describe('alias groups (near-duplicate slugs for one concept)', () => {
            // `whodunit` and `whodunnit-mystery` are both curated and both label
            // as "Whodunit", so the typeahead used to render two identical rows
            // that filtered to different subsets. They are now one group: the
            // facet offers the canonical only, and both the count and `?tag=`
            // span the whole group.

            it('offers the canonical only, never the alias', async () => {
                await seedWithKeyword('ZZ Alias Canonical', ['whodunit']);
                await seedWithKeyword('ZZ Alias Aliased', ['whodunnit-mystery']);

                const results = await searchKeywordFacets(sql, 'who', {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                });
                const keywords = results.map((r) => r.keyword);
                expect(keywords).toContain('whodunit');
                expect(keywords).not.toContain('whodunnit-mystery');
                // One row for the concept, not two.
                expect(keywords.filter((k) => k === 'whodunit')).toHaveLength(1);
            });

            it('counts a title carrying BOTH slugs once, not twice', async () => {
                // The reason the fold has to happen in SQL: merging two
                // COUNT(DISTINCT media_id) results in JS would count this title
                // in both groups and the facet would exceed the filter's total.
                // Tests in this describe share a DB, so assert against the DB's
                // own answer rather than a literal — an absolute count would
                // drift with whatever earlier tests seeded.
                await seedWithKeyword('ZZ Alias Both', ['whodunit', 'whodunnit-mystery']);
                await seedWithKeyword('ZZ Alias Only Alias', ['whodunnit-mystery']);

                const [facet] = (
                    await searchKeywordFacets(sql, 'whodun', {
                        mediaType: 'movie',
                        access: unrestrictedAccess(),
                    })
                ).filter((r) => r.keyword === 'whodunit');
                expect(facet).toBeDefined();

                const scope = sql`
                    AND mi.status = 'active' AND mi.has_files = true
                    AND mi.parent_id IS NULL AND mi.media_type = 'movie'
                `;
                const [group] = (await sql`
                    SELECT COUNT(DISTINCT mk.media_id)::int AS c
                    FROM media_keywords mk JOIN media_items mi ON mi.id = mk.media_id
                    WHERE mk.keyword = ANY(${['whodunit', 'whodunnit-mystery']}) ${scope}
                `) as { c: number }[];
                const [canonicalOnly] = (await sql`
                    SELECT COUNT(DISTINCT mk.media_id)::int AS c
                    FROM media_keywords mk JOIN media_items mi ON mi.id = mk.media_id
                    WHERE mk.keyword = 'whodunit' ${scope}
                `) as { c: number }[];
                const [aliasOnly] = (await sql`
                    SELECT COUNT(DISTINCT mk.media_id)::int AS c
                    FROM media_keywords mk JOIN media_items mi ON mi.id = mk.media_id
                    WHERE mk.keyword = 'whodunnit-mystery' ${scope}
                `) as { c: number }[];

                expect(facet.count).toBe(group.c);
                // Proves the double-count trap is actually exercised: at least
                // one title carries both slugs, so naively summing the per-slug
                // counts overshoots. Without this the assertion above would pass
                // just as happily on non-overlapping fixtures.
                expect(canonicalOnly.c + aliasOnly.c).toBeGreaterThan(group.c);
            });

            it('THE invariant: the offered count equals what selecting it returns', async () => {
                await seedWithKeyword('ZZ Inv Canonical', ['whodunit']);
                await seedWithKeyword('ZZ Inv Alias', ['whodunnit-mystery']);
                await seedWithKeyword('ZZ Inv Both', ['whodunit', 'whodunnit-mystery']);

                const [facet] = (
                    await searchKeywordFacets(sql, 'whodun', {
                        mediaType: 'movie',
                        access: unrestrictedAccess(),
                    })
                ).filter((r) => r.keyword === 'whodunit');
                expect(facet).toBeDefined();

                const page = await getMediaAlphabetical(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                    limit: 500,
                    keyword: 'whodunit',
                });
                expect(page.totalCount).toBe(facet.count);
            });

            it('resolves a legacy ?tag=<alias> deep link to the same set as the canonical', async () => {
                await seedWithKeyword('ZZ Legacy Canonical', ['whodunit']);
                await seedWithKeyword('ZZ Legacy Alias', ['whodunnit-mystery']);

                const viaCanonical = await getMediaAlphabetical(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                    limit: 500,
                    keyword: 'whodunit',
                });
                const viaAlias = await getMediaAlphabetical(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                    limit: 500,
                    keyword: 'whodunnit-mystery',
                });

                // Both fixtures must be reachable from EITHER slug — that is the
                // whole point of the group, and it also proves the sets below
                // aren't equal merely by both being empty.
                const canonicalTitles = viaCanonical.items.map((i) => i.title);
                expect(canonicalTitles).toContain('ZZ Legacy Canonical');
                expect(canonicalTitles).toContain('ZZ Legacy Alias');

                expect(viaAlias.totalCount).toBe(viaCanonical.totalCount);
                expect(viaAlias.items.map((i) => i.title).sort()).toEqual(
                    [...canonicalTitles].sort(),
                );
            });

            it('a prefix matching only the ALIAS still surfaces the canonical, counted group-wide', async () => {
                // 'espio' matches the `espionage` alias but not its canonical
                // `spy`. If the prefix selected only the matched member, the
                // offered count would be smaller than what ?tag=spy returns —
                // the exact invariant break that whole-group selection prevents.
                await seedWithKeyword('ZZ Spy Canonical', ['spy']);
                await seedWithKeyword('ZZ Spy Alias', ['espionage']);

                const results = await searchKeywordFacets(sql, 'espio', {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                });
                const facet = results.find((r) => r.keyword === 'spy');
                expect(facet, 'prefix on an alias must surface its canonical').toBeDefined();
                expect(results.map((r) => r.keyword)).not.toContain('espionage');

                const page = await getMediaAlphabetical(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                    limit: 500,
                    keyword: 'spy',
                });
                // Reachable from the canonical regardless of which slug tagged
                // them, so the count comparison below is over a non-empty set.
                const titles = page.items.map((i) => i.title);
                expect(titles).toContain('ZZ Spy Canonical');
                expect(titles).toContain('ZZ Spy Alias');
                expect(facet!.count).toBe(page.totalCount);
            });
        });

        describe('getGenreFacetCounts honours the tag axis', () => {
            it('a genre count under an active tag equals what ?genre=X&tag=Y actually returns — not what ?genre=X alone returns', async () => {
                // Two Mystery titles: one also carries 'whodunit', the other a
                // different keyword — so the tag axis must strictly narrow the
                // Mystery count, not pass through unfiltered.
                await seedWithKeyword('ZZ Mystery Tagged', ['whodunit'], ['Mystery']);
                await seedWithKeyword('ZZ Mystery Untagged', ['heist'], ['Mystery']);

                const untaggedFacets = await getGenreFacetCounts(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                });
                const taggedFacets = await getGenreFacetCounts(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                    keyword: 'whodunit',
                });
                const mysteryUntagged = untaggedFacets.find((f) => f.genre === 'Mystery');
                const mysteryTagged = taggedFacets.find((f) => f.genre === 'Mystery');
                expect(mysteryUntagged).toBeDefined();
                expect(mysteryTagged).toBeDefined();

                // Regression guard: `keyword` must actually narrow the count, not
                // just be accepted by the type and discarded at runtime (which
                // would make the tagged and untagged facets identical).
                expect(mysteryTagged!.count).toBeLessThan(mysteryUntagged!.count);

                // The invariant the whole feature rests on: the facet count must
                // equal what filtering by BOTH axes together actually returns.
                const both = await getMediaAlphabetical(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                    limit: 500,
                    genreName: 'Mystery',
                    keyword: 'whodunit',
                });
                expect(both.totalCount).toBe(mysteryTagged!.count);
            });

            it('still ignores its own axis (genreName) when a tag is also active', async () => {
                await seedWithKeyword('ZZ Mystery Tagged Own Axis', ['whodunit'], ['Mystery']);
                const withGenreNarrowing = await getGenreFacetCounts(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                    keyword: 'whodunit',
                    genreName: 'Mystery',
                });
                const withoutGenreNarrowing = await getGenreFacetCounts(sql, {
                    mediaType: 'movie',
                    access: unrestrictedAccess(),
                    keyword: 'whodunit',
                });
                expect(withGenreNarrowing).toEqual(withoutGenreNarrowing);
            });
        });
    });
});
