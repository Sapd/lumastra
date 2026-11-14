// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the per-user index over Jellyfin-compat sessions — the layer
// that makes "which clients am I signed in on?" answerable, and individually
// revocable, from settings.
//
// Backed by an in-memory stand-in for the Valkey helpers, so the tests exercise
// the real index/prune/ownership logic rather than a mocked version of it.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { store, sets, scanImpl } = vi.hoisted(() => ({
    store: new Map<string, string>(),
    sets: new Map<string, Set<string>>(),
    scanImpl: { shouldThrow: false, onIndex: null as null | (() => Promise<void>) },
}));

vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: async (key: string) => store.get(key) ?? null,
    cacheGetOrThrow: async (key: string) => {
        if (scanImpl.shouldThrow)
            throw Object.assign(new Error('Valkey unavailable'), { code: 'ECONNREFUSED' });
        return store.get(key) ?? null;
    },
    cacheSet: async (key: string, value: string) => {
        store.set(key, value);
        return true;
    },
    cacheDel: async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        let n = 0;
        for (const k of keys) {
            if (store.delete(k)) n++;
            if (sets.delete(k)) n++;
        }
        return n;
    },
    cacheExists: async (key: string) => store.has(key),
    expire: async () => true,
    sAdd: async (key: string, ...members: string[]) => {
        const set = sets.get(key) ?? new Set<string>();
        sets.set(key, set);
        let added = 0;
        for (const mem of members) {
            if (!set.has(mem)) {
                set.add(mem);
                added++;
            }
        }
        if (scanImpl.onIndex) {
            const hook = scanImpl.onIndex;
            scanImpl.onIndex = null;
            await hook();
        }
        return added;
    },
    sRem: async (key: string, ...members: string[]) => {
        const set = sets.get(key);
        if (!set) return 0;
        let removed = 0;
        for (const mem of members) if (set.delete(mem)) removed++;
        return removed;
    },
    sMembers: async (key: string) => Array.from(sets.get(key) ?? []),
    getCoordinationClient: () => ({
        scan: async (cursor: string, opts: { match: string }) => {
            if (scanImpl.shouldThrow) throw new Error('scan unavailable');
            if (cursor !== '0') return ['0', []];
            const prefix = opts.match.replace(/\*$/, '');
            return ['0', Array.from(store.keys()).filter((k) => k.startsWith(prefix))];
        },
    }),
}));

// The session helpers never touch Postgres; stub the module graph so importing
// auth.ts doesn't pull a real connection into a unit test.
vi.mock('$lib/server/database/connection', () => ({
    Database: class {
        getSql() {
            throw new Error('database access not expected in session tests');
        }
    },
}));

// Security review 2026-09-16, C5: createSession() now denies a mint for a
// disabled/deleted/unresolvable account via resolveTokenUserAccess(). This
// file is about the session-index/prune/ownership logic, not that check
// (which has its own dedicated coverage in auth.test.ts and the
// AuthenticateWithQuickConnect route test) — mock it to unconditionally
// report an active, resolvable account so every createSession() call here
// keeps minting a real token.
vi.mock('$lib/server/auth/resolve-token-user-access', () => ({
    resolveTokenUserAccess: async () => ({
        userGroups: [] as string[],
        disabled: false,
        deleted: false,
        permissions: {} as never,
    }),
}));

const {
    createSession,
    validateSession,
    listSessionsForUser,
    revokeSession,
    revokeSessionForUser,
    revokeSessionsForUser,
} = await import('./auth.js');

const SESSION_PREFIX = 'jfcompat:session:';

function sessionFor(userId: string, deviceName: string, createdAt = '2026-07-01T00:00:00.000Z') {
    return {
        userId,
        username: 'denis',
        isAdmin: false,
        groups: [],
        displayName: null,
        deviceId: `dev-${deviceName}`,
        deviceName,
        clientName: 'Swiftfin',
        clientVersion: '1.2.3',
        createdAt,
    };
}

