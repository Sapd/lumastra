// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();
const mockApiPut = vi.fn();
const mockApiDelete = vi.fn();

vi.mock('$lib/api/client', () => ({
    apiGet: (...a: unknown[]) => mockApiGet(...a),
    apiPost: (...a: unknown[]) => mockApiPost(...a),
    apiPut: (...a: unknown[]) => mockApiPut(...a),
    apiDelete: (...a: unknown[]) => mockApiDelete(...a),
}));

import { getSyncStatus, startSync } from './integrations.js';

beforeEach(() => vi.clearAllMocks());

describe('getSyncStatus', () => {
    it('GETs the provider sync/status route and parses via SyncStatusSchema', async () => {
        const status = {
            state: 'active',
            processed: 3,
            recentActivity: [],
        };
        mockApiGet.mockResolvedValue({ data: status, error: null, status: 200 });

        const result = await getSyncStatus('trakt');

        expect(mockApiGet).toHaveBeenCalledTimes(1);
        expect(mockApiGet.mock.calls[0][0]).toBe('/api/integrations/trakt/sync/status');
        // Second arg is the SyncStatusSchema — spot-check it actually validates the shape.
        const schema = mockApiGet.mock.calls[0][1];
        expect(schema.safeParse(status).success).toBe(true);
        expect(result).toEqual({ data: status, error: null, status: 200 });
    });
});

describe('startSync', () => {
    it('POSTs the direction to the provider sync route', async () => {
        mockApiPost.mockResolvedValue({
            data: { runId: 'run-1', deduped: false },
            error: null,
            status: 202,
        });

        const result = await startSync('mal', 'pull');

        expect(mockApiPost).toHaveBeenCalledTimes(1);
        expect(mockApiPost.mock.calls[0][0]).toBe('/api/integrations/mal/sync');
        expect(mockApiPost.mock.calls[0][2]).toEqual({ direction: 'pull' });
        expect(result.data).toEqual({ runId: 'run-1', deduped: false });
    });
});
