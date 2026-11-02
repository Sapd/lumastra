// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Contract test: the REAL holiday plugin's output through the REAL endpoint.
 *
 * Twice in one week (rating as a string, then externalIds.jellyfin undefined)
 * the plugin emitted a shape the endpoint's response schema rejected and Home
 * got a 500 for the whole holiday season. server.test.ts mocks the plugin, so
 * it can't see that drift; this file mocks only I/O (DB, cache, TMDB, source
 * adapters) and feeds deliberately ragged inputs — nulls, NaN, unmatched
 * titles — so any field the plugin produces that the schema refuses fails here.
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { DiscoveredItem } from '$lib/server/plugins/holidays/types';

const libraryRows = [
    {
        // Every nullable column null — the plugin must not leak a null.
        internal_id: '00000000-0000-4000-8000-000000000948',
        tmdb_id: 948,
        media_type: 'movie',
        title: 'Halloween',
        overview: null,
        poster_path: null,
        backdrop_path: null,
        year: null,
        rating: null,
        popularity: null,
    },
    {
        internal_id: '00000000-0000-4000-8000-000000001100',
        tmdb_id: 1100,
        media_type: 'tv',
        title: 'Starry Lanterns',
        overview: 'Upside down',
        poster_path: '/st.jpg',
        backdrop_path: '/st-bg.jpg',
        year: 2016,
        rating: 8.6,
        popularity: 120,
    },
];

const discovered: DiscoveredItem[] = [
    // In the library via tmdb id → internal id resolved.
    {
        id: 4232,
        mediaType: 'movie',
        title: 'Shimmer',
        overview: 'Ghostface',
        voteAverage: 7.4,
        voteCount: 9000,
        popularity: 40,
        source: 'tmdb',
    },
    // Not in the library → no jellyfin id (the 2026-10-02 500).
    {
        id: 10439,
        mediaType: 'movie',
        title: 'Hocus Pocus',
        voteAverage: Number.NaN,
        popularity: Number.NaN,
        source: 'tmdb',
        isFeatured: true,
    },
    // Same title as a library item but a different TMDB id: must NOT be
    // matched (the old title fallback did, and stripped non-Latin titles to '').
    {
        id: 99999,
        mediaType: 'tv',
        title: 'Wednesday!',
        source: 'tmdb',
        isNewRelease: true,
    },
];

// In-memory cache (namespace|key|user) so cache behaviour is observable.
const cacheStore = vi.hoisted(() => new Map<string, { value: unknown; expiresAt: number }>());
const discoverMock = vi.hoisted(() => vi.fn());
const accessibleMock = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/cache', () => ({
    cacheManager: {
        for: (ns: string) => ({
            get: vi.fn(async (key: string, user?: string) => {
                const hit = cacheStore.get(`${ns}|${key}|${user ?? ''}`);
                return hit && hit.expiresAt > Date.now() ? structuredClone(hit.value) : null;
            }),
            set: vi.fn(async (key: string, value: unknown, ttl = 60_000, user?: string) => {
                cacheStore.set(`${ns}|${key}|${user ?? ''}`, {
                    value: structuredClone(value),
                    expiresAt: Date.now() + ttl,
                });
            }),
            delete: vi.fn(),
        }),
    },
    CACHE_NAMESPACES: new Proxy({}, { get: (_t, key) => String(key) }),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));

vi.mock('$lib/server/database', () => ({
    // AI personalization off: no embeddings in this test.
    testDbConnection: vi.fn().mockResolvedValue(false),
    getDb: () => ({}),
    Database: vi.fn(),
}));

const accessCtx = {
    username: 'alice',
    deniedGroupIds: null,
    ageRating: null,
    liveTvAllowed: false,
    showUnavailableMedia: true,
};

vi.mock('$lib/server/utils/search-access-context.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/search-access-context.js')>()),
    buildSearchAccessContext: vi.fn(async () => ({ ...accessCtx })),
    searchAccessBoundary: () => ({ library: { kind: 'all' }, age: { kind: 'any' } }),
}));

// The caller's library: Shimmer (with a Jellyfin id) and Wednesday under a
// DIFFERENT tmdb id (777) than the discovered one (99999).
const owned = [
    { tmdb_id: '4232', media_type: 'movie', media_id: 'shimmer-uuid' },
    { tmdb_id: '777', media_type: 'tv', media_id: 'wed-uuid' },
];

