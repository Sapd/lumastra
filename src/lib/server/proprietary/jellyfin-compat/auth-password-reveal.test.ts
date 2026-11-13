// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the reversible display copy of the /j client password.
//
// The PIN is verified against a scrypt hash and, separately, stored sealed so
// settings can show it again instead of forcing a reset. These tests pin the
// two properties that matter: the sealed copy round-trips to exactly the PIN
// that was issued, and every failure mode degrades to "cannot be shown" rather
// than to a wrong password or a thrown error.

vi.mock('$lib/server/services/user-credential-lock', () => ({
    withUserCredentialLock: async (
        sql: unknown,
        _id: string,
        work: (tx: unknown) => Promise<unknown>,
    ) => work(sql),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spy on randomInt (real implementation underneath) to prove the alphabet index
// comes from an unbiased draw, not from a byte modulo.
const { randomIntSpy } = vi.hoisted(() => ({ randomIntSpy: vi.fn() }));
vi.mock('crypto', async (importOriginal) => {
    const actual = await importOriginal<typeof import('crypto')>();
    randomIntSpy.mockImplementation(actual.randomInt as (...a: unknown[]) => number);
    return { ...actual, default: actual, randomInt: randomIntSpy };
});

process.env.LUMASTRA_MASTER_KEY = 'a'.repeat(64);

interface StoredRow {
    id: number;
    user_id: string;
    password_hash: string;
    password_sealed: string | null;
    created_at: Date;
    last_used_at: Date | null;
}

const { rows } = vi.hoisted(() => ({ rows: new Map<string, StoredRow>() }));

vi.mock('$lib/server/database/queries/jellyfin-client-passwords.queries', () => ({
    getPasswordByUserId: {
        one: async (_sql: unknown, { userId }: { userId: string }) => rows.get(userId) ?? null,
    },
    getPasswordByUsername: { one: async () => null },
    upsertPassword: {
        execute: async (
            _sql: unknown,
            {
                userId,
                passwordHash,
                passwordSealed,
            }: { userId: string; passwordHash: string; passwordSealed: string | null },
        ) => {
            rows.set(userId, {
                id: 1,
                user_id: userId,
                password_hash: passwordHash,
                password_sealed: passwordSealed,
                created_at: new Date(0),
                last_used_at: null,
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

const { getOrCreatePassword, resetPassword, revealPassword, validatePassword } =
    await import('./auth.js');

beforeEach(() => {
    rows.clear();
});

describe('client password generation', () => {
    it('draws every character with an unbiased randomInt over the whole alphabet', async () => {
        const actual = await vi.importActual<typeof import('crypto')>('crypto');
        randomIntSpy.mockClear();
        randomIntSpy.mockImplementation(((max: number) => max - 1) as never);
        const pw = await resetPassword('u-bias').finally(() =>
            randomIntSpy.mockImplementation(actual.randomInt as never),
        );
        // Last alphabet character, eight times: only possible if the index is the
        // randomInt result itself.
        expect(pw).toBe('99999999');
        expect(randomIntSpy).toHaveBeenCalledTimes(8);
        expect(randomIntSpy).toHaveBeenCalledWith(31);
    });
});

describe('client password reveal', () => {
    it('reveals exactly the password that was issued', async () => {
        const issued = await getOrCreatePassword('u1');

        expect(await revealPassword('u1')).toBe(issued);
    });

    it('reveals the new password after a reset, not the old one', async () => {
        const first = await getOrCreatePassword('u1');
        const second = await resetPassword('u1');

        expect(second).not.toBe(first);
        expect(await revealPassword('u1')).toBe(second);
    });

    it('stores the sealed copy encrypted, never in the clear', async () => {
        const issued = await getOrCreatePassword('u1');
        const stored = rows.get('u1')!;

        expect(stored.password_sealed).toMatch(/^enc:v2:/);
        expect(stored.password_sealed).not.toContain(issued);
        // The hash is a separate, one-way value — the two columns must not have
        // collapsed into storing the same thing.
        expect(stored.password_hash).toMatch(/^scrypt\$/);
        expect(stored.password_hash).not.toContain(issued);
    });

    it('returns null when the user has no password at all', async () => {
        expect(await revealPassword('nobody')).toBeNull();
    });

    it('returns null for a row written before the sealed copy existed', async () => {
        await getOrCreatePassword('u1');
        rows.get('u1')!.password_sealed = null;

        expect(await revealPassword('u1')).toBeNull();
    });

    it('returns null rather than throwing when the sealed value is corrupt', async () => {
        await getOrCreatePassword('u1');
        rows.get('u1')!.password_sealed = 'enc:v1:not-valid-base64-ciphertext';

        expect(await revealPassword('u1')).toBeNull();
    });

    it('keeps the sealed copy out of the authentication path', async () => {
        await getOrCreatePassword('u1');

        // getPasswordByUsername is mocked to return null, so a login attempt
        // must fail — proving validatePassword consults that query (and thus
        // password_hash) and not the reversible copy reachable via user id.
        expect(await validatePassword('denis', 'whatever')).toBeNull();
    });

    // ── Row binding (security review 2026-09-13, C19) ─────────────────────────
    //
    // The reveal endpoint is the read side of the same shape the Subsonic
    // finding named: copy another user's `password_sealed` into your own row
    // and settings prints their PIN. The envelope is bound to its own user_id.

    it('returns null for an envelope transplanted from another user', async () => {
        const adminPin = await getOrCreatePassword('u1');
        await getOrCreatePassword('u2');
        // u2's row now carries u1's ciphertext, verbatim.
        rows.get('u2')!.password_sealed = rows.get('u1')!.password_sealed;

        expect(await revealPassword('u2')).toBeNull();
        // u1's own row is untouched and still reveals.
        expect(await revealPassword('u1')).toBe(adminPin);
    });

    it('keeps a legacy enc:v1: envelope readable', async () => {
        // Rows sealed before C19 carry no binding; locking them out would mean
        // a reset for every existing /j client. They must still open.
        const { deriveMasterKey, sealSecret } = await import('$lib/server/crypto/secret-box.js');
        await getOrCreatePassword('u1');
        rows.get('u1')!.password_sealed = sealSecret('legacy12', deriveMasterKey('a'.repeat(64)));

        expect(await revealPassword('u1')).toBe('legacy12');
    });
});
