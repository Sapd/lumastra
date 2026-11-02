// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    estimatePasswordStrength,
    validatePasswordPolicy,
    PASSWORD_MIN_LENGTH,
    PASSWORD_MAX_LENGTH,
} from './password-strength';

describe('estimatePasswordStrength', () => {
    it('flags a short password as unacceptable', () => {
        const r = estimatePasswordStrength('Ab1!');
        expect(r.acceptable).toBe(false);
        expect(r.warnings.join(' ')).toContain(`${PASSWORD_MIN_LENGTH}`);
    });

    it('flags a common password as very weak', () => {
        const r = estimatePasswordStrength('password');
        expect(r.score).toBe(0);
        expect(r.acceptable).toBe(false);
    });

    it('accepts a long mixed-class password', () => {
        const r = estimatePasswordStrength('Tr0ub4dour-and-Three');
        expect(r.acceptable).toBe(true);
        expect(r.score).toBeGreaterThanOrEqual(2);
    });

    it('rates a long high-variety password as strong', () => {
        const r = estimatePasswordStrength('xK9$mvPq7!wLr2#zTn4@');
        expect(r.score).toBe(4);
        expect(r.label).toBe('strong');
    });

    it('penalizes a single repeated character', () => {
        const r = estimatePasswordStrength('aaaaaaaaaaaaaa');
        expect(r.score).toBeLessThanOrEqual(1);
        expect(r.acceptable).toBe(false);
    });

    it('penalizes a simple leading sequence', () => {
        const r = estimatePasswordStrength('1234567890abcd');
        expect(r.score).toBeLessThanOrEqual(1);
    });
});

describe('validatePasswordPolicy', () => {
    it('returns an error for a short password', () => {
        expect(validatePasswordPolicy('short1!')).not.toBeNull();
    });

    it('returns an error for a weak common password', () => {
        expect(validatePasswordPolicy('password1234')).not.toBeNull();
    });

    it('returns null for an acceptable password', () => {
        expect(validatePasswordPolicy('Tr0ub4dour-and-Three')).toBeNull();
    });
});

describe('validatePasswordPolicy — maximum length', () => {
    it('rejects a password longer than PASSWORD_MAX_LENGTH with a clear message', () => {
        const err = validatePasswordPolicy('Tr0ub4dour-' + 'x'.repeat(PASSWORD_MAX_LENGTH));
        expect(err).toContain(`${PASSWORD_MAX_LENGTH}`);
    });

    it('accepts a strong password at exactly PASSWORD_MAX_LENGTH', () => {
        const base = 'Tr0ub4dour-and-Three!';
        const pw = (base + 'Ab9#').repeat(PASSWORD_MAX_LENGTH).slice(0, PASSWORD_MAX_LENGTH);
        expect(pw.length).toBe(PASSWORD_MAX_LENGTH);
        expect(validatePasswordPolicy(pw)).toBeNull();
    });
});
