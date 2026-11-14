// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /j playlist routes (PlaylistsController) against the jellyfin-sdk-kotlin
 * contract, through the real route handlers over real PG + Valkey.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { truncateTables, TEST_TABLES } from '../integration/helpers/cleanup.js';
import { ensureTestUser } from '../integration/fixtures/user.fixtures.js';
import { callAndCheck, jfEvent, mintJfSession } from './harness';
import { seedMovieEmbeddedSubs } from './seed';
import { POST as createPost } from '../../src/routes/(modules)/j/Playlists/+server';
import { GET as playlistGet } from '../../src/routes/(modules)/j/Playlists/[playlistId]/+server';
import { GET as itemsGet } from '../../src/routes/(modules)/j/Playlists/[playlistId]/Items/+server';
import { GET as usersGet } from '../../src/routes/(modules)/j/Playlists/[playlistId]/Users/+server';
import { GET as userGet } from '../../src/routes/(modules)/j/Playlists/[playlistId]/Users/[userId]/+server';

const USER_ID = '00000000-0000-4000-8000-00000000c0de';
const FRIEND_ID = '00000000-0000-4000-8000-00000000f00d';
let sql: postgres.Sql;
let token: string;
let movieId: string;

beforeAll(async () => {
    sql = getTestDb();
    if (!(await connectValkey())) throw new Error('Valkey not reachable (CACHE_URL)');
});
afterAll(async () => {
    await disconnectValkey();
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
    await ensureTestUser(sql, USER_ID);
    await ensureTestUser(sql, FRIEND_ID);
    const [{ username }] = await sql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${USER_ID}`;
    token = await mintJfSession(sql, { userId: USER_ID, username });
    ({ itemId: movieId } = await seedMovieEmbeddedSubs(sql));
});

async function createPlaylist(): Promise<string> {
    const body = (await callAndCheck(
        'playlist-create',
        'PlaylistCreationResult',
        createPost,
        jfEvent({
            method: 'POST',
            path: '/j/Playlists',
            token,
            params: {},
            body: {
                Name: 'Contract playlist',
                Ids: [movieId],
                MediaType: 'Video',
                Users: [{ UserId: FRIEND_ID.replace(/-/g, ''), CanEdit: true }],
            },
        }),
    )) as { Id: string };
    return body.Id;
}

describe('/j playlists contract', () => {
    it('POST /Playlists → PlaylistCreationResult; GET /Playlists/{id} → PlaylistDto', async () => {
        const id = await createPlaylist();
        const dto = (await callAndCheck(
            'playlist-get',
            'PlaylistDto',
            playlistGet,
            jfEvent({
                method: 'GET',
                path: `/j/Playlists/${id}`,
                token,
                params: { playlistId: id },
            }),
        )) as { ItemIds: string[]; Shares: unknown[] };
        expect(dto.ItemIds).toEqual([movieId]);
        expect(dto.Shares).toHaveLength(1);
    });

    it('GET /Playlists/{id}/Items carries PlaylistItemId', async () => {
        const id = await createPlaylist();
        const body = (await callAndCheck(
            'playlist-items',
            'BaseItemDtoQueryResult',
            itemsGet,
            jfEvent({
                method: 'GET',
                path: `/j/Playlists/${id}/Items`,
                token,
                params: { playlistId: id },
            }),
        )) as { Items: Array<{ PlaylistItemId?: string }> };
        expect(body.Items[0].PlaylistItemId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('GET /Playlists/{id}/Users and /Users/{userId} → PlaylistUserPermissions', async () => {
        const id = await createPlaylist();
        await callAndCheck(
            'playlist-users',
            'List<PlaylistUserPermissions>',
            usersGet,
            jfEvent({
                method: 'GET',
                path: `/j/Playlists/${id}/Users`,
                token,
                params: { playlistId: id },
            }),
        );
        await callAndCheck(
            'playlist-user',
            'PlaylistUserPermissions',
            userGet,
            jfEvent({
                method: 'GET',
                path: `/j/Playlists/${id}/Users/${USER_ID}`,
                token,
                params: { playlistId: id, userId: USER_ID },
            }),
        );
    });
});
