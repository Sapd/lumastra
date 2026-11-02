// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for catalog/series/watch-marker.ts — `GET /series/{id}/watch-marker`.
 *
 * The resolver (`effectiveSeriesMarker`) and the access gate are mocked; these
 * tests pin the handler contract: auth, the not-found/denied 404, the body
 * passthrough, and that the caller's `from` / `fromPositionMs` /
 * `excludeSessionId` reach the resolver.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { SeriesMarker } from '$lib/server/services/effective-series-marker.service.js';
import { SeriesWatchMarkerSchema } from '$lib/schemas/api-series-responses';

const { effectiveSeriesMarker, checkMediaAccess, resolveSeriesId, getMediaItemType } = vi.hoisted(
    () => ({
        effectiveSeriesMarker: vi.fn(),
        checkMediaAccess: vi.fn(),
        resolveSeriesId: vi.fn(),
        getMediaItemType: vi.fn(),
    }),
);

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => ({}),
    getTaskDb: () => ({}),
}));

vi.mock('$lib/server/database/queries/watch-state.queries.js', () => ({
    getUserWatchState: { one: vi.fn().mockResolvedValue({ runtime_ms: 2640000 }) },
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess }));

vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({ getMediaItemType }));

vi.mock('./resolve-series-id.js', () => ({
    resolveSeriesId: resolveSeriesId,
    isUuid: vi.fn().mockReturnValue(true),
}));

vi.mock('$lib/server/services/effective-series-marker.service.js', () => ({
    effectiveSeriesMarker,
}));

import { def } from './watch-marker.js';

const SERIES_ID = '11111111-1111-4111-8111-111111111111';
const FROM_ID = '22222222-2222-4222-8222-222222222222';

const MARKER: SeriesMarker = {
    state: 'in_progress',
    progress: {
        positionMs: 1_320_000,
        durationMs: null,
        fraction: null,
        finished: false,
        updatedAt: '2026-09-21T22:00:00.000Z',
    },
    episode: {
        id: '33333333-3333-4333-8333-333333333333',
        seasonNumber: 1,
        episodeNumber: 10,
        title: 'Episode 10',
        orderKey: 1_010,
    },
    positionMs: 1_320_000,
    updatedAt: '2026-09-21T22:00:00.000Z',
    deviceName: 'iPhone',
    relation: 'forward',
    sameFileAsFrom: false,
};

type Query = { from?: string; fromPositionMs?: number; excludeSessionId?: string };

function fakeEvent(opts: { userId?: string | null } = {}): RequestEvent {
    const url = new URL(`http://localhost/api/v1/series/${SERIES_ID}/watch-marker`);
    const user =
        opts.userId === null
            ? undefined
            : {
                  userId: opts.userId ?? 'test-user-uuid',
                  username: 'alice',
                  isAdmin: false,
                  isAgeRestricted: false,
              };
    return {
        url,
        request: new Request(url, { method: 'GET' }),
        params: { id: SERIES_ID },
        locals: { user, resolvedIds: undefined },
        route: { id: null },
    } as unknown as RequestEvent;
}

function ctx(query: Query = {}) {
    return {
        surface: 'v1' as const,
        input: { query, body: undefined, params: undefined },
    } as unknown as Parameters<NonNullable<typeof def.handlers.GET>>[1];
}

beforeEach(() => {
    vi.clearAllMocks();
    effectiveSeriesMarker.mockResolvedValue(MARKER);
    checkMediaAccess.mockResolvedValue(true);
    resolveSeriesId.mockResolvedValue(SERIES_ID);
    getMediaItemType.mockResolvedValue('tv');
});

describe('watch-marker def structure', () => {
    it('declares user auth and a bearer GET doc', () => {
        expect(def.auth).toEqual({ kind: 'user' });
        expect(def.docs?.GET?.auth).toBe('bearer');
        expect(def.docs?.GET?.tags).toEqual(['Series']);
        expect(def.docs?.GET?.stability).toBe('stable');
    });
});

