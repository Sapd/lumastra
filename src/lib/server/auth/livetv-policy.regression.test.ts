// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import { ApiProblem } from '$lib/server/api/problem.js';
const { read, remote, resync, publish } = vi.hoisted(() => ({
    read: vi.fn(),
    remote: vi.fn(),
    resync: vi.fn(),
    publish: vi.fn(),
}));
const feature = vi.hoisted(() => ({ liveTv: true }));
vi.mock('$lib/server/config.js', () => ({
    config: {
        get FEATURE_LIVETV() {
            return feature.liveTv;
        },
    },
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({ getUserLiveTvAllowed: read }));
vi.mock('$lib/server/cache/auth-cache-bus.js', () => ({
    onRemoteUserLiveTvInvalidate: remote,
    onAuthCacheBusResync: resync,
    publishAuthCacheInvalidation: publish,
}));
beforeEach(() => {
    feature.liveTv = true;
    vi.resetModules();
    vi.clearAllMocks();
    read.mockResolvedValue(true);
});
it('coalesces concurrent and repeated segment policy reads for five seconds', async () => {
    const { userAllowsLiveTv } = await import('./livetv-user-policy.js');
    await Promise.all(Array.from({ length: 8 }, () => userAllowsLiveTv('alice')));
    await userAllowsLiveTv('alice');
    expect(read).toHaveBeenCalledTimes(1);
});
it('invalidates cached decisions on a remote permissions event', async () => {
    const { userAllowsLiveTv } = await import('./livetv-user-policy.js');
    expect(await userAllowsLiveTv('alice')).toBe(true);
    read.mockResolvedValue(false);
    expect(remote).toHaveBeenCalledTimes(1);
    remote.mock.calls[0][0]('alice');
    expect(await userAllowsLiveTv('alice')).toBe(false);
});
it('preserves synthetic service-token capabilities without querying a fake username', async () => {
    read.mockResolvedValue(false);
    const { applyLiveTvUserPolicy } = await import('./livetv-user-policy.js');
    const user = { username: 'service:automation', hasLiveTvPermission: true };
    await applyLiveTvUserPolicy(user, { syntheticIdentity: true });
    expect(user.hasLiveTvPermission).toBe(true);
    expect(read).not.toHaveBeenCalled();
});
it('fails open only for authorized continuation during an outage; a new start fails closed', async () => {
    read.mockRejectedValue(new Error('private database detail'));
    const { userAllowsLiveTv } = await import('./livetv-user-policy.js');
    expect(await userAllowsLiveTv('alice', { continuation: true })).toBe(true);
    expect(await userAllowsLiveTv('alice')).toBe(false);
});
it.each(['/admin/livetv', '/api/admin/livetv/sources', '/api/v1/livetv/admin/sources'])(
    '%s remains an admin capability when the viewing switch is off',
    async (id) => {
        const { liveTvRouteGate } = await import('./livetv-user-policy.js');
        expect(
            liveTvRouteGate({ route: { id }, locals: { user: { hasLiveTvPermission: false } } }),
        ).toBeNull();
    },
);
it('matches the unconfigured response body', async () => {
    const { liveTvRouteGate } = await import('./livetv-user-policy.js');
    const denied = liveTvRouteGate({
        route: { id: '/api/livetv/guide' },
        locals: { user: { hasLiveTvPermission: false } },
    });
    expect(await denied?.json()).toEqual(await ApiProblem.notFound().json());
});
it.each([
    ['DELETE', '/api/livetv/playback-sessions/[playbackSessionId]'],
    ['POST', '/api/v1/livetv/playback-sessions/[playbackSessionId]/leave'],
])('lets %s reach the owner-checked cleanup handler', async (method, id) => {
    const { liveTvRouteGate } = await import('./livetv-user-policy.js');
    expect(
        liveTvRouteGate({
            route: { id },
            request: new Request('http://localhost', { method }),
            locals: { user: { hasLiveTvPermission: false } },
        }),
    ).toBeNull();
});

it('expires cached permission after five seconds and never caches a DB outage', async () => {
    const { userAllowsLiveTv } = await import('./livetv-user-policy.js');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
        expect(await userAllowsLiveTv('alice')).toBe(true);
        now.mockReturnValue(6001);
        read.mockRejectedValueOnce(new Error('unavailable'));
        expect(await userAllowsLiveTv('alice')).toBe(false);
        read.mockResolvedValue(false);
        expect(await userAllowsLiveTv('alice')).toBe(false);
        expect(read).toHaveBeenCalledTimes(3);
    } finally {
        now.mockRestore();
    }
});
it('local writes publish invalidation and do not let an in-flight read restore a stale allow', async () => {
    const { userAllowsLiveTv, invalidateUserLiveTvPolicy } =
        await import('./livetv-user-policy.js');
    let finish!: (allowed: boolean) => void;
    read.mockImplementationOnce(
        () =>
            new Promise<boolean>((resolve) => {
                finish = resolve;
            }),
    );
    const beforeWrite = userAllowsLiveTv('alice');
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    invalidateUserLiveTvPolicy('alice');
    read.mockResolvedValue(false);
    finish(true);
    expect(await beforeWrite).toBe(false);
    expect(publish).toHaveBeenCalledWith({ kind: 'user-live-tv', username: 'alice' });
});

it('an ordinary account cannot bypass the switch by using a service-like username', async () => {
    read.mockResolvedValue(false);
    const { applyLiveTvUserPolicy } = await import('./livetv-user-policy.js');
    const user = { username: 'service:forwarded', hasLiveTvPermission: true };
    await applyLiveTvUserPolicy(user);
    expect(user.hasLiveTvPermission).toBe(false);
    expect(read).toHaveBeenCalledWith(expect.anything(), 'service:forwarded');
});

it('a provisional account first seen without an age cap cannot reuse that allow for its first child request', async () => {
    const { userAllowsLiveTv, applyLiveTvUserPolicy } = await import('./livetv-user-policy.js');
    read.mockImplementation(
        async (_sql: unknown, _username: string, options?: { ageLimited?: boolean }) =>
            options?.ageLimited !== true,
    );
    expect(await userAllowsLiveTv('new-child')).toBe(true);
    const child = { username: 'new-child', hasLiveTvPermission: true, isAgeRestricted: true };
    await applyLiveTvUserPolicy(child);
    expect(child.hasLiveTvPermission).toBe(false);
});

it('B-4: local revocation survives remote clears and resync for 60 seconds of continuation outage', async () => {
    const policy = await import('./livetv-user-policy.js');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
        expect(await policy.userAllowsLiveTv('alice')).toBe(true);
        policy.invalidateUserLiveTvPolicy('ALICE');
        remote.mock.calls[0][0]('alice');
        resync.mock.calls[0][0]();
        read.mockRejectedValue(new Error('down'));
        expect(await policy.userAllowsLiveTv('alice', { continuation: true })).toBe(false);
        expect(await policy.userAllowsLiveTv('unrelated', { continuation: true })).toBe(true);
        now.mockReturnValue(61_001);
        expect(await policy.userAllowsLiveTv('alice', { continuation: true })).toBe(true);
        expect(await policy.userAllowsLiveTv('alice')).toBe(false);
    } finally {
        now.mockRestore();
    }
});
it.each(['remote', 'resync'])(
    'B-4: %s alone does not revoke an unrelated continuation',
    async (kind) => {
        const policy = await import('./livetv-user-policy.js');
        expect(await policy.userAllowsLiveTv('alice')).toBe(true);
        if (kind === 'remote') remote.mock.calls[0][0]('alice');
        else resync.mock.calls[0][0]();
        read.mockRejectedValue(new Error('down'));
        expect(await policy.userAllowsLiveTv('alice', { continuation: true })).toBe(true);
    },
);
it('C-3: feature-off narrows item permissions while retaining synthetic identities and admin configuration', async () => {
    feature.liveTv = false;
    try {
        const policy = await import('./livetv-user-policy.js');
        const user = { username: 'alice', hasLiveTvPermission: true };
        await policy.applyLiveTvUserPolicy(user);
        expect(user.hasLiveTvPermission).toBe(false);
        const synthetic = { username: 'service:automation', hasLiveTvPermission: true };
        await policy.applyLiveTvUserPolicy(synthetic, { syntheticIdentity: true });
        expect(synthetic.hasLiveTvPermission).toBe(true);
        expect(
            policy.liveTvRouteGate({
                route: { id: '/api/admin/livetv/sources' },
                locals: { user },
            }),
        ).toBeNull();
    } finally {
        feature.liveTv = true;
    }
});

it.each(['/admin/livetv', '/api/admin/livetv/sources', '/api/v1/livetv/admin/sources'])(
    'C-3: feature-off preserves permission on %s configuration routes',
    async (routeId) => {
        feature.liveTv = false;
        try {
            const { applyLiveTvUserPolicy } = await import('./livetv-user-policy.js');
            const user = { username: 'alice', hasLiveTvPermission: true };
            await applyLiveTvUserPolicy(user, { routeId });
            expect(user.hasLiveTvPermission).toBe(true);
        } finally {
            feature.liveTv = true;
        }
    },
);

it('B-4: a fresh positive policy read supersedes a local revocation tombstone', async () => {
    const { userAllowsLiveTv, invalidateUserLiveTvPolicy } =
        await import('./livetv-user-policy.js');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
        invalidateUserLiveTvPolicy('alice');
        expect(await userAllowsLiveTv('alice')).toBe(true);
        now.mockReturnValue(6001);
        read.mockRejectedValue(new Error('down'));
        expect(await userAllowsLiveTv('alice', { continuation: true })).toBe(true);
    } finally {
        now.mockRestore();
    }
});
