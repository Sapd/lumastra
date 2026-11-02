// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `getUserAvatar` negative cache.
 *
 * A user with no custom upload, no Jellyfin picture and no Gravatar produced
 * `null`, and null was never cached — so every request re-ran the Jellyfin HTTP
 * fetch AND the Gravatar HTTPS fetch (10 s timeout). /admin/users draws one
 * avatar per row, so N avatar-less users cost N upstream fetch pairs per page
 * view.
 *
 * Assertions are at the two network SEAMS — `fetchWithTimeout` (Jellyfin) and
 * `globalThis.fetch` (Gravatar) — not at the service method's return value: the
 * return value was already `null` before the fix, so counting it proves nothing.
 * What changed is how many upstream calls reaching that `null` costs.
 *
 * The disk cache is replaced per-instance (`avatarCache`) rather than by mocking
 * `./cache`, so the test neither reads nor writes the checkout's real
 * `.cache/user-avatars` directory — a prior run's write would otherwise poison a
 * later run's "cache miss" premise, since disk state outlives the process.
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

/** Number of Gravatar attempts, i.e. calls that actually left for gravatar.com. */
function gravatarCalls(): number {
    return vi.mocked(globalThis.fetch).mock.calls.length;
}

describe('ImageProxyService.getUserAvatar — negative cache', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(null, { status: 404 })),
        );
        // No custom upload, an email on file (so Gravatar is actually attempted),
        // and no users.id row (the GUID branch is not under test here).
        mockGetUserAvatar.mockReset().mockResolvedValue(null);
        mockGetUserAvatarVersion.mockReset().mockResolvedValue(null);
        mockGetUserByUsername.mockReset().mockResolvedValue({ email: 'nobody@example.com' });
        mockGetUserById.mockReset().mockResolvedValue(null);
        // Jellyfin answers "this user has no primary image".
        mockFetchWithTimeout.mockReset().mockResolvedValue(new Response(null, { status: 404 }));
        operationModeState.isJellyfinEnabled = true;
        gateState.syncEnabled = true;
        gateState.callable = true;
        featureOverrides.gravatar = true;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('a repeat request for an avatar-less user hits neither Jellyfin nor Gravatar', async () => {
        const { service } = makeService();

        expect(await service.getUserAvatar('nobody')).toBeNull();
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
        expect(gravatarCalls()).toBe(1);

        // Second call: same answer, no upstream traffic.
        expect(await service.getUserAvatar('nobody')).toBeNull();
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
        expect(gravatarCalls()).toBe(1);

        // ...and a different width, which mints a different DISK cache key, must
        // not re-probe either: "has no avatar anywhere" is a property of the user,
        // not of the derivative asked for.
        expect(await service.getUserAvatar('nobody', { maxWidth: '48' })).toBeNull();
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
        expect(gravatarCalls()).toBe(1);
    });

    it('invalidateAvatarCache re-opens the sources, so an upload is visible at once', async () => {
        const { service } = makeService();

        await service.getUserAvatar('nobody');
        await service.getUserAvatar('nobody');
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
        expect(gravatarCalls()).toBe(1);

        await service.invalidateAvatarCache('nobody');

        expect(await service.getUserAvatar('nobody')).toBeNull();
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
        expect(gravatarCalls()).toBe(2);
    });

    it('the entry is case-folded on both the read and the invalidation', async () => {
        const { service } = makeService();

        await service.getUserAvatar('Nobody');
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);

        // Read side: a different spelling still hits the same entry.
        await service.getUserAvatar('NOBODY');
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);

        // Invalidation side: the PUT handler invalidates with `user.username` from
        // the DB, which need not match the spelling the image request used.
        await service.invalidateAvatarCache('nobody');

        await service.getUserAvatar('Nobody');
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    });

    it('the custom-upload lookup stays live behind the short-circuit', async () => {
        const { service } = makeService();

        await service.getUserAvatar('nobody');
        expect(mockGetUserAvatarVersion).toHaveBeenCalledTimes(1);

        // The negative entry skips the two NETWORK steps, not the cheap indexed
        // query — so an upload that somehow reaches the DB without invalidating
        // still shows up rather than being hidden for the whole TTL.
        mockGetUserAvatarVersion.mockResolvedValue({ source: 'upload', version: '1000' });
        mockGetUserAvatar.mockResolvedValue({
            avatar_data: Buffer.from('png'),
            avatar_content_type: 'image/png',
            source: 'upload',
            version: '1000',
        });

        const result = await service.getUserAvatar('nobody');
        expect(result?.contentType).toBe('image/png');
        expect(mockGetUserAvatarVersion).toHaveBeenCalledTimes(2);
        // Still no second round of upstream traffic.
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('a confirmed miss survives 30 s; a Jellyfin outage does not', async () => {
        // Confirmed: both sources answered, both said no → the 10-minute TTL.
        const confirmed = makeService().service;
        await confirmed.getUserAvatar('nobody');
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + 30_000);
        await confirmed.getUserAvatar('nobody');
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);

        // Transient: Jellyfin 503, so the miss is not a statement about the user →
        // the 15-second TTL, and the same 30 s re-probes.
        mockFetchWithTimeout.mockReset().mockResolvedValue(new Response(null, { status: 503 }));
        const transient = makeService().service;
        await transient.getUserAvatar('nobody');
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);

        vi.setSystemTime(Date.now() + 30_000);
        await transient.getUserAvatar('nobody');
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    });

    it('a Gravatar network failure is not cached as long as a Gravatar 404', async () => {
        // Control: a 404 is Gravatar's own answer (we ask for d=404) and holds for
        // the long TTL — 30 s later, still no second attempt.
        const confirmed = makeService().service;
        await confirmed.getUserAvatar('nobody');
        expect(gravatarCalls()).toBe(1);
        vi.setSystemTime(Date.now() + 30_000);
        await confirmed.getUserAvatar('nobody');
        expect(gravatarCalls()).toBe(1);

        // A connection failure is not an answer, so it must expire quickly.
        vi.mocked(globalThis.fetch)
            .mockReset()
            .mockRejectedValue(new Error('ECONNRESET') as never);
        const transient = makeService().service;
        await transient.getUserAvatar('nobody');
        expect(gravatarCalls()).toBe(1);
        vi.setSystemTime(Date.now() + 30_000);
        await transient.getUserAvatar('nobody');
        expect(gravatarCalls()).toBe(2);
    });
});

