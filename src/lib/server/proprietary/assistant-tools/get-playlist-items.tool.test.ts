// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for `get_playlist_items`.
 *
 * The gap this tool closes: get_playlists returned {name, itemCount} and there
 * was no way to read the contents, so "what's on my Roadtrip playlist?" gave
 * the model a name, a count of 42, and a question about the 42 — the highest
 * confabulation risk on the whole tool surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import { getPlaylistItemsTool } from './get-playlist-items.tool.js';
import type { AssistantToolContext } from './types.js';

vi.mock('../../database/queries/playlists.queries.js', () => ({
    getOwnedPlaylists: vi.fn(),
    getSharedPlaylists: vi.fn(),
    getPlaylistItems: vi.fn(),
}));
vi.mock('../../utils/playlist-utils.js', () => ({ getUserRole: vi.fn() }));

import {
    getOwnedPlaylists,
    getSharedPlaylists,
    getPlaylistItems,
} from '../../database/queries/playlists.queries.js';
import { getUserRole } from '../../utils/playlist-utils.js';
import { assistantTestUser } from './test-context.js';

const userId = toUserId('00000000-0000-0000-0000-000000000001');
function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId,
        userIsAdmin: false,
        user: assistantTestUser(),
        writesAllowed: false,
        accessCtx: {
            username: 'alice',
            deniedGroupIds: ['g1'],
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
    };
}

describe('getPlaylistItemsTool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getSharedPlaylists).mockResolvedValue([]);
    });

    it('lists the titles on a playlist the user owns', async () => {
        vi.mocked(getOwnedPlaylists).mockResolvedValue([
            { id: 7, name: 'Roadtrip', playlist_type: 'music', item_count: 2, role: 'owner' },
        ] as never);
        vi.mocked(getUserRole).mockResolvedValue({ role: 'owner' } as never);
        vi.mocked(getPlaylistItems).mockResolvedValue([
            { title: 'Song A', media_type: 'track', artist: 'Band', position: 1 },
            { title: 'Haze', media_type: 'movie', position: 2 },
        ] as never);

        const result = await getPlaylistItemsTool.execute({ name: 'Roadtrip' }, makeCtx());
        const summary = JSON.parse(result.summaryForModel);

        expect(summary.found).toBe(true);
        expect(summary.playlist).toBe('Roadtrip');
        expect(summary.items.map((i: { title: string }) => i.title)).toEqual(['Song A', 'Haze']);
    });

    // The row filter is the viewer's, not the owner's — a shared playlist can
    // hold titles the viewer is not allowed to see.
    it('passes the caller access boundary to the item query', async () => {
        vi.mocked(getOwnedPlaylists).mockResolvedValue([
            { id: 7, name: 'Roadtrip', playlist_type: 'music', item_count: 0, role: 'owner' },
        ] as never);
        vi.mocked(getUserRole).mockResolvedValue({ role: 'owner' } as never);
        vi.mocked(getPlaylistItems).mockResolvedValue([]);

        await getPlaylistItemsTool.execute({ name: 'Roadtrip' }, makeCtx());

        expect(vi.mocked(getPlaylistItems).mock.calls[0][4]).toEqual({
            library: { kind: 'denyGroups', ids: ['g1'] },
            age: { kind: 'any' },
        });
    });

    it('does not read a playlist the user has no role on', async () => {
        vi.mocked(getOwnedPlaylists).mockResolvedValue([
            { id: 9, name: 'Someone Else', playlist_type: 'music', item_count: 3, role: 'owner' },
        ] as never);
        vi.mocked(getUserRole).mockResolvedValue({ role: null } as never);

        const result = await getPlaylistItemsTool.execute({ name: 'Someone Else' }, makeCtx());

        expect(JSON.parse(result.summaryForModel).found).toBe(false);
        expect(getPlaylistItems).not.toHaveBeenCalled();
    });

    it('refuses to pick when a partial name matches more than one playlist', async () => {
        // `.find()` returned the first substring hit and the model described
        // its contents as the requested playlist, with nothing in the payload
        // saying a choice had been made.
        vi.mocked(getOwnedPlaylists).mockResolvedValue([
            { id: 1, name: 'Chill Evening', playlist_type: 'music', item_count: 5, role: 'owner' },
            { id: 2, name: 'Chill Hard', playlist_type: 'music', item_count: 9, role: 'owner' },
        ] as never);

        const result = await getPlaylistItemsTool.execute({ name: 'Chill' }, makeCtx());
        const summary = JSON.parse(result.summaryForModel);

        expect(summary.found).toBe(false);
        expect(summary.candidatePlaylists).toEqual(['Chill Evening', 'Chill Hard']);
        expect(getPlaylistItems).not.toHaveBeenCalled();
    });

    it('still takes an exact name even when it is a prefix of another', async () => {
        vi.mocked(getOwnedPlaylists).mockResolvedValue([
            { id: 1, name: 'Chill', playlist_type: 'music', item_count: 5, role: 'owner' },
            { id: 2, name: 'Chill Hard', playlist_type: 'music', item_count: 9, role: 'owner' },
        ] as never);
        vi.mocked(getUserRole).mockResolvedValue({ role: 'owner' } as never);
        vi.mocked(getPlaylistItems).mockResolvedValue([]);

        const result = await getPlaylistItemsTool.execute({ name: 'Chill' }, makeCtx());

        expect(JSON.parse(result.summaryForModel).playlist).toBe('Chill');
    });

    it('names the playlists it can see when the requested one does not match', async () => {
        vi.mocked(getOwnedPlaylists).mockResolvedValue([
            { id: 7, name: 'Roadtrip', playlist_type: 'music', item_count: 2, role: 'owner' },
        ] as never);

        const result = await getPlaylistItemsTool.execute({ name: 'Nonexistent' }, makeCtx());
        const summary = JSON.parse(result.summaryForModel);

        expect(summary.found).toBe(false);
        expect(summary.availablePlaylists).toEqual(['Roadtrip']);
    });
});
