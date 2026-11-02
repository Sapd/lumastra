// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/playlists/[id]/items/index.ts — GET keyset conversion.
 *
 * All DB I/O is mocked. Verifies:
 *   • offset mode stays byte-identical (page = {limit, offset, hasMore, total})
 *     plus a Gate J1 bootstrap cursor when hasMore;
 *   • cursor mode routes to the query's cursor page, ignores offset, drops
 *     total, keeps items/hasMore/limit, and emits page.nextCursor on n+1 lookahead;
 *   • the encode→decode round-trip carries (position, id) as exact integers;
 *   • a malformed cursor and a cross-feed ('ma:') cursor both 422.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));

vi.mock('$lib/server/dev-user.js', () => ({ getEffectiveUser: () => 'tester' }));

// METADATA_ADDITIONAL_LANGUAGES is REQUIRED in this mock, not optional detail:
// the GET handler runs overlayItemTitles on both pagination branches and that
// function reads `.length` off it before any other gate, so omitting it makes
// every non-422 case throw before it can assert on paging.
vi.mock('$lib/server/config.js', () => ({
    // Module-level flag read through the playlist import chain (task queues).
    FEATURE_PER_TASK_QUEUES: true,
    config: { UNRATED_CONTENT_VISIBLE: true, METADATA_ADDITIONAL_LANGUAGES: [] },
}));

const mockGetUserRole = vi.fn();
vi.mock('$lib/server/utils/playlist-utils.js', () => ({
    getUserRole: (...a: unknown[]) => mockGetUserRole(...a),
    canEdit: () => true,
    getPlaylistContext: vi.fn(),
}));

const mockGetPlaylistItems = vi.fn();
const mockGetPlaylistType = vi.fn();
vi.mock('$lib/server/database/queries/playlists.queries.js', () => ({
    getPlaylistItems: (...a: unknown[]) => mockGetPlaylistItems(...a),
    getPlaylistType: (...a: unknown[]) => mockGetPlaylistType(...a),
    getPlaylistSummary: vi.fn(),
    resolveEpisodeContext: vi.fn(),
}));

vi.mock('$lib/server/cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups: vi.fn().mockResolvedValue([]),
    toLibraryAccessUser: vi.fn().mockReturnValue({}),
}));

vi.mock('$lib/server/utils/playlist-transforms.js', () => ({
    transformPlaylistItemRow: (row: Record<string, unknown>) => row,
}));

vi.mock('$lib/server/services/playlist-item-manager.service.js', () => ({
    playlistItemManager: { addItems: vi.fn() },
}));

// The def maps legacy Jellyfin ids before gating; the real module pulls the
// catalog service and the task registry, which this test's config mock lacks.
vi.mock('$lib/server/utils/media-resolution.js', () => ({
    mapLegacyJellyfinExternalIds: async (_sql: unknown, ids: unknown) => ids,
}));
vi.mock('$lib/server/utils/resolve-and-gate.js', () => ({
    resolveAndGate: vi.fn(),
    MediaAccessDeniedError: class extends Error {},
    MediaNotResolvableError: class extends Error {},
}));

const { def } = await import('./[id]/items/index.js');

const ctx: ApiContext = { surface: 'internal' };

function item(id: number, position: number): Record<string, unknown> {
    return { id, position, title: `item-${id}`, media_id: `m-${id}` };
}

function getEvent(search = ''): RequestEvent {
    return {
        request: new Request(`http://localhost/api/playlists/7/items${search}`),
        url: new URL(`http://localhost/api/playlists/7/items${search}`),
        params: { id: '7' },
        locals: { user: { userId: 'user-uuid', maxAgeRating: null } },
    } as unknown as RequestEvent;
}

async function body(res: Response): Promise<{ items: unknown[]; page: Record<string, unknown> }> {
    return (await res.json()) as { items: unknown[]; page: Record<string, unknown> };
}

