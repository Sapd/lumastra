// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-user AudiobookShelf credential resolution.
 *
 * Two credential-resolution behaviours can otherwise cause silent failures:
 *
 *  1. `POST /api/api-keys` WITHOUT an explicit `isActive` returns HTTP 200 and a
 *     real-looking key whose `isActive` is `false`. That key then 401s on every
 *     request. Measured directly: omitted → `isActive: false` → `/api/me` 401;
 *     `isActive: true` → `/api/me` 200 scoped to the right user.
 *  2. ABS usernames need not be lowercase. A `===` match against a
 *     lowercased Lumastra username silently links nobody — the exact shape of
 *     bug this integration keeps producing (a correctly-typed comparison that
 *     never fires).
 */

import { describe, it, expect, vi } from 'vitest';
import {
    matchAbsUser,
    forgetUserApiKey,
    resolveUserApiKey,
    unlinkUserApiKey,
    PULL_DISABLED_SECRET,
    type AbsUserSummary,
    type AbsCredentialDeps,
    type AbsApiKeyInfo,
} from './audiobookshelf-credentials.service.js';

/** Synthetic accounts covering case and Unicode differences. */
const ABS_USERS: AbsUserSummary[] = [
    { id: 'u-testuser', username: 'testuser' },
    { id: 'u-testguest', username: 'Testguest' },
    { id: 'u-testmember', username: 'Testmember' },
    { id: 'u-testviewer', username: 'Téstviewer' },
    { id: 'u-testlistener', username: 'testlistener' },
];

function makeDeps(overrides: Partial<AbsCredentialDeps> = {}): AbsCredentialDeps {
    return {
        listUsers: vi.fn(async () => ABS_USERS),
        createApiKey: vi.fn(async () => ({ id: 'key-1', apiKey: 'tok-1', isActive: true })),
        deactivateApiKey: vi.fn(async () => {}),
        listApiKeys: vi.fn(async () => [] as AbsApiKeyInfo[]),
        ...overrides,
    };
}

function makeSecrets(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    return {
        store,
        getUserRaw: vi.fn(
            async (_p: string, userId: string, key: string) =>
                store.get(`${userId}:${key}`) ?? null,
        ),
        setUser: vi.fn(async (_p: string, userId: string, key: string, value: string) => {
            store.set(`${userId}:${key}`, value);
        }),
        deleteUser: vi.fn(async (_p: string, userId: string, key: string) => {
            store.delete(`${userId}:${key}`);
        }),
    };
}

describe('matchAbsUser', () => {
    it('matches an exactly-equal username', () => {
        expect(matchAbsUser(ABS_USERS, 'testuser')?.id).toBe('u-testuser');
    });

    it('matches across case — ABS usernames are not lowercase', () => {
        expect(matchAbsUser(ABS_USERS, 'testguest')?.id).toBe('u-testguest');
        expect(matchAbsUser(ABS_USERS, 'TESTMEMBER')?.id).toBe('u-testmember');
    });

    it('matches a non-ASCII username across case and Unicode normalisation', () => {
        // 'Téstviewer' composed (U+00E9) vs decomposed (e + U+0301) compare unequal
        // under ===, and a German library is exactly where this shows up.
        const decomposed = 'Téstviewer'.toLowerCase();
        expect(matchAbsUser(ABS_USERS, decomposed)?.id).toBe('u-testviewer');
        expect(matchAbsUser(ABS_USERS, 'téstviewer')?.id).toBe('u-testviewer');
    });

    it('ignores surrounding whitespace', () => {
        expect(matchAbsUser(ABS_USERS, '  testuser  ')?.id).toBe('u-testuser');
    });

    it('returns null for an account with no ABS counterpart', () => {
        expect(matchAbsUser(ABS_USERS, 'nobody')).toBeNull();
    });

    it('does not substring-match a different account', () => {
        // 'test' must not resolve to 'testuser'.
        expect(matchAbsUser(ABS_USERS, 'test')).toBeNull();
    });

    it('returns null rather than guessing when two accounts fold together', () => {
        // ABS allows 'Testuser' and 'testuser' to coexist; picking one at random would
        // link a user to somebody else's listening history.
        const ambiguous: AbsUserSummary[] = [
            { id: 'u-a', username: 'Testuser' },
            { id: 'u-b', username: 'testuser' },
        ];
        expect(matchAbsUser(ambiguous, 'TESTUSER')).toBeNull();
    });
});

