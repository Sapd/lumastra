// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * /j/Videos/[itemId]/stream — the play-token branches stand the silent-start
 * detector down by (username, itemId). PlayTokenData.userId holds the USERNAME
 * (play-token-user.ts; PlaybackInfo issues tokens with locals.user.username), and
 * armSilentStart keys its secondary index on the username — so the disarm must
 * pass `username: tokenData.userId`, never a UUID lookup.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const ITEM = 'b1f6c3a0-0000-4000-8000-000000000001';
const FILE = 'f11e0000-0000-4000-8000-000000000001';
const TOKEN = 'a'.repeat(32);

const h = vi.hoisted(() => ({
    disarm: vi.fn(),
    getDb: vi.fn(),
    playUser: vi.fn(),
    tokens: new Map<
        string,
        { userId: string; itemId: string; fileId?: string; mintedByAdmin?: boolean }
    >(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/silent-start', () => ({
    armSilentStart: vi.fn(),
    disarmSilentStart: h.disarm,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/stream-file-handler', () => ({
    handleStreamFile: vi.fn(async () => new Response('media', { status: 200 })),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/stream-limit-notice', () => ({
    serveStreamLimitClipFile: vi.fn(async () => null),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    validatePlayToken: vi.fn(async (t: string) => h.tokens.get(t) ?? null),
    renewPlayTokenBySession: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token-user', async (importOriginal) => ({
    // The REAL applyPlayTokenIdentity: the route must leave a stream-token principal.
    ...(await importOriginal<
        typeof import('$lib/server/proprietary/jellyfin-compat/play-token-user')
    >()),
    buildPlayTokenUserContext: h.playUser,
}));
vi.mock('$lib/server/database', () => ({ getDb: h.getDb }));
vi.mock('$lib/server/cache/valkey.js', () => ({
    publishMessage: vi.fn(async () => true),
    subscribeToChannel: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn(async () => true),
}));
vi.mock('$lib/server/services/session-kill.service', () => ({
    checkSessionKickCooldown: vi.fn(async () => ({ kicked: false })),
}));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: vi.fn(async () => null),
}));

const { GET } = await import('./+server');

