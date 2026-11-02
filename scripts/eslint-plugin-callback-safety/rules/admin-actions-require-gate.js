// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: admin-actions-require-gate
 *
 * Every form action exported from a `+page.server.ts` under `src/routes/admin/`
 * must gate on the caller being an admin as its FIRST statement.
 *
 * ## Why this rule exists (security review 2026-09-12, findings C4/C5)
 *
 * The /admin layout refuses non-admins in its `load`. SvelteKit runs a page's
 * form ACTION before any load, so that gate never applied to
 * `POST /admin/settings?/save` — any authenticated user could write any config
 * key: `ADMIN_GROUPS` (self-promotion) or `APPEARANCE_CUSTOM_JS` (stored XSS in
 * every admin's browser). Twelve pages had the hole; none of their authors did
 * anything unusual — they trusted the layout, which is the natural assumption
 * and the wrong one. A rule, not a review note, because the next admin page
 * will be written with the same assumption.
 *
 * ## What is accepted
 *
 * For every property of `export const actions = { ... }` (also `satisfies`
 * / `as` wrapped) whose value is a function:
 *   - a block body that starts `const denied = denyUnlessAdmin(locals);` directly
 *     followed by `if (denied) return denied;` (the call alone sends nothing), or
 *   - a block body whose first statement is a NEGATED admin verdict check that
 *     returns or throws, `if (!localsIsAdmin(locals)) return fail(403, …);`
 *     (a positive `if (localsIsAdmin(locals)) { … }` is not a gate), or
 *   - an expression body / first `return` that calls one of the gated helpers
 *     (`saveSettingsAction`, `reloadSettingsAction`), which gate internally.
 * Pages that re-export `actions` from `createSettingsPageServer(...)` have no
 * object literal and are not in scope (the factory gates).
 *
 * The runtime twin of this rule is `src/routes/admin/admin-actions-require-admin.test.ts`,
 * which walks every admin page and calls every action as a plain user.
 */

const GATE_CALLEES = new Set(['denyUnlessAdmin']);
const GATED_HELPERS = new Set(['saveSettingsAction', 'reloadSettingsAction']);

function calleeName(node) {
    if (!node || node.type !== 'CallExpression') return null;
    const c = node.callee;
    if (c.type === 'Identifier') return c.name;
    if (c.type === 'MemberExpression' && c.property.type === 'Identifier') return c.property.name;
    return null;
}

function unwrapAwait(node) {
    return node && node.type === 'AwaitExpression' ? node.argument : node;
}

function returnsInside(node) {
    if (!node) return false;
    if (node.type === 'ReturnStatement' || node.type === 'ThrowStatement') return true;
    if (node.type === 'BlockStatement') return node.body.some(returnsInside);
    return false;
}

/** `localsIsAdmin(locals)` / `localsIsAdmin(event.locals)` (optionally awaited). */
function isVerdictCall(node) {
    const n = unwrapAwait(node);
    if (!n || n.type !== 'CallExpression' || calleeName(n) !== 'localsIsAdmin') return false;
    const arg = n.arguments[0];
    if (!arg) return false;
    if (arg.type === 'Identifier') return arg.name === 'locals';
    return (
        arg.type === 'MemberExpression' &&
        arg.property.type === 'Identifier' &&
        arg.property.name === 'locals'
    );
}

/**
 * A NEGATED verdict on THIS request: `!localsIsAdmin(locals)`,
 * `localsIsAdmin(locals) === false` / `!== true`, or one disjunct of
 * `a || !localsIsAdmin(locals)`. A positive check (`if (localsIsAdmin(locals))
 * { …do it… }`), a double negation, or an `.isAdmin` read on some other object
 * (`if (!target.isAdmin)`) is not a gate.
 */
function isNegatedAdminCheck(node) {
    if (!node) return false;
    if (node.type === 'LogicalExpression' && node.operator === '||') {
        return isNegatedAdminCheck(node.left) || isNegatedAdminCheck(node.right);
    }
    if (node.type === 'UnaryExpression' && node.operator === '!') {
        return isVerdictCall(node.argument);
    }
    if (node.type === 'BinaryExpression') {
        const negated = (a, b) =>
            isVerdictCall(a) &&
            b.type === 'Literal' &&
            ((node.operator === '!==' && b.value === true) ||
                (node.operator === '===' && b.value === false));
        return negated(node.left, node.right) || negated(node.right, node.left);
    }
    return false;
}

/** Does this branch return the named variable (`return denied`)? */
function returnsIdentifier(node, name) {
    if (!node) return false;
    if (node.type === 'ReturnStatement') {
        return (
            !!node.argument && node.argument.type === 'Identifier' && node.argument.name === name
        );
    }
    if (node.type === 'BlockStatement') return node.body.some((s) => returnsIdentifier(s, name));
    return false;
}

/** `if (denied) return denied;` for the variable a denyUnlessAdmin() call was stored in. */
function returnsWhenSet(stmt, name) {
    return (
        !!stmt &&
        stmt.type === 'IfStatement' &&
        stmt.test.type === 'Identifier' &&
        stmt.test.name === name &&
        returnsIdentifier(stmt.consequent, name)
    );
}

function isGatedBlock(body) {
    const [first, second] = body;
    if (!first) return false;
    // Inline form: `if (!localsIsAdmin(locals)) return fail(403, …);`
    if (first.type === 'IfStatement') {
        return isNegatedAdminCheck(first.test) && returnsInside(first.consequent);
    }
    // `const denied = denyUnlessAdmin(locals); if (denied) return denied;` — the
    // call alone returns the 403 and nothing sends it.
    if (first.type === 'VariableDeclaration') {
        return first.declarations.some(
            (d) =>
                GATE_CALLEES.has(calleeName(unwrapAwait(d.init))) &&
                d.id.type === 'Identifier' &&
                returnsWhenSet(second, d.id.name),
        );
    }
    if (first.type === 'ReturnStatement') {
        return GATED_HELPERS.has(calleeName(unwrapAwait(first.argument)));
    }
    return false;
}

function isGatedFunction(fn) {
    if (fn.body.type !== 'BlockStatement') {
        return GATED_HELPERS.has(calleeName(unwrapAwait(fn.body)));
    }
    return isGatedBlock(fn.body.body);
}

function unwrapTypeWrappers(node) {
    let n = node;
    while (n && (n.type === 'TSSatisfiesExpression' || n.type === 'TSAsExpression'))
        n = n.expression;
    return n;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'form actions under src/routes/admin must gate on the admin verdict as their first statement (layout loads do not protect actions)',
            recommended: true,
        },
        schema: [],
        messages: {
            ungated:
                "Admin action '{{name}}' does not gate on the caller: start it with `const denied = denyUnlessAdmin(locals); if (denied) return denied;` (or return saveSettingsAction/reloadSettingsAction directly). The /admin layout load does NOT run before form actions.",
        },
    },
    create(context) {
        const filename = String(context.filename ?? context.getFilename?.() ?? '').replace(
            /\\/g,
            '/',
        );
        if (!/\/src\/routes\/admin\/.*\+page\.server\.ts$/.test(filename)) return {};
        return {
            ExportNamedDeclaration(node) {
                const decl = node.declaration;
                if (!decl || decl.type !== 'VariableDeclaration') return;
                for (const d of decl.declarations) {
                    if (d.id.type !== 'Identifier' || d.id.name !== 'actions') continue;
                    const obj = unwrapTypeWrappers(d.init);
                    if (!obj || obj.type !== 'ObjectExpression') continue;
                    for (const prop of obj.properties) {
                        if (prop.type !== 'Property') continue;
                        const fn = prop.value;
                        if (
                            fn.type !== 'ArrowFunctionExpression' &&
                            fn.type !== 'FunctionExpression'
                        )
                            continue;
                        if (isGatedFunction(fn)) continue;
                        const name =
                            prop.key.type === 'Identifier' ? prop.key.name : String(prop.key.value);
                        context.report({ node: prop, messageId: 'ungated', data: { name } });
                    }
                }
            },
        };
    },
};
