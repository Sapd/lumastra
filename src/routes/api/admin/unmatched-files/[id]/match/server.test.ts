// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUpsert, mockAfterMatched, mockExists } = vi.hoisted(() => ({
    mockUpsert: vi.fn(),
    mockAfterMatched: vi.fn(),
    mockExists: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    getMediaItemType: mockExists,
}));
vi.mock('$lib/server/services/catalog.service.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/services/catalog.service.js')>();
    return {
        ExternalIdOwnedByAnotherItemError: actual.ExternalIdOwnedByAnotherItemError,
        createCatalogService: () => ({ upsertExternalId: mockUpsert }),
    };
});
vi.mock('$lib/server/services/media-lifecycle.service.js', () => ({
    MediaLifecycleService: { afterMatched: mockAfterMatched },
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (evt: unknown) => Promise<Response>) => fn,
}));

import { POST } from './+server.js';
import { ExternalIdOwnedByAnotherItemError } from '$lib/server/services/catalog.service.js';

const ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

async function call(body: unknown): Promise<Response> {
    const url = new URL(`http://test/api/admin/unmatched-files/${ID}/match`);
    return await POST!({
        locals: {
            user: { ownerIsAdmin: true, username: 'admin' },
            principal: { kind: 'session', isAdmin: true, scopes: ['admin'] },
        },
        url,
        params: { id: ID },
        request: new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'http://test' },
            body: JSON.stringify(body),
        }),
    } as never);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockExists.mockResolvedValue('movie');
    mockUpsert.mockResolvedValue(undefined);
    mockAfterMatched.mockResolvedValue(undefined);
});

describe('POST /api/admin/unmatched-files/[id]/match', () => {
    it('reports a conflict with the owning item taken from the error', async () => {
        mockUpsert.mockRejectedValue(
            new ExternalIdOwnedByAnotherItemError('tmdb', '550', 'movie', OWNER),
        );
        const res = await call({ provider: 'tmdb', externalId: '550', type: 'movie' });
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ conflictMediaId: OWNER, fileMediaId: ID });
    });

    it('reports success when the match is written but a follow-up hook fails', async () => {
        mockAfterMatched.mockRejectedValue(new Error('valkey down'));
        const res = await call({ provider: 'tmdb', externalId: '550', type: 'movie' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ mediaItemId: ID });
    });

    it('refuses a series id on a movie row (composite-key corruption)', async () => {
        const res = await call({ provider: 'tmdb', externalId: '1429', type: 'series' });
        expect(res.status).toBe(422);
        expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('accepts a series match on a tv row, legacy "tv" included', async () => {
        mockExists.mockResolvedValue('tv');
        expect((await call({ provider: 'tmdb', externalId: '1429', type: 'tv' })).status).toBe(200);
    });
});
