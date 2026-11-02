// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SQL ASSEMBLY tests for the assistant's constraint query — no database.
 *
 * These exist because of a defect that every other layer was blind to.
 * `findMediaByConstraints` composes its WHERE clause from a dozen optional
 * postgres.js fragments, and postgres.js concatenates `${a}${b}` with NOTHING
 * between them. A fragment ending in a bound value therefore emits
 *
 *     AND (…)::integer >= $3AND NOT EXISTS (…)
 *              ^^^^^^^ the next fragment's leading AND, glued to the parameter
 *
 * which Postgres rejects with `trailing junk after parameter at or near
 * "$3AND"`. It only triggers when two value-ending fragments land next to each
 * other, so most argument combinations worked and it reached production, where
 * every `find_media` call combining `minRtRating` with `watched:false` failed.
 *
 * The unit tests could not see it: they mock this query module wholesale. The
 * integration tests could not see it either — they need a live database, and
 * they do not cover this function's argument matrix. So the guard is here: run
 * the real query builder against a NON-CONNECTING postgres.js instance and
 * inspect the SQL string it would have sent. `postgres.js` builds the wire
 * string lazily and only connects on `await`, so nothing here touches a socket.
 */
import { describe, it, expect } from 'vitest';
import postgres from 'postgres';

/** A postgres.js instance that is never awaited, so it never connects. */
const sql = postgres({ host: '127.0.0.1', port: 1, max: 1 });