beforeEach(() => {
    store.clear();
    sets.clear();
    scanImpl.shouldThrow = false;
    scanImpl.onIndex = null;
});

describe('jfcompat session index', () => {
    it('distinguishes a Valkey outage from a missing session and recovers the same token', async () => {
        const token = await createSession(sessionFor('u1', 'iPhone'));
        expect(token).not.toBeNull();
        scanImpl.shouldThrow = true;
        await expect(validateSession(token!)).rejects.toMatchObject({
            name: 'AuthDependencyUnavailableError',
        });
        scanImpl.shouldThrow = false;
        expect(await validateSession(token!)).toMatchObject({ userId: 'u1' });
        expect(await validateSession('missing')).toBeNull();
    });

    it('lists the sessions a user created, newest first', async () => {
        await createSession(sessionFor('u1', 'iPhone', '2026-07-01T00:00:00.000Z'));
        await createSession(sessionFor('u1', 'AppleTV', '2026-07-05T00:00:00.000Z'));

        const items = await listSessionsForUser('u1');

        expect(items.map((i) => i.deviceName)).toEqual(['AppleTV', 'iPhone']);
        expect(items[0].clientName).toBe('Swiftfin');
        expect(items[0].clientVersion).toBe('1.2.3');
    });

    it('never exposes the session token itself', async () => {
        await createSession(sessionFor('u1', 'iPhone'));

        const token = Array.from(store.keys())
            .find((k) => k.startsWith(SESSION_PREFIX))!
            .slice(SESSION_PREFIX.length);
        const [item] = await listSessionsForUser('u1');

        // The handle must not be the token, nor contain it — otherwise the
        // settings page would be handing out a replayable AccessToken.
        expect(item.id).not.toBe(token);
        expect(token).not.toContain(item.id);
    });

    it('does not leak another user’s sessions', async () => {
        await createSession(sessionFor('u1', 'iPhone'));
        await createSession(sessionFor('u2', 'Android'));

        expect((await listSessionsForUser('u1')).map((i) => i.deviceName)).toEqual(['iPhone']);
        expect((await listSessionsForUser('u2')).map((i) => i.deviceName)).toEqual(['Android']);
    });

    it('drops index entries whose session key has expired', async () => {
        await createSession(sessionFor('u1', 'iPhone'));
        await createSession(sessionFor('u1', 'AppleTV'));

        // Simulate the 30-day TTL firing on one session: Valkey cannot expire
        // individual set members, so the index still lists it.
        const expired = Array.from(store.keys()).find((k) => store.get(k)!.includes('iPhone'))!;
        store.delete(expired);

        const items = await listSessionsForUser('u1');
        expect(items.map((i) => i.deviceName)).toEqual(['AppleTV']);
        // ...and the stale member is pruned, not re-checked forever.
        expect(sets.get('jfcompat:user-sessions:u1')!.size).toBe(1);
    });

    it('revokes a single client by handle, leaving the others signed in', async () => {
        await createSession(sessionFor('u1', 'iPhone', '2026-07-01T00:00:00.000Z'));
        await createSession(sessionFor('u1', 'AppleTV', '2026-07-05T00:00:00.000Z'));

        const items = await listSessionsForUser('u1');
        const target = items.find((i) => i.deviceName === 'iPhone')!;

        expect(await revokeSessionForUser('u1', target.id)).toBe(true);
        expect((await listSessionsForUser('u1')).map((i) => i.deviceName)).toEqual(['AppleTV']);
    });

    it('refuses a handle belonging to a different user', async () => {
        await createSession(sessionFor('u1', 'iPhone'));
        await createSession(sessionFor('u2', 'Android'));

        const [victim] = await listSessionsForUser('u2');

        expect(await revokeSessionForUser('u1', victim.id)).toBe(false);
        expect(await listSessionsForUser('u2')).toHaveLength(1);
    });

    it('reports false for an unknown handle instead of silently succeeding', async () => {
        await createSession(sessionFor('u1', 'iPhone'));
        expect(await revokeSessionForUser('u1', 'not-a-real-handle')).toBe(false);
    });

    it('prunes the index when a session is revoked by token', async () => {
        await createSession(sessionFor('u1', 'iPhone'));
        const token = Array.from(store.keys())
            .find((k) => k.startsWith(SESSION_PREFIX))!
            .slice(SESSION_PREFIX.length);

        await revokeSession(token);

        expect(sets.get('jfcompat:user-sessions:u1')?.size ?? 0).toBe(0);
        expect(await listSessionsForUser('u1')).toEqual([]);
    });

    it('clears the index when every session is revoked', async () => {
        await createSession(sessionFor('u1', 'iPhone'));
        await createSession(sessionFor('u1', 'AppleTV'));

        expect(await revokeSessionsForUser('u1')).toBe(2);
        expect(await listSessionsForUser('u1')).toEqual([]);
    });

    it('backfills sessions that were created before the index existed', async () => {
        // A pre-index session: the session key exists, but nothing indexed it.
        store.set(SESSION_PREFIX + 'legacytoken', JSON.stringify(sessionFor('u1', 'OldClient')));

        const items = await listSessionsForUser('u1');

        expect(items.map((i) => i.deviceName)).toEqual(['OldClient']);
    });

    it('retries the backfill after a failed SCAN rather than hiding sessions forever', async () => {
        store.set(SESSION_PREFIX + 'legacytoken', JSON.stringify(sessionFor('u1', 'OldClient')));

        scanImpl.shouldThrow = true;
        expect(await listSessionsForUser('u1')).toEqual([]);

        // The "already backfilled" marker must NOT have been set by the failed
        // attempt, or the session would stay invisible until it re-paired.
        scanImpl.shouldThrow = false;
        expect((await listSessionsForUser('u1')).map((i) => i.deviceName)).toEqual(['OldClient']);
    });
});

