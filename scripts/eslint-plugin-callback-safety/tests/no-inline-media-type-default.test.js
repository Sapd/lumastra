// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

const { RuleTester } = require('eslint');
const rule = require('../rules/no-inline-media-type-default');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

const FILE = '/repo/src/lib/utils/media-type-mapper.ts';
const TEST_FILE = '/repo/src/lib/utils/media-type-mapper.test.ts';
const IMPLEMENTATION = '/repo/src/lib/shared/media-types.ts';

ruleTester.run('no-inline-media-type-default', rule, {
    valid: [
        // Binary projections are intentionally allowed.
        { code: `const type = isSeries(raw) ? 'tv' : 'movie';`, filename: FILE },
        { code: `const type = isMovie(raw) ? 'movie' : 'tv';`, filename: FILE },
        { code: `const type = isEpisode(raw) ? 'episode' : null;`, filename: FILE },
        {
            code: `const sourceLevelLabel = source === 'album' ? 'Album' : 'Series';`,
            filename: FILE,
        },
        {
            code: `const prototype = isEpisode(raw) ? 'episode' : isSeries(raw) ? 'series' : 'movie';`,
            filename: FILE,
        },
        // Null is an honest unsupported-type result, not a fabricated media type.
        {
            code: `const type = isEpisode(raw) ? 'episode' : isSeries(raw) ? 'series' : null;`,
            filename: FILE,
        },
        // Non-media defaults and tests are outside the rule's scope.
        {
            code: `const kind = isEpisode(raw) ? 'episode' : isSeries(raw) ? 'series' : 'unknown';`,
            filename: FILE,
        },
        { code: `const type = toTmdbType(raw) ?? 'movie';`, filename: TEST_FILE },
        { code: `const type = isSeries(raw) ? 'series' : 'movie';`, filename: IMPLEMENTATION },
    ],
    invalid: [
        {
            code: `const type = isEpisode(raw) ? 'episode' : isSeries(raw) ? 'series' : 'movie';`,
            filename: FILE,
            errors: [{ messageId: 'inlineDefault' }],
        },
        {
            code: `const type = isAudiobook(raw) ? 'audiobook' : isSeries(raw) ? 'series' : 'movie';`,
            filename: FILE,
            errors: [{ messageId: 'inlineDefault' }],
        },
        {
            code: `const type = toTmdbType(raw) ?? 'movie';`,
            filename: FILE,
            errors: [{ messageId: 'converterDefault' }],
        },
        {
            code: `const type = toMovieOrSeries(raw) || 'movie';`,
            filename: FILE,
            errors: [{ messageId: 'converterDefault' }],
        },
    ],
});

console.log('no-inline-media-type-default: all tests passed');
