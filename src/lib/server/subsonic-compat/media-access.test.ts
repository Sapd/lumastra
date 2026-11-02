// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { ageRatingFromAuth, subsonicBoundary } from './media-access';
import { isUnrestricted } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { SubsonicAuthContext } from './types';

function auth(overrides: Partial<SubsonicAuthContext>): SubsonicAuthContext {
    return {
        userId: 'u' as SubsonicAuthContext['userId'],
        username: 'u',
        ownerIsAdmin: false,
        displayName: null,
        clientName: 'unit',
        format: 'json',
        userGroups: [],
        maxAgeRating: null,
        isAgeRestricted: false,
        ...overrides,
    };
}

describe('ageRatingFromAuth', () => {
    it('is null for an unrestricted caller', () => {
        expect(ageRatingFromAuth(auth({}))).toBeNull();
    });

    it('carries the caller age limit', () => {
        expect(ageRatingFromAuth(auth({ isAgeRestricted: true, maxAgeRating: 12 }))).toMatchObject({
            maxAgeRating: 12,
        });
    });

    it('fails closed when an age-restricted caller has no limit value', () => {
        // checkAgeGate treats this shape as maxAge 0; the list boundary must not
        // collapse to "any age" for it.
        const age = ageRatingFromAuth(auth({ isAgeRestricted: true, maxAgeRating: null }));
        expect(age).toMatchObject({ maxAgeRating: 0 });
        expect(isUnrestricted(subsonicBoundary(null, age))).toBe(false);
    });
});