/**
 * Edge cases found by an edge-case-hunter review of the first cut. Each of these
 * is a way to reach `return null` that the first version filed under the long
 * "confirmed" TTL although nothing about the user had actually been established,
 * or an entry no invalidation could reach.
 */
describe('ImageProxyService.getUserAvatar — negative cache, misclassified misses', () => {
    const JELLYFIN_GUID = 'deadbeef-0000-4000-8000-000000000000';

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(null, { status: 404 })),
        );
        mockGetUserAvatar.mockReset().mockResolvedValue(null);
        mockGetUserAvatarVersion.mockReset().mockResolvedValue(null);
        mockGetUserByUsername.mockReset().mockResolvedValue({ email: 'nobody@example.com' });
        mockGetUserById.mockReset().mockResolvedValue(null);
        mockFetchWithTimeout.mockReset().mockResolvedValue(new Response(null, { status: 404 }));
        operationModeState.isJellyfinEnabled = true;
        gateState.syncEnabled = true;
        gateState.callable = true;
        featureOverrides.gravatar = true;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it.each([401, 403, 500, 429])(
        'a Jellyfin %i is a config/outage fault, not a fact about the user',
        async (status) => {
            mockFetchWithTimeout.mockResolvedValue(new Response(null, { status }));
            const { service } = makeService();

            await service.getUserAvatar('nobody');
            expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);

            // A rotated admin token blanks avatars for EVERY user; if that earned
            // the 10-minute TTL, fixing the token would not restore them for 10
            // more minutes.
            vi.setSystemTime(Date.now() + 30_000);
            await service.getUserAvatar('nobody');
            expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
        },
    );

    it('a Gravatar 403 (WAF / IP block) is not the same answer as a 404', async () => {
        vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 403 }));
        const { service } = makeService();

        await service.getUserAvatar('nobody');
        expect(gravatarCalls()).toBe(1);

        vi.setSystemTime(Date.now() + 30_000);
        await service.getUserAvatar('nobody');
        expect(gravatarCalls()).toBe(2);
    });

    it('a DB error during the Gravatar email lookup degrades instead of throwing', async () => {
        mockGetUserByUsername.mockRejectedValue(new Error('pool exhausted'));
        const { service } = makeService();

        // Unguarded, this threw straight out of getUserAvatar → 500 on an avatar.
        await expect(service.getUserAvatar('nobody')).resolves.toBeNull();

        // And it is a non-answer, so it must not hold for the long TTL.
        vi.setSystemTime(Date.now() + 30_000);
        await service.getUserAvatar('nobody');
        expect(mockGetUserByUsername).toHaveBeenCalledTimes(2);
    });

    it('enabling Gravatar takes effect at once, even with a live entry', async () => {
        featureOverrides.gravatar = false;
        const { service } = makeService();

        await service.getUserAvatar('nobody');
        expect(gravatarCalls()).toBe(0);

        // An operator flips the flag in settings — no restart. The entry recorded a
        // moment ago never consulted Gravatar, so it is not evidence about this
        // request and must not suppress the probe.
        featureOverrides.gravatar = true;
        await service.getUserAvatar('nobody');
        expect(gravatarCalls()).toBe(1);
    });

    it('enabling Jellyfin sync takes effect at once, even with a live entry', async () => {
        gateState.syncEnabled = false;
        const { service } = makeService();

        await service.getUserAvatar('nobody');
        expect(mockFetchWithTimeout).not.toHaveBeenCalled();

        gateState.syncEnabled = true;
        await service.getUserAvatar('nobody');
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('Jellyfin sync off: URL + key still set, yet no Jellyfin request', async () => {
        gateState.syncEnabled = false;
        const { service } = makeService();

        await service.getUserAvatar('nobody');
        expect(mockFetchWithTimeout).not.toHaveBeenCalled();
        // Gravatar still answers for the user.
        expect(gravatarCalls()).toBe(1);
    });

    it('Jellyfin down / breaker open: no request, and the miss stays short-lived', async () => {
        gateState.callable = false;
        const { service } = makeService();

        await service.getUserAvatar('nobody');
        expect(mockFetchWithTimeout).not.toHaveBeenCalled();

        // Jellyfin comes back: an outage is not a fact about the user, so the
        // next request after the short TTL probes it.
        gateState.callable = true;
        vi.setSystemTime(Date.now() + 30_000);
        await service.getUserAvatar('nobody');
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('sync on + reachable: fetches with the short image timeout', async () => {
        const { service } = makeService();

        await service.getUserAvatar('nobody');
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
        expect(mockFetchWithTimeout.mock.calls[0][2]).toBe(2_500);
        expect(mockFetchWithTimeout.mock.calls[0][1]).toEqual({
            headers: {
                Authorization: expect.stringMatching(
                    /^MediaBrowser Client="Lumastra", .*Token="token"$/,
                ),
            },
        });
    });

    it('a GUID handle no username can be recovered for is never cached', async () => {
        // A raw Jellyfin GUID: getUserById finds no users.id row (the service's own
        // doc comment names this case), resolveUserId returns it unchanged without
        // populating the username→GUID map, so the reverse lookup finds nothing.
        const { service } = makeService();

        await service.getUserAvatar(JELLYFIN_GUID);
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);

        // invalidateAvatarCache is only ever called with `user.username`, so an
        // entry under the bare GUID could never be cleared — it would outlive a
        // real upload for the full TTL. Better to re-probe than to go blind.
        await service.getUserAvatar(JELLYFIN_GUID);
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    });

    it('a GUID handle WITH a known username is cached, and the username clears it', async () => {
        const { service } = makeService();

        // Warm the username→GUID map the way a normal username request does, so the
        // GUID request below can reverse it.
        await service.getUserAvatar('nobody');
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);

        // The first GUID request still probes: the read keys on the handle the
        // CALLER used, and the username→GUID reversal only happens further down, so
        // it cannot hit the entry the username request wrote. It does now record
        // under both handles, the GUID one included.
        await service.getUserAvatar(JELLYFIN_GUID);
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);

        // ...so the NEXT GUID request short-circuits.
        await service.getUserAvatar(JELLYFIN_GUID);
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);

        // An upload invalidates by username; the GUID caller must see it too —
        // invalidateAvatarCache reaches the GUID key via usernameToGuidCache.
        await service.invalidateAvatarCache('nobody');
        await service.getUserAvatar(JELLYFIN_GUID);
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3);
    });
});
