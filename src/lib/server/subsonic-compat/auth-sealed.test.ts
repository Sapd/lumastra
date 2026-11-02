// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for encryption-at-rest of the Subsonic client token.
//
// The Subsonic protocol forces the server to RECOVER the token (clients send
// MD5(token+salt)), so it can never be hashed. These tests pin the properties
// that make sealing a real mitigation rather than decoration: the plaintext
// never reaches the database or the auth cache, the blind index still resolves
// the apiKeyAuthentication reverse lookup, legacy rows keep working and get
// upgraded, and every failure fails CLOSED.

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.LUMASTRA_MASTER_KEY = 'b'.repeat(64);

interface Row {
    id: number;
    user_id: string;
    token: string | null;
    token_sealed: string | null;
    token_lookup: string | null;
    created_at: Date;
    last_used_at: Date | null;
    username: string;
    is_admin: boolean;
    display_name: string | null;
    groups: string[] | null;
}

const { rows, cache } = vi.hoisted(() => ({
    rows: new Map<string, Row>(),
    cache: new Map<string, string>(),
}));

function rowFor(userId: string): Row | null {
    return rows.get(userId) ?? null;
}

vi.mock('$lib/server/database/queries/subsonic-client-passwords.queries', () => ({
    getTokenByUserId: {
        one: async (_sql: unknown, { userId }: { userId: string }) => rowFor(userId),
    },
    getTokenWithUserByUserId: {
        one: async (_sql: unknown, { userId }: { userId: string }) => rowFor(userId),
    },
    getTokenByUsername: {
        one: async (_sql: unknown, { username }: { username: string }) =>
            Array.from(rows.values()).find(
                (r) => r.username.toLowerCase() === username.toLowerCase(),
            ) ?? null,
    },
    getTokenByValue: {
        // Mirrors the real SQL: match the blind index OR the legacy plaintext.
        one: async (_sql: unknown, { token, lookup }: { token: string; lookup: string | null }) =>
            Array.from(rows.values()).find(
                (r) => (lookup !== null && r.token_lookup === lookup) || r.token === token,
            ) ?? null,
    },
    upsertToken: {
        execute: async (
            _sql: unknown,
            p: {
                userId: string;
                token: string | null;
                tokenSealed: string | null;
                tokenLookup: string | null;
            },
        ) => {
            const existing = rows.get(p.userId);
            rows.set(p.userId, {
                id: 1,
                user_id: p.userId,
                token: p.token,
                token_sealed: p.tokenSealed,
                token_lookup: p.tokenLookup,
                created_at: new Date(0),
                last_used_at: null,
                username: existing?.username ?? 'denis',
                is_admin: false,
                display_name: null,
                groups: null,
            });
            return [{ id: 1 }];
        },
    },
    upgradeTokenToSealed: {
        execute: async (
            _sql: unknown,
            p: { userId: string; tokenSealed: string; tokenLookup: string },
        ) => {
            const row = rows.get(p.userId);
            // Mirrors the `AND token_sealed IS NULL` guard in the real query.
            if (!row || row.token_sealed) return [];
            row.token = null;
            row.token_sealed = p.tokenSealed;
            row.token_lookup = p.tokenLookup;
            return [{ id: 1 }];
        },
    },
    updateLastUsed: { execute: async () => [] },
    deleteToken: {
        execute: async (_sql: unknown, { userId }: { userId: string }) => {
            rows.delete(userId);
            return [{ id: 1 }];
        },
    },
    getUsersWithTokens: { all: async () => [] },
}));

vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: async (k: string) => cache.get(k) ?? null,
    cacheSet: async (k: string, v: string) => {
        cache.set(k, v);
        return true;
    },
    cacheDel: async (k: string) => (cache.delete(k) ? 1 : 0),
}));

vi.mock('$lib/server/services/database.service', () => ({
    aiDbService: { getSql: async () => ({}) as unknown },
}));

vi.mock('$lib/server/auth', () => ({
    buildUserPermissions: () => ({ maxAgeRating: null, isAgeRestricted: false }),
}));

// `validateCredentials` / `validateApiKey` now resolve their permission surface
// through `resolveTokenUserAccess` so the in-app cohort age ceiling reaches the
// UserContext. Stubbed to a benign non-admin result for exactly the reason
// `buildUserPermissions` is stubbed above: permissions are not this file's
// subject. The merge itself is covered in `auth-inapp-age-ceiling.test.ts`.
vi.mock('$lib/server/auth/resolve-token-user-access.js', () => ({
    resolveTokenUserAccess: async () => ({
        userGroups: [],
        permissions: { isAdmin: false, maxAgeRating: null, isAgeRestricted: false },
        disabled: false,
        deleted: false,
    }),
    // fix-plan-5 Task 9: auth.ts's cache-miss seed uses this constant for its
    // fail-closed placeholder maxAgeRating — every mock factory of this
    // module must export it or the import surfaces as a vitest "missing
    // export" error, not as a 500/null.
    MOST_RESTRICTIVE_AGE_RATING: 0,
}));

