// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-duplicate-response-types
 *
 * Warns when defining interfaces/types that duplicate Zod schema names.
 * These types should be inferred from Zod schemas to maintain a single source of truth.
 *
 * Problem Pattern:
 * ```typescript
 * // ❌ WRONG - Duplicates Zod schema
 * export interface UniversalMediaItem {
 *     id: string;
 *     title: string;
 *     // ...
 * }
 * ```
 *
 * Correct Pattern:
 * ```typescript
 * // ✅ CORRECT - Import from Zod-inferred types
 * import type { UniversalMediaItem, PageSection } from '$lib/types/api-responses';
 * // or from OpenAPI generated types
 * import type { components } from '$lib/api/openapi-types';
 * type UniversalMediaItem = components['schemas']['UniversalMediaItem'];
 * ```
 *
 * Rationale:
 * - Zod schemas are the source of truth for API validation
 * - Types should be inferred from schemas to prevent drift
 * - Adding new fields requires updating the Zod schema first
 * - Prevents schema/type mismatches that cause runtime errors
 *
 * @see scripts/openapi/components.ts (where Zod schemas live)
 */

const PROTECTED_TYPE_NAMES = ['UniversalMediaItem', 'PageSection', 'SectionMeta', 'ExternalIds'];

module.exports = {
    meta: {
        type: 'suggestion',
        docs: {
            description: 'Warn when defining interfaces/types that duplicate Zod schema names',
            category: 'Best Practices',
            recommended: true,
        },
        messages: {
            duplicateResponseType:
                'Type "{{typeName}}" duplicates a Zod schema name. ' +
                'Import from the correct location instead:\n' +
                '  import type { {{typeName}} } from "$lib/types/api-responses";\n' +
                '  // or directly from Zod schemas:\n' +
                '  import type { {{typeName}} } from "$lib/schemas/api-responses";\n\n' +
                'Why: Zod schemas in src/lib/schemas/api-responses.ts are the SINGLE SOURCE OF TRUTH. ' +
                'Types should be inferred from schemas to prevent drift. ' +
                'To add new fields, update the Zod schema first.',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    // Additional type names to protect
                    protectedTypes: {
                        type: 'array',
                        items: { type: 'string' },
                        default: [],
                    },
                },
                additionalProperties: false,
            },
        ],
    },

    create(context) {
        const options = context.options[0] || {};
        const additionalProtectedTypes = options.protectedTypes || [];
        const allProtectedTypes = [...PROTECTED_TYPE_NAMES, ...additionalProtectedTypes];

        // Check if current file is exempt
        // Note: src/lib/schemas/api-responses.ts is the source of truth for Zod schemas
        // The other files either re-export types or are legacy locations
        const filename = context.filename;
        const isExempt =
            filename.includes('src/lib/schemas/') ||
            filename.includes('scripts/openapi/components.ts') ||
            filename.includes('src/lib/types/api-responses.ts') ||
            filename.includes('src/lib/types/api-common.ts') || // Re-exports from Zod schemas + generic types
            filename.includes('src/lib/types/server-driven-ui.ts') ||
            filename.includes('src/lib/server/utils/api-responses.ts') ||
            filename.includes('.test.ts') ||
            filename.includes('.spec.ts');

        if (isExempt) {
            return {};
        }

        /**
         * Check if a name matches a protected type name
         */
        function isProtectedTypeName(name) {
            return allProtectedTypes.includes(name);
        }

        /**
         * Report a duplicate type definition
         */
        function reportDuplicate(node, typeName) {
            context.report({
                node,
                messageId: 'duplicateResponseType',
                data: { typeName },
            });
        }

        return {
            // Catch: interface UniversalMediaItem { ... }
            TSInterfaceDeclaration(node) {
                const name = node.id.name;
                if (isProtectedTypeName(name)) {
                    reportDuplicate(node, name);
                }
            },

            // Catch: type UniversalMediaItem = { ... }
            TSTypeAliasDeclaration(node) {
                const name = node.id.name;
                if (isProtectedTypeName(name)) {
                    reportDuplicate(node, name);
                }
            },

            // Catch: export interface UniversalMediaItem { ... }
            // (Already caught by TSInterfaceDeclaration, but be explicit about exports)
            ExportNamedDeclaration(node) {
                if (node.declaration) {
                    const decl = node.declaration;

                    // Export interface
                    if (
                        decl.type === 'TSInterfaceDeclaration' &&
                        isProtectedTypeName(decl.id.name)
                    ) {
                        reportDuplicate(decl, decl.id.name);
                    }

                    // Export type
                    if (
                        decl.type === 'TSTypeAliasDeclaration' &&
                        isProtectedTypeName(decl.id.name)
                    ) {
                        reportDuplicate(decl, decl.id.name);
                    }
                }
            },
        };
    },
};
