// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Virtual-season handles on GET/PATCH /api/v1/watch-state/{id}.
 *
 * A series-level access gate alone does not authorise the episodes under it,
 * so every denial case must answer 404 and write nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

const mocks = vi.hoisted(() => ({
    getSql: vi.fn(),
    checkMediaAccess: vi.fn(),
    getSeriesOrdering: vi.fn(),
    getEpisodes: vi.fn(),
    markWatched: vi.fn(),
    markUnwatched: vi.fn(),
    markWatchedOp: vi.fn(),
    markUnwatchedOp: vi.fn(),
    setFavorite: vi.fn(),
    upsertRating: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...a: unknown[]) => mocks.getSql(...a) },
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => mocks.checkMediaAccess(...a),
}));
vi.mock('$lib/server/middleware/id-resolution.js', () => ({
    withIdResolution:
        (handler: (event: unknown) => unknown) =>
        (event: unknown): unknown =>
            handler(event),
}));
vi.mock('$lib/server/database/queries/season-detail.queries.js', () => ({
    getSeriesOrdering: (...a: unknown[]) => mocks.getSeriesOrdering(...a),
}));
vi.mock('$lib/server/database/queries/episode-detail.queries.js', () => ({
    getSeriesEpisodesWithWatchState: (...a: unknown[]) => mocks.getEpisodes(...a),
}));
vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: {
        markWatched: (...a: unknown[]) => mocks.markWatched(...a),
        markUnwatched: (...a: unknown[]) => mocks.markUnwatched(...a),
    },
}));
vi.mock('$lib/server/services/watched-state-ops.js', () => ({
    readWatchedStatus: vi.fn().mockResolvedValue({ kind: 'ok', watched: false }),
    markWatchedOp: (...a: unknown[]) => mocks.markWatchedOp(...a),
    markUnwatchedOp: (...a: unknown[]) => mocks.markUnwatchedOp(...a),
}));
vi.mock('$lib/server/database/queries/watch-state.queries.js', () => ({
    getUserWatchState: { one: vi.fn().mockResolvedValue(null) },
    setUserMediaFavorite: (...a: unknown[]) => mocks.setFavorite(...a),
}));
vi.mock('$lib/server/database/queries/user-ratings.queries.js', () => ({
    getUserRating: { one: vi.fn().mockResolvedValue(null) },
    upsertUserRating: { one: (...a: unknown[]) => mocks.upsertRating(...a) },
    deleteUserRating: { execute: vi.fn() },
}));
vi.mock('$lib/server/database/queries/media-type-cache.queries.js', () => ({
    getMediaType: vi.fn().mockResolvedValue('series'),
    isMusicMediaType: () => false,
}));
vi.mock('$lib/server/database/queries/music-interactions.queries.js', () => ({
    setExplicitTrackRating: vi.fn(),
    clearTrackFeedback: vi.fn(),
}));
vi.mock('$lib/server/database/with-tx.js', () => ({
    withTx: async (sql: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(sql),
}));

import { mount } from '$lib/server/api/mount.js';
import { def } from './[id].js';

const CTX = { surface: 'v1' } as const;
const SERIES = '11111111-2222-3333-4444-555555555555';
const EP1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const EP2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const HANDLE = `vseason:${SERIES}:dvd:2`;
const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeEvent(method: 'GET' | 'PATCH', body?: unknown): RequestEvent {
    const url = `http://localhost/api/v1/watch-state/${encodeURIComponent(HANDLE)}`;
    const init: RequestInit =
        body === undefined
            ? { method }
            : {
                  method,
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(body),
              };
    return {
        url: new URL(url),
        request: new Request(url, init),
        params: { id: HANDLE },
        route: { id: '/api/v1/watch-state/[id]' },
        locals: {
            user: {
                userId: toUserId(USER_ID),
                username: 'alice',
                groups: '',
                userGroups: [] as string[],
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                isAdmin: false,
                isModerator: false,
                maxAgeRating: null,
                isAgeRestricted: false,
                liveTvPriority: 'low' as const,
            },
            resolvedIds: { internalId: HANDLE },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

function expectNothingWritten(): void {
    expect(mocks.markWatched).not.toHaveBeenCalled();
    expect(mocks.markUnwatched).not.toHaveBeenCalled();
    expect(mocks.markWatchedOp).not.toHaveBeenCalled();
    expect(mocks.markUnwatchedOp).not.toHaveBeenCalled();
    expect(mocks.setFavorite).not.toHaveBeenCalled();
    expect(mocks.upsertRating).not.toHaveBeenCalled();
}

describe('watch-state virtual season handles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSql.mockResolvedValue({});
        mocks.checkMediaAccess.mockResolvedValue(true);
        mocks.getSeriesOrdering.mockResolvedValue('dvd');
        mocks.getEpisodes.mockResolvedValue([
            { id: EP1, is_watched: false },
            { id: EP2, is_watched: false },
        ]);
    });

    it('PATCH watched:true writes through the watch manager when every target is allowed', async () => {
        const { PATCH } = mount(def, CTX);
        const res = await PATCH!(makeEvent('PATCH', { watched: true }));
        expect(res.status).toBe(200);
        expect(mocks.markWatched).toHaveBeenCalledTimes(1);
        expect(mocks.markWatched).toHaveBeenCalledWith({ userId: USER_ID, mediaId: HANDLE });
    });

    it('PATCH watched:true returns 404 and writes nothing when the series is denied', async () => {
        mocks.checkMediaAccess.mockImplementation(
            async (_sql: unknown, id: string) => id !== SERIES,
        );
        const { PATCH } = mount(def, CTX);
        const res = await PATCH!(makeEvent('PATCH', { watched: true }));
        expect(res.status).toBe(404);
        expectNothingWritten();
    });

    it('PATCH watched:true returns 404 and writes nothing when one episode is denied', async () => {
        mocks.checkMediaAccess.mockImplementation(async (_sql: unknown, id: string) => id !== EP2);
        const { PATCH } = mount(def, CTX);
        const res = await PATCH!(makeEvent('PATCH', { watched: true }));
        expect(res.status).toBe(404);
        expectNothingWritten();
    });

    it('PATCH watched:true returns 404 and writes nothing when the series ordering is stale', async () => {
        mocks.getSeriesOrdering.mockResolvedValue('standard');
        const { PATCH } = mount(def, CTX);
        const res = await PATCH!(makeEvent('PATCH', { watched: true }));
        expect(res.status).toBe(404);
        expectNothingWritten();
    });

    it.each([
        ['favorite', { favorite: true }],
        ['watched plus favorite', { watched: true, favorite: true }],
    ])('PATCH with %s on a virtual season returns 422 and writes nothing', async (_n, body) => {
        const { PATCH } = mount(def, CTX);
        const res = await PATCH!(makeEvent('PATCH', body));
        expect(res.status).toBe(422);
        expectNothingWritten();
    });

    it('GET returns the derived state when every target is allowed', async () => {
        const { GET } = mount(def, CTX);
        const res = await GET!(makeEvent('GET'));
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ mediaId: HANDLE, watched: false });
    });

    it('GET returns 404 when the series is denied', async () => {
        mocks.checkMediaAccess.mockImplementation(
            async (_sql: unknown, id: string) => id !== SERIES,
        );
        const { GET } = mount(def, CTX);
        expect((await GET!(makeEvent('GET'))).status).toBe(404);
    });

    it('GET returns 404 when one episode is denied', async () => {
        mocks.checkMediaAccess.mockImplementation(async (_sql: unknown, id: string) => id !== EP1);
        const { GET } = mount(def, CTX);
        expect((await GET!(makeEvent('GET'))).status).toBe(404);
    });

    it('GET returns 404 when the series ordering is stale', async () => {
        mocks.getSeriesOrdering.mockResolvedValue('absolute');
        const { GET } = mount(def, CTX);
        expect((await GET!(makeEvent('GET'))).status).toBe(404);
    });
});
