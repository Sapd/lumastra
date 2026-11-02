// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The playlist write budget: POST items and POST items/bulk-delete share one
 * `playlist-bulk:<username>` counter (20 per 60 s). The add handler consumes it
 * only after the body parsed; bulk-delete declares the same key via the def's
 * `rateLimit` (enforced by mount()).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
    add: vi.fn(),
    context: vi.fn(),
    kind: vi.fn(),
    counters: new Map<string, number>(),
    keys: [] as string[],
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: async (key: string, limit: number) => {
        mocks.keys.push(key);
        const used = (mocks.counters.get(key) ?? 0) + 1;
        mocks.counters.set(key, used);
        return {
            allowed: used <= limit,
            total: limit,
            remaining: Math.max(0, limit - used),
            resetAt: Math.floor(Date.now() / 1000) + 30,
        };
    },
    rateLimitHeaders: (r: { total: number; remaining: number; resetAt: number }) => ({
        'X-RateLimit-Limit': String(r.total),
        'X-RateLimit-Remaining': String(r.remaining),
        'X-RateLimit-Reset': String(r.resetAt),
    }),
}));
vi.mock('$lib/server/utils/playlist-utils.js', async (original) => ({
    ...(await original<typeof import('$lib/server/utils/playlist-utils.js')>()),
    getPlaylistContext: mocks.context,
}));
vi.mock('$lib/server/services/playlist-item-manager.service.js', () => ({
    playlistItemManager: { addMediaItems: mocks.add },
}));
vi.mock('$lib/server/cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups: async () => [],
    toLibraryAccessUser: () => ({}),
}));
vi.mock('$lib/server/cache', () => ({
    cacheInvalidation: { onWatchlistChange: vi.fn() },
}));
vi.mock('$lib/server/database/queries/playlists.queries.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/queries/playlists.queries.js')>()),
    getPlaylistType: mocks.kind,
}));
const { def } = await import('./index.js');
const { def: bulkDelete } = await import('./bulk-delete.js');
const mediaId = '550e8400-e29b-41d4-a716-446655440000';
const userId = '110e8400-e29b-41d4-a716-446655440000';

function post(body: unknown, user: object | null = { userId, username: 'alice' }, principal?: object) {
    const url = new URL('http://localhost/api/playlists/1/items');
    return def.handlers.POST!(
        {
            url,
            params: { id: '1' },
            locals: { user: user ?? undefined, principal },
            request: new Request(url, {
                method: 'POST',
                body: typeof body === 'string' ? body : JSON.stringify(body),
            }),
        } as unknown as RequestEvent,
        { surface: 'internal' },
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.counters.clear();
    mocks.keys.length = 0;
    mocks.context.mockResolvedValue({ context: { playlistId: 1, role: 'owner', sql: {} } });
    mocks.kind.mockResolvedValue('general');
    mocks.add.mockResolvedValue({ results: [], summary: { itemCount: 0, revision: 0, updatedAt: '' } });
});

describe('playlist write budget', () => {
    it('rejects the 21st combined add/bulk-delete call with 429 and Retry-After', async () => {
        const bulkKey = (
            bulkDelete.rateLimit as unknown as { keyBy: (e: unknown) => string }
        ).keyBy({ locals: { user: { username: 'alice' } } });
        // 19 bulk-delete calls drain the shared counter (mount() would do this).
        const limit = (bulkDelete.rateLimit as unknown as { limit: number }).limit;
        expect(limit).toBe(20);
        const { checkRateLimit } = await import('$lib/server/middleware/valkey-rate-limit.js');
        for (let i = 0; i < 19; i++) await checkRateLimit(bulkKey, limit, 60);

        expect((await post({ mediaIds: [mediaId] })).status).toBe(200); // 20th
        const blocked = await post({ mediaIds: [mediaId] }); // 21st
        expect(blocked.status).toBe(429);
        expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect(blocked.headers.get('X-RateLimit-Remaining')).toBe('0');
        expect(mocks.add).toHaveBeenCalledTimes(1);
    });

    it('uses the same key as bulk-delete, preferring the principal username', async () => {
        await post({ mediaIds: [mediaId] }, { userId, username: 'alice' });
        await post(
            { mediaIds: [mediaId] },
            { userId, username: 'alice' },
            { username: 'token-owner' },
        );
        expect(mocks.keys).toEqual(['playlist-bulk:alice', 'playlist-bulk:token-owner']);
        const keyBy = (bulkDelete.rateLimit as unknown as { keyBy: (e: unknown) => string }).keyBy;
        expect(keyBy({ locals: { user: { username: 'alice' } } })).toBe(mocks.keys[0]);
        expect(
            keyBy({ locals: { user: { username: 'alice' }, principal: { username: 'token-owner' } } }),
        ).toBe(mocks.keys[1]);
        expect(
            (bulkDelete.rateLimit as unknown as { windowSec: number }).windowSec,
        ).toBe(60);
    });

    it('does not consume budget for an invalid or malformed body', async () => {
        expect((await post({ mediaIds: 'nope' })).status).toBe(422);
        expect((await post('{not json')).status).toBe(422);
        expect(mocks.keys).toEqual([]);
        expect(mocks.counters.size).toBe(0);
        expect(mocks.add).not.toHaveBeenCalled();
    });

    it('answers 401 without a user and consumes nothing', async () => {
        const response = await post({ mediaIds: [mediaId] }, null);
        expect(response.status).toBe(401);
        expect(mocks.keys).toEqual([]);
    });
});
