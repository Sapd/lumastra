// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /j playlist write endpoints (Jellyfin PlaylistsController) through the real
 * route handlers over real Postgres: every role (owner / editor / readonly
 * member / public reader / no access), the PlaylistItemId round trip
 * (create → list → move → delete by entry id), sharing, the system watchlist's
 * rules, media-access scoping, and the collection endpoints' 403.
 */

import { randomUUID } from 'node:crypto';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../tests/integration/helpers/users.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    createPlaylist,
    inviteMember,
    acceptInvite,
} from '$lib/server/database/queries/playlists.queries';
import { ensureWatchlistPlaylist } from '$lib/server/database/queries/watchlist-playlist.queries';
import { playlistIdToUuid } from '$lib/server/jellyfin-compat/playlist-id';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache';
import { toUserId } from '$lib/shared/user-id';

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database')>();
    const { getTestDb: getSql } =
        await import('../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

vi.mock('$lib/server/cache', () => ({
    cacheInvalidation: {
        onWatchlistChange: vi.fn().mockResolvedValue(undefined),
    },
}));

const { POST: createPost } = await import('./+server.js');
const { GET: playlistGet, POST: playlistPost } = await import('./[playlistId]/+server.js');
const {
    GET: itemsGet,
    POST: itemsPost,
    DELETE: itemsDelete,
} = await import('./[playlistId]/Items/+server.js');
const { POST: movePost } = await import('./[playlistId]/Items/[itemId]/Move/[newIndex]/+server.js');
const { GET: usersGet } = await import('./[playlistId]/Users/+server.js');
const {
    GET: userGet,
    POST: userPost,
    DELETE: userDelete,
} = await import('./[playlistId]/Users/[userId]/+server.js');
const { POST: collectionPost } = await import('../Collections/+server.js');
const { POST: collectionItemsPost, DELETE: collectionItemsDelete } =
    await import('../Collections/[collectionId]/Items/+server.js');

interface TestUser {
    id: string;
    username: string;
    maxAgeRating?: number | null;
    userGroups?: string[];
}

function call(
    handler: unknown,
    user: TestUser,
    opts: {
        method: 'GET' | 'POST' | 'DELETE';
        path: string;
        params?: Record<string, string>;
        body?: unknown;
    },
): Promise<Response> {
    const url = new URL(`http://localhost${opts.path}`);
    const ageRestricted = user.maxAgeRating !== undefined && user.maxAgeRating !== null;
    const event = {
        url,
        params: opts.params ?? {},
        request: new Request(url, {
            method: opts.method,
            headers: { 'content-type': 'application/json' },
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        }),
        locals: {
            user: {
                userId: user.id,
                username: user.username,
                groups: '',
                userGroups: user.userGroups ?? [],
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                ownerIsAdmin: false,
                isModerator: false,
                isAgeRestricted: ageRestricted,
                maxAgeRating: ageRestricted ? user.maxAgeRating : null,
            },
        },
    } as unknown as RequestEvent;
    return (handler as (e: RequestEvent) => Promise<Response>)(event);
}

const dashless = (uuid: string): string => uuid.replace(/-/g, '');

interface ItemsBody {
    Items: Array<{ Id: string; PlaylistItemId?: string }>;
    TotalRecordCount: number;
}

describe('/j/Playlists — Jellyfin playlist management', () => {
    let sql: postgres.Sql;
    let owner: TestUser;
    let editor: TestUser;
    let reader: TestUser;
    let outsider: TestUser;
    let movies: string[];
    let adultMovie: string;

    /** Give an item a file — /j browse only serves items that have one. */
    async function attachFile(id: string): Promise<void> {
        const [f] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, file_size_bytes, container_format, duration_seconds)
            VALUES (${`/media/playlists-test/${id}.mkv`}, 1000, 'matroska', 60) RETURNING id
        `;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${f.id}, ${id}, true)`;
    }

    async function movie(title: string, ageRating: number | null = 6): Promise<string> {
        const id = await insertTestMediaItem(
            sql,
            createTestMediaItem({ media_type: 'movie', title, has_files: true }),
        );
        await sql`UPDATE media_items SET age_rating = ${ageRating} WHERE id = ${id}::uuid`;
        await attachFile(id);
        return id;
    }

    /** A private playlist owned by `owner` with editor + readonly members. */
    async function sharedPlaylist(type: 'general' | 'video' = 'video'): Promise<string> {
        const row = await createPlaylist(sql, toUserId(owner.id), 'Shared', null, 'private', type);
        await inviteMember(sql, row.id, toUserId(editor.id), 'editor');
        await acceptInvite(sql, row.id, toUserId(editor.id));
        await inviteMember(sql, row.id, toUserId(reader.id), 'readonly');
        await acceptInvite(sql, row.id, toUserId(reader.id));
        return playlistIdToUuid(row.id);
    }

    async function listItems(user: TestUser, pid: string): Promise<ItemsBody> {
        const res = await call(itemsGet, user, {
            method: 'GET',
            path: `/j/Playlists/${pid}/Items`,
            params: { playlistId: pid },
        });
        expect(res.status).toBe(200);
        return (await res.json()) as ItemsBody;
    }

    async function addItems(
        user: TestUser,
        pid: string,
        ids: string[],
        extra = '',
    ): Promise<number> {
        const res = await call(itemsPost, user, {
            method: 'POST',
            path: `/j/Playlists/${pid}/Items?ids=${ids.join(',')}${extra}`,
            params: { playlistId: pid },
        });
        return res.status;
    }

    beforeAll(() => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        owner = await createTestUser(sql);
        editor = await createTestUser(sql);
        reader = await createTestUser(sql);
        outsider = await createTestUser(sql);
        movies = [await movie('Alpha'), await movie('Bravo'), await movie('Charlie')];
        adultMovie = await movie('Restricted', 18);
    });

    describe('POST /Playlists', () => {
        it('creates from a CreatePlaylistDto body and returns PlaylistCreationResult', async () => {
            const res = await call(createPost, owner, {
                method: 'POST',
                path: '/j/Playlists',
                body: { Name: 'Movie night', Ids: [movies[0], dashless(movies[1])] },
            });
            expect(res.status).toBe(200);
            const { Id } = (await res.json()) as { Id: string };
            expect(Id).toMatch(/^00000000-0000-4000-8000-[0-9a-f]{12}$/);

            const body = await listItems(owner, Id);
            expect(body.Items.map((i) => i.Id)).toEqual([movies[0], movies[1]]);

            const [row] = await sql<{ name: string; playlist_type: string; visibility: string }[]>`
                SELECT name, playlist_type, visibility FROM playlists
                WHERE user_id = ${owner.id}::uuid AND is_system = false
            `;
            expect(row).toEqual({
                name: 'Movie night',
                playlist_type: 'video',
                visibility: 'private',
            });
        });

        it('accepts the obsolete query parameters', async () => {
            const res = await call(createPost, owner, {
                method: 'POST',
                path: `/j/Playlists?name=Query%20list&ids=${movies[2]}&mediaType=Audio&userId=${dashless(owner.id)}`,
            });
            expect(res.status).toBe(200);
            const [row] = await sql<{ name: string; playlist_type: string }[]>`
                SELECT name, playlist_type FROM playlists
                WHERE user_id = ${owner.id}::uuid AND is_system = false
            `;
            expect(row).toEqual({ name: 'Query list', playlist_type: 'music' });
        });

        it('skips items the caller cannot see', async () => {
            const kid: TestUser = { ...outsider, maxAgeRating: 12 };
            const res = await call(createPost, kid, {
                method: 'POST',
                path: '/j/Playlists',
                body: { Name: 'Kids', Ids: [movies[0], adultMovie] },
            });
            expect(res.status).toBe(200);
            const { Id } = (await res.json()) as { Id: string };
            const rows = await sql<{ media_id: string }[]>`
                SELECT pi.media_id FROM playlist_items pi
                JOIN playlists p ON p.id = pi.playlist_id
                WHERE p.user_id = ${kid.id}::uuid AND p.is_system = false
            `;
            expect(rows.map((r) => r.media_id)).toEqual([movies[0]]);
            expect(Id).toBeTruthy();
        });

        it('invites the listed Users with the matching role', async () => {
            const res = await call(createPost, owner, {
                method: 'POST',
                path: '/j/Playlists',
                body: {
                    Name: 'Shared',
                    Users: [
                        { UserId: dashless(editor.id), CanEdit: true },
                        { UserId: reader.id, CanEdit: false },
                    ],
                },
            });
            expect(res.status).toBe(200);
            const members = await sql<{ user_id: string; role: string; status: string }[]>`
                SELECT pm.user_id, pm.role, pm.status FROM playlist_members pm
                JOIN playlists p ON p.id = pm.playlist_id
                WHERE p.user_id = ${owner.id}::uuid
                ORDER BY pm.role
            `;
            expect(members).toEqual([
                { user_id: editor.id, role: 'editor', status: 'pending' },
                { user_id: reader.id, role: 'readonly', status: 'pending' },
            ]);
        });

        // Bad parameters answer 422 (ApiResponses.badRequest → validation_failed),
        // as every other /j route does; Jellyfin answers 400. Clients only
        // distinguish 2xx from the rest.
        it('rejects a missing name, a bad id, and creating for someone else', async () => {
            const noName = await call(createPost, owner, {
                method: 'POST',
                path: '/j/Playlists',
                body: { Ids: [movies[0]] },
            });
            expect(noName.status).toBe(422);

            const badId = await call(createPost, owner, {
                method: 'POST',
                path: '/j/Playlists?name=x&ids=not-a-guid',
            });
            expect(badId.status).toBe(422);

            const badJson = await call(createPost, owner, {
                method: 'POST',
                path: '/j/Playlists',
                body: 'nope',
            });
            expect(badJson.status).toBe(422);

            const other = await call(createPost, owner, {
                method: 'POST',
                path: `/j/Playlists?name=x&userId=${editor.id}`,
            });
            expect(other.status).toBe(403);
        });
    });

    describe('GET /Playlists/{id}', () => {
        it('returns PlaylistDto with visible ItemIds; Shares in full for the owner only', async () => {
            const pid = await sharedPlaylist();
            expect(await addItems(owner, pid, [movies[0], adultMovie])).toBe(204);

            const ownerRes = await call(playlistGet, owner, {
                method: 'GET',
                path: `/j/Playlists/${pid}`,
                params: { playlistId: pid },
            });
            expect(ownerRes.status).toBe(200);
            const dto = (await ownerRes.json()) as {
                OpenAccess: boolean;
                Shares: Array<{ UserId: string; CanEdit: boolean }>;
                ItemIds: string[];
            };
            expect(dto.OpenAccess).toBe(false);
            expect(dto.ItemIds).toEqual([movies[0], adultMovie]);
            expect(dto.Shares).toEqual(
                expect.arrayContaining([
                    { UserId: dashless(editor.id), CanEdit: true },
                    { UserId: dashless(reader.id), CanEdit: false },
                ]),
            );

            const kidReader: TestUser = { ...reader, maxAgeRating: 12 };
            const readerRes = await call(playlistGet, kidReader, {
                method: 'GET',
                path: `/j/Playlists/${pid}`,
                params: { playlistId: pid },
            });
            const readerDto = (await readerRes.json()) as typeof dto;
            expect(readerDto.ItemIds).toEqual([movies[0]]);
            expect(readerDto.Shares).toEqual([{ UserId: dashless(reader.id), CanEdit: false }]);
        });

        it('is 404 without access and 422 for a malformed id', async () => {
            const pid = await sharedPlaylist();
            const denied = await call(playlistGet, outsider, {
                method: 'GET',
                path: `/j/Playlists/${pid}`,
                params: { playlistId: pid },
            });
            expect(denied.status).toBe(404);

            const bad = await call(playlistGet, owner, {
                method: 'GET',
                path: '/j/Playlists/zzz',
                params: { playlistId: 'zzz' },
            });
            expect(bad.status).toBe(422);

            // Above int4: a client-side 4xx, never a Postgres 22003 → 500.
            for (const id of ['00000000-0000-4000-8000-ffffffffffff', '2147483648']) {
                const res = await call(playlistGet, owner, {
                    method: 'GET',
                    path: `/j/Playlists/${id}`,
                    params: { playlistId: id },
                });
                expect(res.status, id).toBe(422);
            }
        });

        it('accepts the dashless id form', async () => {
            const pid = await sharedPlaylist();
            const res = await call(playlistGet, owner, {
                method: 'GET',
                path: `/j/Playlists/${dashless(pid)}`,
                params: { playlistId: dashless(pid) },
            });
            expect(res.status).toBe(200);
        });
    });

    describe('items by role', () => {
        it.each([
            ['owner', 204],
            ['editor', 204],
            ['reader', 403],
            ['outsider', 404],
        ] as const)('%s adding items → %i', async (who, expected) => {
            const pid = await sharedPlaylist();
            const users = { owner, editor, reader, outsider };
            expect(await addItems(users[who], pid, [movies[0]])).toBe(expected);
        });

        it.each([
            ['owner', 204],
            ['editor', 204],
            ['reader', 403],
            ['outsider', 404],
        ] as const)('%s removing an entry → %i', async (who, expected) => {
            const pid = await sharedPlaylist();
            await addItems(owner, pid, [movies[0]]);
            const [{ PlaylistItemId }] = (await listItems(owner, pid)).Items;
            const users = { owner, editor, reader, outsider };
            const res = await call(itemsDelete, users[who], {
                method: 'DELETE',
                path: `/j/Playlists/${pid}/Items?entryIds=${PlaylistItemId}`,
                params: { playlistId: pid },
            });
            expect(res.status).toBe(expected);
        });

        it('a public playlist is readable but not writable by anyone', async () => {
            const row = await createPlaylist(
                sql,
                toUserId(owner.id),
                'Pub',
                null,
                'public',
                'video',
            );
            const pid = playlistIdToUuid(row.id);
            await addItems(owner, pid, [movies[0]]);
            expect((await listItems(outsider, pid)).TotalRecordCount).toBe(1);
            expect(await addItems(outsider, pid, [movies[1]])).toBe(403);
        });

        it('rejects malformed ids and position', async () => {
            const pid = await sharedPlaylist();
            expect(await addItems(owner, pid, ['xyz'])).toBe(422);
            expect(await addItems(owner, pid, [movies[0]], '&position=abc')).toBe(422);
            const res = await call(itemsDelete, owner, {
                method: 'DELETE',
                path: `/j/Playlists/${pid}/Items?entryIds=garbage`,
                params: { playlistId: pid },
            });
            expect(res.status).toBe(422);
        });

        it('does not add an item the caller cannot see', async () => {
            const pid = await sharedPlaylist();
            const kidEditor: TestUser = { ...editor, maxAgeRating: 12 };
            expect(await addItems(kidEditor, pid, [adultMovie, movies[1]])).toBe(204);
            expect((await listItems(owner, pid)).Items.map((i) => i.Id)).toEqual([movies[1]]);
        });
    });

    describe('PlaylistItemId round trip', () => {
        it('create → list → move → delete by PlaylistItemId', async () => {
            const created = await call(createPost, owner, {
                method: 'POST',
                path: '/j/Playlists',
                body: { Name: 'Round trip', Ids: movies },
            });
            const { Id: pid } = (await created.json()) as { Id: string };

            const listed = await listItems(owner, pid);
            expect(listed.Items.map((i) => i.Id)).toEqual(movies);
            const entryIds = listed.Items.map((i) => i.PlaylistItemId);
            for (const e of entryIds) expect(e).toMatch(/^[0-9a-f]{32}$/);
            expect(new Set(entryIds).size).toBe(3);

            // Move Charlie to the front.
            const moved = await call(movePost, owner, {
                method: 'POST',
                path: `/j/Playlists/${pid}/Items/${entryIds[2]}/Move/0`,
                params: { playlistId: pid, itemId: entryIds[2]!, newIndex: '0' },
            });
            expect(moved.status).toBe(204);
            expect((await listItems(owner, pid)).Items.map((i) => i.Id)).toEqual([
                movies[2],
                movies[0],
                movies[1],
            ]);

            // Move Alpha (now index 1) to the end.
            const toEnd = await call(movePost, owner, {
                method: 'POST',
                path: `/j/Playlists/${pid}/Items/${entryIds[0]}/Move/2`,
                params: { playlistId: pid, itemId: entryIds[0]!, newIndex: '2' },
            });
            expect(toEnd.status).toBe(204);
            expect((await listItems(owner, pid)).Items.map((i) => i.Id)).toEqual([
                movies[2],
                movies[1],
                movies[0],
            ]);

            const del = await call(itemsDelete, owner, {
                method: 'DELETE',
                path: `/j/Playlists/${pid}/Items?entryIds=${entryIds[1]},${entryIds[2]}`,
                params: { playlistId: pid },
            });
            expect(del.status).toBe(204);
            const after = await listItems(owner, pid);
            expect(after.Items.map((i) => i.Id)).toEqual([movies[0]]);
            expect(after.Items[0].PlaylistItemId).toBe(entryIds[0]);

            const positions = await sql<{ position: number }[]>`
                SELECT position FROM playlist_items WHERE playlist_id = (
                    SELECT id FROM playlists WHERE user_id = ${owner.id}::uuid AND is_system = false
                )
            `;
            expect(positions.map((p) => p.position)).toEqual([0]);
        });

        it('inserts at ?position=', async () => {
            const pid = await sharedPlaylist();
            await addItems(owner, pid, [movies[0], movies[1]]);
            expect(await addItems(owner, pid, [movies[2]], '&position=1')).toBe(204);
            expect((await listItems(owner, pid)).Items.map((i) => i.Id)).toEqual([
                movies[0],
                movies[2],
                movies[1],
            ]);
        });

        it('move: reader 403, unknown entry 404, bad index 422', async () => {
            const pid = await sharedPlaylist();
            await addItems(owner, pid, [movies[0], movies[1]]);
            const [{ PlaylistItemId }] = (await listItems(owner, pid)).Items;
            const move = (user: TestUser, itemId: string, newIndex: string): Promise<Response> =>
                call(movePost, user, {
                    method: 'POST',
                    path: `/j/Playlists/${pid}/Items/${itemId}/Move/${newIndex}`,
                    params: { playlistId: pid, itemId, newIndex },
                });
            expect((await move(reader, PlaylistItemId!, '1')).status).toBe(403);
            expect((await move(outsider, PlaylistItemId!, '1')).status).toBe(404);
            expect((await move(editor, PlaylistItemId!, '1')).status).toBe(204);
            expect((await move(owner, '0000000000004000a00000007fffffff', '0')).status).toBe(404);
            // An entry id above int4 is malformed, not a Postgres 22003 → 500.
            expect((await move(owner, '0000000000004000a000ffffffffffff', '0')).status).toBe(422);
            expect((await move(owner, PlaylistItemId!, '-1')).status).toBe(422);
        });

        it('expands a series to its episodes', async () => {
            const series = await insertTestMediaItem(
                sql,
                createTestMediaItem({ media_type: 'tv', title: 'Show', has_files: true }),
            );
            const season = await insertTestMediaItem(
                sql,
                createTestMediaItem({ media_type: 'season', parent_id: series, has_files: true }),
            );
            const eps: string[] = [];
            for (const n of [1, 2]) {
                const ep = await insertTestMediaItem(
                    sql,
                    createTestMediaItem({
                        media_type: 'episode',
                        title: `E${n}`,
                        parent_id: season,
                        has_files: true,
                    }),
                );
                await sql`
                    UPDATE media_items SET season_number = 1, episode_number = ${n}
                    WHERE id = ${ep}::uuid
                `;
                await attachFile(ep);
                eps.push(ep);
            }
            await sql`UPDATE media_items SET age_rating = 6 WHERE id = ANY(${[series, season, ...eps]}::uuid[])`;

            const pid = await sharedPlaylist();
            expect(await addItems(owner, pid, [series])).toBe(204);
            const rows = await sql<{ media_id: string }[]>`
                SELECT media_id FROM playlist_items
                WHERE playlist_id = (SELECT id FROM playlists WHERE user_id = ${owner.id}::uuid AND is_system = false)
                ORDER BY position
            `;
            expect(rows.map((r) => r.media_id)).toEqual(eps);

            const pid2 = playlistIdToUuid(
                (await createPlaylist(sql, toUserId(editor.id), 'S', null, 'private', 'video')).id,
            );
            expect(await addItems(editor, pid2, [season])).toBe(204);
            const rows2 = await sql<{ media_id: string }[]>`
                SELECT media_id FROM playlist_items
                WHERE playlist_id = (SELECT id FROM playlists WHERE user_id = ${editor.id}::uuid AND is_system = false)
                ORDER BY position
            `;
            expect(rows2.map((r) => r.media_id)).toEqual(eps);
        });
    });

    describe('POST /Playlists/{id} (update)', () => {
        async function update(user: TestUser, pid: string, body: unknown): Promise<number> {
            const res = await call(playlistPost, user, {
                method: 'POST',
                path: `/j/Playlists/${pid}`,
                params: { playlistId: pid },
                body,
            });
            return res.status;
        }

        it.each([
            ['owner', 204],
            ['editor', 204],
            ['reader', 403],
            ['outsider', 404],
        ] as const)('%s renaming → %i', async (who, expected) => {
            const pid = await sharedPlaylist();
            const users = { owner, editor, reader, outsider };
            expect(await update(users[who], pid, { Name: 'Renamed' })).toBe(expected);
        });

        it('replaces Ids, sets IsPublic and Users as owner', async () => {
            const pid = await sharedPlaylist();
            await addItems(owner, pid, [movies[0]]);
            expect(
                await update(owner, pid, {
                    Ids: [movies[2], movies[1]],
                    IsPublic: true,
                    Users: [{ UserId: dashless(reader.id), CanEdit: true }],
                }),
            ).toBe(204);
            expect((await listItems(owner, pid)).Items.map((i) => i.Id)).toEqual([
                movies[2],
                movies[1],
            ]);
            const members = await sql<{ user_id: string; role: string; status: string }[]>`
                SELECT user_id, role, status FROM playlist_members
                WHERE playlist_id = (SELECT id FROM playlists WHERE user_id = ${owner.id}::uuid AND is_system = false)
            `;
            // Editor dropped; reader kept its accepted status and became editor.
            expect(members).toEqual([{ user_id: reader.id, role: 'editor', status: 'accepted' }]);
            const [{ visibility }] = await sql<{ visibility: string }[]>`
                SELECT visibility FROM playlists WHERE user_id = ${owner.id}::uuid AND is_system = false
            `;
            expect(visibility).toBe('public');
        });

        it('refuses more than 100 distinct Users and invites nobody; duplicates count once', async () => {
            const pid = await sharedPlaylist();
            const strangers = Array.from({ length: 100 }, () => ({
                UserId: randomUUID(),
                CanEdit: false,
            }));
            const tooMany = [{ UserId: dashless(outsider.id), CanEdit: true }, ...strangers];
            expect(await update(owner, pid, { Users: tooMany })).toBe(422);
            const members = await sql<{ user_id: string }[]>`
                SELECT user_id FROM playlist_members
                WHERE playlist_id = (SELECT id FROM playlists WHERE user_id = ${owner.id}::uuid AND is_system = false)
                ORDER BY user_id
            `;
            expect(members.map((m) => m.user_id).sort()).toEqual([editor.id, reader.id].sort());

            const created = await call(createPost, owner, {
                method: 'POST',
                path: '/j/Playlists',
                body: { Name: 'Too shared', Users: tooMany },
            });
            expect(created.status).toBe(422);
            const [{ n }] = await sql<{ n: number }[]>`
                SELECT count(*)::int AS n FROM playlists WHERE name = 'Too shared'
            `;
            expect(n).toBe(0);

            // 150 entries naming one user are one share.
            const same = Array.from({ length: 150 }, () => ({
                UserId: dashless(reader.id),
                CanEdit: false,
            }));
            expect(await update(owner, pid, { Users: same })).toBe(204);
        });

        it('lets an editor rename but not change sharing', async () => {
            const pid = await sharedPlaylist();
            expect(await update(editor, pid, { IsPublic: true })).toBe(403);
            expect(await update(editor, pid, { Users: [] })).toBe(403);
        });

        it('rejects a missing body, empty name, bad IsPublic, bad Ids', async () => {
            const pid = await sharedPlaylist();
            expect(await update(owner, pid, [])).toBe(422);
            expect(await update(owner, pid, { Name: '   ' })).toBe(422);
            expect(await update(owner, pid, { IsPublic: 'yes' })).toBe(422);
            expect(await update(owner, pid, { Ids: ['nope'] })).toBe(422);
        });
    });

    describe('Users (shares)', () => {
        it('GET /Users is owner-only', async () => {
            const pid = await sharedPlaylist();
            const ownerRes = await call(usersGet, owner, {
                method: 'GET',
                path: `/j/Playlists/${pid}/Users`,
                params: { playlistId: pid },
            });
            expect(ownerRes.status).toBe(200);
            expect(await ownerRes.json()).toEqual(
                expect.arrayContaining([
                    { UserId: dashless(editor.id), CanEdit: true },
                    { UserId: dashless(reader.id), CanEdit: false },
                ]),
            );
            for (const [user, status] of [
                [editor, 403],
                [reader, 403],
                [outsider, 404],
            ] as const) {
                const res = await call(usersGet, user, {
                    method: 'GET',
                    path: `/j/Playlists/${pid}/Users`,
                    params: { playlistId: pid },
                });
                expect(res.status).toBe(status);
            }
        });

        it('GET /Users/{userId} answers the caller about themselves', async () => {
            const pid = await sharedPlaylist();
            const get = (user: TestUser, target: string): Promise<Response> =>
                call(userGet, user, {
                    method: 'GET',
                    path: `/j/Playlists/${pid}/Users/${target}`,
                    params: { playlistId: pid, userId: target },
                });
            expect(await (await get(owner, dashless(owner.id))).json()).toEqual({
                UserId: dashless(owner.id),
                CanEdit: true,
            });
            expect(await (await get(editor, editor.id)).json()).toEqual({
                UserId: dashless(editor.id),
                CanEdit: true,
            });
            expect(await (await get(reader, reader.id)).json()).toEqual({
                UserId: dashless(reader.id),
                CanEdit: false,
            });
            expect(await (await get(owner, reader.id)).json()).toEqual({
                UserId: dashless(reader.id),
                CanEdit: false,
            });
            expect((await get(editor, reader.id)).status).toBe(403);
            expect((await get(owner, outsider.id)).status).toBe(404);
            expect((await get(outsider, outsider.id)).status).toBe(404);
            expect((await get(owner, 'bad')).status).toBe(422);
        });

        it('POST /Users/{userId}: owner invites or re-roles; others are refused', async () => {
            const pid = await sharedPlaylist();
            const post = (user: TestUser, target: string, body?: unknown): Promise<Response> =>
                call(userPost, user, {
                    method: 'POST',
                    path: `/j/Playlists/${pid}/Users/${target}`,
                    params: { playlistId: pid, userId: target },
                    body,
                });
            expect((await post(owner, dashless(outsider.id), { CanEdit: true })).status).toBe(204);
            expect((await post(owner, reader.id, { CanEdit: true })).status).toBe(204);
            const members = await sql<{ user_id: string; role: string; status: string }[]>`
                SELECT user_id, role, status FROM playlist_members
                WHERE user_id = ANY(${[outsider.id, reader.id]}::uuid[])
                ORDER BY status
            `;
            expect(members).toEqual([
                { user_id: reader.id, role: 'editor', status: 'accepted' },
                { user_id: outsider.id, role: 'editor', status: 'pending' },
            ]);

            expect((await post(editor, outsider.id, { CanEdit: false })).status).toBe(403);
            expect((await post(reader, outsider.id)).status).toBe(403);
            expect((await post(owner, owner.id)).status).toBe(422);
            expect((await post(owner, '00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
            expect((await post(owner, reader.id, { CanEdit: 'x' })).status).toBe(422);
        });

        it('DELETE /Users/{userId}: owner removes anyone, members only themselves', async () => {
            const pid = await sharedPlaylist();
            const del = (user: TestUser, target: string): Promise<Response> =>
                call(userDelete, user, {
                    method: 'DELETE',
                    path: `/j/Playlists/${pid}/Users/${target}`,
                    params: { playlistId: pid, userId: target },
                });
            expect((await del(editor, reader.id)).status).toBe(403);
            expect((await del(reader, reader.id)).status).toBe(204);
            expect((await del(owner, editor.id)).status).toBe(204);
            expect((await del(owner, editor.id)).status).toBe(404);
            expect((await del(outsider, outsider.id)).status).toBe(404);
        });
    });

    describe('system watchlist', () => {
        it('cannot be renamed, shared, made public or reordered, but takes items', async () => {
            const watchlistId = await ensureWatchlistPlaylist(sql, toUserId(owner.id));
            const pid = playlistIdToUuid(Number(watchlistId));

            const rename = await call(playlistPost, owner, {
                method: 'POST',
                path: `/j/Playlists/${pid}`,
                params: { playlistId: pid },
                body: { Name: 'Mine now' },
            });
            expect(rename.status).toBe(403);

            const share = await call(userPost, owner, {
                method: 'POST',
                path: `/j/Playlists/${pid}/Users/${editor.id}`,
                params: { playlistId: pid, userId: editor.id },
            });
            expect(share.status).toBe(403);

            expect(await addItems(owner, pid, [movies[0], movies[1]])).toBe(204);
            const items = await listItems(owner, pid);
            expect(items.TotalRecordCount).toBe(2);

            const move = await call(movePost, owner, {
                method: 'POST',
                path: `/j/Playlists/${pid}/Items/${items.Items[0].PlaylistItemId}/Move/1`,
                params: {
                    playlistId: pid,
                    itemId: items.Items[0].PlaylistItemId!,
                    newIndex: '1',
                },
            });
            expect(move.status).toBe(403);

            const del = await call(itemsDelete, owner, {
                method: 'DELETE',
                path: `/j/Playlists/${pid}/Items?entryIds=${items.Items[0].PlaylistItemId}`,
                params: { playlistId: pid },
            });
            expect(del.status).toBe(204);
            expect((await listItems(owner, pid)).TotalRecordCount).toBe(1);

            const [row] = await sql<{ name: string; is_system: boolean }[]>`
                SELECT name, is_system FROM playlists WHERE id = ${Number(watchlistId)}
            `;
            expect(row.is_system).toBe(true);
            expect(row.name).not.toBe('Mine now');
        });
    });

    describe('hidden entries, foreign entry ids, pending invitees, library scope', () => {
        const kid = (u: TestUser): TestUser => ({ ...u, maxAgeRating: 12 });

        /** Owner-built playlist [movies[0], adultMovie, movies[1], movies[2]] and its entry ids. */
        async function withHiddenEntry(): Promise<{ pid: string; entry: Map<string, string> }> {
            const pid = await sharedPlaylist();
            expect(await addItems(owner, pid, [movies[0], adultMovie, movies[1], movies[2]])).toBe(
                204,
            );
            const listed = await listItems(owner, pid);
            expect(listed.Items.map((i) => i.Id)).toEqual([
                movies[0],
                adultMovie,
                movies[1],
                movies[2],
            ]);
            return { pid, entry: new Map(listed.Items.map((i) => [i.Id, i.PlaylistItemId!])) };
        }

        it('an editor cannot delete or move an entry whose item is hidden from them', async () => {
            const { pid, entry } = await withHiddenEntry();
            const hidden = entry.get(adultMovie)!;
            const del = await call(itemsDelete, kid(editor), {
                method: 'DELETE',
                path: `/j/Playlists/${pid}/Items?entryIds=${hidden}`,
                params: { playlistId: pid },
            });
            expect(del.status).toBe(204);
            const move = await call(movePost, kid(editor), {
                method: 'POST',
                path: `/j/Playlists/${pid}/Items/${hidden}/Move/0`,
                params: { playlistId: pid, itemId: hidden, newIndex: '0' },
            });
            expect(move.status).toBe(404);
            expect((await listItems(owner, pid)).Items.map((i) => i.Id)).toEqual([
                movies[0],
                adultMovie,
                movies[1],
                movies[2],
            ]);
        });

        it('Move keeps hidden entries in place', async () => {
            const { pid, entry } = await withHiddenEntry();
            const charlie = entry.get(movies[2])!;
            // The kid editor sees [Alpha, Bravo, Charlie]; move Charlie to the front.
            const res = await call(movePost, kid(editor), {
                method: 'POST',
                path: `/j/Playlists/${pid}/Items/${charlie}/Move/0`,
                params: { playlistId: pid, itemId: charlie, newIndex: '0' },
            });
            expect(res.status).toBe(204);
            expect((await listItems(owner, pid)).Items.map((i) => i.Id)).toEqual([
                movies[2],
                movies[0],
                adultMovie,
                movies[1],
            ]);
        });

        it('replacing Ids as a restricted editor keeps the entries hidden from them', async () => {
            const { pid } = await withHiddenEntry();
            const res = await call(playlistPost, kid(editor), {
                method: 'POST',
                path: `/j/Playlists/${pid}`,
                params: { playlistId: pid },
                body: { Ids: [movies[1]] },
            });
            expect(res.status).toBe(204);
            expect((await listItems(owner, pid)).Items.map((i) => i.Id)).toEqual([
                adultMovie,
                movies[1],
            ]);
            expect((await listItems(kid(editor), pid)).Items.map((i) => i.Id)).toEqual([movies[1]]);
        });

        it("a PlaylistItemId from playlist A never touches A through playlist B's routes", async () => {
            const a = await sharedPlaylist();
            await addItems(owner, a, [movies[0], movies[1]]);
            const aEntries = (await listItems(owner, a)).Items.map((i) => i.PlaylistItemId!);
            const b = await sharedPlaylist();
            await addItems(owner, b, [movies[2]]);

            const del = await call(itemsDelete, owner, {
                method: 'DELETE',
                path: `/j/Playlists/${b}/Items?entryIds=${aEntries.join(',')}`,
                params: { playlistId: b },
            });
            expect(del.status).toBe(204);
            const move = await call(movePost, owner, {
                method: 'POST',
                path: `/j/Playlists/${b}/Items/${aEntries[1]}/Move/0`,
                params: { playlistId: b, itemId: aEntries[1], newIndex: '0' },
            });
            expect(move.status).toBe(404);

            const aAfter = await listItems(owner, a);
            expect(aAfter.Items.map((i) => i.Id)).toEqual([movies[0], movies[1]]);
            expect(aAfter.Items.map((i) => i.PlaylistItemId)).toEqual(aEntries);
            expect((await listItems(owner, b)).Items.map((i) => i.Id)).toEqual([movies[2]]);
        });

        it('a pending (not yet accepted) invitee gets 404 on every route', async () => {
            const row = await createPlaylist(
                sql,
                toUserId(owner.id),
                'Pending',
                null,
                'private',
                'video',
            );
            await inviteMember(sql, row.id, toUserId(outsider.id), 'editor');
            const pid = playlistIdToUuid(row.id);
            await addItems(owner, pid, [movies[0]]);
            const [{ PlaylistItemId }] = (await listItems(owner, pid)).Items;
            const p = { playlistId: pid };
            const responses = [
                await call(playlistGet, outsider, {
                    method: 'GET',
                    path: `/j/Playlists/${pid}`,
                    params: p,
                }),
                await call(playlistPost, outsider, {
                    method: 'POST',
                    path: `/j/Playlists/${pid}`,
                    params: p,
                    body: { Name: 'Taken over' },
                }),
                await call(itemsGet, outsider, {
                    method: 'GET',
                    path: `/j/Playlists/${pid}/Items`,
                    params: p,
                }),
                await call(itemsPost, outsider, {
                    method: 'POST',
                    path: `/j/Playlists/${pid}/Items?ids=${movies[1]}`,
                    params: p,
                }),
                await call(itemsDelete, outsider, {
                    method: 'DELETE',
                    path: `/j/Playlists/${pid}/Items?entryIds=${PlaylistItemId}`,
                    params: p,
                }),
                await call(movePost, outsider, {
                    method: 'POST',
                    path: `/j/Playlists/${pid}/Items/${PlaylistItemId}/Move/0`,
                    params: { ...p, itemId: PlaylistItemId!, newIndex: '0' },
                }),
                await call(usersGet, outsider, {
                    method: 'GET',
                    path: `/j/Playlists/${pid}/Users`,
                    params: p,
                }),
                await call(userGet, outsider, {
                    method: 'GET',
                    path: `/j/Playlists/${pid}/Users/${outsider.id}`,
                    params: { ...p, userId: outsider.id },
                }),
                await call(userPost, outsider, {
                    method: 'POST',
                    path: `/j/Playlists/${pid}/Users/${outsider.id}`,
                    params: { ...p, userId: outsider.id },
                    body: { CanEdit: true },
                }),
                await call(userDelete, outsider, {
                    method: 'DELETE',
                    path: `/j/Playlists/${pid}/Users/${outsider.id}`,
                    params: { ...p, userId: outsider.id },
                }),
            ];
            expect(responses.map((r) => r.status)).toEqual(Array(responses.length).fill(404));

            const [state] = await sql<{ name: string; status: string; items: number }[]>`
                SELECT p.name,
                       (SELECT status FROM playlist_members WHERE playlist_id = p.id AND user_id = ${outsider.id}::uuid) AS status,
                       (SELECT count(*)::int FROM playlist_items WHERE playlist_id = p.id) AS items
                FROM playlists p WHERE p.id = ${row.id}
            `;
            expect(state).toEqual({ name: 'Pending', status: 'pending', items: 1 });
        });

        describe('library-group scope', () => {
            let groupId: string;

            beforeEach(async () => {
                const [g] = await sql<{ id: string }[]>`
                    INSERT INTO library_groups (name) VALUES (${`Playlists restricted ${Date.now()}-${Math.random()}`}) RETURNING id
                `;
                groupId = g.id;
                await sql`
                    INSERT INTO library_group_permissions (library_group_id, allowed_groups)
                    VALUES (${groupId}, ${['family-only']})
                `;
                // adultMovie's library is restricted to the "family-only" group; its
                // age rating is lowered so only the library axis hides it.
                await sql`UPDATE media_items SET age_rating = 6, library_group_id = ${groupId} WHERE id = ${adultMovie}::uuid`;
                await sql`
                    UPDATE media_files SET library_group_id = ${groupId}
                    WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${adultMovie}::uuid)
                `;
                invalidateLibraryGroupPermissionsCache();
            });

            afterEach(async () => {
                await sql`DELETE FROM library_group_permissions WHERE library_group_id = ${groupId}`;
                invalidateLibraryGroupPermissionsCache();
            });

            it('scopes adds, deletes, moves and Ids replacement to the libraries the editor can see', async () => {
                const owners = { ...owner, userGroups: ['family-only'] };
                const pid = await sharedPlaylist();
                expect(await addItems(owners, pid, [movies[0], adultMovie, movies[1]])).toBe(204);
                const listed = await listItems(owners, pid);
                expect(listed.Items.map((i) => i.Id)).toEqual([movies[0], adultMovie, movies[1]]);
                const hidden = listed.Items[1].PlaylistItemId!;

                // The editor is not in "family-only": the entry is invisible to them.
                expect((await listItems(editor, pid)).Items.map((i) => i.Id)).toEqual([
                    movies[0],
                    movies[1],
                ]);
                expect(await addItems(editor, pid, [adultMovie, movies[2]])).toBe(204);
                const del = await call(itemsDelete, editor, {
                    method: 'DELETE',
                    path: `/j/Playlists/${pid}/Items?entryIds=${hidden}`,
                    params: { playlistId: pid },
                });
                expect(del.status).toBe(204);
                const move = await call(movePost, editor, {
                    method: 'POST',
                    path: `/j/Playlists/${pid}/Items/${hidden}/Move/0`,
                    params: { playlistId: pid, itemId: hidden, newIndex: '0' },
                });
                expect(move.status).toBe(404);
                const replaced = await call(playlistPost, editor, {
                    method: 'POST',
                    path: `/j/Playlists/${pid}`,
                    params: { playlistId: pid },
                    body: { Ids: [movies[2]] },
                });
                expect(replaced.status).toBe(204);

                expect((await listItems(owners, pid)).Items.map((i) => i.Id)).toEqual([
                    adultMovie,
                    movies[2],
                ]);
            });
        });
    });

    describe('Collections', () => {
        it('answers every collection write with 403', async () => {
            const create = await call(collectionPost, owner, {
                method: 'POST',
                path: '/j/Collections?name=Box',
            });
            expect(create.status).toBe(403);
            const cid = '11111111-2222-4333-8444-555555555555';
            for (const handler of [collectionItemsPost, collectionItemsDelete]) {
                const res = await call(handler, owner, {
                    method: 'POST',
                    path: `/j/Collections/${cid}/Items?ids=${movies[0]}`,
                    params: { collectionId: cid },
                });
                expect(res.status).toBe(403);
            }
        });
    });
});
