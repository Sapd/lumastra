// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ fetch: vi.fn(), warn: vi.fn(), provider: true }));
vi.mock('$lib/server/middleware/auth.js', () => ({ requireAdmin: (handler: unknown) => handler }));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('$lib/server/database/queries/onboarding.queries.js', () => ({
    getEmbeddingDimension: async () => 3,
}));
vi.mock('$lib/server/utils/fetch-timeout.js', () => ({ fetchWithTimeout: h.fetch }));
vi.mock('$lib/server/utils/logger.js', () => ({ Logger: { for: () => ({ warn: h.warn }) } }));
vi.mock('$lib/server/config/domains/ai.js', () => ({
    getAiConfig: () => ({
        embeddingBaseUrl: 'http://internal.example/v1',
        embeddingApiKey: 'secret-key',
    }),
}));
vi.mock('$lib/server/ai/embedding-models.js', () => ({
    resolveEffectiveEmbedding: () => ({
        hasProvider: h.provider,
        provider: 'custom',
        model: 'test',
    }),
}));
import { GET } from './+server';
import { setupProbeHttpError } from '$lib/server/utils/fetch-error-cause.js';
beforeEach(() => {
    vi.clearAllMocks();
    h.provider = true;
});
it.each([400, 401, 403, 404, 422, 429, 500])(
    'D-L3: returns a fixed message for status %s',
    async (status) => {
        h.fetch.mockResolvedValue(
            new Response(JSON.stringify({ error: { message: 'internal-service-secret' } }), {
                status,
            }),
        );
        const response = await GET({} as never);
        expect(await response.json()).toMatchObject({
            ok: false,
            error: setupProbeHttpError(status, 'embedding'),
        });
        expect(h.warn).toHaveBeenCalled();
    },
);
it('D-L3: thrown failures are generic and logged', async () => {
    h.fetch.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1:1234 secret'));
    const response = await GET({} as never);
    expect(await response.json()).toMatchObject({
        ok: false,
        error: 'Embedding connection test failed.',
    });
    expect(h.warn).toHaveBeenCalled();
});
it('retains dimension mismatch and missing-provider responses', async () => {
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] })));
    expect(await (await GET({} as never)).json()).toMatchObject({
        ok: true,
        dimension: 2,
        expected: 3,
        matches: false,
    });
    h.provider = false;
    expect(await (await GET({} as never)).json()).toMatchObject({
        ok: false,
        error: 'No embedding provider is configured.',
    });
});
