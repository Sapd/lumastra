// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/watch/<seriesId>` resolves through the series watch marker.
 *
 * Pins the series branch of the watch loader: where it redirects for each
 * marker outcome, and that the caller's `from` / `fromPos` / `sid` reach the
 * resolver. The resolver itself is covered by
 * `effective-series-marker.{test,integration.test}.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isHttpError, isRedirect } from '@sveltejs/kit';
import type {
    SeriesMarker,
    SeriesMarkerInput,
} from '$lib/server/services/effective-series-marker.service.js';

const { effectiveSeriesMarker, getMediaItemForWatch, checkMediaAccess, getFirstEpisode } =
    vi.hoisted(() => ({
        effectiveSeriesMarker: vi.fn(),
        getMediaItemForWatch: vi.fn(),
        checkMediaAccess: vi.fn(),
        getFirstEpisode: vi.fn(),
    }));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/catalog-operations.queries.js', () => ({
    getMediaItemForWatch,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess }));
vi.mock('$lib/server/services/effective-series-marker.service.js', () => ({
    effectiveSeriesMarker,
}));
vi.mock('$lib/server/services/watch-manager.service.js', () => ({
    watchManager: { getFirstEpisode },
}));
vi.mock('$lib/server/plugins/runtime/widget-metadata.js', () => ({
    listPluginWidgetsFor: vi.fn().mockResolvedValue([]),
}));

const { load } = await import('./+page.server.js');

const SERIES = '11111111-1111-4111-8111-111111111111';
const E8 = '22222222-2222-4222-8222-222222222208';
const E9 = '22222222-2222-4222-8222-222222222209';
const E10 = '22222222-2222-4222-8222-222222222210';
const E1 = '22222222-2222-4222-8222-222222222201';

const SERIES_ROW = {
    id: SERIES,
    title: 'Show',
    media_type: 'tv',
    series_id: null,
    series_title: null,
    season_number: null,
    episode_number: null,
};

function marker(overrides: Partial<SeriesMarker> = {}): SeriesMarker {
    return {
        state: 'in_progress',
        progress: {
            positionMs: 1_320_000,
            durationMs: null,
            fraction: null,
            finished: false,
            updatedAt: '2026-09-21T22:00:00.000Z',
        },
        episode: {
            id: E10,
            seasonNumber: 1,
            episodeNumber: 10,
            title: 'Ten',
            orderKey: 10_010,
        },
        positionMs: 1_320_000,
        updatedAt: '2026-09-21T22:00:00.000Z',
        deviceName: 'iPhone',
        relation: 'none',
        sameFileAsFrom: false,
        ...overrides,
    };
}

/** Runs the loader for `/watch/<SERIES>?<query>` and returns the redirect target. */
async function redirectFor(query: Record<string, string> = {}): Promise<URL> {
    const url = new URL(`http://localhost/watch/${SERIES}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    try {
        await load({
            params: { itemId: SERIES },
            locals: { user: { username: 'alice', userId: 'user-1' } },
            url,
        } as unknown as Parameters<typeof load>[0]);
    } catch (e) {
        if (isRedirect(e)) {
            expect(e.status).toBe(302);
            return new URL(e.location, 'http://localhost');
        }
        throw e;
    }
    throw new Error('expected a redirect');
}

function lastInput(): SeriesMarkerInput {
    return effectiveSeriesMarker.mock.calls.at(-1)![0] as SeriesMarkerInput;
}

beforeEach(() => {
    vi.clearAllMocks();
    getMediaItemForWatch.mockResolvedValue(SERIES_ROW);
    checkMediaAccess.mockResolvedValue(true);
});

