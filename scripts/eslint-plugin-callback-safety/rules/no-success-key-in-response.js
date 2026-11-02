// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-success-key-in-response (WARN)
 *
 * Flags a `success:` key in an object literal handed to `json()` or
 * `typedJson()` in the API def layer (`src/lib/server/api/defs/**`). The
 * redesigned /api/v1 contract returns bare objects or `{ items, page }` —
 * there is no `{ success: true }` envelope.
 *
 * Scope is narrow on purpose: only object literals passed directly to
 * `json(...)` / `typedJson(...)`. This is what keeps `safeParse().success`
 * reads and internal `{ success: true as const, data }` locals (the manual
 * parse-result shape used in some task routes) OUT of scope. Because the
 * heuristic is call-site based, it ships as WARN.
 *
 * Escape hatch (per occurrence):
 *   // eslint-disable-next-line callback-safety/no-success-key-in-response
 */

const DEF_PATH_RE = /\/src\/lib\/server\/api\/defs\//;
const RESPONSE_CALLEES = new Set(['json', 'typedJson']);

function calleeName(node) {
    if (node.type === 'Identifier') return node.name;
    if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
        return node.property.name;
    }
    return null;
}

function keyName(prop) {
    if (prop.type !== 'Property') return null;
    if (prop.key.type === 'Identifier') return prop.key.name;
    if (prop.key.type === 'Literal') return String(prop.key.value);
    return null;
}

module.exports = {
    meta: {
        type: 'suggestion',
        docs: {
            description:
                'Flag a success: envelope key in json()/typedJson() responses in the def layer',
            category: 'API Contract',
            recommended: false,
        },
        schema: [],
        messages: {
            successKey:
                'The /api/v1 contract has no `{ success: true }` envelope — return a bare object or ' +
                '`{ items, page }`. If this success field is genuinely part of a resource payload, add ' +
                '`// eslint-disable-next-line callback-safety/no-success-key-in-response`.',
        },
    },
    create(context) {
        const filename = (context.filename || context.getFilename()).replace(/\\/g, '/');
        if (!DEF_PATH_RE.test(filename)) return {};

        return {
            CallExpression(node) {
                if (!RESPONSE_CALLEES.has(calleeName(node.callee))) return;
                for (const arg of node.arguments) {
                    if (!arg || arg.type !== 'ObjectExpression') continue;
                    for (const prop of arg.properties) {
                        if (keyName(prop) === 'success') {
                            context.report({ node: prop, messageId: 'successKey' });
                        }
                    }
                }
            },
        };
    },
};
