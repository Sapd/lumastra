// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Access Boundary Tests
 *
 * Covers the required-by-shape boundary type, its explicit constructors, and
 * the emitted SQL fragment for all NINE combinations of LibraryScope x AgeScope.
 */

import { describe, it, expect } from 'vitest';
import postgres from 'postgres';
import {
    denyAllAccess,
    deniesEverything,
    isUnrestricted,
    isLibraryGroupVisible,
    boundaryCacheKey,
    restrictedAccess,
    unrestrictedAccess,
} from './media-access-boundary.js';
import type { AgeScope, LibraryScope, MediaAccessBoundary } from './media-access-boundary.js';
import { buildLibraryAccessFilter } from './library-access.builder.js';
import { buildAgeRatingFilter } from './age-rating.builder.js';

// Never connected — we only inspect the template fragments it produces.
const sql = postgres('postgres://localhost');

/**
 * A table alias reaches a template as `sql(alias)`, which postgres.js turns
 * into an `Identifier` — spliced into the SQL TEXT as a quoted identifier
 * (`"mi"`), never bound as a parameter. Resolving those back is what lets the
 * assertions below read the alias a fragment actually correlated on.
 */
function isIdentifier(arg: unknown): arg is { value: string } {
    return (
        typeof arg === 'object' &&
        arg !== null &&
        arg.constructor?.name === 'Identifier' &&
        typeof (arg as { value?: unknown }).value === 'string'
    );
}

/**
 * Flatten a postgres.js template fragment to its literal SQL text: identifiers
 * inlined as postgres.js emits them, `?` for each genuinely bound parameter.
 * Takes `unknown` because `PendingQuery` does not expose `strings` on its
 * public type.
 */
function render(fragment: unknown): string {
    const { strings, args } = fragment as {
        strings?: readonly string[];
        args?: readonly unknown[];
    };
    if (!strings) return '';
    let out = strings[0] ?? '';
    for (let i = 1; i < strings.length; i++) {
        const arg = args?.[i - 1];
        out +=
            (isIdentifier(arg)
                ? arg.value
                : arg !== null &&
                    typeof arg === 'object' &&
                    Array.isArray((arg as { strings?: unknown }).strings)
                  ? render(arg)
                  : '?') + strings[i];
    }
    return out.replace(/\s+/g, ' ').trim();
}

/**
 * Read a fragment's genuinely BOUND parameters. postgres.js exposes these as
 * `args` (`values` is a result-mode method on Query, not the parameter list).
 * `Identifier` entries are excluded on purpose: a table alias is inlined into
 * the SQL text, not bound, and counting them here would let a denied-id array
 * that got interpolated rather than bound hide among them.
 */