describe('defs/playlists/[id]/items (keyset)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUserRole.mockResolvedValue({ role: 'owner', visibility: 'private' });
        mockGetPlaylistType.mockResolvedValue(null);
        mockGetPlaylistItems.mockResolvedValue([]);
    });

    it('no cursor → query receives offset mode with availability filtering', async () => {
        await def.handlers.GET!(getEvent('?limit=10&offset=5'), ctx);
        expect(mockGetPlaylistItems).toHaveBeenCalledTimes(1);
        expect(mockGetPlaylistItems.mock.calls[0][5]).toEqual({
            mode: 'offset',
            availableOnly: true,
        });
    });

    it('offset mode stays byte-identical (keeps total; no cursor when no next page)', async () => {
        mockGetPlaylistItems.mockResolvedValue([item(1, 0)]);
        const b = await body(await def.handlers.GET!(getEvent('?limit=10&offset=0'), ctx));
        expect(b.items).toHaveLength(1);
        expect(b.page).toEqual({ limit: 10, offset: 0, hasMore: false, total: 1 });
        expect(b.page).not.toHaveProperty('cursor');
    });

    it('offset mode emits J1 bootstrap cursor when hasMore', async () => {
        mockGetPlaylistItems.mockResolvedValue([item(1, 0), item(2, 1)]);
        const b = await body(await def.handlers.GET!(getEvent('?limit=1&offset=0'), ctx));
        expect(b.page.hasMore).toBe(true);
        expect(b.page.total).toBe(2);
        expect(typeof b.page.nextCursor).toBe('string');
    });

    it('cursor param → cursor mode, offset ignored, total dropped, exact (position,id)', async () => {
        mockGetPlaylistItems.mockResolvedValueOnce([item(10, 3), item(11, 4)]);
        const boot = await body(await def.handlers.GET!(getEvent('?limit=1'), ctx));
        const cursor = boot.page.nextCursor as string;
        expect(cursor).toBeTruthy();

        mockGetPlaylistItems.mockResolvedValueOnce([item(11, 4)]);
        const b = await body(
            await def.handlers.GET!(
                getEvent(`?limit=5&offset=999&cursor=${encodeURIComponent(cursor)}`),
                ctx,
            ),
        );
        // Last offset row was id=10, position=3 → decoded cursor carries them as text.
        expect(mockGetPlaylistItems.mock.calls[1][5]).toEqual({
            mode: 'cursor',
            availableOnly: true,
            cursor: { position: '3', id: '10' },
            limit: 5,
        });
        expect(b.page).not.toHaveProperty('total');
        expect(b.page).not.toHaveProperty('offset');
        expect(b.page.limit).toBe(5);
    });

    it('cursor mode: hasMore from n+1 lookahead + emits next cursor', async () => {
        mockGetPlaylistItems.mockResolvedValueOnce([item(10, 3), item(11, 4)]);
        const boot = await body(await def.handlers.GET!(getEvent('?limit=1'), ctx));
        const cursor = boot.page.nextCursor as string;

        mockGetPlaylistItems.mockResolvedValueOnce([item(11, 4), item(12, 5)]);
        const b = await body(
            await def.handlers.GET!(getEvent(`?limit=1&cursor=${encodeURIComponent(cursor)}`), ctx),
        );
        expect(b.items).toHaveLength(1);
        expect(b.page.hasMore).toBe(true);
        expect(typeof b.page.nextCursor).toBe('string');
    });

    it('malformed cursor → 422', async () => {
        const res = await def.handlers.GET!(getEvent('?cursor=garbage'), ctx);
        expect(res.status).toBe(422);
        expect(mockGetPlaylistItems).not.toHaveBeenCalled();
    });

    it('cross-feed cursor (members ma: tag) → 422, never decoded here', async () => {
        const foreign =
            'ma:' + Buffer.from('2026-07-20T00:00:00Z:abc', 'utf-8').toString('base64url');
        const res = await def.handlers.GET!(
            getEvent(`?cursor=${encodeURIComponent(foreign)}`),
            ctx,
        );
        expect(res.status).toBe(422);
        expect(mockGetPlaylistItems).not.toHaveBeenCalled();
    });
});
