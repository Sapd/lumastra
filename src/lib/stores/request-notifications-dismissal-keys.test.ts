// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * The dismissal-key round trip, end to end through the store.
 *
 * ## The bug being pinned
 *
 * `user_media_flags(flag_type='request_dismissed')` stores the K-EXT key with
 * the STORAGE media-type token — `tmdb:990050:tv` — because
 * `dismissRequestBodySchema` preprocesses `'series' → 'tv'` before the row is
 * ever written. The client built its lookup key from the PUBLIC vocabulary and
 * asked for `tmdb:990050:series`, so it could not read back a dismissal it had
 * just written. Movies round-tripped fine (`'movie'` is spelled identically in
 * both vocabularies), which is why this shipped and stayed shipped.
 *
 * The user-visible failure needs one more ingredient, reproduced below: a
 * still-airing series never leaves Jellyseerr's pending list — its
 * `media.status` sits at PARTIALLY_AVAILABLE forever — so
 * `/api/request/pending` keeps returning it and `syncFromServer()` re-adds the
 * card on every focus. The dismissal was the only thing that could stop that,
 * and it was unreadable.
 *
 * A stored series dismissal could therefore be followed by the same request
 * card reappearing on the next sync.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));

const mockDismissRequest = vi.fn();
const mockGetPendingRequests = vi.fn();
const mockCheckRequestStatuses = vi.fn();
vi.mock('$lib/api/content', () => ({
    dismissRequest: (...args: unknown[]) => mockDismissRequest(...args),
    getPendingRequests: (...args: unknown[]) => mockGetPendingRequests(...args),
    checkRequestStatuses: (...args: unknown[]) => mockCheckRequestStatuses(...args),
}));

const mockInboxMarkRead = vi.fn();
vi.mock('$lib/stores/notification-inbox', () => ({
    notificationInbox: { markRead: (...args: unknown[]) => mockInboxMarkRead(...args) },
}));

