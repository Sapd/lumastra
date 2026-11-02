// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Library Paths Query Module
 *
 * Tests CRUD operations: create, read, update, delete, and enable/disable.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    validateGroupProviderConsistency,
    getAllLibraryPaths,
    getEnabledLibraryPaths,
    getLibraryPathById,
    getLibraryPathsByGroup,
    createLibraryPath,
    updateLibraryPath,
    deleteLibraryPath,
    restampLibraryPathFileGroups,
    type LibraryPathRow,
} from './library-paths.queries.js';

const TEST_GROUP_ID = '00000000-0000-0000-0000-000000000001';
const TEST_GROUP_ID_2 = '00000000-0000-0000-0000-000000000002';

describe('Library Paths Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();

        await sql`INSERT INTO library_groups (id, name) VALUES (${TEST_GROUP_ID}, 'Test Library') ON CONFLICT DO NOTHING`;
        await sql`INSERT INTO library_groups (id, name) VALUES (${TEST_GROUP_ID_2}, 'Test Library 2') ON CONFLICT DO NOTHING`;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    afterEach(async () => {
        // Clean up all library paths after each test
        await sql`DELETE FROM library_paths`;
    });

    // -------------------------------------------------------------------------
    // createLibraryPath
    // -------------------------------------------------------------------------

    describe('createLibraryPath', () => {
        it('creates a library path with required fields', async () => {
            const created = await createLibraryPath(sql, {
                path: '/mnt/media/movies',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });

            expect(created.id).toBeDefined();
            expect(created.path).toBe('/mnt/media/movies');
            expect(created.media_type).toBe('movie');
            expect(created.language).toBe('en');
            expect(created.provider).toBe('tmdb');
            expect(created.enabled).toBe(true);
            expect(created.provider_path).toBeNull();
            expect(created.created_at).toBeInstanceOf(Date);
            expect(created.updated_at).toBeInstanceOf(Date);
        });

        it('creates a library path with all fields specified', async () => {
            const created = await createLibraryPath(sql, {
                path: '/anime/raw',
                media_type: 'anime',
                language: 'ja',
                provider: 'anidb',
                library_group_id: TEST_GROUP_ID,
            });

            expect(created.path).toBe('/anime/raw');
            expect(created.media_type).toBe('anime');
            expect(created.language).toBe('ja');
            expect(created.provider).toBe('anidb');
        });

        it('creates a library path with provider_path', async () => {
            const created = await createLibraryPath(sql, {
                path: '/mnt/media/movies',
                media_type: 'movie',
                provider_path: '/data/movies',
                library_group_id: TEST_GROUP_ID,
            });

            expect(created.provider_path).toBe('/data/movies');
        });

        it('creates a library path without provider_path (null by default)', async () => {
            const created = await createLibraryPath(sql, {
                path: '/mnt/media/tv',
                media_type: 'tv',
                library_group_id: TEST_GROUP_ID,
            });

            expect(created.provider_path).toBeNull();
        });

        it('creates a library path with fallback_providers', async () => {
            const created = await createLibraryPath(sql, {
                path: '/anime',
                media_type: 'anime',
                language: 'ja',
                provider: 'tmdb',
                fallback_providers: ['anidb'],
                library_group_id: TEST_GROUP_ID,
            });
            expect(created.fallback_providers).toEqual(['anidb']);
        });

        it('defaults fallback_providers to empty array', async () => {
            const created = await createLibraryPath(sql, {
                path: '/tv',
                media_type: 'tv',
                language: 'en',
                library_group_id: TEST_GROUP_ID,
            });
            expect(created.fallback_providers).toEqual([]);
        });

        it('creates multiple paths independently', async () => {
            await createLibraryPath(sql, {
                path: '/movies',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            await createLibraryPath(sql, {
                path: '/tv',
                media_type: 'tv',
                library_group_id: TEST_GROUP_ID,
            });

            const all = await getAllLibraryPaths(sql);
            expect(all).toHaveLength(2);
        });
    });

    // -------------------------------------------------------------------------
    // getAllLibraryPaths
    // -------------------------------------------------------------------------

    describe('getAllLibraryPaths', () => {
        it('returns empty array when no paths exist', async () => {
            const paths = await getAllLibraryPaths(sql);
            expect(paths).toEqual([]);
        });

        it('returns all paths ordered by created_at ASC', async () => {
            const first = await createLibraryPath(sql, {
                path: '/first',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            // Small delay to ensure distinct created_at timestamps and
            // place both in the same library_group so order is by created_at.
            await new Promise((r) => setTimeout(r, 10));
            await createLibraryPath(sql, {
                path: '/second',
                media_type: 'tv',
                library_group_id: first.library_group_id,
            });

            const paths = await getAllLibraryPaths(sql);
            expect(paths).toHaveLength(2);
            expect(paths[0].path).toBe('/first');
            expect(paths[1].path).toBe('/second');
        });

        it('includes both enabled and disabled paths', async () => {
            const p1 = await createLibraryPath(sql, {
                path: '/movies',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            await updateLibraryPath(sql, p1.id, { enabled: false });

            const paths = await getAllLibraryPaths(sql);
            expect(paths).toHaveLength(1);
            expect(paths[0].enabled).toBe(false);
        });
    });

    // -------------------------------------------------------------------------
    // getEnabledLibraryPaths
    // -------------------------------------------------------------------------

    describe('getEnabledLibraryPaths', () => {
        it('returns only enabled paths', async () => {
            const p1 = await createLibraryPath(sql, {
                path: '/movies',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            const p2 = await createLibraryPath(sql, {
                path: '/tv',
                media_type: 'tv',
                library_group_id: TEST_GROUP_ID,
            });
            await updateLibraryPath(sql, p2.id, { enabled: false });

            const enabled = await getEnabledLibraryPaths(sql);
            expect(enabled).toHaveLength(1);
            expect(enabled[0].id).toBe(p1.id);
        });

        it('returns empty array when all paths are disabled', async () => {
            const p1 = await createLibraryPath(sql, {
                path: '/movies',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            await updateLibraryPath(sql, p1.id, { enabled: false });

            const enabled = await getEnabledLibraryPaths(sql);
            expect(enabled).toEqual([]);
        });

        /**
         * A remote-provider row's `path` is a synthetic URI, not a directory.
         * Everything reached from this query walks, stats, watches or
         * sandbox-checks a real directory, so the default must not return it.
         *
         * Inserted with raw SQL on purpose: what the synthetic path looks like
         * is decided by the audiobookshelf connector, and the filter keys off
         * `provider` alone — the test should not bake in a path format.
         */
        async function insertRemotePath(path: string): Promise<string> {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO library_paths (path, media_type, provider, provider_path, library_group_id)
                VALUES (${path}, 'audiobook', 'audiobookshelf', 'abs-library-1', ${TEST_GROUP_ID}::uuid)
                RETURNING id
            `;
            return row.id;
        }

        it('excludes enabled audiobookshelf paths by default', async () => {
            const fsPath = await createLibraryPath(sql, {
                path: '/movies',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            await insertRemotePath('abs://abs-library-1');

            const enabled = await getEnabledLibraryPaths(sql);

            expect(enabled).toHaveLength(1);
            expect(enabled[0].id).toBe(fsPath.id);
            expect(enabled.map((p) => p.provider)).not.toContain('audiobookshelf');
        });

        it('returns audiobookshelf paths with includeRemote: true', async () => {
            const fsPath = await createLibraryPath(sql, {
                path: '/movies',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            const remoteId = await insertRemotePath('abs://abs-library-1');

            const enabled = await getEnabledLibraryPaths(sql, { includeRemote: true });

            expect(enabled.map((p) => p.id).sort()).toEqual([fsPath.id, remoteId].sort());
            const remote = enabled.find((p) => p.id === remoteId);
            expect(remote?.provider).toBe('audiobookshelf');
            expect(remote?.provider_path).toBe('abs-library-1');
        });

        it('still honours enabled = false for remote paths under includeRemote', async () => {
            const remoteId = await insertRemotePath('abs://abs-library-1');
            await updateLibraryPath(sql, remoteId, { enabled: false });

            const enabled = await getEnabledLibraryPaths(sql, { includeRemote: true });

            expect(enabled).toEqual([]);
        });

        it('keeps every filesystem provider visible under the default', async () => {
            for (const provider of ['tmdb', 'jellyfin', 'anidb', 'tvdb', 'musicbrainz'] as const) {
                await createLibraryPath(sql, {
                    path: `/media/${provider}`,
                    media_type: 'movie',
                    provider,
                    library_group_id: TEST_GROUP_ID,
                });
            }

            const enabled = await getEnabledLibraryPaths(sql);

            expect(enabled.map((p) => p.provider).sort()).toEqual([
                'anidb',
                'jellyfin',
                'musicbrainz',
                'tmdb',
                'tvdb',
            ]);
        });
    });

    // -------------------------------------------------------------------------
    // getLibraryPathById
    // -------------------------------------------------------------------------

    describe('getLibraryPathById', () => {
        it('returns the path when it exists', async () => {
            const created = await createLibraryPath(sql, {
                path: '/music',
                media_type: 'music',
                library_group_id: TEST_GROUP_ID,
            });

            const found = await getLibraryPathById(sql, created.id);
            expect(found).not.toBeNull();
            expect((found as LibraryPathRow).id).toBe(created.id);
            expect((found as LibraryPathRow).path).toBe('/music');
        });

        it('returns null for non-existent id', async () => {
            const result = await getLibraryPathById(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBeNull();
        });
    });

    // -------------------------------------------------------------------------
    // updateLibraryPath
    // -------------------------------------------------------------------------

    describe('updateLibraryPath', () => {
        it('updates the enabled flag', async () => {
            const created = await createLibraryPath(sql, {
                path: '/movies',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            expect(created.enabled).toBe(true);

            const updated = await updateLibraryPath(sql, created.id, {
                enabled: false,
            });
            expect(updated).not.toBeNull();
            expect((updated as LibraryPathRow).enabled).toBe(false);
        });

        it('updates the path string', async () => {
            const created = await createLibraryPath(sql, {
                path: '/old-path',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });

            const updated = await updateLibraryPath(sql, created.id, {
                path: '/new-path',
            });
            expect((updated as LibraryPathRow).path).toBe('/new-path');
        });

        it('updates language and provider independently', async () => {
            const created = await createLibraryPath(sql, {
                path: '/anime',
                media_type: 'anime',
                library_group_id: TEST_GROUP_ID,
            });

            const updated = await updateLibraryPath(sql, created.id, {
                language: 'ja',
                provider: 'anidb',
            });
            expect((updated as LibraryPathRow).language).toBe('ja');
            expect((updated as LibraryPathRow).provider).toBe('anidb');
            // Path should be unchanged
            expect((updated as LibraryPathRow).path).toBe('/anime');
        });

        it('returns null for non-existent id', async () => {
            const result = await updateLibraryPath(sql, '00000000-0000-0000-0000-000000000000', {
                enabled: false,
            });
            expect(result).toBeNull();
        });

        it('updates fallback_providers', async () => {
            const created = await createLibraryPath(sql, {
                path: '/tv',
                media_type: 'tv',
                language: 'en',
                library_group_id: TEST_GROUP_ID,
            });
            const updated = await updateLibraryPath(sql, created.id, {
                fallback_providers: ['anidb', 'jellyfin'],
            });
            expect((updated as LibraryPathRow).fallback_providers).toEqual(['anidb', 'jellyfin']);
        });

        it('clears fallback_providers by setting to empty array', async () => {
            const created = await createLibraryPath(sql, {
                path: '/tv',
                media_type: 'tv',
                language: 'en',
                fallback_providers: ['anidb'],
                library_group_id: TEST_GROUP_ID,
            });
            const updated = await updateLibraryPath(sql, created.id, {
                fallback_providers: [],
            });
            expect((updated as LibraryPathRow).fallback_providers).toEqual([]);
        });

        it('sets provider_path on an existing path', async () => {
            const created = await createLibraryPath(sql, {
                path: '/mnt/media/movies',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            expect(created.provider_path).toBeNull();

            const updated = await updateLibraryPath(sql, created.id, {
                provider_path: '/data/movies',
            });
            expect((updated as LibraryPathRow).provider_path).toBe('/data/movies');
        });

        it('clears provider_path by setting it to null', async () => {
            const created = await createLibraryPath(sql, {
                path: '/mnt/media/movies',
                media_type: 'movie',
                provider_path: '/data/movies',
                library_group_id: TEST_GROUP_ID,
            });

            const updated = await updateLibraryPath(sql, created.id, {
                provider_path: null,
            });
            expect((updated as LibraryPathRow).provider_path).toBeNull();
        });

        it('updates updated_at timestamp', async () => {
            const created = await createLibraryPath(sql, {
                path: '/movies',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });

            // Small delay to ensure different timestamp
            await new Promise((r) => setTimeout(r, 10));
            const updated = await updateLibraryPath(sql, created.id, {
                enabled: false,
            });

            expect((updated as LibraryPathRow).updated_at.getTime()).toBeGreaterThanOrEqual(
                created.updated_at.getTime(),
            );
        });
    });

    // -------------------------------------------------------------------------
    // deleteLibraryPath
    // -------------------------------------------------------------------------

    describe('deleteLibraryPath', () => {
        it('deletes an existing path and returns true', async () => {
            const created = await createLibraryPath(sql, {
                path: '/to-delete',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });

            const result = await deleteLibraryPath(sql, created.id);
            expect(result).toBe(true);

            const check = await getLibraryPathById(sql, created.id);
            expect(check).toBeNull();
        });

        it('returns false for non-existent id', async () => {
            const result = await deleteLibraryPath(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBe(false);
        });

        it('does not affect other paths when deleting one', async () => {
            const p1 = await createLibraryPath(sql, {
                path: '/keep',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            const p2 = await createLibraryPath(sql, {
                path: '/delete',
                media_type: 'tv',
                library_group_id: TEST_GROUP_ID,
            });

            await deleteLibraryPath(sql, p2.id);

            const remaining = await getAllLibraryPaths(sql);
            expect(remaining).toHaveLength(1);
            expect(remaining[0].id).toBe(p1.id);
        });
    });

    // -------------------------------------------------------------------------
    // library_group_id
    // -------------------------------------------------------------------------

    describe('library_group_id', () => {
        it('uses the provided library_group_id', async () => {
            const p1 = await createLibraryPath(sql, {
                path: '/movies/standard',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });

            expect(p1.library_group_id).toBe(TEST_GROUP_ID);

            // Second path joins the same group
            const p2 = await createLibraryPath(sql, {
                path: '/movies/4k',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });

            expect(p2.library_group_id).toBe(p1.library_group_id);
        });

        it('getAllLibraryPaths orders by library_group_id then created_at', async () => {
            const p1 = await createLibraryPath(sql, {
                path: '/z-path',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            const p2 = await createLibraryPath(sql, {
                path: '/a-path',
                media_type: 'tv',
                library_group_id: p1.library_group_id,
            });

            const all = await getAllLibraryPaths(sql);
            expect(all).toHaveLength(2);
            // Both share the same group, so ordered by created_at ASC
            expect(all[0].id).toBe(p1.id);
            expect(all[1].id).toBe(p2.id);
        });

        it('updates library_group_id to reassign path to another group', async () => {
            const p1 = await createLibraryPath(sql, {
                path: '/movies',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            const p2 = await createLibraryPath(sql, {
                path: '/movies-4k',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });

            // Move p2 into p1's group
            const updated = await updateLibraryPath(sql, p2.id, {
                library_group_id: p1.library_group_id,
            });

            expect((updated as LibraryPathRow).library_group_id).toBe(p1.library_group_id);
        });

        it('preserves library_group_id when updating other fields', async () => {
            const created = await createLibraryPath(sql, {
                path: '/movies',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            const originalGroupId = created.library_group_id;

            const updated = await updateLibraryPath(sql, created.id, {
                language: 'de',
            });

            expect((updated as LibraryPathRow).library_group_id).toBe(originalGroupId);
        });
    });

    // -------------------------------------------------------------------------
    // getLibraryPathsByGroup
    // -------------------------------------------------------------------------

    describe('getLibraryPathsByGroup', () => {
        it('returns empty array for non-existent group', async () => {
            const result = await getLibraryPathsByGroup(
                sql,
                '00000000-0000-0000-0000-000000000000',
            );
            expect(result).toEqual([]);
        });

        it('returns all paths in a group', async () => {
            const p1 = await createLibraryPath(sql, {
                path: '/movies/standard',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            const p2 = await createLibraryPath(sql, {
                path: '/movies/4k',
                media_type: 'movie',
                library_group_id: p1.library_group_id,
            });
            // Different group — should not be returned
            await createLibraryPath(sql, {
                path: '/tv',
                media_type: 'tv',
                library_group_id: TEST_GROUP_ID_2,
            });

            const group = await getLibraryPathsByGroup(sql, p1.library_group_id);
            expect(group).toHaveLength(2);
            expect(group.map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort());
        });

        it('returns paths ordered by created_at ASC', async () => {
            const p1 = await createLibraryPath(sql, {
                path: '/first',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            const p2 = await createLibraryPath(sql, {
                path: '/second',
                media_type: 'movie',
                library_group_id: p1.library_group_id,
            });

            const group = await getLibraryPathsByGroup(sql, p1.library_group_id);
            expect(group[0].id).toBe(p1.id);
            expect(group[1].id).toBe(p2.id);
        });

        it('returns single path when group has one member', async () => {
            const p1 = await createLibraryPath(sql, {
                path: '/solo',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });

            const group = await getLibraryPathsByGroup(sql, p1.library_group_id);
            expect(group).toHaveLength(1);
            expect(group[0].id).toBe(p1.id);
        });
    });

    // -------------------------------------------------------------------------
    // edition_label
    // -------------------------------------------------------------------------

    describe('edition_label', () => {
        it('defaults to null when not provided', async () => {
            const created = await createLibraryPath(sql, {
                path: '/movies',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });

            expect(created.edition_label).toBeNull();
        });

        it('stores edition_label when provided on create', async () => {
            const created = await createLibraryPath(sql, {
                path: '/movies/4k',
                media_type: 'movie',
                edition_label: '4k',
                library_group_id: TEST_GROUP_ID,
            });

            expect(created.edition_label).toBe('4k');
        });

        it('sets edition_label via update', async () => {
            const created = await createLibraryPath(sql, {
                path: '/movies',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            expect(created.edition_label).toBeNull();

            const updated = await updateLibraryPath(sql, created.id, {
                edition_label: 'directors_cut',
            });

            expect((updated as LibraryPathRow).edition_label).toBe('directors_cut');
        });

        it('clears edition_label by setting to null', async () => {
            const created = await createLibraryPath(sql, {
                path: '/movies/4k',
                media_type: 'movie',
                edition_label: '4k',
                library_group_id: TEST_GROUP_ID,
            });

            const updated = await updateLibraryPath(sql, created.id, {
                edition_label: null,
            });

            expect((updated as LibraryPathRow).edition_label).toBeNull();
        });

        it('preserves edition_label when updating other fields', async () => {
            const created = await createLibraryPath(sql, {
                path: '/movies/4k',
                media_type: 'movie',
                edition_label: '4k',
                library_group_id: TEST_GROUP_ID,
            });

            const updated = await updateLibraryPath(sql, created.id, {
                language: 'fr',
            });

            expect((updated as LibraryPathRow).edition_label).toBe('4k');
        });

        it('getLibraryPathsByGroup includes edition_label', async () => {
            const p1 = await createLibraryPath(sql, {
                path: '/movies/standard',
                media_type: 'movie',
                library_group_id: TEST_GROUP_ID,
            });
            await createLibraryPath(sql, {
                path: '/movies/4k',
                media_type: 'movie',
                library_group_id: p1.library_group_id,
                edition_label: '4k',
            });

            const group = await getLibraryPathsByGroup(sql, p1.library_group_id);
            const labels = group.map((p) => p.edition_label);
            expect(labels).toContain(null);
            expect(labels).toContain('4k');
        });
    });

    // Folder names deliberately don't describe a provider — this rule must key
    // only off the stored `provider`/`fallback_providers` columns.
    describe('validateGroupProviderConsistency', () => {
        it('returns null for an empty group', async () => {
            const error = await validateGroupProviderConsistency(sql, TEST_GROUP_ID, 'tmdb', []);
            expect(error).toBeNull();
        });

        it('returns null when provider and fallback_providers match', async () => {
            await createLibraryPath(sql, {
                path: '/srv/stuff/a',
                media_type: 'movie',
                provider: 'anidb',
                fallback_providers: ['tmdb'],
                library_group_id: TEST_GROUP_ID,
            });

            const error = await validateGroupProviderConsistency(sql, TEST_GROUP_ID, 'anidb', [
                'tmdb',
            ]);
            expect(error).toBeNull();
        });

        it('rejects a provider that conflicts with the existing folder', async () => {
            await createLibraryPath(sql, {
                path: '/srv/stuff/a',
                media_type: 'movie',
                provider: 'anidb',
                library_group_id: TEST_GROUP_ID,
            });

            const error = await validateGroupProviderConsistency(sql, TEST_GROUP_ID, 'tmdb', []);
            expect(error).toContain('anidb');
        });

        it('rejects a fallback_providers mismatch even when provider matches', async () => {
            await createLibraryPath(sql, {
                path: '/srv/stuff/a',
                media_type: 'movie',
                provider: 'tmdb',
                fallback_providers: ['anidb'],
                library_group_id: TEST_GROUP_ID,
            });

            const error = await validateGroupProviderConsistency(sql, TEST_GROUP_ID, 'tmdb', [
                'jellyfin',
            ]);
            expect(error).not.toBeNull();
        });

        it('excludes the path being edited from the check', async () => {
            const created = await createLibraryPath(sql, {
                path: '/srv/stuff/a',
                media_type: 'movie',
                provider: 'anidb',
                library_group_id: TEST_GROUP_ID,
            });

            const error = await validateGroupProviderConsistency(
                sql,
                TEST_GROUP_ID,
                'tmdb',
                [],
                created.id,
            );
            expect(error).toBeNull();
        });
    });
    // -------------------------------------------------------------------------
    // restampLibraryPathFileGroups
    // -------------------------------------------------------------------------

    describe('restampLibraryPathFileGroups', () => {
        afterEach(async () => {
            await sql`DELETE FROM media_files WHERE file_path LIKE '/restamp/%'`;
        });

        it('moves the files under the folder (and only those) to the new group', async () => {
            await sql`
                INSERT INTO media_files (file_path, library_group_id) VALUES
                    ('/restamp/movies/a.mkv', ${TEST_GROUP_ID}::uuid),
                    ('/restamp/movies/sub/b.mkv', ${TEST_GROUP_ID}::uuid),
                    ('/restamp/movies-4k/c.mkv', ${TEST_GROUP_ID}::uuid),
                    ('/restamp/movies%/d.mkv', ${TEST_GROUP_ID}::uuid)
            `;

            const n = await restampLibraryPathFileGroups(sql, '/restamp/movies', TEST_GROUP_ID_2);

            expect(n).toBe(2);
            const rows = await sql<{ file_path: string; library_group_id: string | null }[]>`
                SELECT file_path, library_group_id FROM media_files
                WHERE file_path LIKE '/restamp/%' ORDER BY file_path
            `;
            // Collation decides ORDER BY for '%' / '-' / '/', so compare as a map.
            expect(Object.fromEntries(rows.map((r) => [r.file_path, r.library_group_id]))).toEqual({
                '/restamp/movies%/d.mkv': TEST_GROUP_ID,
                '/restamp/movies-4k/c.mkv': TEST_GROUP_ID,
                '/restamp/movies/a.mkv': TEST_GROUP_ID_2,
                '/restamp/movies/sub/b.mkv': TEST_GROUP_ID_2,
            });
        });

        it('can clear the group', async () => {
            await sql`
                INSERT INTO media_files (file_path, library_group_id)
                VALUES ('/restamp/x/a.mkv', ${TEST_GROUP_ID}::uuid)
            `;
            expect(await restampLibraryPathFileGroups(sql, '/restamp/x', null)).toBe(1);
            const [row] = await sql<{ library_group_id: string | null }[]>`
                SELECT library_group_id FROM media_files WHERE file_path = '/restamp/x/a.mkv'
            `;
            expect(row.library_group_id).toBeNull();
        });
    });
});
