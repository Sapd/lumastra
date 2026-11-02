// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-bare-media-type-comparison.
 *
 * The rule flags `===`/`!==`/`case` comparison of a media-type-ish value against
 * a media-type literal written in a NON-canonical case (`'AUDIOBOOK'`,
 * `'Movie'`, `'SERIES'`, …) or against the cross-convention alias `'show'`.
 *
 * The boundaries that matter, and why each has coverage below:
 *   - canonical lowercase (`'series'`, `'audiobook'`) must stay SILENT, or every
 *     provably-safe `PublicMediaType` comparison in the tree becomes a warning;
 *   - the comparator implementation modules must stay silent (they compare
 *     literals for a living);
 *   - a value the code already case-normalized itself must stay silent.
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-bare-media-type-comparison');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

const FILE = '/repo/src/lib/components/modal/ModalActions.svelte';
const STORE = '/repo/src/lib/stores/modal-url-sync.ts';
// The comparator implementations — exempt, they must compare literals.
const SHARED_IMPL = '/repo/src/lib/shared/media-types.ts';
const SERVER_IMPL = '/repo/src/lib/server/utils/media-types.ts';
const TEST_FILE = '/repo/src/lib/utils/url-slugs.test.ts';

ruleTester.run('no-bare-media-type-comparison', rule, {
    valid: [
        // ── The recommended form ────────────────────────────────────────────
        { code: `if (!isAudiobook(mediaType)) { markWatched(); }`, filename: FILE },
        { code: `const kind = isSeries(item.media_type) ? 'tv' : 'movie';`, filename: FILE },

        // ── Canonical lowercase is deliberately OUT of scope ────────────────
        // A narrowed public union (`PublicMediaType`) is provably lowercase, and
        // this rule cannot see types. See the rule docblock.
        { code: `if (details.type === 'series') { renderSeries(); }`, filename: FILE },
        { code: `if (mediaType === 'audiobook') { openBook(); }`, filename: FILE },
        { code: `if (row.media_type !== 'movie') { skip(); }`, filename: FILE },
        { code: `switch (item.mediaType) { case 'episode': return 1; }`, filename: FILE },

        // ── Not a media-type token at all ───────────────────────────────────
        { code: `if (contentType === 'application/json') { parse(); }`, filename: FILE },
        { code: `if (sortType === 'Asc') { asc(); }`, filename: FILE },
        // Hazardous-looking literal, but the value side is not media-type-ish.
        { code: `if (label === 'Movie') { render(); }`, filename: FILE },
        { code: `if (name === 'Series') { render(); }`, filename: FILE },

        // ── The value already case-normalized itself ────────────────────────
        // Direct call, and via a local initialized from one — this is what
        // normalizeType()/jellyfinToUIType() do inside their switch statements.
        { code: `if (mediaType.toUpperCase() === 'AUDIOBOOK') { openBook(); }`, filename: FILE },
        {
            code: `function f(type) { const mediaType = type.toUpperCase(); switch (mediaType) { case 'MOVIE': return 'movie'; } }`,
            filename: STORE,
        },

        // ── Exempt files ────────────────────────────────────────────────────
        {
            code: `if (normalizeForComparison(t) === 'MOVIE') { return true; }`,
            filename: SHARED_IMPL,
        },
        {
            code: `switch (upperType) { case 'SERIES': return UIMediaType.SERIES; }`,
            filename: SERVER_IMPL,
        },
        {
            code: `expect(slugKindForMediaType('AUDIOBOOK')).toBe('audiobook');`,
            filename: TEST_FILE,
        },
        { code: `if (mediaType === 'AUDIOBOOK') { openBook(); }`, filename: TEST_FILE },
    ],

    invalid: [
        // ── The shape that shipped in ModalActions.svelte, verbatim ─────────
        {
            code: `const watchLabel = mediaType !== 'AUDIOBOOK' ? 'Mark Movie as watched' : 'Mark Book as read';`,
            filename: FILE,
            errors: [{ messageId: 'bareComparison' }],
        },
        {
            code: `if (mediaType !== 'AUDIOBOOK') { markWatched(); }`,
            filename: FILE,
            errors: [{ messageId: 'bareComparison' }],
        },
        // ── PascalCase (Jellyfin) against an app-side media type ────────────
        {
            code: `if (item.mediaType === 'Movie') { openMovie(); }`,
            filename: FILE,
            errors: [{ messageId: 'bareComparison' }],
        },
        {
            code: `if (props.mediaType === 'Series') { openSeries(); }`,
            filename: FILE,
            errors: [{ messageId: 'bareComparison' }],
        },
        // ── UPPERCASE legacy / external-client tokens ──────────────────────
        {
            code: `if (media_type === 'MOVIE') { openMovie(); }`,
            filename: FILE,
            errors: [{ messageId: 'bareComparison' }],
        },
        {
            code: `if (row.media_type === 'SERIES') { openSeries(); }`,
            filename: FILE,
            errors: [{ messageId: 'bareComparison' }],
        },
        // Uppercase of a lowercase-canonical token still mismatches two of the
        // three conventions.
        {
            code: `if (mediaType === 'TV') { openSeries(); }`,
            filename: FILE,
            errors: [{ messageId: 'bareComparison' }],
        },
        // ── The cross-convention alias, even lowercase (mdblist 'show') ─────
        {
            code: `if (item.type === 'show') { countAsSeries(); }`,
            filename: FILE,
            errors: [{ messageId: 'bareComparison' }],
        },
        // ── Literal on the left ────────────────────────────────────────────
        {
            code: `if ('AUDIOBOOK' === mediaType) { openBook(); }`,
            filename: FILE,
            errors: [{ messageId: 'bareComparison' }],
        },
        // ── switch/case ────────────────────────────────────────────────────
        {
            code: `switch (props.mediaType) { case 'Movie': return 1; case 'Series': return 2; }`,
            filename: FILE,
            errors: [{ messageId: 'bareComparison' }, { messageId: 'bareComparison' }],
        },
        // ── A no-substitution template literal is still a string literal ────
        {
            code: 'if (mediaType === `AUDIOBOOK`) { openBook(); }',
            filename: FILE,
            errors: [{ messageId: 'bareComparison' }],
        },
        // ── Optional chaining / non-null / as-cast on the value side ────────
        {
            code: `if (item?.mediaType === 'Series') { openSeries(); }`,
            filename: FILE,
            errors: [{ messageId: 'bareComparison' }],
        },
        {
            code: `if ((item.mediaType as string as MediaType) === 'Movie') { openMovie(); }`,
            filename: FILE,
            errors: [{ messageId: 'bareComparison' }],
        },
        // ── A loose `*Type` name still counts as plausibly a media type ─────
        {
            code: `if (libraryType === 'Movie') { scanMovies(); }`,
            filename: FILE,
            errors: [{ messageId: 'bareComparison' }],
        },
        // ── A local NOT initialized from a case-normalizer is not exempt ────
        {
            code: `function f(x) { const mediaType = String(x); if (mediaType === 'AUDIOBOOK') { openBook(); } }`,
            filename: STORE,
            errors: [{ messageId: 'bareComparison' }],
        },
    ],
});

console.log('no-bare-media-type-comparison: all tests passed');
