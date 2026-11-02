// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * GET /api/recommendations/holiday — response shaping.
 *
 * Regression: on prod (2026-10-02) TMDB-discovered items the library didn't
 * have carried `externalIds: { tmdb, jellyfin: undefined }`, the response
 * schema's record-of-strings rejected the undefined value, and every Home load
 * during Halloween got a 500.
 *
 * NOTE: named server.test.ts (NOT +server.test.ts) — the `+` prefix is reserved.
 */

import { beforeEach, describe, test, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetRecommendations = vi.fn();

vi.mock('$lib/server/plugins/holidays', () => ({
    holidayPlugin: {
        getRecommendations: (...args: unknown[]) => mockGetRecommendations(...args),
    },
}));

vi.mock('$lib/server/plugins/holidays/config-loader.js', () => ({
    getHolidaySettings: () => ({ enabled: true, defaultLimit: 20 }),
}));

vi.mock('$lib/server/dev-user.js', () => ({
    getEffectiveUser: () => 'alice',
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
}));

const { GET } = await import('./+server.js');
const { features } = await import('$lib/server/config.js');

// The feature is off by default; most cases below test the ON behaviour.
let holidaysOn = true;
beforeEach(() => {
    holidaysOn = true;
    mockGetRecommendations.mockReset();
    vi.spyOn(features, 'holidays', 'get').mockImplementation(() => holidaysOn);
});

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/recommendations/holiday?limit=20');
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

describe('GET /api/recommendations/holiday', () => {
    test('disabled (the default) → 200 inactive + empty, plugin never called', async () => {
        holidaysOn = false;
        const res = await GET!(makeEvent());
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(body).toMatchObject({ active: false, items: [] });
        expect(mockGetRecommendations).not.toHaveBeenCalled();
    });

    test('disabled → 200 even for an age-restricted profile (no 403 noise)', async () => {
        holidaysOn = false;
        const event = makeEvent();
        (event.locals.user as { isAgeRestricted?: boolean }).isAgeRestricted = true;
        const res = await GET!(event);
        expect(res.status).toBe(200);
    });

    test('an item without a library match (jellyfin id undefined) does not 500', async () => {
        mockGetRecommendations.mockResolvedValue({
            active: true,
            holiday: { id: 'halloween', name: 'Halloween' },
            cached: false,
            items: [
                {
                    externalIds: { tmdb: '948' },
                    mediaType: 'movie',
                    title: 'Halloween',
                    rating: 7.5,
                    isAvailable: true,
                },
                {
                    externalIds: { tmdb: '4232', jellyfin: undefined },
                    mediaType: 'movie',
                    title: 'Shimmer',
                    rating: 7.4,
                    isAvailable: false,
                    canRequest: true,
                },
            ],
        });

        const res = await GET!(makeEvent());
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(body.items).toHaveLength(2);
        expect(body.items[1].externalIds).toEqual({ tmdb: '4232' });
    });
});
