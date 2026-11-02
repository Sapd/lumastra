// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint rule: require-route-authz
 *
 * Closes the "forgotten guard" class. Historically the whole `/api/*` surface
 * sat behind a forward-auth reverse proxy, so authorization was opt-in and a
 * route that forgot its guard was still shielded by the proxy. Now that native
 * login + OIDC make the app directly reachable, every `/api/*` route is hit by
 * any authenticated (possibly low-privilege) user, so a route with NO
 * authorization decision is a silent exposure.
 *
 * This rule requires every `+server.ts` under `src/routes/api/**` that exports
 * an HTTP handler to EITHER reference a recognized authorization primitive OR
 * carry an explicit `// authz: <label> — <reason>` annotation declaring the
 * route's policy on purpose. It is a commit-time net, NOT a correctness proof:
 * it verifies that SOME authz decision exists, not that it is the right one
 * (that is what code review / the security audit are for). Choosing the wrong
 * guard (e.g. requireWatchPermissions where requireAdmin is needed) still
 * passes — but a route reachable by anyone with zero thought does not.
 *
 * Greppable inventory: `grep -rn "authz: public" src/routes/api` enumerates the
 * intentionally-unguarded surface for security review.
 *
 * NOT in scope (different auth systems / not under /api): `/routes/j/*`
 * (Jellyfin compat, self-authenticating via withJellyfinAuth), `/routes/subsonic/*`
 * (Subsonic credentials), `/routes/oauth/*` (device flow). Re-export shim files
 * (`export { GET } from '...'`) are skipped — the target module is linted.
 */

// Recognized authorization primitives. Presence of any of these tokens in the
// file source means the route makes an authorization (or at least identity)
// decision. Keep in sync with src/lib/server/middleware/auth.ts,
// src/lib/server/tasks/api-auth.ts, playlist-utils, media-access, and the
// route factories.
const AUTHZ_TOKENS = [
    // Session / forward-auth wrappers (middleware/auth.ts)
    'requireAdmin',
    'requireAuth',
    'requireSelfOrAdmin',
    'requireWatchPermissions',
    'requireGroups',
    'optionalAuth',
    'withAdminAuth',
    'withMiddleware',
    // Media access gates (middleware/media-access.ts, library-access.ts)
    'withMediaAccess',
    'withAgeGate',
    'withLibraryAccess',
    'checkMediaAccess',
    // Token / scope auth for /api/v1 task-ops (tasks/api-auth.ts)
    'authenticate(',
    'requireScope',
    // Subsonic credential validation
    'parseSubsonicAuth',
    // Jellyfin compat auth
    'withJellyfinAuth',
    // Playlist role gates (playlist-utils)
    'getUserRole',
    'getPlaylistContext',
    'getPlaylistItemContext',
    // Mutation resolve+gate
    'resolveAndGate',
    // Signed-URL (HMAC) — the signature is the authorization
    'verifySignedUrl',
    // mount.ts enforce() — the /api/v1 auth chokepoint (maps AuthSpec to primitives)
    'enforce(',
    // Route factories that embed their own auth
    'createCrudEndpoints',
    'createPreferenceHandlers',
    'createMusicStreamHandlers',
    'proxySection',
    'widgetGuard',
    // Inline identity decision — the handler reads the server-derived identity.
    // Coarse on purpose: a route that reads locals.user is at least
    // identity-aware. Correctness of the subsequent check is a review concern.
    'locals.user',
    'locals.session',
];

// The admin verdict (auth/locals-admin.ts) counts only as a GUARD: an `if`
// whose test is `!localsIsAdmin(…)` (alone or one disjunct of `||`) and whose
// branch returns or throws. Computing it for an option is no authorization.
function isNegatedVerdict(node) {
    if (!node) return false;
    if (node.type === 'LogicalExpression' && node.operator === '||') {
        return isNegatedVerdict(node.left) || isNegatedVerdict(node.right);
    }
    if (node.type !== 'UnaryExpression' || node.operator !== '!') return false;
    const arg = node.argument;
    return (
        arg.type === 'CallExpression' &&
        arg.callee.type === 'Identifier' &&
        arg.callee.name === 'localsIsAdmin'
    );
}

function exitsBranch(node) {
    if (!node) return false;
    if (node.type === 'ReturnStatement' || node.type === 'ThrowStatement') return true;
    if (node.type === 'BlockStatement') return node.body.some(exitsBranch);
    return false;
}

// Matches a `// authz: <label> — <reason>` (or `authz: public`) escape comment.
// Requires at least a label after `authz:` so a bare `// authz:` doesn't pass.
const AUTHZ_ANNOTATION = /\bauthz:\s*\S+/i;

