// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test for review Important 1 on Task 1 of the watchlist-as-
 * system-playlist plan: `getOwnedPlaylists` now returns the caller's
 * `is_system` watchlist row, `transformPlaylistRow` turns it into a response
 * with `playlistType: 'watchlist'`, and that body goes through mount()'s
 * response-contract gate (`finalizeResponse` -> `inspectResponse`, which
 * `safeParse`s it against the def's declared 200 schema). Before this fix the
 * declared schema (`playlistSchema.playlistType` -> `playlistTypeSchema`,
 * `z.enum(['general','music','video'])`) rejected `'watchlist'` outright, and
 * the gate THROWS a `ResponseContractViolation` in test mode (NODE_ENV=test,
 * which vitest sets) rather than letting a drifting response pass silently.
 *
 * This exercises the real production path end to end: real DB row via
 * `ensureWatchlistPlaylist`, real `getOwnedPlaylists`, real
 * `transformPlaylistRow`, real `mount()`-wrapped `GET /playlists` handler —
 * nothing here is mocked. A prior version of this fix widened
 * `transformPlaylistRow`'s TS return type instead of the runtime Zod schema,
 * which would have made this test fail with the same
 * ResponseContractViolation despite `npm run typecheck` passing clean —
 * exactly the gap a compile-only check cannot see.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../../tests/integration/helpers/users.js';
import { toUserId } from '$lib/shared/user-id.js';
import { ensureWatchlistPlaylist } from '$lib/server/database/queries/watchlist-playlist.queries.js';
import { playlistsListResponseSchema } from '$lib/schemas/playlists.js';
import { mount } from '$lib/server/api/mount.js';
import { def } from './index.js';
import type postgres from 'postgres';

let sql: postgres.Sql;

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

function makeGetEvent(username: string, userId: string): RequestEvent {
    const url = new URL('http://localhost/api/v1/playlists');
    return {
        url,
        request: new Request(url.toString(), { method: 'GET' }),
        params: {},
        route: { id: '/api/v1/playlists' as const },
        locals: {
            user: {
                userId: toUserId(userId),
                username,
                groups: '',
                userGroups: [] as string[],
                hasWatchPermission: false,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                ownerIsAdmin: false,
                isModerator: false,
                maxAgeRating: null as null | number,
                isAgeRestricted: false,
                liveTvPriority: 'low' as const,
            },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: () => Promise.reject(new Error('fetch not stubbed')),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => {},
    } as unknown as RequestEvent;
}

describe('GET /playlists — watchlist row response-contract regression', () => {
    it('a watchlist playlist in the listing parses against playlistsListResponseSchema', async () => {
        const user = await createTestUser(sql);
        await ensureWatchlistPlaylist(sql, toUserId(user.id));

        const { GET } = mount(def, { surface: 'v1' });
        // If the response drifts from its declared schema, mount()'s
        // finalizeResponse() throws ResponseContractViolation here (test mode
        // only) rather than letting a bad body through — that throw IS the
        // regression signal, so no try/catch: an unexpected throw fails this
        // test with the violation's own message.
        const res = await GET!(makeGetEvent(user.username, user.id));

        expect(res.status).toBe(200);
        const body: unknown = await res.json();
        const parsed = playlistsListResponseSchema.safeParse(body);
        expect(parsed.success).toBe(true);

        const items = (body as { items: Array<{ playlistType: string }> }).items;
        const watchlistItem = items.find((item) => item.playlistType === 'watchlist');
        expect(watchlistItem).toBeDefined();
    });
});
