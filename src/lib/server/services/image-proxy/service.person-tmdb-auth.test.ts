// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * getPersonImage's TMDB person-details lookup sends the configured credential
 * in the shape TMDB expects: a v3 API key as ?api_key=, a v4 Read Access Token
 * as a Bearer header.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/database/queries/image-candidates.queries.js', () => ({
    getSelectedImageCandidate: vi.fn().mockResolvedValue(null),
    getSuppressedImageProviders: vi.fn().mockResolvedValue([]),
    hasPersonImageOwner: vi.fn().mockResolvedValue(false),
    registerPersonImageCandidate: vi.fn(),
}));

const V3_KEY = '0123456789abcdef0123456789abcdef';
const V4_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ0ZXN0In0.sig';

const configOverrides = vi.hoisted(() => ({ TMDB_API_KEY: '' }) as Record<string, unknown>);
vi.mock('$lib/server/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get: (target, prop: string) =>
                prop in configOverrides ? configOverrides[prop] : target[prop as never],
        }),
    };
});

import { ImageProxyService } from './service';

const fetchMock = vi.fn();

async function lookUpPerson(): Promise<{ url: URL; headers: Record<string, string> }> {
    const service = new ImageProxyService({} as never);
    // Details answer 404, so the lookup ends before any image fetch or cache write.
    expect(await service.getPersonImage('42')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url: new URL(url), headers: init.headers as Record<string, string> };
}

describe('ImageProxyService.getPersonImage TMDB auth', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockImplementation(async () => new Response('{}', { status: 404 }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends a v3 key as ?api_key= without a Bearer header', async () => {
        configOverrides.TMDB_API_KEY = V3_KEY;
        const { url, headers } = await lookUpPerson();
        expect(url.origin + url.pathname).toBe('https://api.themoviedb.org/3/person/42');
        expect(url.searchParams.get('api_key')).toBe(V3_KEY);
        expect(headers.Authorization).toBeUndefined();
    });

    it('sends a v4 token as Bearer and keeps it out of the URL', async () => {
        configOverrides.TMDB_API_KEY = V4_TOKEN;
        const { url, headers } = await lookUpPerson();
        expect(url.searchParams.has('api_key')).toBe(false);
        expect(headers.Authorization).toBe(`Bearer ${V4_TOKEN}`);
    });
});
