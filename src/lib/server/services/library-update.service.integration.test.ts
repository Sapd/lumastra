// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the "update a library" service against a real
 * Postgres database: the transactional fan-out (every folder in the group
 * ends up with the new media_type/provider/fallback_providers, or none of
 * them do), and the remote-folder conflict leaving everything unchanged.
 *
 * Group/folder names and paths deliberately do NOT describe their type or
 * provider (e.g. a movie library named "Family Vault", folders under
 * `/srv/stuff/`) — the service must key only off stored fields, never off a
 * name or path string.
 */
import { randomUUID } from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { getLibraryPathsByGroup } from '$lib/server/database/queries/library-paths.queries.js';
import { getLibraryGroupById } from '$lib/server/database/queries/library-groups.queries.js';
import { updateLibrary, RemoteLibraryConflictError } from './library-update.service.js';

describe('updateLibrary (integration)', () => {
    let sql: postgres.Sql;
    const createdGroupIds: string[] = [];

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        if (createdGroupIds.length > 0) {
            await sql`DELETE FROM library_group_permissions WHERE library_group_id IN ${sql(createdGroupIds)}`;
            await sql`DELETE FROM library_paths WHERE library_group_id IN ${sql(createdGroupIds)}`;
            await sql`DELETE FROM library_groups WHERE id IN ${sql(createdGroupIds)}`;
        }
        await closeTestDb();
    });

    async function makeLibrary(
        folders: { path: string; media_type: string; provider: string }[],
    ): Promise<string> {
        const groupId = randomUUID();
        createdGroupIds.push(groupId);
        await sql`INSERT INTO library_groups (id, name) VALUES (${groupId}, 'Family Vault')`;
        for (const f of folders) {
            await sql`
                INSERT INTO library_paths (id, path, media_type, provider, library_group_id)
                VALUES (${randomUUID()}, ${f.path}, ${f.media_type}, ${f.provider}, ${groupId})
            `;
        }
        return groupId;
    }

    it('fans media_type/provider/fallback_providers out to every folder in one transaction', async () => {
        const groupId = await makeLibrary([
            { path: '/srv/stuff/a', media_type: 'movie', provider: 'tmdb' },
            { path: '/srv/stuff/b', media_type: 'movie', provider: 'tmdb' },
            { path: '/srv/stuff/c', media_type: 'movie', provider: 'tmdb' },
        ]);

        const result = await updateLibrary(sql, groupId, {
            media_type: 'anime',
            provider: 'anidb',
            fallback_providers: ['tmdb'],
        });

        expect(result).not.toBeNull();
        expect(result?.paths).toHaveLength(3);

        const paths = await getLibraryPathsByGroup(sql, groupId);
        expect(paths).toHaveLength(3);
        for (const p of paths) {
            expect(p.media_type).toBe('anime');
            expect(p.provider).toBe('anidb');
            expect(p.fallback_providers).toEqual(['tmdb']);
        }
    });

    it('updates group-level fields (name/icon/description/max_age_rating)', async () => {
        const groupId = await makeLibrary([
            { path: '/srv/stuff/d', media_type: 'movie', provider: 'tmdb' },
        ]);

        const result = await updateLibrary(sql, groupId, {
            name: 'New Name',
            icon: 'star',
            description: 'a new description',
            max_age_rating: 16,
        });

        expect(result?.group.name).toBe('New Name');
        const group = await getLibraryGroupById(sql, groupId);
        expect(group?.icon).toBe('star');
        expect(group?.description).toBe('a new description');
        expect(group?.max_age_rating).toBe(16);
    });

    it('writes access in the same save, and [] makes the library unrestricted again', async () => {
        const groupId = await makeLibrary([
            { path: '/srv/stuff/k', media_type: 'movie', provider: 'tmdb' },
        ]);
        const allowed = async (): Promise<string[] | null> => {
            const [row] = await sql<[{ allowed_groups: string[] }?]>`
                SELECT allowed_groups FROM library_group_permissions
                WHERE library_group_id = ${groupId}`;
            return row?.allowed_groups ?? null;
        };

        await updateLibrary(sql, groupId, { name: 'Evening', allowed_groups: ['kids', 'teens'] });
        expect(await allowed()).toEqual(['kids', 'teens']);
        expect((await getLibraryGroupById(sql, groupId))?.name).toBe('Evening');

        await updateLibrary(sql, groupId, { allowed_groups: [] });
        expect(await allowed()).toBeNull();
    });

    it('leaves access alone when the save does not mention it', async () => {
        const groupId = await makeLibrary([
            { path: '/srv/stuff/m', media_type: 'movie', provider: 'tmdb' },
        ]);
        await updateLibrary(sql, groupId, { allowed_groups: ['kids'] });
        await updateLibrary(sql, groupId, { name: 'Shelf' });
        const [row] = await sql<[{ allowed_groups: string[] }]>`
            SELECT allowed_groups FROM library_group_permissions WHERE library_group_id = ${groupId}`;
        expect(row.allowed_groups).toEqual(['kids']);
    });

    it('returns null for a nonexistent library', async () => {
        const result = await updateLibrary(sql, randomUUID(), { name: 'X' });
        expect(result).toBeNull();
    });

    it('leaves every folder unchanged when a remote-source folder would be repointed', async () => {
        const groupId = await makeLibrary([
            { path: '/srv/stuff/e', media_type: 'movie', provider: 'tmdb' },
        ]);
        // Hand-insert a remote-provider folder alongside it (the picker itself
        // would derive the abs:// sentinel; the service only cares that the
        // STORED provider is remote).
        await sql`
            INSERT INTO library_paths (id, path, media_type, provider, provider_path, library_group_id)
            VALUES (${randomUUID()}, 'abs://upstream-id', 'movie', 'audiobookshelf', 'upstream-id', ${groupId})
        `;

        const before = await getLibraryPathsByGroup(sql, groupId);

        await expect(updateLibrary(sql, groupId, { media_type: 'tv' })).rejects.toBeInstanceOf(
            RemoteLibraryConflictError,
        );

        const after = await getLibraryPathsByGroup(sql, groupId);
        expect(after).toEqual(before);

        const group = await getLibraryGroupById(sql, groupId);
        expect(group?.name).toBe('Family Vault'); // group row untouched too
    });
});
