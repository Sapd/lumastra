// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { deprecationSpecFields } from './generate-public';

describe('deprecationSpecFields', () => {
    const block = { since: '2026-11-01', sunset: '2027-02-01', replacement: '/diagnostics/events' };

    it('emits deprecated: true and x-deprecation for a deprecated operation', () => {
        expect(deprecationSpecFields('deprecated', block)).toEqual({ deprecated: true, 'x-deprecation': block });
    });

    it('emits nothing for a current operation', () => {
        expect(deprecationSpecFields('stable', undefined)).toEqual({});
    });

    it('refuses deprecated without a block, a block without deprecated, and a bad block', () => {
        expect(deprecationSpecFields('deprecated', undefined)).toBe(
            "stability 'deprecated' needs a deprecation block (since, replacement)",
        );
        expect(deprecationSpecFields('beta', block)).toBe("a deprecation block needs stability 'deprecated'");
        expect(deprecationSpecFields('deprecated', { ...block, sunset: '2026-11-02' })).toBe(
            'deprecation block: sunset is 1 days after since; the policy needs at least 90',
        );
    });
});
