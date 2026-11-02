// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SQL ASSEMBLY tests for the shared Next-Up candidate CTEs — no database.
 *
 * Two things this file pins:
 *
 * 1. **Fragment gluing.** `postgres.js` splices a nested fragment in with NO
 *    separator on either side, so two value-ending fragments landing adjacent
 *    emit `$3AND` and Postgres rejects the whole statement at runtime only.
 *    `buildNextUpCandidateCtes` interpolates up to five optional fragments
 *    (series filter, two status filters, two ordering joins) and the Jellyfin
 *    consumer adds the access matrix on top.
 *
 * 2. **The anchor model itself.** The Jellyfin Next Up query used to select the
 *    first *unwatched* episode in the series (`COALESCE(ep_ws.is_watched,
 *    false) = false`), which pinned finished shows to their earliest gap
 *    forever — a user with 176/178 TNG episodes watched but no S01E02 was
 *    offered S01E02 as his next episode indefinitely, and a Sky Harbor
 *    re-watcher on S23 was offered S01E01. The correct model anchors on the
 *    most recently watched episode and takes the first episode ordered
 *    strictly after it. Asserting on the rendered SQL is how that stays true
 *    for BOTH consumers without a database.
 *
 * Harness copied from `series-downloads.sql-assembly.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import postgres from 'postgres';
import { buildNextUpCandidateCtes } from './builders/next-up-candidates.builder.js';
import { getNextUpEpisodes } from './jellyfin-browse.queries.js';
import { getNextUpFromDb } from './watch-state.queries.js';
import { toUserId } from '$lib/shared/user-id';
import { unrestrictedAccess, type MediaAccessBoundary } from './builders/media-access-boundary.js';

/** A postgres.js instance that is never awaited, so it never connects. */
const sql = postgres({ host: '127.0.0.1', port: 1, max: 1 });

interface BuiltQuery {
    strings: string[];
    args: unknown[];
}

interface BuiltIdentifier {
    value: string;
}

function isBuiltQuery(value: unknown): value is BuiltQuery {
    return (
        typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as BuiltQuery).strings) &&
        Array.isArray((value as BuiltQuery).args)
    );
}

function isBuiltIdentifier(value: unknown): value is BuiltIdentifier {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as BuiltIdentifier).value === 'string' &&
        !Array.isArray((value as BuiltQuery).strings)
    );
}

function renderSql(query: unknown, counter = { n: 0 }): string {
    if (!isBuiltQuery(query)) return '';
    let out = '';
    query.strings.forEach((part, i) => {
        out += part;
        if (i < query.args.length) {
            const arg = query.args[i];
            if (isBuiltQuery(arg)) {
                out += renderSql(arg, counter);
            } else if (isBuiltIdentifier(arg)) {
                out += arg.value.replace(/"/g, '');
            } else {
                out += `$${++counter.n}`;
            }
        }
    });
    return out;
}

/** `$3AND`, `$12ORDER`, … — a parameter glued to the next fragment's text. */
const GLUED_PARAMETER = /\$\d+[A-Za-z]/;

const USER = toUserId('00000000-0000-0000-0000-000000000001');
const SERIES = '11111111-1111-1111-1111-111111111111';
const DENIED_GROUPS = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'];
const AGE = { maxAgeRating: 12, allowUnrated: false };

function boundary(
    deniedGroupIds: string[] | null,
    ageRating: { maxAgeRating: number; allowUnrated: boolean } | null,
): MediaAccessBoundary {
    return {
        library: deniedGroupIds
            ? { kind: 'denyGroups' as const, ids: deniedGroupIds }
            : { kind: 'all' as const },
        age: ageRating
            ? {
                  kind: 'limit' as const,
                  maxAgeRating: ageRating.maxAgeRating,
                  allowUnrated: ageRating.allowUnrated,
              }
            : { kind: 'any' as const },
    };
}

/**
 * Build a query without executing it. Deliberately NOT awaited: awaiting makes
 * postgres.js dial the dead port and escalate its retry backoff, so successive
 * renders in one file get monotonically slower until the suite times out. The
 * tagged template is evaluated synchronously before the first await, so the
 * built query is already recorded when the call returns.
 */
function render(run: (recorder: postgres.Sql) => unknown): string {
    const built: unknown[] = [];
    const recorder = ((...args: unknown[]) => {
        const q = (sql as unknown as (...a: unknown[]) => unknown)(...args);
        built.push(q);
        return q;
    }) as unknown as postgres.Sql;
    Object.setPrototypeOf(recorder, sql);

    void Promise.resolve(run(recorder)).catch(() => undefined);

    const outer = [...built].reverse().find(isBuiltQuery);
    expect(outer, 'no query was built').toBeDefined();
    return renderSql(outer);
}

const renderJellyfin = (
    access: MediaAccessBoundary,
    seriesId: string | null = null,
    maxAgeDays = 0,
): string => render((rec) => getNextUpEpisodes(rec, USER, 20, access, seriesId, maxAgeDays));

const renderWeb = (): string =>
    render((rec) => getNextUpFromDb.all(rec, { userId: USER, limit: 20, maxAgeDays: 60 }));

describe('buildNextUpCandidateCtes', () => {
    const MATRIX = [
        { name: 'defaults', opts: {} },
        { name: 'series-scoped', opts: { seriesId: SERIES } },
        { name: 'active-status only', opts: { requireActiveStatus: true } },
        {
            name: 'series-scoped + active status',
            opts: { seriesId: SERIES, requireActiveStatus: true },
        },
    ];

    it.each(MATRIX)('emits valid SQL with $name', ({ opts }) => {
        const rendered = renderSql(
            buildNextUpCandidateCtes(sql, { userId: USER, maxAgeDays: 60, ...opts }),
        );
        expect(rendered).not.toMatch(GLUED_PARAMETER);
    });

    it('anchors on the most recently watched episode, not the first unwatched one', () => {
        const rendered = renderSql(buildNextUpCandidateCtes(sql, { userId: USER, maxAgeDays: 60 }));
        // The anchor CTE and the strictly-greater comparison against it.
        expect(rendered).toContain('recent_watched_order');
        expect(rendered).toMatch(/>\s*wps\.recent_watched_order/);
        // The old Jellyfin model: "any episode the user has not watched".
        expect(rendered).not.toContain('is_watched, false) = false');
    });

    it('never anchors on or returns a special (season 0)', () => {
        // A finished behind-the-scenes special must not drag Next Up back to
        // S01E01 — the specials guard has to apply on BOTH sides.
        const rendered = renderSql(buildNextUpCandidateCtes(sql, { userId: USER, maxAgeDays: 60 }));
        const guards = rendered.match(/order_season_number, mi\.season_number\) > 0/g) ?? [];
        expect(guards.length).toBeGreaterThanOrEqual(2);
    });

    it('honours a Continue Watching dismissal', () => {
        const rendered = renderSql(buildNextUpCandidateCtes(sql, { userId: USER, maxAgeDays: 60 }));
        expect(rendered).toContain("flag_type = 'dismissed_cw'");
    });

    it('scopes to one series only when asked', () => {
        const scoped = renderSql(
            buildNextUpCandidateCtes(sql, { userId: USER, maxAgeDays: 60, seriesId: SERIES }),
        );
        const open = renderSql(buildNextUpCandidateCtes(sql, { userId: USER, maxAgeDays: 60 }));
        expect(scoped).toContain('season.parent_id = $');
        expect(open).not.toContain('season.parent_id = $');
    });

    it('gates status only when asked', () => {
        const gated = renderSql(
            buildNextUpCandidateCtes(sql, {
                userId: USER,
                maxAgeDays: 60,
                requireActiveStatus: true,
            }),
        );
        const open = renderSql(buildNextUpCandidateCtes(sql, { userId: USER, maxAgeDays: 60 }));
        expect(gated).toContain("mi.status = 'active'");
        expect(gated).toContain("series.status = 'active'");
        expect(open).not.toContain("mi.status = 'active'");
    });
});

describe('getNextUpEpisodes SQL assembly', () => {
    const MATRIX = [
        { name: 'no access limits', access: boundary(null, null) },
        { name: 'library only', access: boundary(DENIED_GROUPS, null) },
        { name: 'age only', access: boundary(null, AGE) },
        { name: 'library + age', access: boundary(DENIED_GROUPS, AGE) },
    ];

    it.each(MATRIX)('emits valid SQL with $name', ({ access }) => {
        expect(renderJellyfin(access)).not.toMatch(GLUED_PARAMETER);
        expect(renderJellyfin(access, SERIES, 60)).not.toMatch(GLUED_PARAMETER);
    });

    it('uses the shared candidate CTEs', () => {
        const rendered = renderJellyfin(boundary(null, null));
        expect(rendered).toContain('next_up_candidates');
        expect(rendered).toContain('recent_watched_order');
    });

    it('orders by the anchor timestamp so the freshest series comes first', () => {
        expect(renderJellyfin(boundary(null, null))).toContain(
            'ORDER BY ne.last_watched_at DESC NULLS LAST',
        );
    });
});

describe('getNextUpFromDb SQL assembly', () => {
    it('emits valid SQL', () => {
        expect(renderWeb()).not.toMatch(GLUED_PARAMETER);
    });

    it('shares the candidate CTEs with the Jellyfin query', () => {
        const web = renderWeb();
        const jellyfin = renderJellyfin(unrestrictedAccess());
        // Same primitive on both surfaces. The two differ only by the options
        // the builder exposes (Jellyfin gates on status), so compare the CTE
        // prefix with those optional clauses normalised away — anything else
        // diverging means someone hand-edited one surface's next-up logic
        // again, which is the drift this builder exists to prevent.
        const prefix = (s: string) =>
            s
                .slice(0, s.lastIndexOf('next_up_candidates AS ('))
                .replace(/JOIN media_items series ON[\s\S]*?status = 'active'/g, '')
                .replace(/\$\d+/g, '$?')
                .replace(/\s+/g, ' ')
                .trim();
        expect(prefix(web)).toBe(prefix(jellyfin));
    });
});
