// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the watch-together session access boundary.
 *
 * The differential tests below are the ones that matter: they run the SAME
 * fixture through an unrestricted boundary and a restricted one and assert the
 * restricted result is a strict subset. That is what catches a boundary
 * argument that arrived but was never actually applied — the failure mode a
 * "does it return sessions?" test happily passes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { UserContext } from '$lib/server/types';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary';

const buildSearchAccessContext = vi.fn();

vi.mock('$lib/server/utils/search-access-context.js', async () => {
    const actual =
        await vi.importActual<typeof import('./search-access-context')>('./search-access-context');
    return {
        ...actual,
        buildSearchAccessContext: (...args: unknown[]) => buildSearchAccessContext(...args),
    };
});

const { filterSessionsByAccess, resolveWatchTogetherBoundary } =
    await import('./watch-together-access');

// ---------------------------------------------------------------------------
// Fixture: four sessions, one of which has no itemId.
// ---------------------------------------------------------------------------

const ALLOWED_ID = '11111111-1111-4111-8111-111111111111';
const DENIED_ID = '22222222-2222-4222-8222-222222222222';
const ALSO_ALLOWED_ID = '33333333-3333-4333-8333-333333333333';

interface TestSession {
    code: string;
    title: string;
    itemId?: string | null;
}

const SESSIONS: TestSession[] = [
    { code: 'AAA', title: 'Allowed movie', itemId: ALLOWED_ID },
    { code: 'BBB', title: 'Denied-library movie', itemId: DENIED_ID },
    { code: 'CCC', title: 'Also allowed', itemId: ALSO_ALLOWED_ID },
    { code: 'DDD', title: 'Session with no itemId', itemId: '' },
];

/**
 * Mock sql that answers `filterAccessibleMediaIds` with a fixed allowed set —
 * i.e. it stands in for a database where DENIED_ID sits in a denied library
 * group. The restricted boundary is the only thing that makes this query run.
 */
function createMockSql(allowedRows: string[]): Sql {
    const fn = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) =>
        Promise.resolve(allowedRows.map((id) => ({ id }))),
    );
    return fn as unknown as Sql;
}

const RESTRICTED = restrictedAccess({
    deniedGroupIds: ['denied-group'],
    maxAgeRating: 13,
    allowUnrated: false,
});

// ---------------------------------------------------------------------------
// Differential: restricted ⊂ unrestricted, denyAll = ∅
// ---------------------------------------------------------------------------