function argsOf(fragment: unknown): readonly unknown[] {
    const args = (fragment as { args?: readonly unknown[] }).args;
    return (args ?? []).filter((a) => !isIdentifier(a));
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

describe('constructors', () => {
    it('unrestrictedAccess opens both axes explicitly', () => {
        expect(unrestrictedAccess()).toEqual({
            library: { kind: 'all' },
            age: { kind: 'any' },
        });
    });

    it('denyAllAccess closes both axes', () => {
        expect(denyAllAccess()).toEqual({
            library: { kind: 'denyAll' },
            age: { kind: 'denyAll' },
        });
    });

    it('returns fresh objects so callers cannot mutate a shared singleton', () => {
        const a = unrestrictedAccess();
        const b = unrestrictedAccess();
        expect(a).not.toBe(b);
        expect(a.library).not.toBe(b.library);
    });

    it('restrictedAccess maps real per-user values onto both axes', () => {
        expect(
            restrictedAccess({
                deniedGroupIds: ['g1', 'g2'],
                maxAgeRating: 13,
                allowUnrated: false,
            }),
        ).toEqual({
            library: { kind: 'denyGroups', ids: ['g1', 'g2'] },
            age: { kind: 'limit', maxAgeRating: 13, allowUnrated: false },
        });
    });

    it('restrictedAccess collapses an empty denied list to all', () => {
        const boundary = restrictedAccess({
            deniedGroupIds: [],
            maxAgeRating: 18,
            allowUnrated: true,
        });
        expect(boundary.library).toEqual({ kind: 'all' });
        expect(boundary.age).toEqual({ kind: 'limit', maxAgeRating: 18, allowUnrated: true });
    });

    it('restrictedAccess collapses a null maxAgeRating to any', () => {
        const boundary = restrictedAccess({
            deniedGroupIds: ['g1'],
            maxAgeRating: null,
            allowUnrated: false,
        });
        expect(boundary.age).toEqual({ kind: 'any' });
    });

    it('restrictedAccess copies the denied ids rather than aliasing the input', () => {
        const ids = ['g1'];
        const boundary = restrictedAccess({
            deniedGroupIds: ids,
            maxAgeRating: null,
            allowUnrated: false,
        });
        ids.push('g2');
        expect(boundary.library).toEqual({ kind: 'denyGroups', ids: ['g1'] });
    });

    it('restrictedAccess never produces denyAll — that is denyAllAccess only', () => {
        const boundary = restrictedAccess({
            deniedGroupIds: [],
            maxAgeRating: null,
            allowUnrated: false,
        });
        expect(deniesEverything(boundary)).toBe(false);
        expect(isUnrestricted(boundary)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

describe('deniesEverything / isUnrestricted', () => {
    it('deniesEverything is true when either axis is denyAll', () => {
        expect(deniesEverything(denyAllAccess())).toBe(true);
        expect(deniesEverything({ library: { kind: 'denyAll' }, age: { kind: 'any' } })).toBe(true);
        expect(deniesEverything({ library: { kind: 'all' }, age: { kind: 'denyAll' } })).toBe(true);
    });

    it('deniesEverything is false for open or merely restricted boundaries', () => {
        expect(deniesEverything(unrestrictedAccess())).toBe(false);
        expect(
            deniesEverything({
                library: { kind: 'denyGroups', ids: ['g'] },
                age: { kind: 'limit', maxAgeRating: 6, allowUnrated: false },
            }),
        ).toBe(false);
    });

    it('isUnrestricted is true only when both axes are fully open', () => {
        expect(isUnrestricted(unrestrictedAccess())).toBe(true);
        expect(isUnrestricted(denyAllAccess())).toBe(false);
        expect(
            isUnrestricted({ library: { kind: 'denyGroups', ids: ['g'] }, age: { kind: 'any' } }),
        ).toBe(false);
        expect(
            isUnrestricted({
                library: { kind: 'all' },
                age: { kind: 'limit', maxAgeRating: 18, allowUnrated: true },
            }),
        ).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// restrictedAccess — construction from a real user's values
// ---------------------------------------------------------------------------

describe('restrictedAccess', () => {
    it('maps an empty denied array + null age to fully unrestricted', () => {
        expect(
            restrictedAccess({ deniedGroupIds: [], maxAgeRating: null, allowUnrated: false }),
        ).toEqual(unrestrictedAccess());
    });

    it('maps a non-empty denied array to denyGroups', () => {
        expect(
            restrictedAccess({
                deniedGroupIds: ['a', 'b'],
                maxAgeRating: null,
                allowUnrated: false,
            }).library,
        ).toEqual({ kind: 'denyGroups', ids: ['a', 'b'] });
    });

    it('maps a numeric bound to limit', () => {
        expect(
            restrictedAccess({ deniedGroupIds: [], maxAgeRating: 16, allowUnrated: true }).age,
        ).toEqual({ kind: 'limit', maxAgeRating: 16, allowUnrated: true });
    });

    it('never expresses denyAll — restricted real users always see something', () => {
        const inputs = [
            { deniedGroupIds: [], maxAgeRating: null, allowUnrated: false },
            { deniedGroupIds: ['g'], maxAgeRating: 0, allowUnrated: false },
        ];
        for (const input of inputs) {
            expect(deniesEverything(restrictedAccess(input))).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// All nine LibraryScope x AgeScope combinations
// ---------------------------------------------------------------------------

const LIBRARY_SCOPES: Record<string, LibraryScope> = {
    all: { kind: 'all' },
    denyGroups: { kind: 'denyGroups', ids: ['grp-1', 'grp-2'] },
    denyAll: { kind: 'denyAll' },
};

const AGE_SCOPES: Record<string, AgeScope> = {
    any: { kind: 'any' },
    limit: { kind: 'limit', maxAgeRating: 16, allowUnrated: true },
    denyAll: { kind: 'denyAll' },
};

describe('emitted SQL for all nine scope combinations', () => {
    for (const [libName, library] of Object.entries(LIBRARY_SCOPES)) {
        for (const [ageName, age] of Object.entries(AGE_SCOPES)) {
            it(`library=${libName} age=${ageName}`, () => {
                const boundary: MediaAccessBoundary = { library, age };

                const librarySql = render(buildLibraryAccessFilter(sql, boundary.library));
                const ageSql = render(buildAgeRatingFilter(sql, boundary.age));

                // --- library axis ---
                if (libName === 'all') {
                    expect(librarySql).toBe('');
                } else if (libName === 'denyAll') {
                    expect(librarySql).toBe('AND false');
                } else {
                    expect(librarySql).toContain('NOT EXISTS');
                    expect(librarySql).toContain('media_file_items');
                    expect(librarySql).toContain('mf.library_group_id != ALL(');
                    // Container rows (tv/season/artist/album) dispatch to a
                    // descendant-walk EXISTS instead of the leaf "own files"
                    // predicate (C3, task 4) — see library-access.builder.test.ts
                    // for the per-branch SQL shape.
                    // `"mi"` quoted: the alias is emitted as an Identifier
                    // (the builder's default), not interpolated text.
                    expect(librarySql).toContain('CASE "mi".media_type');
                    // The predicate is parameterized, never interpolated.
                    // ELEVEN bound arrays: five for the media_type CASE (tv,
                    // season, artist, album, else) and six for the own-column
                    // clause fix round 3 added (its `!= ALL(...)` arm plus one
                    // per branch of its guard CASE — tv, season, artist,
                    // album, else). This said five and had been RED since
                    // that clause landed; verified against pristine HEAD
                    // before changing it (2026-09-15). It said ten until
                    // 2026-09-18 (security fix-plan-4, Shape B): the guard
                    // CASE's `ELSE FALSE` arm became a positive EXISTS over
                    // the row's own files, which binds one more array.
                    expect(argsOf(buildLibraryAccessFilter(sql, boundary.library))).toEqual(
                        Array.from({ length: 11 }, () => ['grp-1', 'grp-2']),
                    );
                    expect(librarySql).not.toContain('grp-1');
                }

                // --- age axis ---
                if (ageName === 'any') {
                    expect(ageSql).toBe('');
                } else if (ageName === 'denyAll') {
                    expect(ageSql).toBe('AND false');
                } else {
                    expect(ageSql).toContain('max_age_rating');
                    expect(ageSql).toContain('IS NULL');
                    expect(ageSql).toContain('<= ');
                    const vals = argsOf(buildAgeRatingFilter(sql, boundary.age));
                    expect(vals).toContain(true); // allowUnrated
                    expect(vals).toContain(16); // maxAgeRating
                    expect(ageSql).not.toContain('16');
                }
            });
        }
    }

    it('denyAll on either axis makes the whole boundary deny everything', () => {
        for (const [libName, library] of Object.entries(LIBRARY_SCOPES)) {
            for (const [ageName, age] of Object.entries(AGE_SCOPES)) {
                const expected = libName === 'denyAll' || ageName === 'denyAll';
                expect(deniesEverything({ library, age })).toBe(expected);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// Builder back-compat with the legacy argument forms
// ---------------------------------------------------------------------------

describe('builders still accept the legacy argument forms', () => {
    it('buildLibraryAccessFilter: null / undefined / [] emit nothing', () => {
        expect(render(buildLibraryAccessFilter(sql, null))).toBe('');
        expect(render(buildLibraryAccessFilter(sql, undefined))).toBe('');
        expect(render(buildLibraryAccessFilter(sql, []))).toBe('');
    });

    it('buildLibraryAccessFilter: a legacy array emits the predicate', () => {
        expect(render(buildLibraryAccessFilter(sql, ['g']))).toContain('media_file_items');
    });

    it('buildAgeRatingFilter: null / undefined / null-bound emit nothing', () => {
        expect(render(buildAgeRatingFilter(sql, null))).toBe('');
        expect(render(buildAgeRatingFilter(sql, undefined))).toBe('');
        expect(render(buildAgeRatingFilter(sql, { maxAgeRating: null, allowUnrated: true }))).toBe(
            '',
        );
    });

    it('buildAgeRatingFilter: honours the alias override for scope input', () => {
        const scoped = render(
            buildAgeRatingFilter(
                sql,
                { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
                'm',
            ),
        );
        expect(scoped).toContain('age_rating');
        // alias is emitted as an identifier parameter, not inlined text
        expect(scoped).not.toContain('mi.');
    });

    it('buildAgeRatingFilter: rejects an unsafe alias', () => {
        expect(() =>
            buildAgeRatingFilter(
                sql,
                { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
                'a b',
            ),
        ).toThrow(/invalid alias/);
    });

    it('buildAgeRatingFilter: denyAll ignores the alias entirely', () => {
        expect(render(buildAgeRatingFilter(sql, { kind: 'denyAll' }, 'anything'))).toBe(
            'AND false',
        );
    });
});

describe('isLibraryGroupVisible', () => {
    const GROUP_A = '11111111-1111-1111-1111-111111111111';
    const GROUP_B = '22222222-2222-2222-2222-222222222222';

    it('unrestricted: every group visible, including a null group', () => {
        expect(isLibraryGroupVisible(unrestrictedAccess(), GROUP_A)).toBe(true);
        expect(isLibraryGroupVisible(unrestrictedAccess(), null)).toBe(true);
    });

    it('denyGroups: hides listed groups, keeps the rest', () => {
        const boundary = restrictedAccess({
            deniedGroupIds: [GROUP_A],
            maxAgeRating: null,
            allowUnrated: true,
        });
        expect(isLibraryGroupVisible(boundary, GROUP_A)).toBe(false);
        expect(isLibraryGroupVisible(boundary, GROUP_B)).toBe(true);
    });

    it('denyGroups: a row with no library group stays visible (matches the SQL builder)', () => {
        const boundary = restrictedAccess({
            deniedGroupIds: [GROUP_A],
            maxAgeRating: null,
            allowUnrated: true,
        });
        expect(isLibraryGroupVisible(boundary, null)).toBe(true);
    });

    it('denyAll on either axis hides everything', () => {
        expect(isLibraryGroupVisible(denyAllAccess(), GROUP_A)).toBe(false);
        expect(isLibraryGroupVisible(denyAllAccess(), null)).toBe(false);
        // age-only denyAll — the library axis alone would have let this through
        expect(
            isLibraryGroupVisible({ library: { kind: 'all' }, age: { kind: 'denyAll' } }, GROUP_A),
        ).toBe(false);
    });
});

describe('boundaryCacheKey', () => {
    const GROUP_A = '11111111-1111-1111-1111-111111111111';
    const GROUP_B = '22222222-2222-2222-2222-222222222222';

    it('gives unrestricted and denyAll DIFFERENT non-empty keys', () => {
        const unrestricted = boundaryCacheKey(unrestrictedAccess());
        const denied = boundaryCacheKey(denyAllAccess());
        expect(unrestricted).not.toBe('');
        expect(denied).not.toBe('');
        expect(unrestricted).not.toBe(denied);
    });

    it('is stable regardless of denied-group ordering', () => {
        const a = boundaryCacheKey(
            restrictedAccess({
                deniedGroupIds: [GROUP_A, GROUP_B],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );
        const b = boundaryCacheKey(
            restrictedAccess({
                deniedGroupIds: [GROUP_B, GROUP_A],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );
        expect(a).toBe(b);
    });

    it('separates callers that differ on either axis', () => {
        const keys = new Set([
            boundaryCacheKey(unrestrictedAccess()),
            boundaryCacheKey(denyAllAccess()),
            boundaryCacheKey(
                restrictedAccess({
                    deniedGroupIds: [GROUP_A],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            ),
            boundaryCacheKey(
                restrictedAccess({
                    deniedGroupIds: [GROUP_B],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            ),
            boundaryCacheKey(
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: false,
                }),
            ),
            boundaryCacheKey(
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: true,
                }),
            ),
        ]);
        expect(keys.size).toBe(6);
    });
});
