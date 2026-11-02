// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `getUserAvatar` — the uploaded avatar across replicas.
 *
 * Each web replica has its own disk cache, and an upload or delete purges only
 * the one that handled it. So the `custom-*` key carries the row's version
 * (`avatar_updated_at`), and the cache is read only AFTER the DB said which
 * version is current: a replica holding an older copy — or a copy of an avatar
 * since deleted — misses instead of serving it. Same seams and setup as
 * service.avatar-idp.test.ts, but here the disk cache is a real map.
 */

import originalSharp from 'sharp';
import { runImageProviderBudget } from './work-budget';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetUserAvatar = vi.hoisted(() => vi.fn());
const mockGetUserAvatarVersion = vi.hoisted(() => vi.fn());
const mockGetUserByUsername = vi.hoisted(() => vi.fn());
const mockGetUserById = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserAvatar: mockGetUserAvatar,
    getUserAvatarVersion: mockGetUserAvatarVersion,
    getUserByUsername: mockGetUserByUsername,
    getUserById: mockGetUserById,
}));

// The Jellyfin seam. Jellyfin is "enabled" and every username resolves to a
// fixed GUID, so the Jellyfin step genuinely runs.
const mockFetchWithTimeout = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/fetch-utils.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/fetch-utils.js')>()),
    fetchWithTimeout: mockFetchWithTimeout,
}));

// Mutable, because both gates are LIVE getters in production (an admin flips them
// from settings with no restart) and the negative-cache key folds their state in.
const operationModeState = vi.hoisted(() => ({ isJellyfinEnabled: true }));
vi.mock('$lib/server/operation-mode.js', () => ({
    operationMode: operationModeState,
}));
// The runtime Jellyfin gate (sync flag + reachability + breaker), live in prod.
const gateState = vi.hoisted(() => ({ syncEnabled: true, callable: true }));
vi.mock('$lib/server/jellyfin/runtime-gate.js', () => ({
    JELLYFIN_DIRECT_FETCH_TIMEOUT_MS: 2_500,
    isJellyfinSyncEnabled: () => gateState.syncEnabled,
    canCallJellyfin: () => gateState.syncEnabled && gateState.callable,
    recordJellyfinTransportFailure: vi.fn(),
    recordJellyfinTransportSuccess: vi.fn(),
}));
vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserId: vi.fn().mockResolvedValue('deadbeef-0000-4000-8000-000000000000'),
}));

const configOverrides: Record<string, unknown> = {
    AUTH_OIDC_SYNC_AVATAR: true,
    JELLYFINURL: 'http://jellyfin.invalid',
    JELLYFINAPIKEY: 'token',
    IMAGE_WEBP_ENABLED: false,
    IMAGE_THUMB_QUALITY: 80,
};
const featureOverrides = vi.hoisted(() => ({ gravatar: true }) as Record<string, unknown>);
vi.mock('$lib/server/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config')>();
    return {
        ...actual,
        features: new Proxy(actual.features, {
            get: (target, prop: string) =>
                prop in featureOverrides ? featureOverrides[prop] : target[prop as never],
        }),
        config: new Proxy(actual.config, {
            get: (target, prop: string) =>
                prop in configOverrides ? configOverrides[prop] : target[prop as never],
        }),
    };
});

const { ImageProxyService } = await import('./service');

type AvatarCacheStub = {
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    deleteByPrefix: ReturnType<typeof vi.fn>;
};

/** A service whose disk cache always misses and never writes. */
function makeService() {
    const service = new ImageProxyService(vi.fn() as never);
    const avatarCache: AvatarCacheStub = {
        read: vi.fn(async () => null),
        write: vi.fn(async () => {}),
        deleteByPrefix: vi.fn(async () => {}),
    };
    (service as unknown as { avatarCache: AvatarCacheStub }).avatarCache = avatarCache;
    return { service, avatarCache };
}

/** The stored row both DB reads see (`null` = no stored avatar). */
function storeAvatar(
    row: {
        avatar_data: Buffer;
        avatar_content_type: string;
        source: 'upload' | 'idp';
        version: string | null;
    } | null,
) {
    mockGetUserAvatar.mockResolvedValue(row);
    mockGetUserAvatarVersion.mockResolvedValue(row && { source: row.source, version: row.version });
}

const OLD = Buffer.from('old-upload');
const NEW = Buffer.from('new-upload');

function upload(buffer: Buffer, version: string | null) {
    return {
        avatar_data: buffer,
        avatar_content_type: 'image/webp',
        source: 'upload' as const,
        version,
    };
}

/** makeService() whose disk cache keeps what it is given, like a replica's. */
function makeReplica(seed: Record<string, Buffer> = {}) {
    const { service, avatarCache } = makeService();
    const disk = new Map(Object.entries(seed));
    avatarCache.read.mockImplementation(async (key: string) => disk.get(key) ?? null);
    avatarCache.write.mockImplementation(async (key: string, buf: Buffer) => {
        disk.set(key, buf);
    });
    return { service, avatarCache, disk };
}

