// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SQL ASSEMBLY tests for the series smart-download queries — no database.
 *
 * `postgres.js` splices a nested query fragment in with NO separator on either
 * side. Two value-ending fragments landing next to each other therefore emit
 *
 *     AND mf.library_group_id != ALL($3::uuid[])AND (mi.age_rating IS NULL ...)
 *                                              ^^^ glued to the parameter
 *
 * which Postgres rejects with `trailing junk after parameter at or near "$3AND"`.
 * It only triggers for SOME argument combinations, so most calls work and it
 * reaches production — which is exactly what happened to the assistant's
 * constraint query. Both queries here interpolate FOUR optional fragments
 * adjacently, so this file is not optional.
 *
 * The unit suite cannot see this (it mocks the query module wholesale) and the
 * integration suite cannot either (it does not cover the access-argument
 * matrix). So: run the real builders against a NON-CONNECTING postgres.js
 * instance and inspect the SQL text they would have sent. postgres.js builds
 * the wire string lazily and only connects on `await`, so nothing here touches
 * a socket.
 *
 * Harness copied from `assistant-rag.sql-assembly.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import postgres from 'postgres';
import {
    buildDefaultFileLibraryFilter,
    buildConsumedExpressionFragment,
} from './series-downloads.queries.js';

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

/**
 * `sql(alias)` (e.g. `${sql('mf')}.library_group_id`) does not build a nested
 * query — postgres.js resolves it to an `Identifier { value: '"mf"' }` and
 * splices that straight into the surrounding template's `strings`/`args`,
 * exactly like a bound value would be spliced, except it is never a
 * parameter: it is quoted identifier TEXT, not a `$n` placeholder.
 */
function isBuiltIdentifier(value: unknown): value is BuiltIdentifier {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as BuiltIdentifier).value === 'string' &&
        !Array.isArray((value as BuiltQuery).strings)
    );
}

/**
 * Render the SQL text a query would produce. Mirrors the two behaviours under
 * test: static `strings` joined with each interpolated value in between, a
 * nested fragment spliced in with NO separator, an identifier inlined as its
 * (unquoted, for readability) text, and everything else as a `$n` parameter.
 */
export function renderSql(query: unknown, counter = { n: 0 }): string {
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

/**
 * The exact failure signature: a `$N` placeholder followed immediately by a
 * letter. Matches `$3AND`, `$12ORDER`, etc.
 */
export const GLUED_PARAMETER = /\$\d+[A-Za-z]/;

const DENIED = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'];

describe('postgres.js fragment concatenation', () => {
    it('glues a value-ending fragment to the next fragment without a separator', () => {
        // The trap, demonstrated. It also proves the renderer above models the
        // real concatenation — if it ever stopped gluing, every other assertion
        // in this file would silently pass.
        //
        // The fragment must end IMMEDIATELY after its bound value for the glue
        // to land on the parameter itself (`$1AND`, matching GLUED_PARAMETER).
        // A fragment with trailing SQL text after its last value — e.g.
        // `ALL(${DENIED}::uuid[])` — glues onto that trailing text instead
        // (`...[])AND...`), which is the same production bug but does not
        // match this narrower regex.
        const a = sql`AND mf.library_group_id != ${DENIED[0]}`;
        const b = sql`AND ep.has_files = ${true}`;
        expect(renderSql(sql`SELECT 1 WHERE true ${a}${b}`)).toMatch(GLUED_PARAMETER);
    });

    it('is fixed by a single space between fragments', () => {
        const a = sql`AND mf.library_group_id != ${DENIED[0]}`;
        const b = sql`AND ep.has_files = ${true}`;
        expect(renderSql(sql`SELECT 1 WHERE true ${a} ${b}`)).not.toMatch(GLUED_PARAMETER);
    });
});

describe('buildDefaultFileLibraryFilter', () => {
    it('emits nothing when no group is denied', () => {
        expect(renderSql(buildDefaultFileLibraryFilter(sql, null)).trim()).toBe('');
        expect(renderSql(buildDefaultFileLibraryFilter(sql, [])).trim()).toBe('');
    });

    it("tests THIS file's group, not the series' files", () => {
        // Deliberately stricter than buildEpisodeLibraryFilter, which tests the
        // SERIES' files: the bytes we would encode are this file's bytes, so
        // this file's group is what must be permitted.
        const rendered = renderSql(buildDefaultFileLibraryFilter(sql, DENIED));
        expect(rendered).toContain('mf.library_group_id IS NULL');
        expect(rendered).toContain('mf.library_group_id != ALL(');
        expect(rendered).not.toContain('media_file_items');
    });

    it('honours a custom alias', () => {
        expect(renderSql(buildDefaultFileLibraryFilter(sql, DENIED, 'df'))).toContain(
            'df.library_group_id',
        );
    });

    it('rejects an unsafe alias rather than interpolating it', () => {
        expect(() => buildDefaultFileLibraryFilter(sql, DENIED, 'mf; DROP TABLE')).toThrow();
    });
});

describe('buildConsumedExpressionFragment', () => {
    it("reproduces Continue Watching's duration-tiered thresholds exactly", () => {
        // Sharing these numbers with continue-watching-page.query.ts is a hard
        // requirement: a different threshold makes an episode vanish from
        // Continue Watching while staying in the pool.
        const rendered = renderSql(buildConsumedExpressionFragment(sql, 'st'));
        expect(rendered).toContain('0.90');
        expect(rendered).toContain('0.95');
        expect(rendered).toContain('0.96');
        expect(rendered).toContain('st.is_watched');
        expect(rendered).toContain('st.resume_position_ms');
        expect(rendered).toContain('st.runtime_ms');
    });

    it('is COALESCEd to false, so a NULL runtime never reads as consumed', () => {
        // `false OR NULL` is NULL in SQL. Without the COALESCE an episode with
        // no runtime would make anchor_consumed NULL, and a NULL anchor flips
        // the forward window between `>` and `>=`.
        expect(renderSql(buildConsumedExpressionFragment(sql))).toContain('COALESCE(');
    });

    it('rejects an unsafe alias', () => {
        expect(() => buildConsumedExpressionFragment(sql, '1bad')).toThrow();
    });
});

import { getSeriesNextUpCandidates, type SeriesFrequencyMode } from './series-downloads.queries.js';
import { toUserId } from '$lib/shared/user-id';

const USER = toUserId('00000000-0000-0000-0000-000000000001');
const DENIED_GROUPS = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'];
const AGE = { maxAgeRating: 12, allowUnrated: false };

/** The literal ORDER BY text `buildSeriesOrderingFragment` compiles each mode to. */
const ORDERING_LITERAL: Record<SeriesFrequencyMode, string> = {
    off: 'ORDER BY distance ASC, series_rank ASC, media_id ASC',
    balanced:
        'ORDER BY (CASE WHEN distance = 0 THEN 0 ELSE GREATEST(1, distance - freq_allowance) END) ASC, ' +
        'distance ASC, frequency_rank ASC, series_rank ASC, media_id ASC',
    frequency_first: 'ORDER BY frequency_rank ASC, distance ASC, series_rank ASC, media_id ASC',
};

/**
 * The 'balanced' fragment is written across multiple lines for readability in
 * the query source, so its rendered SQL carries real newlines/indentation
 * between tokens. Collapsing runs of whitespace to a single space keeps the
 * assertion about the ORDERING (still a literal, still unparameterised,
 * still identical between the two queries) rather than about incidental
 * formatting.
 */
function collapseWhitespace(sql: string): string {
    return sql.replace(/\s+/g, ' ').trim();
}

/**
 * Build a query without executing it.
 *
 * The query function is `async`, so awaiting it would open a socket. The `sql`
 * tag is wrapped in a recorder that delegates to the real one and keeps every
 * template it builds. Interpolations are evaluated before the template that
 * contains them, so the LAST recorded template is the outer query. The returned
 * promise rejects (nothing listens on port 1) and is swallowed deliberately —
 * the SQL text was already assembled by then, which is all this inspects.
 */
async function renderCandidates(
    access: {
        deniedGroupIds: string[] | null;
        ageRating: { maxAgeRating: number; allowUnrated: boolean } | null;
    },
    opts: { frequencyMode?: SeriesFrequencyMode } = {},
): Promise<string> {
    const built: unknown[] = [];
    const recorder = ((...args: unknown[]) => {
        const q = (sql as unknown as (...a: unknown[]) => unknown)(...args);
        built.push(q);
        return q;
    }) as unknown as postgres.Sql;
    // Inherit options/helpers (sql.unsafe, the identifier form, …).
    Object.setPrototypeOf(recorder, sql);

    // Deliberately NOT awaited. Awaiting makes postgres.js try to connect to
    // the dead port, and each failed attempt escalates its retry backoff, so
    // successive renders in this file got monotonically slower — 4ms, then
    // 752ms, then 16s, until the last one blew the 30s timeout and failed the
    // blocking suite under CI load. The tagged template inside the query
    // function is evaluated synchronously before its first await, so the
    // built query is already recorded by the time the call returns.
    void Promise.resolve(getSeriesNextUpCandidates(recorder, USER, access as never, opts)).catch(
        () => undefined,
    );

    const outer = [...built].reverse().find(isBuiltQuery);
    expect(outer, 'no query was built').toBeDefined();
    return renderSql(outer);
}

describe('getSeriesNextUpCandidates SQL assembly', () => {
    const MATRIX = [
        { name: 'no access limits', access: { deniedGroupIds: null, ageRating: null } },
        { name: 'library only', access: { deniedGroupIds: DENIED_GROUPS, ageRating: null } },
        { name: 'age only', access: { deniedGroupIds: null, ageRating: AGE } },
        { name: 'library + age', access: { deniedGroupIds: DENIED_GROUPS, ageRating: AGE } },
    ];

    it.each(MATRIX)('emits valid SQL with $name', async ({ access }) => {
        // FOUR optional fragments land next to each other in `forward`:
        // the ordering join, the unmapped-episode filter, the age filter and
        // the file library filter. Two value-ending ones adjacent is all it
        // takes.
        const rendered = await renderCandidates(access);
        expect(rendered).not.toMatch(GLUED_PARAMETER);
    });

    it.each(['off', 'balanced', 'frequency_first'] as const)(
        'keeps the ordering expression literal and unparameterised — %s',
        async (frequencyMode) => {
            // If this ever renders with a $N in it, someone made the sort key
            // dynamic and the endpoint no longer has one ordering. 'balanced'
            // is also the DEFAULT when frequencyMode is omitted — the
            // un-upgraded-client case — so that case is exercised
            // implicitly by every other test in this file that calls
            // renderCandidates() with no opts.
            const rendered = await renderCandidates(
                { deniedGroupIds: null, ageRating: null },
                { frequencyMode },
            );
            expect(collapseWhitespace(rendered)).toContain(ORDERING_LITERAL[frequencyMode]);
        },
    );

    it('defaults to balanced when no frequencyMode is given — including an un-upgraded client', async () => {
        const rendered = await renderCandidates({ deniedGroupIds: null, ageRating: null });
        expect(collapseWhitespace(rendered)).toContain(ORDERING_LITERAL.balanced);
    });

    it('applies the age filter to the series alias, not the episode', async () => {
        const rendered = await renderCandidates({ deniedGroupIds: null, ageRating: AGE });
        expect(rendered).toContain('series_mi.age_rating');
        expect(rendered).not.toContain('ep.age_rating');
    });

    it('applies the library filter to the default file alias', async () => {
        const rendered = await renderCandidates({
            deniedGroupIds: DENIED_GROUPS,
            ageRating: null,
        });
        expect(rendered).toContain('mf.library_group_id');
    });
});

/**
 * Finding #18: `covers_media_ids` used to be a correlated scalar subquery
 * inside `per_file`'s SELECT list, re-scanning the whole (unindexed,
 * materialised) `forward` CTE once per `bounded` row -- O(|bounded| x
 * |forward|) tuplestore comparisons with nothing bounding `forward` itself.
 * Aggregating `forward` in a single GROUP BY, joined against only the
 * file_ids `bounded` needs, removes that quadratic term. This cannot be an
 * integration/behavioural test: both shapes return identical rows, which is
 * the point of the optimisation, so only the SQL text distinguishes them.
 */
describe('getSeriesNextUpCandidates covers_media_ids aggregation', () => {
    it('aggregates covers_media_ids from a single GROUP BY, not a correlated subquery per row', async () => {
        const rendered = await renderCandidates({ deniedGroupIds: null, ageRating: null });
        expect(rendered).not.toMatch(/FROM forward g\s+WHERE g\.file_id = f\.file_id/);
        expect(rendered).toMatch(/GROUP BY g\.file_id/);
    });

    it('still aggregates from the pre-truncation forward CTE, not the truncated bounded one', async () => {
        // MAX_DISTANCE_PER_SERIES bounds ROW COUNT, not how many episodes one
        // artifact covers -- a combined file straddling that boundary must
        // still report every covered episode id (behaviourally covered by
        // series-downloads.queries.integration.test.ts's "combined file
        // straddling the distance boundary" case).
        const rendered = await renderCandidates({ deniedGroupIds: null, ageRating: null });
        const coversCte = rendered.match(/covers AS \(([\s\S]*?)\),\s*per_file AS/);
        expect(coversCte, 'no covers CTE found').toBeTruthy();
        // The aggregate itself scans 'forward'; 'bounded' only narrows WHICH
        // file_ids are aggregated, via a join, never which rows contribute to
        // one file_id's array.
        expect(coversCte![1]).toMatch(/array_agg\([^)]*\)[^;]*\n\s*FROM forward g/);
    });
});

import { getSeriesNextUpRescore } from './series-downloads.queries.js';

async function renderRescore(
    access: {
        deniedGroupIds: string[] | null;
        ageRating: { maxAgeRating: number; allowUnrated: boolean } | null;
    },
    opts: { frequencyMode?: SeriesFrequencyMode } = {},
): Promise<string> {
    const built: unknown[] = [];
    const recorder = ((...args: unknown[]) => {
        const q = (sql as unknown as (...a: unknown[]) => unknown)(...args);
        built.push(q);
        return q;
    }) as unknown as postgres.Sql;
    Object.setPrototypeOf(recorder, sql);

    // Deliberately NOT awaited. Awaiting makes postgres.js try to connect to
    // the dead port, and each failed attempt escalates its retry backoff, so
    // successive renders in this file got monotonically slower — 4ms, then
    // 752ms, then 16s, until the last one blew the 30s timeout and failed the
    // blocking suite under CI load. The tagged template inside the query
    // function is evaluated synchronously before its first await, so the
    // built query is already recorded by the time the call returns.
    void Promise.resolve(
        getSeriesNextUpRescore(
            recorder,
            USER,
            ['11111111-1111-1111-1111-111111111111'],
            access as never,
            opts,
        ),
    ).catch(() => undefined);

    const outer = [...built].reverse().find(isBuiltQuery);
    expect(outer, 'no query was built').toBeDefined();
    return renderSql(outer);
}

describe('getSeriesNextUpRescore SQL assembly', () => {
    it.each([
        { name: 'no access limits', access: { deniedGroupIds: null, ageRating: null } },
        { name: 'library only', access: { deniedGroupIds: DENIED_GROUPS, ageRating: null } },
        { name: 'age only', access: { deniedGroupIds: null, ageRating: AGE } },
        { name: 'library + age', access: { deniedGroupIds: DENIED_GROUPS, ageRating: AGE } },
    ])('emits valid SQL with $name', async ({ access }) => {
        expect(await renderRescore(access)).not.toMatch(GLUED_PARAMETER);
    });

    it.each(['off', 'balanced', 'frequency_first'] as const)(
        'uses the SAME literal ordering expression as the candidate query — %s',
        async (frequencyMode) => {
            // The equivalence invariant, checked at the text level as well as
            // behaviourally, for EVERY mode: if these two strings ever
            // diverge for a mode, a client reorders its whole pool on every
            // rescore made in that mode.
            const rescoreSql = await renderRescore(
                { deniedGroupIds: null, ageRating: null },
                { frequencyMode },
            );
            const candidatesSql = await renderCandidates(
                { deniedGroupIds: null, ageRating: null },
                { frequencyMode },
            );
            const ordering = ORDERING_LITERAL[frequencyMode];
            expect(collapseWhitespace(rescoreSql)).toContain(ordering);
            expect(collapseWhitespace(candidatesSql)).toContain(ordering);
        },
    );
});

/**
 * `CONTINUE_WATCHING_MAX_AGE_DAYS = 0` is documented — in the config schema
 * and in the admin settings help text — as "disable the cutoff". Every other
 * consumer of that setting carries an explicit `= 0` escape. If these two
 * queries lose theirs, 0 collapses the predicate to `>= NOW()`, no committed
 * row satisfies it, `engagement` empties for every user, and rescore reports
 * every downloaded episode as `graduated` — which this lane's graduation
 * policy spells `delete`. That is a silent wipe of the offline library from a
 * setting whose own help text calls 0 safe, so the escape is asserted at the
 * text level, in the always-running unit suite.
 */
const AGE_ZERO_ESCAPE = /AND \(\s*\$\d+ = 0\s*OR GREATEST\(/;

describe('the maxAgeDays = 0 escape', () => {
    it('is present in the candidate query', async () => {
        const rendered = await renderCandidates({ deniedGroupIds: null, ageRating: null });
        expect(rendered).toMatch(AGE_ZERO_ESCAPE);
    });

    it('is present in the rescore query — the destructive half', async () => {
        const rendered = await renderRescore({ deniedGroupIds: null, ageRating: null });
        expect(rendered).toMatch(AGE_ZERO_ESCAPE);
    });
});
