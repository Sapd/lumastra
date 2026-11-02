// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `get_playlists` assistant tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPlaylistsTool } from './get-playlists.tool.js';
import type { AssistantToolContext } from './types.js';
import type { PlaylistRow } from '../../database/queries/playlists.queries.js';
import { toUserId } from '$lib/shared/user-id.js';

const TEST_USER_ID = toUserId('00000000-0000-0000-0000-000000000001');

vi.mock('../../database/queries/playlists.queries.js', () => ({
    getOwnedPlaylists: vi.fn(),
    getSharedPlaylists: vi.fn(),
}));

import { getOwnedPlaylists, getSharedPlaylists } from '../../database/queries/playlists.queries.js';
import { assistantTestUser } from './test-context.js';

function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId: TEST_USER_ID,
        userIsAdmin: false,
        user: assistantTestUser(),
        writesAllowed: false,
        accessCtx: {
            username: 'alice',
            deniedGroupIds: null,
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
    };
}

const own = {
    name: 'My Faves',
    playlist_type: 'video',
    visibility: 'private',
    item_count: 12,
    role: 'owner',
} as unknown as PlaylistRow;

const shared = {
    name: 'Movie Night',
    playlist_type: 'video',
    visibility: 'shared',
    item_count: 5,
    role: 'editor',
} as unknown as PlaylistRow;

describe('getPlaylistsTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('combines owned and invited (shared) playlists', async () => {
        vi.mocked(getOwnedPlaylists).mockResolvedValue([own]);
        vi.mocked(getSharedPlaylists).mockResolvedValue([shared]);

        const result = await getPlaylistsTool.execute({}, makeCtx());
        const summary = JSON.parse(result.summaryForModel);

        // `count` → `returnedCount` + an always-present page marker (see
        // result-counts.ts): a bare `count` beside a list kept being relayed as
        // a library total ("wir haben 10 Filme") no matter what the prompt said.
        expect(summary.returnedCount).toBe(2);
        expect(summary.playlists.map((p: { name: string }) => p.name)).toEqual([
            'My Faves',
            'Movie Night',
        ]);
        expect(summary.playlists[0].role).toBe('owner');
        expect(summary.playlists[1].role).toBe('editor');
        expect(result.media).toBeUndefined();
    });

    it('queries playlists for the calling user only', async () => {
        vi.mocked(getOwnedPlaylists).mockResolvedValue([]);
        vi.mocked(getSharedPlaylists).mockResolvedValue([]);
        await getPlaylistsTool.execute({}, makeCtx());
        expect(vi.mocked(getOwnedPlaylists).mock.calls[0][1]).toBe(TEST_USER_ID);
        expect(vi.mocked(getSharedPlaylists).mock.calls[0][1]).toBe(TEST_USER_ID);
    });
});
