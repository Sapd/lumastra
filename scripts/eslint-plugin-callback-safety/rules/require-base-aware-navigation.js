// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GUARD H — in-app navigation must go through a base-path-aware helper.
 *
 * A root-absolute literal like `href="/browse"` or `goto('/watch/1')` ignores
 * SvelteKit's configured `base` (`kit.paths.base` / `BASE_PATH`). On a subpath
 * install (`https://host/lumastra/`) it navigates to the HOST root instead of
 * into the app. `redirect(302, '/')` did exactly that at 47 call sites.
 *
 * ## Why not `svelte/no-navigation-without-resolve`?
 *
 * That rule exists and does this job — but it hardcodes `$app/paths` as the only
 * place `resolve` may be imported from, and this codebase deliberately imports
 * `resolve` from `$lib/paths` instead. That indirection is NOT stylistic: calling
 * SvelteKit's generic `resolve()` directly instantiates a ~9k-member union of
 * template-literal route types, which accounted for 71k of the 88k TS2859
 * "excessive complexity" errors when the app crossed tsgo's global budget (see
 * the header of src/lib/paths.ts and scripts/typecheck/README.md). Switching the
 * ~117 call sites to `$app/paths` to satisfy the upstream rule would reintroduce
 * that. So the upstream rule stays off and this one enforces the same invariant
 * against the wrappers this repo actually uses.
 *
 * ## What counts as base-aware
 *
 * A call to a helper IMPORTED from `$lib/paths`, `$lib/shared/api-urls` or
 * `$app/paths` — `resolve` / `resolveRoute` / `navigateTo` / `url` / `appPath` /
 * `apiUrl` / `entityImageUrl` / `buildImageRefs`.
 *
 * Provenance matters, not just the name: an earlier version matched on the
 * callee name alone, so a local `const resolve = (s: string) => s` silently
 * satisfied the rule. The local binding is now resolved back to its import, and
 * a same-named local that is NOT imported from one of those modules is treated
 * as unwrapped. `import { url as u }` is handled too — the alias is tracked, not
 * the exported name.
 *
 * @see src/lib/shared/api-urls.ts
 * @see src/lib/paths.ts
 * @see docs/dev/eslint-exceptions.md
 */

/** Helpers that apply the base path. A literal wrapped in one of these is fine. */
const BASE_AWARE = new Set([
    'resolve',
    'resolveRoute',
    'navigateTo',
    'url',
    'appPath',
    'apiUrl',
    'entityImageUrl',
    'buildImageRefs',
]);

/** Only these modules can supply a base-aware helper. */
const BASE_AWARE_SOURCES = new Set(['$lib/paths', '$lib/shared/api-urls', '$app/paths']);

/** Strip a `.js`/`.ts` suffix so `$lib/shared/api-urls.js` matches. */
function normaliseSource(value) {
    return String(value).replace(/\.(js|ts)$/, '');
}

/** Client-side navigation calls whose first argument is a destination. */
const NAV_CALLS = new Set(['goto', 'pushState', 'replaceState']);

/** Attributes whose value is a URL the browser will resolve against the origin. */
const URL_ATTRS = new Set(['href', 'src', 'action', 'poster', 'formaction']);

/**
 * Root-absolute in-app path. `//host/x` is protocol-relative (external) and
 * `/` alone is still in-app, so it is included.
 */
function isInAppAbsolute(text) {
    return typeof text === 'string' && text.startsWith('/') && !text.startsWith('//');
}

function preview(text) {
    const oneLine = String(text).replace(/\s+/g, ' ');
    return oneLine.length > 48 ? `${oneLine.slice(0, 45)}…` : oneLine;
}

/** Text of a Literal / TemplateLiteral's leading chunk, or null. */
function leadingText(node) {
    if (!node) return null;
    if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
    if (node.type === 'TemplateLiteral') return node.quasis[0]?.value?.raw ?? null;
    return null;
}

/**
 * Local names bound to a base-aware helper by an import in this file.
 * Keyed by LOCAL name so aliases (`import { url as u }`) are honoured.
 */
