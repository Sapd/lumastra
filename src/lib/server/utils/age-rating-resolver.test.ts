// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { resolveMaxAgeFromGroups } from './age-rating-resolver';

describe('resolveMaxAgeFromGroups', () => {
    it('returns null when no age groups present', () => {
        expect(resolveMaxAgeFromGroups(['users', 'media'])).toBeNull();
    });

    it('extracts age from age-{N} group', () => {
        expect(resolveMaxAgeFromGroups(['users', 'age-12'])).toBe(12);
    });

    it('takes the highest when multiple age groups', () => {
        expect(resolveMaxAgeFromGroups(['age-6', 'age-12'])).toBe(12);
    });

    it('is case-insensitive', () => {
        expect(resolveMaxAgeFromGroups(['Age-16', 'USERS'])).toBe(16);
    });

    it('handles age-0', () => {
        expect(resolveMaxAgeFromGroups(['age-0'])).toBe(0);
    });

    it('ignores malformed groups', () => {
        expect(resolveMaxAgeFromGroups(['age-', 'age-abc', 'age-12'])).toBe(12);
    });

    it('ignores groups that contain age- but are not the pattern', () => {
        expect(resolveMaxAgeFromGroups(['manage-users', 'stage-deploy'])).toBeNull();
    });

    describe('custom prefix', () => {
        it('uses custom prefix', () => {
            expect(resolveMaxAgeFromGroups(['kids-12', 'users'], 'kids-')).toBe(12);
        });

        it('ignores default prefix when custom is set', () => {
            expect(resolveMaxAgeFromGroups(['age-12', 'users'], 'kids-')).toBeNull();
        });

        it('handles prefix with special regex characters', () => {
            expect(resolveMaxAgeFromGroups(['rating.12'], 'rating.')).toBe(12);
        });
    });
});
