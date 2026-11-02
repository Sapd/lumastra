// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-direct-external-id-access
 *
 * Warns when code directly accesses provider-specific external IDs instead of
 * using the provider-agnostic helpers from external-ids.ts.
 *
 * Problem Pattern:
 * ```typescript
 * const tmdbId = item.externalIds.tmdb;  // Direct provider access
 * if (item.externalIds.imdb) { ... }     // Direct provider check
 * ```
 *
 * Correct Pattern:
 * ```typescript
 * import { getExternalIdFor, getPreferredExternalId } from '$lib/utils/external-ids';
 *
 * const tmdbId = getExternalIdFor(item.externalIds, 'tmdb');  // Explicit provider
 * const preferred = getPreferredExternalId(item.externalIds); // Provider-agnostic
 * ```
 *
 * Exception: When explicitly needing a specific provider (e.g., Jellyseerr requires TMDB),
 * use getExternalIdFor() with a comment explaining the constraint:
 * ```typescript
 * // Jellyseerr requires TMDB ID - external API constraint
 * const tmdbId = getExternalIdFor(item.externalIds, 'tmdb');
 * ```
 *
 * @see docs/provider-constraints.md
 */

const EXTERNAL_ID_PROVIDERS = ['tmdb', 'imdb', 'tvdb', 'trakt', 'mal', 'jellyfin', 'internal'];

module.exports = {
    meta: {
        type: 'suggestion',
        docs: {
            description:
                'Enforce use of provider-agnostic helpers instead of direct externalIds property access',
            category: 'Best Practices',
            recommended: true,
        },
        messages: {
            directAccess:
                'Direct access to externalIds.{{provider}} is discouraged. ' +
                "Use getExternalIdFor(externalIds, '{{provider}}') for explicit provider access, " +
                'or getPreferredExternalId(externalIds) for provider-agnostic code.',
            directAssignment:
                'Direct assignment to externalIds.{{provider}} should use createExternalIds() ' +
                'or merge helpers from external-ids.ts.',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    // Allow specific providers to be accessed directly (e.g., for Jellyseerr)
                    allowedProviders: {
                        type: 'array',
                        items: { type: 'string' },
                        default: [],
                    },
                    // Paths to exempt (e.g., external-ids.ts itself)
                    exemptPaths: {
                        type: 'array',
                        items: { type: 'string' },
                        default: [
                            'external-ids.ts',
                            'api-common.ts',
                            'media-id-helpers.ts',
                            '.test.ts',
                            '.spec.ts',
                        ],
                    },
                },
                additionalProperties: false,
            },
        ],
        fixable: null, // Could be 'code' if we want auto-fix
    },

    create(context) {
        const options = context.options[0] || {};
        const allowedProviders = options.allowedProviders || [];
        const exemptPaths = options.exemptPaths || [
            'external-ids.ts',
            'api-common.ts',
            'media-id-helpers.ts',
            '.test.ts',
            '.spec.ts',
        ];

        // Check if current file is exempt
        const filename = context.filename;
        const isExempt = exemptPaths.some((path) => filename.includes(path));
        if (isExempt) {
            return {};
        }

        /**
         * Check if a node is accessing an external ID provider property
         */
        function isExternalIdAccess(node) {
            // Must be a MemberExpression
            if (node.type !== 'MemberExpression') {
                return null;
            }

            // Check if property is a known external ID provider
            const property = node.property;
            let providerName = null;

            if (property.type === 'Identifier') {
                providerName = property.name;
            } else if (property.type === 'Literal' && typeof property.value === 'string') {
                providerName = property.value;
            }

            if (!providerName || !EXTERNAL_ID_PROVIDERS.includes(providerName)) {
                return null;
            }

            // Check if allowed
            if (allowedProviders.includes(providerName)) {
                return null;
            }

            // Check if parent is 'externalIds' or object ending in 'externalIds'
            const object = node.object;
            if (isExternalIdsObject(object)) {
                return providerName;
            }

            return null;
        }

        /**
         * Check if a node represents an externalIds object
         */
        function isExternalIdsObject(node) {
            // Direct identifier: externalIds.tmdb
            if (node.type === 'Identifier' && node.name === 'externalIds') {
                return true;
            }

            // Member expression: item.externalIds
            if (
                node.type === 'MemberExpression' &&
                node.property.type === 'Identifier' &&
                node.property.name === 'externalIds'
            ) {
                return true;
            }

            // Optional chaining: item?.externalIds
            if (
                node.type === 'ChainExpression' &&
                node.expression.type === 'MemberExpression' &&
                node.expression.property.type === 'Identifier' &&
                node.expression.property.name === 'externalIds'
            ) {
                return true;
            }

            return false;
        }

        /**
         * Check if node has a disable comment nearby
         */
        function hasDisableComment(node) {
            const sourceCode = context.sourceCode;
            const comments = sourceCode.getCommentsBefore(node);

            for (const comment of comments) {
                const text = comment.value.toLowerCase();
                if (
                    text.includes('eslint-disable') &&
                    (text.includes('no-direct-external-id-access') ||
                        text.includes('provider-constraint') ||
                        text.includes('jellyseerr'))
                ) {
                    return true;
                }
            }

            // Also check line comments on the same line
            const lineComments = sourceCode.getCommentsAfter(node);
            for (const comment of lineComments) {
                const text = comment.value.toLowerCase();
                if (
                    text.includes('provider-constraint') ||
                    text.includes('jellyseerr requires') ||
                    text.includes('external api constraint')
                ) {
                    return true;
                }
            }

            return false;
        }

        return {
            MemberExpression(node) {
                // Skip if this is part of an optional chain we've already processed
                if (node.parent && node.parent.type === 'ChainExpression') {
                    return;
                }

                const provider = isExternalIdAccess(node);
                if (provider && !hasDisableComment(node)) {
                    context.report({
                        node,
                        messageId: 'directAccess',
                        data: { provider },
                    });
                }
            },

            // Handle optional chaining: item?.externalIds?.tmdb
            ChainExpression(node) {
                // Walk through the chain looking for externalIds.provider patterns
                function walkChain(expr) {
                    if (expr.type !== 'MemberExpression') {
                        return;
                    }

                    const provider = isExternalIdAccess(expr);
                    if (provider && !hasDisableComment(expr)) {
                        context.report({
                            node: expr,
                            messageId: 'directAccess',
                            data: { provider },
                        });
                    }

                    // Continue walking up the chain
                    if (expr.object) {
                        if (expr.object.type === 'MemberExpression') {
                            walkChain(expr.object);
                        }
                    }
                }

                walkChain(node.expression);
            },

            // Catch destructuring: const { tmdb } = externalIds;
            VariableDeclarator(node) {
                if (
                    node.id.type === 'ObjectPattern' &&
                    node.init &&
                    isExternalIdsObject(node.init)
                ) {
                    for (const prop of node.id.properties) {
                        if (prop.type === 'Property' && prop.key.type === 'Identifier') {
                            const propName = prop.key.name;
                            if (
                                EXTERNAL_ID_PROVIDERS.includes(propName) &&
                                !allowedProviders.includes(propName)
                            ) {
                                if (!hasDisableComment(prop)) {
                                    context.report({
                                        node: prop,
                                        messageId: 'directAccess',
                                        data: { provider: propName },
                                    });
                                }
                            }
                        }
                    }
                }
            },
        };
    },
};
