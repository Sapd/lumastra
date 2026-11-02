// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `validateUsername` — the shape + reservation gate shared by
 * first-admin setup (`completeNativeSetup`) and admin-created users
 * (`admin-user.service.ts#createUser`). Pure function, no collaborators to
 * mock.
 */

import { describe, it, expect } from 'vitest';
import { validateUsername } from './native-auth.service.js';

describe('validateUsername', () => {
    it('accepts a normal username', () => {
        expect(validateUsername('bob')).toBeNull();
        expect(validateUsername('bob.doe_1')).toBeNull();
    });

    it('rejects an invalid shape', () => {
        expect(validateUsername('')).not.toBeNull();
        expect(validateUsername('!')).not.toBeNull();
    });

    it('rejects the reserved "system" username so no account can collide with the internal-actor sentinel', () => {
        expect(validateUsername('system')).not.toBeNull();
        expect(validateUsername('System')).not.toBeNull();
        expect(validateUsername('SYSTEM')).not.toBeNull();
    });

    it('does not reject "admin" — a plausible real operator account', () => {
        expect(validateUsername('admin')).toBeNull();
    });
});
