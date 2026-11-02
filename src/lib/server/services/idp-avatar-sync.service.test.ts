// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import type postgres from 'postgres';

const configMock = vi.hoisted(() => ({
    config: { AUTH_OIDC_SYNC_AVATAR: true, AUTH_OIDC_ALLOW_INSECURE: false },
}));
vi.mock('$lib/server/config.js', () => configMock);

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const queryMocks = vi.hoisted(() => ({
    getUserIdpAvatarState: vi.fn(),
    setUserIdpAvatar: vi.fn(async () => true),
    touchUserIdpAvatar: vi.fn(async () => undefined),
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => queryMocks);

const proxyMocks = vi.hoisted(() => ({ invalidateAvatarCache: vi.fn(async () => undefined) }));
vi.mock('$lib/server/services/image-proxy/index.js', () => ({
    getImageProxyService: () => proxyMocks,
}));

// The real ssrf-guard runs (wrapped only to observe its arguments); DNS and the
// undici transport are mocked. Hosts named `private.*` resolve to a private
// address; everything else is public.
vi.mock('node:dns/promises', () => ({
    default: {
        lookup: vi.fn(async (host: string) => [
            { address: host.startsWith('private.') ? '10.0.0.5' : '93.184.216.34', family: 4 },
        ]),
    },
}));
const ssrfMocks = vi.hoisted(() => ({
    resolveSafePublicUrl: vi.fn(),
}));
vi.mock('$lib/server/utils/ssrf-guard.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('$lib/server/utils/ssrf-guard.js')>();
    ssrfMocks.resolveSafePublicUrl.mockImplementation(real.resolveSafePublicUrl);
    return { ...real, resolveSafePublicUrl: ssrfMocks.resolveSafePublicUrl };
});

type PinLookup = (
    host: string,
    opts: unknown,
    cb: (err: null, addrs: Array<{ address: string; family: number }>) => void,
) => void;
const agentOpts: Array<{ connect: { lookup: PinLookup } }> = [];
const fetchMock = vi.hoisted(() => vi.fn<(url: URL, init: RequestInit) => Promise<Response>>());
vi.mock('undici', () => ({
    Agent: class {
        constructor(opts: { connect: { lookup: PinLookup } }) {
            agentOpts.push(opts);
        }
        close(): Promise<void> {
            return Promise.resolve();
        }
        destroy(): Promise<void> {
            return Promise.resolve();
        }
    },
    fetch: (url: URL, init: RequestInit) => fetchMock(url, init),
}));

/**
 * The address the Nth pinned connection would dial. The pinned lookup answers
 * on a later tick (like dns.lookup), so wait for its callback.
 */
function pinnedAddress(n: number): Promise<string> {
    return new Promise((resolve) => {
        agentOpts[n].connect.lookup('ignored', { all: true }, (_e, addrs) => {
            resolve(addrs[0].address);
        });
    });
}

import { _resetSsrfDnsCacheForTests } from '$lib/server/utils/ssrf-guard.js';
import {
    syncIdpAvatar,
    IDP_AVATAR_MAX_BYTES,
    _resetIdpAvatarSyncStateForTests,
} from './idp-avatar-sync.service.js';

const sql = {} as postgres.Sql;
const USER = { userId: '00000000-0000-0000-0000-0000000000aa', username: 'alice' };
const ISSUER = 'https://private.auth.example/application/o/lumastra/';

let png: Buffer;

function imageResponse(body: Buffer, contentType = 'image/png'): Response {
    return new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'content-type': contentType },
    });
}

function state(
    over: Partial<{ source: string | null; hasData: boolean; updatedAt: Date | null }> = {},
) {
    return { source: null, hasData: false, updatedAt: null, ...over };
}

/** The `value` argument of the last setUserIdpAvatar call. */
function lastWrite(): { data: Buffer | null; contentType: string | null; source: string | null } {
    const calls = queryMocks.setUserIdpAvatar.mock.calls as unknown as Array<
        [
            unknown,
            string,
            string | null,
            { data: Buffer | null; contentType: string | null; source: string | null },
        ]
    >;
    return calls[calls.length - 1][3];
}

