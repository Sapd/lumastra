// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pins the playlist-detail SSR loader's returned shape: it must surface
 * `isSystem` on `data.playlist`, because `PlaylistHeader`'s isSystem guard
 * (Task 8) is worthless if the loader never puts the field on the page.
 *
 * Task 8's review found this loader builds its own object literal rather
 * than going through `transformPlaylistRow` (the function an earlier task
 * fixed to emit `isSystem`), so it silently dropped the field even though
 * `getPlaylistById` already selects `is_system`. This test would have
 * caught that: it mocks every dependency the loader touches and asserts on
 * the ACTUAL returned object, so removing the `isSystem` line from
 * `+page.server.ts` fails it (see task-8-report.md for the RED/GREEN
 * demonstration).
 */

import { describe, expect, it, vi } from 'vitest';
vi.mock('$lib/server/services/image-descriptor/avatars.js', async () => {
    const { userAvatarSet } = await import('$lib/server/services/image-descriptor/resolver.js');
    return {
        userImageSets: async (_sql: unknown, surface: 'internal' | 'v1', ids: string[]) =>
            new Map(
                ids.map((userId) => [userId, userAvatarSet(surface, { userId, version: '0' })]),
            ),
    };
});

const {
    getPlaylistById,
    getPlaylistItems,
    getPlaylistMembers,
    getEffectiveCollapsedGroups,
    getDeniedLibraryGroups,
    toLibraryAccessUser,
    restrictedAccess,
} = vi.hoisted(() => ({
    getPlaylistById: vi.fn(),
    getPlaylistItems: vi.fn(),
    getPlaylistMembers: vi.fn(),
    getEffectiveCollapsedGroups: vi.fn(),
    getDeniedLibraryGroups: vi.fn(),
    toLibraryAccessUser: vi.fn(),
    restrictedAccess: vi.fn(),
}));

vi.mock('$lib/server/database/connection', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/config', () => ({
    features: { playlists: true, playlistChat: false },
    config: { UNRATED_CONTENT_VISIBLE: true },
}));
vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));
vi.mock('$lib/server/database/queries/playlists.queries.js', () => ({
    getPlaylistById,
    getPlaylistItems,
    getPlaylistMembers,
    getEffectiveCollapsedGroups,
}));
vi.mock('$lib/server/cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups,
    toLibraryAccessUser,
}));
vi.mock('$lib/server/database/queries/builders/media-access-boundary.js', () => ({
    restrictedAccess,
}));

vi.mock('$lib/server/utils/public-author.js', () => ({
    authorOrPlaceholder: (authors: Map<string, unknown>, userId: string) =>
        authors.get(userId) ?? {
            userId,
            displayName: null,
            images: { primary: { href: `/avatar/${userId}`, revision: '0', source: 'self' } },
        },
    loadPublicAuthors: async () => new Map(),
    toPublicAuthor: ({ userId, displayName }: { userId: string; displayName: string | null }) => ({
        userId,
        displayName,
        images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
    }),
}));

const { load } = await import('./+page.server.js');
const { PLAYLIST_DETAIL_DEPENDENCY } = await import('./playlist-detail-transform.js');

function makePlaylistRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        revision: 0,
        item_count: 0,
        member_count: 0,
        user_id: 'user-1',
        owner_username: 'denis',
        name: 'Watchlist',
        description: null,
        visibility: 'private',
        playlist_type: 'watchlist',
        is_system: true,
        cover_image: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

describe('playlist detail loader — isSystem wiring', () => {
    it('surfaces isSystem: true for the watchlist so PlaylistHeader can hide its controls', async () => {
        getPlaylistById.mockResolvedValue(makePlaylistRow({ is_system: true }));
        getPlaylistItems.mockResolvedValue([]);
        getPlaylistMembers.mockResolvedValue([]);
        getEffectiveCollapsedGroups.mockResolvedValue([]);
        getDeniedLibraryGroups.mockResolvedValue([]);
        toLibraryAccessUser.mockReturnValue({});
        restrictedAccess.mockReturnValue({});

        const depends = vi.fn();
        const result = (await load({
            locals: { user: { userId: 'user-1', username: 'denis' } },
            params: { id: '1' },
            depends,
        } as never)) as { playlist: { isSystem?: boolean } };

        expect(result.playlist.isSystem).toBe(true);
        // The page re-runs this load when the watchlist changes from a modal.
        expect(depends).toHaveBeenCalledWith(PLAYLIST_DETAIL_DEPENDENCY);
    });

    it('surfaces isSystem: false for a regular playlist', async () => {
        getPlaylistById.mockResolvedValue(
            makePlaylistRow({ is_system: false, playlist_type: 'general' }),
        );
        getPlaylistItems.mockResolvedValue([]);
        getPlaylistMembers.mockResolvedValue([]);
        getEffectiveCollapsedGroups.mockResolvedValue([]);
        getDeniedLibraryGroups.mockResolvedValue([]);
        toLibraryAccessUser.mockReturnValue({});
        restrictedAccess.mockReturnValue({});

        const result = (await load({
            locals: { user: { userId: 'user-1', username: 'denis' } },
            params: { id: '1' },
            depends: vi.fn(),
        } as never)) as { playlist: { isSystem?: boolean } };

        expect(result.playlist.isSystem).toBe(false);
    });
});
