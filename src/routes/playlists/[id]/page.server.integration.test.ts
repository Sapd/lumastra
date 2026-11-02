// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The playlist page grants exactly what the playlist API grants (getUserRole):
 * a PENDING invite opens nothing, and a private playlist the viewer cannot see
 * answers 404 like a missing one.
 *
 * The page load ran its own membership query without `status = 'accepted'`, so
 * an invitee read a private playlist before accepting, and it answered 403 for
 * private ids, which told sequential-id probing which playlists exist. Found in
 * the 2026-10-07 entry-point review.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
    derivedUsername,
} from '../../../../tests/integration/fixtures/index.js';
import {
    createPlaylist,
    inviteMember,
    acceptInvite,
} from '$lib/server/database/queries/playlists.queries.js';
import { load } from './+page.server.js';

type LoadEvent = Parameters<typeof load>[0];

let sql: postgres.Sql;
const owner = generateTestUserId();
const invitee = generateTestUserId();
const outsider = generateTestUserId();
const allUsers = [owner, invitee, outsider];

function viewerEvent(playlistId: number, userId: string): LoadEvent {
    return {
        params: { id: String(playlistId) },
        locals: {
            user: {
                userId,
                username: derivedUsername(userId),
                ownerIsAdmin: false,
                maxAgeRating: null,
            },
        },
        depends: () => undefined,
    } as unknown as LoadEvent;
}

async function status(run: () => unknown): Promise<number> {
    try {
        await run();
        return 200;
    } catch (e) {
        return (e as { status?: number }).status ?? 500;
    }
}

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await sql`DELETE FROM playlist_members WHERE user_id = ANY(${sql.array(allUsers)}::uuid[])`;
    await sql`DELETE FROM playlists WHERE user_id = ANY(${sql.array(allUsers)}::uuid[])`;
    for (const u of allUsers) await ensureTestUser(sql, u);
});

describe('/playlists/[id] load — who may open a private playlist', () => {
    it('a pending invitee gets 404 until they accept, then the playlist', async () => {
        const playlist = await createPlaylist(sql, owner, 'Private', null, 'private', 'general');
        await inviteMember(sql, playlist.id, invitee, 'readonly');

        expect(await status(() => load(viewerEvent(playlist.id, invitee)))).toBe(404);

        await acceptInvite(sql, playlist.id, invitee);
        expect(await status(() => load(viewerEvent(playlist.id, invitee)))).toBe(200);
    });

    it('a stranger gets the same 404 for a private playlist as for a missing id', async () => {
        const playlist = await createPlaylist(sql, owner, 'Private', null, 'private', 'general');
        expect(await status(() => load(viewerEvent(playlist.id, outsider)))).toBe(404);
        expect(await status(() => load(viewerEvent(999_999_999, outsider)))).toBe(404);
    });

    it('the owner still opens it', async () => {
        const playlist = await createPlaylist(sql, owner, 'Private', null, 'private', 'general');
        expect(await status(() => load(viewerEvent(playlist.id, owner)))).toBe(200);
    });
});