vi.mock('$lib/stores/toast.store', () => ({
    toasts: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const memoryStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryStorage.set(key, value),
    removeItem: (key: string) => void memoryStorage.delete(key),
    clear: () => memoryStorage.clear(),
});

/** A synthetic request for an airing series, hence never "available". */
const TMDB = '990050';
const REQUESTED_AT = '2020-01-01T20:39:21.000Z';
const DISMISSED_AT = '2020-01-13T11:06:14.907Z';

/**
 * `syncFromServer()` drops any pending request older than 14 days (see the
 * `maxAge` check in `src/lib/stores/request-notifications.ts`) so a
 * long-since-abandoned request doesn't linger forever. REQUESTED_AT above is
 * well within that window of this frozen instant, but real wall-clock time
 * marches on — without pinning `Date`, this suite silently started failing
 * once "now" drifted more than 14 days past REQUESTED_AT.
 * Freeze `now` shortly after DISMISSED_AT instead of trusting
 * the system clock.
 */
const NOW = '2020-01-13T12:30:00.000Z';

/**
 * The pending payload as `/api/request/pending` really shapes it: `mediaType`
 * in the PUBLIC vocabulary, and a status that is not `available` because
 * Jellyseerr reports PARTIALLY_AVAILABLE for a show that is still airing.
 */
function pendingResponse(dismissals: Array<{ key: string; dismissedAt: string }>) {
    return {
        data: {
            items: [
                {
                    id: 101,
                    dismissalKey: `tmdb:${TMDB}:tv`,
                    externalIds: { tmdb: TMDB },
                    mediaType: 'series',
                    title: 'Cloud Lantern Academy',
                    posterPath: '/cloud-lantern-academy.jpg',
                    status: 'partially_available',
                    requestedAt: REQUESTED_AT,
                    is4k: false,
                },
            ],
            dismissals,
            page: { limit: 50, offset: 0, hasMore: false, total: 1 },
            linked: true,
        },
        error: null,
        status: 200,
    };
}

async function freshStore(): Promise<typeof import('./request-notifications.js')> {
    vi.resetModules();
    const mod = await import('./request-notifications.js');
    mod.requestNotifications.clear();
    mod.requestNotifications.setUser('testguest');
    return mod;
}

beforeEach(() => {
    vi.clearAllMocks();
    // Only `Date` is faked: the store's own promise plumbing must still
    // settle on real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    memoryStorage.clear();
    mockInboxMarkRead.mockResolvedValue(undefined);
    mockDismissRequest.mockResolvedValue({
        data: null,
        error: null,
        status: 200,
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the key the server stores is the key the client reads', () => {
    it('honours a series dismissal stored under the tv token', async () => {
        const { requestNotifications } = await freshStore();

        // The storage-vocabulary dismissal returned for the synthetic request.
        mockGetPendingRequests.mockResolvedValue(
            pendingResponse([{ key: `tmdb:${TMDB}:tv`, dismissedAt: DISMISSED_AT }]),
        );

        await requestNotifications.syncFromServer();

        expect(get(requestNotifications).notifications).toEqual([]);
    });

    it('still shows a series with no dismissal at all', async () => {
        const { requestNotifications } = await freshStore();
        mockGetPendingRequests.mockResolvedValue(pendingResponse([]));

        await requestNotifications.syncFromServer();

        expect(get(requestNotifications).notifications).toHaveLength(1);
    });

    it('honours a K-UUID dismissal written by another surface', async () => {
        // For-You writes the bare media_items UUID; the popup must read it too,
        // or "dismissed in the rail, still popping up" is the same bug wearing
        // the other key shape.
        const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        const { requestNotifications } = await freshStore();

        const response = pendingResponse([{ key: uuid, dismissedAt: DISMISSED_AT }]);
        response.data.items[0].externalIds = { tmdb: TMDB, internal: uuid } as never;
        response.data.items[0].dismissalKey = uuid;
        mockGetPendingRequests.mockResolvedValue(response);

        await requestNotifications.syncFromServer();

        expect(get(requestNotifications).notifications).toEqual([]);
    });

    it('re-surfaces the card when the user re-requests after dismissing', async () => {
        const { requestNotifications } = await freshStore();

        const response = pendingResponse([{ key: `tmdb:${TMDB}:tv`, dismissedAt: DISMISSED_AT }]);
        // A fresh request is newer than the dismissal — the whole point of
        // comparing timestamps rather than treating the flag as absolute.
        response.data.items[0].requestedAt = '2020-01-13T12:00:00.000Z';
        mockGetPendingRequests.mockResolvedValue(response);

        await requestNotifications.syncFromServer();

        expect(get(requestNotifications).notifications).toHaveLength(1);
    });
});

describe('every card dismisses through the request-dismiss endpoint', () => {
    // Carried over from the deleted request-notifications-inbox.test.ts. There
    // used to be a SECOND dismiss path for inbox-hydrated cards (mark the
    // durable row read instead of POSTing). Hydration and that branch are gone;
    // this pins the single remaining path so a second one cannot creep back in
    // unnoticed. The server retires the matching `request.available` row off
    // this same POST — see `upsertDismissal` → `scheduleRequestDismissalSync`.
    it('POSTs exactly once for a poll-tracked card', async () => {
        const { requestNotifications } = await freshStore();
        requestNotifications.addRequest({ tmdb: '550' }, 'movie', 'Quiet Orbit', undefined);

        await requestNotifications.dismiss({ tmdb: '550' }, 'movie');

        expect(mockDismissRequest).toHaveBeenCalledTimes(1);
        expect(get(requestNotifications).notifications).toEqual([]);
    });
});

describe('a dismiss survives the sync that immediately follows it', () => {
    it('does not re-add the card the user just dismissed', async () => {
        const { requestNotifications } = await freshStore();

        // 1. The card arrives from the pending list.
        mockGetPendingRequests.mockResolvedValue(pendingResponse([]));
        await requestNotifications.syncFromServer();
        expect(get(requestNotifications).notifications).toHaveLength(1);

        // 2. User clicks the X.
        await requestNotifications.dismiss({ tmdb: TMDB }, 'series');
        expect(get(requestNotifications).notifications).toEqual([]);

        // 3. A sync whose response was computed BEFORE the dismiss row landed
        //    arrives right after it — the focus/visibility handlers make this
        //    ordinary, not exotic. It must not resurrect the card.
        await requestNotifications.syncFromServer();
        expect(get(requestNotifications).notifications).toEqual([]);
    });
});

describe('request progress polling', () => {
    it('updates every title when more than 20 requests are tracked', async () => {
        const { requestNotifications } = await freshStore();
        for (let id = 1; id <= 41; id++) {
            requestNotifications.addRequest({ tmdb: String(id) }, 'movie', `Movie ${id}`);
        }
        mockCheckRequestStatuses.mockImplementation(
            async (items: { externalIds: { tmdb: string }; mediaType: string }[]) => {
                if (items.length > 20) return { data: null, error: 'Too many requests' };
                return {
                    data: items.map((item) => ({
                        ...item,
                        status: 'downloading',
                        download: { percentage: 25 },
                    })),
                    error: null,
                };
            },
        );

        await requestNotifications.poll();

        expect(mockCheckRequestStatuses.mock.calls.map(([items]) => items.length)).toEqual([
            20, 20, 1,
        ]);
        expect(get(requestNotifications).notifications).toHaveLength(41);
        expect(
            get(requestNotifications).notifications.every((item) => item.status === 'downloading'),
        ).toBe(true);
    });

    it('continues after a failed batch and retries it on the next poll', async () => {
        const { requestNotifications } = await freshStore();
        for (let id = 1; id <= 21; id++) {
            requestNotifications.addRequest({ tmdb: String(id) }, 'movie', `Movie ${id}`);
        }
        mockCheckRequestStatuses.mockRejectedValueOnce(new Error('Offline'));
        mockCheckRequestStatuses.mockImplementation(
            async (items: { externalIds: { tmdb: string }; mediaType: string }[]) => ({
                data: items.map((item) => ({ ...item, status: 'available' })),
                error: null,
            }),
        );

        await requestNotifications.poll();
        expect(
            get(requestNotifications).notifications.filter((item) => item.status === 'available'),
        ).toHaveLength(1);
        await requestNotifications.poll();
        expect(
            get(requestNotifications).notifications.every((item) => item.status === 'available'),
        ).toBe(true);
    });

    it('preserves detailed failure messages and clears stale progress and messages', async () => {
        const { requestNotifications } = await freshStore();
        const item = { externalIds: { tmdb: '1' }, mediaType: 'movie' as const };
        requestNotifications.addRequest(item.externalIds, item.mediaType, 'Movie');
        requestNotifications.applyStatusResults([
            {
                ...item,
                status: 'downloading',
                download: { percentage: 70 },
                statusMessage: 'Downloading release',
            },
        ]);
        requestNotifications.applyStatusResults([
            { ...item, status: 'unavailable', statusMessage: 'Download failed' },
        ]);
        expect(get(requestNotifications).notifications[0]).toMatchObject({
            status: 'unavailable',
            statusMessage: 'Download failed',
        });
        expect(get(requestNotifications).notifications[0].download).toBeUndefined();

        requestNotifications.applyStatusResults([{ ...item, status: 'searching' }]);
        expect(get(requestNotifications).notifications[0].statusMessage).toBeUndefined();
    });
});

describe('restoring selected seasons', () => {
    it('merges multiple requests for the same show and polls their season scope', async () => {
        const { requestNotifications } = await freshStore();
        const response = pendingResponse([]);
        const request = response.data.items[0];
        mockGetPendingRequests.mockResolvedValue({
            ...response,
            data: {
                ...response.data,
                items: [
                    { ...request, seasons: [2] },
                    { ...request, id: 1688, seasons: [3, 2] },
                ],
                page: { limit: 50, offset: 0, hasMore: false, total: 2 },
            },
        });
        await requestNotifications.syncFromServer();
        expect(get(requestNotifications).notifications[0].seasons).toEqual([2, 3]);
        mockCheckRequestStatuses.mockResolvedValue({ data: [], error: null });
        await requestNotifications.poll();
        expect(mockCheckRequestStatuses).toHaveBeenLastCalledWith([
            expect.objectContaining({ externalIds: { tmdb: TMDB }, seasons: [2, 3] }),
        ]);
    });
});

describe('legacy series card migration', () => {
    it('merges persisted tv and series cards and applies canonical season progress', async () => {
        const { requestNotifications } = await freshStore();
        const card = {
            externalIds: { tmdb: TMDB },
            title: 'Cloud Lantern Academy',
            status: 'pending',
            seasons: [1],
            createdAt: Date.now(),
            shownAt: Date.now(),
        };
        memoryStorage.set(
            'dashboard-request-notifications-migration',
            JSON.stringify({
                version: 8,
                lastPoll: 0,
                notifications: [
                    { ...card, id: `tmdb:${TMDB}:tv`, mediaType: 'tv' },
                    { ...card, id: `tmdb:${TMDB}:series`, mediaType: 'series', seasons: [2] },
                ],
            }),
        );
        requestNotifications.setUser('migration');
        expect(get(requestNotifications).notifications).toHaveLength(1);
        expect(get(requestNotifications).notifications[0]).toMatchObject({
            id: `tmdb:${TMDB}:series`,
            mediaType: 'series',
            seasons: [1, 2],
        });
        requestNotifications.applyStatusResults([
            {
                externalIds: { tmdb: TMDB },
                mediaType: 'series',
                seasonNumber: 1,
                status: 'downloading',
                download: { percentage: 37 },
            },
        ]);
        expect(get(requestNotifications).notifications[0]).toMatchObject({
            status: 'downloading',
            download: { percentage: 37 },
        });
        mockGetPendingRequests.mockResolvedValue(pendingResponse([]));
        await requestNotifications.syncFromServer();
        expect(get(requestNotifications).notifications).toHaveLength(1);
    });
});
