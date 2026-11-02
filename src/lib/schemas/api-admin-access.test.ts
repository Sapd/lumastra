// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for access-group capability value validation (standalone multi-user).
 * `max_age_rating` must be a bounded integer; boolean caps must not carry a value.
 */

import { describe, it, expect } from 'vitest';
import {
    AccessGroupCapabilitySchema,
    CreateAccessGroupBodySchema,
    MAX_AGE_RATING_CEILING,
} from './api-admin-access.js';

describe('AccessGroupCapabilitySchema value validation', () => {
    it('accepts a valid numeric max_age_rating', () => {
        expect(
            AccessGroupCapabilitySchema.safeParse({ capability: 'max_age_rating', value: '12' })
                .success,
        ).toBe(true);
        expect(
            AccessGroupCapabilitySchema.safeParse({ capability: 'max_age_rating', value: '0' })
                .success,
        ).toBe(true);
    });

    it('rejects max_age_rating with a non-numeric / negative / out-of-range value', () => {
        for (const value of ['nan', '-1', String(MAX_AGE_RATING_CEILING + 1), '12.5', '']) {
            expect(
                AccessGroupCapabilitySchema.safeParse({ capability: 'max_age_rating', value })
                    .success,
            ).toBe(false);
        }
    });

    it('rejects max_age_rating with a missing value', () => {
        expect(
            AccessGroupCapabilitySchema.safeParse({ capability: 'max_age_rating' }).success,
        ).toBe(false);
    });

    it('accepts a boolean cap with no value', () => {
        expect(AccessGroupCapabilitySchema.safeParse({ capability: 'livetv' }).success).toBe(true);
        expect(
            AccessGroupCapabilitySchema.safeParse({ capability: 'livetv', value: null }).success,
        ).toBe(true);
    });

    it('rejects a boolean cap that carries a value (silently-ignored typo guard)', () => {
        expect(
            AccessGroupCapabilitySchema.safeParse({ capability: 'livetv', value: 'high' }).success,
        ).toBe(false);
        expect(
            AccessGroupCapabilitySchema.safeParse({ capability: 'admin', value: 'true' }).success,
        ).toBe(false);
    });

    it('CreateAccessGroupBody rejects an invalid capability value', () => {
        const res = CreateAccessGroupBodySchema.safeParse({
            name: 'Bad',
            capabilities: [{ capability: 'max_age_rating', value: '999' }],
        });
        expect(res.success).toBe(false);
    });
});
