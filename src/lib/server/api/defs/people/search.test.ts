// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/person/search: the TMDB request must carry the configured key in
 * the shape TMDB expects — a v3 API key as ?api_key=, a v4 Read Access Token
 * as a Bearer header. Sending a v3 key as Bearer is a 401 from TMDB.
 */

import { personImageSet } from '$lib/server/services/image-descriptor/resources.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const V3_KEY = '0123456789abcdef0123456789abcdef';
const V4_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ0ZXN0In0.sig';

const { mockConfig } = vi.hoisted(() => ({ mockConfig: { TMDB_API_KEY: '' } }));

vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { personDetails: 'personDetails' },
    cacheManager: {
        for: () => ({ get: vi.fn(async () => null), set: vi.fn(async () => undefined) }),
    },
}));

import { def } from './search.js';

const fetchMock = vi.fn();

function callSearch(name: string): Promise<Response> {
    const event = {
        url: new URL(`http://localhost/api/person/search?name=${encodeURIComponent(name)}`),
    } as unknown as RequestEvent;
    return def.handlers.GET!(event, {} as never) as Promise<Response>;
}

function lastRequest(): { url: URL; headers: Record<string, string> } {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url: new URL(url), headers: init.headers as Record<string, string> };
}

describe('GET /api/person/search TMDB auth', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    results: [{ id: 7, name: 'Ada Lovelace', profile_path: '/a.jpg' }],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends a v3 API key as ?api_key= without a Bearer header', async () => {
        mockConfig.TMDB_API_KEY = V3_KEY;

        const res = await callSearch('Ada Lovelace');

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            personId: 7,
            name: 'Ada Lovelace',
            images: personImageSet('internal', 7, '/a.jpg'),
        });
        const { url, headers } = lastRequest();
        expect(url.origin + url.pathname).toBe('https://api.themoviedb.org/3/search/person');
        expect(url.searchParams.get('query')).toBe('Ada Lovelace');
        expect(url.searchParams.get('api_key')).toBe(V3_KEY);
        expect(headers.Authorization).toBeUndefined();
    });

    it('sends a v4 Read Access Token as Bearer and keeps it out of the URL', async () => {
        mockConfig.TMDB_API_KEY = V4_TOKEN;

        const res = await callSearch('Ada Lovelace');

        expect(res.status).toBe(200);
        const { url, headers } = lastRequest();
        expect(url.searchParams.has('api_key')).toBe(false);
        expect(headers.Authorization).toBe(`Bearer ${V4_TOKEN}`);
    });
});
