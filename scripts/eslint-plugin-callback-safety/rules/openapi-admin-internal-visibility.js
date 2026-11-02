// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: openapi-admin-internal-visibility
 *
 * Every `_openapi.ts` under `src/routes/api/v1/admin/**` must declare its
 * route metadata as `visibility: 'internal'`. Admin routes are operator-only
 * surface; shipping one without the `internal` marker leaks it into the
 * public OpenAPI spec (the Scalar reference + the published api-v1.yaml).
 *
 * The check fires on the exported `route` object literal: if a top-level
 * `visibility: 'internal'` key/value is absent, the route is flagged.
 *
 * Escape hatch — intentionally-public admin route:
 *   Put a marker comment anywhere in the file:
 *       // openapi-allow-public-admin: <reason>
 *   (or the usual `// eslint-disable-next-line` on the export). The marker is
 *   the sanctioned allow-list so a deliberate public admin endpoint stays
 *   greppable.
 *
 * Scope: only `**\/api/v1/admin/**\/_openapi.ts`. Re-export shims
 * (`export { route } from '...'`) carry no literal and are skipped — the
 * canonical source file is the one that gets checked.
 */

const ADMIN_OPENAPI_RE = /\/api\/v1\/admin\/.*\/_openapi\.ts$/;
const ALLOW_MARKER = 'openapi-allow-public-admin';

function isInternalVisibilityProp(prop) {
    if (prop.type !== 'Property') return false;
    const keyName =
        prop.key.type === 'Identifier'
            ? prop.key.name
            : prop.key.type === 'Literal'
              ? prop.key.value
              : null;
    if (keyName !== 'visibility') return false;
    return prop.value.type === 'Literal' && prop.value.value === 'internal';
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                "Admin _openapi.ts route metadata must declare visibility:'internal' so it stays out of the public spec",
            category: 'API Contract',
            recommended: true,
        },
        schema: [],
        messages: {
            missingInternal:
                "Admin route metadata must declare visibility:'internal' (file is under api/v1/admin/). " +
                "Add `visibility: 'internal'` to the route object, or, for an intentionally-public admin " +
                'route, add an allow-list comment `// openapi-allow-public-admin: <reason>`.',
        },
    },
    create(context) {
        const filename = context.filename || context.getFilename();
        if (!ADMIN_OPENAPI_RE.test(filename.replace(/\\/g, '/'))) return {};

        // Allow-list escape hatch: a marker comment anywhere in the file.
        const sourceCode = context.sourceCode || context.getSourceCode();
        const hasAllowMarker = sourceCode
            .getAllComments()
            .some((c) => c.value.includes(ALLOW_MARKER));
        if (hasAllowMarker) return {};

        return {
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name="route"]'(
                node,
            ) {
                // Unwrap `satisfies` / type-assertion wrappers to reach the literal.
                let init = node.init;
                while (
                    init &&
                    (init.type === 'TSSatisfiesExpression' || init.type === 'TSAsExpression')
                ) {
                    init = init.expression;
                }
                if (!init || init.type !== 'ObjectExpression') return;

                const ok = init.properties.some(isInternalVisibilityProp);
                if (!ok) {
                    context.report({ node: node.id, messageId: 'missingInternal' });
                }
            },
        };
    },
};
