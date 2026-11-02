// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Security review 2026-09-13, C2 — `validatePassword` (backing
 * `POST /j/Users/AuthenticateByName`) must refuse a DISABLED user even when
 * the password is correct. The SQL predicate itself
 * (`getPasswordByUsername`'s `AND u.disabled_at IS NULL`) is not under test
 * here; this pins the function-level seam, mirroring the mocking shape of
 * `auth-password-reveal.test.ts` — a real `getOrCreatePassword` /
 * `validatePassword` round-trip through a real scrypt verify, with only the
 * query module faked to reproduce the real join's disabled filter.
 */

vi.mock('$lib/server/services/user-credential-lock', () => ({
    withUserCredentialLock: async (
        sql: unknown,
        _id: string,
        work: (tx: unknown) => Promise<unknown>,
    ) => work(sql),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.LUMASTRA_MASTER_KEY = 'd'.repeat(64);

interface StoredRow {
    id: number;
    user_id: string;
    password_hash: string;
    password_sealed: string | null;
    created_at: Date;
    last_used_at: Date | null;
    username: string;
    is_admin: boolean;
    display_name: string | null;
    groups: string[] | null;
    disabled: boolean;
}

const { rows } = vi.hoisted(() => ({ rows: new Map<string, StoredRow>() }));

vi.mock('$lib/server/database/queries/jellyfin-client-passwords.queries', () => ({
    getPasswordByUserId: {
        one: async (_sql: unknown, { userId }: { userId: string }) => rows.get(userId) ?? null,
    },
    // Mirrors the real query's `JOIN users u ... AND u.disabled_at IS NULL`.
    getPasswordByUsername: {
        one: async (_sql: unknown, { username }: { username: string }) =>
            Array.from(rows.values()).find((r) => r.username === username && !r.disabled) ?? null,
    },
    upsertPassword: {
        execute: async (
            _sql: unknown,
            {
                userId,
                passwordHash,
                passwordSealed,
            }: { userId: string; passwordHash: string; passwordSealed: string | null },
        ) => {
            const existing = rows.get(userId);
            rows.set(userId, {
                id: 1,
                user_id: userId,
                password_hash: passwordHash,
                password_sealed: passwordSealed,
                created_at: new Date(0),
                last_used_at: null,
                username: existing?.username ?? 'gatekept',
                is_admin: existing?.is_admin ?? false,
                display_name: existing?.display_name ?? null,
                groups: existing?.groups ?? [],
                disabled: existing?.disabled ?? false,
            });
            return [{ id: 1 }];
        },
    },
    updateLastUsed: { execute: async () => [] },
    deletePassword: { execute: async () => [] },
    getUsersWithPasswords: { all: async () => [] },
}));

vi.mock('$lib/server/database/connection', () => ({
    Database: class {
        getSql() {
            return null;
        }
    },
}));

vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: async () => null,
    cacheSet: async () => true,
    cacheDel: async () => 0,
    cacheExists: async () => false,
    expire: async () => true,
    sAdd: async () => 0,
    sRem: async () => 0,
    sMembers: async () => [],
    getCoordinationClient: () => null,
}));

const { getOrCreatePassword, validatePassword } = await import('./auth.js');

beforeEach(() => {
    rows.clear();
});

describe('Jellyfin-compat validatePassword: disabled user rejected at the seam (C2)', () => {
    it('refuses a disabled user even with the correct password', async () => {
        const pin = await getOrCreatePassword('u1');
        rows.get('u1')!.disabled = true;

        expect(await validatePassword('gatekept', pin)).toBeNull();
    });

    it('accepts the SAME password once the user is NOT disabled (control)', async () => {
        const pin = await getOrCreatePassword('u1');

        const result = await validatePassword('gatekept', pin);
        expect(result).not.toBeNull();
        expect(result?.username).toBe('gatekept');
    });
});