function collectBaseAwareLocals(programNode) {
    const locals = new Set();

    const visit = (statements) => {
        for (const stmt of statements ?? []) {
            // svelte-eslint-parser nests a component's imports inside a
            // SvelteScriptElement rather than putting them on Program.body, so a
            // Program-only walk finds nothing in a .svelte file and every
            // correctly-wrapped call reads as unwrapped. That produced 54 false
            // positives — all of them .svelte, none .ts — before this descent
            // was added. `<script>` and `<script module>` are both covered.
            if (stmt.type === 'SvelteScriptElement') {
                visit(stmt.body);
                continue;
            }
            if (stmt.type !== 'ImportDeclaration') continue;
            if (!BASE_AWARE_SOURCES.has(normaliseSource(stmt.source.value))) continue;
            for (const spec of stmt.specifiers) {
                if (spec.type === 'ImportSpecifier') {
                    const exported =
                        spec.imported.type === 'Identifier'
                            ? spec.imported.name
                            : spec.imported.value;
                    if (BASE_AWARE.has(exported)) locals.add(spec.local.name);
                } else if (spec.type === 'ImportNamespaceSpecifier') {
                    // `import * as paths from '$lib/paths'` → paths.url(…)
                    locals.add(`*${spec.local.name}`);
                }
            }
        }
    };

    visit(programNode.body);
    return locals;
}

/** True when `call` is a call to a helper imported from a base-aware module. */
function isBaseAwareCall(call, locals) {
    if (!call || call.type !== 'CallExpression') return false;
    const c = call.callee;
    if (c.type === 'Identifier') return locals.has(c.name);
    if (
        c.type === 'MemberExpression' &&
        c.object.type === 'Identifier' &&
        c.property.type === 'Identifier'
    ) {
        return locals.has(`*${c.object.name}`) && BASE_AWARE.has(c.property.name);
    }
    return false;
}

/**
 * The literal a navigation argument ultimately carries, or null when there is
 * nothing to judge.
 *
 * `goto('/x')`                  → the literal, unwrapped        → report
 * `goto(resolve('/x'))`         → base-aware wrapper            → null (fine)
 * `goto(notAHelper('/x'))`      → the INNER literal, unwrapped  → report
 * `goto(someVariable)`          → not a literal                 → null
 *
 * Descending into a non-base-aware wrapper is what closes the "local function
 * named `resolve`" hole: the wrapper's name no longer matters, only whether it
 * was imported from a module that actually applies the base path.
 */
function unwrappedLiteral(node, locals) {
    if (!node) return null;
    if (node.type === 'Literal' || node.type === 'TemplateLiteral') return leadingText(node);
    if (node.type === 'CallExpression') {
        if (isBaseAwareCall(node, locals)) return null;
        return unwrappedLiteral(node.arguments[0], locals);
    }
    return null;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Require in-app navigation targets to go through a base-path-aware helper so subpath installs work',
            category: 'Possible Errors',
            recommended: true,
        },
        schema: [],
        messages: {
            navCall:
                'Root-absolute "{{path}}" passed to {{fn}}() ignores the install base path — on a subpath install it navigates to the HOST root, not into the app. Wrap it: resolve(path) from `$lib/paths`, or appPath(path) from `$lib/shared/api-urls`.',
            navAttr:
                'Root-absolute "{{path}}" in {{attr}}= ignores the install base path — on a subpath install this points outside the app. Use {{attr}}={resolve(\'…\')} from `$lib/paths` (or apiUrl(…) for an API endpoint).',
        },
    },

    create(context) {
        // Svelte templates parse to a Program whose body carries the <script>
        // imports, so one collection pass covers .ts and .svelte alike.
        let locals = new Set();

        function reportCall(node, fn) {
            const text = unwrappedLiteral(node, locals);
            if (!isInAppAbsolute(text)) return;
            context.report({ node, messageId: 'navCall', data: { path: preview(text), fn } });
        }

        return {
            Program(node) {
                locals = collectBaseAwareLocals(node);
            },

            CallExpression(node) {
                const c = node.callee;
                const name =
                    c.type === 'Identifier'
                        ? c.name
                        : c.type === 'MemberExpression' && c.property.type === 'Identifier'
                          ? c.property.name
                          : null;
                if (!name) return;

                if (NAV_CALLS.has(name)) {
                    reportCall(node.arguments[0], name);
                    return;
                }
                // redirect(302, '/x') — the destination is the SECOND argument.
                if (name === 'redirect' && node.arguments.length >= 2) {
                    reportCall(node.arguments[1], 'redirect');
                }
            },

            // Svelte template attributes: href="/browse", src="/x".
            // svelte-eslint-parser gives a SvelteLiteral for static text and a
            // SvelteMustacheTag for `{...}`; only the static form can be a bare
            // root-absolute literal.
            SvelteAttribute(node) {
                const attr = node.key?.name;
                if (!URL_ATTRS.has(attr)) return;
                const first = node.value?.[0];
                if (!first || first.type !== 'SvelteLiteral') return;
                if (!isInAppAbsolute(first.value)) return;
                context.report({
                    node: first,
                    messageId: 'navAttr',
                    data: { path: preview(first.value), attr },
                });
            },
        };
    },
};
