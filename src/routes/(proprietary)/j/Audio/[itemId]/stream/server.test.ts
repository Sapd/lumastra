// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /j/Audio/{itemId}/stream and /stream.{container}: a valid play token is
 * served without a session; everything else goes through the route file's
 * withJellyfinAuth-wrapped handler (PATs refused).
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    authOptions: [] as unknown[],
    handleStreamFile: vi.fn(),
    validatePlayToken: vi.fn(),
    checkMediaAccess: vi.fn(),
    streamProgressive: vi.fn(),
}));

// A stand-in for withJellyfinAuth: 401 without a signed-in user.
vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler, options?: unknown) => {
        h.authOptions.push(options);
        return (event: RequestEvent) =>
            event.locals.user ? handler(event) : new Response(null, { status: 401 });
    },
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: h.checkMediaAccess,
}));
vi.mock('$lib/server/services/session-kill.service', () => ({
    checkSessionKickCooldown: vi.fn(async () => ({ kicked: false })),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/silent-start', () => ({
    disarmSilentStart: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/stream-file-handler', () => ({
    handleStreamFile: h.handleStreamFile,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/music-progressive', () => ({
    streamMusicProgressive: h.streamProgressive,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    validatePlayToken: h.validatePlayToken,
    renewPlayTokenBySession: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token-user', () => ({
    // 2026-10-13: routes call applyPlayTokenIdentity (user + never-admin stream_token principal).
    applyPlayTokenIdentity: (event: { locals: Record<string, unknown> }, user: unknown) => {
        event.locals.user = user;
        event.locals.principal = { kind: 'stream_token', isAdmin: false, scopes: [] };
    },
    buildPlayTokenUserContext: async (username: string) => ({
        userId: `uid-${username}`,
        username,
        isAdmin: false,
    }),
}));

const { GET: streamGet } = await import('./+server');
const { GET: byContainerGet } = await import('../stream.[container]/+server');

const ITEM = '00000000-0000-4000-a000-000000000001';
const FILE = '00000000-0000-4000-a000-0000000000fa';

function event(path: string, signedIn: boolean, container?: string): RequestEvent {
    const url = new URL(`https://app.example/j/Audio/${ITEM}/${path}`);
    return {
        url,
        request: new Request(url),
        params: container ? { itemId: ITEM, container } : { itemId: ITEM },
        locals: signedIn ? { user: { userId: 'uid-alice', username: 'alice' } } : {},
    } as unknown as RequestEvent;
}

const call = (handler: unknown, e: RequestEvent): Promise<Response> =>
    (handler as (e: RequestEvent) => Promise<Response>)(e);

beforeEach(() => {
    h.handleStreamFile.mockReset().mockResolvedValue(new Response('bytes', { status: 206 }));
    h.validatePlayToken
        .mockReset()
        .mockImplementation(async (t: string) =>
            t === 'tok-1' ? { fileId: FILE, itemId: ITEM, userId: 'bob' } : null,
        );
    h.checkMediaAccess.mockReset().mockResolvedValue(true);
    h.streamProgressive.mockReset();
});

describe('/j/Audio/{itemId}/stream', () => {
    it('wraps its session handlers in withJellyfinAuth with PATs refused', () => {
        expect(h.authOptions.length).toBeGreaterThanOrEqual(3);
        for (const o of h.authOptions) expect(o).toEqual({ pat: 'deny' });
    });

    it('serves a play token without a session, pinned to the token file', async () => {
        const res = await call(streamGet, event('stream?mediaSourceId=tok-1', false));
        expect(res.status).toBe(206);
        const served = h.handleStreamFile.mock.calls[0][0] as RequestEvent;
        expect(served.url.searchParams.get('mediaSourceId')).toBe(FILE);
        expect(served.locals.user?.username).toBe('bob');
    });

    it('falls back to the session handler: 401 without one, the file with one', async () => {
        expect((await call(streamGet, event('stream?mediaSourceId=nope', false))).status).toBe(401);
        expect(h.handleStreamFile).not.toHaveBeenCalled();
        expect((await call(streamGet, event('stream', true))).status).toBe(206);
        expect(h.checkMediaAccess).toHaveBeenCalledWith({}, ITEM, expect.anything(), {
            fileBacked: true,
        });
    });

    it('404s a signed-in user without access', async () => {
        h.checkMediaAccess.mockResolvedValue(false);
        expect((await call(streamGet, event('stream', true))).status).toBe(404);
        expect(h.handleStreamFile).not.toHaveBeenCalled();
    });
});

describe('/j/Audio/{itemId}/stream.{container}', () => {
    it('rejects an invalid container (ApiResponses.badRequest, 422) before anything else', async () => {
        expect((await call(byContainerGet, event('stream.m%2Fp3', true, 'm/p3'))).status).toBe(422);
    });

    it('Static=true takes a play token without a session', async () => {
        const res = await call(
            byContainerGet,
            event('stream.mp3?Static=true&play_token=tok-1', false, 'mp3'),
        );
        expect(res.status).toBe(206);
    });

    it('Static=true without a token, and the transcode branch, need a session', async () => {
        expect(
            (await call(byContainerGet, event('stream.mp3?Static=true', false, 'mp3'))).status,
        ).toBe(401);
        // A play token does not open the direct/transcode branch.
        expect(
            (await call(byContainerGet, event('stream.mp3?mediaSourceId=tok-1', false, 'mp3')))
                .status,
        ).toBe(401);
        expect(h.handleStreamFile).not.toHaveBeenCalled();
        expect(h.streamProgressive).not.toHaveBeenCalled();
    });
});