describe('filterSessionsByAccess — differential', () => {
    it('restricted result is a STRICT SUBSET of the unrestricted result', async () => {
        const unrestrictedSql = createMockSql([ALLOWED_ID, DENIED_ID, ALSO_ALLOWED_ID]);
        const restrictedSql = createMockSql([ALLOWED_ID, ALSO_ALLOWED_ID]);

        const unrestricted = await filterSessionsByAccess(
            unrestrictedSql,
            SESSIONS,
            unrestrictedAccess(),
        );
        const restricted = await filterSessionsByAccess(restrictedSql, SESSIONS, RESTRICTED);

        const unrestrictedCodes = new Set(unrestricted.map((s) => s.code));
        const restrictedCodes = restricted.map((s) => s.code);

        // Subset...
        for (const code of restrictedCodes) {
            expect(unrestrictedCodes.has(code)).toBe(true);
        }
        // ...and STRICT: the boundary actually removed something. If the
        // boundary were dropped on the floor these two would be equal.
        expect(restricted.length).toBeLessThan(unrestricted.length);
        expect(restrictedCodes).not.toContain('BBB');
    });

    it('unrestricted keeps every session, including the itemId-less one', async () => {
        const sql = createMockSql([]);
        const result = await filterSessionsByAccess(sql, SESSIONS, unrestrictedAccess());
        expect(result.map((s) => s.code)).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
        // Unrestricted short-circuits inside filterAccessibleMediaIds.
        expect(sql).not.toHaveBeenCalled();
    });

    it('denyAll returns EMPTY and never queries', async () => {
        const sql = createMockSql([ALLOWED_ID, DENIED_ID, ALSO_ALLOWED_ID]);
        const result = await filterSessionsByAccess(sql, SESSIONS, denyAllAccess());
        expect(result).toEqual([]);
        expect(sql).not.toHaveBeenCalled();
    });

    it('denyAll on the library axis alone returns EMPTY', async () => {
        const sql = createMockSql([ALLOWED_ID]);
        const result = await filterSessionsByAccess(sql, SESSIONS, {
            library: { kind: 'denyAll' },
            age: { kind: 'any' },
        });
        expect(result).toEqual([]);
    });

    it('denyAll on the age axis alone returns EMPTY', async () => {
        const sql = createMockSql([ALLOWED_ID]);
        const result = await filterSessionsByAccess(sql, SESSIONS, {
            library: { kind: 'all' },
            age: { kind: 'denyAll' },
        });
        expect(result).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// itemId-less sessions: exempt from the media filter, NOT from the boundary
// ---------------------------------------------------------------------------

describe('filterSessionsByAccess — itemId-less sessions', () => {
    it('keeps an itemId-less session under a restricted boundary (unchanged behaviour)', async () => {
        const sql = createMockSql([ALLOWED_ID]);
        const result = await filterSessionsByAccess(sql, SESSIONS, RESTRICTED);
        expect(result.map((s) => s.code)).toEqual(['AAA', 'DDD']);
    });

    it('DROPS an itemId-less session under denyAll — its title/host is the leak', async () => {
        const sql = createMockSql([]);
        const onlyBlank: TestSession[] = [{ code: 'DDD', title: 'secret', itemId: null }];
        const result = await filterSessionsByAccess(sql, onlyBlank, denyAllAccess());
        expect(result).toEqual([]);
    });

    it('returns empty when there is no sql handle', async () => {
        const result = await filterSessionsByAccess(null, SESSIONS, RESTRICTED);
        expect(result).toEqual([]);
    });

    it('returns empty for an empty session list', async () => {
        const sql = createMockSql([ALLOWED_ID]);
        expect(await filterSessionsByAccess(sql, [], RESTRICTED)).toEqual([]);
        expect(sql).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Boundary resolution fails CLOSED
// ---------------------------------------------------------------------------

describe('resolveWatchTogetherBoundary', () => {
    const user = { username: 'alice', maxAgeRating: null } as unknown as UserContext;

    beforeEach(() => {
        buildSearchAccessContext.mockReset();
    });

    it('returns denyAll when there is no database handle', async () => {
        const boundary = await resolveWatchTogetherBoundary(null, user);
        expect(boundary).toEqual(denyAllAccess());
        expect(buildSearchAccessContext).not.toHaveBeenCalled();
    });

    it('returns denyAll when building the access context THROWS', async () => {
        // Regression: this used to be `.catch(() => undefined)` + `if (ctx)`,
        // which skipped filtering entirely and listed every session.
        buildSearchAccessContext.mockRejectedValue(new Error('library-perms cache miss'));
        const boundary = await resolveWatchTogetherBoundary(createMockSql([]), user);
        expect(boundary).toEqual(denyAllAccess());
    });

    it('projects a real access context onto the boundary', async () => {
        buildSearchAccessContext.mockResolvedValue({
            username: 'alice',
            deniedGroupIds: ['g1'],
            ageRating: { maxAgeRating: 13, allowUnrated: false },
            liveTvAllowed: false,
            showUnavailableMedia: false,
        });
        const boundary = await resolveWatchTogetherBoundary(createMockSql([]), user);
        expect(boundary).toEqual({
            library: { kind: 'denyGroups', ids: ['g1'] },
            age: { kind: 'limit', maxAgeRating: 13, allowUnrated: false },
        });
    });

    it('an unrestricted user projects onto an explicitly unrestricted boundary', async () => {
        buildSearchAccessContext.mockResolvedValue({
            username: 'admin',
            deniedGroupIds: null,
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        });
        const boundary = await resolveWatchTogetherBoundary(createMockSql([]), user);
        expect(boundary).toEqual(unrestrictedAccess());
    });
});
