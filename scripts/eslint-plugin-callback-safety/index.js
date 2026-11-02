// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Plugin: callback-safety
 *
 * Custom ESLint plugin to detect callback type mismatches that cause silent failures
 * in Svelte components and enforce provider-agnostic patterns.
 *
 * Rules:
 * 1. no-custom-event-in-callback-prop - Prevents CustomEvent in callback props
 * 2. require-validation-optional-chaining - Requires validation for optional chaining in critical contexts
 * 3. validate-callback-parameters - Suggests validation when invoking callback props
 * 4. no-direct-external-id-access - Enforces provider-agnostic external ID helpers
 * 5. no-duplicate-response-types - Prevents duplicating Zod schema names in type definitions
 * 6. no-raw-json-response - Prefer typedJson() over raw json() in API routes
 * 7. no-direct-write-queries-in-routes - Routes must use service managers for write operations
 * 8. no-empty-catch - Prevents bare catch blocks that silently swallow errors
 * 9. config-schema-registered - Every config.ts getter key must be in schema.ts
 * 10. no-direct-sql-begin - Disallow raw sql.begin/savepoint in services/plugins; use withTx()
 * 11. no-unscoped-media-items - Require access-filter marker when sql template touches media_items
 * 12. require-has-files-with-active-status - Require has_files filter when selecting movie/tv rows
 * 13. no-narrowing-media-type-cast - Disallow `as 'movie' | 'tv'`; the real union has five tokens
 * 14. no-hardcoded-api-path - API defs must derive URLs from ctx.surface (api-urls.ts)
 * 15. require-base-aware-navigation - in-app nav must go through a base-path-aware helper
 * 16. no-base-path-in-url - config.BASE_PATH (filesystem dir) must never seed a URL
 * 17. no-app-paths-resolve - only src/lib/paths.ts may import resolve() from $app/paths
 * 18. no-bare-media-type-comparison - compare media types with the shared comparators, not literals
 * 19. no-comparator-on-narrowed-media-type - no comparator on an already-collapsed media type
 * 20. no-absolute-vi-mock-path - vi.mock() specifiers must be portable, not machine-absolute
 * 21. require-defs-ownership-gate - user-level defs on a dynamic path must consult the caller
 * 22. admin-actions-require-gate - every /admin form action gates on the admin verdict first
 * 23. no-bare-fetch-in-server - forbid a bare global fetch() call in src/lib/server/**; route through fetchWithTimeout
 * 24. no-locals-user-is-admin - server code decides admin with localsIsAdmin(locals), not locals.user.isAdmin
 *
 * @see docs/dev/lint-rules/callback-types.md
 * @see docs/provider-constraints.md
 */

