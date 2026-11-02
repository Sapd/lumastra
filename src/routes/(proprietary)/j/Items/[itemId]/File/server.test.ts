// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/** GET /j/Items/{itemId}/File: the original file for a signed-in user with access. */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    authOptions: [] as unknown[],
    handleStreamFile: vi.fn(),
    checkMediaAccess: vi.fn(),
    kicked: { kicked: false } as { kicked: boolean; remainingSeconds?: number },
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
    checkSessionKickCooldown: vi.fn(async () => h.kicked),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/silent-start', () => ({
    disarmSilentStart: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/stream-file-handler', () => ({
    handleStreamFile: h.handleStreamFile,
}));

const { GET } = await import('./+server');

const ITEM = '00000000-0000-4000-a000-000000000001';

function event(signedIn: boolean, query = ''): RequestEvent {
    const url = new URL(`https://app.example/j/Items/${ITEM}/File${query}`);
    return {
        url,
        request: new Request(url, { headers: { Range: 'bytes=0-' } }),
        params: { itemId: ITEM },
        locals: signedIn ? { user: { userId: 'uid-alice', username: 'alice' } } : {},
    } as unknown as RequestEvent;
}

const call = (e: RequestEvent): Promise<Response> =>
    (GET as unknown as (e: RequestEvent) => Promise<Response>)(e);

beforeEach(() => {
    h.handleStreamFile.mockReset().mockResolvedValue(new Response('bytes', { status: 206 }));
    h.checkMediaAccess.mockReset().mockResolvedValue(true);
    h.kicked = { kicked: false };
});

describe('/j/Items/{itemId}/File', () => {
    it('is wrapped in withJellyfinAuth with PATs refused', () => {
        expect(h.authOptions).toEqual([{ pat: 'deny' }]);
    });

    it('401s without a session and never touches the file', async () => {
        expect((await call(event(false, '?ApiKey=bogus'))).status).toBe(401);
        expect(h.handleStreamFile).not.toHaveBeenCalled();
    });

    it('serves the file (range response) after the access check', async () => {
        const res = await call(event(true, '?ApiKey=tok'));
        expect(res.status).toBe(206);
        expect(h.checkMediaAccess).toHaveBeenCalledWith({}, ITEM, expect.anything(), {
            fileBacked: true,
        });
        expect(h.handleStreamFile).toHaveBeenCalledOnce();
    });

    it('404s an item the user cannot access', async () => {
        h.checkMediaAccess.mockResolvedValue(false);
        expect((await call(event(true))).status).toBe(404);
        expect(h.handleStreamFile).not.toHaveBeenCalled();
    });

    it('refuses a user inside a kick cooldown', async () => {
        h.kicked = { kicked: true, remainingSeconds: 30 };
        const res = await call(event(true));
        expect(res.status).not.toBe(206);
        expect(h.handleStreamFile).not.toHaveBeenCalled();
    });
});
