// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    getDb: vi.fn(),
    checkMediaAccess: vi.fn(),
    probePlayability: vi.fn(),
}));

vi.mock('$lib/server/database/index.js', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: mocks.checkMediaAccess,
}));
vi.mock('$lib/server/services/playability.service.js', () => ({
    probePlayability: mocks.probePlayability,
}));

import { def } from './playability.js';
import { enforce } from '$lib/server/api/mount.js';
import { PlayabilityRequestSchema } from '$lib/schemas/api-playability.js';

const ID = '6b1f0000-0000-4000-8000-000000000001';
const USER = { userId: 'user-1', username: 'alice' };

function call(id: string, body: unknown = {}, user: unknown = USER) {
    const event = { params: { id }, locals: { user } } as never;
    const ctx = {
        surface: 'v1',
        input: { body: PlayabilityRequestSchema.parse(body) },
    } as never;
    return def.handlers.POST!(event, ctx);
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({});
    mocks.checkMediaAccess.mockResolvedValue(true);
    mocks.probePlayability.mockResolvedValue({
        ok: true,
        data: {
            mediaId: ID,
            activeFileId: 'f1',
            resumePositionMs: 0,
            isWatched: false,
            versions: [],
        },
    });
});

describe('POST /media/{id}/playability', () => {
    it('declares media:read, not media:write, and a body that reuses the start capabilities', () => {
        expect(def.auth).toEqual({ kind: 'scope', anyOf: ['media:read'] });
    });

    it('returns the probe result', async () => {
        const res = await call(ID, { capabilities: { videoCodecs: ['h264'] } });
        expect(res.status).toBe(200);
        expect((await res.json()).activeFileId).toBe('f1');
        expect(mocks.probePlayability).toHaveBeenCalledWith(
            expect.objectContaining({
                mediaId: ID,
                userId: 'user-1',
                capabilities: { videoCodecs: ['h264'] },
                surface: 'v1',
            }),
        );
    });

    it('an item the account may not see is 404 and is never probed', async () => {
        mocks.checkMediaAccess.mockResolvedValue(false);
        const res = await call(ID);
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toContain('application/problem+json');
        expect(mocks.probePlayability).not.toHaveBeenCalled();
    });

    it('a malformed id is 404 without touching the database access check', async () => {
        const res = await call('not-a-uuid');
        expect(res.status).toBe(404);
        expect(mocks.checkMediaAccess).not.toHaveBeenCalled();
    });

    it('no user is 401', async () => {
        expect((await call(ID, {}, null)).status).toBe(401);
    });

    it('maps service failures to problem+json', async () => {
        mocks.probePlayability.mockResolvedValue({ ok: false, status: 422, message: 'nope' });
        const res = await call(ID);
        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('validation_failed');
        mocks.probePlayability.mockResolvedValue({ ok: false, status: 404, message: 'x' });
        expect((await call(ID)).status).toBe(404);
    });

    it('passes a lower-cased fileId to the probe (ids are compared as text)', async () => {
        await call(ID, { fileId: '9C2E0000-0000-4000-8000-00000000ABCD' });
        expect(mocks.probePlayability).toHaveBeenCalledWith(
            expect.objectContaining({ fileId: '9c2e0000-0000-4000-8000-00000000abcd', username: 'alice' }),
        );
    });

    it.each([500, 503, 502])('a service status %i is the documented 503 problem', async (status) => {
        mocks.probePlayability.mockResolvedValue({ ok: false, status, message: 'unreadable' });
        const res = await call(ID);
        expect(res.status).toBe(503);
        expect((await res.json()).code).toBe('dependency_unavailable');
    });

    it('rejects a non-uuid fileId in the body schema', () => {
        expect(PlayabilityRequestSchema.safeParse({ fileId: 'x' }).success).toBe(false);
    });

    describe('scope', () => {
        const eventWith = (scopes: string[]) =>
            ({
                locals: {
                    user: { userId: 'user-1', username: 'alice' },
                    principal: {
                        kind: 'pat',
                        userId: 'user-1',
                        username: 'alice',
                        userGroups: [],
                        scopes,
                        isAdmin: false,
                    },
                },
                request: new Request('http://x/api/v1/media/x/playability', { method: 'POST' }),
            }) as never;

        it('a media:read-only credential may probe (it reads what GET /media/{id} shows, creates nothing)', async () => {
            expect(await enforce(def.auth as Parameters<typeof enforce>[0], eventWith(['media:read']))).toBeNull();
        });

        it('a credential without media:read is refused with scope_required', async () => {
            const res = await enforce(def.auth as Parameters<typeof enforce>[0], eventWith(['playlists:read']));
            expect(res?.status).toBe(403);
            expect((await res!.json()).code).toBe('scope_required');
        });
    });
});
