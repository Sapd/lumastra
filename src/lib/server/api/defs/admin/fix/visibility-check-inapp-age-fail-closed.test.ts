// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The admin visibility-check diagnostic must fail CLOSED on the age axis when
 * the in-app access layer cannot be resolved — the same posture security
 * review 2026-09-17 (C12) established for `forward-auth.ts`'s
 * `resolveInAppAccess` and `resolve-token-user-access.ts`'s
 * `resolveInAppAccessSafe`.
 *
 * This endpoint held a third copy of the fixed-twice shape: a
 * `.catch(() => ({ ..., capabilities: {} }))` around `resolveEffectiveAccess`,
 * feeding an empty capability set into `buildUserPermissions`. Because
 * `max_age_rating` is MIN-merged (restrictive) rather than additive, an empty
 * set does not "degrade to nothing extra" on that axis — it ERASES the
 * ceiling. The tool then told the operator the age gate was "skipped — this
 * user has no age ceiling configured" for a user who is in fact restricted,
 * which is the precise wrong answer the comment above that call already
 * documents having fixed once.
 *
 * `buildUserPermissions` is deliberately NOT mocked: the merge it performs on
 * `extraCapabilities` is the behaviour under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const USER_ID = '66666666-6666-6666-6666-666666666601';
const MEDIA_ID = '77777777-7777-7777-7777-777777777701';

// A tagged-template stub for the one `sql\`SELECT ... media_items\`` call.
const sqlStub = Object.assign(
    async () => [
        {
            id: MEDIA_ID,
            title: 'Some Rated Film',
            media_type: 'movie',
            has_files: true,
            age_rating: 12,
            status: 'active',
            browsable: true,
        },
    ],
    {},
);

vi.mock('$lib/server/database/connection.js', () => ({
    getAdminDb: () => sqlStub,
}));

// No age group and NO per-user pin: the only possible ceiling is in-app.
const baseUser = {
    id: USER_ID,
    username: 'inapp-only-kid',
    is_admin: false,
    admin_pinned: false,
    max_age_rating: null as number | null,
    age_rating_pinned: false,
    groups: [] as string[],
    disabled_at: null,
    deleted_at: null,
};
const mockGetUserById = vi.fn(async () => ({ ...baseUser }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: () => mockGetUserById(),
}));

// Defaults to FAILING — the exact fault class C12 covers. Individual tests
// override it with a healthy resolution.
const mockResolveEffectiveAccess = vi.fn(async (): Promise<unknown> => {
    throw new Error('access-control DB read failed (simulated)');
});
vi.mock('$lib/server/services/access-control.service.js', () => ({
    resolveEffectiveAccess: () => mockResolveEffectiveAccess(),
}));

vi.mock('$lib/server/cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups: async () => null,
    isMediaAccessible: async () => true,
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: async () => ({ allowed: false, reason: 'age' }),
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        ADMIN_GROUPS: ['admin'],
        WATCH_PERMISSION_GROUPS: ['admin'],
        LIVETV_GROUPS: ['livetv'],
        REQUEST_GROUPS: [],
        SOCIAL_REVIEW_GROUPS: [],
        MEDIA_ANNOTATION_GROUPS: [],
        MODERATOR_GROUPS: [],
        LIVETV_HIGH_PRIORITY_GROUPS: [],
        ARR_MANAGER_GROUPS: [],
        AGE_RATING_GROUP_PREFIX: 'age-',
        UNRATED_CONTENT_VISIBLE: true,
    },
}));

const { def } = await import('./visibility-check.js');

interface Gate {
    gate: string;
    code: string;
    params: Record<string, string | number>;
    passed: boolean;
    evaluated: boolean;
    detail: string;
}

async function runCheck(): Promise<{ gates: Gate[] }> {
    const resp = await def.handlers.GET!(
        {} as never,
        {
            input: { query: { userId: USER_ID, mediaId: MEDIA_ID } },
        } as never,
    );
    return (await (resp as Response).json()) as { gates: Gate[] };
}

describe('admin visibility-check — in-app access failure must fail CLOSED on the age axis', () => {
    beforeEach(() => {
        mockGetUserById.mockClear();
        mockResolveEffectiveAccess.mockClear();
    });

    it('evaluates the age gate against the most-restrictive ceiling instead of reporting "no age ceiling"', async () => {
        const body = await runCheck();
        const ageGate = body.gates.find((g) => g.gate === 'age-rating');

        // The bug: `capabilities: {}` erased the ceiling, so this gate came
        // back evaluated:false with "this user has no age ceiling configured"
        // — telling the operator a restricted user can see a rated item.
        expect(ageGate?.evaluated).toBe(true);
        expect(ageGate?.passed).toBe(false);
        expect(ageGate?.detail).toContain('ceiling of 0');
        // The page renders the code in the user's language; the fallback note
        // travels as a param so it is not lost in translation.
        expect(body.gates.find((g) => g.gate === 'age-rating')).toMatchObject({
            code: 'age-above',
            params: { rating: 12, max: 0, fallback: 1 },
        });
    });
});

describe('admin visibility-check — a per-user pin must not RAISE a stricter in-app ceiling', () => {
    beforeEach(() => {
        mockGetUserById.mockClear();
        mockResolveEffectiveAccess.mockClear();
    });

    it('reports the MOST RESTRICTIVE of a permissive pin and a stricter in-app cohort', async () => {
        // Pinned at 18, but an in-app cohort caps the account at 6.
        // `resolveTokenUserAccess` (what production actually runs) resolves this
        // as mergeMaxAge(pin, inAppMerged) = MIN(18, 6) = 6. The pre-fix
        // `age_rating_pinned ? pin : derived` returned 18 outright, dropping the
        // in-app ceiling for every PINNED user and telling the operator a
        // 12-rated item was visible when production denies it.
        mockGetUserById.mockResolvedValueOnce({
            ...baseUser,
            max_age_rating: 18,
            age_rating_pinned: true,
        });
        mockResolveEffectiveAccess.mockResolvedValueOnce({
            inAppGroupNames: ['kids-cohort'],
            effectiveGroups: ['kids-cohort'],
            capabilities: { maxAgeRating: 6 },
        });

        const body = await runCheck();
        const ageGate = body.gates.find((g) => g.gate === 'age-rating');

        expect(ageGate?.evaluated).toBe(true);
        expect(ageGate?.detail).toContain('ceiling of 6');
        // Item is rated 12, above the real ceiling of 6 — so it must FAIL.
        expect(ageGate?.passed).toBe(false);
    });
});
