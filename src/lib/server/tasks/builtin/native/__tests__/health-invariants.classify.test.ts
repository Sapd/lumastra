// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `classifyStatus` — including the operatorActionable cap.
 *
 * This exists because the cap shipped with NO test that it does anything. The
 * sibling tests assert the FLAG is set on the right invariants and that it
 * agrees with their prose; none of them exercised the function the flag
 * controls. Making `classifyStatus` ignore `operatorActionable` — the exact
 * wrongness the flag was added to prevent, restoring a permanent unclearable
 * red on the operator's dashboard — would have left every test green.
 *
 * `invariants.test.ts` also MIRRORS this logic locally rather than importing
 * it, and a mirror cannot fail when the real function changes. Hence the
 * export and this direct test.
 */

import { describe, it, expect } from 'vitest';
import { classifyStatus } from '../health-invariants.js';

describe('classifyStatus', () => {
    it('classifies on strict > of each threshold', () => {
        expect(classifyStatus(0, 0, 0)).toBe('green');
        expect(classifyStatus(1, 0, 0)).toBe('red');
        expect(classifyStatus(5, 10, 100)).toBe('green');
        expect(classifyStatus(11, 10, 100)).toBe('amber');
        expect(classifyStatus(101, 10, 100)).toBe('red');
    });

    it('defaults to actionable — the cap is an exception, not the norm', () => {
        expect(classifyStatus(1, 0, 0)).toBe('red');
        expect(classifyStatus(1, 0, 0, true)).toBe('red');
    });

    it('CAPS an unactionable finding at amber, however far past red it goes', () => {
        // The whole point: a finding whose remediation is "nothing you can do
        // from here" must never hold a red the operator cannot clear.
        expect(classifyStatus(1, 0, 0, false)).toBe('amber');
        expect(classifyStatus(999_999, 0, 0, false)).toBe('amber');
    });

    it('does not promote a green finding just because it is unactionable', () => {
        // The cap only ever lowers. An unactionable invariant at zero is still
        // green — otherwise the board fills with permanent amber noise.
        expect(classifyStatus(0, 0, 0, false)).toBe('green');
        expect(classifyStatus(5, 10, 100, false)).toBe('green');
    });

    it('leaves the amber band untouched for an unactionable finding', () => {
        expect(classifyStatus(11, 10, 100, false)).toBe('amber');
    });
});
