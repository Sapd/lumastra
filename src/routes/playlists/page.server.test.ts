// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    owned: [] as { id: number; role?: 'owner' | 'editor' | 'readonly' }[],
    shared: [] as { id: number; role?: 'owner' | 'editor' | 'readonly' }[],
    pending: [] as { id: number; role?: 'editor' | 'readonly'; invited_at?: string | Date }[],
}));
vi.mock('$lib/server/config', () => ({ features: { playlists: true } }));
vi.mock('$lib/server/database/connection', () => ({ getDb: () => async () => state.pending }));
vi.mock('$lib/server/utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: () => 'tmdb',
}));
vi.mock('$lib/server/database/queries/playlists.queries.js', () => ({
    getOwnedPlaylists: async () => state.owned,
    getSharedPlaylists: async () => state.shared,
}));
vi.mock('$lib/server/database/queries/watchlist-playlist.queries.js', () => ({
    ensureWatchlistPlaylist: async () => 1,
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: async () => ({}),
    searchAccessBoundary: () => ({ library: { kind: 'all' }, age: { kind: 'any' } }),
}));
vi.mock('$lib/server/database/queries/builders/library-access.builder.js', () => ({
    buildLibraryAccessFilter: () => '',
}));
vi.mock('$lib/server/database/queries/builders/age-rating.builder.js', () => ({
    buildSeriesOwnedAgeRatingFilter: () => '',
}));
vi.mock('$lib/server/utils/playlist-transforms.js', () => ({
    playlistsWithImages: vi.fn(
        async (_sql: unknown, entries: { row: { id: number }; role: string }[]) =>
            entries.map(({ row, role }) => ({ id: row.id, role })),
    ),
}));
import { load } from './+page.server';
import { playlistsWithImages } from '$lib/server/utils/playlist-transforms.js';

const event = {
    locals: { user: { username: 'fixture', userId: '00000000-0000-4000-8000-000000000001' } },
} as Parameters<typeof load>[0];
beforeEach(() => {
    state.owned = [];
    state.shared = [];
    state.pending = [];
    vi.clearAllMocks();
});

it('preserves owned/shared/invite partitions, roles and invite timestamps', async () => {
    state.owned = [{ id: 1 }, { id: 2 }];
    state.shared = [{ id: 3, role: 'editor' }, { id: 4 }];
    state.pending = [
        { id: 5, role: 'editor', invited_at: new Date('2026-01-01T00:00:00.000Z') },
        { id: 6, invited_at: '2026-01-02' },
    ];
    expect(await load(event)).toEqual({
        owned: [
            { id: 1, role: 'owner' },
            { id: 2, role: 'owner' },
        ],
        shared: [
            { id: 3, role: 'editor' },
            { id: 4, role: 'readonly' },
        ],
        pendingInvites: [
            { id: 5, role: 'editor', invitedAt: '2026-01-01T00:00:00.000Z' },
            { id: 6, role: 'readonly', invitedAt: '2026-01-02' },
        ],
        username: 'fixture',
    });
    expect(playlistsWithImages).toHaveBeenCalledTimes(1);
});

it('keeps invites when preceding partitions are empty', async () => {
    state.pending = [{ id: 7 }];
    expect(await load(event)).toEqual({
        owned: [],
        shared: [],
        pendingInvites: [{ id: 7, role: 'readonly', invitedAt: '' }],
        username: 'fixture',
    });
});
