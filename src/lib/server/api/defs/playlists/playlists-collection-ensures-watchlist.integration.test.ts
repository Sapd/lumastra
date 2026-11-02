// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * N1 (2026-09-22 edge-case pass on the watchlist-as-system-playlist project):
 * `GET /playlists` (both the internal and /api/v1 surfaces mount this same
 * def) never called `ensureWatchlistPlaylist` — only the web SSR route
 * (`routes/playlists/+page.server.ts`) did. A user who only ever talks to
 * the API (a native client, or a fresh /api/v1 token holder) would see no
 * Watchlist entry at all until the web page happened to be loaded once.
 *
 * `playlists-watchlist-response.integration.test.ts` covers the response
 * SHAPE of a watchlist row once one exists — it explicitly calls
 * `ensureWatchlistPlaylist` first, simulating a user who already has one.
 * This file covers the opposite precondition: a user who has NEVER had a
 * watchlist row created, hitting the collection endpoint directly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../../tests/integration/helpers/users.js';
import { toUserId } from '$lib/shared/user-id.js';
import { getWatchlistPlaylistId } from '$lib/server/database/queries/watchlist-playlist.queries.js';
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

function makeGetEvent(url: URL, username: string, userId: string): RequestEvent {
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

describe('GET /playlists — creates the watchlist on first access', () => {
    it('a brand-new user (no prior ensureWatchlistPlaylist call) sees a watchlist entry', async () => {
        const user = await createTestUser(sql);

        // Precondition: this user genuinely has no watchlist row yet — the
        // regression only reproduces if we start from nothing.
        expect(await getWatchlistPlaylistId(sql, toUserId(user.id))).toBeNull();

        const { GET } = mount(def, { surface: 'v1' });
        const url = new URL('http://localhost/api/v1/playlists');
        const res = await GET!(makeGetEvent(url, user.username, user.id));

        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: { playlistType: string; name: string }[] };
        const watchlistItem = body.items.find((item) => item.playlistType === 'watchlist');
        expect(watchlistItem).toBeDefined();
        expect(watchlistItem?.name).toBe('Watchlist');

        // And the row now genuinely exists in the DB, not just in the response.
        expect(await getWatchlistPlaylistId(sql, toUserId(user.id))).not.toBeNull();
    });

    it('scope=public never creates a watchlist row for the (unrelated) caller', async () => {
        const user = await createTestUser(sql);
        expect(await getWatchlistPlaylistId(sql, toUserId(user.id))).toBeNull();

        const { GET } = mount(def, { surface: 'v1' });
        const url = new URL('http://localhost/api/v1/playlists?scope=public');
        const res = await GET!(makeGetEvent(url, user.username, user.id));

        expect(res.status).toBe(200);
        expect(await getWatchlistPlaylistId(sql, toUserId(user.id))).toBeNull();
    });
});
