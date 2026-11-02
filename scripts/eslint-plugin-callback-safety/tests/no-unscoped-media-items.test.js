// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-unscoped-media-items.
 *
 * The regression these exist for (2026-07-30): the rule proved "this file is
 * gated" by substring-matching the marker tokens against the RAW SOURCE TEXT
 * (`sourceCode.getText()`). Comments are part of that text, so a doc comment
 * merely *naming* `checkMediaAccess` marked an entire file as gated — a query
 * module could read `media_items` with no scoping whatsoever and lint stayed
 * green. Nothing about the rule complained; the hole was only visible because
 * the surrounding eslint-disable directives were then reported as unused.
 *
 * The invariants below therefore pin BOTH directions:
 *   - a marker in prose (block comment, line comment, JSDoc, or the
 *     justification text of another rule's disable directive) does NOT count
 *   - a marker in a string / SQL template body does NOT count
 *   - a marker that exists only in TYPE syntax or as an UNUSED IMPORT does
 *     NOT count: both are erased before anything can run, so they are prose
 *     with a compiler in front of them
 *   - a runnable reference (call, callee passed by reference, parameter or
 *     variable binding, property read) DOES count
 *
 * The prose cases are the ones that must FAIL against the pre-fix rule. If a
 * future refactor reintroduces raw-text matching, they go red. Verified by
 * running this file against the pre-fix rule: the first prose case asserts
 * 1 error and gets 0.
 *
 * The `valid` list also pins two shapes that the obvious implementation of
 * the type-vs-value check gets WRONG — a gate call inside an `as` cast, and
 * one on a sql template with a generic type argument. Both are real calls
 * living on a node that also carries type syntax; erasing them reports a
 * properly gated file. See the comment on those cases.
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-unscoped-media-items');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

// Path-scoped rule: every case needs a filename it actually applies to.
const QUERY_FILE = '/repo/src/lib/server/database/queries/thing.queries.ts';
const ROUTE_FILE = '/repo/src/routes/api/thing/+server.ts';
const EXEMPT_FILE = '/repo/src/lib/server/database/queries/admin-media.queries.ts';
// C3 (2026-09-18 fix-plan-4): src/lib/server/api/defs/ is where the modern
// dual-mounted API handlers live. Until APPLICABLE_PATH_FRAGMENTS includes
// this fragment, a bare media_items template here is invisible to the rule.
const DEFS_FILE = '/repo/src/lib/server/api/defs/things/index.ts';

const SELECT = 'SELECT mi.id, mi.title FROM media_items mi WHERE mi.status = 0';
const unscoped = [{ messageId: 'unscoped' }];

ruleTester.run('no-unscoped-media-items', rule, {
    valid: [
        // ── real code references DO count ────────────────────────────────
        {
            name: 'imported + called gate helper',
            filename: QUERY_FILE,
            code: `
                import { buildLibraryAccessFilter } from '$lib/x';
                export async function f(sql, denied) {
                    const acl = buildLibraryAccessFilter(sql, denied);
                    return sql\`${SELECT} \${acl}\`;
                }
            `,
        },
        {
            name: 'access plumbing threaded through as a parameter name',
            filename: QUERY_FILE,
            code: `
                export async function f(sql, deniedGroupIds) {
                    return sql\`${SELECT} AND \${deniedGroupIds}\`;
                }
            `,
        },
        {
            name: 'imported AND actually used downstream',
            filename: QUERY_FILE,
            code: `
                import { filterAccessibleRows } from '$lib/x';
                export async function f(sql, user) {
                    const rows = await sql\`${SELECT}\`;
                    return filterAccessibleRows(rows, user);
                }
            `,
        },
        {
            name: 'a COMPUTED property key is a real value read, unlike a plain key',
            filename: QUERY_FILE,
            code: `
                import { checkMediaAccess } from '$lib/x';
                export async function f(sql) {
                    const gates = { [checkMediaAccess]: 1 };
                    return [gates, await sql\`${SELECT}\`];
                }
            `,
        },
        {
            name: 'a declared-then-called local gate still counts (the call site does)',
            filename: QUERY_FILE,
            code: `
                function checkMediaAccess(user) { return Boolean(user); }
                export async function f(sql, user) {
                    if (!checkMediaAccess(user)) return [];
                    return sql\`${SELECT}\`;
                }
            `,
        },
        // ── the two shapes that a naive type-vs-value test gets WRONG ─────
        // Both hold a real gate call inside a node that also carries type
        // syntax. Classifying by ANCESTOR NODE TYPE (rather than by the child
        // key being descended into) erases the call and reports the file.
        // Measured while building this: the ancestor test produced 3 false
        // reports in src/routes/(proprietary)/j/Shows/[seriesId]/Episodes,
        // whose gate calls are real but sit inside `as [{ count: string }]`.
        {
            name: 'gate call inside an `as` cast still counts',
            filename: QUERY_FILE,
            code: `
                import { buildLibraryAccessFilter } from '$lib/x';
                export async function f(sql, denied) {
                    return (await sql\`${SELECT} \${buildLibraryAccessFilter(sql, denied)}\`) as [
                        { count: string },
                    ];
                }
            `,
        },
        {
            name: 'gate call on a sql template with a generic type argument still counts',
            filename: QUERY_FILE,
            code: `
                import { buildAgeRatingFilter } from '$lib/x';
                export async function f(sql, age) {
                    return await sql<{ id: string }[]>\`${SELECT} \${buildAgeRatingFilter(sql, age)}\`;
                }
            `,
        },
        // ── scope / applicability ────────────────────────────────────────
        {
            name: 'exempt path is not checked at all',
            filename: EXEMPT_FILE,
            code: `export async function f(sql) { return sql\`${SELECT}\`; }`,
        },
        {
            name: 'non-applicable path is not checked at all',
            filename: '/repo/src/lib/utils/helper.ts',
            code: `export async function f(sql) { return sql\`${SELECT}\`; }`,
        },
        {
            name: 'sql template that does not touch media_items',
            filename: QUERY_FILE,
            code: `export async function f(sql) { return sql\`SELECT * FROM users\`; }`,
        },
        // ── C3 (2026-09-18 fix-plan-4): src/lib/server/api/defs/ coverage ──
        {
            name: 'defs/ file with a gate helper in value position is not reported',
            filename: DEFS_FILE,
            code: `
                import { buildLibraryAccessFilter } from '$lib/x';
                export async function f(sql, denied) {
                    const acl = buildLibraryAccessFilter(sql, denied);
                    return sql\`${SELECT} \${acl}\`;
                }
            `,
        },
    ],

    invalid: [
        // ── THE REGRESSION: prose must not stand in for a gate ───────────
        {
            name: 'REGRESSION: JSDoc naming checkMediaAccess is not a gate',
            filename: QUERY_FILE,
            code: `
                /**
                 * Access note: callers gate on the parent item via
                 * checkMediaAccess before reaching this query.
                 */
                export async function f(sql, id) {
                    return sql\`${SELECT} AND mi.id = \${id}\`;
                }
            `,
            errors: unscoped,
        },
        {
            name: 'REGRESSION: line comment naming buildLibraryAccessFilter is not a gate',
            filename: QUERY_FILE,
            code: `
                export async function f(sql) {
                    // buildLibraryAccessFilter is deliberately NOT used here
                    return sql\`${SELECT}\`;
                }
            `,
            errors: unscoped,
        },
        {
            // The real specimen (src/routes/api/ai/embedding-preview/+server.ts)
            // carries this text as the `--` justification tail of a
            // require-has-files-with-active-status disable directive. The
            // literal directive is NOT reproduced here: RuleTester registers
            // only the rule under test, so an unknown rule name in a directive
            // adds a spurious "Definition for rule ... was not found" problem
            // and the case would assert on a harness artifact. The prose —
            // which is the thing that must not count — is reproduced verbatim.
            name: 'REGRESSION: marker inside another rule’s disable justification is not a gate',
            filename: ROUTE_FILE,
            code: `
                export async function f(sql) {
                    // -- admin-only embedding preview (requireAdmin); intentionally
                    //    samples the full catalog incl. file-less rows.
                    return sql\`${SELECT}\`;
                }
            `,
            errors: unscoped,
        },
        {
            name: 'REGRESSION: marker named inside the SQL body is not a gate',
            filename: QUERY_FILE,
            code: `
                export async function f(sql) {
                    return sql\`${SELECT} -- checkMediaAccess runs upstream\`;
                }
            `,
            errors: unscoped,
        },
        {
            name: 'REGRESSION: marker in a plain string literal is not a gate',
            filename: QUERY_FILE,
            code: `
                export async function f(sql) {
                    const note = 'gated by filterAccessibleRows upstream';
                    return sql\`${SELECT}\`;
                }
            `,
            errors: unscoped,
        },
        // ── prose with a compiler in front of it: erased at runtime ───────
        // A type is not an access decision. These pass a token-stream check
        // (the identifier IS in the token stream) but gate nothing, so they
        // belong with the prose cases above.
        {
            name: 'REGRESSION: marker only as a type-annotation field is not a gate',
            filename: QUERY_FILE,
            code: `
                interface Opts { ageRating: string | null }
                export async function f(sql, opts: Opts) {
                    return sql\`${SELECT}\`;
                }
            `,
            errors: unscoped,
        },
        {
            name: 'REGRESSION: marker only in a type alias / return type is not a gate',
            filename: QUERY_FILE,
            code: `
                type Gate = typeof checkMediaAccess;
                export async function f(sql): Promise<Gate[]> {
                    return sql\`${SELECT}\`;
                }
            `,
            errors: unscoped,
        },
        {
            name: 'REGRESSION: marker only as an unused import binding is not a gate',
            filename: ROUTE_FILE,
            code: `
                import { requireAdmin } from '$lib/x';
                export async function f(sql) {
                    return sql\`${SELECT}\`;
                }
            `,
            errors: unscoped,
        },
        // ── a marker NAME in a position that decides nothing ─────────────
        //
        // Measured bypasses that survived the prose fix: the token is real code
        // by then, but no access decision can happen at any of these positions.
        {
            name: 'REGRESSION: marker as a non-computed object property key is not a gate',
            filename: QUERY_FILE,
            code: `
                const doc = { checkMediaAccess: true };
                export async function f(sql) {
                    return [doc, await sql\`${SELECT}\`];
                }
            `,
            errors: unscoped,
        },
        {
            name: 'REGRESSION: marker as a dead function declaration is not a gate',
            filename: QUERY_FILE,
            code: `
                function checkMediaAccess() {}
                export async function f(sql) {
                    return sql\`${SELECT}\`;
                }
            `,
            errors: unscoped,
        },
        {
            name: 'REGRESSION: marker as a class declaration name is not a gate',
            filename: QUERY_FILE,
            code: `
                class isMediaAccessible {}
                export async function f(sql) {
                    return sql\`${SELECT}\`;
                }
            `,
            errors: unscoped,
        },
        {
            name: 'REGRESSION: marker as an enum member is not a gate',
            filename: QUERY_FILE,
            code: `
                enum Field { ageRating }
                export async function f(sql) {
                    return [Field, await sql\`${SELECT}\`];
                }
            `,
            errors: unscoped,
        },
        {
            name: 'REGRESSION: marker as a statement label is not a gate',
            filename: QUERY_FILE,
            code: `
                export async function f(sql) {
                    checkMediaAccess: for (let i = 0; i < 1; i++) {
                        if (i) break checkMediaAccess;
                    }
                    return sql\`${SELECT}\`;
                }
            `,
            errors: unscoped,
        },
        // ── baseline: genuinely unscoped ─────────────────────────────────
        {
            name: 'no marker anywhere',
            filename: QUERY_FILE,
            code: `export async function f(sql) { return sql\`${SELECT}\`; }`,
            errors: unscoped,
        },
        {
            name: 'each offending template reports separately',
            filename: QUERY_FILE,
            code: `
                export async function f(sql) {
                    const a = await sql\`${SELECT}\`;
                    const b = await sql\`SELECT 1 FROM media_items\`;
                    return [a, b];
                }
            `,
            errors: [{ messageId: 'unscoped' }, { messageId: 'unscoped' }],
        },
        // ── C3 (2026-09-18 fix-plan-4): src/lib/server/api/defs/ coverage ──
        // Proof the gap was live: defs/runs/index.ts's resolveRunMediaItems
        // runs an unscoped `FROM media_items` read with no marker anywhere in
        // the file and no suppression directive, because the rule never
        // looked at this tree. This fixture pins that a bare media_items
        // template under defs/ is now reported.
        {
            name: 'defs/ file with a bare media_items template and no marker is reported',
            filename: DEFS_FILE,
            code: `export async function f(sql) { return sql\`${SELECT}\`; }`,
            errors: unscoped,
        },
    ],
});

console.log('✓ no-unscoped-media-items tests passed');
