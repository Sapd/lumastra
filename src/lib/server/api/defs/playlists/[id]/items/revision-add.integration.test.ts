// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { UserContext } from '$lib/server/types.js';
import { getTestDb } from '../../../../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../../../../tests/integration/helpers/users.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { createAndInsertTestMusicHierarchy } from '../../../../../../../../tests/integration/fixtures/music.fixtures.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestSeries,
} from '../../../../../../../../tests/integration/fixtures/index.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    createPlaylist,
    getPlaylistSummary,
} from '$lib/server/database/queries/playlists.queries.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { playlistItemManager } from '$lib/server/services/playlist-item-manager.service.js';
import type { AddPlaylistItemsResponse, PlaylistSummary } from '$lib/schemas/playlists.js';

vi.mock('$lib/server/database/connection.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/connection.js')>()),
    getDb: () => getTestDb(),
}));
// Isolate the write protocol from library fixtures; missing catalog IDs still fail in the manager.
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn(async () => true),
}));
const { def: list } = await import('./index.js');
const { def: order } = await import('./order.js');
const { def: remove } = await import('./[entryId].js');
const { def: bulkDelete } = await import('./bulk-delete.js');
const ctx = { surface: 'internal' as const };
const missing = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

async function fixture() {
    const sql = getTestDb();
    const owner = await createTestUser(sql);
    const user: UserContext = {
        userId: toUserId(owner.id),
        username: owner.username,
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        ownerIsAdmin: true,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
    };
    const playlist = await createPlaylist(sql, user.userId, 'Revision protocol', null, 'private');
    const { id: first } = await createAndInsertTestMovie(sql, {});
    const { id: second } = await createAndInsertTestMovie(sql, {});
    await sql`UPDATE media_items SET has_files = true WHERE id = ANY(${[first, second]}::uuid[])`;
    const add = (mediaIds: string[]) =>
        playlistItemManager.addMediaItems({
            sql,
            playlistId: playlist.id,
            playlistType: 'general',
            mediaIds,
            user,
            surface: 'internal',
            access: unrestrictedAccess(),
        });
    const reorder = (expectedRevision: number, entryIds: number[]) => {
        const url = new URL(`http://localhost/api/playlists/${playlist.id}/items/order`);
        return order.handlers.PUT!(
            {
                url,
                params: { id: String(playlist.id) },
                locals: { user },
                request: new Request(url, {
                    method: 'PUT',
                    body: JSON.stringify({ expectedRevision, entryIds }),
                }),
            } as unknown as RequestEvent,
            ctx,
        );
    };
    return { sql, playlist, first, second, add, reorder, user };
}

beforeEach(() => vi.clearAllMocks());

