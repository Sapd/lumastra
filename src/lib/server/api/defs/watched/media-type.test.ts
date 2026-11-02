// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /watched — media-type discriminator.
 *
 * The file header promised "canonical `series` (never 'tv')" directly above a
 * transform that emitted the raw stored `tv`, and the SPA response schema was
 * pinned to the bug rather than the promise. Both are fixed; this keeps them
 * from drifting apart again.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetCachedWatchedIds = vi.fn();
const mockSetCachedWatchedIds = vi.fn();
const mockGetWatchedItems = vi.fn();
const mockGetUserIdByUsername = vi.fn();

vi.mock('$lib/server/services/watched-cache.service.js', () => ({
    getCachedWatchedIds: (...a: unknown[]) => mockGetCachedWatchedIds(...a),
    setCachedWatchedIds: (...a: unknown[]) => mockSetCachedWatchedIds(...a),
}));

// `getWatchedItems` is a defineQuery object invoked as `.all(sql, params)`,
// not a bare function.
vi.mock('$lib/server/database/queries/index.js', () => ({
    getWatchedItems: { all: (...a: unknown[]) => mockGetWatchedItems(...a) },
    getUserIdByUsername: (...a: unknown[]) => mockGetUserIdByUsername(...a),
}));

vi.mock('$lib/server/database/queries/builders/media-access-boundary.js', () => ({
    unrestrictedAccess: () => ({}),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));

vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));

vi.mock('$lib/server/dev-user.js', () => ({
    getEffectiveUser: (_: unknown, username: string) => username,
}));

vi.mock('$lib/server/config.js', () => ({ config: { DEFAULT_USER: 'default-user' } }));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

const { def: watchedDef } = await import('./index.js');
const { WatchedItemsDataSchema } = await import('$lib/schemas/watched-types.js');

function makeEvent(): RequestEvent {
    const url = new URL('http://localhost/api/watched');
    return {
        url,
        request: new Request(url.toString()),
        params: {},
        route: { id: '/api/watched' },
        locals: { user: { username: 'alice', userId: 'u1' } },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedWatchedIds.mockResolvedValue(null);
    mockGetUserIdByUsername.mockResolvedValue('u1');
    mockSetCachedWatchedIds.mockResolvedValue(undefined);
});

describe('GET /watched — media type', () => {
    it('emits `series` for a stored `tv` row, never the raw token', async () => {
        mockGetWatchedItems.mockResolvedValue([
            { tmdb_id: '1396', media_type: 'tv', internal_id: 'uuid-1' },
        ]);

        const res = (await watchedDef.handlers.GET!(makeEvent(), {
            surface: 'internal',
        } as never)) as Response;

        const body = (await res.json()) as { watchedItems: Array<Record<string, unknown>> };
        expect(body.watchedItems[0].mediaType).toBe('series');
    });

    it('leaves `movie` alone', async () => {
        mockGetWatchedItems.mockResolvedValue([
            { tmdb_id: '550', media_type: 'movie', internal_id: 'uuid-2' },
        ]);

        const res = (await watchedDef.handlers.GET!(makeEvent(), {
            surface: 'internal',
        } as never)) as Response;

        const body = (await res.json()) as { watchedItems: Array<Record<string, unknown>> };
        expect(body.watchedItems[0].mediaType).toBe('movie');
    });

    it('validates against the SPA-facing WatchedItemsDataSchema', async () => {
        // The schema was pinned to ['movie','tv']; if handler and schema ever
        // disagree again, the SPA's validated client rejects the whole response.
        mockGetWatchedItems.mockResolvedValue([
            { tmdb_id: '1396', media_type: 'tv', internal_id: 'uuid-1' },
            { tmdb_id: '550', media_type: 'movie', internal_id: 'uuid-2' },
        ]);

        const res = (await watchedDef.handlers.GET!(makeEvent(), {
            surface: 'internal',
        } as never)) as Response;

        const parsed = WatchedItemsDataSchema.safeParse(await res.json());
        expect(parsed.error?.issues ?? []).toEqual([]);
        expect(parsed.success).toBe(true);
    });
});
