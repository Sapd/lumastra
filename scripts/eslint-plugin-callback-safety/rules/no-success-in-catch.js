// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-success-in-catch (OPT-IN — registered but OFF by default)
 *
 * Catches the "false-success" bug class: a task (or any function) returns a
 * success-shaped result from *inside a catch block* — a swallowed failure
 * reported to the caller as success. This is the pattern behind the repeated
 * silent-data-staleness incidents (a stage/task threw, the catch reported
 * `{ success: true }`, the orchestrator marked the item done, and stale data
 * was never refreshed).
 *
 * Trigger (PRECISE — deliberately low false-positive):
 *   A `ReturnStatement` whose *nearest enclosing control construct is a
 *   `CatchClause`* (i.e. it returns FROM the catch, not from a nested
 *   function declared inside the catch), whose returned expression is — or
 *   directly contains, via a conditional/logical branch — an object literal
 *   with a `success: true` property where the value is the literal `true`
 *   (an `as const` assertion on `true` is unwrapped and still counts).
 *
 * NOT flagged (intentionally):
 *   - `return { success: false, ... }` in a catch (honest failure report)
 *   - `return { success: someVar }` / computed success (not a literal true)
 *   - `return { success }` shorthand (a variable, not a literal)
 *   - `throw` / re-throw in a catch (no return, so nothing to flag)
 *   - `{ success: true }` on the happy path / after a real success (not in a catch)
 *   - a `success: true` returned by a *nested* function declared inside the
 *     catch (that return exits the inner function, not the catch)
 *
 * The `itemsProcessed` / `result`-shaped success signals are intentionally
 * out of scope: those keys appear all over legitimate partial-result returns
 * and would blow up the false-positive rate. The literal `success: true` key
 * is the unambiguous marker of the bug class, so that is all this rule flags.
 *
 * Escape hatch (per occurrence), for a genuinely-safe catch that must report
 * success (rare — e.g. a catch that only handles an already-done / idempotent
 * "not an error" condition):
 *   // eslint-disable-next-line callback-safety/no-success-in-catch
 *
 * NOTE: This rule is OFF in the enforced eslint config on purpose — there are
 * pre-existing false-success sites across the codebase and the repo runs
 * `eslint --max-warnings=0`. See docs/dev/eslint-exceptions.md ("false-success
 * in catch") for the phased enable path.
 */

/**
 * Unwrap TS type assertions / non-null / await wrappers so we can see the
 * underlying expression (e.g. `true as const`, `(await x)`).
 * @param {import('estree').Node | null | undefined} node
 * @returns {import('estree').Node | null | undefined}
 */
function unwrap(node) {
    let cur = node;
    while (
        cur &&
        (cur.type === 'TSAsExpression' ||
            cur.type === 'TSSatisfiesExpression' ||
            cur.type === 'TSNonNullExpression')
    ) {
        cur = cur.expression;
    }
    return cur;
}

/**
 * @param {import('estree').Property | import('estree').SpreadElement} prop
 * @returns {string | null}
 */
function propKeyName(prop) {
    if (prop.type !== 'Property') return null;
    if (prop.computed) return null;
    if (prop.key.type === 'Identifier') return prop.key.name;
    if (prop.key.type === 'Literal') return String(prop.key.value);
    return null;
}

/**
 * Return the `success: true` Property node if this object literal has one
 * whose value is the literal `true` (unwrapping an `as const`). Otherwise null.
 * @param {import('estree').ObjectExpression} objExpr
 */
function successTrueProperty(objExpr) {
    for (const prop of objExpr.properties) {
        if (propKeyName(prop) !== 'success') continue;
        // prop is a Property (propKeyName returns null for SpreadElement)
        const value = unwrap(prop.value);
        if (value && value.type === 'Literal' && value.value === true) {
            return prop;
        }
    }
    return null;
}

/**
 * Search a returned expression for a `success: true` object literal. Bounded
 * traversal: we only descend through conditional / logical branches (the
 * common `return cond ? { success: true } : x` and `return x && { success:true }`
 * shapes). We do NOT deep-walk arbitrary call arguments — keeping the rule
 * precise and cheap.
 * @param {import('estree').Node | null | undefined} node
 * @param {number} depth
 */
function findSuccessTrue(node, depth) {
    if (!node || depth > 6) return null;
    const n = unwrap(node);
    if (!n) return null;
    if (n.type === 'ObjectExpression') {
        return successTrueProperty(n);
    }
    if (n.type === 'ConditionalExpression') {
        return findSuccessTrue(n.consequent, depth + 1) || findSuccessTrue(n.alternate, depth + 1);
    }
    if (n.type === 'LogicalExpression') {
        return findSuccessTrue(n.left, depth + 1) || findSuccessTrue(n.right, depth + 1);
    }
    return null;
}

const FUNCTION_TYPES = new Set([
    'FunctionDeclaration',
    'FunctionExpression',
    'ArrowFunctionExpression',
]);

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Disallow returning a `{ success: true }`-shaped result from inside a catch block (a swallowed failure reported as success)',
            category: 'Possible Errors',
            recommended: false,
        },
        schema: [],
        messages: {
            successInCatch:
                'Returning `{ success: true }` from a catch block reports a swallowed failure as success — this is the false-success bug class behind repeated silent-data-staleness incidents. Return an honest failure shape (e.g. `{ success: false, error }`) and let the caller decide, or re-throw. If this catch genuinely handles a non-error/idempotent condition, add `// eslint-disable-next-line callback-safety/no-success-in-catch` with a reason.',
        },
    },

    create(context) {
        return {
            ReturnStatement(node) {
                if (!node.argument) return;

                // Determine the nearest enclosing control construct: if we hit
                // a function boundary before a CatchClause, this return exits
                // that inner function (not the catch) — leave it alone.
                let cur = node.parent;
                let inCatch = false;
                while (cur) {
                    if (FUNCTION_TYPES.has(cur.type)) break;
                    if (cur.type === 'CatchClause') {
                        inCatch = true;
                        break;
                    }
                    cur = cur.parent;
                }
                if (!inCatch) return;

                const found = findSuccessTrue(node.argument, 0);
                if (found) {
                    context.report({ node: found, messageId: 'successInCatch' });
                }
            },
        };
    },
};