describe('/watch/<seriesId> — no from', () => {
    it('redirects to the in-progress marker episode (E10), not next-up (E9)', async () => {
        effectiveSeriesMarker.mockResolvedValue(marker());
        const target = await redirectFor();
        expect(target.pathname).toBe(`/watch/${E10}`);
        expect(target.searchParams.get('resolved')).toBe('series');
        expect(target.searchParams.get('slug')).toBeTruthy();
        expect(target.searchParams.get('info')).toContain('S01E10');
        expect(target.searchParams.get('mk')).toBe('S01E10');
        expect(target.searchParams.get('dev')).toBe('iPhone');
        // The landing load resumes via resolveEffectiveResume — never a `t`.
        expect(target.searchParams.has('t')).toBe(false);
        expect(lastInput()).toMatchObject({
            seriesId: SERIES,
            fromEpisodeId: null,
            fromPositionMs: null,
            excludeSessionId: null,
        });
    });

    it('a next marker redirects there with resolved=series', async () => {
        effectiveSeriesMarker.mockResolvedValue(
            marker({
                state: 'next',
                episode: {
                    id: E9,
                    seasonNumber: 1,
                    episodeNumber: 9,
                    title: 'Nine',
                    orderKey: 10_009,
                },
                positionMs: 0,
                deviceName: null,
            }),
        );
        const target = await redirectFor();
        expect(target.pathname).toBe(`/watch/${E9}`);
        expect(target.searchParams.get('resolved')).toBe('series');
        expect(target.searchParams.has('dev')).toBe(false);
    });

    it('a finished series rewatches from the first main-line episode with resolved=series', async () => {
        effectiveSeriesMarker.mockResolvedValue(marker({ state: 'finished', positionMs: 0 }));
        getFirstEpisode.mockResolvedValue({
            media_id: E1,
            title: 'One',
            season_number: 1,
            episode_number: 1,
        });
        const target = await redirectFor();
        expect(getFirstEpisode).toHaveBeenCalledWith(SERIES);
        expect(target.pathname).toBe(`/watch/${E1}`);
        expect(target.searchParams.get('resolved')).toBe('series');
        expect(target.searchParams.get('info')).toBe('Rewatching from S01E01 - One');
        expect(target.searchParams.get('slug')).toBeTruthy();
        // A series Play never raises the finished card.
        expect(target.searchParams.has('from')).toBe(false);
        expect(target.searchParams.has('t')).toBe(false);
    });

    it('a finished series whose first-episode lookup fails lands on the marker with the card', async () => {
        effectiveSeriesMarker.mockResolvedValue(marker({ state: 'finished', positionMs: 0 }));
        getFirstEpisode.mockRejectedValue(new Error('db down'));
        const target = await redirectFor();
        expect(target.pathname).toBe(`/watch/${E10}`);
        expect(target.searchParams.get('resolved')).toBe('finished');
        expect(target.searchParams.has('info')).toBe(false);
    });

    it('a failing marker lookup falls back to the first episode', async () => {
        effectiveSeriesMarker.mockRejectedValue(new Error('db down'));
        getFirstEpisode.mockResolvedValue({
            media_id: E1,
            title: 'One',
            season_number: 1,
            episode_number: 1,
        });
        const target = await redirectFor();
        expect(target.pathname).toBe(`/watch/${E1}`);
        expect(target.searchParams.get('resolved')).toBe('series');
        expect(target.searchParams.get('info')).toContain('S01E01');
    });

    it('404 when both the marker lookup and the first-episode fallback fail', async () => {
        effectiveSeriesMarker.mockRejectedValue(new Error('db down'));
        getFirstEpisode.mockRejectedValue(new Error('db down'));
        await expect(redirectFor()).rejects.toSatisfy(
            (e: unknown) => isHttpError(e) && e.status === 404,
        );
    });

    it('404 when the marker has no episode', async () => {
        effectiveSeriesMarker.mockResolvedValue(
            marker({ state: 'not_started', episode: null, positionMs: 0 }),
        );
        await expect(redirectFor()).rejects.toSatisfy(
            (e: unknown) => isHttpError(e) && e.status === 404,
        );
    });
});

