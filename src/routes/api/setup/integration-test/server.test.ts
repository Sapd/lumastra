// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for POST /api/setup/integration-test — the TMDB / MDBList key
 * probe. Verifies validation, the provider→request mapping, the configured-key
 * fallback, and the ok / error result shapes. fetch is mocked; no network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetch, mockConfig } = vi.hoisted(() => ({
    mockFetch: vi.fn(),
    mockConfig: { TMDB_API_KEY: '', MDBLIST_API_KEY: '' },
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/utils/fetch-timeout.js', () => ({
    fetchWithTimeout: (...a: unknown[]) => mockFetch(...a),
}));
vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
}));

const okResponse = () => ({ ok: true, status: 200, json: async () => ({}) });
const unauthorizedResponse = () => ({
    ok: false,
    status: 401,
    json: async () => ({ status_message: 'Invalid API key' }),
});

const callPost = async (body: unknown) => {
    const { POST } = await import('./+server.js');
    return (POST as (event: unknown) => Promise<Response>)({
        request: new Request('http://localhost/test', {
            method: 'POST',
            body: JSON.stringify(body),
        }),
    });
};

describe('POST /api/setup/integration-test', () => {
    it.each(['tmdb', 'mdblist'])('gives generic request advice for %s', async (provider) => {
        mockFetch.mockResolvedValue({
            ok: false,
            status: 400,
            json: async () => ({ error: 'secret-token' }),
        });
        const body = await (await callPost({ provider, apiKey: 'secret-token' })).json();
        expect(body.error).toMatch(/address.*settings/i);
        expect(body.error).not.toMatch(/embedding|dimension|model|secret-token/i);
    });
    it.each(['tmdb', 'mdblist'])('gives a safe TLS remedy for %s', async (provider) => {
        mockFetch.mockRejectedValue(
            new TypeError('key-secret', {
                cause: Object.assign(new Error('user:password'), {
                    code: 'SELF_SIGNED_CERT_IN_CHAIN',
                }),
            }),
        );
        const body = await (await callPost({ provider, apiKey: 'key-secret' })).json();
        expect(body.error).toContain('NODE_EXTRA_CA_CERTS');
        expect(body.error).not.toMatch(/key-secret|user:password/);
    });

    it.each(['tmdb', 'mdblist'])('never echoes an upstream error body for %s', async (provider) => {
        mockFetch.mockResolvedValue({
            ok: false,
            status: 503,
            json: async () => ({ error: 'key-secret user:password' }),
        });
        const body = await (await callPost({ provider, apiKey: 'key-secret' })).json();
        expect(body.error).not.toMatch(/key-secret|user:password/);
        expect(body.error).toMatch(/503/);
    });
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.TMDB_API_KEY = '';
        mockConfig.MDBLIST_API_KEY = '';
        mockFetch.mockResolvedValue(okResponse());
    });

    it('rejects an unknown provider', async () => {
        const res = await callPost({ provider: 'nope', apiKey: 'k' });
        expect(res.status).toBe(422);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a malformed body', async () => {
        const { POST } = await import('./+server.js');
        const res = await (POST as (event: unknown) => Promise<Response>)({
            request: {
                json: async () => {
                    throw new Error('bad json');
                },
            },
        });
        expect(res.status).toBe(422);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('tests a bearer-style TMDB key against /3/configuration', async () => {
        const body = await (
            await callPost({ provider: 'tmdb', apiKey: 'eyJhbGciOiJIUzI1NiJ9.test' })
        ).json();
        expect(body).toEqual({ ok: true });
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe('https://api.themoviedb.org/3/configuration');
        expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
            'Bearer eyJhbGciOiJIUzI1NiJ9.test',
        );
    });

    it('tests a v3 TMDB key as an api_key query param', async () => {
        await callPost({ provider: 'tmdb', apiKey: 'plainv3key' });
        const [url] = mockFetch.mock.calls[0];
        expect(url).toBe('https://api.themoviedb.org/3/configuration?api_key=plainv3key');
    });

    it('reports an invalid TMDB key on a 401', async () => {
        mockFetch.mockResolvedValue(unauthorizedResponse());
        const body = await (await callPost({ provider: 'tmdb', apiKey: 'bad' })).json();
        expect(body).toEqual({
            ok: false,
            retryable: false,
            error: expect.stringMatching(/TMDB.*rejected/),
        });
    });

    it('tests an MDBList key against /lists/user with an apikey query param', async () => {
        const body = await (await callPost({ provider: 'mdblist', apiKey: 'mk' })).json();
        expect(body).toEqual({ ok: true });
        const [url] = mockFetch.mock.calls[0];
        expect(url).toBe('https://api.mdblist.com/lists/user?apikey=mk');
    });

    it('reports an invalid MDBList key on a 401', async () => {
        mockFetch.mockResolvedValue(unauthorizedResponse());
        const body = await (await callPost({ provider: 'mdblist', apiKey: 'bad' })).json();
        expect(body).toEqual({ ok: false, error: 'Invalid MDBList API key' });
    });

    it('falls back to the configured TMDB key when apiKey is blank', async () => {
        mockConfig.TMDB_API_KEY = 'configured-key';
        const body = await (await callPost({ provider: 'tmdb', apiKey: '  ' })).json();
        expect(body).toEqual({ ok: true });
        const [url] = mockFetch.mock.calls[0];
        expect(url).toBe('https://api.themoviedb.org/3/configuration?api_key=configured-key');
    });

    it('returns ok:false without calling fetch when no key is provided or configured', async () => {
        const body = await (await callPost({ provider: 'mdblist' })).json();
        expect(body).toEqual({ ok: false, error: 'No key configured' });
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns ok:false when the fetch throws', async () => {
        mockFetch.mockRejectedValue(
            Object.assign(new Error('private-key'), { code: 'ECONNREFUSED' }),
        );
        const body = await (await callPost({ provider: 'tmdb', apiKey: 'k' })).json();
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/connection refused/i);
        expect(body.error).not.toContain('private-key');
    });
});
