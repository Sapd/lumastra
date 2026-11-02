// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Behavioural tests for DELETE /api/v1/media/{id}/rating.
 *
 * Drives the real mount()/enforce() pipeline rather than calling the handler
 * directly — the point of this endpoint is that it is REACHABLE by a generated
 * client, so the wiring (handler present, route re-exports DELETE) is part of
 * what is under test, not incidental to it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

// ── Module mocks ─────────────────────────────────────────────────────────────
// `$lib/server/config.js` is deliberately NOT mocked: a partial stub throws at
// import because TaskRegistry reads FEATURE_PER_TASK_QUEUES at module scope.

const { mockGetSql, mockCheckMediaAccess, mockDeleteUserRating, mockClearTrackFeedback, mockGetMediaType } = vi.hoisted(() => ({
    mockGetSql: vi.fn(),
    mockCheckMediaAccess: vi.fn(),
    mockDeleteUserRating: vi.fn(),
    mockClearTrackFeedback: vi.fn(),
    mockGetMediaType: vi.fn().mockResolvedValue('movie'),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...a: unknown[]) => mockGetSql(...a) },
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...a: unknown[]) => mockCheckMediaAccess(...a),
}));

// withIdResolution opens its own DB connection to resolve composite ids. The
// event already carries a resolved internalId, so pass straight through.
vi.mock('$lib/server/middleware/id-resolution.js', () => ({
    withIdResolution:
        (handler: (event: unknown) => unknown) =>
        (event: unknown): unknown =>
            handler(event),
}));

vi.mock('$lib/server/database/queries/user-ratings.queries.js', () => ({
    deleteUserRating: { execute: (...a: unknown[]) => mockDeleteUserRating(...a) },
    getUserRating: { one: vi.fn() },
    upsertUserRating: { one: vi.fn() },
}));

vi.mock('$lib/server/database/queries/media-type-cache.queries.js', () => ({
    getMediaType: mockGetMediaType,
    isMusicMediaType: (type: string) => type === 'track',
}));

vi.mock('$lib/server/database/queries/music-interactions.queries.js', () => ({
    clearTrackFeedback: mockClearTrackFeedback,
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import { mount } from '$lib/server/api/mount.js';
import { def } from './media-id-rating.js';
import * as route from '../../../../../routes/api/v1/media/[id]/rating/+server.js';
import * as internalRoute from '../../../../../routes/api/media/[id]/rating/+server.js';

const CTX = { surface: 'v1' } as const;
const MEDIA_ID = '11111111-2222-3333-4444-555555555555';
const USER_ID = '00000000-0000-0000-0000-000000000001';

function makeEvent(opts: { authenticated?: boolean } = {}): RequestEvent {
    const user = opts.authenticated
        ? {
              userId: toUserId(USER_ID),
              username: 'alice',
              groups: '',
              userGroups: [] as string[],
              hasWatchPermission: true,
              hasLiveTvPermission: false,
              hasRequestPermission: false,
              isAdmin: false,
              isModerator: false,
              maxAgeRating: null as null | number,
              isAgeRestricted: false,
              liveTvPriority: 'low' as const,
          }
        : null;

    const url = `http://localhost/api/v1/media/${MEDIA_ID}/rating`;
    return {
        url: new URL(url),
        request: new Request(url, { method: 'DELETE' }),
        params: { id: MEDIA_ID },
        route: { id: '/api/v1/media/[id]/rating' },
        locals: { user, resolvedIds: { internalId: MEDIA_ID } },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

describe('DELETE /api/v1/media/{id}/rating', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetMediaType.mockResolvedValue('movie');
        mockGetSql.mockResolvedValue({} as unknown);
        mockCheckMediaAccess.mockResolvedValue(true);
        mockDeleteUserRating.mockResolvedValue({ id: 1 });
    });

    it('is reachable — both mounts of the route export a DELETE', () => {
        // This is how a generated client clears a rating; an unmounted handler
        // would defeat that silently.
        expect((route as Record<string, unknown>).DELETE).toBeTypeOf('function');
        expect((internalRoute as Record<string, unknown>).DELETE).toBeTypeOf('function');
    });

    it('clears track feedback through clearTrackFeedback instead of deleteUserRating', async () => {
        mockGetMediaType.mockResolvedValue('track');
        const { DELETE } = mount(def, CTX);
        const res = await DELETE!(makeEvent({ authenticated: true }));
        expect(res.status).toBe(204);
        expect(mockClearTrackFeedback).toHaveBeenCalledWith(expect.anything(), USER_ID, MEDIA_ID);
        expect(mockDeleteUserRating).not.toHaveBeenCalled();
    });

    it('clears the rating and returns 204', async () => {
        const { DELETE } = mount(def, CTX);
        const res = await DELETE!(makeEvent({ authenticated: true }));

        expect(res.status).toBe(204);
        expect(mockDeleteUserRating).toHaveBeenCalledTimes(1);
        expect(mockDeleteUserRating.mock.calls[0][1]).toEqual({
            userId: USER_ID,
            mediaId: MEDIA_ID,
        });
    });

    it('is idempotent — a no-op delete still returns 204', async () => {
        // No row matched: the write query returns nothing.
        mockDeleteUserRating.mockResolvedValue(undefined);

        const { DELETE } = mount(def, CTX);
        const res = await DELETE!(makeEvent({ authenticated: true }));

        expect(res.status).toBe(204);
    });

    it('returns 404 rather than 403 for media the caller cannot reach', async () => {
        mockCheckMediaAccess.mockResolvedValue(false);

        const { DELETE } = mount(def, CTX);
        const res = await DELETE!(makeEvent({ authenticated: true }));

        expect(res.status).toBe(404);
        // Must not touch state for media the caller cannot see.
        expect(mockDeleteUserRating).not.toHaveBeenCalled();
    });

    it('rejects an unauthenticated caller without touching the database', async () => {
        const { DELETE } = mount(def, CTX);
        const res = await DELETE!(makeEvent({ authenticated: false }));

        expect(res.status).toBe(401);
        expect(mockDeleteUserRating).not.toHaveBeenCalled();
    });

    it('sends no body, so a 204-expecting client never tries to decode one', async () => {
        const { DELETE } = mount(def, CTX);
        const res = await DELETE!(makeEvent({ authenticated: true }));

        expect(await res.text()).toBe('');
    });
});
