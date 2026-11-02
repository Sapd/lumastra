// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Database Cleanup Query Module
 *
 * Tests backfill, stub merging, orphan detection, and hard-delete
 * candidate queries against a real PostgreSQL test database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { resetArtistCreditEvidenceCache } from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/artist-credit-evidence.js';

import {
    backfillHasFilesMediaItems,
    clearStaleHasFilesMediaItems,
    pruneOrphanedInteractionsPerson,
    pruneOrphanedInteractionReactionsPerson,
    findMergeStubCandidates,
    applyStubMerge,
    findMisidentifiedEpisodes,
    softDeleteOrphanMediaStubs,
    healDeadArtistReferences,
    healDanglingArtistIds,
    softDeleteOrphanMusicItems,
    findHardDeletableMediaIds,
    cleanupOrphanedMediaFiles,
    purgeStageStateForDeletedItems,
    autoMergeDuplicateArtists,
} from './database-cleanup.queries.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Database Cleanup Queries', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, ['media_item_stage_state', ...TEST_TABLES.media]);
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['media_item_stage_state', ...TEST_TABLES.media]);
    });

    // ========================================================================
    // backfillHasFilesMediaItems
    // ========================================================================

    describe('backfillHasFilesMediaItems', () => {
        it('sets has_files true for items with media_file_items', async () => {
            const mediaId = crypto.randomUUID();
            const fileId = crypto.randomUUID();

            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${mediaId}::uuid, ${'Test Movie'}, 'movie', 'active')
            `;
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${'/test/movie.mkv'}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${mediaId}::uuid)
            `;

            await backfillHasFilesMediaItems(sql);

            const [row] = await sql<{ has_files: boolean }[]>`
                SELECT has_files FROM media_items WHERE id = ${mediaId}::uuid
            `;
            expect(row.has_files).toBe(true);
        });

        it('sets has_files true for parents of items with files', async () => {
            const seriesId = crypto.randomUUID();
            const seasonId = crypto.randomUUID();
            const fileId = crypto.randomUUID();

            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${seriesId}::uuid, ${'Test Series'}, 'tv', 'active')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
                VALUES (${seasonId}::uuid, ${'Season 1'}, 'season', ${seriesId}::uuid, 1, 'active')
            `;
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${'/test/season.mkv'}, NOW(), NOW())
            `;
            // Link file to season (not series directly)
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${seasonId}::uuid)
            `;

            await backfillHasFilesMediaItems(sql);

            const [row] = await sql<{ has_files: boolean }[]>`
                SELECT has_files FROM media_items WHERE id = ${seriesId}::uuid
            `;
            expect(row.has_files).toBe(true);
        });
    });

    describe('clearStaleHasFilesMediaItems', () => {
        const hasFiles = async (id: string): Promise<boolean> => {
            const [row] = await sql<{ has_files: boolean }[]>`
                SELECT has_files FROM media_items WHERE id = ${id}::uuid
            `;
            return row.has_files;
        };

        const insertItem = async (opts: {
            id: string;
            mediaType: string;
            hasFiles: boolean;
            parentId?: string;
            status?: string;
        }): Promise<void> => {
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files, parent_id)
                VALUES (
                    ${opts.id}::uuid, ${'T-' + opts.id.slice(0, 8)}, ${opts.mediaType},
                    ${opts.status ?? 'active'}, ${opts.hasFiles}, ${opts.parentId ?? null}::uuid
                )
            `;
        };

        const attachFile = async (mediaItemId: string, path: string): Promise<void> => {
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${path}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${mediaItemId}::uuid)
            `;
        };

        it('leaves an item that really owns a file alone', async () => {
            const id = crypto.randomUUID();
            await insertItem({ id, mediaType: 'movie', hasFiles: true });
            await attachFile(id, '/test/real-movie.mkv');

            await clearStaleHasFilesMediaItems(sql);

            expect(await hasFiles(id)).toBe(true);
        });

        it('leaves a series alone when only a grandchild episode owns the file', async () => {
            const seriesId = crypto.randomUUID();
            const seasonId = crypto.randomUUID();
            const episodeId = crypto.randomUUID();
            await insertItem({ id: seriesId, mediaType: 'tv', hasFiles: true });
            await insertItem({
                id: seasonId,
                mediaType: 'season',
                hasFiles: true,
                parentId: seriesId,
            });
            await insertItem({
                id: episodeId,
                mediaType: 'episode',
                hasFiles: true,
                parentId: seasonId,
            });
            await attachFile(episodeId, '/test/ep.mkv');

            await clearStaleHasFilesMediaItems(sql);

            // All three stay true — the grandchild is what backs them.
            expect(await hasFiles(seriesId)).toBe(true);
            expect(await hasFiles(seasonId)).toBe(true);
            expect(await hasFiles(episodeId)).toBe(true);
        });

        // The literal Macross Plus repro (prod 2026-07-30): the episodes were cleared
        // when their files went away but the flag never propagated up, so the series and
        // season stayed `true` forever and kept the item inside the provider-artwork
        // eligibility domain.
        it('clears a whole tv/season/episode chain when nothing in it owns a file', async () => {
            const seriesId = crypto.randomUUID();
            const seasonId = crypto.randomUUID();
            const episodeId = crypto.randomUUID();
            await insertItem({ id: seriesId, mediaType: 'tv', hasFiles: true });
            await insertItem({
                id: seasonId,
                mediaType: 'season',
                hasFiles: true,
                parentId: seriesId,
            });
            await insertItem({
                id: episodeId,
                mediaType: 'episode',
                hasFiles: false,
                parentId: seasonId,
            });

            const cleared = await clearStaleHasFilesMediaItems(sql);

            expect(cleared).toBeGreaterThanOrEqual(2);
            expect(await hasFiles(seriesId)).toBe(false);
            expect(await hasFiles(seasonId)).toBe(false);
        });

        // THE regression test. Audiobooks are file-less by design — the bytes live on
        // the AudiobookShelf server. Prod carries 1183 such rows; a clear that ignored
        // the media_type exclusion would delete the entire audiobook library from every
        // has_files-gated surface.
        it('NEVER clears an audiobook, which is file-less by design', async () => {
            const id = crypto.randomUUID();
            await insertItem({ id, mediaType: 'audiobook', hasFiles: true });

            await clearStaleHasFilesMediaItems(sql);

            expect(await hasFiles(id)).toBe(true);
        });

        it('leaves non-active rows alone (their own delete sites own that flag)', async () => {
            const id = crypto.randomUUID();
            await insertItem({ id, mediaType: 'movie', hasFiles: true, status: 'deleted' });

            await clearStaleHasFilesMediaItems(sql);

            expect(await hasFiles(id)).toBe(true);
        });

        it('is bounded by the limit', async () => {
            const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
            for (const id of ids) await insertItem({ id, mediaType: 'movie', hasFiles: true });

            const cleared = await clearStaleHasFilesMediaItems(sql, 2);

            expect(cleared).toBe(2);
        });

        it('is idempotent — a second pass finds nothing left to do', async () => {
            const id = crypto.randomUUID();
            await insertItem({ id, mediaType: 'movie', hasFiles: true });

            expect(await clearStaleHasFilesMediaItems(sql)).toBe(1);
            expect(await clearStaleHasFilesMediaItems(sql)).toBe(0);
        });
    });

    // These two prunes shipped with `WHERE media_people.id = target_id::uuid` while
    // `media_people.id` is BIGINT, so Postgres rejected the predicate at PLAN time on
    // every run. It went unnoticed for months because database-cleanup only reports
    // failure when the total cleaned count is zero — on a busy install another stage
    // always cleans something, so the run reported "completed" while carrying the
    // error in `result.errors`. Merely CALLING these functions is enough to catch it;
    // that no test did is why it survived.
    describe('pruneOrphanedInteractions* (person targets)', () => {
        const PERSON_PREFIX = 'itest-person-prune';
        let userId: string;

        const makeUser = async (): Promise<string> => {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO users (id, username)
                VALUES (${id}::uuid, ${`${PERSON_PREFIX}-${id.slice(0, 8)}`})
                ON CONFLICT DO NOTHING
            `;
            return id;
        };

        /** A real media_people row; returns its BIGINT id as text. */
        const makePerson = async (): Promise<string> => {
            const mediaId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${mediaId}::uuid, ${`${PERSON_PREFIX}-item`}, 'movie', 'active')
            `;
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO media_people (media_id, name, role)
                VALUES (${mediaId}::uuid, ${`${PERSON_PREFIX}-name`}, 'actor')
                RETURNING id::text AS id
            `;
            return row.id;
        };

        const addInteraction = async (targetId: string): Promise<string> => {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO interactions (target_type, target_id, user_id, body)
                VALUES ('person', ${targetId}, ${userId}::uuid, ${`${PERSON_PREFIX}-body`})
                RETURNING id::text AS id
            `;
            return row.id;
        };

        const interactionExists = async (id: string): Promise<boolean> => {
            const rows = await sql`SELECT 1 FROM interactions WHERE id = ${id}::bigint`;
            return rows.length > 0;
        };

        beforeEach(async () => {
            await sql`DELETE FROM interactions WHERE body LIKE ${`${PERSON_PREFIX}%`}`;
            await sql`DELETE FROM media_items WHERE title LIKE ${`${PERSON_PREFIX}%`}`;
            userId = await makeUser();
        });

        // The regression test proper: this THREW `operator does not exist: bigint = uuid`
        // before the fix, regardless of what rows existed.
        it('executes without a type error', async () => {
            await expect(pruneOrphanedInteractionsPerson(sql)).resolves.toBeTypeOf('number');
            await expect(pruneOrphanedInteractionReactionsPerson(sql)).resolves.toBeTypeOf(
                'number',
            );
        });

        it('deletes an interaction whose person no longer exists', async () => {
            // A bigint id that cannot collide with a real sequence value.
            const orphanId = await addInteraction('9223372036854775806');

            await pruneOrphanedInteractionsPerson(sql);

            expect(await interactionExists(orphanId)).toBe(false);
        });

        it('keeps an interaction whose person DOES exist', async () => {
            const personId = await makePerson();
            const keptId = await addInteraction(personId);

            await pruneOrphanedInteractionsPerson(sql);

            expect(await interactionExists(keptId)).toBe(true);
        });

        // A numeric string wider than bigint must not blow up the cast with 22003
        // (numeric_value_out_of_range) — which is exactly why this compares `id::text`
        // rather than casting target_id to bigint. Such a value cannot possibly be a
        // real `media_people.id` (bigint tops out at 19 digits), so pruning it is the
        // correct outcome; the point of the test is that it resolves instead of throwing.
        it('prunes a numeric target_id too wide for bigint, without an overflow error', async () => {
            const wideId = await addInteraction('99999999999999999999999999999999');

            await expect(pruneOrphanedInteractionsPerson(sql)).resolves.toBeTypeOf('number');

            expect(await interactionExists(wideId)).toBe(false);
        });
    });

    // ========================================================================
    // findMergeStubCandidates
    // ========================================================================

    describe('findMergeStubCandidates', () => {
        it('finds tv stubs matching a canonical series by title', async () => {
            const canonicalId = crypto.randomUUID();
            const stubId = crypto.randomUUID();

            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${canonicalId}::uuid, ${'Merge Test Series'}, 'tv', 'active')
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${canonicalId}::uuid, 'tmdb', ${'12345'}, 'tv')
            `;
            // Season under canonical
            const seasonId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
                VALUES (${seasonId}::uuid, ${'Season 1'}, 'season', ${canonicalId}::uuid, 1, 'active')
            `;

            // Backdate past the 30-minute grace window the cleanup queries apply
            // (freshly-created items are skipped to avoid racing an in-flight scan).
            await sql`
                INSERT INTO media_items (id, title, media_type, status, created_at)
                VALUES (${stubId}::uuid, ${'Merge Test Series'}, 'tv', 'active', NOW() - INTERVAL '1 hour')
            `;
            // Season under stub
            const stubSeasonId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
                VALUES (${stubSeasonId}::uuid, ${'Season 1'}, 'season', ${stubId}::uuid, 1, 'active')
            `;

            await sql`UPDATE media_items SET year = 2020 WHERE id IN (${canonicalId}, ${stubId})`;
            const candidates = await findMergeStubCandidates(sql, 10);
            const match = candidates.find(
                (c) => c.stub_id === stubId && c.canonical_id === canonicalId,
            );
            expect(match).toBeDefined();
        });

        it('returns empty when no stubs match', async () => {
            const candidates = await findMergeStubCandidates(sql, 10);
            expect(candidates).toBeInstanceOf(Array);
        });

        it('skips ambiguous, fresh and childless stubs', async () => {
            const tag = crypto.randomUUID().slice(0, 8);
            async function series(opts: {
                title: string;
                ext?: boolean;
                child?: boolean;
                old?: boolean;
            }): Promise<string> {
                const id = crypto.randomUUID();
                await sql`
                    INSERT INTO media_items (id, title, media_type, status, year, created_at)
                    VALUES (${id}::uuid, ${opts.title}, 'tv', 'active', 2020,
                            ${opts.old === false ? sql`NOW()` : sql`NOW() - INTERVAL '1 hour'`})
                `;
                if (opts.ext) {
                    await sql`
                        INSERT INTO external_ids (media_id, provider, external_id, media_type)
                        VALUES (${id}::uuid, 'tmdb', ${String(Math.floor(Math.random() * 9e7) + 1)}, 'tv')
                    `;
                }
                if (opts.child) {
                    await sql`
                        INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
                        VALUES (${crypto.randomUUID()}::uuid, 'Season 1', 'season', ${id}::uuid, 1, 'active')
                    `;
                }
                return id;
            }

            // Two canonical series share the title: not exactly one match.
            await series({ title: `Twin ${tag}`, ext: true });
            await series({ title: `twin ${tag} `, ext: true });
            const ambiguous = await series({ title: `Twin ${tag}`, child: true });
            // Inside the 30-minute grace window.
            await series({ title: `Fresh ${tag}`, ext: true });
            const fresh = await series({ title: `Fresh ${tag}`, child: true, old: false });
            // No children: nothing to re-parent.
            await series({ title: `Empty ${tag}`, ext: true });
            const childless = await series({ title: `Empty ${tag}` });
            // Matches case- and whitespace-insensitively: merged.
            const canonical = await series({ title: `Solo ${tag}`, ext: true });
            const stub = await series({ title: `  SOLO ${tag}`, child: true });

            const candidates = await findMergeStubCandidates(sql, 100_000);
            const byStub = new Map(candidates.map((c) => [c.stub_id, c.canonical_id]));
            expect(byStub.get(stub)).toBe(canonical);
            expect(byStub.has(ambiguous)).toBe(false);
            expect(byStub.has(fresh)).toBe(false);
            expect(byStub.has(childless)).toBe(false);
        });
    });

    // ========================================================================
    // applyStubMerge
    // ========================================================================

    describe('applyStubMerge', () => {
        it('reparents non-conflicting children and deletes stub', async () => {
            const canonicalId = crypto.randomUUID();
            const stubId = crypto.randomUUID();
            const stubSeasonId = crypto.randomUUID();

            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${canonicalId}::uuid, ${'Canonical'}, 'tv', 'active')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${stubId}::uuid, ${'Stub'}, 'tv', 'active')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
                VALUES (${stubSeasonId}::uuid, ${'Season 2'}, 'season', ${stubId}::uuid, 2, 'active')
            `;

            await applyStubMerge(sql, stubId, canonicalId);

            const [seasonRow] = await sql<{ parent_id: string; status: string }[]>`
                SELECT parent_id, status FROM media_items WHERE id = ${stubSeasonId}::uuid
            `;
            expect(seasonRow.parent_id).toBe(canonicalId);

            const [stubRow] = await sql<{ status: string }[]>`
                SELECT status FROM media_items WHERE id = ${stubId}::uuid
            `;
            expect(stubRow.status).toBe('deleted');
        });
    });

    // ========================================================================
    // findMisidentifiedEpisodes
    // ========================================================================

    describe('findMisidentifiedEpisodes', () => {
        it('finds tv stubs with no year and 0-2 children', async () => {
            const stubId = crypto.randomUUID();
            const seasonId = crypto.randomUUID();

            // Backdate past the 30-minute grace window the cleanup queries apply.
            await sql`
                INSERT INTO media_items (id, title, media_type, status, created_at)
                VALUES (${stubId}::uuid, ${'Misidentified Stub'}, 'tv', 'active', NOW() - INTERVAL '1 hour')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
                VALUES (${seasonId}::uuid, ${'Season 1'}, 'season', ${stubId}::uuid, 1, 'active')
            `;

            const stubs = await findMisidentifiedEpisodes(sql, 10);
            const match = stubs.find((s) => s.stub_id === stubId);
            expect(match).toBeDefined();
        });

        it('excludes stubs with on-disk files', async () => {
            const stubId = crypto.randomUUID();
            const seasonId = crypto.randomUUID();
            const fileId = crypto.randomUUID();

            // Backdate past the grace window so on-disk files are the sole reason
            // this stub is excluded (not the freshness filter).
            await sql`
                INSERT INTO media_items (id, title, media_type, status, created_at)
                VALUES (${stubId}::uuid, ${'File Stub'}, 'tv', 'active', NOW() - INTERVAL '1 hour')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
                VALUES (${seasonId}::uuid, ${'Season 1'}, 'season', ${stubId}::uuid, 1, 'active')
            `;
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${'/test/file.mkv'}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${seasonId}::uuid)
            `;

            const stubs = await findMisidentifiedEpisodes(sql, 10);
            const match = stubs.find((s) => s.stub_id === stubId);
            expect(match).toBeUndefined();
        });
    });

    // ========================================================================
    // softDeleteOrphanMediaStubs
    // ========================================================================

    describe('softDeleteOrphanMediaStubs', () => {
        it('soft-deletes orphan tv stubs', async () => {
            const orphanId = crypto.randomUUID();
            // Backdate past the 30-minute grace window the cleanup queries apply.
            await sql`
                INSERT INTO media_items (id, title, media_type, status, created_at)
                VALUES (${orphanId}::uuid, ${'Orphan TV'}, 'tv', 'active', NOW() - INTERVAL '1 hour')
            `;

            const count = await softDeleteOrphanMediaStubs(sql);
            expect(count).toBeGreaterThanOrEqual(1);

            const [row] = await sql<{ status: string }[]>`
                SELECT status FROM media_items WHERE id = ${orphanId}::uuid
            `;
            expect(row.status).toBe('deleted');
        });

        it('does not delete stubs with external ids', async () => {
            const withExtId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${withExtId}::uuid, ${'Has Ext ID'}, 'tv', 'active')
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${withExtId}::uuid, 'tmdb', ${'777'}, 'tv')
            `;

            const _count = await softDeleteOrphanMediaStubs(sql);
            const [row] = await sql<{ status: string }[]>`
                SELECT status FROM media_items WHERE id = ${withExtId}::uuid
            `;
            expect(row.status).toBe('active');
        });

        // Regression: "Pimp! Code" search bug (2026-07-16). A credit-only
        // artist — zero albums of its own, linked from another artist's
        // track via custom_metadata.additional_artist_ids — used to satisfy
        // every orphan predicate and get soft-deleted, permanently hiding it
        // from searchMusic (status = 'active' required) even though the
        // crediting track stayed active and kept resolving the artist link.
        it('does not delete a credit-only artist referenced via a track additional_artist_ids', async () => {
            const creditOnlyArtist = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at)
                VALUES (
                    ${creditOnlyArtist}::uuid, ${'Pimp! Code'}, 'artist', 'active', NULL,
                    NOW() - INTERVAL '1 hour'
                )
            `;

            // A different, real artist that owns the compilation album the
            // track actually lives under (mirrors prod: album parent = "Rob
            // Mayth", not the credit-only artist).
            const albumOwner = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at)
                VALUES (${albumOwner}::uuid, ${'Rob Fenwick'}, 'artist', 'active', NULL, NOW() - INTERVAL '1 hour')
            `;
            const albumId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at)
                VALUES (${albumId}::uuid, ${'Rob Fenwick Presents 80+'}, 'album', 'active', ${albumOwner}::uuid, NOW() - INTERVAL '1 hour')
            `;
            const trackId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at, custom_metadata)
                VALUES (
                    ${trackId}::uuid, ${'Raise Your Head Up (Radio Edit)'}, 'track', 'active',
                    ${albumId}::uuid, NOW() - INTERVAL '1 hour',
                    ${sql.json({ artist: 'Pimp! Code', additional_artist_ids: [creditOnlyArtist] })}
                )
            `;

            await softDeleteOrphanMediaStubs(sql);

            const [row] = await sql<{ status: string }[]>`
                SELECT status FROM media_items WHERE id = ${creditOnlyArtist}::uuid
            `;
            expect(row.status).toBe('active');
        });
    });

    // ========================================================================
    // healDeadArtistReferences
    // ========================================================================

    describe('healDeadArtistReferences', () => {
        /**
         * Insert a soft-deleted "dead" artist, an active "canonical" artist
         * sharing its normalized title, and a track whose additional_artist_ids
         * carries the given ids (in order).
         */
        async function seedDeadAndCanonical(
            title: string,
            additionalArtistIds: string[],
        ): Promise<{ deadId: string; canonicalId: string; trackId: string }> {
            const canonicalId = crypto.randomUUID();
            const deadId = crypto.randomUUID();
            const albumOwnerId = crypto.randomUUID();
            const albumId = crypto.randomUUID();
            const trackId = crypto.randomUUID();

            // Canonical active artist created first (older created_at) so the
            // ORDER BY created_at ASC tiebreak picks it deterministically.
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at)
                VALUES (${canonicalId}::uuid, ${title}, 'artist', 'active', NULL, NOW() - INTERVAL '2 hour')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at)
                VALUES (${deadId}::uuid, ${title}, 'artist', 'deleted', NULL, NOW() - INTERVAL '1 hour')
            `;

            // A distinct album-owning artist + album + track referencing the
            // dead id via additional_artist_ids (mirrors the credit-only shape).
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at)
                VALUES (${albumOwnerId}::uuid, ${'Album Owner ' + crypto.randomUUID().slice(0, 8)}, 'artist', 'active', NULL, NOW() - INTERVAL '1 hour')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at)
                VALUES (${albumId}::uuid, ${'Album ' + crypto.randomUUID().slice(0, 8)}, 'album', 'active', ${albumOwnerId}::uuid, NOW() - INTERVAL '1 hour')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at, custom_metadata)
                VALUES (
                    ${trackId}::uuid, ${'Track ' + crypto.randomUUID().slice(0, 8)}, 'track', 'active',
                    ${albumId}::uuid, NOW() - INTERVAL '1 hour',
                    ${sql.json({ additional_artist_ids: additionalArtistIds })}
                )
            `;

            return { deadId, canonicalId, trackId };
        }

        it('rewrites a dead artist reference to the active canonical artist, preserving order', async () => {
            const otherId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at)
                VALUES (${otherId}::uuid, ${'Other Credited ' + crypto.randomUUID().slice(0, 8)}, 'artist', 'active', NULL, NOW() - INTERVAL '1 hour')
            `;

            const title = 'Heal Target Artist ' + crypto.randomUUID().slice(0, 8);
            const { deadId, canonicalId, trackId } = await seedDeadAndCanonical(title, []);

            // seedDeadAndCanonical doesn't know deadId ahead of time, so set the
            // track's additional_artist_ids directly now that we have it.
            await sql`
                UPDATE media_items
                SET custom_metadata = ${sql.json({ additional_artist_ids: [otherId, deadId] })}
                WHERE id = ${trackId}::uuid
            `;

            const healed = await healDeadArtistReferences(sql);
            expect(healed).toBeGreaterThanOrEqual(1);

            const [row] = await sql<{ custom_metadata: { additional_artist_ids: string[] } }[]>`
                SELECT custom_metadata FROM media_items WHERE id = ${trackId}::uuid
            `;
            expect(row.custom_metadata.additional_artist_ids).toEqual([otherId, canonicalId]);
        });

        it('dedupes when the track already carries the canonical id', async () => {
            const title = 'Heal Dedupe Artist ' + crypto.randomUUID().slice(0, 8);
            const { deadId, canonicalId, trackId } = await seedDeadAndCanonical(title, []);

            await sql`
                UPDATE media_items
                SET custom_metadata = ${sql.json({ additional_artist_ids: [canonicalId, deadId] })}
                WHERE id = ${trackId}::uuid
            `;

            const healed = await healDeadArtistReferences(sql);
            expect(healed).toBeGreaterThanOrEqual(1);

            const [row] = await sql<{ custom_metadata: { additional_artist_ids: string[] } }[]>`
                SELECT custom_metadata FROM media_items WHERE id = ${trackId}::uuid
            `;
            expect(row.custom_metadata.additional_artist_ids).toEqual([canonicalId]);
        });

        it('leaves a dead artist untouched and uncounted when no active same-norm artist exists', async () => {
            const deadId = crypto.randomUUID();
            const albumOwnerId = crypto.randomUUID();
            const albumId = crypto.randomUUID();
            const trackId = crypto.randomUUID();
            const title = 'Orphan Dead Artist ' + crypto.randomUUID().slice(0, 8);

            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at)
                VALUES (${deadId}::uuid, ${title}, 'artist', 'deleted', NULL, NOW() - INTERVAL '1 hour')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at)
                VALUES (${albumOwnerId}::uuid, ${'Album Owner ' + crypto.randomUUID().slice(0, 8)}, 'artist', 'active', NULL, NOW() - INTERVAL '1 hour')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at)
                VALUES (${albumId}::uuid, ${'Album ' + crypto.randomUUID().slice(0, 8)}, 'album', 'active', ${albumOwnerId}::uuid, NOW() - INTERVAL '1 hour')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at, custom_metadata)
                VALUES (
                    ${trackId}::uuid, ${'Track ' + crypto.randomUUID().slice(0, 8)}, 'track', 'active',
                    ${albumId}::uuid, NOW() - INTERVAL '1 hour',
                    ${sql.json({ additional_artist_ids: [deadId] })}
                )
            `;

            const healed = await healDeadArtistReferences(sql);

            const [row] = await sql<{ custom_metadata: { additional_artist_ids: string[] } }[]>`
                SELECT custom_metadata FROM media_items WHERE id = ${trackId}::uuid
            `;
            expect(row.custom_metadata.additional_artist_ids).toEqual([deadId]);
            expect(healed).toBe(0);
        });

        it('is idempotent — a second run rewrites nothing and returns 0', async () => {
            const otherId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, created_at)
                VALUES (${otherId}::uuid, ${'Other Credited ' + crypto.randomUUID().slice(0, 8)}, 'artist', 'active', NULL, NOW() - INTERVAL '1 hour')
            `;

            const title = 'Heal Idempotent Artist ' + crypto.randomUUID().slice(0, 8);
            const { deadId, canonicalId, trackId } = await seedDeadAndCanonical(title, []);
            await sql`
                UPDATE media_items
                SET custom_metadata = ${sql.json({ additional_artist_ids: [otherId, deadId] })}
                WHERE id = ${trackId}::uuid
            `;

            const firstRun = await healDeadArtistReferences(sql);
            expect(firstRun).toBeGreaterThanOrEqual(1);

            const secondRun = await healDeadArtistReferences(sql);
            expect(secondRun).toBe(0);

            const [row] = await sql<{ custom_metadata: { additional_artist_ids: string[] } }[]>`
                SELECT custom_metadata FROM media_items WHERE id = ${trackId}::uuid
            `;
            expect(row.custom_metadata.additional_artist_ids).toEqual([otherId, canonicalId]);
        });
    });

    // ========================================================================
    // healDanglingArtistIds
    // ========================================================================

    describe('healDanglingArtistIds', () => {
        type Meta = Record<string, unknown>;
        const insertArtist = async (title: string): Promise<string> => {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id)
                VALUES (${id}::uuid, ${title}, 'artist', 'active', NULL)
            `;
            return id;
        };
        const insertTrack = async (
            title: string,
            meta: Meta,
            locked = false,
            parentId: string | null = null,
        ): Promise<string> => {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id, metadata_locked, custom_metadata)
                VALUES (${id}::uuid, ${title}, 'track', 'active', ${parentId}, ${locked}, ${sql.json(meta as never)})
            `;
            return id;
        };
        const metaOf = async (id: string): Promise<Meta> => {
            const [row] = await sql<{ custom_metadata: Meta }[]>`
                SELECT custom_metadata FROM media_items WHERE id = ${id}::uuid
            `;
            return row.custom_metadata;
        };

        beforeEach(() => {
            resetArtistCreditEvidenceCache();
        });

        it('drops a hard-deleted id, re-links the intact scalar credit, and is idempotent', async () => {
            // Solo tracks make "Alpha Act" and "Beta Act" known artists, so the
            // ambiguous "und" joiner in the compilation credit may be split.
            // Two distinct tags per name (INDEPENDENT_CREDIT_MIN_TAGS).
            await insertTrack('solo a1', { artist: 'Alpha Act' });
            await insertTrack('solo a2', { artist: 'Alpha Act feat. Gamma One' });
            await insertTrack('solo b1', { artist: 'Beta Act' });
            await insertTrack('solo b2', { artist: 'Beta Act feat. Gamma Two' });
            const validId = await insertArtist('Valid Credit');
            const deadId = crypto.randomUUID(); // no media_items row, ever

            const trackId = await insertTrack('Compilation Track', {
                artist: 'Alpha Act und Beta Act',
                additional_artist_ids: [validId, deadId],
            });

            const first = await healDanglingArtistIds(sql);
            expect(first.tracks).toBe(1);
            expect(first.idsDropped).toBe(1);
            expect(first.failed).toBe(0);

            const meta = await metaOf(trackId);
            const ids = meta.additional_artist_ids as string[];
            expect(ids).not.toContain(deadId);
            expect(ids[0]).toBe(validId); // order of valid ids kept
            const linked = await sql<{ title: string }[]>`
                SELECT title FROM media_items WHERE id = ANY(${ids}::uuid[]) AND media_type = 'artist'
            `;
            expect(linked.map((r) => r.title).sort()).toEqual(
                ['Alpha Act', 'Beta Act', 'Valid Credit'].sort(),
            );

            const second = await healDanglingArtistIds(sql);
            expect(second).toEqual({ tracks: 0, idsDropped: 0, failed: 0 });
            expect(await metaOf(trackId)).toEqual(meta);
        });

        it('leaves metadata_locked tracks untouched', async () => {
            const deadId = crypto.randomUUID();
            const original = { artist: 'Alpha Act und Beta Act', additional_artist_ids: [deadId] };
            const trackId = await insertTrack('Locked Track', original, true);

            const result = await healDanglingArtistIds(sql);
            expect(result.tracks).toBe(0);
            expect(await metaOf(trackId)).toEqual(original);
        });

        it('ignores tracks with no array, an empty array, or only valid ids; tolerates junk entries', async () => {
            const validId = await insertArtist('Only Valid');
            const noKey = await insertTrack('no key', { artist: 'X' });
            const empty = await insertTrack('empty', { additional_artist_ids: [] });
            const valid = await insertTrack('valid', { additional_artist_ids: [validId] });
            const scalar = await insertTrack('not an array', { additional_artist_ids: 'oops' });
            const junk = await insertTrack('junk', {
                artist: 'Solo',
                additional_artist_ids: [validId, 'not-a-uuid'],
            });

            const result = await healDanglingArtistIds(sql);
            expect(result.tracks).toBe(1);
            const junkIds = (await metaOf(junk)).additional_artist_ids as string[];
            expect(junkIds[0]).toBe(validId);
            expect(junkIds).not.toContain('not-a-uuid');
            expect((await metaOf(noKey)).additional_artist_ids).toBeUndefined();
            expect((await metaOf(empty)).additional_artist_ids).toEqual([]);
            expect((await metaOf(valid)).additional_artist_ids).toEqual([validId]);
            expect((await metaOf(scalar)).additional_artist_ids).toBe('oops');
        });

        it('does not drop the id of a soft-deleted artist (healDeadArtistReferences owns it)', async () => {
            const softDeleted = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, parent_id)
                VALUES (${softDeleted}::uuid, ${'Soft Deleted Artist'}, 'artist', 'deleted', NULL)
            `;
            const trackId = await insertTrack('Refs Soft Deleted', {
                artist: 'Soft Deleted Artist',
                additional_artist_ids: [softDeleted],
            });
            const result = await healDanglingArtistIds(sql);
            expect(result.tracks).toBe(0);
            expect((await metaOf(trackId)).additional_artist_ids).toEqual([softDeleted]);
        });

        it('still drops the dead id when reconcile throws, and the next tick moves on', async () => {
            const deadId = crypto.randomUUID();
            const poison = await insertTrack('poison', {
                artist: 'Poison Solo',
                additional_artist_ids: [deadId],
            });
            // reconcile writes track_artist_credits; make that write fail for this row.
            await sql.unsafe(`
                CREATE OR REPLACE FUNCTION test_poison_reconcile() RETURNS trigger AS $$
                BEGIN
                    IF NEW.title = 'poison' AND NEW.custom_metadata ? 'track_artist_credits' THEN
                        RAISE EXCEPTION 'poisoned';
                    END IF;
                    RETURN NEW;
                END $$ LANGUAGE plpgsql`);
            await sql.unsafe(
                `CREATE TRIGGER test_poison_reconcile BEFORE UPDATE ON media_items
                 FOR EACH ROW EXECUTE FUNCTION test_poison_reconcile()`,
            );
            try {
                const first = await healDanglingArtistIds(sql, { limit: 1 });
                expect(first.failed).toBe(1);
                expect(first.firstError).toContain('poisoned');
                expect(first.idsDropped).toBe(1);
                expect((await metaOf(poison)).additional_artist_ids).toEqual([]);

                const later = await insertTrack('later', {
                    artist: 'Later Solo',
                    additional_artist_ids: [deadId],
                });
                const second = await healDanglingArtistIds(sql, { limit: 1 });
                expect(second.failed).toBe(0);
                expect(second.tracks).toBe(1);
                expect((await metaOf(later)).additional_artist_ids).not.toContain(deadId);
            } finally {
                await sql.unsafe('DROP TRIGGER IF EXISTS test_poison_reconcile ON media_items');
                await sql.unsafe('DROP FUNCTION IF EXISTS test_poison_reconcile()');
            }
        });

        it('works through a bounded batch per call and carries the rest over', async () => {
            const deadId = crypto.randomUUID();
            for (let i = 0; i < 3; i++) {
                await insertTrack(`batch ${i}`, {
                    artist: `Solo ${i}`,
                    additional_artist_ids: [deadId],
                });
            }
            const first = await healDanglingArtistIds(sql, { limit: 2 });
            expect(first.tracks).toBe(2);
            const second = await healDanglingArtistIds(sql, { limit: 2 });
            expect(second.tracks).toBe(1);
            expect((await healDanglingArtistIds(sql)).tracks).toBe(0);
        });
    });

    // ========================================================================
    // softDeleteOrphanMusicItems
    // ========================================================================

    describe('softDeleteOrphanMusicItems', () => {
        it('soft-deletes tracks with no media_file_items', async () => {
            const trackId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, created_at)
                VALUES (${trackId}::uuid, ${'Orphan Track'}, 'track', 'active', NOW() - INTERVAL '1 hour')
            `;

            const count = await softDeleteOrphanMusicItems(sql);
            expect(count).toBeGreaterThanOrEqual(1);

            const [row] = await sql<{ status: string }[]>`
                SELECT status FROM media_items WHERE id = ${trackId}::uuid
            `;
            expect(row.status).toBe('deleted');
        });

        it('does not delete tracks with file links', async () => {
            const trackId = crypto.randomUUID();
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, created_at)
                VALUES (${trackId}::uuid, ${'Linked Track'}, 'track', 'active', NOW() - INTERVAL '1 hour')
            `;
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${'/test/track.mp3'}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${trackId}::uuid)
            `;

            const _count = await softDeleteOrphanMusicItems(sql);
            const [row] = await sql<{ status: string }[]>`
                SELECT status FROM media_items WHERE id = ${trackId}::uuid
            `;
            expect(row.status).toBe('active');
        });

        it('does not soft-delete a soft-dismissed (recently) track', async () => {
            const trackId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, created_at, is_dismissed, dismissed_at)
                VALUES (${trackId}::uuid, ${'Dismissed Track'}, 'track', 'active', NOW() - INTERVAL '1 year', true, NOW())
            `;

            await softDeleteOrphanMusicItems(sql);

            const [row] = await sql<{ status: string }[]>`
                SELECT status FROM media_items WHERE id = ${trackId}::uuid
            `;
            expect(row.status).toBe('active');
        });

        it('still soft-deletes a genuinely orphaned, non-dismissed old track', async () => {
            const orphanId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, created_at, is_dismissed)
                VALUES (${orphanId}::uuid, ${'Old Orphan Track'}, 'track', 'active', NOW() - INTERVAL '1 year', false)
            `;

            await softDeleteOrphanMusicItems(sql);

            const [row] = await sql<{ status: string }[]>`
                SELECT status FROM media_items WHERE id = ${orphanId}::uuid
            `;
            expect(row.status).toBe('deleted');
        });
    });

    // ========================================================================
    // autoMergeDuplicateArtists — referenced loser albums
    // ========================================================================

    describe('autoMergeDuplicateArtists', () => {
        it('keeps localized VA decisions compatible with their duplicate winner', async () => {
            const [winner] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title,media_type,created_at) VALUES ('Çeşitli Sanatçılar','artist',NOW()-INTERVAL '2 days') RETURNING id`;
            const [loser] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title,media_type) VALUES ('Çeşitli Sanatçılar.','artist') RETURNING id`;
            const [album] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title,media_type,parent_id) VALUES ('Sampler','album',${loser.id}) RETURNING id`;
            const [track] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title,media_type,parent_id,custom_metadata) VALUES ('Song','track',${album.id},'{"compilation":true}'::jsonb) RETURNING id`;
            const [file] = await sql<
                { id: string }[]
            >`INSERT INTO media_files (file_path) VALUES (${'/music/' + track.id + '.mp3'}) RETURNING id`;
            await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${file.id},${track.id},true)`;
            const noop = (): void => {};
            expect(
                (await autoMergeDuplicateArtists(sql, { info: noop, warn: noop, debug: noop }))
                    .merged,
            ).toBe(1);
            expect(await sql`SELECT parent_id FROM media_items WHERE id=${album.id}`).toEqual([
                { parent_id: winner.id },
            ]);
        });

        it('merges punctuation variants with matching tag decisions and empty albums', async () => {
            const [winner] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title,media_type,created_at) VALUES ('Guns N Roses','artist', NOW()-INTERVAL '2 days') RETURNING id`;
            const [loser] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title,media_type) VALUES (${"Guns N' Roses"},'artist') RETURNING id`;
            const [album] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title,media_type,parent_id) VALUES ('Live','album',${loser.id}) RETURNING id`;
            await sql`INSERT INTO media_items (title,media_type,parent_id) VALUES ('Empty','album',${loser.id})`;
            const [track] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title,media_type,parent_id,custom_metadata) VALUES ('Song','track',${album.id},${sql.json({ album_artist: "Guns N' Roses" })}) RETURNING id`;
            const [file] = await sql<
                { id: string }[]
            >`INSERT INTO media_files (file_path) VALUES (${'/music/' + track.id + '.mp3'}) RETURNING id`;
            await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${file.id},${track.id},true)`;
            const noop = (): void => {};
            expect(
                (await autoMergeDuplicateArtists(sql, { info: noop, warn: noop, debug: noop }))
                    .merged,
            ).toBe(1);
            expect(await sql`SELECT 1 FROM media_items WHERE id=${loser.id}`).toHaveLength(0);
            expect(
                await sql`SELECT 1 FROM media_items WHERE media_type='album' AND parent_id=${winner.id}`,
            ).toHaveLength(2);
        });

        it("moves a referenced colliding loser album's references to the winner album and deletes both losers", async () => {
            const user = crypto.randomUUID();
            const winner = crypto.randomUUID(),
                loser = crypto.randomUUID();
            const winHits = crypto.randomUUID(),
                winB = crypto.randomUUID(),
                loseHits = crypto.randomUUID(),
                loseB = crypto.randomUUID(),
                trackHits = crypto.randomUUID(),
                trackB = crypto.randomUUID();
            await sql`INSERT INTO users (id, username) VALUES (${user}, ${user})`;
            try {
                // VA aliases fold to one norm, so both may be active at once.
                await sql`INSERT INTO media_items (id, title, media_type, status, created_at) VALUES
                    (${winner}, 'Various Artists', 'artist', 'active', NOW() - INTERVAL '2 days'),
                    (${loser}, 'VA', 'artist', 'active', NOW() - INTERVAL '1 day')`;
                await sql`INSERT INTO media_items (id, title, media_type, status, parent_id, has_files) VALUES
                    (${winHits}, 'Hits', 'album', 'active', ${winner}, true),
                    (${winB}, 'B-Sides', 'album', 'active', ${winner}, true),
                    (${loseHits}, 'Hits', 'album', 'active', ${loser}, true),
                    (${loseB}, 'B-Sides', 'album', 'active', ${loser}, true)`;
                await sql`INSERT INTO media_items (id, title, media_type, status, parent_id) VALUES
                    (${trackHits}, 'Hit', 'track', 'active', ${loseHits}),
                    (${trackB}, 'B', 'track', 'active', ${loseB})`;
                await sql`INSERT INTO user_media_state (media_id, user_id, is_favorite) VALUES (${loseHits}, ${user}, true)`;

                for (const id of [trackHits, trackB]) {
                    await sql`UPDATE media_items SET custom_metadata='{"compilation":true}'::jsonb WHERE id=${id}`;
                    const [file] = await sql<
                        { id: string }[]
                    >`INSERT INTO media_files (file_path) VALUES (${'/music/fixtures/' + id + '.mp3'}) RETURNING id`;
                    await sql`INSERT INTO media_file_items (file_id,media_item_id,is_default) VALUES (${file.id},${id},true)`;
                }

                const noop = (): void => {};
                const outcome = await autoMergeDuplicateArtists(sql, {
                    info: noop,
                    warn: noop,
                    debug: noop,
                });
                expect(outcome.merged).toBe(1);

                const rows = await sql<
                    { id: string; status: string; parent_id: string | null; has_files: boolean }[]
                >`SELECT id::text, status, parent_id::text, has_files FROM media_items
                  WHERE id = ANY(${[loser, loseHits, loseB, trackHits, trackB]}::uuid[])`;
                const byId = new Map(rows.map((r) => [r.id, r]));
                expect(byId.has(loser)).toBe(false);
                expect(byId.has(loseB)).toBe(false);
                expect(byId.has(loseHits)).toBe(false);
                expect(byId.get(trackHits)?.parent_id).toBe(winHits);
                expect(byId.get(trackB)?.parent_id).toBe(winB);
                expect(
                    await sql`SELECT media_id::text, is_favorite FROM user_media_state WHERE user_id = ${user}`,
                ).toEqual([{ media_id: winHits, is_favorite: true }]);
            } finally {
                await sql`DELETE FROM user_media_state WHERE user_id = ${user}`;
                await sql`DELETE FROM users WHERE id = ${user}`;
            }
        });
    });

    // ========================================================================
    // findHardDeletableMediaIds
    // ========================================================================

    describe('findHardDeletableMediaIds', () => {
        it('finds soft-deleted items older than cutoff with no active children', async () => {
            const oldDeletedId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, updated_at)
                VALUES (${oldDeletedId}::uuid, ${'Old Deleted'}, 'movie', 'deleted', NOW() - INTERVAL '10 days')
            `;

            const ids = await findHardDeletableMediaIds(
                sql,
                new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
                100,
            );
            expect(ids).toContain(oldDeletedId);
        });

        it('excludes items with active children', async () => {
            const parentId = crypto.randomUUID();
            const childId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, updated_at)
                VALUES (${parentId}::uuid, ${'Parent'}, 'tv', 'deleted', NOW() - INTERVAL '10 days')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
                VALUES (${childId}::uuid, ${'Child'}, 'season', ${parentId}::uuid, 1, 'active')
            `;

            const ids = await findHardDeletableMediaIds(
                sql,
                new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
                100,
            );
            expect(ids).not.toContain(parentId);
        });
    });

    // ========================================================================
    // Audiobook safety net
    // ========================================================================

    describe('audiobook rows are invisible to every cleanup sweep', () => {
        // Audiobooks are the only media type stored with `has_files = true` and
        // ZERO `media_file_items` — the bytes live on the Audiobookshelf server
        // and playback resolves through `external_ids`. Every physical guard in
        // this module ("no file rows" ⇒ orphan) would therefore classify a
        // perfectly healthy book as garbage. Today they are safe only because
        // each sweep happens to be scoped to other media types; nothing pinned
        // that, and the whole `has_files = true` decision rests on it.

        async function seedAudiobook(): Promise<string> {
            const id = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status, has_files, created_at)
                VALUES (${id}::uuid, ${'Ein Hörbuch'}, 'audiobook', 'active', true,
                        NOW() - INTERVAL '2 days')
            `;
            return id;
        }

        async function readRow(
            id: string,
        ): Promise<{ status: string; has_files: boolean; is_dismissed: boolean }> {
            const [row] = await sql<
                Array<{ status: string; has_files: boolean; is_dismissed: boolean }>
            >`SELECT status, has_files, is_dismissed FROM media_items WHERE id = ${id}::uuid`;
            return row;
        }

        it('survives softDeleteOrphanMediaStubs with has_files intact', async () => {
            const id = await seedAudiobook();

            await softDeleteOrphanMediaStubs(sql);

            expect(await readRow(id)).toMatchObject({ status: 'active', has_files: true });
        });

        it('survives softDeleteOrphanMusicItems with has_files intact', async () => {
            const id = await seedAudiobook();

            await softDeleteOrphanMusicItems(sql);

            expect(await readRow(id)).toMatchObject({ status: 'active', has_files: true });
        });

        it('is not resurrected by backfillHasFilesMediaItems after a dismissal', async () => {
            // The sweep dismisses a book that vanished upstream by setting
            // has_files = false. The backfill only moves false → true for rows
            // that DO have file rows, so it must leave this one alone —
            // otherwise a gone book would grow a live Listen button again.
            const id = await seedAudiobook();
            await sql`
                UPDATE media_items SET has_files = false, is_dismissed = true
                WHERE id = ${id}::uuid
            `;

            await backfillHasFilesMediaItems(sql);

            expect(await readRow(id)).toMatchObject({
                status: 'active',
                has_files: false,
                is_dismissed: true,
            });
        });

        it('is never offered to the hard-delete purge while active', async () => {
            // findHardDeletableMediaIds' only physical guard is "no
            // media_file_items", which every audiobook passes trivially. Its
            // status filter is the sole thing keeping books out of a purge that
            // destroys ratings, sessions and watchlist entries — which is why
            // the sweep may only ever dismiss, never write status = 'deleted'.
            const id = await seedAudiobook();
            await sql`
                UPDATE media_items
                SET has_files = false, is_dismissed = true, updated_at = NOW() - INTERVAL '90 days'
                WHERE id = ${id}::uuid
            `;

            const ids = await findHardDeletableMediaIds(
                sql,
                new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
                100,
            );

            expect(ids).not.toContain(id);
        });
    });

    // ========================================================================
    // cleanupOrphanedMediaFiles
    // ========================================================================

    describe('cleanupOrphanedMediaFiles', () => {
        it('deletes media_files with no media_file_items', async () => {
            const orphanFileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${orphanFileId}::uuid, ${'/test/orphan.mkv'}, NOW(), NOW())
            `;

            const count = await cleanupOrphanedMediaFiles(sql, 100);
            expect(count).toBeGreaterThanOrEqual(1);

            const [row] = await sql<{ id: string }[]>`
                SELECT id FROM media_files WHERE id = ${orphanFileId}::uuid
            `;
            expect(row).toBeUndefined();
        });

        it('skips files with linked media_file_items', async () => {
            const fileId = crypto.randomUUID();
            const mediaId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${mediaId}::uuid, ${'Linked'}, 'movie', 'active')
            `;
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${'/test/linked.mkv'}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${mediaId}::uuid)
            `;

            const _count = await cleanupOrphanedMediaFiles(sql, 100);
            const [row] = await sql<{ id: string }[]>`
                SELECT id FROM media_files WHERE id = ${fileId}::uuid
            `;
            expect(row.id).toBe(fileId);
        });
    });

    // ========================================================================
    // purgeStageStateForDeletedItems
    // ========================================================================

    describe('purgeStageStateForDeletedItems', () => {
        it('deletes stage_state for soft-deleted media', async () => {
            const mediaId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${mediaId}::uuid, ${'Deleted'}, 'movie', 'deleted')
            `;
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, status, processing_version)
                VALUES (${mediaId}::uuid, 'test-stage', 'pending', 1)
            `;

            const count = await purgeStageStateForDeletedItems(sql);
            expect(count).toBeGreaterThanOrEqual(1);

            const [row] = await sql<{ media_item_id: string }[]>`
                SELECT media_item_id FROM media_item_stage_state
                WHERE media_item_id = ${mediaId}::uuid
            `;
            expect(row).toBeUndefined();
        });

        it('preserves stage_state for active media', async () => {
            const mediaId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${mediaId}::uuid, ${'Active'}, 'movie', 'active')
            `;
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, status, processing_version)
                VALUES (${mediaId}::uuid, 'test-stage', 'pending', 1)
            `;

            const _count = await purgeStageStateForDeletedItems(sql);

            const [row] = await sql<{ media_item_id: string }[]>`
                SELECT media_item_id FROM media_item_stage_state
                WHERE media_item_id = ${mediaId}::uuid
            `;
            expect(row.media_item_id).toBe(mediaId);
        });
    });
});
