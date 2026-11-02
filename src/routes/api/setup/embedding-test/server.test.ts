// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for POST /api/setup/embedding-test — the "embed a test string" probe.
 * Verifies validation, the provider→request mapping (URL + dimension param), and
 * the ok / dimension-mismatch / error result shapes. fetch is mocked; no network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetSql, mockDim, mockFetch } = vi.hoisted(() => ({
    mockGetSql: vi.fn(),
    mockDim: vi.fn(),
    mockFetch: vi.fn(),
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...a: unknown[]) => mockGetSql(...a) },
}));
vi.mock('$lib/server/database/queries/onboarding.queries.js', () => ({
    getEmbeddingDimension: (...a: unknown[]) => mockDim(...a),
}));
vi.mock('$lib/server/utils/fetch-timeout.js', () => ({
    fetchWithTimeout: (...a: unknown[]) => mockFetch(...a),
}));

const okResponse = (dim: number) => ({
    ok: true,
    json: async () => ({ data: [{ embedding: new Array(dim).fill(0.1) }] }),
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

describe('POST /api/setup/embedding-test', () => {
    it.each([
        { provider: 'voyage', model: 'voyage-3-large', dimension: 1536 },
        { provider: 'voyage', model: 'voyage-2', dimension: 1024 },
        { provider: 'voyage', model: 'new-model', dimension: 1024 },
        { provider: 'openai', model: 'text-embedding-ada-002', dimension: 1536 },
        { provider: 'openai', model: 'text-embedding-3-small', dimension: 2048 },
        { provider: 'custom', model: 'local-model', dimension: 1024 },
        { provider: 'custom', model: 'text-embedding-3-small', dimension: 1024 },
    ])(
        'omits unsupported dimension parameters for $provider/$model at $dimension',
        async ({ provider, model, dimension }) => {
            mockDim.mockResolvedValue(dimension);
            mockFetch.mockResolvedValue(okResponse(dimension));
            const response = await callPost({
                provider,
                model,
                apiKey: 'key',
                endpoint: 'http://embeddings:8000/v1',
            });
            expect(await response.json()).toEqual({
                ok: true,
                dimension,
                expected: dimension,
                matches: true,
            });
            const request = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(request).not.toHaveProperty('dimensions');
            expect(request).not.toHaveProperty('output_dimension');
        },
    );

    it('reports the actual width when Voyage cannot request the database dimension', async () => {
        mockDim.mockResolvedValue(1536);
        mockFetch.mockResolvedValue(okResponse(1024));
        const response = await callPost({ provider: 'voyage', apiKey: 'key' });
        expect(JSON.parse(mockFetch.mock.calls[0][1].body)).not.toHaveProperty('output_dimension');
        expect(await response.json()).toEqual({
            ok: true,
            dimension: 1024,
            expected: 1536,
            matches: false,
        });
    });
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockDim.mockResolvedValue(1024);
        mockFetch.mockResolvedValue(okResponse(1024));
    });

    it('rejects an unknown provider', async () => {
        expect((await callPost({ provider: 'nope', apiKey: 'k' })).status).toBe(422);
    });

    it('rejects a missing api key', async () => {
        expect((await callPost({ provider: 'openai', apiKey: '' })).status).toBe(422);
    });

    it('rejects a non-http custom endpoint', async () => {
        const res = await callPost({ provider: 'custom', apiKey: 'k', endpoint: 'not-a-url' });
        expect(res.status).toBe(422);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns ok:false when the DB dimension is unreadable', async () => {
        mockDim.mockResolvedValue(null);
        const body = await (await callPost({ provider: 'openai', apiKey: 'k' })).json();
        expect(body.ok).toBe(false);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it('embeds via OpenAI, requesting the DB dimension, and reports a match', async () => {
        const body = await (await callPost({ provider: 'openai', apiKey: 'sk' })).json();
        expect(body).toEqual({ ok: true, dimension: 1024, expected: 1024, matches: true });
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe('https://api.openai.com/v1/embeddings');
        expect(JSON.parse((init as { body: string }).body)).toMatchObject({
            model: 'text-embedding-3-small',
            dimensions: 1024,
        });
    });

    it('hits the custom endpoint URL for a custom provider', async () => {
        await callPost({
            provider: 'custom',
            apiKey: 'k',
            endpoint: 'https://e.example.com/v1/',
            model: 'm',
        });
        expect(mockFetch.mock.calls[0][0]).toBe('https://e.example.com/v1/embeddings');
    });

    it('uses the Voyage URL + output_dimension for voyage', async () => {
        await callPost({ provider: 'voyage', apiKey: 'pa' });
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe('https://api.voyageai.com/v1/embeddings');
        expect(JSON.parse((init as { body: string }).body)).toMatchObject({
            output_dimension: 1024,
        });
    });

    it('flags a dimension mismatch (works but wrong width)', async () => {
        mockFetch.mockResolvedValue(okResponse(1536));
        const body = await (await callPost({ provider: 'openai', apiKey: 'sk' })).json();
        expect(body).toEqual({ ok: true, dimension: 1536, expected: 1024, matches: false });
    });

    it('surfaces a provider error on a non-2xx response', async () => {
        mockFetch.mockResolvedValue({
            ok: false,
            status: 401,
            json: async () => ({ error: { message: 'Invalid API key' } }),
        });
        const body = await (await callPost({ provider: 'openai', apiKey: 'bad' })).json();
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/API key/);
    });

    it('returns ok:false when the fetch throws', async () => {
        mockFetch.mockRejectedValue(
            Object.assign(new Error('private-key'), { code: 'ECONNREFUSED' }),
        );
        const body = await (await callPost({ provider: 'openai', apiKey: 'k' })).json();
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/connection refused/i);
        expect(body.error).not.toContain('private-key');
    });

    it.each(['SELF_SIGNED_CERT_IN_CHAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UNKNOWN'])(
        'sanitises nested %s failures',
        async (code) => {
            mockFetch.mockRejectedValue(
                new TypeError('key-secret https://user:password@host/?key=key-secret', {
                    cause: new AggregateError([Object.assign(new Error('key-secret'), { code })]),
                }),
            );
            const body = await (
                await callPost({
                    provider: 'custom',
                    apiKey: 'key-secret',
                    endpoint: 'https://host/v1?key=key-secret',
                })
            ).json();
            expect(body.ok).toBe(false);
            expect(body.error).not.toMatch(/key-secret|user:password|UNKNOWN/);
            expect(body.error).toMatch(/check|NODE_EXTRA_CA_CERTS/i);
            if (code === 'SELF_SIGNED_CERT_IN_CHAIN')
                expect(body.error).toContain('NODE_EXTRA_CA_CERTS');
        },
    );

    it('never echoes an upstream error body', async () => {
        mockFetch.mockResolvedValue({
            ok: false,
            status: 400,
            json: async () => ({ error: { message: 'key-secret user:password' } }),
        });
        const body = await (await callPost({ provider: 'openai', apiKey: 'key-secret' })).json();
        expect(body.error).not.toMatch(/key-secret|user:password/);
        expect(body.error).toMatch(/model|dimension/i);
    });
});