vi.mock('$lib/server/database/queries/browse.queries.js', () => ({
    getMediaByTmdbKeyword: vi.fn(async () => libraryRows),
    getAccessibleMediaByTmdbIds: accessibleMock,
}));

function ownedFor(_sql: unknown, pairs: { tmdbId: number; mediaType: string }[]) {
    return Promise.resolve(
        owned.filter((o) =>
            pairs.some((p) => String(p.tmdbId) === o.tmdb_id && p.mediaType === o.media_type),
        ),
    );
}

vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    resolveExternalIdToUuid: vi.fn().mockResolvedValue(null),
}));

vi.mock('$lib/server/providers/implementations/tmdb/index.js', () => ({
    tmdbApi: { isAvailable: () => false },
}));

vi.mock('$lib/server/plugins/holidays/sources', () => ({
    getSourceAdapter: () => ({
        isAvailable: () => true,
        discover: discoverMock,
    }),
}));

vi.mock('$lib/server/dev-user.js', () => ({ getEffectiveUser: () => 'alice' }));

const { GET } = await import('./+server.js');
const { POST } = await import('./refresh/+server.js');
const { buildSearchAccessContext } = await import('$lib/server/utils/search-access-context.js');
const { features } = await import('$lib/server/config.js');
const { getHolidayRecommendations } = await import('$lib/server/plugins/holidays/plugin.js');

function makeEvent(query = 'limit=20'): RequestEvent {
    const url = new URL(`http://localhost/api/recommendations/holiday?${query}`);
    return {
        url,
        params: {},
        route: { id: '/api/recommendations/holiday' as const },
        request: new Request(url.toString()),
        locals: {
            user: {
                userId: 'usr_00000000-0000-0000-0000-000000000001',
                username: 'alice',
                groups: '',
                userGroups: [],
                ownerIsAdmin: false,
                maxAgeRating: null,
            },
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

beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
});

afterAll(() => {
    vi.useRealTimers();
});

beforeEach(() => {
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
    cacheStore.clear();
    discoverMock.mockReset().mockImplementation(async () => discovered);
    accessibleMock.mockReset().mockImplementation(ownedFor);
    // Off by default (DISABLE_HOLIDAY_RECOMMENDATIONS); this file tests ON.
    vi.spyOn(features, 'holidays', 'get').mockReturnValue(true);
});

async function titlesOf(query?: string): Promise<string[]> {
    const params = new URLSearchParams(query);
    const event = makeEvent(query);
    const refresh = params.has('refresh');
    if (refresh) {
        params.delete('refresh');
        event.request = new Request(event.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.fromEntries(params)),
        });
    }
    const res = await (refresh ? POST!(event) : GET!(event));
    expect(res.status).toBe(200);
    const body = await res.json();
    return (body.items as { title: string }[]).map((i) => i.title);
}

