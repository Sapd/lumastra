// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for require-has-files-with-active-status rule.
 *
 * The rule fires on sql templates that:
 *   - touch media_items via FROM/JOIN
 *   - contain a literal 'movie' string (the tell of a user-facing list
 *     filtered to top-level playable items — joined-ancestor filters use
 *     'tv'/'series'/'season' but never 'movie' since movies have no children)
 *   - do NOT contain has_files anywhere in the template text
 * Exempt paths (catalog ops, admin, sync, search, music, etc.) never fire.
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/require-has-files-with-active-status');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

const QUERIES_PATH = '/repo/src/lib/server/database/queries/onboarding.queries.ts';
const ROUTE_PATH = '/repo/src/routes/api/for-you/recently-added/+server.ts';
const ADMIN_ROUTE_PATH = '/repo/src/routes/api/admin/media/+server.ts';
const ADMIN_PATH = '/repo/src/routes/admin/media/+server.ts';
const CATALOG_PATH = '/repo/src/lib/server/database/queries/catalog-operations.queries.ts';
const SEARCH_PATH = '/repo/src/lib/server/database/queries/search.queries.ts';
const MUSIC_PATH = '/repo/src/lib/server/database/queries/music.queries.ts';
const MIGRATION_PATH = '/repo/src/lib/server/database/migrations/13.9.0_library_added_at.ts';
const TEST_PATH = '/repo/src/lib/server/database/queries/onboarding.queries.test.ts';
const COMPONENT_PATH = '/repo/src/lib/components/MyComponent.svelte';

