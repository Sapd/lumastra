// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression tests — resource-level authorisation on comment / reaction endpoints.
 *
 * Security invariants verified:
 *   1. Non-member GET  /playlists/{id}/comments  → 404 (private playlist IDOR)
 *   2. Non-member POST /playlists/{id}/comments  → 404
 *   3. Non-member GET  /playlists/{id}/reactions → 404
 *   4. Non-member PUT /playlists/{id}/reactions → 404
 *   5. Non-member DELETE /playlists/{id}/reactions → 404
 *   6. Member (any role) GET/POST comments → 200/201
 *   7. Public playlist non-member → allowed (role='readonly' from getUserRole)
 *   8. Media comment GET with access denied → 404
 *   9. Media reaction GET with access denied → 404
 *  10. Media comment GET with access granted → 200
 *
 * All external I/O is mocked — no real DB required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

// ── Module mocks (must be hoisted before any imports that need them) ──────────

vi.mock('$lib/server/utils/public-author.js', () => ({
    authorOrPlaceholder: (authors: Map<string, unknown>, userId: string) =>
        authors.get(userId) ?? {
            userId,
            displayName: null,
            images: { primary: { href: `/avatar/${userId}`, revision: '0', source: 'self' } },
        },
    loadPublicAuthors: async (ids: string[]) =>
        new Map(
            ids.map((userId) => [
                userId,
                {
                    userId,
                    displayName: null,
                    images: {
                        primary: { href: `/avatar/${userId}`, revision: '0', source: 'self' },
                    },
                },
            ]),
        ),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockSql,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

// getUserIdByUsername — used by POST/DELETE handlers to resolve userId.
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: vi.fn().mockResolvedValue('user-uuid-123'),
}));

// getUserRole — controls the playlist membership gate.
const mockGetUserRole = vi.fn();
vi.mock('$lib/server/utils/playlist-utils.js', () => ({
    getUserRole: (...args: unknown[]) => mockGetUserRole(...args),
}));

// checkMediaAccess — controls the media library/age gate.
const mockCheckMediaAccess = vi.fn();
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

// Interaction queries — stub happy-path returns so handler logic runs through.
const mockListComments = vi.fn().mockResolvedValue([]);
const mockInsertComment = vi.fn().mockResolvedValue({
    id: 'comment-1',
    user_id: 'user-uuid-123',
    username: 'alice',
    body: 'hello',
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
});
const mockListReactions = vi.fn().mockResolvedValue([]);
const mockUpsertReaction = vi.fn().mockResolvedValue(undefined);
const mockDeleteReaction = vi.fn().mockResolvedValue(undefined);

vi.mock('$lib/server/database/queries/interactions.queries.js', () => ({
    listComments: (...args: unknown[]) => mockListComments(...args),
    insertComment: (...args: unknown[]) => mockInsertComment(...args),
    getCommentOwner: vi.fn(),
    softDeleteComment: vi.fn(),
    listReactions: (...args: unknown[]) => mockListReactions(...args),
    upsertReaction: (...args: unknown[]) => mockUpsertReaction(...args),
    deleteReaction: (...args: unknown[]) => mockDeleteReaction(...args),
}));

// ── Shared mock sql stub ──────────────────────────────────────────────────────

const mockSql = {};

// ── Import defs AFTER mocks ───────────────────────────────────────────────────

const { def: playlistCommentsDef } =
    await import('$lib/server/api/defs/playlists/[id]/comments/index.js');
const { def: playlistReactionsDef } =
    await import('$lib/server/api/defs/playlists/[id]/reactions/index.js');