describe('resolveUserApiKey', () => {
    it('returns the stored key without touching ABS when one already exists', async () => {
        const secrets = makeSecrets({ 'lu-1:api_key': 'existing-token' });
        const deps = makeDeps();

        const key = await resolveUserApiKey({
            secrets,
            deps,
            userId: 'lu-1',
            username: 'testuser',
            reenablePull: true,
        });

        expect(key).toBe('existing-token');
        expect(deps.listUsers).not.toHaveBeenCalled();
        expect(deps.createApiKey).not.toHaveBeenCalled();
    });

    it('mints a key with isActive explicitly true and persists it', async () => {
        const secrets = makeSecrets({ [`lu-1:${PULL_DISABLED_SECRET}`]: 'true' });
        const deps = makeDeps();

        const key = await resolveUserApiKey({
            secrets,
            deps,
            userId: 'lu-1',
            username: 'testuser',
            reenablePull: true,
        });

        expect(key).toBe('tok-1');
        expect(deps.createApiKey).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u-testuser', isActive: true }),
        );
        expect(secrets.store.get('lu-1:api_key')).toBe('tok-1');
        expect(secrets.store.has(`lu-1:${PULL_DISABLED_SECRET}`)).toBe(false);
    });

    it('does not clear an explicit pull opt-out during background credential use', async () => {
        const secrets = makeSecrets({
            'lu-1:api_key': 'existing-token',
            [`lu-1:${PULL_DISABLED_SECRET}`]: 'true',
        });

        await resolveUserApiKey({
            secrets,
            deps: makeDeps(),
            userId: 'lu-1',
            username: 'testuser',
        });

        expect(secrets.store.get(`lu-1:${PULL_DISABLED_SECRET}`)).toBe('true');
    });

    it('mints against the case-insensitively matched ABS account', async () => {
        const secrets = makeSecrets();
        const deps = makeDeps();

        await resolveUserApiKey({ secrets, deps, userId: 'lu-2', username: 'testguest' });

        expect(deps.createApiKey).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u-testguest' }),
        );
    });

    it('returns null and mints nothing when the user has no ABS account', async () => {
        const secrets = makeSecrets();
        const deps = makeDeps();

        const key = await resolveUserApiKey({
            secrets,
            deps,
            userId: 'lu-3',
            username: 'nobody',
        });

        expect(key).toBeNull();
        expect(deps.createApiKey).not.toHaveBeenCalled();
        expect(secrets.store.size).toBe(0);
    });

    /**
     * Guards the verified footgun end-to-end: if ABS ever hands back an inert
     * key we must not persist it. A stored dead key is worse than no key —
     * every later cycle reads it from the cache, 401s, and never re-mints.
     */
    it('refuses to persist a key that came back inert', async () => {
        const secrets = makeSecrets();
        const deps = makeDeps({
            createApiKey: vi.fn(async () => ({ id: 'key-x', apiKey: 'tok-x', isActive: false })),
        });

        const key = await resolveUserApiKey({
            secrets,
            deps,
            userId: 'lu-4',
            username: 'testuser',
        });

        expect(key).toBeNull();
        expect(secrets.store.size).toBe(0);
    });

    it('does not persist anything when minting throws', async () => {
        const secrets = makeSecrets();
        const deps = makeDeps({
            createApiKey: vi.fn(async () => {
                throw new Error('ABS 500');
            }),
        });

        await expect(
            resolveUserApiKey({ secrets, deps, userId: 'lu-5', username: 'testuser' }),
        ).rejects.toThrow('ABS 500');
        expect(secrets.store.size).toBe(0);
    });
});

describe('forgetUserApiKey', () => {
    /**
     * The self-heal path. When ABS rejects a key (401/403) it is dead upstream;
     * if the local row survives, `resolveUserApiKey` short-circuits on it every
     * later cycle and the user never syncs again — there is no other recovery
     * short of an operator running unlink by hand.
     */
    it('drops the cached key so the next resolve re-mints', async () => {
        const secrets = makeSecrets({ 'lu-1:api_key': 'revoked', 'lu-1:api_key_id': 'key-1' });
        const deps = makeDeps();

        await forgetUserApiKey({ secrets, userId: 'lu-1' });
        expect(secrets.store.size).toBe(0);

        const key = await resolveUserApiKey({
            secrets,
            deps,
            userId: 'lu-1',
            username: 'testuser',
        });
        expect(key).toBe('tok-1');
        expect(deps.createApiKey).toHaveBeenCalledTimes(1);
    });

    it('does not call ABS — the key is already dead upstream', async () => {
        const secrets = makeSecrets({ 'lu-1:api_key': 'revoked' });
        const deps = makeDeps();

        await forgetUserApiKey({ secrets, userId: 'lu-1' });

        expect(deps.deactivateApiKey).not.toHaveBeenCalled();
    });
});