module.exports = {
    rules: {
        'no-custom-event-in-callback-prop': require('./rules/no-custom-event-in-callback-prop'),
        'require-validation-optional-chaining': require('./rules/require-validation-optional-chaining'),
        'validate-callback-parameters': require('./rules/validate-callback-parameters'),
        'no-direct-external-id-access': require('./rules/no-direct-external-id-access'),
        'no-duplicate-response-types': require('./rules/no-duplicate-response-types'),
        'no-raw-json-response': require('./rules/no-raw-json-response'),
        'no-direct-write-queries-in-routes': require('./rules/no-direct-write-queries-in-routes'),
        'no-empty-catch': require('./rules/no-empty-catch'),
        'config-schema-registered': require('./rules/config-schema-registered'),
        'no-direct-sql-begin': require('./rules/no-direct-sql-begin'),
        'no-unscoped-media-items': require('./rules/no-unscoped-media-items'),
        'no-unrestricted-access-outside-allowlist': require('./rules/no-unrestricted-access-outside-allowlist'),
        'require-has-files-with-active-status': require('./rules/require-has-files-with-active-status'),
        'stage-applies-to-mirror-in-sync': require('./rules/stage-applies-to-mirror-in-sync'),
        'no-bare-json-stringify-in-sql': require('./rules/no-bare-json-stringify-in-sql'),
        'no-username-in-user-id-sql': require('./rules/no-username-in-user-id-sql'),
        'require-route-authz': require('./rules/require-route-authz'),
        'no-narrowing-media-type-cast': require('./rules/no-narrowing-media-type-cast'),
        // Media-type case/dead-guard pair (see eslint.config.cjs GUARD K).
        'no-bare-media-type-comparison': require('./rules/no-bare-media-type-comparison'),
        'no-comparator-on-narrowed-media-type': require('./rules/no-comparator-on-narrowed-media-type'),
        'no-inline-media-type-default': require('./rules/no-inline-media-type-default'),
        'no-compat-media-type-conversion-import': require('./rules/no-compat-media-type-conversion-import'),
        'no-absolute-vi-mock-path': require('./rules/no-absolute-vi-mock-path'),
        'require-defs-ownership-gate': require('./rules/require-defs-ownership-gate'),
        // Admin form actions run BEFORE the layout load (see eslint.config.cjs GUARD K2).
        'admin-actions-require-gate': require('./rules/admin-actions-require-gate'),
        // OpenAPI / API-contract guards (see eslint.config.cjs GUARD B–E).
        'openapi-admin-internal-visibility': require('./rules/openapi-admin-internal-visibility'),
        'openapi-route-satisfies-metadata': require('./rules/openapi-route-satisfies-metadata'),
        'no-discriminator-leak-in-response': require('./rules/no-discriminator-leak-in-response'),
        'no-success-key-in-response': require('./rules/no-success-key-in-response'),
        'no-canonical-schema-shadow': require('./rules/no-canonical-schema-shadow'),
        // API surface guard (see eslint.config.cjs GUARD G).
        'no-hardcoded-api-path': require('./rules/no-hardcoded-api-path'),
        'require-base-aware-navigation': require('./rules/require-base-aware-navigation'),
        // BASE_PATH-overload guard (see eslint.config.cjs GUARD I).
        'no-base-path-in-url': require('./rules/no-base-path-in-url'),
        // Typecheck-budget guard (see eslint.config.cjs GUARD J).
        'no-app-paths-resolve': require('./rules/no-app-paths-resolve'),
        // Opt-in (registered but OFF in the enforced config — see
        // docs/dev/eslint-exceptions.md, "false-success in catch").
        'no-success-in-catch': require('./rules/no-success-in-catch'),
        // C22 fix-plan finding (see eslint.config.cjs GUARD M).
        'no-bare-fetch-in-server': require('./rules/no-bare-fetch-in-server'),
        // Principal-vs-owner admin guard (see eslint.config.cjs GUARD N).
        'no-locals-user-is-admin': require('./rules/no-locals-user-is-admin'),
    },
    configs: {
        recommended: {
            plugins: ['callback-safety'],
            rules: {
                'callback-safety/no-custom-event-in-callback-prop': 'warn',
                'callback-safety/require-validation-optional-chaining': 'warn',
                'callback-safety/validate-callback-parameters': 'warn',
                'callback-safety/no-direct-external-id-access': 'warn',
                'callback-safety/no-duplicate-response-types': 'warn',
                'callback-safety/no-raw-json-response': 'warn',
                'callback-safety/no-direct-write-queries-in-routes': 'warn',
                'callback-safety/no-empty-catch': 'warn',
                'callback-safety/no-direct-sql-begin': 'warn',
                'callback-safety/no-unscoped-media-items': 'warn',
                'callback-safety/require-has-files-with-active-status': 'warn',
                'callback-safety/stage-applies-to-mirror-in-sync': 'error',
                'callback-safety/no-bare-json-stringify-in-sql': 'error',
                'callback-safety/no-username-in-user-id-sql': 'error',
                'callback-safety/require-route-authz': 'error',
                // Media-type case/dead-guard pair. Both are enforced as errors;
                // fixed-convention provider boundaries use per-occurrence reasons.
                'callback-safety/no-bare-media-type-comparison': 'error',
                'callback-safety/no-comparator-on-narrowed-media-type': 'error',
            },
        },
        strict: {
            plugins: ['callback-safety'],
            rules: {
                'callback-safety/no-custom-event-in-callback-prop': 'error',
                'callback-safety/require-validation-optional-chaining': 'error',
                'callback-safety/validate-callback-parameters': 'warn',
                'callback-safety/no-direct-external-id-access': 'error',
                'callback-safety/no-duplicate-response-types': 'error',
                'callback-safety/no-raw-json-response': 'warn',
                'callback-safety/no-direct-write-queries-in-routes': 'warn',
                'callback-safety/no-empty-catch': 'error',
                'callback-safety/no-direct-sql-begin': 'warn',
                'callback-safety/no-unscoped-media-items': 'error',
                'callback-safety/require-has-files-with-active-status': 'error',
                'callback-safety/no-bare-json-stringify-in-sql': 'error',
                'callback-safety/require-route-authz': 'error',
                'callback-safety/no-bare-media-type-comparison': 'error',
                'callback-safety/no-comparator-on-narrowed-media-type': 'error',
            },
        },
    },
};
