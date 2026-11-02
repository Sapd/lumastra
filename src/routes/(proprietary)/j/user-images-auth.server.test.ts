// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * /j/UserImage and /j/Users/{id}/Images/{type}: a real avatar needs a Jellyfin
 * credential. Without one (or with one that does not validate) every id gets
 * the same generic silhouette, never the uploaded avatar.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FLAT = USER_ID.replace(/-/g, '');
const UNKNOWN = '22222222222242228222222222222222';

const getUserAvatar = vi.fn();
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackImage: vi.fn() },
}));
vi.mock('$lib/server/services/image-proxy', async () => ({
    ...(await import('$lib/server/services/image-proxy/response.js')),
    getImageProxyService: () => ({ getUserAvatar }),
}));
vi.mock('$lib/server/database', () => ({
    getDb: () => async (_s: TemplateStringsArray, ...values: unknown[]) =>
        String(values[0]).replace(/-/g, '') === FLAT ? [{ username: 'alice' }] : [],
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('$lib/server/middleware/valkey-rate-limit', () => ({
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 10, resetAt: 0 }),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/auth', () => ({
    validateSession: async (token: string) =>
        token === 'good'
            ? {
                  userId: 'aaaaaaaa-0000-4000-a000-000000000001',
                  username: 'viewer',
                  deviceId: 'd',
                  clientName: 'c',
                  clientVersion: '1',
              }
            : null,
    revokeSession: vi.fn(),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/pat-auth', () => ({
    validateJellyfinCompatPat: async () => null,
}));
vi.mock('$lib/server/auth/resolve-token-user-access', () => ({
    resolveTokenUserAccess: async () => ({
        disabled: false,
        deleted: false,
        userGroups: [],
        permissions: { ownerIsAdmin: false },
    }),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/user-avatar', () => ({
    handleDeleteUserImage: vi.fn(),
    handleUploadUserImage: vi.fn(),
}));

const { GET: userImageGet } = await import('./UserImage/+server.js');
const { GET: usersImagesGet } = await import('./Users/[userId]/Images/[imageType]/+server.js');

type Ev = Parameters<typeof userImageGet>[0];

function call(
    handler: (e: Ev) => Response | Promise<Response>,
    path: string,
    params: Record<string, string>,
    headers: Record<string, string> = {},
): Promise<Response> {
    const request = new Request(`http://localhost${path}`, { headers });
    return Promise.resolve(
        handler({
            request,
            url: new URL(request.url),
            params,
            locals: {},
            route: { id: null },
            getClientAddress: () => '127.0.0.1',
            fetch: vi.fn(),
            setHeaders: vi.fn(),
        } as unknown as Ev),
    );
}

const REAL = Buffer.from('REAL-AVATAR-BYTES');
beforeEach(() => {
    getUserAvatar
        .mockReset()
        .mockResolvedValue({ buffer: REAL, contentType: 'image/webp', cacheControl: 'public, max-age=300' });
});

const routes: [string, string, (id: string) => Promise<Response>, (id: string, h: Record<string, string>) => Promise<Response>][] = [
    [
        '/j/UserImage',
        'UserImage',
        (id) => call(userImageGet as never, `/j/UserImage?UserId=${id}`, {}),
        (id, h) => call(userImageGet as never, `/j/UserImage?UserId=${id}`, {}, h),
    ],
    [
        '/j/Users/{id}/Images/Primary',
        'Users',
        (id) => call(usersImagesGet as never, `/j/Users/${id}/Images/Primary`, { userId: id, imageType: 'Primary' }),
        (id, h) => call(usersImagesGet as never, `/j/Users/${id}/Images/Primary`, { userId: id, imageType: 'Primary' }, h),
    ],
];

describe.each(routes)('%s', (_name, _k, anon, withHeaders) => {
    it('anonymous: silhouette for an existing and an unknown id, never the avatar', async () => {
        const a = await anon(FLAT);
        const b = await anon(UNKNOWN);
        for (const res of [a, b]) {
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toBe('image/svg+xml');
            expect(res.headers.get('cache-control')).toMatch(/^private/);
        }
        expect(await a.text()).toBe(await b.text());
        expect(getUserAvatar).not.toHaveBeenCalled();
    });

    it('an invalid token is answered like no token', async () => {
        const res = await withHeaders(FLAT, { 'X-Emby-Token': 'bogus' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/svg+xml');
        expect(getUserAvatar).not.toHaveBeenCalled();
    });

    it.each([
        ['X-Emby-Token', { 'X-Emby-Token': 'good' }],
        ['X-Emby-Authorization', { 'X-Emby-Authorization': 'MediaBrowser Client="x", Token="good"' }],
        ['Authorization', { Authorization: 'MediaBrowser Token="good"' }],
    ])('valid session via %s: the real avatar, private cache', async (_h, headers) => {
        const res = await withHeaders(FLAT, headers);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/webp');
        expect(res.headers.get('cache-control')).toMatch(/^private,/);
        expect(Buffer.from(await res.arrayBuffer()).equals(REAL)).toBe(true);
    });

    it('valid session, unknown id: silhouette (no oracle)', async () => {
        const res = await withHeaders(UNKNOWN, { 'X-Emby-Token': 'good' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/svg+xml');
    });
});

it('valid api_key query token on /j/Users/{id}/Images', async () => {
    const res = await call(
        usersImagesGet as never,
        `/j/Users/${FLAT}/Images/Primary?api_key=good`,
        { userId: FLAT, imageType: 'Primary' },
    );
    expect(res.headers.get('content-type')).toBe('image/webp');
});
