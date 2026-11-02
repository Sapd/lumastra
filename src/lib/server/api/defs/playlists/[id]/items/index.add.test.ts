// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
    add: vi.fn(),
    context: vi.fn(),
    invalidate: vi.fn(),
    kind: vi.fn(),
}));
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: async () => ({ allowed: true }),
    rateLimitHeaders: () => ({}),
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
    cacheInvalidation: { onWatchlistChange: mocks.invalidate },
}));
vi.mock('$lib/server/database/queries/playlists.queries.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/queries/playlists.queries.js')>()),
    getPlaylistType: mocks.kind,
}));
const { def } = await import('./index.js');
const mediaId = '550e8400-e29b-41d4-a716-446655440000';
const userId = '110e8400-e29b-41d4-a716-446655440000';
const summary = { itemCount: 1, revision: 2, updatedAt: '2026-10-17T00:00:00Z' };
function post(body: unknown) {
    const url = new URL('http://localhost/api/playlists/1/items');
    return def.handlers.POST!(
        {
            url,
            params: { id: '1' },
            locals: { user: { userId, username: 'owner', userGroups: [], maxAgeRating: null } },
            request: new Request(url, { method: 'POST', body: JSON.stringify(body) }),
        } as unknown as RequestEvent,
        { surface: 'internal' },
    );
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({ context: { playlistId: 1, role: 'owner', sql: {} } });
    mocks.kind.mockResolvedValue('general');
    mocks.add.mockResolvedValue({
        results: [
            {
                mediaId,
                status: 'added',
                entries: [{ id: 1, mediaId }],
                expanded: false,
                reason: null,
            },
        ],
        summary,
    });
});
describe('POST playlist items catalog batch (single and former bulk cases)', () => {
    it('returns 200 with per-input outcomes and the revision summary', async () => {
        const response = await post({ mediaIds: [mediaId] });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            results: [{ mediaId, status: 'added' }],
            summary,
        });
        expect(mocks.add).toHaveBeenCalledWith(
            expect.objectContaining({ mediaIds: [mediaId], playlistId: 1, surface: 'internal' }),
        );
        expect(mocks.invalidate).not.toHaveBeenCalled();
    });
    it('does not turn duplicate results into a 409', async () => {
        mocks.add.mockResolvedValue({
            results: [
                {
                    mediaId,
                    status: 'duplicate',
                    entries: [{ id: 1, mediaId }],
                    expanded: false,
                    reason: null,
                },
            ],
            summary,
        });
        const response = await post({ mediaIds: [mediaId] });
        expect(response.status).toBe(200);
        expect((await response.json()).results[0].status).toBe('duplicate');
    });
    it('preserves expanded child entries and rejected outcomes within the same batch', async () => {
        mocks.add.mockResolvedValue({
            results: [
                {
                    mediaId,
                    status: 'added',
                    entries: [{ id: 1 }, { id: 2 }],
                    expanded: true,
                    reason: null,
                },
                {
                    mediaId,
                    status: 'rejected',
                    entries: [],
                    expanded: false,
                    reason: 'media_type_not_allowed',
                },
            ],
            summary,
        });
        expect((await (await post({ mediaIds: [mediaId, mediaId] })).json()).results).toHaveLength(
            2,
        );
    });
    it('denies readonly callers before adding', async () => {
        mocks.context.mockResolvedValue({ context: { playlistId: 1, role: 'readonly', sql: {} } });
        expect((await post({ mediaIds: [mediaId] })).status).toBe(403);
        expect(mocks.add).not.toHaveBeenCalled();
    });
    it('invalidates the watchlist cache for successful entries only', async () => {
        mocks.kind.mockResolvedValue('watchlist');
        await post({ mediaIds: [mediaId] });
        expect(mocks.invalidate).toHaveBeenCalledWith(userId, mediaId);
        mocks.invalidate.mockClear();
        mocks.add.mockResolvedValue({
            results: [{ mediaId, status: 'duplicate', entries: [{ id: 1, mediaId }] }],
            summary,
        });
        await post({ mediaIds: [mediaId] });
        expect(mocks.invalidate).not.toHaveBeenCalled();
    });
    it('does not lose a successful write when cache invalidation fails', async () => {
        mocks.kind.mockResolvedValue('watchlist');
        mocks.invalidate.mockRejectedValueOnce(new Error('cache unavailable'));
        expect((await post({ mediaIds: [mediaId] })).status).toBe(200);
    });
    it.each([
        {},
        { mediaIds: [] },
        { mediaIds: ['not-a-uuid'] },
        { mediaIds: Array(501).fill(mediaId) },
        { externalIds: { internal: mediaId }, mediaType: 'movie', title: 'old input' },
        { items: [{ externalIds: { internal: mediaId }, title: 'old bulk input' }] },
        { mediaIds: [mediaId], externalIds: { jellyfin: 'legacy' } },
    ])('rejects invalid or retired input %j before invoking the manager', async (body) => {
        expect((await post(body)).status).toBe(422);
        expect(mocks.add).not.toHaveBeenCalled();
    });
});
