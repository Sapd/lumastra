// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-13, C2 — disabling a user must be honoured by the
 * Subsonic-compat auth SEAM (`validateCredentials` / `validateApiKey`), not
 * just the underlying SQL predicate. The query-level exclusion
 * (`AND u.disabled_at IS NULL`) already has dedicated coverage in
 * `subsonic-client-passwords.queries.integration.test.ts`; this file pins the
 * function-level behaviour on top of it, mirroring the mocking shape of
 * `auth-sealed.test.ts`: an in-memory row store filtered exactly like the
 * real join, plus a real in-memory Valkey stub so the 60s auth cache is
 * genuinely exercised.
 *
 * The cache is part of the seam: `validateCredentials` skips the DB (and
 * therefore the disabled filter) on a cache hit, so a disabled user stays
 * valid until the per-username cache entry is invalidated. `setDisabled`
 * (via `revokeAllCredentialsForUser`) calls the real `invalidateCacheForUser`
 * to force that — the last test below exercises that exact call, unmocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.LUMASTRA_MASTER_KEY = 'c'.repeat(64);

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
    disabled: boolean;
}

const { rows, cache } = vi.hoisted(() => ({
    rows: new Map<string, Row>(),
    cache: new Map<string, string>(),
}));

vi.mock('$lib/server/database/queries/subsonic-client-passwords.queries', () => ({
    // Mirrors the real `getTokenByUsername` / `getTokenByValue` SQL, which
    // JOINs users and filters `AND u.disabled_at IS NULL`.
    getTokenByUsername: {
        one: async (_sql: unknown, { username }: { username: string }) =>
            Array.from(rows.values()).find(
                (r) => r.username.toLowerCase() === username.toLowerCase() && !r.disabled,
            ) ?? null,
    },
    getTokenByValue: {
        one: async (_sql: unknown, { token, lookup }: { token: string; lookup: string | null }) =>
            Array.from(rows.values()).find(
                (r) =>
                    ((lookup !== null && r.token_lookup === lookup) || r.token === token) &&
                    !r.disabled,
            ) ?? null,
    },
    updateLastUsed: { execute: async () => [] },
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

const { validateCredentials, validateApiKey, invalidateCacheForUser } = await import('./auth.js');

const USER_ID = '22222222-2222-4222-8222-222222222222';
// 40 lowercase hex chars, matching the real token shape (TOKEN_LENGTH=20 bytes).
const TOKEN = 'a'.repeat(40);

function seedRow(disabled: boolean): void {
    rows.set(USER_ID, {
        id: 1,
        user_id: USER_ID,
        token: TOKEN,
        token_sealed: null,
        token_lookup: null,
        created_at: new Date(0),
        last_used_at: null,
        username: 'gatekept',
        is_admin: false,
        display_name: null,
        groups: null,
        disabled,
    });
}

beforeEach(() => {
    rows.clear();
    cache.clear();
});

describe('Subsonic compat auth: disabled user rejected at the seam (C2)', () => {
    it('validateCredentials refuses a disabled user even with the correct password', async () => {
        seedRow(true);

        expect(await validateCredentials('gatekept', { password: TOKEN })).toBeNull();
    });

    it('validateCredentials accepts the SAME credential once the user is NOT disabled (control)', async () => {
        seedRow(false);

        expect(await validateCredentials('gatekept', { password: TOKEN })).not.toBeNull();
    });

    it('validateApiKey refuses a disabled user even with the correct token as api key', async () => {
        seedRow(true);

        expect(await validateApiKey(TOKEN, {} as never)).toBeNull();
    });

    it('validateApiKey accepts the SAME api key once the user is NOT disabled (control)', async () => {
        seedRow(false);

        expect(await validateApiKey(TOKEN, {} as never)).not.toBeNull();
    });

    it('a cached successful auth is refused once the user is disabled and the cache invalidated', async () => {
        seedRow(false);

        // Warm the 60s auth cache with a genuine success.
        const first = await validateCredentials('gatekept', { password: TOKEN });
        expect(first).not.toBeNull();
        expect(cache.size).toBeGreaterThan(0);

        // Disable at the DB layer (mirrors `disabled_at` being set) and
        // invalidate the cache exactly like revokeAllCredentialsForUser does
        // when an admin disables the account. invalidateCacheForUser is the
        // REAL (unmocked) export under test here.
        rows.get(USER_ID)!.disabled = true;
        await invalidateCacheForUser('gatekept');

        expect(await validateCredentials('gatekept', { password: TOKEN })).toBeNull();
    });
});
