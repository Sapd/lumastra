// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fix matches `?library=` filter (integration).
 *
 * Both Fix matches views narrow to a library through `buildLibraryGroupRootFilter`,
 * the same membership rule `getLibraryGroupsWithCounts` counts with:
 *   - through files, attached to LEAVES and walked up to the root (an episode's
 *     file puts its series — and every row under it — in the library);
 *   - directly via media_items.library_group_id, ONLY for a library with no
 *     file-linked items at all (AudiobookShelf-style).
 *
 * Library names deliberately say nothing about their content: membership must
 * never be inferred from a name or path.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { countReidentifyItems, loadReidentifyQueue } from './ingest-map.queries.js';
import { countPersonalMediaItems, listPersonalMediaItems } from './media-items.queries.js';
import { createLibraryGroup, getLibraryGroupsWithCounts } from './library-groups.queries.js';

const PREFIX = 'fixmatches-library-test-';

describe('Fix matches library filter (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await cleanup();
        await closeTestDb();
    });

    beforeEach(async () => {
        await cleanup();
    });

    async function cleanup(): Promise<void> {
        await sql`
            DELETE FROM media_file_items
             WHERE file_id IN (SELECT id FROM media_files WHERE file_path LIKE ${'/' + PREFIX + '%'})
        `;
        await sql`DELETE FROM media_files WHERE file_path LIKE ${'/' + PREFIX + '%'}`;
        // Children first: parent_id is a FK.
        for (let depth = 0; depth < 3; depth++) {
            await sql`
                DELETE FROM media_items mi
                 WHERE mi.title LIKE ${PREFIX + '%'}
                   AND NOT EXISTS (SELECT 1 FROM media_items c WHERE c.parent_id = mi.id)
            `;
        }
        await sql`DELETE FROM library_groups WHERE name LIKE ${PREFIX + '%'}`;
    }

    async function group(name: string): Promise<string> {
        return (await createLibraryGroup(sql, { name: PREFIX + name })).id;
    }

    async function item(
        title: string,
        mediaType: string,
        opts: {
            parentId?: string;
            libraryGroupId?: string;
            seasonNumber?: number;
            episodeNumber?: number;
        } = {},
    ): Promise<string> {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items
                (id, title, media_type, status, parent_id, library_group_id, season_number, episode_number)
            VALUES (${id}::uuid, ${PREFIX + title}, ${mediaType}, 'active',
                    ${opts.parentId ?? null}, ${opts.libraryGroupId ?? null},
                    ${opts.seasonNumber ?? null}, ${opts.episodeNumber ?? null})
        `;
        return id;
    }

    async function attachFile(itemId: string, groupId: string, name: string): Promise<void> {
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, library_group_id)
            VALUES (${'/' + PREFIX + name}, ${groupId}::uuid)
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${file.id}::uuid, ${itemId}::uuid)
        `;
        await sql`UPDATE media_items SET has_files = true WHERE id = ${itemId}::uuid`;
    }

    /** A broken match needs a matched item (or series) — see reidentifyPredicate. */
    async function markMatched(mediaItemId: string, mediaType: string): Promise<void> {
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${mediaItemId}::uuid, 'tmdb',
                    ${String(80_000_000 + Math.floor(Math.random() * 9_000_000))},
                    ${mediaType}, true)
        `;
    }

    /** Library scoping fixtures represent explicit identity repairs, not operational failures. */
    async function failIdentityRepair(mediaItemId: string, stageId: string): Promise<void> {
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, attempt, last_error, updated_at)
            VALUES (${mediaItemId}::uuid, ${stageId}, 1, 'failed_permanent', 3,
                    ${sql.json({ message: 'Provider identity no longer exists', retryable: false, remediation: 'identity' })}, now())
        `;
    }

    async function queueIds(libraryGroupId: string): Promise<string[]> {
        const rows = await loadReidentifyQueue(sql, {
            limit: 500,
            offset: 0,
            search: PREFIX,
            libraryGroupId,
        });
        return rows.map((r) => r.media_item_id).sort();
    }

    async function queueCount(libraryGroupId: string): Promise<number> {
        return countReidentifyItems(sql, { search: PREFIX, libraryGroupId });
    }

    /**
     * Three libraries:
     *   "Evening" — a series whose files sit on its EPISODES only;
     *   "Harbor"  — no files at all, items assigned directly (AudiobookShelf-style);
     *   "Orchard" — a movie with its own file.
     * Every root was matched once and has a broken-match row.
     */
    async function seedBrokenMatches() {
        const evening = await group('Evening');
        const harbor = await group('Harbor');
        const orchard = await group('Orchard');

        const series = await item('series', 'tv');
        await markMatched(series, 'tv');
        const season = await item('season-1', 'season', { parentId: series, seasonNumber: 1 });
        const episode = await item('episode-1', 'episode', {
            parentId: season,
            seasonNumber: 1,
            episodeNumber: 1,
        });
        await attachFile(episode, evening, 'evening/e1.mkv');
        await failIdentityRepair(series, 'tmdb-metadata-sync');
        await failIdentityRepair(season, 'season-poster');

        const book = await item('book', 'audiobook', { libraryGroupId: harbor });
        await markMatched(book, 'audiobook');
        await failIdentityRepair(book, 'tmdb-metadata-sync');

        const movie = await item('movie', 'movie');
        await markMatched(movie, 'movie');
        await attachFile(movie, orchard, 'orchard/m.mkv');
        await failIdentityRepair(movie, 'tmdb-metadata-sync');

        return { evening, harbor, orchard, series, season, episode, book, movie };
    }

    describe('Broken match', () => {
        it('puts a series and its season in the library its EPISODE files belong to', async () => {
            const s = await seedBrokenMatches();

            expect(await queueIds(s.evening)).toEqual([s.series, s.season].sort());
            expect(await queueCount(s.evening)).toBe(2);
        });

        it('resolves a failed episode (a leaf itself) to its library too', async () => {
            const s = await seedBrokenMatches();
            await failIdentityRepair(s.episode, 'episode-thumb');

            expect(await queueIds(s.evening)).toEqual([s.series, s.season, s.episode].sort());
            expect(await queueCount(s.evening)).toBe(3);
        });

        it('reaches a file-less (AudiobookShelf-style) library through the direct fallback', async () => {
            const s = await seedBrokenMatches();

            expect(await queueIds(s.harbor)).toEqual([s.book]);
            expect(await queueCount(s.harbor)).toBe(1);
        });

        it('excludes items of every other library', async () => {
            const s = await seedBrokenMatches();

            expect(await queueIds(s.orchard)).toEqual([s.movie]);
            expect(await queueCount(s.orchard)).toBe(1);
            // The unfiltered queue still holds all four.
            expect(await countReidentifyItems(sql, { search: PREFIX })).toBe(4);
        });

        it('keeps the fallback shut for a file-backed library', async () => {
            const s = await seedBrokenMatches();
            // Directly assigned to a library that HAS file-linked items: the
            // direct column must not add it (it would contaminate every
            // file-backed library with discovery-only roots).
            const stray = await item('stray', 'movie', { libraryGroupId: s.evening });
            await markMatched(stray, 'movie');
            await failIdentityRepair(stray, 'tmdb-metadata-sync');

            expect(await queueIds(s.evening)).toEqual([s.series, s.season].sort());
        });

        it('excludes an operational failure in the same library from list and count', async () => {
            const s = await seedBrokenMatches();
            const operational = await item('operational', 'movie');
            await markMatched(operational, 'movie');
            await attachFile(operational, s.orchard, 'orchard/operational.mkv');
            await sql`
                INSERT INTO media_item_stage_state
                    (media_item_id, stage_id, processing_version, status, attempt, last_error)
                VALUES (${operational}::uuid, 'media-probe', 1, 'failed_permanent', 3,
                    ${sql.json({ message: 'Unsupported video codec', retryable: false, remediation: 'operational' })})
            `;

            expect(await queueIds(s.orchard)).toEqual([s.movie]);
            expect(await queueCount(s.orchard)).toBe(1);
        });

        it('agrees with getLibraryGroupsWithCounts on which libraries hold the roots', async () => {
            const s = await seedBrokenMatches();
            const counts = await getLibraryGroupsWithCounts(sql);
            const byId = new Map(counts.map((c) => [c.id, c.item_count]));

            expect(byId.get(s.evening)).toBe(1); // the series
            expect(byId.get(s.harbor)).toBe(1); // the book
            expect(byId.get(s.orchard)).toBe(1); // the movie
        });
    });

    describe('Never matched', () => {
        it('scopes list and count to the library of the episode files', async () => {
            const evening = await group('Evening');
            const orchard = await group('Orchard');

            const series = await item('never-series', 'tv');
            const season = await item('never-season-1', 'season', {
                parentId: series,
                seasonNumber: 1,
            });
            const episode = await item('never-episode-1', 'episode', {
                parentId: season,
                seasonNumber: 1,
                episodeNumber: 1,
            });
            await attachFile(episode, evening, 'evening/never-e1.mkv');

            const movie = await item('never-movie', 'movie');
            await attachFile(movie, orchard, 'orchard/never-m.mkv');

            const inEvening = await listPersonalMediaItems(sql, {
                limit: 100,
                offset: 0,
                search: PREFIX,
                libraryGroupId: evening,
            });
            expect(inEvening.map((r) => r.id)).toEqual([series]);
            expect(
                await countPersonalMediaItems(sql, { search: PREFIX, libraryGroupId: evening }),
            ).toBe(1);

            const inOrchard = await listPersonalMediaItems(sql, {
                limit: 100,
                offset: 0,
                search: PREFIX,
                libraryGroupId: orchard,
            });
            expect(inOrchard.map((r) => r.id)).toEqual([movie]);
            expect(
                await countPersonalMediaItems(sql, { search: PREFIX, libraryGroupId: orchard }),
            ).toBe(1);
        });
    });
});