const { def: mediaCommentsDef } = await import('$lib/server/api/defs/media/[id]/comments/index.js');
const { def: mediaReactionsDef } =
    await import('$lib/server/api/defs/media/[id]/reactions/index.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const PLAYLIST_ID = '42';
const MEDIA_UUID = '550e8400-e29b-41d4-a716-446655440000';

function makeEvent(
    method: string,
    url: string,
    params: Record<string, string>,
    body?: unknown,
    username = 'alice',
): Partial<RequestEvent> {
    return {
        request: new Request(url, {
            method,
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        }),
        url: new URL(url),
        params,
        locals: {
            principal: { username, isAdmin: false },
            user: { username, isAdmin: false },
        } as unknown as RequestEvent['locals'],
    };
}

function makePlaylistEvent(method: string, body?: unknown): Partial<RequestEvent> {
    const url = `http://localhost/api/v1/playlists/${PLAYLIST_ID}/comments`;
    return makeEvent(method, url, { id: PLAYLIST_ID }, body);
}

function makePlaylistReactionEvent(method: string, body?: unknown): Partial<RequestEvent> {
    const url = `http://localhost/api/v1/playlists/${PLAYLIST_ID}/reactions`;
    return makeEvent(method, url, { id: PLAYLIST_ID }, body);
}

function makeMediaCommentEvent(method: string, body?: unknown): Partial<RequestEvent> {
    const url = `http://localhost/api/v1/media/${MEDIA_UUID}/comments`;
    return makeEvent(method, url, { id: MEDIA_UUID }, body);
}

function makeMediaReactionEvent(method: string, body?: unknown): Partial<RequestEvent> {
    const url = `http://localhost/api/v1/media/${MEDIA_UUID}/reactions`;
    return makeEvent(method, url, { id: MEDIA_UUID }, body);
}

const ctx: ApiContext = {
    surface: 'v1',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('playlist comments — resource-level access gate (IDOR regression)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: member with full access
        mockGetUserRole.mockResolvedValue({ role: 'editor', visibility: 'private' });
        mockListComments.mockResolvedValue([]);
        mockInsertComment.mockResolvedValue({
            id: 'comment-1',
            user_id: 'user-uuid-123',
            username: 'alice',
            body: 'hello',
            created_at: new Date('2026-01-01'),
            updated_at: new Date('2026-01-01'),
        });
    });

    it('non-member GET /playlists/{id}/comments → 404 (private IDOR blocked)', async () => {
        mockGetUserRole.mockResolvedValue({ role: null });

        const event = makePlaylistEvent('GET');
        const res = await playlistCommentsDef.handlers.GET!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(404);
    });

    it('non-member POST /playlists/{id}/comments → 404', async () => {
        mockGetUserRole.mockResolvedValue({ role: null });

        const event = makePlaylistEvent('POST', { body: 'hello' });
        const res = await playlistCommentsDef.handlers.POST!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(404);
    });

    it('non-member does NOT see comment data (listComments never called)', async () => {
        mockGetUserRole.mockResolvedValue({ role: null });

        const event = makePlaylistEvent('GET');
        await playlistCommentsDef.handlers.GET!(event as RequestEvent, ctx);

        expect(mockListComments).not.toHaveBeenCalled();
    });

    it('non-member does NOT insert comment (insertComment never called)', async () => {
        mockGetUserRole.mockResolvedValue({ role: null });

        const event = makePlaylistEvent('POST', { body: 'hello' });
        await playlistCommentsDef.handlers.POST!(event as RequestEvent, ctx);

        expect(mockInsertComment).not.toHaveBeenCalled();
    });

    it('member (editor) GET /playlists/{id}/comments → 200', async () => {
        mockGetUserRole.mockResolvedValue({ role: 'editor', visibility: 'private' });

        const event = makePlaylistEvent('GET');
        const res = await playlistCommentsDef.handlers.GET!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(200);
    });

    it('member (readonly) POST /playlists/{id}/comments → 201 (any member may post)', async () => {
        mockGetUserRole.mockResolvedValue({ role: 'readonly', visibility: 'private' });

        const event = makePlaylistEvent('POST', { body: 'hello' });
        const res = await playlistCommentsDef.handlers.POST!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(201);
    });

    it('public playlist non-member GET → allowed (getUserRole returns readonly)', async () => {
        // getUserRole returns 'readonly' for public playlists with no membership
        mockGetUserRole.mockResolvedValue({ role: 'readonly', visibility: 'public' });

        const event = makePlaylistEvent('GET');
        const res = await playlistCommentsDef.handlers.GET!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(200);
    });
});

