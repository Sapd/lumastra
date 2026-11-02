// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/watch-state/{id} — the internal (SPA) mount of the shared
 * watch-state def, used by the web player's movie position re-check.
 *
 * Covers: a session (cookie / forward-auth) caller reads its position and
 * watched flag; no identity → 401; the internal mount is read-only (no PUT).
 *
 * NOTE: named server.test.ts (NOT +server.test.ts) — the `+` prefix is reserved
 * by SvelteKit for route files.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockReadWatched = vi.hoisted(() => vi.fn());
const mockGetWatchState = vi.hoisted(() => vi.fn());
const mockGetRating = vi.hoisted(() => vi.fn());
const mockGetSql = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/middleware/id-resolution.js', () => ({
    withIdResolution: (handler: (evt: unknown) => Promise<Response>) => (evt: unknown) =>
        handler(evt),
}));

vi.mock('$lib/server/middleware/validate', () => ({
    withValidation: (handler: unknown) => handler,
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/server/database/with-tx.js', () => ({
    withTx: vi.fn(),
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: mockGetSql },
}));

vi.mock('$lib/server/services/watched-state-ops.js', () => ({
    readWatchedStatus: mockReadWatched,
    markWatchedOp: vi.fn(),
    markUnwatchedOp: vi.fn(),
}));

vi.mock('$lib/server/database/queries/watch-state.queries.js', () => ({
    getUserWatchState: { one: mockGetWatchState },
    setUserMediaFavorite: vi.fn(),
}));

vi.mock('$lib/server/database/queries/user-ratings.queries.js', () => ({
    getUserRating: { one: mockGetRating },
    upsertUserRating: { one: vi.fn() },
    deleteUserRating: { execute: vi.fn() },
}));

const route = await import('./[id]/+server.js');

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const MEDIA_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeGetEvent(withUser: boolean): RequestEvent {
    const url = new URL('http://localhost/api/watch-state/' + MEDIA_ID);
    return {
        request: new Request(url, { method: 'GET' }),
        url,
        params: { id: MEDIA_ID },
        route: { id: '/api/watch-state/[id]' },
        locals: withUser
            ? {
                  // A session caller: forward-auth / cookie populate locals.user.
                  user: { userId: USER_ID, username: 'movie_viewer' },
                  resolvedIds: { internalId: MEDIA_ID },
              }
            : {},
    } as unknown as RequestEvent;
}

describe('GET /api/watch-state/{id} (internal surface)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockReadWatched.mockResolvedValue({ kind: 'ok', watched: false });
        mockGetWatchState.mockResolvedValue({
            is_watched: false,
            resume_position_ms: 2_400_000,
            runtime_ms: 6_000_000,
            watch_count: 0,
            last_watched_at: null,
            last_event_at: '2026-09-23T10:00:00.000Z',
            is_favorite: false,
        });
        mockGetRating.mockResolvedValue(null);
    });

    it('returns the caller position and watched flag for a session user', async () => {
        const res = await route.GET!(makeGetEvent(true));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ mediaId: MEDIA_ID, watched: false, positionMs: 2_400_000 });
        expect(mockReadWatched).toHaveBeenCalledWith(USER_ID, MEDIA_ID, expect.anything());
    });

    it('rejects a caller without identity with 401', async () => {
        const res = await route.GET!(makeGetEvent(false));
        expect(res.status).toBe(401);
        expect(mockReadWatched).not.toHaveBeenCalled();
    });

    it('is read-only: the internal mount exports no PUT', () => {
        expect(route.GET).toBeTypeOf('function');
        expect('PUT' in route).toBe(false);
    });
});