it.each(['token', 'handle'])(
    'revoking a parent by %s removes Quick Connect children',
    async (mode) => {
        const parent = (await createSession(sessionFor('u1', 'phone')))!;
        const { createHash } = await import('node:crypto');
        const parentHandle = createHash('sha256').update(parent).digest('hex').slice(0, 32);
        const child = (await createSession({
            ...sessionFor('u1', 'TV'),
            origin: 'quick_connect',
            approvedBySessionToken: parent,
        }))!;
        await createSession(sessionFor('u1', 'unrelated'));
        if (mode === 'token') await revokeSession(parent);
        else await revokeSessionForUser('u1', parentHandle);
        expect(await validateSession(child)).toBeNull();
        expect((await listSessionsForUser('u1')).map((s) => s.deviceName)).toEqual(['unrelated']);
    },
);

it('an approved Quick Connect secret cannot mint after its parent was revoked', async () => {
    const parent = (await createSession(sessionFor('u1', 'phone')))!;
    await revokeSession(parent);
    expect(
        await createSession({
            ...sessionFor('u1', 'late-TV'),
            origin: 'quick_connect',
            approvedBySessionToken: parent,
        }),
    ).toBeNull();
});

it('natural parent expiry does not shorten the already minted child lifetime', async () => {
    const parent = (await createSession(sessionFor('u1', 'phone')))!;
    const child = (await createSession({
        ...sessionFor('u1', 'TV'),
        origin: 'quick_connect',
        approvedBySessionToken: parent,
    }))!;
    store.delete(SESSION_PREFIX + parent);
    expect(await validateSession(child)).toMatchObject({ deviceName: 'TV' });
});

it('refuses a mint when its parent is revoked while the child is being indexed', async () => {
    const parent = (await createSession(sessionFor('u1', 'phone')))!;
    scanImpl.onIndex = async () => {
        await revokeSession(parent);
    };
    expect(
        await createSession({
            ...sessionFor('u1', 'racing-TV'),
            origin: 'quick_connect',
            approvedBySessionToken: parent,
        }),
    ).toBeNull();
    expect(await listSessionsForUser('u1')).toEqual([]);
});
