// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Authorization of the item write defs (order, delete, bulk-delete) for a
 * readonly accepted member and a public non-member, cross-playlist entry ids,
 * and the watched endpoint (no revision bump, member gate, entry scoping).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { UserContext } from '$lib/server/types.js';
import { getTestDb } from '../../../../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../../../../tests/integration/helpers/users.js';
import { createAndInsertTestMovie } from '../../../../../../../../tests/integration/fixtures/index.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    acceptInvite,
    createPlaylist,
    getPlaylistSummary,
    inviteMember,
} from '$lib/server/database/queries/playlists.queries.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { playlistItemManager } from '$lib/server/services/playlist-item-manager.service.js';

vi.mock('$lib/server/database/connection.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/connection.js')>()),
    getDb: () => getTestDb(),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn(async () => true),
}));
const { def: order } = await import('./order.js');
const { def: remove } = await import('./[entryId].js');
const { def: bulkDelete } = await import('./bulk-delete.js');
const { def: watched } = await import('./[entryId]/watched.js');
const ctx = { surface: 'internal' as const };

async function makeUser(): Promise<UserContext> {
    const row = await createTestUser(getTestDb());
    return {
        userId: toUserId(row.id),
        username: row.username,
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        ownerIsAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
    };
}

async function fixture() {
    const sql = getTestDb();
    const owner = await makeUser();
    const readonly = await makeUser();
    const outsider = await makeUser();
    // Public, so the outsider resolves to the 'readonly' role without membership.
    const playlist = await createPlaylist(sql, owner.userId, 'Access matrix', null, 'public');
    const other = await createPlaylist(sql, owner.userId, 'Other list', null, 'private');
    await inviteMember(sql, playlist.id, readonly.userId, 'readonly');
    await acceptInvite(sql, playlist.id, readonly.userId);
    const { id: a } = await createAndInsertTestMovie(sql, {});
    const { id: b } = await createAndInsertTestMovie(sql, {});
    const { id: c } = await createAndInsertTestMovie(sql, {});
    const add = (playlistId: number, mediaIds: string[]) =>
        playlistItemManager.addMediaItems({
            sql,
            playlistId,
            playlistType: 'general',
            mediaIds,
            user: owner,
            surface: 'internal',
            access: unrestrictedAccess(),
        });
    const main = await add(playlist.id, [a, b]);
    const foreign = await add(other.id, [c]);
    const entries = main.results.map((r) => r.entries[0].id);
    const foreignEntry = foreign.results[0].entries[0].id;

    const event = (
        user: UserContext,
        playlistId: number,
        suffix: string,
        method: string,
        body?: unknown,
    ) => {
        const url = new URL(`http://localhost/api/playlists/${playlistId}/items${suffix}`);
        const last = suffix.match(/\/(\d+)/)?.[1] ?? String(playlistId);
        return {
            url,
            params: { id: last, entryId: last },
            locals: { user },
            request: new Request(url, {
                method,
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
        } as unknown as RequestEvent;
    };
    const summary = (id: number) => getPlaylistSummary(sql, id);
    return { sql, owner, readonly, outsider, playlist, other, entries, foreignEntry, event, summary };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('item write defs: authorization and entry scoping', () => {
    it.each(['readonly', 'outsider'] as const)(
        'denies order, delete and bulk-delete to the %s caller and leaves the playlist unchanged',
        async (who) => {
            const f = await fixture();
            const caller = f[who];
            const before = await f.summary(f.playlist.id);

            const reorder = await order.handlers.PUT!(
                f.event(caller, f.playlist.id, '/order', 'PUT', {
                    expectedRevision: before.revision,
                    entryIds: f.entries.toReversed(),
                }),
                ctx,
            );
            expect(reorder.status).toBe(403);

            const removed = await remove.handlers.DELETE!(
                f.event(caller, f.playlist.id, `/${f.entries[0]}`, 'DELETE'),
                ctx,
            );
            expect(removed.status).toBe(403);

            const bulk = await bulkDelete.handlers.POST!(
                f.event(caller, f.playlist.id, '/bulk-delete', 'POST', { entryIds: f.entries }),
                ctx,
            );
            expect(bulk.status).toBe(403);

            expect(await f.summary(f.playlist.id)).toEqual(before);
            const rows = await f.sql<
                { id: number }[]
            >`SELECT id FROM playlist_items WHERE playlist_id = ${f.playlist.id} ORDER BY position`;
            expect(rows.map((r) => r.id)).toEqual(f.entries);
        },
    );

    it('answers 404 for an entry id that belongs to another playlist and leaves both lists untouched', async () => {
        const f = await fixture();
        const mainBefore = await f.summary(f.playlist.id);
        const otherBefore = await f.summary(f.other.id);

        const removed = await remove.handlers.DELETE!(
            f.event(f.owner, f.playlist.id, `/${f.foreignEntry}`, 'DELETE'),
            ctx,
        );
        expect(removed.status).toBe(404);

        const bulk = await bulkDelete.handlers.POST!(
            f.event(f.owner, f.playlist.id, '/bulk-delete', 'POST', {
                entryIds: [f.foreignEntry],
            }),
            ctx,
        );
        expect(bulk.status).toBe(404);

        expect(await f.summary(f.playlist.id)).toEqual(mainBefore);
        expect(await f.summary(f.other.id)).toEqual(otherBefore);
    });

    it('bulk-delete with a mix of own and foreign ids only removes the own entries', async () => {
        const f = await fixture();
        const response = await bulkDelete.handlers.POST!(
            f.event(f.owner, f.playlist.id, '/bulk-delete', 'POST', {
                entryIds: [f.entries[0], f.foreignEntry],
            }),
            ctx,
        );
        expect(response.status).toBe(200);
        expect(await f.summary(f.other.id)).toMatchObject({ itemCount: 1 });
        expect(await f.summary(f.playlist.id)).toMatchObject({ itemCount: 1 });
    });
});

describe('PUT /playlists/{id}/items/{entryId}/watched', () => {
    const put = (f: Awaited<ReturnType<typeof fixture>>, user: UserContext, entryId: number, playlistId = f.playlist.id) =>
        watched.handlers.PUT!(
            {
                ...f.event(user, playlistId, `/${entryId}/watched`, 'PUT', { watched: true }),
            } as RequestEvent,
            ctx,
        );

    it('records watched for an accepted member without changing the playlist revision', async () => {
        const f = await fixture();
        const before = await f.summary(f.playlist.id);
        const response = await put(f, f.readonly, f.entries[0]);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.watched).toBe(true);
        expect(body.playlistSummary.revision).toBe(before.revision);
        expect((await f.summary(f.playlist.id)).revision).toBe(before.revision);
        const rows = await f.sql<
            { watched: boolean }[]
        >`SELECT watched FROM playlist_item_watched WHERE item_id = ${f.entries[0]} AND user_id = ${f.readonly.userId}::uuid`;
        expect(rows).toEqual([{ watched: true }]);
    });

    it('denies a public non-member with 403 and writes nothing', async () => {
        const f = await fixture();
        const before = await f.summary(f.playlist.id);
        const response = await put(f, f.outsider, f.entries[0]);
        expect(response.status).toBe(403);
        const rows = await f.sql`SELECT 1 FROM playlist_item_watched WHERE item_id = ${f.entries[0]}`;
        expect(rows).toHaveLength(0);
        expect(await f.summary(f.playlist.id)).toEqual(before);
    });

    it('answers 404 for an entry id from another playlist', async () => {
        const f = await fixture();
        const response = await put(f, f.owner, f.foreignEntry);
        expect(response.status).toBe(404);
        const rows = await f.sql`SELECT 1 FROM playlist_item_watched WHERE item_id = ${f.foreignEntry}`;
        expect(rows).toHaveLength(0);
    });
});
