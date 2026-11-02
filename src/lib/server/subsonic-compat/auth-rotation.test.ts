// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Master-key rotation round-trip for the Subsonic token store
 * (security review 2026-09-12, C9).
 *
 * Two properties, and the second is the one that was easy to get wrong: the
 * envelope must open under the NEW key and no longer under the old one, AND the
 * `token_lookup` blind index must be recomputed under the new key. The lookup is
 * HMAC-SHA256 over the SAME master key, so a rotation that moved only the
 * envelope would leave `apiKeyAuthentication` searching for a digest nobody can
 * reproduce — the token would exist and never authenticate.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Sql } from 'postgres';
import { deriveMasterKey, sealSecret, openSecret } from '$lib/server/crypto/secret-box';

vi.mock('$lib/server/crypto/master-key', () => ({
    resolveMasterKey: () => 'a'.repeat(64),
}));

vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: async () => null,
    cacheSet: async () => true,
    cacheDel: async () => 1,
}));

vi.mock('$lib/server/services/database.service', () => ({
    aiDbService: { getSql: async () => ({}) as unknown },
}));

vi.mock('$lib/server/auth', () => ({
    buildUserPermissions: () => ({ maxAgeRating: null, isAgeRestricted: false }),
}));

vi.mock('$lib/server/database/queries/subsonic-client-passwords.queries', () => ({
    getTokenByUserId: { one: async () => null },
    getTokenByUsername: { one: async () => null },
    getTokenByValue: { one: async () => null },
    getTokenWithUserByUserId: { one: async () => null },
    upsertToken: { execute: async () => [] },
    upgradeTokenToSealed: { execute: async () => [] },
    updateLastUsed: { execute: async () => [] },
    deleteToken: { execute: async () => [] },
}));

const KEY_A = deriveMasterKey('a'.repeat(64));
const KEY_B = deriveMasterKey('b'.repeat(64));

/**
 * The AAD context auth.ts binds a stored token to — its own row's user_id
 * (security review 2026-09-13, C19). Spelled out rather than imported so the
 * test pins the ON-DISK contract: change the format and every stored token
 * stops opening, which is exactly what a failure here should mean.
 */
function ctx(userId: string): string {
    return `subsonic_client_passwords:${userId.toLowerCase()}`;
}

/** The blind index exactly as auth.ts derives it. */
function lookupUnder(key: Buffer, token: string): string {
    return createHmac('sha256', key)
        .update('subsonic-token-lookup-v1:' + token)
        .digest('hex');
}

interface FakeSql {
    sql: Sql;
    updates: unknown[][];
}

function makeSql(rows: Record<string, unknown>[]): FakeSql {
    const updates: unknown[][] = [];
    const sqlFn = ((strings: readonly string[], ...values: unknown[]) => {
        if (/UPDATE/i.test(strings.join(' '))) {
            updates.push(values);
            const [sealed, lookup, userId] = values as [string, string, string];
            const row = rows.find((r) => r.user_id === userId);
            if (row) {
                row.token = null;
                row.token_sealed = sealed;
                row.token_lookup = lookup;
            }
            return Promise.resolve([]);
        }
        return Promise.resolve(rows);
    }) as unknown as Sql;
    return { sql: sqlFn, updates };
}

const { rotateSubsonicTokens } = await import('./auth.js');