interface BuiltQuery {
    strings: string[];
    args: unknown[];
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
 * Render the SQL text a query would produce.
 *
 * postgres.js's own `stringify` lives behind a non-exported subpath, so this
 * mirrors the one behaviour under test: a template's static `strings` are joined
 * with each interpolated value in between, and a nested query fragment is
 * spliced in with NO separator on either side. Plain values become `$n`
 * placeholders. That splice-with-no-separator is precisely the trap, so this
 * renderer reproduces it — the first test below asserts that it does, which is
 * what keeps this stand-in honest.
 */
function renderSql(query: unknown, counter = { n: 0 }): string {
    if (!isBuiltQuery(query)) return '';
    let out = '';
    query.strings.forEach((part, i) => {
        out += part;
        if (i < query.args.length) {
            const arg = query.args[i];
            out += isBuiltQuery(arg) ? renderSql(arg, counter) : `$${++counter.n}`;
        }
    });
    return out;
}

/**
 * The exact failure signature: a `$N` placeholder followed immediately by a
 * letter. Matches `$3AND`, `$12ORDER`, etc. — anything glued to a parameter.
 */
const GLUED_PARAMETER = /\$\d+[A-Za-z]/;

describe('postgres.js fragment concatenation', () => {
    it('glues a value-ending fragment to the next fragment without a separator', () => {
        const a = sql`AND mi.year >= ${2000}`;
        const b = sql`AND NOT EXISTS (SELECT 1 FROM x WHERE u = ${'uid'})`;

        // This is the trap, demonstrated: no separator, broken SQL. It also
        // proves the renderer above models the real concatenation — if it ever
        // stopped gluing, every other assertion here would silently pass.
        expect(renderSql(sql`SELECT 1 WHERE true ${a}${b}`)).toMatch(GLUED_PARAMETER);
    });

    it('is fixed by a single space between fragments', () => {
        const a = sql`AND mi.year >= ${2000}`;
        const b = sql`AND NOT EXISTS (SELECT 1 FROM x WHERE u = ${'uid'})`;

        expect(renderSql(sql`SELECT 1 WHERE true ${a} ${b}`)).not.toMatch(GLUED_PARAMETER);
    });
});

describe('findMediaByConstraints SQL assembly', () => {
    /**
     * Build the query without executing it.
     *
     * `findMediaByConstraints` is `async`, so it hands back a Promise and
     * awaiting it would open a socket. Instead the `sql` tag is wrapped in a
     * recorder that delegates to the real one and keeps every template it
     * builds. Interpolations are evaluated before the template that contains
     * them, so the LAST recorded template is the outer query. The returned
     * promise is rejected (nothing is listening on port 1) and is swallowed
     * deliberately — the SQL text was already assembled by then, which is all
     * this suite inspects.
     */
    async function render(params: Record<string, unknown>): Promise<string> {
        const { findMediaByConstraints } = await import('./assistant-rag.queries.js');

        const built: unknown[] = [];
        const recorder = ((...args: unknown[]) => {
            const q = (sql as unknown as (...a: unknown[]) => unknown)(...args);
            built.push(q);
            return q;
        }) as unknown as postgres.Sql;
        // Inherit options/helpers (sql.json, sql.unsafe, …) from the real tag.
        Object.setPrototypeOf(recorder, sql);

        // Deliberately NOT awaited. Awaiting makes postgres.js try to connect
        // to the dead port, and each failed attempt escalates its retry
        // backoff, so successive renders in a file get monotonically slower
        // (measured in the sibling series test: 4ms → 752ms → 16s → 30s
        // timeout). The tagged template is evaluated synchronously before the
        // query function's first await, so the built query is already
        // recorded by the time the call returns.
        void Promise.resolve(
            findMediaByConstraints(recorder, {
                userId: '00000000-0000-0000-0000-000000000001',
                access: { library: { kind: 'all' }, age: { kind: 'any' } },
                limit: 10,
                ...params,
            } as never),
        ).catch(() => undefined);

        const outer = [...built].reverse().find(isBuiltQuery);
        expect(outer, 'no query was built').toBeDefined();
        return renderSql(outer);
    }

    // The combination that actually broke on prod.
    it('emits valid SQL for a Rotten Tomatoes floor plus an unwatched filter', async () => {
        const rendered = await render({
            mediaType: 'movie',
            minRtRating: 85,
            watched: false,
            sortBy: 'rt_rating',
        });
        expect(rendered).not.toMatch(GLUED_PARAMETER);
        expect(rendered).toContain('rt_rating');
    });

    /**
     * Every optional filter at once. Each is a separate fragment, so this is the
     * densest adjacency the builder can produce — if any pair is missing its
     * separator, it shows up here.
     */
    it('emits valid SQL with every optional filter set at once', async () => {
        const rendered = await render({
            mediaType: 'movie',
            genres: ['Comedy'],
            excludeGenres: ['Horror'],
            addedWithinDays: 30,
            minYear: 2000,
            maxYear: 2020,
            minRuntimeMinutes: 60,
            maxRuntimeMinutes: 120,
            minRtRating: 70,
            minRtAudienceScore: 70,
            minImdbRating: 7,
            watched: false,
            sortBy: 'rating',
        });
        expect(rendered).not.toMatch(GLUED_PARAMETER);
    });

    /**
     * `maxAgeRating` and `unwatchedByUsername` are live, model-reachable params
     * (see find-media.tool.ts) whose fragments no other case in this file ever
     * populates — and the access boundary is only ever exercised in its
     * "allow everything" form, which renders as EMPTY fragments, so the
     * separators around all four went untested. An empty neighbour cannot glue
     * to anything; only a populated one can.
     */
    it('emits valid SQL with the age ceiling and the peer-unwatched filter set', async () => {
        const rendered = await render({
            mediaType: 'movie',
            maxAgeRating: 12,
            unwatchedByUsername: 'bob',
            minRtRating: 70,
            watched: false,
        });
        expect(rendered).not.toMatch(GLUED_PARAMETER);
    });

    it('emits valid SQL when the access boundary itself renders fragments', async () => {
        const rendered = await render({
            mediaType: 'movie',
            access: {
                library: { kind: 'denyGroups', ids: ['11111111-1111-4111-8111-111111111111'] },
                age: { kind: 'limit', maxAgeRating: 16, allowUnrated: false },
            },
            genres: ['Comedy'],
            minRtRating: 70,
            watched: false,
        });
        expect(rendered).not.toMatch(GLUED_PARAMETER);
    });

    // Each sort branch rebuilds its rating expression; none may glue a parameter.
    it.each([
        'rating',
        'rt_rating',
        'rt_audience_score',
        'imdb_rating',
        'newest_added',
        'oldest_added',
    ])('emits valid SQL when sorting by %s', async (sortBy) => {
        const rendered = await render({ sortBy, minRtRating: 50, watched: false });
        expect(rendered).not.toMatch(GLUED_PARAMETER);
    });

    it('emits valid SQL with no optional filters at all', async () => {
        expect(await render({})).not.toMatch(GLUED_PARAMETER);
    });
});
