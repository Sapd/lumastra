// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { RESERVED_USERNAMES, isReservedUsername } from './reserved-usernames.js';

describe('isReservedUsername', () => {
    it('reserves the internal "system" actor sentinel', () => {
        expect(isReservedUsername('system')).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(isReservedUsername('SYSTEM')).toBe(true);
        expect(isReservedUsername('SyStEm')).toBe(true);
    });

    it('trims surrounding whitespace before comparing', () => {
        expect(isReservedUsername('  system  ')).toBe(true);
    });

    it('does not reserve "admin" — a plausible real operator account', () => {
        expect(isReservedUsername('admin')).toBe(false);
        expect(RESERVED_USERNAMES.has('admin')).toBe(false);
    });

    it('does not reserve an ordinary username', () => {
        expect(isReservedUsername('bob')).toBe(false);
        expect(isReservedUsername('systematic')).toBe(false);
    });
});
