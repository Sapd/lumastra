// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-raw-json-response
 *
 * Detects import of `json` from `@sveltejs/kit` in API route files
 * and suggests using `typedJson` from `$lib/server/utils/typed-response` instead.
 *
 * This ensures server responses are validated against Zod schemas in dev mode,
 * catching schema drift before it causes client-side validation failures.
 *
 * Error responses via ApiResponses are exempt (they have a fixed shape, no client schema).
 */

module.exports = {
    meta: {
        type: 'suggestion',
        docs: {
            description: 'Prefer typedJson() over raw json() in API routes for response validation',
            category: 'Best Practices',
            recommended: true,
        },
        schema: [],
        messages: {
            useTypedJson:
                'Use typedJson(schema, data) from $lib/server/utils/typed-response instead of json() for validated responses. Error responses via ApiResponses are exempt.',
        },
    },
    create(context) {
        return {
            ImportDeclaration(node) {
                if (node.source.value !== '@sveltejs/kit') return;
                const jsonSpecifier = node.specifiers.find(
                    (s) => s.type === 'ImportSpecifier' && s.imported.name === 'json',
                );
                if (jsonSpecifier) {
                    context.report({
                        node: jsonSpecifier,
                        messageId: 'useTypedJson',
                    });
                }
            },
        };
    },
};