beforeEach(async () => {
    vi.clearAllMocks();
    agentOpts.length = 0;
    _resetSsrfDnsCacheForTests();
    _resetIdpAvatarSyncStateForTests();
    queryMocks.setUserIdpAvatar.mockResolvedValue(true);
    configMock.config.AUTH_OIDC_SYNC_AVATAR = true;
    configMock.config.AUTH_OIDC_ALLOW_INSECURE = false;
    queryMocks.getUserIdpAvatarState.mockResolvedValue(state());
    png ??= await sharp({
        create: { width: 400, height: 300, channels: 3, background: '#3366cc' },
    })
        .png()
        .toBuffer();
});

describe('syncIdpAvatar', () => {
    it('does nothing when AUTH_OIDC_SYNC_AVATAR is off', async () => {
        configMock.config.AUTH_OIDC_SYNC_AVATAR = false;
        const out = await syncIdpAvatar(sql, {
            ...USER,
            picture: 'https://x/a.png',
            issuer: ISSUER,
        });
        expect(out).toBe('disabled');
        expect(queryMocks.getUserIdpAvatarState).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('stores a data: PNG as a 200x200 WebP', async () => {
        const picture = `data:image/png;base64,${png.toString('base64')}`;
        const out = await syncIdpAvatar(sql, { ...USER, picture, issuer: ISSUER });

        expect(out).toBe('stored');
        const written = lastWrite();
        expect(written.contentType).toBe('image/webp');
        const meta = await sharp(written.data as Buffer).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual(['webp', 200, 200]);
        expect(written.source).toMatch(/^[0-9a-f]{64}$/);
        expect(proxyMocks.invalidateAvatarCache).toHaveBeenCalledWith('alice');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects an SVG data: URI and records it so it is not retried', async () => {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
        const picture = `data:image/svg+xml;base64,${svg.toString('base64')}`;
        const out = await syncIdpAvatar(sql, { ...USER, picture, issuer: ISSUER });

        expect(out).toBe('rejected');
        expect(lastWrite()).toMatchObject({ data: null, contentType: null });
        expect(lastWrite().source).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects a data: URI whose bytes are not an image', async () => {
        const picture = `data:image/png;base64,${Buffer.from('<html>not a png</html>').toString('base64')}`;
        expect(await syncIdpAvatar(sql, { ...USER, picture, issuer: ISSUER })).toBe('rejected');
    });

    it('fetches a public https picture and stores it', async () => {
        fetchMock.mockResolvedValueOnce(imageResponse(png));
        const out = await syncIdpAvatar(sql, {
            ...USER,
            picture: 'https://gravatar.example/avatar/abc?s=200',
            issuer: ISSUER,
        });

        expect(out).toBe('stored');
        expect(ssrfMocks.resolveSafePublicUrl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        // Pinned in the transport: the hostname stays in the URL (Host + SNI).
        expect(String(url)).toBe('https://gravatar.example/avatar/abc?s=200');
        expect(new Headers(init.headers).has('host')).toBe(false);
        expect(await pinnedAddress(0)).toBe('93.184.216.34');
        expect(init.redirect).toBe('manual');
        expect(init.credentials).toBe('omit');
    });

    it('allows a private address only for the issuer origin', async () => {
        fetchMock.mockResolvedValueOnce(imageResponse(png));
        const out = await syncIdpAvatar(sql, {
            ...USER,
            picture: 'https://private.auth.example/media/user-avatars/alice.png',
            issuer: ISSUER,
        });

        expect(out).toBe('stored');
        expect(ssrfMocks.resolveSafePublicUrl).toHaveBeenCalledWith(expect.any(URL), {
            allowPrivate: true,
        });
        expect(await pinnedAddress(0)).toBe('10.0.0.5');
    });

    it('a public host redirecting INTO the issuer origin gets no private allowance', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(null, {
                status: 302,
                headers: { location: 'https://private.auth.example/api/v3/admin/' },
            }),
        );
        const out = await syncIdpAvatar(sql, {
            ...USER,
            picture: 'https://attacker.example/a.png',
            issuer: ISSUER,
        });

        expect(out).toBe('rejected');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(ssrfMocks.resolveSafePublicUrl).toHaveBeenLastCalledWith(expect.any(URL), {
            allowPrivate: false,
        });
    });

    it('refuses a URL carrying credentials', async () => {
        const out = await syncIdpAvatar(sql, {
            ...USER,
            picture: 'https://user:pw@cdn.example/a.png',
            issuer: ISSUER,
        });
        expect(out).toBe('rejected');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a private address on any other host, without fetching', async () => {
        const out = await syncIdpAvatar(sql, {
            ...USER,
            picture: 'https://private.intranet.example/a.png',
            issuer: ISSUER,
        });

        expect(out).toBe('rejected');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('re-checks every redirect hop (issuer redirecting to a private host)', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(null, {
                status: 302,
                headers: { location: 'https://private.intranet.example/secret.png' },
            }),
        );
        const out = await syncIdpAvatar(sql, {
            ...USER,
            picture: 'https://private.auth.example/media/a.png',
            issuer: ISSUER,
        });

        expect(out).toBe('rejected');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refuses plain http unless AUTH_OIDC_ALLOW_INSECURE is on', async () => {
        const params = { ...USER, picture: 'http://cdn.example/a.png', issuer: ISSUER };
        expect(await syncIdpAvatar(sql, params)).toBe('rejected');
        expect(fetchMock).not.toHaveBeenCalled();

        configMock.config.AUTH_OIDC_ALLOW_INSECURE = true;
        fetchMock.mockResolvedValueOnce(imageResponse(png));
        expect(await syncIdpAvatar(sql, params)).toBe('stored');
    });

    it('rejects an SVG served by URL', async () => {
        fetchMock.mockResolvedValueOnce(imageResponse(Buffer.from('<svg/>'), 'image/svg+xml'));
        expect(
            await syncIdpAvatar(sql, {
                ...USER,
                picture: 'https://cdn.example/a.svg',
                issuer: ISSUER,
            }),
        ).toBe('rejected');
    });

    it('rejects a picture over the size cap', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response('x', {
                status: 200,
                headers: {
                    'content-type': 'image/png',
                    'content-length': String(IDP_AVATAR_MAX_BYTES + 1),
                },
            }),
        );
        expect(
            await syncIdpAvatar(sql, {
                ...USER,
                picture: 'https://cdn.example/big.png',
                issuer: ISSUER,
            }),
        ).toBe('rejected');
    });

    it('keeps the stored copy when the picture host is down', async () => {
        queryMocks.getUserIdpAvatarState.mockResolvedValue(
            state({ source: 'old', hasData: true, updatedAt: new Date() }),
        );
        fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }));
        const out = await syncIdpAvatar(sql, {
            ...USER,
            picture: 'https://cdn.example/new.png',
            issuer: ISSUER,
        });

        expect(out).toBe('unavailable');
        expect(queryMocks.setUserIdpAvatar).not.toHaveBeenCalled();
        expect(proxyMocks.invalidateAvatarCache).not.toHaveBeenCalled();
    });

    it('skips an unchanged picture inside the refresh window, refetches after it', async () => {
        const picture = 'https://cdn.example/a.png';
        // A fresh Response per call: a body can only be read once.
        fetchMock.mockImplementation(async () => imageResponse(png));
        await syncIdpAvatar(sql, { ...USER, picture, issuer: ISSUER });
        const source = lastWrite().source;
        fetchMock.mockClear();

        queryMocks.getUserIdpAvatarState.mockResolvedValue(
            state({ source, hasData: true, updatedAt: new Date() }),
        );
        expect(await syncIdpAvatar(sql, { ...USER, picture, issuer: ISSUER })).toBe('unchanged');
        expect(fetchMock).not.toHaveBeenCalled();

        queryMocks.getUserIdpAvatarState.mockResolvedValue(
            state({ source, hasData: true, updatedAt: new Date(Date.now() - 8 * 86_400_000) }),
        );
        expect(await syncIdpAvatar(sql, { ...USER, picture, issuer: ISSUER })).toBe('stored');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a 404 for the picture we already hold keeps the copy and restarts the window', async () => {
        const picture = 'https://cdn.example/signed.png';
        fetchMock.mockImplementation(async () => imageResponse(png));
        await syncIdpAvatar(sql, { ...USER, picture, issuer: ISSUER });
        const source = lastWrite().source;
        queryMocks.setUserIdpAvatar.mockClear();
        proxyMocks.invalidateAvatarCache.mockClear();

        queryMocks.getUserIdpAvatarState.mockResolvedValue(
            state({ source, hasData: true, updatedAt: new Date(Date.now() - 8 * 86_400_000) }),
        );
        fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));
        expect(await syncIdpAvatar(sql, { ...USER, picture, issuer: ISSUER })).toBe('rejected');

        expect(queryMocks.setUserIdpAvatar).not.toHaveBeenCalled();
        expect(queryMocks.touchUserIdpAvatar).toHaveBeenCalledWith(sql, USER.userId, source);
        expect(proxyMocks.invalidateAvatarCache).not.toHaveBeenCalled();
    });

    it('does not retry an unreachable picture on the next sign-in', async () => {
        fetchMock.mockImplementation(async () => new Response('busy', { status: 503 }));
        const params = { ...USER, picture: 'https://cdn.example/a.png', issuer: ISSUER };

        expect(await syncIdpAvatar(sql, params)).toBe('unavailable');
        expect(await syncIdpAvatar(sql, params)).toBe('unavailable');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('two concurrent sign-ins share one fetch', async () => {
        fetchMock.mockImplementation(async () => imageResponse(png));
        const params = { ...USER, picture: 'https://cdn.example/a.png', issuer: ISSUER };

        const [a, b] = await Promise.all([syncIdpAvatar(sql, params), syncIdpAvatar(sql, params)]);

        expect([a, b]).toEqual(['stored', 'stored']);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not overwrite a newer picture written meanwhile (compare-and-set lost)', async () => {
        queryMocks.setUserIdpAvatar.mockResolvedValue(false);
        fetchMock.mockImplementation(async () => imageResponse(png));
        const out = await syncIdpAvatar(sql, {
            ...USER,
            picture: 'https://cdn.example/a.png',
            issuer: ISSUER,
        });

        expect(out).toBe('unchanged');
        expect(queryMocks.setUserIdpAvatar).toHaveBeenCalledWith(
            sql,
            USER.userId,
            null,
            expect.objectContaining({ contentType: 'image/webp' }),
        );
        expect(proxyMocks.invalidateAvatarCache).not.toHaveBeenCalled();
    });

    it('refuses a pixel bomb (small file, huge declared dimensions)', async () => {
        const bomb = await sharp({
            create: { width: 5000, height: 4000, channels: 3, background: '#000' },
        })
            .png({ compressionLevel: 9 })
            .toBuffer();
        const picture = `data:image/png;base64,${bomb.toString('base64')}`;
        expect(await syncIdpAvatar(sql, { ...USER, picture, issuer: ISSUER })).toBe('rejected');
    });

    it('clears the stored copy when the IdP stops sending a picture', async () => {
        queryMocks.getUserIdpAvatarState.mockResolvedValue(
            state({ source: 'old', hasData: true, updatedAt: new Date() }),
        );
        const out = await syncIdpAvatar(sql, { ...USER, picture: null, issuer: ISSUER });

        expect(out).toBe('cleared');
        expect(lastWrite()).toEqual({ data: null, contentType: null, source: null });
        expect(proxyMocks.invalidateAvatarCache).toHaveBeenCalledWith('alice');
    });

    it('does nothing without a picture when nothing was stored', async () => {
        expect(await syncIdpAvatar(sql, { ...USER, picture: null, issuer: ISSUER })).toBe(
            'unchanged',
        );
        expect(queryMocks.setUserIdpAvatar).not.toHaveBeenCalled();
    });

    it('never throws, even when the DB read fails', async () => {
        queryMocks.getUserIdpAvatarState.mockRejectedValueOnce(new Error('db down'));
        expect(
            await syncIdpAvatar(sql, {
                ...USER,
                picture: 'https://cdn.example/a.png',
                issuer: ISSUER,
            }),
        ).toBe('unavailable');
    });
});