describe('ImageProxyService.getUserAvatar — uploaded avatar versions', () => {
    beforeEach(() => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(null, { status: 404 })),
        );
        mockGetUserAvatar.mockReset();
        mockGetUserAvatarVersion.mockReset();
        mockGetUserByUsername.mockReset().mockResolvedValue({ email: 'alice@example.com' });
        mockGetUserById.mockReset().mockResolvedValue(null);
        mockFetchWithTimeout.mockReset().mockResolvedValue(new Response(null, { status: 404 }));
        operationModeState.isJellyfinEnabled = true;
        gateState.syncEnabled = true;
        gateState.callable = true;
        featureOverrides.gravatar = true;
        configOverrides.AUTH_OIDC_SYNC_AVATAR = true;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('charges a small avatar encode on miss and leaves a disk hit free when the budget is exhausted', async () => {
        const source = await originalSharp({
            create: {
                width: 200,
                height: 200,
                channels: 3,
                background: '#998800',
            },
        })
            .webp()
            .toBuffer();
        storeAvatar(upload(source, 'cpu-budget'));
        const { service } = makeReplica();
        const provider = vi.fn<() => Promise<Response | null>>(async () => null);
        const encode = vi.fn<() => Promise<Response | null>>(async () => null);
        const render = async (): Promise<Response> => {
            const image = await service.getUserAvatar('alice', { size: 'thumb' });
            expect(image).not.toBeNull();
            expect((await originalSharp(image!.buffer).metadata()).width).toBe(48);
            return new Response(null, { headers: { 'X-Cache': image!.cacheStatus! } });
        };
        const first = await runImageProviderBudget(provider, render, encode, false);
        expect(first.headers.get('X-Cache')).toBe('MISS');
        expect(encode).toHaveBeenCalledTimes(1);
        encode.mockClear().mockResolvedValue(new Response(null, { status: 429 }));
        const second = await runImageProviderBudget(provider, render, encode, false);
        expect(second.headers.get('X-Cache')).toBe('HIT');
        expect(encode).not.toHaveBeenCalled();
        expect(provider).not.toHaveBeenCalled();
    });

    it('preserves named avatar widths and buckets raw avatar widths before the cache key', async () => {
        const source = await originalSharp({
            create: { width: 200, height: 200, channels: 3, background: 'red' },
        })
            .webp()
            .toBuffer();
        storeAvatar(upload(source, 'width-budget'));
        const { service, disk } = makeReplica();
        await runImageProviderBudget(
            async () => null,
            async () => {
                for (const [size, width] of [
                    ['thumb', 48],
                    ['card', 96],
                    ['full', 200],
                ] as const) {
                    const result = await service.getUserAvatar('alice', { size });
                    expect((await originalSharp(result!.buffer).metadata()).width).toBe(width);
                }
                for (const [width, expected] of [
                    ['1', 48],
                    ['48', 48],
                    ['49', 96],
                    ['96', 96],
                    ['97', 160],
                    ['160', 160],
                    ['161', 200],
                    ['249', 200],
                    ['601', 200],
                    ['3840', 200],
                ] as const) {
                    const result = await service.getUserAvatar('alice', { maxWidth: width });
                    expect((await originalSharp(result!.buffer).metadata()).width).toBe(expected);
                }
                return new Response();
            },
            async () => null,
            false,
        );
        expect(disk.size).toBe(4);
    });

    it('never caches an unresized source when encode admission is denied', async () => {
        const source = await originalSharp({
            create: {
                width: 200,
                height: 200,
                channels: 3,
                background: 'blue',
            },
        })
            .webp()
            .toBuffer();
        storeAvatar(upload(source, 'denied-encode'));
        const { service, disk } = makeReplica();
        const render = async (): Promise<Response> => {
            await service.getUserAvatar('alice', { size: 'thumb' });
            return new Response('avatar');
        };
        const response = await runImageProviderBudget(
            async () => null,
            render,
            async () => new Response(null, { status: 429 }),
            false,
        );
        expect(response.status).toBe(429);
        expect(disk.size).toBe(0);
        const encode = vi.fn(async () => null);
        expect((await runImageProviderBudget(async () => null, render, encode, false)).status).toBe(
            200,
        );
        expect(encode).toHaveBeenCalledTimes(1);
    });

    it('caches an upload under custom-<user>-v<version>-', async () => {
        storeAvatar(upload(NEW, '2000'));
        const { service, disk } = makeReplica();

        expect((await service.getUserAvatar('alice'))?.buffer).toBe(NEW);
        expect([...disk.keys()]).toEqual([expect.stringMatching(/^custom-alice-v2000-q80-w200\./)]);
    });

    it('a hit on the current version never reads the image bytes', async () => {
        storeAvatar(upload(NEW, '2000'));
        const { service } = makeReplica();
        await service.getUserAvatar('alice');
        mockGetUserAvatar.mockClear();

        const result = await service.getUserAvatar('alice');

        expect(result?.buffer).toEqual(NEW);
        expect(result?.cacheStatus).toBe('HIT');
        expect(mockGetUserAvatarVersion).toHaveBeenCalledTimes(2);
        expect(mockGetUserAvatar).not.toHaveBeenCalled();
    });

    it('a replica that cached the old upload serves the new one (it never got the purge)', async () => {
        storeAvatar(upload(OLD, '1000'));
        const { service, disk } = makeReplica();
        await service.getUserAvatar('alice');

        // Re-uploaded through the OTHER replica: the row moves, this cache does not.
        storeAvatar(upload(NEW, '2000'));
        const result = await service.getUserAvatar('alice');

        expect(result?.buffer).toBe(NEW);
        expect(result?.cacheStatus).toBe('MISS');
        expect(disk.size).toBe(2);
    });

    it('a replica that cached an upload since deleted elsewhere does not serve it', async () => {
        storeAvatar(upload(OLD, '1000'));
        const { service, avatarCache } = makeReplica();
        await service.getUserAvatar('alice');

        storeAvatar(null);
        avatarCache.read.mockClear();
        const result = await service.getUserAvatar('alice');

        // Fell through to Jellyfin and Gravatar, both of which 404.
        expect(result).toBeNull();
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
        const read = avatarCache.read.mock.calls.map((c) => String(c[0]));
        expect(read.some((k) => k.startsWith('custom-'))).toBe(false);
    });

    it('an upload made before versioning reads as v0', async () => {
        storeAvatar(upload(OLD, null));
        const { service, disk } = makeReplica();

        await service.getUserAvatar('alice');

        expect([...disk.keys()][0]).toMatch(/^custom-alice-v0-/);
    });

    it('files the bytes under the version read WITH them, not the earlier lookup', async () => {
        // The upload lands between the version-only read and the bytes read.
        mockGetUserAvatarVersion.mockResolvedValue({ source: 'upload', version: '1000' });
        mockGetUserAvatar.mockResolvedValue(upload(NEW, '2000'));
        const { service, disk } = makeReplica();

        expect((await service.getUserAvatar('alice'))?.buffer).toBe(NEW);
        expect([...disk.keys()]).toEqual([expect.stringMatching(/^custom-alice-v2000-/)]);
    });

    it('an upload elsewhere shows through this replica\'s "no avatar" negative entry', async () => {
        storeAvatar(null);
        const { service } = makeReplica();
        expect(await service.getUserAvatar('alice')).toBeNull();
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);

        // No invalidateAvatarCache on THIS replica: the PUT went to the other one.
        storeAvatar(upload(NEW, '2000'));
        expect((await service.getUserAvatar('alice'))?.buffer).toBe(NEW);
        // ...and the negative entry still spares the network sources.
        storeAvatar(null);
        expect(await service.getUserAvatar('alice')).toBeNull();
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('with the DB down, a cached upload is not served and a fallback is cached briefly', async () => {
        const { service, avatarCache } = makeReplica({
            'custom-alice-v1000-q80-w200.jpg': OLD,
        });
        mockGetUserAvatarVersion.mockRejectedValue(new Error('pool exhausted'));
        vi.mocked(globalThis.fetch).mockResolvedValue(
            new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
        );

        const result = await service.getUserAvatar('alice');

        // Gravatar stood in. It may be standing in for an upload the DB could
        // not confirm, so the browser must not keep it for 48 h.
        expect(result?.buffer).toEqual(Buffer.from([1, 2, 3]));
        expect(result?.cacheControl).toBe('public, max-age=60');
        expect(mockGetUserAvatar).not.toHaveBeenCalled();
        const read = avatarCache.read.mock.calls.map((c) => String(c[0]));
        expect(read.some((k) => k.startsWith('custom-'))).toBe(false);
    });

    it('a bytes read that fails after the version read also caches the fallback briefly', async () => {
        const { service } = makeReplica();
        mockGetUserAvatarVersion.mockResolvedValue({ source: 'upload', version: '1000' });
        mockGetUserAvatar.mockRejectedValue(new Error('statement timeout'));
        vi.mocked(globalThis.fetch).mockResolvedValue(
            new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
        );

        const result = await service.getUserAvatar('alice');

        expect(result?.buffer).toEqual(Buffer.from([1, 2, 3]));
        expect(result?.cacheControl).toBe('public, max-age=60');
    });

    it('invalidateAvatarCache still reaches every versioned custom-* entry', async () => {
        const { service, avatarCache } = makeReplica();
        await service.invalidateAvatarCache('alice');
        const prefixes = avatarCache.deleteByPrefix.mock.calls.map((c) => String(c[0]));
        expect(prefixes).toContain('custom-alice-');
    });
});
