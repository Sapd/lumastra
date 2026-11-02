// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test for GET /api/setup/media-count — the empty-first-scan detector.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetSql, mockCount, mockProblem } = vi.hoisted(() => ({
    mockGetSql: vi.fn(),
    mockCount: vi.fn(),
    mockProblem: vi.fn(),
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
    countActiveMediaItems: (...a: unknown[]) => mockCount(...a),
    getLatestScanMetadataProblem: (...a: unknown[]) => mockProblem(...a),
}));

const callGet = async () => {
    const { GET } = await import('./+server.js');
    return (GET as (event: unknown) => Promise<Response>)({});
};

describe('GET /api/setup/media-count', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue({});
        mockProblem.mockResolvedValue({
            metadataUnavailable: 0,
            metadataProviderError: null,
            metadataProviderId: null,
        });
    });

    it('503s when the database is unavailable', async () => {
        mockGetSql.mockResolvedValue(null);
        const res = await callGet();
        expect(res.status).toBe(503);
        expect(mockCount).not.toHaveBeenCalled();
    });

    it('returns the active media count', async () => {
        mockCount.mockResolvedValue(0);
        const res = await callGet();
        const body = await res.json();
        expect(res.status).toBe(200);
        expect(body).toEqual({ count: 0, metadataUnavailable: 0, metadataProviderError: null });
    });

    it('reports a rejected TMDB key from the latest scans (S5)', async () => {
        mockCount.mockResolvedValue(147);
        mockProblem.mockResolvedValue({
            metadataUnavailable: 147,
            metadataProviderError: 'auth',
            metadataProviderId: 'tmdb-metadata-provider',
        });
        const body = await (await callGet()).json();
        expect(body).toEqual({
            count: 147,
            metadataUnavailable: 147,
            metadataProviderError: 'tmdb_auth',
        });
    });

    it('reports a missing metadata provider as provider_unavailable', async () => {
        mockCount.mockResolvedValue(3);
        mockProblem.mockResolvedValue({
            metadataUnavailable: 3,
            metadataProviderError: 'unavailable',
            metadataProviderId: null,
        });
        const body = await (await callGet()).json();
        expect(body.metadataProviderError).toBe('provider_unavailable');
    });
});
