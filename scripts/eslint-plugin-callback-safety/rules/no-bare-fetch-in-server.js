// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-bare-fetch-in-server
 *
 * C22 fix-plan finding: a bare `fetch()` call follows an arbitrary redirect
 * by default. Twelve credentialed or admin-configured outbound call sites in
 * `src/lib/server/**` used bare `fetch()` instead of the shared, guarded
 * `fetchWithTimeout` (`utils/fetch-utils.ts` / `utils/fetch-timeout.ts`) —
 * this rule is the backstop against a THIRTEENTH one appearing the same way
 * the finding's "latent" item did (an editor auto-import completing
 * `fetchWithTimeout` from the wrong, unguarded module).
 *
 * What is flagged: a CALL to the global `fetch` — i.e. an unresolved
 * identifier reference named `fetch` used as a call expression — anywhere
 * under `src/lib/server/**`. Deliberately scope-aware rather than a text
 * match on `fetch(`: several files bind a LOCAL variable/parameter/import
 * named `fetch` that has nothing to do with the global (e.g.
 * `defs/recommendations/feed-watching-section.ts`'s
 * `fetchExactWatchingCandidates(fetch: (limit) => ..., ...)`, and the
 * `RecommenderStrategy.fetch()` interface method every strategy file
 * implements) — those must never be flagged, since they're not global-fetch
 * call sites the guard could apply to. A `MemberExpression` callee
 * (`ctx.dep('x').fetch(...)`, `strategy.fetch(...)`) is never flagged
 * either, for the same reason: it isn't a call to the global.
 *
 * Not flagged: `.test.ts` / `.integration.test.ts` files — test doubles and
 * harnesses legitimately reference `fetch` directly (`vi.stubGlobal('fetch',
 * ...)`, local mock servers, etc.), and the invariant this rule protects is
 * about production outbound calls, not test scaffolding.
 *
 * Exempt files: the guard modules themselves, which must call the real
 * global `fetch` to implement the guard in the first place.
 *
 * Every other pre-existing bare-fetch call site in `src/lib/server/**` that
 * is NOT one of the twelve C22 sites falls into one of two buckets, and each
 * one carries its own `eslint-disable-next-line` + reason (see
 * `docs/dev/eslint-exceptions.md` for the indexed list):
 *   1. Already redirect-guarded by a DIFFERENT, established mechanism —
 *      `tasks/url-safety.ts`'s `safeFetch` or the `resolveSafePublicUrl` +
 *      `buildPinnedFetch` per-hop DNS-pinning pattern (`utils/ssrf-guard.ts`)
 *      — the public-only guard for arbitrary/user-supplied targets, a
 *      different invariant than the same-origin-only guard C22 is about.
 *   2. A fixed, non-admin-configurable public host with no redirect-pivot
 *      value (api.themoviedb.org, gravatar.com, the hardcoded Lumastra
 *      license server) — out of C22's "admin-configured or credentialed"
 *      scope, OR a known, tracked gap flagged as a C22 sibling rather than
 *      fixed in this task (see the eslint-exceptions.md entry for exactly
 *      which sites are gaps vs. already-safe).
 */

const EXEMPT_FILES = [
    /(^|\/)src\/lib\/server\/utils\/fetch-utils\.ts$/,
    /(^|\/)src\/lib\/server\/utils\/fetch-timeout\.ts$/,
    /(^|\/)src\/lib\/server\/tasks\/url-safety\.ts$/,
];

const TEST_FILE = /\.(test|integration\.test)\.ts$/;

function isExempt(filename) {
    const normalized = String(filename).replace(/\\/g, '/');
    if (TEST_FILE.test(normalized)) return true;
    return EXEMPT_FILES.some((re) => re.test(normalized));
}

/** True if `fetch` resolves to a user-declared variable/param/import anywhere in the enclosing scope chain (i.e. NOT the global). */
function resolvesToLocalBinding(node, context) {
    let scope = context.sourceCode.getScope(node);
    while (scope) {
        if (scope.variables.some((v) => v.name === 'fetch' && v.defs.length > 0)) {
            return true;
        }
        scope = scope.upper;
    }
    return false;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Forbid a bare call to the global fetch() in src/lib/server/** — route credentialed/admin-configured outbound calls through fetchWithTimeout (or an established SSRF guard) instead',
            category: 'Possible Errors',
            recommended: true,
        },
        schema: [],
        messages: {
            bareFetch:
                "Bare fetch() call in src/lib/server/**. Credentialed or admin-configured outbound calls must go through fetchWithTimeout ('$lib/server/utils/fetch-utils.js' or 'fetch-timeout.js'), which refuses a cross-origin redirect (C22 fix-plan finding). If this call is already covered by a different guard (safeFetch / resolveSafePublicUrl+buildPinnedFetch) or targets a fixed non-admin-configurable public host, add `// eslint-disable-next-line callback-safety/no-bare-fetch-in-server -- <reason>` and record it in docs/dev/eslint-exceptions.md.",
        },
    },

    create(context) {
        const filename = context.filename ?? context.getFilename();
        if (isExempt(filename)) return {};

        return {
            CallExpression(node) {
                if (node.callee.type !== 'Identifier' || node.callee.name !== 'fetch') return;
                if (resolvesToLocalBinding(node, context)) return;
                context.report({ node, messageId: 'bareFetch' });
            },
        };
    },
};
