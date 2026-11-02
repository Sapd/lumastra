// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-unrestricted-access-outside-allowlist
 *
 * Flags a deliberate media-access bypass — `unrestrictedAccess()` (or a bare
 * `UNRESTRICTED` constant) — in a server file that is NOT on the allowlist of
 * admin / scanner / compat / cache-warming paths where reading the full catalog
 * is legitimate by policy.
 *
 * ## Why this rule exists
 *
 * The required-by-shape `MediaAccessBoundary` migration made every unfiltered
 * read GREPPABLE: an unfiltered query must now spell out `unrestrictedAccess()`
 * rather than silently omit an optional `deniedGroupIds`/`ageRating` argument.
 * `no-unscoped-media-items` proves an access marker is PRESENT; it cannot tell
 * that the marker chosen is the fail-open one. This rule closes that gap: it
 * makes every deliberate fail-open visible in review instead of invisible by
 * omission, which is exactly the drive-by-contributor scenario the enforcement
 * layer of the spec was meant to catch.
 *
 * The rule is intentionally file-scoped (same trade-off as
 * `no-unscoped-media-items`): a NEW file that reaches for `unrestrictedAccess()`
 * is flagged, and must either land the file on the allowlist below (a reviewable
 * diff to this rule) or acknowledge the bypass with an inline
 * `// eslint-disable-next-line` at the call site. Both make the decision visible.
 */

// Only server code can hold an access boundary; client code never does.
const APPLICABLE_PATH_FRAGMENTS = ['/src/routes/', '/src/lib/server/'];

// Paths where an unrestricted read is legitimate by policy:
//   - admin surfaces (an admin may read every row by design),
//   - the /j + /subsonic compat surfaces (bypass the central gate by design —
//     see docs/architecture/jellyfin-compat-security.md),
//   - assistant tools (run with the caller's own already-gated context),
//   - cache warming + background engines that materialise the full catalog,
//   - the boundary module itself and demo/seed endpoints,
//   - tests + migrations.
//
// The trailing block lists the specific user-facing files that already held a
// pre-boundary unrestricted read (audited during the required-by-shape
// migration). Those reads pre-date this rule; changing which rows they return
// is out of scope (the migration must not change semantics), so they are
// catalogued here rather than papered over. Adding a NEW file here is a
// deliberate, reviewable act — do not do it to silence the rule; gate the query
// or justify the bypass with an inline disable.
const ALLOWLIST_PATH_FRAGMENTS = [
    '.test.ts',
    '.spec.ts',
    '.integration.test.ts',
    '/migrations/',
    // The boundary primitive itself defines/returns the constructors.
    '/src/lib/server/database/queries/builders/media-access-boundary.ts',
    // Admin surfaces.
    '/src/routes/admin/',
    '/src/routes/api/admin/',
    '/src/lib/server/api/defs/admin/',
    // Compat surfaces (bypass the central gate by design).
    '/src/lib/server/subsonic-compat/',
    '/src/lib/server/proprietary/jellyfin-compat/',
    '/src/routes/(proprietary)/j/',
    // Assistant tools run inside the caller's own gated context.
    '/src/lib/server/proprietary/assistant-tools/',
    // Cache warming + background candidate engines read the full catalog.
    '/src/lib/server/cache/warming.ts',
    '/src/lib/server/services/suggestion-engine.service.ts',
    // Demo/seed endpoint (admin-triggered, synthetic data).
    '/src/routes/api/ai/create-demo-ratings/',
    // ── Pre-existing user-facing unrestricted reads (audited 2026-07-21). ──
    // These held an implicit permissive default before the boundary migration;
    // it is now explicit + greppable. Tightening them changes which rows a
    // restricted user sees, which the migration must not do — tracked separately.
    '/src/lib/server/api/defs/music/sections/genre-name.ts',
    '/src/lib/server/api/defs/music/alchemy-brew.ts',
    '/src/lib/server/api/defs/for-you/watching-sources.ts',
    '/src/lib/server/api/defs/catalog/media-id-similar.ts',
    '/src/lib/server/api/defs/recommendations/calendar-delegate.ts',
    '/src/lib/server/api/defs/watched/index.ts',
    '/src/lib/server/api/defs/stats/username-all.ts',
    '/src/lib/server/services/watch-manager.service.ts',
    '/src/lib/server/services/music/genre-plan.service.ts',
    '/src/routes/music/+page.server.ts',
    '/src/routes/music/albums/+page.server.ts',
    '/src/routes/music/artists/+page.server.ts',
    '/src/routes/music/genres/',
];

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Flag unrestrictedAccess() / UNRESTRICTED media-access bypasses outside the admin/scanner/compat allowlist',
            category: 'Possible Errors',
            recommended: true,
        },
        schema: [],
        messages: {
            unrestricted:
                'Deliberate media-access bypass ({{name}}) in a non-allowlisted path. Every ' +
                'fail-open read must be visible in review: gate the query with a real ' +
                '`MediaAccessBoundary` (e.g. `searchAccessBoundary(ctx)` / `restrictedAccess(...)`), ' +
                'or — if it is genuinely admin/scanner/compat — add this file to ' +
                'ALLOWLIST_PATH_FRAGMENTS in ' +
                'scripts/eslint-plugin-callback-safety/rules/no-unrestricted-access-outside-allowlist.js, ' +
                'or acknowledge it with ' +
                '`// eslint-disable-next-line callback-safety/no-unrestricted-access-outside-allowlist`.',
        },
    },

    create(context) {
        const filename = context.filename || context.getFilename?.() || '';
        const normalised = filename.replace(/\\/g, '/');

        const isApplicable = APPLICABLE_PATH_FRAGMENTS.some((frag) => normalised.includes(frag));
        if (!isApplicable) return {};

        const isAllowlisted = ALLOWLIST_PATH_FRAGMENTS.some((frag) => normalised.includes(frag));
        if (isAllowlisted) return {};

        function reportName(node, name) {
            context.report({ node, messageId: 'unrestricted', data: { name } });
        }

        return {
            // `unrestrictedAccess()` — Identifier or `x.unrestrictedAccess()`.
            CallExpression(node) {
                const callee = node.callee;
                if (callee.type === 'Identifier' && callee.name === 'unrestrictedAccess') {
                    reportName(node, 'unrestrictedAccess()');
                } else if (
                    callee.type === 'MemberExpression' &&
                    callee.property &&
                    callee.property.type === 'Identifier' &&
                    callee.property.name === 'unrestrictedAccess'
                ) {
                    reportName(node, 'unrestrictedAccess()');
                }
            },
            // A bare `UNRESTRICTED` constant used as a value (spec's alternative
            // spelling of the bypass). References only — not its declaration.
            Identifier(node) {
                if (node.name !== 'UNRESTRICTED') return;
                const parent = node.parent;
                if (!parent) return;
                // Skip declarations / property keys / imports — flag value uses.
                if (
                    (parent.type === 'VariableDeclarator' && parent.id === node) ||
                    (parent.type === 'Property' && parent.key === node && !parent.computed) ||
                    parent.type === 'ImportSpecifier' ||
                    parent.type === 'ImportDefaultSpecifier' ||
                    (parent.type === 'MemberExpression' &&
                        parent.property === node &&
                        !parent.computed)
                ) {
                    return;
                }
                reportName(node, 'UNRESTRICTED');
            },
        };
    },
};
