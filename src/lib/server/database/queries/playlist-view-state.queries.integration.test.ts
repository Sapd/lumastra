// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for per-user playlist view state (collapsed groups).
 *
 * Focus: the inheritance contract that backs the feature — a viewer with no row
 * of their own inherits the OWNER's collapsed groups; once they save their own,
 * it wins and is never overwritten by the owner's.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/index.js';
import { getEffectiveCollapsedGroups, upsertPlaylistViewState } from './playlists.queries.js';

describe('Playlist view state queries', () => {
    let sql: postgres.Sql;
    const createdPlaylistIds: number[] = [];
    const createdUserIds: string[] = [];

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    afterEach(async () => {
        // playlist_view_state rows cascade-delete with their playlist.
        if (createdPlaylistIds.length > 0) {
            await sql`DELETE FROM playlists WHERE id = ANY(${createdPlaylistIds})`;
            createdPlaylistIds.length = 0;
        }
        if (createdUserIds.length > 0) {
            await sql`DELETE FROM user_profiles WHERE user_id = ANY(${createdUserIds}::uuid[])`;
            await sql`DELETE FROM users WHERE id = ANY(${createdUserIds}::uuid[])`;
            createdUserIds.length = 0;
        }
    });

    async function createOwnerAndPlaylist(): Promise<{ ownerId: string; playlistId: number }> {
        const ownerId = generateTestUserId('owner');
        await ensureTestUser(sql, ownerId);
        createdUserIds.push(ownerId);
        const [row] = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name)
            VALUES (${ownerId}::uuid, ${'View State Test'})
            RETURNING id
        `;
        createdPlaylistIds.push(row.id);
        return { ownerId, playlistId: row.id };
    }

    it('returns empty groups when no rows exist', async () => {
        const { ownerId, playlistId } = await createOwnerAndPlaylist();
        const groups = await getEffectiveCollapsedGroups(sql, playlistId, ownerId, ownerId);
        expect(groups).toEqual({ series: [], season: [] });
    });

    it('a viewer with no row inherits the owner’s collapsed groups', async () => {
        const { ownerId, playlistId } = await createOwnerAndPlaylist();
        const viewerId = generateTestUserId('viewer');
        await ensureTestUser(sql, viewerId);
        createdUserIds.push(viewerId);

        await upsertPlaylistViewState(sql, playlistId, ownerId, {
            series: ['tmdb:1396'],
            season: ['tmdb:1396-S2'],
        });

        const groups = await getEffectiveCollapsedGroups(sql, playlistId, viewerId, ownerId);
        expect(groups).toEqual({ series: ['tmdb:1396'], season: ['tmdb:1396-S2'] });
    });

    it('an anonymous viewer (no userId) also inherits the owner’s groups', async () => {
        const { ownerId, playlistId } = await createOwnerAndPlaylist();
        await upsertPlaylistViewState(sql, playlistId, ownerId, { series: ['bb'], season: [] });

        const groups = await getEffectiveCollapsedGroups(sql, playlistId, null, ownerId);
        expect(groups).toEqual({ series: ['bb'], season: [] });
    });

    it('a viewer’s own saved row wins over the owner’s and is not overwritten', async () => {
        const { ownerId, playlistId } = await createOwnerAndPlaylist();
        const viewerId = generateTestUserId('viewer');
        await ensureTestUser(sql, viewerId);
        createdUserIds.push(viewerId);

        await upsertPlaylistViewState(sql, playlistId, ownerId, {
            series: ['owner-series'],
            season: [],
        });
        await upsertPlaylistViewState(sql, playlistId, viewerId, {
            series: ['viewer-series'],
            season: ['viewer-season'],
        });

        // Owner still sees their own.
        expect(await getEffectiveCollapsedGroups(sql, playlistId, ownerId, ownerId)).toEqual({
            series: ['owner-series'],
            season: [],
        });
        // Viewer sees their own — not the owner's.
        expect(await getEffectiveCollapsedGroups(sql, playlistId, viewerId, ownerId)).toEqual({
            series: ['viewer-series'],
            season: ['viewer-season'],
        });
    });

    it('upsert replaces a user’s previous groups (full replacement, no merge)', async () => {
        const { ownerId, playlistId } = await createOwnerAndPlaylist();
        await upsertPlaylistViewState(sql, playlistId, ownerId, { series: ['a', 'b'], season: [] });
        await upsertPlaylistViewState(sql, playlistId, ownerId, {
            series: ['c'],
            season: ['c-S1'],
        });

        expect(await getEffectiveCollapsedGroups(sql, playlistId, ownerId, ownerId)).toEqual({
            series: ['c'],
            season: ['c-S1'],
        });
    });
});