function call(
    path: string,
    query: Record<string, string> = {},
    adminSession: boolean | Record<string, unknown> = false,
): Promise<Response> {
    const url = new URL(`https://example.test/j/Videos/${path}/stream`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const user =
        adminSession === true
            ? { username: 'admin', ownerIsAdmin: true }
            : adminSession === false
              ? undefined
              : adminSession;
    const event = {
        params: { itemId: path },
        url,
        request: new Request(url),
        locals: user ? { user } : {},
    } as unknown as RequestEvent;
    return (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
}

describe('Videos/[itemId]/stream — play-token disarm keys on the token username', () => {
    it('returns a retryable 503 when the play-token user lookup is unavailable', async () => {
        const { AuthDependencyUnavailableError } =
            await import('$lib/server/auth/dependency-unavailable.js');
        h.playUser.mockRejectedValueOnce(new AuthDependencyUnavailableError());
        const response = await call(ITEM, { mediaSourceId: TOKEN });
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('5');
        expect(h.disarm).not.toHaveBeenCalled();
    });
    beforeEach(() => {
        h.disarm.mockClear();
        h.getDb.mockReturnValue({});
        h.playUser.mockImplementation(async (username: string) => ({
            userId: 'uuid-of-alice',
            username,
            ownerIsAdmin: false,
        }));
        h.tokens.clear();
        h.tokens.set(TOKEN, { userId: 'alice', itemId: ITEM, fileId: FILE });
    });

    it('file token in the path (ExoPlayer direct play)', async () => {
        const res = await call(TOKEN, { PlaySessionId: 'ps-1' });
        expect(res.status).toBe(200);
        expect(h.disarm).toHaveBeenCalledTimes(1);
        expect(h.disarm).toHaveBeenCalledWith(
            expect.objectContaining({ username: 'alice', itemId: ITEM, playSessionId: 'ps-1' }),
        );
    });

    it('file token as mediaSourceId with the real item id in the path (Android TV)', async () => {
        const res = await call(ITEM, { mediaSourceId: TOKEN });
        expect(res.status).toBe(200);
        expect(h.disarm).toHaveBeenCalledWith(
            expect.objectContaining({ username: 'alice', itemId: ITEM }),
        );
    });

    it("an admin owner's play token gets a never-admin stream-token principal", async () => {
        h.playUser.mockResolvedValueOnce({
            userId: 'uuid-of-admin',
            username: 'admin',
            userGroups: ['admins'],
            ownerIsAdmin: true,
            mediaAccessIsAdmin: true,
        });
        const url = new URL(`https://example.test/j/Videos/${TOKEN}/stream`);
        const event = {
            params: { itemId: TOKEN },
            url,
            request: new Request(url),
            locals: {},
        } as unknown as RequestEvent;
        const res = await (GET as unknown as (e: RequestEvent) => Promise<Response>)(event);
        expect(res.status).toBe(200);
        expect(event.locals.principal).toMatchObject({ kind: 'stream_token', isAdmin: false });
        expect(localsIsAdmin(event.locals)).toBe(false);
    });

    it('legacy play_token query parameter', async () => {
        h.tokens.set('legacy', { userId: 'alice', itemId: ITEM });
        const res = await call(ITEM, { play_token: 'legacy' });
        expect(res.status).toBe(200);
        expect(h.disarm).toHaveBeenCalledWith(
            expect.objectContaining({ username: 'alice', itemId: ITEM }),
        );
    });

    it('blocks an admin-owned scoped play token when the database is unavailable', async () => {
        h.getDb.mockReturnValue(null);
        h.playUser.mockResolvedValue({
            username: 'admin',
            ownerIsAdmin: true,
            mediaAccessIsAdmin: false,
        });
        const res = await call(TOKEN);
        expect(res.status).toBe(500);
        expect(h.disarm).not.toHaveBeenCalled();
    });

    it('keeps admin password-session streaming available when the database is unavailable', async () => {
        h.getDb.mockReturnValue(null);
        expect((await call(ITEM, {}, true)).status).toBe(200);
    });

    it('blocks a non-admin credential of an admin owner on the session path when the database is unavailable', async () => {
        h.getDb.mockReturnValue(null);
        const res = await call(
            ITEM,
            {},
            {
                username: 'admin',
                ownerIsAdmin: true,
                mediaAccessIsAdmin: false,
            },
        );
        expect(res.status).toBe(500);
        expect(h.disarm).not.toHaveBeenCalled();
    });
});

describe("Videos/[itemId]/stream — the play token's mint-time admin flag reaches the user context", () => {
    beforeEach(() => {
        h.getDb.mockReturnValue({});
        h.playUser.mockReset();
        h.playUser.mockImplementation(async (username: string) => ({
            userId: 'uuid-of-alice',
            username,
            ownerIsAdmin: false,
        }));
        h.tokens.clear();
    });

    const branches: Array<[string, () => Promise<Response>]> = [
        ['file token in the path', () => call(TOKEN)],
        ['file token as mediaSourceId', () => call(ITEM, { mediaSourceId: TOKEN })],
        ['legacy play_token', () => call(ITEM, { play_token: TOKEN })],
    ];

    for (const [name, run] of branches) {
        it(`${name}: passes mintedByAdmin through`, async () => {
            h.tokens.set(TOKEN, {
                userId: 'alice',
                itemId: ITEM,
                fileId: FILE,
                mintedByAdmin: true,
            });
            if (name === 'legacy play_token') {
                h.tokens.set(TOKEN, { userId: 'alice', itemId: ITEM, mintedByAdmin: true });
            }
            await run();
            expect(h.playUser).toHaveBeenCalledWith('alice', { mintedByAdmin: true });
        });

        it(`${name}: a token without the flag stays non-admin`, async () => {
            h.tokens.set(
                TOKEN,
                name === 'legacy play_token'
                    ? { userId: 'alice', itemId: ITEM }
                    : { userId: 'alice', itemId: ITEM, fileId: FILE },
            );
            await run();
            expect(h.playUser).toHaveBeenCalledWith('alice', { mintedByAdmin: false });
        });
    }
});
