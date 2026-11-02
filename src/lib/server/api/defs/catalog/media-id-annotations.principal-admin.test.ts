// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media/{id}/annotations: admin authority comes from the PRINCIPAL, not from the
 * token owner's `locals.user.isAdmin` (spec 2026-10-07-auth-route-policy-design §5.1).
 *
 *  - GET/POST: `canAccessAnnotationType` lets an admin principal past the
 *    community-permission check. The user's own moderator / annotation / review
 *    permissions stay honoured.
 *  - DELETE: only an admin principal may delete other users' annotations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import {
    TEST_USER_ID,
    adminOwnersDeviceToken,
    adminOwnersReadWritePat,
    adminSession,
    adminScopedPat,
    adminUserWithoutPrincipal,
} from '$lib/server/api/principal-locals.test-helpers.js';

vi.mock('$lib/server/config.js', () => ({
    features: { mediaAnnotations: true, socialReviews: true, mediaChat: true },
    config: { ANNOTATIONS_MAX_PINS: 5 },
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => ({}),
}));

const mockGetAnnotations = vi.fn();
const mockCreateAnnotation = vi.fn();
const mockUpsertReview = vi.fn();
const mockDeleteAnnotation = vi.fn();
vi.mock('$lib/server/database/queries/media-annotations.queries.js', () => ({
    getAnnotations: (...a: unknown[]) => mockGetAnnotations(...a),
    createAnnotation: (...a: unknown[]) => mockCreateAnnotation(...a),
    getUserPinCount: vi.fn(async () => 0),
    upsertReview: (...a: unknown[]) => mockUpsertReview(...a),
    deleteAnnotation: (...a: unknown[]) => mockDeleteAnnotation(...a),
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUsernamesByIds: vi.fn(async () => new Map()),
    getUserIdByUsername: vi.fn(async () => '11111111-1111-4111-8111-111111111111'),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn(async () => true),
}));

const { def, annotationByIdDef } = await import('./media-id-annotations.js');
const ctx: ApiContext = { surface: 'internal' };

const MEDIA_ID = '550e8400-e29b-41d4-a716-446655440000';
const ANNOTATION_ID = '660e8400-e29b-41d4-a716-446655440000';

/** Strip the user's OWN community permissions, so only admin authority can pass. */
function withoutCommunityPermissions(l: RequestEvent['locals']): RequestEvent['locals'] {
    const user = l.user as unknown as Record<string, unknown>;
    user.isModerator = false;
    user.hasMediaAnnotationPermission = false;
    user.hasReviewPermission = false;
    return l;
}

function event(locals: RequestEvent['locals'], url: string, init?: RequestInit): RequestEvent {
    return {
        url: new URL(url),
        params: { id: MEDIA_ID, annotationId: ANNOTATION_ID },
        locals: { ...locals, resolvedIds: { internalId: MEDIA_ID } },
        request: new Request(url, init),
    } as unknown as RequestEvent;
}

async function list(locals: RequestEvent['locals'], type: 'chat' | 'review'): Promise<Response> {
    const url = `http://localhost/api/media/${MEDIA_ID}/annotations?type=${type}`;
    return (await def.handlers.GET!(event(locals, url), {
        ...ctx,
        input: { query: { type, limit: 50, offset: 0 } },
    } as unknown as ApiContext)) as Response;
}

async function post(locals: RequestEvent['locals'], type: 'chat' | 'review'): Promise<Response> {
    const url = `http://localhost/api/media/${MEDIA_ID}/annotations`;
    return (await def.handlers.POST!(event(locals, url, { method: 'POST' }), {
        ...ctx,
        input: { body: { type, content: 'hello' } },
    } as unknown as ApiContext)) as Response;
}

async function del(locals: RequestEvent['locals']): Promise<Response> {
    const url = `http://localhost/api/media/${MEDIA_ID}/annotations/${ANNOTATION_ID}`;
    return (await annotationByIdDef.handlers.DELETE!(
        event(locals, url, { method: 'DELETE' }),
        ctx,
    )) as Response;
}

