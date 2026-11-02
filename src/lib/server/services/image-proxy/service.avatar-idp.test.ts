// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `getUserAvatar` — the picture synced from the OIDC provider.
 *
 * Chain: upload → IdP → Jellyfin → Gravatar. The IdP copy comes back from the
 * same DB reads as the upload (`getUserAvatarVersion` / `getUserAvatar`, both
 * with `{ includeIdp }`), so the seams here are those queries' arguments, the
 * disk-cache keys, and whether the Jellyfin / Gravatar fetches ran at all. Setup mirrors
 * service.avatar-negative-cache.test.ts.
 */

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

const UPLOAD = Buffer.from('upload-bytes');
const IDP = Buffer.from('idp-bytes');

describe('ImageProxyService.getUserAvatar — IdP picture', () => {
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

    it('serves the IdP picture before Jellyfin and Gravatar, under its own cache key', async () => {
        storeAvatar({
            avatar_data: IDP,
            avatar_content_type: 'image/webp',
            source: 'idp',
            version: '1759300000000',
        });
        const { service, avatarCache } = makeService();

        const result = await service.getUserAvatar('alice');

        expect(result?.buffer).toBe(IDP);
        expect(mockGetUserAvatar).toHaveBeenCalledWith(expect.anything(), 'alice', {
            includeIdp: true,
        });
        expect(mockFetchWithTimeout).not.toHaveBeenCalled();
        expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
        const written = avatarCache.write.mock.calls.map((c) => String(c[0]));
        expect(written).toHaveLength(1);
        expect(written[0]).toMatch(/^idp-alice-v1759300000000-/);
    });

    it('a newer IdP picture misses an older cached one (other replicas never got the purge)', async () => {
        const { service, avatarCache } = makeService();
        avatarCache.read.mockImplementation(async (key: string) =>
            key.includes('-v1000-') ? Buffer.from('stale') : null,
        );
        storeAvatar({
            avatar_data: IDP,
            avatar_content_type: 'image/webp',
            source: 'idp',
            version: '2000',
        });

        expect((await service.getUserAvatar('alice'))?.buffer).toBe(IDP);
    });

    it('an upload is cached under custom-*, never idp-*', async () => {
        storeAvatar({
            avatar_data: UPLOAD,
            avatar_content_type: 'image/webp',
            source: 'upload',
            version: '1000',
        });
        const { service, avatarCache } = makeService();

        expect((await service.getUserAvatar('alice'))?.buffer).toBe(UPLOAD);
        expect(String(avatarCache.write.mock.calls[0][0])).toMatch(/^custom-alice-/);
    });

    it('with AUTH_OIDC_SYNC_AVATAR off the IdP copy is not asked for', async () => {
        configOverrides.AUTH_OIDC_SYNC_AVATAR = false;
        storeAvatar(null);
        const { service } = makeService();

        expect(await service.getUserAvatar('alice')).toBeNull();
        expect(mockGetUserAvatarVersion).toHaveBeenCalledWith(expect.anything(), 'alice', {
            includeIdp: false,
        });
        // Fell through to the remaining sources.
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('invalidateAvatarCache drops the idp-* entries too', async () => {
        const { service, avatarCache } = makeService();
        await service.invalidateAvatarCache('alice');
        const prefixes = avatarCache.deleteByPrefix.mock.calls.map((c) => String(c[0]));
        expect(prefixes).toContain('idp-alice-');
        expect(prefixes).toContain('custom-alice-');
    });
});
