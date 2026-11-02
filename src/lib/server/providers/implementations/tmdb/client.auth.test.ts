// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TMDBApiService sends the configured credential in the shape TMDB expects:
 * a v3 API key as ?api_key=, a v4 Read Access Token as a Bearer header.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const V3_KEY = '0123456789abcdef0123456789abcdef';
const V4_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ0ZXN0In0.sig';

const cfg = vi.hoisted(() => ({ TMDB_API_KEY: '', TMDB_LANGUAGE: 'en-US' }));
vi.mock('$lib/server/config', () => ({ config: cfg }));

const { createTMDBApi } = await import('./client.js');

const fetchMock = vi.fn();

function lastRequest(): { url: URL; headers: Record<string, string> } {
    const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
    return { url: new URL(url), headers: init.headers as Record<string, string> };
}

describe('TMDBApiService request auth', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        fetchMock.mockImplementation(
            async () =>
                new Response(JSON.stringify({ results: [], total_pages: 0, total_results: 0 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends a v3 key as ?api_key= and keeps the other query params', async () => {
        cfg.TMDB_API_KEY = V3_KEY;

        await createTMDBApi('de-DE').searchMulti('Ada Lovelace', 2);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const { url, headers } = lastRequest();
        expect(url.origin + url.pathname).toBe('https://api.themoviedb.org/3/search/multi');
        expect(url.searchParams.get('api_key')).toBe(V3_KEY);
        expect(url.searchParams.get('query')).toBe('Ada Lovelace');
        expect(url.searchParams.get('page')).toBe('2');
        expect(url.searchParams.get('language')).toBe('de-DE');
        expect(headers.Authorization).toBeUndefined();
    });

    it('sends a v4 token as Bearer and keeps it out of the URL', async () => {
        cfg.TMDB_API_KEY = V4_TOKEN;

        await createTMDBApi('de-DE').searchMulti('Ada Lovelace', 2);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const { url, headers } = lastRequest();
        expect(url.searchParams.has('api_key')).toBe(false);
        expect(url.searchParams.get('query')).toBe('Ada Lovelace');
        expect(headers.Authorization).toBe(`Bearer ${V4_TOKEN}`);
    });
    it('reports a safe transport cause after retries without exposing credentials', async () => {
        cfg.TMDB_API_KEY = V3_KEY;
        const cause = Object.assign(new Error(`https://upstream/?api_key=${V3_KEY}`), {
            code: 'ENOTFOUND',
        });
        fetchMock.mockRejectedValue(new TypeError('fetch failed', { cause }));
        const error = await createTMDBApi('de-DE')
            .searchMulti('transport-test')
            .catch((value: unknown) => value);
        expect(error).toMatchObject({
            status: null,
            authFatal: false,
            message: 'TMDB transport failed: ENOTFOUND',
        });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(String(error)).not.toContain(V3_KEY);
    });

    it('recovers from a transient transport failure with the existing retry policy', async () => {
        cfg.TMDB_API_KEY = V3_KEY;
        fetchMock.mockRejectedValueOnce(
            new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }),
        );
        await expect(
            createTMDBApi('de-DE').searchMulti('transport-recovery'),
        ).resolves.toMatchObject({ results: [] });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