describe('rotateSubsonicTokens', () => {
    it('re-seals the token and recomputes the blind index under the new key', async () => {
        const token = 'f'.repeat(40);
        const rows: Record<string, unknown>[] = [
            {
                user_id: 'u1',
                token: null,
                token_sealed: sealSecret(token, KEY_A),
                token_lookup: lookupUnder(KEY_A, token),
            },
        ];
        const { sql, updates } = makeSql(rows);

        const result = await rotateSubsonicTokens(sql, KEY_A, KEY_B);

        expect(result).toEqual({ rotated: 1, skipped: 0, reasons: [], legacyUpgraded: 1 });
        expect(updates).toHaveLength(1);
        const sealed = rows[0].token_sealed as string;
        // Rotation is also the envelope upgrade path: the re-sealed token is
        // bound to u1 and does not open as another user's row.
        expect(sealed.startsWith('enc:v2:')).toBe(true);
        expect(openSecret(sealed, KEY_B, ctx('u1'))).toBe(token);
        expect(() => openSecret(sealed, KEY_B, ctx('u2'))).toThrow();
        expect(() => openSecret(sealed, KEY_A, ctx('u1'))).toThrow();
        // The reverse lookup must now match the NEW key's digest, not the old.
        expect(rows[0].token_lookup).toBe(lookupUnder(KEY_B, token));
        expect(rows[0].token_lookup).not.toBe(lookupUnder(KEY_A, token));
    });

    it('seals a legacy plaintext row under the new key and clears the plaintext', async () => {
        const token = 'a'.repeat(40);
        const rows: Record<string, unknown>[] = [
            { user_id: 'u2', token, token_sealed: null, token_lookup: null },
        ];
        const { sql } = makeSql(rows);

        const result = await rotateSubsonicTokens(sql, KEY_A, KEY_B);

        expect(result.rotated).toBe(1);
        expect(rows[0].token).toBeNull();
        expect(openSecret(rows[0].token_sealed as string, KEY_B, ctx('u2'))).toBe(token);
        expect(rows[0].token_lookup).toBe(lookupUnder(KEY_B, token));
    });

    it('is safe to re-run: a token already under the new key keeps working', async () => {
        const token = 'b'.repeat(40);
        const rows: Record<string, unknown>[] = [
            {
                user_id: 'u3',
                token: null,
                token_sealed: sealSecret(token, KEY_B, ctx('u3')),
                token_lookup: lookupUnder(KEY_B, token),
            },
        ];
        const { sql } = makeSql(rows);

        const result = await rotateSubsonicTokens(sql, KEY_A, KEY_B);

        expect(result.skipped).toBe(0);
        expect(openSecret(rows[0].token_sealed as string, KEY_B, ctx('u3'))).toBe(token);
        expect(rows[0].token_lookup).toBe(lookupUnder(KEY_B, token));
    });

    it('upgrades an unbound enc:v1: token that is ALREADY under the new key', async () => {
        // What an install that rotated before C19 shipped looks like: right
        // key, no row binding — still transplantable into another user's row.
        const token = 'd'.repeat(40);
        const rows: Record<string, unknown>[] = [
            {
                user_id: 'u5',
                token: null,
                token_sealed: sealSecret(token, KEY_B),
                token_lookup: lookupUnder(KEY_B, token),
            },
        ];
        const { sql, updates } = makeSql(rows);

        const result = await rotateSubsonicTokens(sql, KEY_A, KEY_B);

        expect(result).toEqual({ rotated: 1, skipped: 0, reasons: [], legacyUpgraded: 1 });
        expect(updates).toHaveLength(1);
        const sealed = rows[0].token_sealed as string;
        expect(sealed.startsWith('enc:v2:')).toBe(true);
        expect(openSecret(sealed, KEY_B, ctx('u5'))).toBe(token);
        expect(() => openSecret(sealed, KEY_B, ctx('u6'))).toThrow();
    });

    it('reports a token transplanted from ANOTHER user rather than re-sealing it', async () => {
        // The C19 attack, seen from the rotation sweep: u7's row holds u6's
        // envelope. It opens under neither context-for-u7, so it is reported
        // instead of being quietly re-sealed as if it belonged here.
        const rows: Record<string, unknown>[] = [
            {
                user_id: 'u7',
                token: null,
                token_sealed: sealSecret('e'.repeat(40), KEY_A, ctx('u6')),
                token_lookup: 'stale',
            },
        ];
        const { sql, updates } = makeSql(rows);

        const result = await rotateSubsonicTokens(sql, KEY_A, KEY_B);

        expect(result.rotated).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.reasons[0]).toContain('user_id=u7');
        expect(updates).toHaveLength(0);
    });

    it('reports a token that opens under neither key rather than dropping it silently', async () => {
        const KEY_C = deriveMasterKey('c'.repeat(64));
        const rows: Record<string, unknown>[] = [
            {
                user_id: 'u4',
                token: null,
                token_sealed: sealSecret('c'.repeat(40), KEY_C),
                token_lookup: 'stale',
            },
        ];
        const { sql, updates } = makeSql(rows);

        const result = await rotateSubsonicTokens(sql, KEY_A, KEY_B);

        expect(result.rotated).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.reasons[0]).toContain('user_id=u4');
        expect(updates).toHaveLength(0);
    });
});