describe('playlist add and revision protocol', () => {
    it('reports added, duplicate and rejected per input, returning complete entries and one summary', async () => {
        const f = await fixture();
        const result: AddPlaylistItemsResponse = await f.add([f.first, f.first, missing]);
        expect(result.results.map((entry) => entry.status)).toEqual([
            'added',
            'duplicate',
            'rejected',
        ]);
        expect(result.results[0].entries[0]).toMatchObject({
            mediaId: f.first,
            position: 0,
            watched: false,
        });
        expect(result.results[0].entries[0]).not.toHaveProperty('externalIds');
        expect(result.results[1].entries[0].id).toBe(result.results[0].entries[0].id);
        expect(result.results[2]).toMatchObject({ entries: [], reason: 'not_found' });
        expect(result.summary).toMatchObject({ itemCount: 1, revision: 1 });
        const duplicate = await f.add([f.first]);
        expect(duplicate.summary.revision).toBe(1);
    });

    it('expands series, seasons and albums and reports existing children as duplicates', async () => {
        const f = await fixture();
        const series = await createAndInsertTestSeries(f.sql, {
            tmdbId: 98761017,
            seasonCount: 1,
            episodesPerSeason: 2,
        });
        const [{ id: seasonId }] = await f.sql<
            { id: string }[]
        >`SELECT id FROM media_items WHERE parent_id = ${series.seriesId}::uuid AND media_type = 'season'`;
        await f.sql`UPDATE media_items SET has_files = true WHERE parent_id = ${seasonId}::uuid`;
        const music = await createAndInsertTestMusicHierarchy(f.sql, { trackCount: 2 });
        await f.sql`UPDATE media_items SET has_files = true WHERE parent_id = ${music.albumId}::uuid`;
        const result = await f.add([series.seriesId, seasonId, music.albumId, music.trackIds[0]]);
        expect(result.results.map((entry) => entry.status)).toEqual([
            'added',
            'duplicate',
            'added',
            'duplicate',
        ]);
        expect(result.results.map((entry) => entry.expanded)).toEqual([true, true, true, false]);
        expect(result.results.map((entry) => entry.entries.length)).toEqual([2, 2, 2, 1]);
        expect(
            result.results[0].entries.every(
                (entry) => entry.mediaType === 'episode' && entry.seriesId === series.seriesId,
            ),
        ).toBe(true);
        expect(result.summary).toMatchObject({ revision: 1, itemCount: 4 });
    });

    it('rejects inaccessible input without dropping a successful sibling', async () => {
        const f = await fixture();
        vi.mocked(checkMediaAccess).mockResolvedValueOnce(false);
        const result = await f.add([f.first, f.second]);
        expect(result.results.map((entry) => entry.status)).toEqual(['rejected', 'added']);
        expect(result.results[0].entries).toEqual([]);
        expect(result.summary).toMatchObject({ revision: 1, itemCount: 1 });
    });

    it('returns revision summaries for entry removal and bulk deletion', async () => {
        const f = await fixture();
        const added = await f.add([f.first, f.second]);
        const [first, second] = added.results.map((result) => result.entries[0].id);
        const event = (suffix: string, method: string, body?: unknown) => {
            const url = new URL(`http://localhost/api/playlists/${f.playlist.id}/items/${suffix}`);
            return {
                url,
                params: { id: String(f.playlist.id), entryId: String(first) },
                locals: { user: f.user },
                request: new Request(url, {
                    method,
                    ...(body ? { body: JSON.stringify(body) } : {}),
                }),
            } as unknown as RequestEvent;
        };
        const removed = await remove.handlers.DELETE!(event(String(first), 'DELETE'), ctx);
        expect(removed.status).toBe(200);
        expect(await removed.json()).toMatchObject({ itemCount: 1, revision: 2 });
        const deleted = await bulkDelete.handlers.POST!(
            event('bulk-delete', 'POST', { entryIds: [second] }),
            ctx,
        );
        expect(deleted.status).toBe(200);
        expect(await deleted.json()).toMatchObject({ itemCount: 0, revision: 3 });
    });

    it('rejects stale reorders with current revision and leaves positions unchanged', async () => {
        const f = await fixture();
        const initial = await f.add([f.first]);
        const added = await f.add([f.second]);
        const response = await f.reorder(
            initial.summary.revision,
            initial.results[0].entries.map((entry) => entry.id),
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
            code: 'conflict',
            details: `revision:${added.summary.revision}`,
        });
        expect(await getPlaylistSummary(f.sql, f.playlist.id)).toEqual(added.summary);
    });

    it('requires a full permutation and bumps revision on successful reorder', async () => {
        const f = await fixture();
        const added = await f.add([f.first, f.second]);
        const ids = added.results.flatMap((result) => result.entries.map((entry) => entry.id));
        for (const invalid of [[ids[0]], [ids[0], ids[0]], [ids[0], 2147483647]]) {
            expect((await f.reorder(added.summary.revision, invalid)).status).toBe(422);
        }
        const response = await f.reorder(added.summary.revision, ids.toReversed());
        expect(response.status).toBe(200);
        const summary: PlaylistSummary = await response.json();
        expect(summary.revision).toBe(added.summary.revision + 1);
        const rows = await f.sql<
            { id: number }[]
        >`SELECT id FROM playlist_items WHERE playlist_id = ${f.playlist.id} ORDER BY position`;
        expect(rows.map((row) => row.id)).toEqual(ids.toReversed());
    });

    it('reorders the visible subset in its existing slots, preserving hidden rows', async () => {
        const f = await fixture();
        const music = await createAndInsertTestMusicHierarchy(f.sql, { trackCount: 3 });
        const added = await f.add(music.trackIds);
        const [a, h, b] = added.results.map((r) => r.entries[0].id);
        await f.sql`UPDATE media_items SET has_files = false WHERE id = ${music.trackIds[1]}`;
        const [hidden] = await f.sql`SELECT * FROM playlist_items WHERE id = ${h}`;
        const url = new URL(`http://localhost/api/playlists/${f.playlist.id}/items`);
        const read = await list.handlers.GET!(
            {
                url,
                params: { id: String(f.playlist.id) },
                locals: { user: f.user },
                request: new Request(url),
            } as unknown as RequestEvent,
            ctx,
        );
        expect(read.status).toBe(200);
        const view = (await read.json()) as { items: { id: number }[] };
        expect(view.items.map((entry) => entry.id)).toEqual([a, b]);
        expect(
            (
                await f.reorder(
                    added.summary.revision,
                    view.items.map((entry) => entry.id).toReversed(),
                )
            ).status,
        ).toBe(200);
        const rows =
            await f.sql`SELECT * FROM playlist_items WHERE playlist_id = ${f.playlist.id} ORDER BY position, id`;
        expect(rows.map((r) => r.id)).toEqual([b, h, a]);
        expect(rows[1]).toEqual(hidden);
        const summary = await getPlaylistSummary(f.sql, f.playlist.id);
        for (const invalid of [[a], [a, a], [a, h, b]]) {
            expect((await f.reorder(summary.revision, invalid)).status).toBe(422);
        }
        expect((await f.reorder(added.summary.revision, [a, b])).status).toBe(409);

        await f.sql`UPDATE playlist_items SET position = 0 WHERE id = ANY(${[a, b]}::int[])`;
        expect((await f.reorder(summary.revision, [b, a])).status).toBe(200);
        const tied =
            await f.sql`SELECT * FROM playlist_items WHERE playlist_id = ${f.playlist.id} ORDER BY position, id`;
        expect(tied.filter((row) => row.id !== h).map((row) => row.id)).toEqual([b, a]);
        expect(tied.find((row) => row.id === h)).toEqual(hidden);
    });

    it('serializes concurrent add and reorder under the same playlist lock', async () => {
        const f = await fixture();
        const initial = await f.add([f.first]);
        const id = initial.results[0].entries[0].id;
        const [added, response] = await Promise.all([
            f.add([f.second]),
            f.reorder(initial.summary.revision, [id]),
        ]);
        expect(added.results[0].status).toBe('added');
        expect([200, 409]).toContain(response.status);
        const rows = await f.sql<
            { media_id: string; position: number }[]
        >`SELECT media_id, position FROM playlist_items WHERE playlist_id = ${f.playlist.id} ORDER BY position`;
        expect(rows.map((row) => row.media_id)).toEqual([f.first, f.second]);
        expect(rows.map((row) => row.position)).toEqual([0, 1]);
        const summary = await getPlaylistSummary(f.sql, f.playlist.id);
        expect(summary.revision).toBe(response.status === 200 ? 3 : 2);
    });
});
