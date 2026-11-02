// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-Postgres coverage for the two-layer system-playlist guard (Task 3 of
 * the watchlist-as-system-playlist project).
 *
 * - The `getUserRole`/`updatePlaylist`/`deletePlaylist` tests exercise the
 *   SQL layer directly — the load-bearing guard that holds even if a def
 *   handler forgets its own check.
 * - The `def.handlers.*` tests drive the real route handlers (bypassing only
 *   `mount()`'s auth/CORS wiring — `defineEndpoint` is an identity function,
 *   see `api/define.ts`), with `getDb()` redirected to the test database, so
 *   a removed def-layer check shows up as a real test failure rather than a
 *   silent no-op — several of these routes have NO SQL guard underneath them
 *   (members/invite/chat/comments/reactions/reorder), so the def check is
 *   the only thing stopping the operation.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import type { UserContext } from '$lib/server/types.js';
import { getTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../../tests/integration/helpers/users.js';
import { toUserId } from '$lib/shared/user-id';
import {
    ensureWatchlistPlaylist,
    WATCHLIST_PLAYLIST_NAME,
} from '$lib/server/database/queries/watchlist-playlist.queries.js';
import { getUserRole } from '$lib/server/utils/playlist-utils.js';
import { updatePlaylist, deletePlaylist } from '$lib/server/database/queries/playlists.queries.js';
import type postgres from 'postgres';

vi.mock('$lib/server/database/connection.js', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database/connection.js')>();
    const { getTestDb: getSql } =
        await import('../../../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

const { def: playlistByIdDef } = await import('./[id]/index.js');
const { def: membersDef } = await import('./[id]/members/index.js');
const { def: chatDef } = await import('./[id]/chat/index.js');
const { def: reorderDef } = await import('./[id]/items/order.js');
const { def: memberByIdDef } = await import('./[id]/members/[userId].js');
const { playlistAccessGate } = await import('./[id]/access-gate.js');

const ctx: ApiContext = { surface: 'internal' };

function fullUser(overrides: Partial<UserContext> = {}): UserContext {
    return {
        userId: toUserId('00000000-0000-0000-0000-000000000000'),
        username: 'system-playlist-guard-test',
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
        ...overrides,
    };
}

function buildEvent(
    params: Record<string, string>,
    user: UserContext,
    method = 'GET',
    body?: unknown,
): RequestEvent {
    const url = new URL(`http://localhost/api/playlists/${params.id}`);
    return {
        params,
        locals: { user },
        url,
        request: new Request(url, {
            method,
            headers: { 'content-type': 'application/json' },
            body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
        }),
        route: { id: null },
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

describe('system playlist guards', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    it('reports isSystem for the watchlist and not for an ordinary playlist', async () => {
        const user = await createTestUser(sql);
        const watchlistId = await ensureWatchlistPlaylist(sql, toUserId(user.id));
        const [{ id: normalId }] = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, visibility, playlist_type)
            VALUES (${user.id}::uuid, 'Normal', 'private', 'general')
            RETURNING id
        `;

        const watchlistRole = await getUserRole(sql, watchlistId, null, user.id);
        const normalRole = await getUserRole(sql, normalId, null, user.id);

        expect(watchlistRole.isSystem).toBe(true);
        expect(normalRole.isSystem).toBe(false);
    });

    it('refuses to change a system playlist type (the delete bypass)', async () => {
        const user = await createTestUser(sql);
        const watchlistId = await ensureWatchlistPlaylist(sql, toUserId(user.id));

        await updatePlaylist(sql, watchlistId, { playlistType: 'general' });

        const rows = await sql<{ playlist_type: string; is_system: boolean }[]>`
            SELECT playlist_type, is_system FROM playlists WHERE id = ${watchlistId}
        `;
        expect(rows[0].playlist_type).toBe('watchlist');
        expect(rows[0].is_system).toBe(true);
    });

    it('refuses to rename a system playlist', async () => {
        const user = await createTestUser(sql);
        const watchlistId = await ensureWatchlistPlaylist(sql, toUserId(user.id));

        await updatePlaylist(sql, watchlistId, { name: 'Junk' });

        const rows = await sql<{ name: string }[]>`
            SELECT name FROM playlists WHERE id = ${watchlistId}
        `;
        expect(rows[0].name).toBe(WATCHLIST_PLAYLIST_NAME);
    });

    it('refuses to delete a system playlist even after an attempted PUT-then-DELETE bypass', async () => {
        const user = await createTestUser(sql);
        const watchlistId = await ensureWatchlistPlaylist(sql, toUserId(user.id));

        // Step 1: attempt the type-flip that would defeat a delete guard keyed
        // on playlist_type instead of is_system.
        await updatePlaylist(sql, watchlistId, { playlistType: 'general' });

        // Step 2: attempt the delete immediately after.
        const deleted = await deletePlaylist(sql, watchlistId, toUserId(user.id));
        expect(deleted).toBe(false);

        const rows = await sql<{ playlist_type: string; is_system: boolean }[]>`
            SELECT playlist_type, is_system FROM playlists WHERE id = ${watchlistId}
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].playlist_type).toBe('watchlist');
        expect(rows[0].is_system).toBe(true);
    });

    it('deletePlaylist blocks on is_system even if playlist_type has drifted from "watchlist" (isolates the predicate itself)', async () => {
        const user = await createTestUser(sql);
        const watchlistId = await ensureWatchlistPlaylist(sql, toUserId(user.id));

        // Bypass updatePlaylist entirely via raw SQL to construct the one
        // precondition that would let a playlist_type-keyed delete guard
        // diverge from an is_system-keyed one: is_system still true, but
        // playlist_type no longer 'watchlist'. updatePlaylist's own guard
        // means this state is otherwise unreachable through the app — this
        // test isolates deletePlaylist's own predicate from that fact.
        await sql`UPDATE playlists SET playlist_type = 'general' WHERE id = ${watchlistId}`;

        const deleted = await deletePlaylist(sql, watchlistId, toUserId(user.id));
        expect(deleted).toBe(false);

        const rows = await sql`SELECT id FROM playlists WHERE id = ${watchlistId}`;
        expect(rows).toHaveLength(1);
    });

    it('GET /playlists/{id} reports isSystem: true for the watchlist', async () => {
        const user = await createTestUser(sql);
        const watchlistId = await ensureWatchlistPlaylist(sql, toUserId(user.id));

        const event = buildEvent(
            { id: String(watchlistId) },
            fullUser({ userId: toUserId(user.id), username: user.username }),
        );

        const res = await playlistByIdDef.handlers.GET!(event, ctx);
        expect(res.status).toBe(200);
        const responseBody = (await res.json()) as { isSystem: boolean };
        expect(responseBody.isSystem).toBe(true);
    });

    it('POST /playlists/{watchlistId}/members refuses with 409 (no SQL guard sits under this route)', async () => {
        const owner = await createTestUser(sql);
        const invitee = await createTestUser(sql);
        const watchlistId = await ensureWatchlistPlaylist(sql, toUserId(owner.id));

        const event = buildEvent(
            { id: String(watchlistId) },
            fullUser({ userId: toUserId(owner.id), username: owner.username }),
            'POST',
            { userId: invitee.id, role: 'editor' },
        );

        const res = await membersDef.handlers.POST!(event, ctx);
        expect(res.status).toBe(409);
        const responseBody = (await res.json()) as { code?: string };
        expect(responseBody.code).toBe('conflict');
    });

    // -------------------------------------------------------------------
    // Final-review Important 2: nine more def-layer `is_system` guards had
    // no test — several of these routes have NO SQL guard underneath them,
    // so the def-layer check is the ONLY thing stopping the operation
    // (see this file's header). One 409 assertion per handler, table-driven,
    // each built fresh (its own owner + watchlist) so they can run in any
    // order/in parallel without sharing playlist state.
    // -------------------------------------------------------------------
    describe('def-layer is_system guards (Important 2 — final review)', () => {
        type GuardCase = {
            name: string;
            run: (args: {
                watchlistId: number;
                owner: { id: string; username: string };
            }) => Promise<Response>;
        };

        const VALID_MEMBER_UUID = '11111111-1111-4111-8111-111111111111';

        const cases: GuardCase[] = [
            {
                name: 'access-gate.ts — playlistAccessGate (shared by comments/reactions)',
                run: async ({ watchlistId, owner }) => {
                    const event = buildEvent(
                        { id: String(watchlistId) },
                        fullUser({ userId: toUserId(owner.id), username: owner.username }),
                    );
                    const result = await playlistAccessGate(
                        sql,
                        String(watchlistId),
                        event,
                        'read',
                    );
                    if (!result) {
                        throw new Error('expected playlistAccessGate to return a 409, got null');
                    }
                    return result;
                },
            },
            {
                name: 'chat/index.ts GET — list messages',
                run: async ({ watchlistId, owner }) => {
                    const event = buildEvent(
                        { id: String(watchlistId) },
                        fullUser({ userId: toUserId(owner.id), username: owner.username }),
                    );
                    return chatDef.handlers.GET!(event, ctx);
                },
            },
            {
                name: 'chat/index.ts POST — send message',
                run: async ({ watchlistId, owner }) => {
                    const event = buildEvent(
                        { id: String(watchlistId) },
                        fullUser({ userId: toUserId(owner.id), username: owner.username }),
                        'POST',
                        { message: 'hello' },
                    );
                    return chatDef.handlers.POST!(event, ctx);
                },
            },
            {
                name: 'items/order.ts PUT — reorder items (non-reorderability is a defining property of the watchlist)',
                run: async ({ watchlistId, owner }) => {
                    const event = buildEvent(
                        { id: String(watchlistId) },
                        fullUser({ userId: toUserId(owner.id), username: owner.username }),
                        'PUT',
                        { expectedRevision: 0, entryIds: [] },
                    );
                    return reorderDef.handlers.PUT!(event, ctx);
                },
            },
            {
                name: 'members/[userId].ts PUT — update member role (internal surface)',
                run: async ({ watchlistId, owner }) => {
                    const event = buildEvent(
                        { id: String(watchlistId), userId: VALID_MEMBER_UUID },
                        fullUser({ userId: toUserId(owner.id), username: owner.username }),
                        'PUT',
                        { role: 'editor' },
                    );
                    return memberByIdDef.handlers.PUT!(event, ctx);
                },
            },
            {
                name: 'members/[userId].ts DELETE — remove member (internal surface)',
                run: async ({ watchlistId, owner }) => {
                    const event = buildEvent(
                        { id: String(watchlistId), userId: VALID_MEMBER_UUID },
                        fullUser({ userId: toUserId(owner.id), username: owner.username }),
                        'DELETE',
                    );
                    return memberByIdDef.handlers.DELETE!(event, ctx);
                },
            },
            {
                name: 'members/[userId].ts PUT — update member role (v1 surface)',
                run: async ({ watchlistId, owner }) => {
                    const event = buildEvent(
                        { id: String(watchlistId), userId: VALID_MEMBER_UUID },
                        fullUser({ userId: toUserId(owner.id), username: owner.username }),
                        'PUT',
                        { role: 'editor' },
                    );
                    return memberByIdDef.handlers.PUT!(event, { surface: 'v1' });
                },
            },
            {
                name: 'members/[userId].ts DELETE — remove member (v1 surface)',
                run: async ({ watchlistId, owner }) => {
                    const event = buildEvent(
                        { id: String(watchlistId), userId: VALID_MEMBER_UUID },
                        fullUser({ userId: toUserId(owner.id), username: owner.username }),
                        'DELETE',
                    );
                    return memberByIdDef.handlers.DELETE!(event, { surface: 'v1' });
                },
            },
            {
                name: 'members/index.ts GET — list members',
                run: async ({ watchlistId, owner }) => {
                    const event = buildEvent(
                        { id: String(watchlistId) },
                        fullUser({ userId: toUserId(owner.id), username: owner.username }),
                    );
                    return membersDef.handlers.GET!(event, ctx);
                },
            },
        ];

        it.each(cases)('$name refuses with 409 on the watchlist', async ({ run }) => {
            const owner = await createTestUser(sql);
            const watchlistId = await ensureWatchlistPlaylist(sql, toUserId(owner.id));

            const res = await run({ watchlistId, owner });

            expect(res.status).toBe(409);
            const responseBody = (await res.json()) as { code?: string };
            expect(responseBody.code).toBe('conflict');
        });
    });
});