describe('playlist reactions — resource-level access gate (IDOR regression)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetUserRole.mockResolvedValue({ role: 'editor', visibility: 'private' });
        mockListReactions.mockResolvedValue([]);
        mockUpsertReaction.mockResolvedValue(undefined);
        mockDeleteReaction.mockResolvedValue(undefined);
    });

    it('non-member GET /playlists/{id}/reactions → 404', async () => {
        mockGetUserRole.mockResolvedValue({ role: null });

        const event = makePlaylistReactionEvent('GET');
        const res = await playlistReactionsDef.handlers.GET!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(404);
    });

    it('non-member PUT /playlists/{id}/reactions → 404', async () => {
        mockGetUserRole.mockResolvedValue({ role: null });

        const event = makePlaylistReactionEvent('PUT', { emoji: '👍' });
        const res = await playlistReactionsDef.handlers.PUT!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(404);
    });

    it('non-member DELETE /playlists/{id}/reactions → 404', async () => {
        mockGetUserRole.mockResolvedValue({ role: null });

        const event = makePlaylistReactionEvent('DELETE', { emoji: '👍' });
        const res = await playlistReactionsDef.handlers.DELETE!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(404);
    });

    it('non-member does NOT see reaction data (listReactions never called)', async () => {
        mockGetUserRole.mockResolvedValue({ role: null });

        const event = makePlaylistReactionEvent('GET');
        await playlistReactionsDef.handlers.GET!(event as RequestEvent, ctx);

        expect(mockListReactions).not.toHaveBeenCalled();
    });

    it('member GET /playlists/{id}/reactions → 200', async () => {
        mockGetUserRole.mockResolvedValue({ role: 'editor', visibility: 'private' });

        const event = makePlaylistReactionEvent('GET');
        const res = await playlistReactionsDef.handlers.GET!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(200);
    });
});

describe('media comments — resource-level access gate (library/age gate)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCheckMediaAccess.mockResolvedValue(true);
        mockListComments.mockResolvedValue([]);
        mockInsertComment.mockResolvedValue({
            id: 'comment-2',
            user_id: 'user-uuid-123',
            username: 'alice',
            body: 'great film',
            created_at: new Date('2026-01-01'),
            updated_at: new Date('2026-01-01'),
        });
    });

    it('denied media GET /media/{id}/comments → 404', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);

        const event = makeMediaCommentEvent('GET');
        const res = await mediaCommentsDef.handlers.GET!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(404);
    });

    it('denied media POST /media/{id}/comments → 404', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);

        const event = makeMediaCommentEvent('POST', { body: 'great film' });
        const res = await mediaCommentsDef.handlers.POST!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(404);
    });

    it('denied media: listComments never called', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);

        const event = makeMediaCommentEvent('GET');
        await mediaCommentsDef.handlers.GET!(event as RequestEvent, ctx);

        expect(mockListComments).not.toHaveBeenCalled();
    });

    it('allowed media GET /media/{id}/comments → 200', async () => {
        mockCheckMediaAccess.mockResolvedValue(true);

        const event = makeMediaCommentEvent('GET');
        const res = await mediaCommentsDef.handlers.GET!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(200);
    });

    it('allowed media POST /media/{id}/comments → 201', async () => {
        mockCheckMediaAccess.mockResolvedValue(true);

        const event = makeMediaCommentEvent('POST', { body: 'great film' });
        const res = await mediaCommentsDef.handlers.POST!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(201);
    });
});

describe('media reactions — resource-level access gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCheckMediaAccess.mockResolvedValue(true);
        mockListReactions.mockResolvedValue([]);
        mockUpsertReaction.mockResolvedValue(undefined);
    });

    it('denied media GET /media/{id}/reactions → 404', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);

        const event = makeMediaReactionEvent('GET');
        const res = await mediaReactionsDef.handlers.GET!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(404);
    });

    it('denied media PUT /media/{id}/reactions → 404', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);

        const event = makeMediaReactionEvent('PUT', { emoji: '🎬' });
        const res = await mediaReactionsDef.handlers.PUT!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(404);
    });

    it('allowed media GET /media/{id}/reactions → 200', async () => {
        mockCheckMediaAccess.mockResolvedValue(true);

        const event = makeMediaReactionEvent('GET');
        const res = await mediaReactionsDef.handlers.GET!(event as RequestEvent, ctx);

        expect((res as Response).status).toBe(200);
    });
});
