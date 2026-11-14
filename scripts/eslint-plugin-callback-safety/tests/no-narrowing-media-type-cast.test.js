// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-narrowing-media-type-cast.
 *
 * The rule flags assertions that squeeze the five-token media-type union down
 * to the two-token 'movie' | 'tv' convention. The interesting cases are the
 * boundaries: an assertion that already ADMITS episode/season is fine, and
 * `undefined`/`null` members must not change the verdict.
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-narrowing-media-type-cast');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

const FILE = '/repo/src/lib/server/api/defs/foo.ts';
// A top-level `src/lib/*.svelte` page — in scope via APPLICABLE_PATH_PATTERNS
// rather than a path fragment, so it gets its own coverage.
const LIB_PAGE = '/repo/src/lib/Watchlist.svelte';
const ROUTE = '/repo/src/routes/playlists/+page.svelte';
// Outside the rule's path scope — it must stay silent there while the
// repo-wide burn-down is in progress. `src/lib/schemas/` still has violations.
const OUT_OF_SCOPE = '/repo/src/lib/schemas/ai.ts';
// A nested component under a directory that is NOT in scope — proves the
// top-level `*.svelte` pattern does not leak into arbitrary subtrees.
const OUT_OF_SCOPE_NESTED = '/repo/src/lib/schemas/nested/Foo.svelte';

ruleTester.run('no-narrowing-media-type-cast', rule, {
    valid: [
        // Already honest: admits the tokens the parser can actually emit.
        {
            code: `const t = parsed.mediaType as 'movie' | 'tv' | 'episode' | 'season';`,
            filename: FILE,
        },
        {
            code: `const t = parsed.mediaType as ParsedMediaTypeToken;`,
            filename: FILE,
        },
        // A deliberately wider mixed union is someone being explicit, not the
        // hazard this rule is about.
        {
            code: `const t = row.media_type as 'movie' | 'episode';`,
            filename: FILE,
        },
        // Non-media-type assertions must not be touched.
        {
            code: `const s = value as string;`,
            filename: FILE,
        },
        {
            code: `const n = value as 'asc' | 'desc';`,
            filename: FILE,
        },
        {
            code: `const r = row as Record<string, unknown>;`,
            filename: FILE,
        },
        // Runtime narrowing rather than an assertion — the recommended fix.
        {
            code: `const t = isSeries(row.media_type) ? 'tv' : 'movie';`,
            filename: FILE,
        },
        // Same hazardous shape, but outside the enforced paths.
        {
            code: `const t = parsed.mediaType as 'movie' | 'tv';`,
            filename: OUT_OF_SCOPE,
        },
        {
            code: `const t = parsed.mediaType as 'movie' | 'tv';`,
            filename: OUT_OF_SCOPE_NESTED,
        },
    ],

    invalid: [
        // The canonical shape.
        {
            code: `const t = parsed.mediaType as 'movie' | 'tv';`,
            filename: FILE,
            errors: [{ messageId: 'narrowingCast' }],
        },
        // Reversed order must still fire.
        {
            code: `const t = parsed.mediaType as 'tv' | 'movie';`,
            filename: FILE,
            errors: [{ messageId: 'narrowingCast' }],
        },
        // Parenthesized.
        {
            code: `const t = (parsed.mediaType as ('movie' | 'tv'));`,
            filename: FILE,
            errors: [{ messageId: 'narrowingCast' }],
        },
        // `undefined` is orthogonal — the media-type narrowing is still wrong.
        {
            code: `const t = parsed.mediaType as 'movie' | 'tv' | undefined;`,
            filename: FILE,
            errors: [{ messageId: 'narrowingCast' }],
        },
        // Single-token assertions are the same mistake, one token smaller.
        {
            code: `const t = row.media_type as 'tv';`,
            filename: FILE,
            errors: [{ messageId: 'narrowingCast' }],
        },
        // Inside a returned object literal — the media-id-resolver shape.
        {
            code: `function f() { return { mediaType: mediaType as 'movie' | 'tv' }; }`,
            filename: FILE,
            errors: [{ messageId: 'narrowingCast' }],
        },
        // As a call argument — the normalizeCacheKey shape.
        {
            code: `lookup(sql, provider, id, mediaType as 'movie' | 'tv');`,
            filename: FILE,
            errors: [{ messageId: 'narrowingCast' }],
        },
        // A top-level src/lib page — matched by pattern, not by fragment.
        {
            code: `const t = item.mediaType as 'movie' | 'tv';`,
            filename: LIB_PAGE,
            errors: [{ messageId: 'narrowingCast' }],
        },
        // Routes outside /src/routes/api/, which the burn-down now also covers.
        {
            code: `const t = item.mediaType as 'movie' | 'tv';`,
            filename: ROUTE,
            errors: [{ messageId: 'narrowingCast' }],
        },
    ],
});

console.log('no-narrowing-media-type-cast: all tests passed');