const {
    getOrCreateToken,
    resetToken,
    revealToken,
    validateCredentials,
    validateApiKey,
    deleteUserToken,
} = await import('./auth.js');

const { createHash } = await import('crypto');

// Must be a real UUID: toUserId() validates the shape.
const USER_ID = '11111111-1111-4111-8111-111111111111';

function seedLegacyPlaintextRow(userId: string, token: string, username = 'denis'): void {
    rows.set(userId, {
        id: 1,
        user_id: userId,
        token,
        token_sealed: null,
        token_lookup: null,
        created_at: new Date(0),
        last_used_at: null,
        username,
        is_admin: false,
        display_name: null,
        groups: null,
    });
}

/** Wait out the fire-and-forget lazy upgrade. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    rows.clear();
    cache.clear();
});

describe('Subsonic token encryption at rest', () => {
    it('caches a sealed dummy for unknown usernames and never authenticates it', async () => {
        expect(await validateCredentials('unknown', { password: 'f'.repeat(40) })).toBeNull();
        const raw = Array.from(cache.values())[0]!;
        const entry = JSON.parse(raw) as { credentialMissing: boolean; token: string };
        expect(entry.credentialMissing).toBe(true);
        expect(entry.token).toMatch(/^enc:v2:/);
        expect(await validateCredentials('unknown', { password: 'f'.repeat(40) })).toBeNull();
        expect(
            await validateCredentials('unknown', { token: '0'.repeat(32), salt: 'probe' }),
        ).toBeNull();
        expect(Array.from(cache.values())).toEqual([raw]);
    });

    it('stores an envelope and blind index, never the plaintext', async () => {
        const token = await getOrCreateToken(USER_ID);
        const row = rows.get(USER_ID)!;

        expect(row.token).toBeNull();
        expect(row.token_sealed).toMatch(/^enc:v2:/);
        expect(row.token_sealed).not.toContain(token);
        expect(row.token_lookup).toMatch(/^[0-9a-f]{64}$/);
        expect(row.token_lookup).not.toContain(token);
    });

    it('round-trips the token through reveal', async () => {
        const token = await getOrCreateToken(USER_ID);
        expect(await revealToken(USER_ID)).toBe(token);
    });

    it('authenticates in token mode against a sealed row', async () => {
        const token = await getOrCreateToken(USER_ID);
        const salt = 'abc123';
        const digest = createHash('md5')
            .update(token + salt)
            .digest('hex');

        expect(await validateCredentials('denis', { token: digest, salt })).not.toBeNull();
    });

    it('authenticates in password mode against a sealed row', async () => {
        const token = await getOrCreateToken(USER_ID);
        expect(await validateCredentials('denis', { password: token })).not.toBeNull();
    });

    it('rejects a wrong token against a sealed row', async () => {
        await getOrCreateToken(USER_ID);
        expect(await validateCredentials('denis', { password: 'f'.repeat(40) })).toBeNull();
    });

    it('keeps the plaintext out of the auth cache', async () => {
        const token = await getOrCreateToken(USER_ID);
        await validateCredentials('denis', { password: token });

        const entries = Array.from(cache.values());
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) {
            expect(entry).not.toContain(token);
            expect(entry).toContain('enc:v2:');
        }
    });

    it('resolves the apiKeyAuthentication reverse lookup via the blind index', async () => {
        const token = await getOrCreateToken(USER_ID);

        const result = await validateApiKey(token, {} as never);
        expect(result?.userId).toBe(USER_ID);
    });

    it('rejects an unknown api key', async () => {
        await getOrCreateToken(USER_ID);
        expect(await validateApiKey('a'.repeat(40), {} as never)).toBeNull();
    });

    it('accepts a display-formatted api key (spaces, mixed case)', async () => {
        const token = await getOrCreateToken(USER_ID);
        const spaced = (token.match(/.{1,5}/g) ?? []).join(' ').toUpperCase();

        expect(await validateApiKey(spaced, {} as never)).not.toBeNull();
    });

    it('still authenticates a legacy plaintext row', async () => {
        seedLegacyPlaintextRow(USER_ID, 'c'.repeat(40));
        expect(await validateCredentials('denis', { password: 'c'.repeat(40) })).not.toBeNull();
    });

    it('upgrades a legacy plaintext row in place on first authentication', async () => {
        const legacy = 'c'.repeat(40);
        seedLegacyPlaintextRow(USER_ID, legacy);

        await validateCredentials('denis', { password: legacy });
        await settle();

        const row = rows.get(USER_ID)!;
        expect(row.token).toBeNull();
        expect(row.token_sealed).toMatch(/^enc:v2:/);
        expect(row.token_lookup).toMatch(/^[0-9a-f]{64}$/);
        // ...and the same token keeps working afterwards.
        cache.clear();
        expect(await validateCredentials('denis', { password: legacy })).not.toBeNull();
    });

    it('upgrades a legacy row reached through the api-key path too', async () => {
        const legacy = 'd'.repeat(40);
        seedLegacyPlaintextRow(USER_ID, legacy);

        await validateApiKey(legacy, {} as never);
        await settle();

        expect(rows.get(USER_ID)!.token).toBeNull();
        expect(rows.get(USER_ID)!.token_sealed).toMatch(/^enc:v2:/);
    });

    it('fails closed when the envelope cannot be opened', async () => {
        await getOrCreateToken(USER_ID);
        // Simulate a master key that no longer matches (rotation, or a replica
        // that generated its own because the config dir was not shared).
        rows.get(USER_ID)!.token_sealed = 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

        expect(await revealToken(USER_ID)).toBeNull();
        expect(await validateCredentials('denis', { password: 'anything' })).toBeNull();
        expect(await validateCredentials('denis', { password: '' })).toBeNull();
    });

    it('never accepts an empty credential', async () => {
        await getOrCreateToken(USER_ID);
        expect(await validateCredentials('denis', { password: '' })).toBeNull();
    });

    it('replaces both representations on reset', async () => {
        const first = await getOrCreateToken(USER_ID);
        const firstSealed = rows.get(USER_ID)!.token_sealed;

        const second = await resetToken(USER_ID);

        expect(second).not.toBe(first);
        expect(rows.get(USER_ID)!.token_sealed).not.toBe(firstSealed);
        expect(rows.get(USER_ID)!.token).toBeNull();
        expect(await revealToken(USER_ID)).toBe(second);
        // The old token must no longer resolve through the blind index.
        expect(await validateApiKey(first, {} as never)).toBeNull();
    });

    it('reveals nothing once the token is deleted', async () => {
        await getOrCreateToken(USER_ID);
        await deleteUserToken(USER_ID);
        expect(await revealToken(USER_ID)).toBeNull();
    });
});

// ── Row binding (security review 2026-09-13, C19) ─────────────────────────────
//
// The finding: an envelope said nothing about which row it came from, so an
// attacker with database write access could run
//   UPDATE subsonic_client_passwords SET token_sealed = <the admin's>
//   WHERE user_id = <mine>
// and GET /api/subsonic-connect/password/reveal would hand them the admin's
// token in plaintext. The envelope is now bound to its own user_id.

describe('a token envelope is bound to the row it lives in', () => {
    const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

    function seedRow(userId: string, username: string, tokenSealed: string | null): void {
        rows.set(userId, {
            id: 2,
            user_id: userId,
            token: null,
            token_sealed: tokenSealed,
            token_lookup: null,
            created_at: new Date(0),
            last_used_at: null,
            username,
            is_admin: false,
            display_name: null,
            groups: null,
        });
    }

    it('reveal returns null for an envelope transplanted from another user', async () => {
        const adminToken = await getOrCreateToken(USER_ID);
        // A second user, into whose row the admin's ciphertext is copied verbatim.
        seedRow(OTHER_USER_ID, 'mallory', rows.get(USER_ID)!.token_sealed);

        expect(await revealToken(OTHER_USER_ID)).toBeNull();
        // The admin's own row is untouched and still reveals.
        expect(await revealToken(USER_ID)).toBe(adminToken);
    });

    it('authentication fails closed for a transplanted envelope', async () => {
        const adminToken = await getOrCreateToken(USER_ID);
        seedRow(OTHER_USER_ID, 'mallory', rows.get(USER_ID)!.token_sealed);

        // Even knowing the plaintext, the stolen row cannot authenticate as its
        // new owner: the envelope will not open in this row's context.
        expect(await validateCredentials('mallory', { password: adminToken })).toBeNull();
    });

    it('the api-key lookup still resolves the token to its OWN user', async () => {
        const adminToken = await getOrCreateToken(USER_ID);

        const result = await validateApiKey(adminToken, {} as never);
        expect(result?.userId).toBe(USER_ID);
    });
});
