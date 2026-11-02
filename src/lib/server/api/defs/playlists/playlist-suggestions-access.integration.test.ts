// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import { getTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../../tests/integration/helpers/users.js';
import { toUserId } from '$lib/shared/user-id.js';

// Keep the handler and authorization SQL real; stub only the recommendation
// work after the gate so a denied invitee must never reach either algorithm.
const recommendations = vi.hoisted(() => ({
    metadata: vi.fn(async () => []),
    sonic: vi.fn(async () => []),
    coverage: vi.fn(async () => 0),
}));
vi.mock('$lib/server/services/database.service.js', async () => {
    const { getTestDb: getSql } =
        await import('../../../../../../tests/integration/setup/test-database.js');
    return { aiDbService: { getSql: async () => getSql() } };
});
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getPlaylistSuggestionsFull: recommendations.metadata,
    getPlaylistSuggestionsViaSonic: recommendations.sonic,
    countPlaylistSonicEmbeddings: recommendations.coverage,
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(async () => ({})),
    searchAccessBoundary: vi.fn(() => ({})),
}));
vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    filterAccessibleRows: vi.fn(async () => []),
}));

const { def } = await import('./[id]/suggestions.js');

function eventFor(playlistId: number, user: { id: string; username: string }): RequestEvent {
    const url = new URL(`http://localhost/playlists/${playlistId}/suggestions`);
    return {
        params: { id: String(playlistId) },
        url,
        request: new Request(url),
        locals: {
            user: {
                userId: toUserId(user.id),
                username: user.username,
                groups: '',
                userGroups: [],
                hasWatchPermission: true,
                hasLiveTvPermission: false,
                hasRequestPermission: false,
                ownerIsAdmin: false,
                isModerator: false,
                maxAgeRating: null,
                isAgeRestricted: false,
                liveTvPriority: 'low',
            },
        },
    } as unknown as RequestEvent;
}

async function fixture(visibility: 'private' | 'public' = 'private'): Promise<{
    owner: { id: string; username: string };
    viewer: { id: string; username: string };
    playlistId: number;
}> {
    const sql = getTestDb();
    const owner = await createTestUser(sql);
    const viewer = await createTestUser(sql);
    const [{ id: playlistId }] = await sql<{ id: number }[]>`
        INSERT INTO playlists (user_id, name, visibility, playlist_type)
        VALUES (${owner.id}::uuid, 'Suggestions access test', ${visibility}, 'general')
        RETURNING id
    `;
    return { owner, viewer, playlistId };
}

describe.each(['internal', 'v1'] as const)(
    'playlist suggestions access (%s surface)',
    (surface) => {
        const ctx: ApiContext = { surface };
        beforeEach(() => vi.clearAllMocks());

        it('returns 404 for a pending private invitee before computing recommendations', async () => {
            const { viewer, playlistId } = await fixture();
            const sql = getTestDb();
            await sql`
            INSERT INTO playlist_members (playlist_id, user_id, role, status)
            VALUES (${playlistId}, ${viewer.id}::uuid, 'editor', 'pending')
        `;
            const response = await def.handlers.GET!(eventFor(playlistId, viewer), ctx);
            expect(response.status).toBe(404);
            expect(recommendations.metadata).not.toHaveBeenCalled();
            expect(recommendations.sonic).not.toHaveBeenCalled();
            expect(recommendations.coverage).not.toHaveBeenCalled();
        });

        it('allows the private playlist owner', async () => {
            const { owner, playlistId } = await fixture();
            const response = await def.handlers.GET!(eventFor(playlistId, owner), ctx);
            expect(response.status).toBe(200);
            expect(recommendations.metadata).toHaveBeenCalledOnce();
        });

        it.each(['editor', 'readonly'])('allows an accepted private %s member', async (role) => {
            const { viewer, playlistId } = await fixture();
            const sql = getTestDb();
            await sql`
            INSERT INTO playlist_members (playlist_id, user_id, role, status)
            VALUES (${playlistId}, ${viewer.id}::uuid, ${role}, 'accepted')
        `;
            const response = await def.handlers.GET!(eventFor(playlistId, viewer), ctx);
            expect(response.status).toBe(200);
            expect(recommendations.metadata).toHaveBeenCalledOnce();
        });

        it('allows an unrelated authenticated public viewer', async () => {
            const { viewer, playlistId } = await fixture('public');
            const response = await def.handlers.GET!(eventFor(playlistId, viewer), ctx);
            expect(response.status).toBe(200);
            expect(recommendations.metadata).toHaveBeenCalledOnce();
        });

        it('returns 404 for an unrelated private viewer', async () => {
            const { viewer, playlistId } = await fixture();
            const response = await def.handlers.GET!(eventFor(playlistId, viewer), ctx);
            expect(response.status).toBe(404);
            expect(recommendations.metadata).not.toHaveBeenCalled();
        });
    },
);