describe('media annotations: admin authority is the principal’s', () => {
    beforeEach(() => {
        for (const m of [mockGetAnnotations, mockCreateAnnotation, mockUpsertReview]) m.mockReset();
        mockDeleteAnnotation.mockReset();
        mockGetAnnotations.mockResolvedValue([]);
        const row = {
            id: ANNOTATION_ID,
            media_id: MEDIA_ID,
            type: 'chat',
            content: 'hello',
            timestamp_seconds: null,
            created_at: new Date('2026-01-01'),
        };
        mockCreateAnnotation.mockResolvedValue(row);
        mockUpsertReview.mockResolvedValue({ ...row, type: 'review' });
    });

    describe('GET (canAccessAnnotationType)', () => {
        it('an admin owner’s device token without community permissions is denied', async () => {
            const res = await list(withoutCommunityPermissions(adminOwnersDeviceToken()), 'chat');
            expect(res.status).toBe(403);
            expect(mockGetAnnotations).not.toHaveBeenCalled();
        });

        it('an admin owner’s read/write PAT without community permissions is denied (review)', async () => {
            const res = await list(
                withoutCommunityPermissions(adminOwnersReadWritePat()),
                'review',
            );
            expect(res.status).toBe(403);
        });

        it('locals.user.isAdmin without a principal, without community permissions, is denied', async () => {
            const res = await list(
                withoutCommunityPermissions(adminUserWithoutPrincipal()),
                'chat',
            );
            expect(res.status).toBe(403);
            expect(mockGetAnnotations).not.toHaveBeenCalled();
        });

        it('control: an admin session without community permissions is allowed', async () => {
            const res = await list(withoutCommunityPermissions(adminSession()), 'chat');
            expect(res.status).toBe(200);
            expect(mockGetAnnotations).toHaveBeenCalledTimes(1);
        });

        it('control: an admin-scoped PAT without community permissions is allowed', async () => {
            const res = await list(withoutCommunityPermissions(adminScopedPat()), 'review');
            expect(res.status).toBe(200);
        });

        it('the user’s own annotation permission is still honoured for a device token', async () => {
            const l = withoutCommunityPermissions(adminOwnersDeviceToken());
            (l.user as unknown as Record<string, unknown>).hasMediaAnnotationPermission = true;
            const res = await list(l, 'chat');
            expect(res.status).toBe(200);
        });

        it('the user’s own moderator flag is still honoured for a device token', async () => {
            const l = withoutCommunityPermissions(adminOwnersDeviceToken());
            (l.user as unknown as Record<string, unknown>).isModerator = true;
            const res = await list(l, 'review');
            expect(res.status).toBe(200);
        });
    });

    describe('POST (canAccessAnnotationType)', () => {
        it('an admin owner’s device token without community permissions is denied', async () => {
            const res = await post(withoutCommunityPermissions(adminOwnersDeviceToken()), 'chat');
            expect(res.status).toBe(403);
            expect(mockCreateAnnotation).not.toHaveBeenCalled();
        });

        it('locals.user.isAdmin without a principal, without community permissions, is denied', async () => {
            const res = await post(
                withoutCommunityPermissions(adminUserWithoutPrincipal()),
                'review',
            );
            expect(res.status).toBe(403);
            expect(mockUpsertReview).not.toHaveBeenCalled();
        });

        it('control: an admin session without community permissions may post', async () => {
            const res = await post(withoutCommunityPermissions(adminSession()), 'chat');
            expect(res.status).toBe(201);
            expect(mockCreateAnnotation).toHaveBeenCalledTimes(1);
        });
    });

    describe('DELETE (deleting other users’ annotations)', () => {
        it('an admin owner’s device token deletes with isAdmin=false (own annotations only)', async () => {
            const res = await del(adminOwnersDeviceToken());
            expect(res.status).toBe(204);
            expect(mockDeleteAnnotation).toHaveBeenCalledWith(expect.anything(), {
                annotationId: ANNOTATION_ID,
                userId: TEST_USER_ID,
                isAdmin: false,
            });
        });

        it('an admin owner’s read/write PAT deletes with isAdmin=false', async () => {
            await del(adminOwnersReadWritePat());
            expect(mockDeleteAnnotation.mock.calls[0]![1]).toMatchObject({ isAdmin: false });
        });

        it('locals.user.isAdmin without a principal deletes with isAdmin=false', async () => {
            await del(adminUserWithoutPrincipal());
            expect(mockDeleteAnnotation.mock.calls[0]![1]).toMatchObject({ isAdmin: false });
        });

        it('control: an admin session deletes with isAdmin=true', async () => {
            const res = await del(adminSession());
            expect(res.status).toBe(204);
            expect(mockDeleteAnnotation.mock.calls[0]![1]).toMatchObject({ isAdmin: true });
        });

        it('control: an admin-scoped PAT deletes with isAdmin=true', async () => {
            await del(adminScopedPat());
            expect(mockDeleteAnnotation.mock.calls[0]![1]).toMatchObject({ isAdmin: true });
        });
    });
});

it('returns 404 for a malformed annotation id without deleting', async () => {
    mockDeleteAnnotation.mockClear();
    const ev = event(adminSession(), 'http://localhost/api/media/test/annotations/nope', {
        method: 'DELETE',
    });
    ev.params.annotationId = 'nope';
    const res = await annotationByIdDef.handlers.DELETE!(ev, ctx);
    expect(res.status).toBe(404);
    expect(mockDeleteAnnotation).not.toHaveBeenCalled();
});
