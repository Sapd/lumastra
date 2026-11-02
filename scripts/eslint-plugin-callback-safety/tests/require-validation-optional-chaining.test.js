// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for require-validation-optional-chaining rule
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/require-validation-optional-chaining');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

ruleTester.run('require-validation-optional-chaining', rule, {
    valid: [
        {
            // No optional chaining
            code: `
        const id = item.tmdbId;
        fetch(\`/api/data/\${id}\`);
      `,
        },
        {
            // Optional chaining not in critical context
            code: `
        const title = item?.title;
        console.log(title);
      `,
        },
        {
            // With requireValue validation
            code: `
        const id = requireValue(item?.tmdbId, 'Item must have tmdbId');
        fetch(\`/api/data/\${id}\`);
      `,
        },
        {
            // With explicit null check
            code: `
        if (!item?.tmdbId) throw new Error('Missing tmdbId');
        fetch(\`/api/data/\${item.tmdbId}\`);
      `,
        },
        {
            // Optional chaining in non-critical string
            code: `
        const message = \`Title: \${item?.title || 'Unknown'}\`;
      `,
        },
    ],
    invalid: [
        {
            // Optional chaining in fetch URL
            code: `
        const id = item?.tmdbId;
        fetch(\`/api/data/\${id}\`);
      `,
            errors: [
                {
                    messageId: 'unsafeOptionalChaining',
                    data: {
                        context: 'fetch',
                    },
                },
            ],
        },
        {
            // Direct optional chaining in template literal
            code: `fetch(\`/api/recommendations/\${item?.tmdbId}\`);`,
            errors: [
                {
                    messageId: 'unsafeOptionalChaining',
                },
            ],
        },
        {
            // Optional chaining in new URL
            code: `
        const url = new URL(\`/profile/\${user?.id}\`);
      `,
            errors: [
                {
                    messageId: 'unsafeOptionalChaining',
                    data: {
                        context: 'new URL',
                    },
                },
            ],
        },
        {
            // Chained optional chaining
            code: `
        const name = data?.user?.profile?.name;
        fetch(\`/api/users/\${name}\`);
      `,
            errors: [
                {
                    messageId: 'unsafeOptionalChaining',
                },
            ],
        },
        {
            // Optional chaining in Request constructor
            code: `
        new Request(\`/api/items/\${item?.id}\`);
      `,
            errors: [
                {
                    messageId: 'unsafeOptionalChaining',
                },
            ],
        },
    ],
});

console.log('✅ All tests passed for require-validation-optional-chaining');
