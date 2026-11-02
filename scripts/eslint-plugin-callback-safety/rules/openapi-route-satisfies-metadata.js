// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: openapi-route-satisfies-metadata
 *
 * Every non-re-export `_openapi.ts` must annotate its exported `route` as
 * either `export const route: RouteMetadata = {...}` or
 * `export const route = {...} satisfies RouteMetadata`.
 *
 * Why: an unannotated object literal is structurally typed only at its use
 * site. The OpenAPI generator reads `route` via a dynamic import and treats
 * fields loosely; an unannotated literal let malformed metadata (e.g. a
 * string where a {schema, description} ResponseDef was expected — the
 * "string-binary" hole) through unchecked. Forcing the annotation makes
 * `tsc` validate the literal against RouteMetadata at author time.
 *
 * Re-export shims (`export { route } from '...'`) carry no literal — the
 * canonical source file is annotated, so they are skipped.
 *
 * Escape hatch: `// eslint-disable-next-line callback-safety/openapi-route-satisfies-metadata`.
 *
 * Scope: `**\/_openapi.ts`.
 */

const OPENAPI_RE = /\/_openapi\.ts$/;

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'route export in _openapi.ts must be annotated `: RouteMetadata` or `satisfies RouteMetadata`',
            category: 'API Contract',
            recommended: true,
        },
        schema: [],
        messages: {
            needsAnnotation:
                'Annotate the `route` export as `export const route: RouteMetadata = {...}` or ' +
                '`export const route = {...} satisfies RouteMetadata`. An unannotated literal is not ' +
                'type-checked against RouteMetadata and lets malformed response metadata through.',
        },
    },
    create(context) {
        const filename = context.filename || context.getFilename();
        if (!OPENAPI_RE.test(filename.replace(/\\/g, '/'))) return {};

        return {
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name="route"]'(
                node,
            ) {
                // `: RouteMetadata` → id carries a type annotation. OK.
                if (node.id.typeAnnotation) return;
                // `... satisfies X` → init is a TSSatisfiesExpression. OK.
                if (node.init && node.init.type === 'TSSatisfiesExpression') return;
                // Anything else (bare object literal, etc.) is unannotated.
                context.report({ node: node.id, messageId: 'needsAnnotation' });
            },
        };
    },
};
