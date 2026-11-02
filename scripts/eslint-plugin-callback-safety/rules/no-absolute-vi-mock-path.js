// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-absolute-vi-mock-path
 *
 * `vi.mock()` matches on the RESOLVED module id. An absolute filesystem path only
 * resolves to that id on the one machine whose filesystem it describes; anywhere else
 * it matches nothing, the mock silently does not apply, and the REAL module loads.
 *
 * ## Why this rule exists (measured 2026-08-28)
 *
 * `main`'s blocking unit suite was red for hours with 72 failures, all reading
 * `AI database not configured - transcode persistence requires DATABASE_URL`. The
 * cause was not the env var. Three transcode suites registered **52** `vi.mock()`
 * calls under absolute paths beginning `/Users/someone/Documents/GitHub/...`. On the
 * Linux CI runner none of them could match, so the real persistence service, file
 * manager, process runner and database connection loaded instead of the doubles.
 *
 * What makes this bug class worth a lint rule rather than a code review note is that
 * it is INVISIBLE FROM BOTH SIDES. On the authoring machine every path matches and
 * every mock applies, so the suite is green and nothing looks wrong. In CI the mocks
 * are absent and the failure surfaces somewhere unrelated — a missing env var, a
 * connection error, a timeout — pointing nowhere near the specifier that caused it.
 * "Passes locally, fails in CI, for reasons that name a different subsystem" is
 * exactly the shape that costs hours.
 *
 * ## What is flagged
 *
 * The module specifier of `vi.mock` / `vi.doMock` / `vi.unmock` / `vi.doUnmock` when
 * it is a static string that cannot be portable:
 *
 *   - a POSIX absolute path (`/Users/...`, `/home/...`)
 *   - a Windows path (`C:\...`, `C:/...`)
 *   - a `file://` URL
 *
 * and the same specifier when it is built from `__dirname`, `__filename`, or a
 * `path.resolve()` / `path.join()` call — those produce an absolute path at runtime
 * and fail the same way, just without a literal to grep for.
 *
 * ## What to write instead
 *
 * This repo's convention is an alias specifier with a `.js` extension
 * (`vi.mock('$lib/server/config.js', ...)`, `vi.mock('$app/environment', ...)`), and
 * a relative specifier only when mocking a sibling (`vi.mock('./client.js', ...)`).
 * Both resolve identically on every machine.
 *
 * @see src/hooks.server.test.ts for the alias style
 * @see src/lib/api/audiobooks.test.ts for the sibling-relative style
 */

/** POSIX absolute: `/Users/...`, `/home/...`. A bare `/` is not a valid specifier either. */
const POSIX_ABSOLUTE = /^\//;

/** Windows drive-qualified: `C:\Users\...` or `C:/Users/...`. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** A `file://` URL — portable in spelling, machine-specific in what it names. */
const FILE_URL = /^file:\/\//i;

/** The mocking entry points that take a module specifier as their first argument. */
const MOCK_CALLEES = new Set(['mock', 'doMock', 'unmock', 'doUnmock']);

/** Node helpers that yield an absolute path when used to build a specifier. */
const PATH_BUILDERS = new Set(['resolve', 'join']);

function staticStringValue(node) {
    if (!node) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    // A template literal with no interpolation is just a string spelled differently.
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis.map((q) => q.value.cooked).join('');
    }
    return null;
}

function isAbsoluteSpecifier(value) {
    return POSIX_ABSOLUTE.test(value) || WINDOWS_ABSOLUTE.test(value) || FILE_URL.test(value);
}

/**
 * True when the expression is `__dirname` / `__filename`, or a `path.resolve(...)` /
 * `path.join(...)` (however `path` was imported), or contains one — a specifier built
 * this way is absolute at runtime even though no literal shows it.
 */
function buildsAbsolutePath(node, depth = 0) {
    if (!node || depth > 4) return false;

    if (node.type === 'Identifier') {
        return node.name === '__dirname' || node.name === '__filename';
    }

    if (node.type === 'CallExpression') {
        const callee = node.callee;
        if (
            callee.type === 'MemberExpression' &&
            !callee.computed &&
            callee.property.type === 'Identifier' &&
            PATH_BUILDERS.has(callee.property.name)
        ) {
            return true;
        }
        return node.arguments.some((arg) => buildsAbsolutePath(arg, depth + 1));
    }

    if (node.type === 'TemplateLiteral') {
        return node.expressions.some((expr) => buildsAbsolutePath(expr, depth + 1));
    }

    if (node.type === 'BinaryExpression' && node.operator === '+') {
        return (
            buildsAbsolutePath(node.left, depth + 1) || buildsAbsolutePath(node.right, depth + 1)
        );
    }

    return false;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'vi.mock() specifiers must be portable (alias or sibling-relative); an absolute filesystem path silently fails to match on any other machine',
            category: 'Possible Errors',
            recommended: true,
        },
        schema: [],
        messages: {
            absoluteLiteral:
                "`{{callee}}()` specifier '{{specifier}}' is an absolute filesystem path. It only resolves on the machine that path describes — everywhere else (CI included) the mock silently does not apply and the REAL module loads, so the suite passes here and fails there with an error naming an unrelated subsystem. Use an alias specifier ('$lib/…', '$app/…', with a .js extension) or a sibling-relative one ('./x.js').",
            computedAbsolute:
                '`{{callee}}()` builds its specifier from __dirname/__filename or path.resolve/join, which produces an absolute path at runtime. That matches only on this machine; in CI the mock is silently skipped and the real module loads. Use a static alias or sibling-relative specifier instead.',
        },
    },

    create(context) {
        return {
            CallExpression(node) {
                const callee = node.callee;
                if (
                    callee.type !== 'MemberExpression' ||
                    callee.computed ||
                    callee.object.type !== 'Identifier' ||
                    callee.object.name !== 'vi' ||
                    callee.property.type !== 'Identifier' ||
                    !MOCK_CALLEES.has(callee.property.name)
                ) {
                    return;
                }

                const spec = node.arguments[0];
                if (!spec) return;

                const calleeName = `vi.${callee.property.name}`;
                const value = staticStringValue(spec);

                if (value !== null) {
                    if (isAbsoluteSpecifier(value)) {
                        context.report({
                            node: spec,
                            messageId: 'absoluteLiteral',
                            data: { callee: calleeName, specifier: value },
                        });
                    }
                    return;
                }

                if (buildsAbsolutePath(spec)) {
                    context.report({
                        node: spec,
                        messageId: 'computedAbsolute',
                        data: { callee: calleeName },
                    });
                }
            },
        };
    },
};