describe('resolveUserApiKey — upstream failures are not "no account"', () => {
    /**
     * `listUsers` throwing (rather than returning []) is what keeps an ABS
     * outage or an expired operator key from being silently reported as "this
     * user has no ABS account" — which would link nobody and show nothing.
     */
    it('propagates a listUsers failure instead of reporting the user unlinked', async () => {
        const secrets = makeSecrets();
        const deps = makeDeps({
            listUsers: vi.fn(async () => {
                throw new Error('Audiobookshelf listUsers failed: HTTP error! status: 401');
            }),
        });

        await expect(
            resolveUserApiKey({ secrets, deps, userId: 'lu-1', username: 'testuser' }),
        ).rejects.toThrow(/listUsers failed/);
        expect(secrets.store.size).toBe(0);
    });
});

describe('unlinkUserApiKey', () => {
    /**
     * `plugin_user_credentials` cascades on user delete, but the ABS-side key
     * stays live and usable. Dropping only the local row leaks a working
     * credential for an account that believes it was unlinked.
     */
    it('deactivates the key on ABS as well as dropping the local row', async () => {
        const secrets = makeSecrets({ 'lu-1:api_key': 'tok-1', 'lu-1:api_key_id': 'key-1' });
        const deps = makeDeps();

        await unlinkUserApiKey({ secrets, deps, userId: 'lu-1' });

        expect(deps.deactivateApiKey).toHaveBeenCalledWith('key-1');
        expect(secrets.store.has('lu-1:api_key')).toBe(false);
        expect(secrets.store.has('lu-1:api_key_id')).toBe(false);
        expect(secrets.store.get(`lu-1:${PULL_DISABLED_SECRET}`)).toBe('true');
    });

    it('still drops the local row when the ABS-side deactivate fails', async () => {
        const secrets = makeSecrets({ 'lu-1:api_key': 'tok-1', 'lu-1:api_key_id': 'key-1' });
        const deps = makeDeps({
            deactivateApiKey: vi.fn(async () => {
                throw new Error('ABS unreachable');
            }),
        });

        await unlinkUserApiKey({ secrets, deps, userId: 'lu-1' });

        expect(secrets.store.has('lu-1:api_key')).toBe(false);
    });

    it('records an explicit opt-out even for a user without a current key', async () => {
        const secrets = makeSecrets();
        const deps = makeDeps();

        await unlinkUserApiKey({ secrets, deps, userId: 'lu-9' });

        expect(deps.deactivateApiKey).not.toHaveBeenCalled();
        expect(secrets.store.get(`lu-9:${PULL_DISABLED_SECRET}`)).toBe('true');
    });
});