describe('holiday plugin → endpoint contract', () => {
    test('disabled: the endpoint AND the plugin itself return inactive, nothing discovered', async () => {
        vi.spyOn(features, 'holidays', 'get').mockReturnValue(false);

        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ active: false, items: [] });

        // Any other caller of the plugin (editorial rail, future paths) is gated too.
        const direct = await getHolidayRecommendations('alice', { access: null });
        expect(direct).toMatchObject({ active: false, items: [] });
        expect(discoverMock).not.toHaveBeenCalled();
        expect(cacheStore.size).toBe(0);
    });

    test('ragged library + TMDB items all survive the response schema', async () => {
        const res = await GET!(makeEvent());
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.active).toBe(true);
        expect(body.holiday.id).toBe('halloween');

        const byTitle = new Map(
            (body.items as { title: string }[]).map((i) => [i.title, i as Record<string, unknown>]),
        );
        expect([...byTitle.keys()].sort()).toEqual(
            ['Halloween', 'Hocus Pocus', 'Shimmer', 'Starry Lanterns', 'Wednesday!'].sort(),
        );

        for (const item of byTitle.values()) {
            expect(Number.isFinite(item.rating)).toBe(true);
            for (const v of Object.values(item.externalIds as Record<string, unknown>)) {
                expect(typeof v).toBe('string');
            }
        }

        // Library rows: available via their own media id, playable without Jellyfin.
        expect(byTitle.get('Halloween')).toMatchObject({
            isAvailable: true,
            canRequest: false,
            externalIds: { tmdb: '948', internal: '00000000-0000-4000-8000-000000000948' },
        });
        expect(byTitle.get('Shimmer')?.externalIds).not.toHaveProperty('jellyfin');
        expect(byTitle.get('Shimmer')).toMatchObject({
            isAvailable: true,
            externalIds: { tmdb: '4232', internal: 'shimmer-uuid' },
        });
        expect(byTitle.get('Hocus Pocus')).toMatchObject({
            isAvailable: false,
            canRequest: true,
        });
        expect(byTitle.get('Hocus Pocus')!.externalIds).toEqual({ tmdb: '10439' });
        expect(byTitle.get('Wednesday!')).toMatchObject({ isAvailable: false, canRequest: true });
        expect(byTitle.get('Wednesday!')!.externalIds).toEqual({ tmdb: '99999' });

        // Owned titles rank ahead of unowned ones with no signals.
        const titles = (body.items as { title: string }[]).map((i) => i.title);
        expect(titles.indexOf('Starry Lanterns')).toBeLessThan(titles.indexOf('Wednesday!'));

        // Only display fields of the holiday config reach the client.
        expect(body.holiday).not.toHaveProperty('sources');
        expect(body.holiday).not.toHaveProperty('validation');
    });

    test('SHOW_UNAVAILABLE_MEDIA off: only playable items are returned', async () => {
        vi.mocked(buildSearchAccessContext).mockResolvedValueOnce({
            ...accessCtx,
            showUnavailableMedia: false,
        });

        const res = await GET!(makeEvent());
        const body = await res.json();

        expect(res.status).toBe(200);
        expect((body.items as { title: string }[]).map((i) => i.title).sort()).toEqual(
            ['Halloween', 'Shimmer', 'Starry Lanterns'].sort(),
        );
    });

    test('SHOW_UNAVAILABLE_MEDIA off: an owned title ranked below the cut still shows', async () => {
        // 30 popular unowned titles outrank Shimmer (owned); limit=5 cuts the
        // pool at 10 — availability must be resolved before that cut.
        const popular: DiscoveredItem[] = Array.from({ length: 30 }, (_, i) => ({
            id: 50000 + i,
            mediaType: 'movie',
            title: `Popular ${i}`,
            voteAverage: 9,
            voteCount: 100000,
            popularity: 5000,
            source: 'tmdb',
        }));
        discoverMock.mockImplementation(async () => [...popular, discovered[0]]);
        vi.mocked(buildSearchAccessContext).mockResolvedValueOnce({
            ...accessCtx,
            showUnavailableMedia: false,
        });

        expect(await titlesOf('limit=5')).toContain('Shimmer');
    });

    test('a failed library lookup is cached only briefly', async () => {
        accessibleMock.mockRejectedValueOnce(new Error('db blip'));

        expect(await titlesOf()).toContain('Shimmer'); // listed, just not available
        await titlesOf();
        expect(accessibleMock).toHaveBeenCalledTimes(1); // short-lived entry served

        vi.setSystemTime(Date.now() + 61_000);
        await titlesOf();
        expect(accessibleMock).toHaveBeenCalledTimes(2); // recomputed, not pinned for the TTL
    });

    test('an empty source result is cached only briefly (globally and per user)', async () => {
        discoverMock.mockResolvedValueOnce([]);
        expect(await titlesOf()).not.toContain('Hocus Pocus');
        await titlesOf();
        expect(discoverMock).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + 61_000);
        expect(await titlesOf()).toContain('Hocus Pocus');
        expect(discoverMock).toHaveBeenCalledTimes(2);
    });

    test('refresh rediscovers at most once a minute per user, whatever the limit', async () => {
        await titlesOf('limit=20');
        expect(discoverMock).toHaveBeenCalledTimes(1);

        await titlesOf('limit=20&refresh=true');
        expect(discoverMock).toHaveBeenCalledTimes(2); // bypasses the shared cache

        await titlesOf('limit=20&refresh=true');
        expect(discoverMock).toHaveBeenCalledTimes(2); // throttled: served from cache

        // A different limit is a new result entry but shares the shared pool
        // and the per-user throttle.
        await titlesOf('limit=7&refresh=true');
        expect(discoverMock).toHaveBeenCalledTimes(2);
    });
});
