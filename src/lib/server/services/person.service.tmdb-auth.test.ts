// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * handlePersonGet's direct-TMDB fallback (no provider answers) sends the
 * configured credential in the shape TMDB expects on both requests: a v3 API
 * key as ?api_key=, a v4 Read Access Token as a Bearer header.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';

const V3_KEY = '0123456789abcdef0123456789abcdef';
const V4_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ0ZXN0In0.sig';

const { mockConfig } = vi.hoisted(() => ({ mockConfig: { TMDB_API_KEY: '' } }));

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
    isUnavailableMediaVisible: () => false,
}));
vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    getProvidersByPriority: () => [],
    invokeProviderGetPersonDetail: vi.fn(async () => null),
}));
vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { personDetails: { name: 'person-details-v2', ttl: 1 } },
    cacheManager: { for: () => ({ get: vi.fn(async () => null), set: vi.fn() }) },
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn() },
}));

import { handlePersonGet } from './person.service.js';

const fetchMock = vi.fn();

async function getPerson(): Promise<Array<{ url: URL; headers: Record<string, string> }>> {
    const event = { params: { personId: '42' } } as unknown as RequestEvent;
    const res = await handlePersonGet(event, unrestrictedAccess());
    // The details fetch answers 404, so the handler stops before any DB work.
    expect(res.status).toBe(404);
    return (fetchMock.mock.calls as Array<[string, RequestInit]>).map(([url, init]) => ({
        url: new URL(url),
        headers: init.headers as Record<string, string>,
    }));
}

describe('handlePersonGet direct-TMDB auth', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockImplementation(async () => new Response('{}', { status: 404 }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends a v3 key as ?api_key= on the details and credits requests', async () => {
        mockConfig.TMDB_API_KEY = V3_KEY;

        const calls = await getPerson();

        expect(calls.map((c) => c.url.pathname).sort()).toEqual([
            '/3/person/42',
            '/3/person/42/combined_credits',
        ]);
        for (const { url, headers } of calls) {
            expect(url.searchParams.get('api_key')).toBe(V3_KEY);
            expect(headers.Authorization).toBeUndefined();
        }
    });

    it('sends a v4 token as Bearer on both requests and keeps it out of the URL', async () => {
        mockConfig.TMDB_API_KEY = V4_TOKEN;

        const calls = await getPerson();

        expect(calls).toHaveLength(2);
        for (const { url, headers } of calls) {
            expect(url.searchParams.has('api_key')).toBe(false);
            expect(headers.Authorization).toBe(`Bearer ${V4_TOKEN}`);
        }
    });
});
