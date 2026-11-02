// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-app-paths-resolve
 *
 * `resolve()` from `$app/paths` is generic over
 * `RouteIdWithSearchOrHash | PathnameWithSearchOrHash` — every route id AND every
 * pathname, each ×3 for the `?search`/`#hash` variants. At this app's route count
 * that constraint is a ~9k-member union of template-literal types, and inferring it
 * (especially for a *dynamic* string) is astronomically expensive.
 *
 * `src/lib/paths.ts` exists precisely to contain that cost: it narrows the signature
 * once (`resolve as unknown as (path: string) => string`) and re-exports the wrapper
 * as `resolve`. Every other module must import from `$lib/paths`.
 *
 * ## Why this rule exists (measured 2026-07-30)
 *
 * Six modules imported `resolve` straight from `$app/paths`, three of them calling it
 * with a template literal (`resolve(`/watch/${channel.id}`)`). That was enough to blow
 * TypeScript's global type-relation budget: a whole-project `svelte-check` produced
 * **29,153 errors — 25,773 of them "Excessive complexity comparing types"** — plus 24
 * internal `Debug Failure` assertions and a `RangeError: Maximum call stack size
 * exceeded`, and never reached a summary. Swapping those six imports to `$lib/paths`
 * brought the same run to **122 errors, 0 complexity, 1m49s**. One straggler is enough
 * to reintroduce the blowup, and the symptom (thousands of errors in unrelated files)
 * points nowhere near the cause — hence a lint rule rather than a code comment.
 *
 * ## What is flagged
 *
 * A named import of `resolve` from `$app/paths` (aliases included:
 * `import { resolve as r }`), and a namespace import used as `paths.resolve(...)`,
 * in any file other than the wrapper itself.
 *
 * Deliberately NOT flagged: `base` and `assets` from `$app/paths` — those are plain
 * strings with no generic instantiation, and ~23 modules import them legitimately.
 *
 * @see src/lib/paths.ts
 * @see scripts/typecheck/README.md
 * @see docs/dev/eslint-exceptions.md
 */

/** The one module allowed to import the expensive generic and narrow it. */
const WRAPPER_MODULE = /(^|\/)src\/lib\/paths\.ts$/;

/** `$app/paths`, tolerating a `.js`/`.ts` suffix. */
const APP_PATHS_SOURCE = /^\$app\/paths(\.(js|ts))?$/;

/** The single expensive export. `base` / `assets` are cheap and must stay allowed. */
const EXPENSIVE_EXPORT = 'resolve';

function isWrapper(filename) {
    return WRAPPER_MODULE.test(String(filename).replace(/\\/g, '/'));
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Only src/lib/paths.ts may import resolve() from $app/paths; everything else must use the narrowed $lib/paths wrapper',
            category: 'Possible Errors',
            recommended: true,
        },
        fixable: 'code',
        schema: [],
        messages: {
            directResolve:
                "Import `resolve` from '$lib/paths', not '$app/paths'. The $app/paths signature is generic over a ~9k-member union of every route id and pathname; instantiating it here blows TypeScript's global type-relation budget and floods svelte-check with thousands of \"Excessive complexity\" errors in unrelated files. `$lib/paths` re-exports a narrowed wrapper that is identical at runtime.",
            namespaceResolve:
                "`{{name}}.resolve()` reaches the generic $app/paths signature. Import { resolve } from '$lib/paths' instead — see src/lib/paths.ts for why the narrowed wrapper exists.",
        },
    },

    create(context) {
        const filename = context.filename ?? context.getFilename();
        if (isWrapper(filename)) return {};

        /** Local names bound to a `import * as X from '$app/paths'`. */
        const namespaceLocals = new Set();

        return {
            ImportDeclaration(node) {
                if (!APP_PATHS_SOURCE.test(String(node.source.value))) return;

                for (const spec of node.specifiers) {
                    if (spec.type === 'ImportNamespaceSpecifier') {
                        namespaceLocals.add(spec.local.name);
                        continue;
                    }
                    if (spec.type !== 'ImportSpecifier') continue;
                    const imported =
                        spec.imported.type === 'Identifier'
                            ? spec.imported.name
                            : spec.imported.value;
                    if (imported !== EXPENSIVE_EXPORT) continue;

                    context.report({
                        node: spec,
                        messageId: 'directResolve',
                        // Only auto-fix the unambiguous shape: `resolve` is the sole
                        // specifier, so the whole declaration can be repointed. A mixed
                        // `{ base, resolve }` import needs a human to split it.
                        fix:
                            node.specifiers.length === 1
                                ? (fixer) =>
                                      fixer.replaceText(
                                          node.source,
                                          context.sourceCode
                                              .getText(node.source)
                                              .replace('$app/paths', '$lib/paths'),
                                      )
                                : null,
                    });
                }
            },

            MemberExpression(node) {
                if (
                    node.computed ||
                    node.object.type !== 'Identifier' ||
                    !namespaceLocals.has(node.object.name) ||
                    node.property.type !== 'Identifier' ||
                    node.property.name !== EXPENSIVE_EXPORT
                ) {
                    return;
                }
                context.report({
                    node,
                    messageId: 'namespaceResolve',
                    data: { name: node.object.name },
                });
            },
        };
    },
};