describe('stale-key sweep before minting', () => {
    /** Mirrors what production actually had: three live keys for ONE ABS user. */
    const LIVE_KEYS: AbsApiKeyInfo[] = [
        { id: 'k-old-1', name: 'Lumastra (Testuser)', userId: 'u-testuser', isActive: true },
        { id: 'k-old-2', name: 'Lumastra (testuser)', userId: 'u-testuser', isActive: true },
        { id: 'k-other-user', name: 'Lumastra (Testguest)', userId: 'u-testguest', isActive: true },
        { id: 'k-operator', name: 'root admin token', userId: 'u-testuser', isActive: true },
        { id: 'k-inactive', name: 'Lumastra (testuser)', userId: 'u-testuser', isActive: false },
    ];

    it('deactivates our own active keys for THIS ABS user before minting', async () => {
        const deps = makeDeps({ listApiKeys: vi.fn(async () => LIVE_KEYS) });
        const secrets = makeSecrets();

        await resolveUserApiKey({ secrets, deps, userId: 'lum-1', username: 'testuser' });

        const revoked = (deps.deactivateApiKey as ReturnType<typeof vi.fn>).mock.calls.map(
            (c) => c[0],
        );
        // Both case-variants of our own key for u-testuser, and nothing else.
        expect(revoked.sort()).toEqual(['k-old-1', 'k-old-2']);
    });

    it("never touches the operator key, another user's key, or an inactive key", async () => {
        const deps = makeDeps({ listApiKeys: vi.fn(async () => LIVE_KEYS) });
        await resolveUserApiKey({
            secrets: makeSecrets(),
            deps,
            userId: 'lum-1',
            username: 'testuser',
        });

        const revoked = (deps.deactivateApiKey as ReturnType<typeof vi.fn>).mock.calls.map(
            (c) => c[0],
        );
        expect(revoked).not.toContain('k-operator');
        expect(revoked).not.toContain('k-other-user');
        expect(revoked).not.toContain('k-inactive');
    });

    it('sweeps BEFORE minting, so a sweep bug cannot revoke the new key', async () => {
        const order: string[] = [];
        const deps = makeDeps({
            listApiKeys: vi.fn(async () => LIVE_KEYS),
            deactivateApiKey: vi.fn(async () => {
                order.push('deactivate');
            }),
            createApiKey: vi.fn(async () => {
                order.push('create');
                return { id: 'key-new', apiKey: 'tok-new', isActive: true };
            }),
        });

        await resolveUserApiKey({
            secrets: makeSecrets(),
            deps,
            userId: 'lum-1',
            username: 'testuser',
        });

        expect(order.filter((o) => o === 'create')).toHaveLength(1);
        expect(order.indexOf('create')).toBe(order.length - 1);
        expect(order[0]).toBe('deactivate');
    });

    it('still mints when listing keys fails — hygiene must not block linking', async () => {
        const deps = makeDeps({
            listApiKeys: vi.fn(async () => {
                throw new Error('ABS unreachable');
            }),
        });
        const secrets = makeSecrets();

        await expect(
            resolveUserApiKey({ secrets, deps, userId: 'lum-1', username: 'testuser' }),
        ).resolves.toBe('tok-1');
        expect(deps.createApiKey).toHaveBeenCalled();
    });

    it('still mints when a deactivate fails, leaving the orphan logged', async () => {
        const deps = makeDeps({
            listApiKeys: vi.fn(async () => LIVE_KEYS),
            deactivateApiKey: vi.fn(async () => {
                throw new Error('403');
            }),
        });

        await expect(
            resolveUserApiKey({
                secrets: makeSecrets(),
                deps,
                userId: 'lum-1',
                username: 'testuser',
            }),
        ).resolves.toBe('tok-1');
    });

    it('skips the sweep entirely when the caller supplies no listApiKeys', async () => {
        const deps = makeDeps({ listApiKeys: undefined });

        await expect(
            resolveUserApiKey({
                secrets: makeSecrets(),
                deps,
                userId: 'lum-1',
                username: 'testuser',
            }),
        ).resolves.toBe('tok-1');
        expect(deps.deactivateApiKey).not.toHaveBeenCalled();
    });

    it('does not sweep or mint when the user has no ABS account at all', async () => {
        const deps = makeDeps({ listApiKeys: vi.fn(async () => LIVE_KEYS) });

        await expect(
            resolveUserApiKey({
                secrets: makeSecrets(),
                deps,
                userId: 'lum-9',
                username: 'nobody-here',
            }),
        ).resolves.toBeNull();
        expect(deps.deactivateApiKey).not.toHaveBeenCalled();
        expect(deps.createApiKey).not.toHaveBeenCalled();
    });

    it('does not sweep when a cached key already exists (no re-mint)', async () => {
        const deps = makeDeps({ listApiKeys: vi.fn(async () => LIVE_KEYS) });
        const secrets = makeSecrets({ 'lum-1:api_key': 'already-have-one' });

        await expect(
            resolveUserApiKey({ secrets, deps, userId: 'lum-1', username: 'testuser' }),
        ).resolves.toBe('already-have-one');
        expect(deps.listApiKeys).not.toHaveBeenCalled();
        expect(deps.deactivateApiKey).not.toHaveBeenCalled();
    });
});

