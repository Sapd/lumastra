// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';
import { def } from './[id].js';
import { def as renewDef } from './[id]/renew.js';
import { PlaybackGrantResponseSchema, RenewPlaybackGrantResponseSchema } from './schema.js';

const service = vi.hoisted(() => ({
    getPlaybackGrant: vi.fn(),
    revokePlaybackGrant: vi.fn(),
    renewPlaybackGrant: vi.fn(),
}));
const StoreUnavailable = vi.hoisted(() => class extends Error {});
vi.mock('$lib/server/services/playback-grant.js', () => ({
    ...service,
    PlaybackGrantStoreUnavailableError: StoreUnavailable,
}));

const id = '11111111-1111-4111-8111-111111111111';
const grant = {
    id,
    token: 'secret',
    userId: 'owner',
    mediaId: 'media',
    playbackSessionId: 'play-session',
    kind: 'video',
    expiresAt: new Date('2026-10-17T10:00:00Z'),
    renewAfter: new Date('2026-10-17T09:00:00Z'),
    ipPinned: true,
};
function event(owner?: string): RequestEvent {
    return { locals: { user: owner ? { userId: owner } : undefined } } as unknown as RequestEvent;
}
const ctx: ApiContext<NonNullable<typeof def.request>> = {
    surface: 'v1',
    input: { body: undefined, query: undefined, params: { id } },
};

const renewCtx: ApiContext<NonNullable<typeof renewDef.request>> = {
    ...ctx,
    input: { params: { id }, query: undefined, body: { token: 'secret' } },
};

beforeEach(() => {
    vi.resetAllMocks();
    service.getPlaybackGrant.mockResolvedValue(grant);
    service.renewPlaybackGrant.mockResolvedValue(grant);
    service.revokePlaybackGrant.mockResolvedValue(true);
});

describe('owner authenticated playback grant management', () => {
    it('requires an account user for all operations', async () => {
        expect(def.auth).toEqual({ kind: 'scope', anyOf: ['media:write'] });
        expect(renewDef.auth).toEqual({ kind: 'scope', anyOf: ['media:write'] });
        expect((await def.handlers.GET!(event(), ctx)).status).toBe(401);
        expect((await def.handlers.DELETE!(event(), ctx)).status).toBe(401);
        expect((await renewDef.handlers.POST!(event(), renewCtx)).status).toBe(401);
        expect(service.getPlaybackGrant).not.toHaveBeenCalled();
        expect(service.renewPlaybackGrant).not.toHaveBeenCalled();
        expect(service.revokePlaybackGrant).not.toHaveBeenCalled();
    });

    it('looks up metadata by public ID and owner, and never returns the secret', async () => {
        const response = await def.handlers.GET!(event('owner'), ctx);
        expect(service.getPlaybackGrant).toHaveBeenCalledWith(id, 'owner', 'v1');
        const body = await response.json();
        expect(PlaybackGrantResponseSchema.safeParse(body).success).toBe(true);
        expect(body).not.toHaveProperty('token');
        expect(body).not.toHaveProperty('userId');
        expect(body.renewHref).toBe(`/api/v1/playback/grants/${id}/renew`);
    });

    it('does not reveal missing grants or another owner grants', async () => {
        service.getPlaybackGrant.mockResolvedValue(null);
        service.renewPlaybackGrant.mockResolvedValue(null);
        service.revokePlaybackGrant.mockResolvedValue(false);
        expect((await def.handlers.GET!(event('other'), ctx)).status).toBe(404);
        expect((await renewDef.handlers.POST!(event('other'), renewCtx)).status).toBe(404);
        expect((await def.handlers.DELETE!(event('other'), ctx)).status).toBe(404);
        expect(service.getPlaybackGrant).toHaveBeenCalledWith(id, 'other', 'v1');
        expect(service.renewPlaybackGrant).toHaveBeenCalledWith(id, 'other', 'v1', 'secret');
        expect(service.revokePlaybackGrant).toHaveBeenCalledWith(id, 'other');
    });

    it('answers a Live store outage on renewal with a 503 problem, not a 500', async () => {
        service.renewPlaybackGrant.mockRejectedValue(new StoreUnavailable('down'));
        const response = await renewDef.handlers.POST!(event('owner'), renewCtx);
        expect(response.status).toBe(503);
        expect((await response.json()).code).toBe('dependency_unavailable');
    });

    it('returns the unchanged secret on renewal', async () => {
        const response = await renewDef.handlers.POST!(event('owner'), renewCtx);
        const body = await response.json();
        expect(RenewPlaybackGrantResponseSchema.safeParse(body).success).toBe(true);
        expect(body.token).toBe('secret');
        expect(body).not.toHaveProperty('previousTokenExpiresAt');
        expect(body.ipPinned).toBe(true);
        expect(service.renewPlaybackGrant).toHaveBeenCalledWith(id, 'owner', 'v1', 'secret');
    });

    it('uses the authenticated principal owner when legacy locals disagree', async () => {
        const request = event('legacy-user');
        request.locals.principal = {
            userId: 'principal-owner',
        } as unknown as App.Locals['principal'];
        await def.handlers.GET!(request, ctx);
        await renewDef.handlers.POST!(request, renewCtx);
        await def.handlers.DELETE!(request, ctx);
        expect(service.getPlaybackGrant).toHaveBeenCalledWith(id, 'principal-owner', 'v1');
        expect(service.renewPlaybackGrant).toHaveBeenCalledWith(
            id,
            'principal-owner',
            'v1',
            'secret',
        );
        expect(service.revokePlaybackGrant).toHaveBeenCalledWith(id, 'principal-owner');
    });

    it('revokes by public ID and owner', async () => {
        expect((await def.handlers.DELETE!(event('owner'), ctx)).status).toBe(204);
        expect(service.revokePlaybackGrant).toHaveBeenCalledWith(id, 'owner');
    });
});

it('keeps cookie-only grant metadata and renewal links on the internal API surface', async () => {
    const internal = { ...ctx, surface: 'internal' as const };
    for (const response of [
        await def.handlers.GET!(event('owner'), internal),
        await renewDef.handlers.POST!(event('owner'), { ...renewCtx, surface: 'internal' }),
    ]) {
        expect(await response.json()).toMatchObject({
            renewHref: `/api/playback/grants/${id}/renew`,
        });
    }
    expect(service.getPlaybackGrant).toHaveBeenCalledWith(id, 'owner', 'internal');
    expect(service.renewPlaybackGrant).toHaveBeenCalledWith(id, 'owner', 'internal', 'secret');
});
