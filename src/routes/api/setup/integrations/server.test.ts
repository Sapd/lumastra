// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for POST /api/setup/integrations — MDBList + embedding config.
 * Verifies validation, the provider→config-key mapping, and dimension locking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetSql, mockDim, mockSave, mockFetch, configState } = vi.hoisted(() => ({
    mockGetSql: vi.fn(),
    mockDim: vi.fn(),
    mockSave: vi.fn(),
    mockFetch: vi.fn(),
    configState: { values: {} as Record<string, unknown>, locked: new Set<string>() },
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
vi.mock('$lib/server/config/config.service.js', () => ({
    saveConfig: (...a: unknown[]) => mockSave(...a),
}));
vi.mock('$lib/server/config/index.js', () => ({
    getAll: () => configState.values,
    isEnvOverridden: (key: string) => configState.locked.has(key),
}));
vi.mock('$lib/server/utils/audit-log', () => ({
    auditLog: vi.fn(),
    auditActorFromLocals: vi.fn(),
}));
vi.mock('$lib/server/utils/fetch-timeout.js', () => ({
    fetchWithTimeout: (...args: unknown[]) => mockFetch(...args),
}));

const callPost = async (body: unknown) => {
    const { POST } = await import('./+server.js');
    return (POST as (event: unknown) => Promise<Response>)({
        request: new Request('http://localhost/test', {
            method: 'POST',
            body: JSON.stringify(body),
        }),
    });
};

describe('POST /api/setup/integrations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockDim.mockResolvedValue(1024);
        mockSave.mockResolvedValue(undefined);
        configState.values = {};
        configState.locked.clear();
        mockFetch.mockReset();
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ data: [{ embedding: new Array(1024).fill(0.1) }] }),
        });
    });

    it.each([401, 403, 400, 404, 422])(
        'refuses to save or enable embeddings after HTTP %s',
        async (status) => {
            mockFetch.mockResolvedValue({
                ok: false,
                status,
                json: async () => ({ error: 'sk-secret user:password' }),
            });
            const res = await callPost({
                mdblistApiKey: 'mdb',
                embedding: { provider: 'openai', apiKey: 'sk-secret' },
            });
            expect(res.status).toBe(422);
            const text = await res.text();
            expect(text).toMatch(/key|model|provider/i);
            expect(text).not.toMatch(/sk-secret|user:password/);
            expect(text).toMatch(/switch embeddings off.*continue/i);
            expect(mockSave).toHaveBeenCalledExactlyOnceWith({ MDBLIST_API_KEY: 'mdb' });
        },
    );

    it('refuses a dimension mismatch, naming the required and returned widths', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ data: [{ embedding: new Array(1536).fill(0.1) }] }),
        });
        const res = await callPost({ embedding: { provider: 'openai', apiKey: 'sk-x' } });
        expect(res.status).toBe(422);
        expect(await res.text()).toMatch(/1536.*1024|1024.*1536/);
        expect(mockSave).not.toHaveBeenCalled();
    });

    it.each([
        { embedding: [] },
        { embedding: ['not-a-number'] },
        { embedding: [null] },
        { embedding: [0.1] },
    ])('refuses an invalid or wrong-width vector %j', async ({ embedding }) => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ data: [{ embedding }] }),
        });
        expect((await callPost({ embedding: { provider: 'openai', apiKey: 'sk-x' } })).status).toBe(
            422,
        );
        expect(mockSave).not.toHaveBeenCalled();
    });

    it('saves during a failed connection with a visible retry warning', async () => {
        mockFetch.mockRejectedValueOnce(
            new TypeError('sk-secret', { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }),
        );
        const body = { embedding: { provider: 'openai', apiKey: 'sk-secret' } };
        const res = await callPost(body);
        expect(res.status).toBe(200);
        const result = await res.json();
        expect(result.warning).toMatch(/could not verify now.*Lumastra will retry/i);
        expect(result.warning).toContain('NODE_EXTRA_CA_CERTS');
        expect(result.warning).not.toContain('sk-secret');
        expect(mockSave).toHaveBeenCalledWith(
            expect.objectContaining({ FEATURE_AI_RECOMMENDATIONS: true }),
        );
        expect((await callPost(body)).status).toBe(200);
        expect(mockSave).toHaveBeenCalledTimes(2);
    });

    it.each(['http://', 'ftp://host', 'https://user:password@host/v1', 'https://host/v1#secret'])(
        'rejects an invalid custom URL %s before sending a key',
        async (endpoint) => {
            expect(
                (await callPost({ embedding: { provider: 'custom', apiKey: 'k', endpoint } }))
                    .status,
            ).toBe(422);
            expect(mockFetch).not.toHaveBeenCalled();
            expect(mockSave).not.toHaveBeenCalled();
        },
    );

    it('refuses a conflicting env-owned value before probing', async () => {
        configState.locked.add('EMBEDDING_BASE_URL');
        configState.values.EMBEDDING_BASE_URL = 'https://env.example/v1';
        const res = await callPost({ embedding: { provider: 'openai', apiKey: 'sk-x' } });
        expect(res.status).toBe(422);
        expect(await res.text()).toContain('EMBEDDING_BASE_URL');
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockSave).not.toHaveBeenCalled();
    });

    it('skips an unchanged env-owned connection and can safely re-run it', async () => {
        configState.values = {
            EMBEDDING_BASE_URL: '',
            OPENAI_API_KEY: 'sk-env',
            EMBEDDING_MODEL: 'text-embedding-3-small',
            EMBEDDING_DIMENSIONS: 1024,
            FEATURE_AI_RECOMMENDATIONS: true,
        };
        Object.keys(configState.values).forEach((key) => configState.locked.add(key));
        const body = { embedding: { provider: 'openai', apiKey: 'sk-env' } };
        expect((await callPost(body)).status).toBe(200);
        expect((await callPost(body)).status).toBe(200);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockSave).not.toHaveBeenCalled();
    });

    it('probes the env-owned model that will actually be used', async () => {
        configState.values.EMBEDDING_MODEL = 'custom-env-model';
        configState.locked.add('EMBEDDING_MODEL');
        await callPost({
            embedding: { provider: 'custom', apiKey: 'k', endpoint: 'http://embeddings:8000/v1' },
        });
        expect(JSON.parse(mockFetch.mock.calls[0][1].body).model).toBe('custom-env-model');
    });

    it('clears an old Voyage key when switching to OpenAI so runtime uses the tested provider', async () => {
        configState.values.VOYAGE_API_KEY = 'old-voyage-key';
        await callPost({ embedding: { provider: 'openai', apiKey: 'sk-x' } });
        expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ VOYAGE_API_KEY: '' }));
    });

    it('refuses a switch to OpenAI when an env-owned Voyage key would still take precedence', async () => {
        configState.values.VOYAGE_API_KEY = 'env-voyage-key';
        configState.locked.add('VOYAGE_API_KEY');
        const res = await callPost({ embedding: { provider: 'openai', apiKey: 'sk-x' } });
        expect(res.status).toBe(422);
        expect(await res.text()).toContain('VOYAGE_API_KEY');
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockSave).not.toHaveBeenCalled();
    });

    it('503s when the database is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);
        expect((await callPost({})).status).toBe(503);
    });

    it('saves only MDBList when only that is provided (no embedding)', async () => {
        const res = await callPost({ mdblistApiKey: 'mdb-key' });
        expect(res.status).toBe(200);
        expect(mockSave).toHaveBeenCalledWith({ MDBLIST_API_KEY: 'mdb-key' });
    });

    it('does nothing (saved:false) when the body is empty', async () => {
        const body = await (await callPost({})).json();
        expect(body).toEqual({ ok: true, saved: false });
        expect(mockSave).not.toHaveBeenCalled();
    });

    it('maps OpenAI + locks the dimension + enables AI', async () => {
        await callPost({
            embedding: { provider: 'openai', apiKey: 'sk-x', model: 'text-embedding-3-small' },
        });
        expect(mockSave).toHaveBeenCalledWith(
            expect.objectContaining({
                OPENAI_API_KEY: 'sk-x',
                EMBEDDING_DIMENSIONS: 1024,
                EMBEDDING_MODEL: 'text-embedding-3-small',
                FEATURE_AI_RECOMMENDATIONS: true,
            }),
        );
    });

    it('maps Voyage to VOYAGE_API_KEY', async () => {
        await callPost({ embedding: { provider: 'voyage', apiKey: 'pa-x' } });
        const u = mockSave.mock.calls[0][0] as Record<string, unknown>;
        expect(u.VOYAGE_API_KEY).toBe('pa-x');
        expect('OPENAI_API_KEY' in u).toBe(false);
    });

    it('maps a custom endpoint to EMBEDDING_API_KEY + EMBEDDING_BASE_URL, never OPENAI_API_KEY', async () => {
        // The embedding resolver reads only EMBEDDING_API_KEY for a custom base URL
        // (no fallback to OPENAI_API_KEY), so the old OPENAI_API_KEY mapping left a
        // wizard-configured custom endpoint unusable and filed a third-party key as
        // the OpenAI one.
        await callPost({
            embedding: { provider: 'custom', apiKey: 'k', endpoint: 'https://e.example.com/v1' },
        });
        const u = mockSave.mock.calls[0][0] as Record<string, unknown>;
        expect(u.EMBEDDING_API_KEY).toBe('k');
        expect(u.EMBEDDING_BASE_URL).toBe('https://e.example.com/v1');
        expect('OPENAI_API_KEY' in u).toBe(false);
    });

    it.each(['openai', 'voyage'])(
        'clears a custom base URL left from an earlier run when %s is picked',
        async (provider) => {
            await callPost({ embedding: { provider, apiKey: 'x' } });
            const u = mockSave.mock.calls[0][0] as Record<string, unknown>;
            expect(u.EMBEDDING_BASE_URL).toBe('');
            expect('EMBEDDING_API_KEY' in u).toBe(false);
        },
    );

    it('rejects a custom provider with no endpoint', async () => {
        const res = await callPost({ embedding: { provider: 'custom', apiKey: 'k' } });
        expect(res.status).toBe(422);
        expect(mockSave).not.toHaveBeenCalled();
    });

    it('rejects an embedding with no api key', async () => {
        const res = await callPost({ embedding: { provider: 'openai', apiKey: '' } });
        expect(res.status).toBe(422);
    });

    it('rejects an unknown provider', async () => {
        const res = await callPost({ embedding: { provider: 'nope', apiKey: 'k' } });
        expect(res.status).toBe(422);
    });

    it('refuses (500, no save) when the embedding dimension cannot be read', async () => {
        mockDim.mockResolvedValue(null);
        const res = await callPost({ embedding: { provider: 'openai', apiKey: 'sk-x' } });

        expect(res.status).toBe(500);
        expect(mockSave).not.toHaveBeenCalled();
    });

    it('still saves MDBList even though the embedding block is absent', async () => {
        // (dimension null only matters when an embedding is requested)
        mockDim.mockResolvedValue(null);
        await callPost({ mdblistApiKey: 'mdb' });
        expect(mockSave).toHaveBeenCalledWith({ MDBLIST_API_KEY: 'mdb' });
    });

    it.each([408, 429, 500, 502, 503, 504])(
        'saves both integrations with a retry warning after HTTP %s',
        async (status) => {
            mockFetch.mockResolvedValue({
                ok: false,
                status,
                json: async () => ({ error: 'sk-secret' }),
            });
            const response = await callPost({
                mdblistApiKey: 'mdb',
                embedding: { provider: 'openai', apiKey: 'sk-secret' },
            });
            expect(response.status).toBe(200);
            const result = await response.json();
            expect(result).toMatchObject({ ok: true, saved: true });
            expect(result.warning).toMatch(/could not verify now.*Lumastra will retry/i);
            expect(result.warning).not.toContain('sk-secret');
            expect(mockSave).toHaveBeenCalledWith({ MDBLIST_API_KEY: 'mdb' });
            expect(mockSave).toHaveBeenCalledWith(
                expect.objectContaining({
                    OPENAI_API_KEY: 'sk-secret',
                    FEATURE_AI_RECOMMENDATIONS: true,
                }),
            );
        },
    );

    it.each(['TimeoutError', 'AbortError', 'TypeError'])(
        'saves embeddings after %s with a retry warning',
        async (name) => {
            mockFetch.mockRejectedValue(Object.assign(new Error('sk-secret'), { name }));
            const response = await callPost({
                embedding: { provider: 'openai', apiKey: 'sk-secret' },
            });
            expect(response.status).toBe(200);
            expect((await response.json()).warning).toMatch(
                /could not verify now.*Lumastra will retry/i,
            );
            expect(mockSave).toHaveBeenCalledWith(
                expect.objectContaining({ FEATURE_AI_RECOMMENDATIONS: true }),
            );
        },
    );

    it('skips unchanged embeddings even when another integration changes during an outage', async () => {
        configState.values = {
            EMBEDDING_BASE_URL: '',
            OPENAI_API_KEY: 'sk-existing',
            EMBEDDING_MODEL: 'text-embedding-3-small',
            EMBEDDING_DIMENSIONS: 1024,
            FEATURE_AI_RECOMMENDATIONS: true,
        };
        mockFetch.mockRejectedValue(new Error('outage'));
        const response = await callPost({
            mdblistApiKey: 'new-mdb',
            embedding: { provider: 'openai', apiKey: 'sk-existing' },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, saved: true });
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockSave).toHaveBeenCalledExactlyOnceWith({ MDBLIST_API_KEY: 'new-mdb' });
    });

    it.each(['provider', 'key', 'url', 'dimension', 'database', 'env'])(
        'preserves MDBList when embeddings fail %s validation',
        async (failure) => {
            const embedding = { provider: 'openai', apiKey: 'sk-x', endpoint: '' };
            if (failure === 'provider') embedding.provider = 'invalid';
            if (failure === 'key') embedding.apiKey = '';
            if (failure === 'url') {
                embedding.provider = 'custom';
                embedding.endpoint = 'https://user:password@host';
            }
            if (failure === 'dimension') mockDim.mockResolvedValue(null);
            if (failure === 'database') mockGetSql.mockResolvedValue(null);
            if (failure === 'env') {
                configState.values.FEATURE_AI_RECOMMENDATIONS = false;
                configState.locked.add('FEATURE_AI_RECOMMENDATIONS');
            }
            const response = await callPost({ mdblistApiKey: 'mdb', embedding });
            expect(response.ok).toBe(false);
            expect(mockSave).toHaveBeenCalledExactlyOnceWith({ MDBLIST_API_KEY: 'mdb' });
        },
    );

    it('preserves MDBList when a returned vector has the wrong dimension', async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            json: async () => ({ data: [{ embedding: new Array(1536).fill(0.1) }] }),
        });
        const response = await callPost({
            mdblistApiKey: 'mdb',
            embedding: { provider: 'openai', apiKey: 'sk-x' },
        });
        expect(response.status).toBe(422);
        expect(await response.text()).toMatch(/switch embeddings off.*continue/i);
        expect(mockSave).toHaveBeenCalledExactlyOnceWith({ MDBLIST_API_KEY: 'mdb' });
    });
});