describe('GET /series/{id}/watch-marker', () => {
    it('401 without a user', async () => {
        const res = await def.handlers.GET!(fakeEvent({ userId: null }), ctx());
        expect(res.status).toBe(401);
        expect(effectiveSeriesMarker).not.toHaveBeenCalled();
    });

    it('404 when the series id does not resolve', async () => {
        resolveSeriesId.mockResolvedValue(null);
        const res = await def.handlers.GET!(fakeEvent(), ctx());
        expect(res.status).toBe(404);
        expect(effectiveSeriesMarker).not.toHaveBeenCalled();
    });

    it('404 for a series the caller may not access', async () => {
        checkMediaAccess.mockResolvedValue(false);
        const res = await def.handlers.GET!(fakeEvent(), ctx());
        expect(res.status).toBe(404);
        expect(effectiveSeriesMarker).not.toHaveBeenCalled();
    });

    it.each(['movie', 'episode'])('404 when the id names a %s, not a series', async (type) => {
        getMediaItemType.mockResolvedValue(type);
        const res = await def.handlers.GET!(fakeEvent(), ctx());
        expect(res.status).toBe(404);
        expect(effectiveSeriesMarker).not.toHaveBeenCalled();
    });

    it('200 passes the marker through unchanged and matches the schema', async () => {
        const res = await def.handlers.GET!(fakeEvent(), ctx());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject(MARKER);
        // The marker service owns the progress block; the handler passes it through.
        expect(body.progress).toEqual(MARKER.progress);
        expect(SeriesWatchMarkerSchema.safeParse(body).success).toBe(true);
    });

    it('a marker without an episode is still a valid 200 body', async () => {
        const empty: SeriesMarker = {
            ...MARKER,
            state: 'not_started',
            progress: {
                positionMs: null,
                durationMs: null,
                fraction: null,
                finished: false,
                updatedAt: null,
            },
            episode: null,
            positionMs: 0,
            updatedAt: null,
            deviceName: null,
            relation: 'none',
        };
        effectiveSeriesMarker.mockResolvedValue(empty);
        const res = await def.handlers.GET!(fakeEvent(), ctx());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject(empty);
        expect(body.progress.durationMs).toBeNull();
        expect(SeriesWatchMarkerSchema.safeParse(body).success).toBe(true);
    });

    it('forwards from / fromPositionMs / excludeSessionId to the resolver', async () => {
        await def.handlers.GET!(
            fakeEvent(),
            ctx({ from: FROM_ID, fromPositionMs: 60_000, excludeSessionId: 'sess-1' }),
        );
        expect(effectiveSeriesMarker).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'test-user-uuid',
                seriesId: SERIES_ID,
                fromEpisodeId: FROM_ID,
                fromPositionMs: 60_000,
                excludeSessionId: 'sess-1',
            }),
        );
    });

    it('omitted query params reach the resolver as null', async () => {
        await def.handlers.GET!(fakeEvent(), ctx());
        expect(effectiveSeriesMarker).toHaveBeenCalledWith(
            expect.objectContaining({
                fromEpisodeId: null,
                fromPositionMs: null,
                excludeSessionId: null,
            }),
        );
    });
});

describe('watch-marker request query', () => {
    const query = def.request!.query!;

    it('accepts a uuid from + non-negative integer position', () => {
        const parsed = query.safeParse({ from: FROM_ID, fromPositionMs: '1500' });
        expect(parsed.success).toBe(true);
        expect(parsed.data).toMatchObject({ from: FROM_ID, fromPositionMs: 1500 });
    });

    it('rejects a non-uuid from and a negative position', () => {
        expect(query.safeParse({ from: 'not-a-uuid' }).success).toBe(false);
        expect(query.safeParse({ fromPositionMs: '-1' }).success).toBe(false);
    });
});
