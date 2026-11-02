// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pins the loader → Playlist conversion (`buildTypedPlaylist`) used by
 * `[id]/+page.svelte` before handing the result to `PlaylistHeader`. This is
 * one half of the wiring Task 8's review found missing: the component-level
 * `PlaylistHeader.svelte.test.ts` proves the header reacts correctly to
 * `isSystem`, but does so with a hand-built prop that never touches this
 * conversion. See `page.server.test.ts` (in this same directory) for the
 * other half — the loader's own returned shape.
 */

import { describe, expect, it } from 'vitest';
import { buildTypedPlaylist, type ServerPlaylist } from './playlist-detail-transform';

function makeServerPlaylist(overrides: Partial<ServerPlaylist>): ServerPlaylist {
    return {
        id: 1,
        owner: { userId: 'owner', displayName: 'Denis', images: { primary: { href: '/avatar', revision: '0', source: 'self' } } },
        revision: 4,
        memberCount: 0,
        itemCount: 0,
        isSystem: false,
        name: 'Watchlist',
        description: null,
        visibility: 'private',
        playlistType: 'watchlist',
        images: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        role: 'owner',
        ...overrides,
    };
}

describe('buildTypedPlaylist', () => {
    it('carries isSystem through into the Playlist shape PlaylistHeader consumes', () => {
        const sp = makeServerPlaylist({ isSystem: true });
        const result = buildTypedPlaylist(sp, 0);
        expect(result.isSystem).toBe(true);
    });

    it('does not fabricate isSystem for a regular playlist', () => {
        const sp = makeServerPlaylist({ isSystem: false, playlistType: 'general' });
        const result = buildTypedPlaylist(sp, 0);
        expect(result.isSystem).toBe(false);
    });

    it('preserves the API owner and revision for readonly viewers', () => {
        const sp = makeServerPlaylist({ role: 'readonly' });
        const result = buildTypedPlaylist(sp, 0);
        expect(result.role).toBe('readonly');
        expect(result.revision).toBe(4);
        expect(result.owner).toEqual(sp.owner);
    });
});