describe('resolveUserApiKey — provisioning an ABS account', () => {
    /**
     * Without provisioning, a listener with no ABS counterpart is stuck: the
     * session endpoint turns the null into 403 "This account has no
     * AudiobookShelf link", which reads as a broken integration rather than a
     * missing account. That is what preprod hit — ABS had only `root`.
     */
    function store() {
        const map = new Map<string, string>();
        return {
            map,
            getUserRaw: vi.fn(
                async (_p: string, u: string, k: string) => map.get(`${u}:${k}`) ?? null,
            ),
            setUser: vi.fn(async (_p: string, u: string, k: string, v: string) => {
                map.set(`${u}:${k}`, v);
            }),
            deleteUser: vi.fn(async (_p: string, u: string, k: string) => {
                map.delete(`${u}:${k}`);
            }),
        };
    }

    it('creates the ABS account, then mints a key against it', async () => {
        const secrets = store();
        const createUser = vi.fn(async (input: { username: string; password: string }) => ({
            id: 'u-new',
            username: input.username,
        }));
        const createApiKey = vi.fn(async () => ({
            id: 'k-new',
            apiKey: 'tok-new',
            isActive: true,
        }));
        const deps = makeDeps({ createUser, createApiKey });

        const key = await resolveUserApiKey({
            secrets: secrets as never,
            deps,
            userId: 'lum-new',
            username: 'newcomer',
            autoCreate: true,
        });

        expect(createUser).toHaveBeenCalledTimes(1);
        // The key must be minted against the ACCOUNT JUST CREATED. Minting
        // against anything else hands this listener somebody else's library.
        expect(createApiKey).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'u-new', isActive: true }),
        );
        expect(key).toBe('tok-new');
    });

    it('never sends an empty password — ABS rejects the account outright', async () => {
        const secrets = store();
        const createUser = vi.fn(async (input: { username: string; password: string }) => ({
            id: 'u-new',
            username: input.username,
        }));
        await resolveUserApiKey({
            secrets: secrets as never,
            deps: makeDeps({ createUser }),
            userId: 'lum-new',
            username: 'newcomer',
            autoCreate: true,
        });

        const pw = createUser.mock.calls[0][0].password;
        expect(pw.length).toBeGreaterThanOrEqual(32);
        // Two calls must not agree, or every provisioned account shares one
        // password on a server that does have a login form.
        await resolveUserApiKey({
            secrets: store() as never,
            deps: makeDeps({ createUser }),
            userId: 'lum-other',
            username: 'other',
            autoCreate: true,
        });
        expect(createUser.mock.calls[1][0].password).not.toBe(pw);
    });

    it('does NOT create an account when the operator has opted out', async () => {
        const createUser = vi.fn();
        const key = await resolveUserApiKey({
            secrets: store() as never,
            deps: makeDeps({ createUser }),
            userId: 'lum-new',
            username: 'newcomer',
            autoCreate: false,
        });

        expect(createUser).not.toHaveBeenCalled();
        expect(key).toBeNull();
    });

    it('defaults to NOT creating when the caller says nothing', async () => {
        // Scheduled sync calls this without the flag and must never provision
        // for someone who has not opened an audiobook.
        const createUser = vi.fn();
        const key = await resolveUserApiKey({
            secrets: store() as never,
            deps: makeDeps({ createUser }),
            userId: 'lum-new',
            username: 'newcomer',
        });

        expect(createUser).not.toHaveBeenCalled();
        expect(key).toBeNull();
    });

    it('leaves an EXISTING ABS account alone rather than creating a duplicate', async () => {
        const createUser = vi.fn();
        const key = await resolveUserApiKey({
            secrets: store() as never,
            deps: makeDeps({ createUser }),
            userId: 'lum-testuser',
            username: 'testuser',
            autoCreate: true,
        });

        expect(createUser).not.toHaveBeenCalled();
        expect(key).toBe('tok-1');
    });

    it('does not create when the username is AMBIGUOUS on the ABS side', async () => {
        // matchAbsUser refuses to guess between `Testuser` and `testuser`; creating a
        // third account for the same person would be worse than refusing.
        const createUser = vi.fn();
        const deps = makeDeps({
            createUser,
            listUsers: vi.fn(async () => [
                { id: 'u-a', username: 'Testuser' },
                { id: 'u-b', username: 'testuser' },
            ]),
        });

        const key = await resolveUserApiKey({
            secrets: store() as never,
            deps,
            userId: 'lum-testuser',
            username: 'testuser',
            autoCreate: true,
        });

        expect(createUser).not.toHaveBeenCalled();
        expect(key).toBeNull();
    });

    it('reports unlinked, not crashed, when the client cannot create users', async () => {
        const deps = makeDeps();
        delete (deps as { createUser?: unknown }).createUser;

        const key = await resolveUserApiKey({
            secrets: store() as never,
            deps,
            userId: 'lum-new',
            username: 'newcomer',
            autoCreate: true,
        });

        expect(key).toBeNull();
    });
});