// HTTP method export with a handler body (NOT a re-export).
const HANDLER_EXPORT =
    /export\s+(?:const|async\s+function|function)\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/;

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Every /api route handler must reference an authorization primitive or carry an explicit `// authz:` annotation',
            category: 'Security',
        },
        messages: {
            missingAuthz:
                'Route handler has no authorization decision. Add an authz primitive (requireAuth/requireAdmin/checkMediaAccess/getPlaylistContext/authenticate(...)/etc.) OR, if the route is intentionally reachable without one, an explicit `// authz: <label> — <reason>` comment (e.g. `// authz: public — native login, must be reachable pre-auth`). This is a commit-time net for the forgotten-guard class, not a correctness check.',
        },
        schema: [],
    },
    create(context) {
        const filename = context.filename.replace(/\\/g, '/');

        // Only +server route files under the /api surface.
        if (!/\/src\/routes\/api\//.test(filename)) return {};
        if (!/\/\+server\.(ts|js)$/.test(filename)) return {};

        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const text = sourceCode.getText();

        // No handler body in this file (pure re-export shim, or types only) →
        // nothing to guard here; the target module is linted on its own.
        if (!HANDLER_EXPORT.test(text)) return {};

        // Verdict guards and the exported handlers, by source range: a guard
        // covers only the handler it sits in, so a guarded GET does not let an
        // unguarded POST in the same file through.
        const guards = [];
        const handlers = [];
        // Only trust the auth chokepoint imported from our API module. A rate
        // limiter alone (or an unrelated function named mount) is not authz.
        const mountImports = new Set();
        const rateLimitImports = new Set();
        const unwrap = (n) => (n?.type === 'TSNonNullExpression' ? unwrap(n.expression) : n);
        const isMountedHandler = (expression) => {
            const n = unwrap(expression);
            if (!n) return false;
            if (
                n.type === 'CallExpression' &&
                n.callee.type === 'Identifier' &&
                rateLimitImports.has(n.callee.name)
            ) {
                return isMountedHandler(n.arguments[0]);
            }
            if (
                n.type !== 'MemberExpression' ||
                n.computed ||
                n.property.type !== 'Identifier' ||
                !METHOD.test(n.property.name)
            ) return false;
            const call = n.object;
            return (
                call.type === 'CallExpression' &&
                call.callee.type === 'Identifier' &&
                mountImports.has(call.callee.name)
            );
        };
        const METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;
        return {
            ImportDeclaration(node) {
                for (const spec of node.specifiers) {
                    if (
                        spec.type !== 'ImportSpecifier' ||
                        spec.importKind === 'type' ||
                        node.importKind === 'type'
                    ) continue;
                    if (
                        node.source.value === '$lib/server/api/mount.js' &&
                        spec.imported.name === 'mount'
                    ) mountImports.add(spec.local.name);
                    if (
                        node.source.value === '$lib/server/middleware/valkey-rate-limit.js' &&
                        spec.imported.name === 'withAISuggestionRateLimit'
                    ) {
                        rateLimitImports.add(spec.local.name);
                    }
                }
            },
            IfStatement(node) {
                if (isNegatedVerdict(node.test) && exitsBranch(node.consequent)) {
                    guards.push(node.range);
                }
            },
            ExportNamedDeclaration(node) {
                const decl = node.declaration;
                if (!decl) return;
                if (decl.type === 'FunctionDeclaration' && decl.id && METHOD.test(decl.id.name)) {
                    handlers.push(decl);
                }
                if (decl.type === 'VariableDeclaration') {
                    for (const d of decl.declarations) {
                        if (d.id.type === 'Identifier' && METHOD.test(d.id.name) && d.init) {
                            handlers.push(d);
                        }
                    }
                }
            },
            'Program:exit'(node) {
                const covered = (h) =>
                    isMountedHandler(h.init) ||
                    guards.some(([start, end]) => start >= h.range[0] && end <= h.range[1]);
                if (handlers.length > 0 && handlers.every(covered)) return;
                // An explicit authz annotation anywhere in the file is the escape hatch.
                const hasAnnotation = sourceCode
                    .getAllComments()
                    .some((c) => AUTHZ_ANNOTATION.test(c.value));
                if (hasAnnotation) return;

                // Any recognized authorization primitive present?
                const hasAuthzToken = AUTHZ_TOKENS.some((tok) => text.includes(tok));
                if (hasAuthzToken) return;

                context.report({ node, messageId: 'missingAuthz' });
            },
        };
    },
};
