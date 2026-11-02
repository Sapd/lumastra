// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    hashPassword,
    verifyPassword,
    needsRehash,
    PasswordTooLongError,
    MAX_PASSWORD_LENGTH,
} from './password';

describe('password hashing (scrypt)', () => {
    it('round-trips a correct password', async () => {
        const stored = await hashPassword('correct horse battery staple');
        expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    });

    it('rejects a wrong password', async () => {
        const stored = await hashPassword('correct horse battery staple');
        expect(await verifyPassword('wrong horse battery staple', stored)).toBe(false);
    });

    it('produces a unique salt per hash (no deterministic output)', async () => {
        const a = await hashPassword('same-password-here');
        const b = await hashPassword('same-password-here');
        expect(a).not.toEqual(b);
        // Both still verify.
        expect(await verifyPassword('same-password-here', a)).toBe(true);
        expect(await verifyPassword('same-password-here', b)).toBe(true);
    });

    it('emits the self-describing scrypt format', async () => {
        const stored = await hashPassword('whatever-passphrase');
        expect(stored).toMatch(/^scrypt\$N=\d+,r=\d+,p=\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    });

    it('verifyPassword returns false (never throws) for malformed stored values', async () => {
        expect(await verifyPassword('x', '')).toBe(false);
        expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
        expect(await verifyPassword('x', 'scrypt$bad$salt')).toBe(false);
        expect(await verifyPassword('x', 'bcrypt$N=1$a$b')).toBe(false);
        expect(await verifyPassword('x', 'scrypt$N=0,r=0,p=0$$')).toBe(false);
    });

    it('rejects an over-long password on hash', async () => {
        await expect(hashPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toBeInstanceOf(
            PasswordTooLongError,
        );
    });

    it('returns false for an over-long password on verify', async () => {
        const stored = await hashPassword('a-normal-password');
        expect(await verifyPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1), stored)).toBe(false);
    });

    it('needsRehash is false for a freshly produced hash, true for weaker params', async () => {
        const stored = await hashPassword('rehash-check-password');
        expect(needsRehash(stored)).toBe(false);
        expect(needsRehash('scrypt$N=16384,r=8,p=1$YWJj$ZGVm')).toBe(true);
        expect(needsRehash('garbage')).toBe(true);
    });
});