describe('/watch/<seriesId>?from=… — forward-only re-check', () => {
    it('M1: from=E8 with the marker forward to E10 redirects to E10 carrying from/fromPos', async () => {
        effectiveSeriesMarker.mockResolvedValue(marker({ relation: 'forward' }));
        const target = await redirectFor({ from: E8, fromPos: '600000', sid: 'sess-tab' });
        expect(target.pathname).toBe(`/watch/${E10}`);
        expect(target.searchParams.get('resolved')).toBe('series');
        expect(target.searchParams.get('from')).toBe(E8);
        expect(target.searchParams.get('fromPos')).toBe('600000');
        expect(target.searchParams.get('mk')).toBe('S01E10');
        expect(target.searchParams.get('dev')).toBe('iPhone');
        expect(target.searchParams.has('sid')).toBe(false);
        expect(lastInput()).toMatchObject({
            seriesId: SERIES,
            fromEpisodeId: E8,
            fromPositionMs: 600_000,
            excludeSessionId: 'sess-tab',
        });
    });

    it('a marker behind from redirects back to from with resolved=stay', async () => {
        effectiveSeriesMarker.mockResolvedValue(
            marker({
                relation: 'behind',
                episode: {
                    id: E8,
                    seasonNumber: 1,
                    episodeNumber: 8,
                    title: 'Eight',
                    orderKey: 10_008,
                },
            }),
        );
        const target = await redirectFor({ from: E10, fromPos: '1000' });
        expect(target.pathname).toBe(`/watch/${E10}`);
        expect(target.searchParams.get('resolved')).toBe('stay');
        expect(target.searchParams.has('seekMs')).toBe(false);
    });

    it('a same-position marker redirects back to from with resolved=stay', async () => {
        effectiveSeriesMarker.mockResolvedValue(marker({ relation: 'same' }));
        const target = await redirectFor({ from: E10, fromPos: '1310000' });
        expect(target.pathname).toBe(`/watch/${E10}`);
        expect(target.searchParams.get('resolved')).toBe('stay');
    });

    it('M2: forward on the same episode redirects to from with resolved=seek&seekMs', async () => {
        effectiveSeriesMarker.mockResolvedValue(marker({ relation: 'forward' }));
        const target = await redirectFor({ from: E10, fromPos: '60000' });
        expect(target.pathname).toBe(`/watch/${E10}`);
        expect(target.searchParams.get('resolved')).toBe('seek');
        expect(target.searchParams.get('seekMs')).toBe('1320000');
        expect(target.searchParams.get('dev')).toBe('iPhone');
    });

    it('M7: forward onto a combined-file sibling seeks inside from instead of navigating', async () => {
        effectiveSeriesMarker.mockResolvedValue(
            marker({ relation: 'forward', sameFileAsFrom: true }),
        );
        const target = await redirectFor({ from: E9, fromPos: '0' });
        expect(target.pathname).toBe(`/watch/${E9}`);
        expect(target.searchParams.get('resolved')).toBe('seek');
        expect(target.searchParams.get('seekMs')).toBe('1320000');
    });

    it('a finished series keeps the player on from and shows the finished card', async () => {
        effectiveSeriesMarker.mockResolvedValue(
            marker({ state: 'finished', positionMs: 0, relation: 'forward' }),
        );
        const target = await redirectFor({ from: E8, fromPos: '5000' });
        expect(target.pathname).toBe(`/watch/${E8}`);
        expect(target.searchParams.get('resolved')).toBe('finished');
        expect(target.searchParams.get('dev')).toBe('iPhone');
        expect(target.searchParams.has('seekMs')).toBe(false);
    });

    it('a finished series on the from episode itself shows the finished card', async () => {
        effectiveSeriesMarker.mockResolvedValue(
            marker({ state: 'finished', positionMs: 0, relation: 'same' }),
        );
        const target = await redirectFor({ from: E10, fromPos: '5000' });
        expect(target.pathname).toBe(`/watch/${E10}`);
        expect(target.searchParams.get('resolved')).toBe('finished');
    });

    it('a finished marker behind from stays without the card', async () => {
        effectiveSeriesMarker.mockResolvedValue(
            marker({ state: 'finished', positionMs: 0, relation: 'behind' }),
        );
        const target = await redirectFor({ from: E10, fromPos: '5000' });
        expect(target.pathname).toBe(`/watch/${E10}`);
        expect(target.searchParams.get('resolved')).toBe('stay');
    });

    it('relation none (from not in this series) behaves as if there were no from', async () => {
        effectiveSeriesMarker.mockResolvedValue(marker({ relation: 'none' }));
        const target = await redirectFor({ from: E8 });
        expect(target.pathname).toBe(`/watch/${E10}`);
        expect(target.searchParams.get('resolved')).toBe('series');
        expect(target.searchParams.has('from')).toBe(false);
    });

    it('relation none on a finished series rewatches from the first episode', async () => {
        effectiveSeriesMarker.mockResolvedValue(
            marker({ state: 'finished', positionMs: 0, relation: 'none' }),
        );
        getFirstEpisode.mockResolvedValue({
            media_id: E1,
            title: 'One',
            season_number: 1,
            episode_number: 1,
        });
        const target = await redirectFor({ from: E8 });
        expect(target.pathname).toBe(`/watch/${E1}`);
        expect(target.searchParams.get('resolved')).toBe('series');
        expect(target.searchParams.has('from')).toBe(false);
    });

    it('a finished series re-check never looks up the first episode', async () => {
        effectiveSeriesMarker.mockResolvedValue(
            marker({ state: 'finished', positionMs: 0, relation: 'forward' }),
        );
        await redirectFor({ from: E8 });
        expect(getFirstEpisode).not.toHaveBeenCalled();
    });

    it('a malformed from is ignored rather than reaching the resolver', async () => {
        effectiveSeriesMarker.mockResolvedValue(marker());
        const target = await redirectFor({ from: 'not-a-uuid', fromPos: 'abc' });
        expect(target.pathname).toBe(`/watch/${E10}`);
        expect(lastInput()).toMatchObject({ fromEpisodeId: null, fromPositionMs: null });
    });

    it('M14: a failing marker lookup keeps the caller on from', async () => {
        effectiveSeriesMarker.mockRejectedValue(new Error('db down'));
        const target = await redirectFor({ from: E8, fromPos: '5000' });
        expect(target.pathname).toBe(`/watch/${E8}`);
        expect(target.searchParams.get('resolved')).toBe('stay');
    });
});
