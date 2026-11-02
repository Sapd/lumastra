// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

const { RuleTester } = require('eslint');
const rule = require('../rules/no-compat-media-type-conversion-import');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

ruleTester.run('no-compat-media-type-conversion-import', rule, {
    valid: [
        {
            code: `import { toMovieOrSeries } from '$lib/shared/media-type-domain';`,
            filename: '/repo/src/lib/server/api/route.ts',
        },
        {
            code: `import { isMovie, isSeries } from '$lib/shared/media-types';`,
            filename: '/repo/src/lib/server/api/route.ts',
        },
        {
            code: `import { toMovieOrSeries } from '$lib/server/utils/media-types';`,
            filename: '/repo/src/lib/server/utils/media-types.test.ts',
        },
    ],
    invalid: [
        {
            code: `import { toMovieOrSeries } from '$lib/shared/media-types';`,
            filename: '/repo/src/lib/server/api/route.ts',
            errors: [{ messageId: 'converter' }],
            output: `import { toMovieOrSeries } from '$lib/shared/media-type-domain';`,
        },
        {
            code: `import { toPublicMediaType, isMovie } from '../utils/media-types.js';`,
            filename: '/repo/src/lib/server/api/route.ts',
            errors: [{ messageId: 'converter' }],
            output: `import { isMovie } from '../utils/media-types.js';\nimport { toPublicMediaType } from '$lib/shared/media-type-domain';`,
        },
    ],
});

console.log('no-compat-media-type-conversion-import: all tests passed');
