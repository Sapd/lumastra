// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET|POST /j/UserItems/{itemId}/UserData — which writes a partial
 * UpdateUserItemDataDto turns into, and that the answer is the re-read dto.
 * Real-DB round trip: server.integration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestHandler } from './$types';

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

const fakeSql = {};
vi.mock('$lib/server/database', () => ({ getDb: () => fakeSql }));

const mockCheckMediaAccess = vi.fn();
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => mockCheckMediaAccess(...a),
}));

const mockMarkWatched = vi.fn();
const mockMarkUnwatched = vi.fn();
const mockSetResumePosition = vi.fn();
vi.mock('$lib/server/services/watch-manager.service', () => ({
    watchManager: {
        markWatched: (...a: unknown[]) => mockMarkWatched(...a),
        markUnwatched: (...a: unknown[]) => mockMarkUnwatched(...a),
        setResumePosition: (...a: unknown[]) => mockSetResumePosition(...a),
    },
}));

const mockGetMediaType = vi.fn();
vi.mock('$lib/server/database/queries/media-type-cache.queries', () => ({
    getMediaType: (...a: unknown[]) => mockGetMediaType(...a),
    isMusicMediaType: (t: string | null) => t === 'track',
}));

const mockReadUserItemData = vi.fn();
vi.mock('$lib/server/jellyfin-compat/user-item-data', () => ({
    readUserItemData: (...a: unknown[]) => mockReadUserItemData(...a),
}));

const mockSetJellyfinFavorite = vi.fn();
vi.mock('$lib/server/jellyfin-compat/favorites', () => ({
    setJellyfinFavorite: (...a: unknown[]) => mockSetJellyfinFavorite(...a),
}));

const { GET, POST } = await import('./+server.js');

const ITEM_ID = '00000000-0000-4000-a000-000000000001';
const USER = { userId: 'uid-alice', username: 'alice', hasLiveTvPermission: false };
const DTO = {
    PlaybackPositionTicks: 0,
    PlayedPercentage: 0,
    Played: false,
    IsFavorite: true,
    PlayCount: 0,
    Key: ITEM_ID,
    ItemId: ITEM_ID,
};

function makeEvent(method: 'GET' | 'POST', body?: unknown, itemId = ITEM_ID) {
    const url = new URL(`https://app.example/j/UserItems/${itemId}/UserData`);
    return {
        request: new Request(url, {
            method,
            ...(body !== undefined
                ? {
                      body: typeof body === 'string' ? body : JSON.stringify(body),
                      headers: { 'content-type': 'application/json' },
                  }
                : {}),
        }),
        url,
        params: { itemId },
        locals: { user: USER },
    } as never;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockCheckMediaAccess.mockResolvedValue(true);
    mockReadUserItemData.mockResolvedValue(DTO);
    mockGetMediaType.mockResolvedValue('movie');
    mockSetJellyfinFavorite.mockResolvedValue({ status: 'ok', target: 'media' });
});

describe('GET /j/UserItems/{itemId}/UserData', () => {
    it("answers the item's user data", async () => {
        const res = await GET!(makeEvent('GET'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(DTO);
        // The full user, so a series reads back its access-scoped episode counts.
        expect(mockReadUserItemData).toHaveBeenCalledWith(
            fakeSql,
            ITEM_ID,
            expect.objectContaining({ userId: 'uid-alice' }),
        );
    });

    it('is a 404 for an inaccessible item, an unknown item and a non-UUID id', async () => {
        mockCheckMediaAccess.mockResolvedValueOnce(false);
        expect((await GET!(makeEvent('GET'))).status).toBe(404);
        mockReadUserItemData.mockResolvedValueOnce(null);
        expect((await GET!(makeEvent('GET'))).status).toBe(404);
        expect((await GET!(makeEvent('GET', undefined, 'nope'))).status).toBe(404);
    });
});

describe('POST /j/UserItems/{itemId}/UserData', () => {
    it('applies only the fields that are set, and answers the re-read dto', async () => {
        const res = await POST!(
            makeEvent('POST', {
                IsFavorite: true,
                Played: null,
                PlaybackPositionTicks: null,
                Rating: 8,
                Likes: true,
                PlayCount: 3,
            }),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(DTO);
        expect(mockSetJellyfinFavorite).toHaveBeenCalledWith(fakeSql, USER, ITEM_ID, true);
        expect(mockMarkWatched).not.toHaveBeenCalled();
        expect(mockMarkUnwatched).not.toHaveBeenCalled();
        expect(mockSetResumePosition).not.toHaveBeenCalled();
        // The existence guard reads the row alone (bare id: no access context,
        // no folder counts); the answer is read for the full user.
        expect(mockReadUserItemData.mock.calls[0][2]).toBe('uid-alice');
        expect(mockReadUserItemData.mock.calls[1][2]).toMatchObject({ userId: 'uid-alice' });
    });

    it('sets the resume point from PlaybackPositionTicks', async () => {
        await POST!(makeEvent('POST', { PlaybackPositionTicks: 600_000_000 }));
        expect(mockSetResumePosition).toHaveBeenCalledWith({
            userId: 'uid-alice',
            mediaId: ITEM_ID,
            positionMs: 60_000,
        });
        expect(mockSetJellyfinFavorite).not.toHaveBeenCalled();
    });

    it('Played=true marks watched and ignores a position in the same request', async () => {
        await POST!(makeEvent('POST', { Played: true, PlaybackPositionTicks: 600_000_000 }));
        expect(mockMarkWatched).toHaveBeenCalledWith({ userId: 'uid-alice', mediaId: ITEM_ID });
        expect(mockSetResumePosition).not.toHaveBeenCalled();
    });

    it('Played=false marks unwatched, then applies the position', async () => {
        await POST!(makeEvent('POST', { played: false, playbackPositionTicks: 0 }));
        expect(mockMarkUnwatched).toHaveBeenCalledWith({ userId: 'uid-alice', mediaId: ITEM_ID });
        expect(mockSetResumePosition).toHaveBeenCalledWith({
            userId: 'uid-alice',
            mediaId: ITEM_ID,
            positionMs: 0,
        });
    });

    it('skips Played and the position for a music item', async () => {
        mockGetMediaType.mockResolvedValue('track');
        const res = await POST!(makeEvent('POST', { Played: true, PlaybackPositionTicks: 10 }));
        expect(res.status).toBe(200);
        expect(mockMarkWatched).not.toHaveBeenCalled();
        expect(mockSetResumePosition).not.toHaveBeenCalled();
    });

    it('a favourite the item type cannot hold does not fail the request', async () => {
        mockSetJellyfinFavorite.mockResolvedValue({
            status: 'type_not_allowed',
            mediaType: 'episode',
        });
        const res = await POST!(makeEvent('POST', { IsFavorite: true }));
        expect(res.status).toBe(200);
    });

    it('refuses a body that is not JSON and writes nothing', async () => {
        const res = await POST!(makeEvent('POST', 'not json'));
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
        expect(mockSetJellyfinFavorite).not.toHaveBeenCalled();
    });

    it('writes nothing for an inaccessible or unknown item', async () => {
        mockCheckMediaAccess.mockResolvedValueOnce(false);
        expect((await POST!(makeEvent('POST', { IsFavorite: true }))).status).toBe(404);
        mockReadUserItemData.mockResolvedValueOnce(null);
        expect((await POST!(makeEvent('POST', { IsFavorite: true }))).status).toBe(404);
        expect(mockSetJellyfinFavorite).not.toHaveBeenCalled();
    });
});
