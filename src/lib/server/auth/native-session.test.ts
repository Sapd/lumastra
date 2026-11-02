// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for buildUserContextFromSession (the standalone-multiuser PRIMARY
 * auth path). Focus: the age-rating pin/cohort merge must be MOST-RESTRICTIVE so
 * a permissive pin can never RAISE a more-restrictive in-app cohort's ceiling
 * (consistency with the forward-auth mergeMaxAge path).
 */

import { describe, it, expect } from 'vitest';
import { buildUserContextFromSession } from './native-session.js';
import type { ValidatedSessionRow } from '$lib/server/database/queries/user-sessions.queries.js';

function row(overrides: Partial<ValidatedSessionRow> = {}): ValidatedSessionRow {
    return {
        session_id: 's',
        user_id: '00000000-0000-0000-0000-000000000001',
        username: 'kid',
        groups: null,
        is_admin: false,
        admin_pinned: false,
        max_age_rating: null,
        age_rating_pinned: false,
        ...overrides,
    };
}

describe('buildUserContextFromSession — age-rating pin vs in-app cohort merge', () => {
    it('pinned-high user in a max_age_rating=6 cohort is capped at 6 (pin cannot raise)', () => {
        const ctx = buildUserContextFromSession(
            row({ age_rating_pinned: true, max_age_rating: 18 }),
            { extraCapabilities: { maxAgeRating: 6 } },
        );
        expect(ctx.maxAgeRating).toBe(6);
        expect(ctx.isAgeRestricted).toBe(true);
    });

    it('pin applies when no in-app cohort age cap is present', () => {
        const ctx = buildUserContextFromSession(
            row({ age_rating_pinned: true, max_age_rating: 12 }),
            { extraCapabilities: {} },
        );
        expect(ctx.maxAgeRating).toBe(12);
    });

    it('in-app cohort age cap applies when not pinned', () => {
        const ctx = buildUserContextFromSession(row({ age_rating_pinned: false }), {
            extraCapabilities: { maxAgeRating: 6 },
        });
        expect(ctx.maxAgeRating).toBe(6);
    });

    it('no pin, no cohort cap → unrestricted (backward compatible)', () => {
        const ctx = buildUserContextFromSession(row());
        expect(ctx.maxAgeRating).toBeNull();
        expect(ctx.isAgeRestricted).toBe(false);
    });

    it('admin (via pin) is always unrestricted regardless of a cohort cap', () => {
        const ctx = buildUserContextFromSession(row({ admin_pinned: true, is_admin: true }), {
            extraCapabilities: { maxAgeRating: 6 },
        });
        expect(ctx.ownerIsAdmin).toBe(true);
        expect(ctx.maxAgeRating).toBeNull();
        expect(ctx.isAgeRestricted).toBe(false);
    });
});