ruleTester.run('require-has-files-with-active-status', rule, {
    valid: [
        // ── correct: has_files = true present literally ──
        {
            code: "await sql`SELECT mi.id FROM media_items mi WHERE mi.status = 'active' AND mi.has_files = true AND mi.media_type IN ('movie', 'tv')`;",
            filename: QUERIES_PATH,
        },
        // ── correct: has_files present in conditional fragment ──
        {
            code:
                'const availableOnly = true;' +
                "await sql`SELECT mi.id FROM media_items mi WHERE mi.media_type IN ('movie', 'tv') ${availableOnly ? sql`AND mi.has_files = true` : sql``}`;",
            filename: QUERIES_PATH,
        },
        // ── the SQL-comment stripper must not eat REAL filter text ──
        //    A `--` on an earlier line must only blank to end of THAT line.
        {
            code:
                'await sql`SELECT mi.id FROM media_items mi\n' +
                '-- library scope below\n' +
                "WHERE mi.media_type IN ('movie', 'tv') AND mi.has_files = true`;",
            filename: QUERIES_PATH,
        },
        //    A `--` inside a quoted SQL literal is not a comment, so a real
        //    has_files filter after it on the same line must still count.
        {
            code:
                'await sql`SELECT mi.id FROM media_items mi\n' +
                "WHERE mi.title <> '--' AND mi.media_type = 'movie' AND mi.has_files = true`;",
            filename: QUERIES_PATH,
        },
        //    Likewise an apostrophe-bearing literal must not desynchronise the
        //    quote tracking and swallow the filter that follows it.
        {
            code:
                'await sql`SELECT mi.id FROM media_items mi\n' +
                "WHERE mi.media_type = 'movie' AND mi.title <> 'a/*b' AND mi.has_files = true`;",
            filename: QUERIES_PATH,
        },
        // ── correct: no movie literal — catalog-shape query ──
        {
            code:
                "const mediaTypes = ['movie'];" +
                'await sql`SELECT mi.id FROM media_items mi WHERE mi.media_type = ANY(${mediaTypes})`;',
            filename: QUERIES_PATH,
        },
        // ── correct: joined-ancestor 'tv'/'series' filter without 'movie'
        //    literal must not fire — this is the false-positive shape we
        //    saw in /j/Shows/[seriesId]/Episodes and /j/UserViews ──
        {
            code: "await sql`SELECT mi.id FROM media_items mi JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season' JOIN media_items series ON series.id = season.parent_id AND series.media_type IN ('tv', 'series') WHERE mi.media_type = 'episode' AND mi.status = 'active'`;",
            filename: QUERIES_PATH,
        },
        {
            code: "await sql`SELECT id FROM media_items mi WHERE mi.media_type IN ('tv', 'anime')`;",
            filename: QUERIES_PATH,
        },
        // ── correct: no FROM/JOIN media_items ──
        {
            code: "await sql`SELECT id FROM external_ids WHERE provider = 'tmdb'`;",
            filename: QUERIES_PATH,
        },
        // ── exempt: catalog operations file ──
        {
            code: "await sql`SELECT id FROM media_items WHERE media_type IN ('movie', 'tv')`;",
            filename: CATALOG_PATH,
        },
        // ── exempt: search query file ──
        {
            code: "await sql`SELECT id FROM media_items WHERE media_type = 'movie'`;",
            filename: SEARCH_PATH,
        },
        // ── exempt: music queries (different media_type universe) ──
        {
            code: "await sql`SELECT id FROM media_items WHERE media_type IN ('movie', 'tv')`;",
            filename: MUSIC_PATH,
        },
        // ── exempt: admin route ──
        {
            code: "await sql`SELECT id FROM media_items WHERE media_type = 'movie'`;",
            filename: ADMIN_ROUTE_PATH,
        },
        {
            code: "await sql`SELECT id FROM media_items WHERE media_type = 'movie'`;",
            filename: ADMIN_PATH,
        },
        // ── exempt: migration ──
        {
            code: "await sql`SELECT id FROM media_items WHERE media_type = 'movie'`;",
            filename: MIGRATION_PATH,
        },
        // ── exempt: test file ──
        {
            code: "await sql`SELECT id FROM media_items WHERE media_type = 'movie'`;",
            filename: TEST_PATH,
        },
        // ── outside applicable paths (components, etc.) ──
        {
            code: "const noop = `SELECT id FROM media_items WHERE media_type = 'movie'`;",
            filename: COMPONENT_PATH,
        },
        // ── not a sql tag — random template literal happens to mention media_items ──
        {
            code: "const tag = (s) => s; tag`FROM media_items WHERE media_type = 'movie'`;",
            filename: QUERIES_PATH,
        },
        // ── eslint-disable-next-line override ──
        // RuleTester runs the rule under the synthetic id `rule-to-test/...`,
        // so we use that prefix here. Real callsites use the real plugin name.
        {
            code:
                '// eslint-disable-next-line rule-to-test/require-has-files-with-active-status\n' +
                "await sql`SELECT id FROM media_items WHERE media_type IN ('movie', 'tv')`;",
            filename: QUERIES_PATH,
        },
    ],
    invalid: [
        // ── the regression we're catching: SELECT from media_items, filters
        //    by 'movie'/'tv' literals, no has_files anywhere. The exact
        //    buggy shape from getRecentlyAddedItems pre-fix.
        {
            code: "await sql`SELECT mi.id, mi.title FROM media_items mi WHERE mi.status = 'active' AND mi.media_type IN ('movie', 'tv') ORDER BY mi.created_at DESC`;",
            filename: QUERIES_PATH,
            errors: [{ messageId: 'missingHasFiles' }],
        },
        // ── single-type variant (filter by 'movie' alone) ──
        {
            code: "await sql`SELECT mi.id FROM media_items mi WHERE mi.media_type = 'movie' AND mi.status = 'active'`;",
            filename: QUERIES_PATH,
            errors: [{ messageId: 'missingHasFiles' }],
        },
        // ── JOIN form, with 'movie' literal present ──
        {
            code: "await sql`SELECT u.id FROM users u JOIN media_items mi ON mi.id = u.media_id WHERE mi.media_type = 'movie'`;",
            filename: ROUTE_PATH,
            errors: [{ messageId: 'missingHasFiles' }],
        },
        // ── route file (under /src/routes/) with the same bug shape ──
        {
            code: "await sql`SELECT id FROM media_items WHERE media_type IN ('movie', 'tv')`;",
            filename: ROUTE_PATH,
            errors: [{ messageId: 'missingHasFiles' }],
        },
        // ── REGRESSION (2026-07-30): a JS comment inside the template that
        //    merely NAMES has_files must not satisfy the filter requirement.
        //    Same false-negative class as the prose hole in
        //    no-unscoped-media-items: the marker was matched against raw
        //    source text, so mentioning the column counted as filtering on it.
        {
            code:
                'await sql`SELECT id FROM media_items ' +
                "WHERE media_type = 'movie' ${/* has_files is enforced upstream */ ''}`;",
            filename: QUERIES_PATH,
            errors: [{ messageId: 'missingHasFiles' }],
        },
        {
            code:
                'await sql`SELECT id FROM media_items ' +
                "WHERE media_type = 'movie' ${\n// has_files filter applied by the caller\n''}`;",
            filename: QUERIES_PATH,
            errors: [{ messageId: 'missingHasFiles' }],
        },
        // ── REGRESSION (2026-07-30, second pass): a SQL comment inside the
        //    template. `blankComments` uses getCommentsInside(), which only
        //    sees JS comments — a `--` line inside the template is plain
        //    template TEXT, so naming the column there satisfied the rule even
        //    after the JS-comment hole above was closed. Same prose-as-proof
        //    shape, one layer down.
        {
            code:
                'await sql`SELECT id FROM media_items\n' +
                "WHERE media_type = 'movie' -- has_files is applied by the caller\n`;",
            filename: QUERIES_PATH,
            errors: [{ messageId: 'missingHasFiles' }],
        },
        {
            code:
                'await sql`SELECT id FROM media_items\n' +
                "/* has_files intentionally omitted, see ADR-12 */\nWHERE media_type = 'movie'`;",
            filename: QUERIES_PATH,
            errors: [{ messageId: 'missingHasFiles' }],
        },
    ],
});

console.log('✅ require-has-files-with-active-status tests passed');
