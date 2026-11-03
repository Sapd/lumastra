const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const svelte = require('eslint-plugin-svelte');
const svelteParser = require('svelte-eslint-parser');
const prettier = require('eslint-config-prettier');
const globals = require('globals');
const callbackSafety = require('./scripts/eslint-plugin-callback-safety');

const sharedGlobals = {
    ...globals.browser,
    ...globals.node,
    // Vite `define` constant (vite.config.ts): true in dev/test/preprod builds.
    __API_CONTRACT_STRICT__: 'readonly',
    // Vite `define` constant: literal route segments (vite.diagnostic-route-words.ts).
    __DIAGNOSTIC_ROUTE_WORDS__: 'readonly',
};

// Shared `no-restricted-imports` pattern banning a direct `upsertUserGroups`
// import (security review 5, C4 + Shape C, 2026-09-23 — see the block below
// that applies it broadly for the full rationale). Factored out so the
// viewing-boundary block (player/viewing/routes/watch) can layer this SAME
// ban on top of its own proprietary-import ban in one `no-restricted-imports`
// config, rather than being exempted from this ban entirely — flat config
// REPLACES, not merges, a repeated rule key for the same matched file, so a
// file cannot be covered by two separate blocks that both set
// `no-restricted-imports`.
//
// An anchored `regex`, NOT a `group` list: `group` entries use gitignore
// semantics, where a directory pattern such as `**/database/queries` matches
// EVERY module under that directory — so, with `importNames` set, every
// `import * as X from '…/database/queries/<any>.queries.js'` was flagged
// (CI "Full lint" failed on embedding-operations.service.ts, which never
// touches upsertUserGroups). The regex matches only the two modules that
// export the name: the `queries` barrel (bare, `/index`, `/index.js`) and
// `oauth-admin.queries(.js)`, via `$lib/server/…` or any relative path.
// Intra-`database/` relative imports (`./queries/index.js`) stay unmatched;
// user-groups.service.architecture.test.ts covers those and dynamic imports.
const upsertUserGroupsRestrictedPattern = {
    regex: '^(\\$lib/server/|(\\.{1,2}/)+(.+/)?)database/queries(/(index|oauth-admin\\.queries)(\\.js)?)?$',
    importNames: ['upsertUserGroups'],
    message:
        'Do not import upsertUserGroups directly — it never invalidates the ' +
        'admin/max-age caches its write feeds (security review 5, C4 + Shape C). ' +
        'Use syncUserGroups() from $lib/server/services/user-groups.service.js instead.',
};

// ── Server-tree split: lint:typed (type-aware) vs lint:tests (no types) ─────
// lint:typed lints NON-test source in the server trees with type information
// from tsconfig.eslint.json. Their test files are linted by lint:tests, which
// runs without a TypeScript program: the type-aware rules are enabled only on
// non-test source (the typed block below), and the one type-aware plugin rule
// (no-comparator-on-narrowed-media-type) already returns early for test files.
// `scripts/check-lint-tiers.mjs` checks that lint:typed and lint:tests cover
// the same trees.
const TEST_FILE_GLOBS = ['**/*.test.ts', '**/*.integration.test.ts', '**/*.perf.test.ts'];

// Rules that need type information. Enabled for non-test source in the server
// trees only; never on test files.
const serverTypeAwareRules = {
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-return': 'error',
    '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
};

// Every rule of the server-tree block that needs no type information. Used by
// both the typed block (non-test files) and the test block (test files).
const serverRules = {
    ...tsPlugin.configs.recommended.rules,
    '@typescript-eslint/consistent-type-imports': 'warn',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'no-unsafe-optional-chaining': 'error',
    'no-restricted-syntax': [
        'error',
        {
            selector: 'TemplateElement[value.raw=/INSERT INTO external_ids/]',
            message:
                'Use CatalogService.upsertExternalId() or batchUpsertExternalIds() instead of direct INSERT INTO external_ids. See AGENTS.md for details.',
        },
    ],
    'callback-safety/no-direct-external-id-access': 'warn',
    'callback-safety/no-duplicate-response-types': 'warn',
    'callback-safety/no-empty-catch': 'warn',
    // Disallow raw sql.begin/savepoint in services/plugins — see rule docs.
    'callback-safety/no-direct-sql-begin': 'warn',
    // Require an access-filter marker in any function whose sql template
    // touches media_items. ERROR (see the primary config block above).
    'callback-safety/no-unscoped-media-items': 'error',
    // Flag `unrestrictedAccess()` bypasses outside the admin/scanner/compat
    // allowlist (see the primary config block above).
    'callback-safety/no-unrestricted-access-outside-allowlist': 'error',
    // Require `has_files = true` filter in user-facing movie/tv queries.
    'callback-safety/require-has-files-with-active-status': 'warn',
};

module.exports = [
    {
        ignores: [
            '.DS_Store',
            'node_modules',
            'build',
            '.svelte-kit',
            'package',
            'cache',
            'playwright-report',
            'test-results',
            'src/paraglide',
            'src/lib/paraglide',
            '.env',
            '.env.*',
            'pnpm-lock.yaml',
            'package-lock.json',
            'yarn.lock',
            'plugins/*/dist/**',
        ],
    },
    js.configs.recommended,
    ...svelte.configs['flat/recommended'],
    prettier,
    ...svelte.configs['flat/prettier'],
    {
        files: ['**/*.{js,cjs,mjs}'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: sharedGlobals,
        },
    },
    // TypeScript files - basic linting without type-aware rules (reduces memory usage)
    {
        files: ['**/*.{ts,tsx}'],
        ignores: ['scripts/**'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: 'module',
            },
            globals: {
                ...sharedGlobals,
                // DOM and Web API types for utility files
                RequestInit: 'readonly',
                RequestInfo: 'readonly',
                ResponseInit: 'readonly',
                MediaImage: 'readonly',
                MediaSessionAction: 'readonly',
                MediaSessionActionHandler: 'readonly',
                TextTrackMode: 'readonly',
                EventListener: 'readonly',
                MediaDecodingConfiguration: 'readonly',
                RequestPriority: 'readonly',
                NodeListOf: 'readonly',
                HTMLCollectionOf: 'readonly',
                ChildNode: 'readonly',
                BodyInit: 'readonly',
                AnimationPlayState: 'readonly',
                // SvelteKit-generated App namespace (app.d.ts)
                App: 'readonly',
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
            'callback-safety': callbackSafety,
        },
        rules: {
            ...tsPlugin.configs.recommended.rules,
            '@typescript-eslint/consistent-type-imports': 'warn',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            // Prevent unsafe optional chaining (calling/spreading potentially undefined values)
            'no-unsafe-optional-chaining': 'error',
            // Prevent direct INSERT into external_ids - use CatalogService instead
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'TemplateElement[value.raw=/INSERT INTO external_ids/]',
                    message:
                        'Use CatalogService.upsertExternalId() or batchUpsertExternalIds() instead of direct INSERT INTO external_ids. See AGENTS.md for details.',
                },
            ],
            // Provider-agnostic external ID access - use helpers from $lib/utils/external-ids
            'callback-safety/no-direct-external-id-access': 'warn',
            // Prevent duplicate response type definitions - use Zod-inferred types instead
            'callback-safety/no-duplicate-response-types': 'warn',
            // Prevent silent error swallowing in catch blocks
            'callback-safety/no-empty-catch': 'warn',
            // Disallow raw sql.begin/savepoint in services/plugins — use withTx() instead.
            // Crashes when sql is a ReservedSql; see commit de3943d8d. Rule itself is
            // path-scoped to services/** and plugins/** internally.
            'callback-safety/no-direct-sql-begin': 'warn',
            // Require an access-filter marker in any function whose sql template
            // touches media_items. Catches the 9-round access-gate campaign bug
            // class at write time. Path-scoped internally to routes/queries/services.
            // ERROR (not warn): `--max-warnings=0` already fails CI on it, but
            // `error` makes the perimeter non-negotiable to a contributor reading
            // this config and prevents it silently softening if that flag relaxes.
            'callback-safety/no-unscoped-media-items': 'error',
            // Flag `unrestrictedAccess()` / UNRESTRICTED bypasses outside an
            // allowlist of admin / scanner / compat paths, so every deliberate
            // fail-open is visible in review rather than invisible by omission.
            'callback-safety/no-unrestricted-access-outside-allowlist': 'error',
            // Require `has_files = true` filter in user-facing movie/tv queries.
            // Catches the 2026-05-22 ghost "Recently Added" bug where TMDB-only
            // catalog rows surfaced as clickable cards. Path-scoped internally.
            'callback-safety/require-has-files-with-active-status': 'warn',

            // Keep the metro-line UI's STAGE_APPLIES_TO mirror in sync with the
            // canonical coversStages.appliesTo declarations in the task files.
            // Build-time fail prevents the 2026-05-23 drift class (library-
            // embeddings narrowed in the task but mirror left stale, episodes
            // kept parking visually at the wrong station). Path-scoped to
            // ingest-map.constants.ts internally.
            'callback-safety/stage-applies-to-mirror-in-sync': 'error',
            // Bind the users.id UUID (not a username) into re-keyed uuid user_id
            // columns (mig 16.46.0). Catches the compiler-blind raw-SQL class.
            'callback-safety/no-username-in-user-id-sql': 'error',
            // Every /api route handler must make an authorization decision (or
            // carry an explicit `// authz:` annotation). Closes the forgotten-
            // guard class now that native login + OIDC make /api directly
            // reachable by any authenticated user. Path-scoped to
            // src/routes/api/** internally.
            'callback-safety/require-route-authz': 'error',
            // `as 'movie' | 'tv'` asserts a five-token union down to two. It
            // converts nothing — it just silences the compiler while an
            // 'episode'/'season'/'series' value flows on, so downstream
            // `=== 'tv'` branches route episodes as movies. Shipped as the
            // enforcement half of the media-type seam: parseMediaId emits five
            // tokens, most destination types modelled two.
            'callback-safety/no-narrowing-media-type-cast': 'error',

            // ── OPT-IN (kept OFF): no-success-in-catch ──────────────────────
            // Catches the "false-success" bug class: a task/function returns a
            // `{ success: true }`-shaped result from inside a catch block (a
            // swallowed failure reported as success — the pattern behind the
            // repeated silent-data-staleness incidents). The rule EXISTS and is
            // unit-tested, but stays OFF because there are pre-existing
            // false-success sites across the codebase and the repo runs
            // `eslint --max-warnings=0` — flipping it on would break the build.
            // Enable path (fix/annotate sites, then flip to 'warn' then
            // 'error', scoped to src/lib/server/tasks/ first) is documented in
            // docs/dev/eslint-exceptions.md ("false-success in catch").
            'callback-safety/no-success-in-catch': 'off',
        },
    },
    // Migrations legitimately reference the OLD schema state (a column may have
    // been a username at that migration's point in history, and the re-key
    // migration itself maps username→uuid) — exempt them from the uuid-user_id
    // guard.
    {
        files: ['**/migrations/**/*.{js,ts}'],
        rules: {
            'callback-safety/no-username-in-user-id-sql': 'off',
        },
    },
    // Critical server files - non-test source, type-aware (lint:typed).
    // Type information comes from tsconfig.eslint.json, not the root tsconfig.json.
    {
        files: [
            'src/lib/server/services/**/*.ts',
            'src/lib/server/database/**/*.ts',
            'src/routes/api/**/*.ts',
            'src/routes/public-api/**/*.ts',
        ],
        ignores: TEST_FILE_GLOBS,
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                project: './tsconfig.eslint.json',
                tsconfigRootDir: __dirname,
            },
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: sharedGlobals,
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
            'callback-safety': callbackSafety,
        },
        rules: {
            ...serverRules,
            ...serverTypeAwareRules,
        },
    },
    // Test files in the same server trees (lint:tests). No type information:
    // the same non-type-aware rules as the block above, nothing type-aware.
    // Without a program the scope manager knows only the ES lib, so `no-undef`
    // would flag DOM type names (HeadersInit, RequestInit, ...) that the typed
    // run used to see. `parserOptions.lib` restores exactly that lib set.
    {
        files: [
            'src/lib/server/services/**/*.test.ts',
            'src/lib/server/database/**/*.test.ts',
            'src/routes/api/**/*.test.ts',
            'src/routes/public-api/**/*.test.ts',
        ],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: 'module',
            parserOptions: {
                lib: ['esnext', 'dom', 'dom.iterable'],
            },
            globals: sharedGlobals,
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
            'callback-safety': callbackSafety,
        },
        rules: {
            ...serverRules,
        },
    },
    // Svelte 5 rune modules (.svelte.ts) — basic linting without type-aware rules
    {
        files: ['**/*.svelte.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: 2022,
                sourceType: 'module',
            },
            globals: {
                ...sharedGlobals,
                $state: 'readonly',
                $derived: 'readonly',
                $effect: 'readonly',
                $props: 'readonly',
                $bindable: 'readonly',
                $inspect: 'readonly',
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
        },
        rules: {
            ...tsPlugin.configs.recommended.rules,
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
        },
    },
    // Svelte files - basic linting without type-aware rules
    {
        files: ['**/*.svelte'],
        languageOptions: {
            parser: svelteParser,
            parserOptions: {
                parser: tsParser,
                extraFileExtensions: ['.svelte'],
            },
            globals: {
                ...globals.browser,
                // Additional DOM and Web API types
                RequestInit: 'readonly',
                RequestInfo: 'readonly',
                ResponseInit: 'readonly',
                MediaImage: 'readonly',
                MediaSessionAction: 'readonly',
                MediaSessionActionHandler: 'readonly',
                TextTrackMode: 'readonly',
                EventListener: 'readonly',
                MediaDecodingConfiguration: 'readonly',
                RequestPriority: 'readonly',
                NodeListOf: 'readonly',
                HTMLCollectionOf: 'readonly',
                ChildNode: 'readonly',
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
            'callback-safety': callbackSafety,
        },
        rules: {
            'svelte/no-at-html-tags': 'off',
            // Disable this rule because we use resolve from $lib/paths (a wrapper around $app/paths)
            // The rule only recognizes imports from $app/paths directly
            'svelte/no-navigation-without-resolve': 'off',
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': 'off',
            'no-unused-vars': 'off',
            // Custom callback safety rules
            'callback-safety/no-custom-event-in-callback-prop': 'warn',
            'callback-safety/require-validation-optional-chaining': 'warn',
            'callback-safety/validate-callback-parameters': 'warn',
            'callback-safety/no-duplicate-response-types': 'warn',
            'callback-safety/no-empty-catch': 'warn',
            // Same rule and same reasoning as the .ts block above. It has to be
            // repeated here because `**/*.svelte` does not match `**/*.{ts,tsx}`,
            // and the client is exactly where the five-token union meets a
            // two-token destination: components speak the canonical 'series' via
            // UniversalMediaType while stores and request bodies speak 'tv'.
            'callback-safety/no-narrowing-media-type-cast': 'error',
        },
    },
    {
        files: [
            '**/*.server.{js,ts}',
            'src/lib/server/**/*.{js,ts}',
            'scripts/**/*.{js,ts}',
            'migrations/**/*.{js,ts}',
        ],
        languageOptions: {
            globals: globals.node,
        },
    },
    // Relax TypeScript rules for utility scripts (they're one-off tools, not production code)
    // Scripts don't use type-aware linting (projectService) for better performance
    {
        files: ['scripts/**/*.ts', 'scripts/**/*.js'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                // No projectService - basic parsing only
                ecmaVersion: 2022,
                sourceType: 'module',
            },
            globals: globals.node,
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
        },
        rules: {
            // Base no-unused-vars conflicts with TS callback param signatures —
            // turn off in favor of the TS variant which respects argsIgnorePattern.
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unnecessary-type-assertion': 'off',
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
    // Test files get no type information anywhere, so no type-aware rule is
    // enabled for them: the typed rules above and in serverTypeAwareRules only
    // apply to non-test source. (Previously these were listed here as 'off'.)
    {
        files: ['**/*.test.ts', '**/*.integration.test.ts', '**/*.perf.test.ts'],
        plugins: {
            '@typescript-eslint': tsPlugin,
        },
        rules: {
            '@typescript-eslint/no-unused-vars': 'warn',
        },
    },
    // Allow CatalogService to use direct INSERT INTO external_ids (it's the single source of truth)
    // Also allow migrations (one-time schema scripts) and tests (setting up test data)
    {
        files: [
            'src/lib/server/services/catalog.service.ts',
            'src/lib/server/database/migrations/**/*.ts',
            '**/*.test.ts',
            '**/*.integration.test.ts',
        ],
        rules: {
            'no-restricted-syntax': 'off',
        },
    },
    // Prevent routes from importing write-path query functions directly — use service managers
    {
        files: ['src/routes/**/*.ts', 'src/routes/**/*.js'],
        ignores: ['src/routes/j/**', '**/*.test.ts', '**/*.integration.test.ts'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/no-direct-write-queries-in-routes': 'warn',
        },
    },
    // Public API routes MUST use typedJson() — raw json() causes Swift client decoding failures
    {
        files: ['src/routes/public-api/**/*.ts'],
        ignores: ['**/*.test.ts'],
        rules: {
            'callback-safety/no-raw-json-response': 'error',
        },
    },
    // Internal API routes — not yet migrated
    {
        files: ['src/routes/api/**/*.ts'],
        ignores: ['**/*.test.ts'],
        rules: {
            'callback-safety/no-raw-json-response': 'off',
        },
    },
    // Prevent throw error() in API routes - use ApiResponses methods instead
    // Also enforce using query modules instead of direct SQL
    {
        files: ['src/routes/api/**/*.ts'],
        ignores: ['**/*.test.ts', '**/*.integration.test.ts'],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'TemplateElement[value.raw=/INSERT INTO external_ids/]',
                    message:
                        'Use CatalogService.upsertExternalId() or batchUpsertExternalIds() instead of direct INSERT INTO external_ids.',
                },
                {
                    selector: 'TemplateElement[value.raw=/UPDATE external_ids/]',
                    message:
                        'Use CatalogService methods instead of direct UPDATE external_ids. See the AGENTS.md external IDs section.',
                },
                {
                    selector: 'TemplateElement[value.raw=/DELETE FROM external_ids/]',
                    message:
                        'Use CatalogService methods instead of direct DELETE FROM external_ids. See the AGENTS.md external IDs section.',
                },
                {
                    selector: 'ThrowStatement > CallExpression[callee.name="error"]',
                    message:
                        'Use ApiResponses methods (e.g., ApiResponses.unauthorized(), ApiResponses.badRequest()) instead of throw error() in API routes for consistent error responses.',
                },
            ],
        },
    },
    // Enforce operationMode helper — prevent direct features.jellyfin in server code
    // Note: Only effective for src/lib/server/**/*.ts files. Route +server.ts files are
    // covered by the pre-existing 'off' block below (which disables all no-restricted-syntax
    // for routes). The route-level guard relies on grep verification in CI instead.
    {
        files: ['src/routes/**/*.ts', 'src/lib/server/**/*.ts'],
        ignores: [
            'src/lib/server/config.ts',
            'src/lib/server/config/**',
            'src/lib/server/operation-mode.ts',
            '**/*.test.ts',
            '**/*.integration.test.ts',
        ],
        rules: {
            'no-restricted-syntax': [
                'warn',
                {
                    selector: 'MemberExpression[object.name="features"][property.name="jellyfin"]',
                    message:
                        'Use operationMode.isJellyfinEnabled instead of features.jellyfin. Import from $lib/server/operation-mode.js.',
                },
            ],
        },
    },
    // Warn about direct SQL usage in route handlers - prefer query modules
    // This is disabled ('off') because many routes have documented SQL usage
    // See docs/eslint-exceptions.md for rationale
    {
        files: ['src/routes/**/*.ts', 'src/routes/**/*.js'],
        ignores: [
            '**/*.test.ts',
            '**/*.integration.test.ts',
            'src/routes/**/+layout.server.ts',
            'src/routes/**/+page.server.ts',
        ],
        rules: {
            'no-restricted-syntax': [
                'off',
                {
                    selector:
                        'TaggedTemplateExpression[tag.name="sql"], TaggedTemplateExpression[tag.object.name="sql"]',
                    message:
                        'Direct SQL queries in routes should be avoided. Prefer using query modules from src/lib/server/database/queries/. If this query is complex and requires direct SQL, document the exception in docs/eslint-exceptions.md. Examples: use getWatchStatusForUser() instead of raw SQL for user_episode_watch_status queries.',
                },
                {
                    selector: 'MemberExpression[object.name="sql"][property.name="unsafe"]',
                    message:
                        'Direct sql.unsafe() usage in routes is strongly discouraged. Use query modules from src/lib/server/database/queries/ instead. If absolutely necessary, document the exception in docs/eslint-exceptions.md.',
                },
            ],
        },
    },
    // Enforce that every config.ts getter key is registered in schema.ts
    {
        files: ['src/lib/server/config.ts'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/config-schema-registered': 'error',
        },
    },
    // Test files legitimately query media_items without access-scoping — they set
    // up fixtures and assert against raw rows. The access-scoping rules
    // (no-unscoped-media-items / require-has-files-with-active-status) and the
    // empty-catch rule are not meaningful in test code. Trailing block so it wins.
    {
        files: ['**/*.test.ts', '**/*.integration.test.ts', '**/*.perf.test.ts'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/no-unscoped-media-items': 'off',
            'callback-safety/require-has-files-with-active-status': 'off',
            'callback-safety/no-empty-catch': 'off',
            // `import()` type annotations are a non-issue in test files —
            // tests routinely reference internal types inline. Style-only.
            '@typescript-eslint/consistent-type-imports': 'off',
        },
    },
    // =========================================================================
    // Viewing-boundary rule (§2.4 of the adaptive-viewing-page spec).
    //
    // AGPL player primitives and AGPL viewing shells must NEVER import the
    // proprietary tree. The existing check-license-boundary.mjs script catches
    // this at the module level; this ESLint rule gives inline IDE feedback.
    //
    // Direction that IS permitted: proprietary → AGPL (e.g. LessonShell imports
    // PlayerSurface, LessonRail — those files are excluded from this rule).
    // =========================================================================
    {
        files: [
            'src/lib/components/player/**/*.{ts,svelte}',
            'src/lib/components/viewing/**/*.{ts,svelte}',
            'src/routes/watch/**/*.{ts,svelte}',
        ],
        rules: {
            'no-restricted-imports': [
                'error',
                {
                    patterns: [
                        {
                            group: ['**/proprietary/**'],
                            message:
                                'AGPL player/viewing code must not import the proprietary tree. ' +
                                'Use snippet props (rail/belowFold) or route-level injection instead.',
                        },
                        // Security review 5, C4 + Shape C: this file matches BOTH this
                        // block and the group-write invalidation block below, and flat
                        // config replaces (not merges) `no-restricted-imports` for a
                        // file matched by two blocks — so the upsertUserGroups ban is
                        // layered in HERE rather than relying on the other block, which
                        // deliberately `ignores` this path to avoid clobbering the
                        // proprietary-import ban above.
                        upsertUserGroupsRestrictedPattern,
                    ],
                },
            ],
        },
    },
    // =========================================================================
    // Group-write invalidation rule (security review 5, C4 + Shape C,
    // 2026-09-23). `upsertUserGroups` (oauth-admin.queries.ts) is a pure
    // query and stays that way, but writing `users.groups` directly bypasses
    // the admin/max-age cache invalidation every reader of those caches
    // trusts (forward-auth's session path, the /j session and PAT paths, the
    // play-token and Live TV paths). `syncUserGroups`
    // (services/user-groups.service.ts) is the sanctioned wrapper — this
    // rule makes forgetting it a lint error instead of a silent staleness
    // bug the next writer reintroduces.
    //
    // Scoped narrowly with `ignores` (rather than a broad `files` glob that
    // would OVERRIDE the viewing-boundary `no-restricted-imports` block
    // above for any overlapping file — flat config replaces, not merges, a
    // repeated rule key for the same file) to: the wrapper itself, the query
    // module's own definition, the barrel that re-exports it, every test
    // file, and the player/viewing/routes-watch tree (which gets this SAME
    // ban layered into its own block above instead). The one transactional
    // caller, `user-identity.service.ts` — which must call `upsertUserGroups`
    // directly inside its `withTx` (the pure query needs the transaction's
    // own client) and invalidates via `invalidateGroupDerivedCaches` only
    // AFTER commit — is NOT exempted here; it carries a scoped
    // `eslint-disable-next-line` on its own import line instead, so the ban
    // still applies to every OTHER import in that file.
    // =========================================================================
    {
        files: ['src/**/*.ts'],
        ignores: [
            '**/*.test.ts',
            '**/*.integration.test.ts',
            '**/*.perf.test.ts',
            'src/lib/server/services/user-groups.service.ts',
            'src/lib/server/database/queries/oauth-admin.queries.ts',
            'src/lib/server/database/queries/index.ts',
            'src/lib/components/player/**/*.{ts,svelte}',
            'src/lib/components/viewing/**/*.{ts,svelte}',
            'src/routes/watch/**/*.{ts,svelte}',
        ],
        rules: {
            'no-restricted-imports': ['error', { patterns: [upsertUserGroupsRestrictedPattern] }],
        },
    },
    // =========================================================================
    // GUARD A — keep `_openapi.ts` files OUT of the def layer.
    //
    // The OpenAPI generator (scripts/openapi/generate.ts) dynamic-imports every
    // colocated `_openapi.ts` under tsx to read its `route` metadata. A def
    // module (`$lib/server/api/defs/**`) pulls the full server runtime —
    // database.service, the native valkey-glide addon, the Lua/tasks chain —
    // which under tsx throws (or hangs). When that import throws, the route is
    // SILENTLY DROPPED from the spec (this is exactly how /search and /browse/az
    // disappeared). So an `_openapi.ts` must stay light: import request/response
    // Zod schemas from `$lib/schemas` (or a deliberately-light `*.schemas.ts`
    // sidecar that imports nothing but zod) — never from a def module.
    //
    // Implemented with `no-restricted-syntax` (not `no-restricted-imports`) so we
    // can carve out the one safe exception: `*.schemas`/`*.schemas.ts` sidecars
    // under the def tree are zod-only by construction (see
    // defs/catalog/media-id-rating.schemas.ts) and are the sanctioned single
    // source of truth shared by a def and its `_openapi.ts`. The regex bans any
    // `**/api/defs/**` import whose specifier does NOT end in `.schemas`(.ts/.js).
    // =========================================================================
    {
        files: ['**/_openapi.ts'],
        plugins: {
            '@typescript-eslint': tsPlugin,
            'callback-safety': callbackSafety,
        },
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector:
                        'ImportDeclaration[source.value=/(\\$lib\\/server\\/api\\/defs|\\/api\\/defs\\/)/]:not([source.value=/\\.schemas(\\.[jt]s)?$/])',
                    message:
                        "_openapi.ts must stay light (it's imported by the OpenAPI generator under tsx). " +
                        'Import request/response schemas from $lib/schemas, not the def — importing a def ' +
                        'pulls the server runtime (cache/tasks/lua) and the route gets silently dropped from ' +
                        "the spec. (A zod-only '*.schemas.ts' sidecar under defs/ is the only exception.)",
                },
            ],
            // =====================================================================
            // GUARD B — every non-re-export `_openapi.ts` must annotate its `route`
            // export `: RouteMetadata` (or `satisfies RouteMetadata`). An
            // unannotated object literal is not type-checked against RouteMetadata
            // and let malformed response metadata (the string-binary ResponseDef
            // hole) through. Re-export shims carry no literal and are skipped.
            // =====================================================================
            'callback-safety/openapi-route-satisfies-metadata': 'error',
            // =====================================================================
            // GUARD C — admin `_openapi.ts` (api/v1/admin/**) must declare
            // visibility:'internal' so operator-only routes never leak into the
            // public OpenAPI spec. The rule is path-scoped internally (only fires
            // on api/v1/admin/**/_openapi.ts). Escape hatch for an intentionally-
            // public admin route: a `// openapi-allow-public-admin: <reason>`
            // marker comment in the file.
            // =====================================================================
            'callback-safety/openapi-admin-internal-visibility': 'error',
        },
    },
    // =========================================================================
    // GUARD L (ERROR) — runtime app code may never read the combined or
    // internal-only OpenAPI spec files directly. `docs/api/openapi.yaml`'s own
    // `info.description` says "Do not use for documentation" (it carries every
    // route, including every `visibility:'internal'` admin one that GUARD C
    // above keeps out of api-v1.yaml specifically so it's safe to publish);
    // `internal-api.yaml` is the internal-only complement, "For: Documentation
    // only" per the generator's own log line, and was never meant to be a
    // runtime file at all. A route that reads either leaks admin/internal
    // endpoint shapes to whoever can reach it — this is exactly what happened
    // at src/routes/api-docs/+server.ts before it was fixed to read
    // docs/api/api-v1.yaml (the deliberately public-safe spec) instead.
    // TypeScript type generation is the one legitimate reader of the combined
    // file (`npm run openapi:types`), and it runs via `scripts/`, outside this
    // rule's file scope.
    // =========================================================================
    {
        files: ['src/routes/**/*.ts', 'src/lib/server/**/*.ts'],
        ignores: ['**/*.test.ts', '**/*.integration.test.ts'],
        rules: {
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'Literal[value=/openapi\\.yaml|internal-api\\.yaml/]',
                    message:
                        'Runtime code must never read docs/api/openapi.yaml (combined spec — its own ' +
                        "info.description says 'Do not use for documentation', and it carries every " +
                        'internal/admin route GUARD C keeps out of api-v1.yaml) or internal-api.yaml ' +
                        '(internal-only, documentation-only by design). Read docs/api/api-v1.yaml instead ' +
                        '— the deliberately public-safe spec. TypeScript type generation from the combined ' +
                        "file is the one legitimate exception and lives in scripts/, outside this rule's scope.",
                },
            ],
        },
    },
    // =========================================================================
    // GUARD D/E (WARN) — API def-layer response-shape guards. Scoped to
    // response-construction sites (object literals passed to json()/typedJson())
    // in src/lib/server/api/defs/**:
    //   D) no-discriminator-leak-in-response — flag legacy mediaType/imageUrl/
    //      posterUrl/posterPath keys (contract uses type: + images{} hrefs).
    //   E) no-success-key-in-response — flag a `success:` envelope key (contract
    //      returns bare objects | {items,page}, no { success: true } wrapper).
    // Both ship as WARN (the call-site heuristic can false-positive on
    // passthrough payload names) with a per-occurrence eslint-disable escape
    // hatch. The rules path-scope to defs/** internally.
    // =========================================================================
    {
        files: ['src/lib/server/api/defs/**/*.ts'],
        ignores: ['**/*.test.ts', '**/*.integration.test.ts'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/no-discriminator-leak-in-response': 'warn',
            'callback-safety/no-success-key-in-response': 'warn',
            // GUARD F — no def-local copy of a canonical $lib/schemas response
            // schema (the response-contract drift class: one declaration per
            // shape, import it, never hand-copy). ERROR: the copy silently drifts
            // from the emitted shape and additionalProperties:false then breaks
            // strict clients.
            'callback-safety/no-canonical-schema-shadow': 'error',
        },
    },
    // =========================================================================
    // GUARD G (ERROR) — API defs must derive every URL from `ctx.surface`.
    //
    // A def is mounted on BOTH `/api` and `/api/v1` by separate route files, so
    // any prefix written as a literal is wrong on one surface by construction:
    //   - `/api/v1/series/${id}` leaked v1 links into internal responses;
    //   - `/api/image/catalog/{id}/{type}` (what `getCatalog*Url` emits) has NO
    //     `/api/v1` route at all — v1 clients got a 404;
    //   - `toEntityImageBase()` mapped the hand-written `imageBase` string that
    //     drifted to three values for the SAME surface (it is being deleted).
    // The literals also break subpath installs, since only the helpers prepend
    // SvelteKit's `base`.
    //
    // The one legal source of a prefix is `src/lib/server/api/surface-urls.ts`
    // (`apiBase` / `apiUrl` / `entityImageUrl` / `buildImageRefs`).
    //
    // Tests are exempt (same `ignores` as GUARD D/E/F): a def test legitimately
    // asserts on the concrete emitted path — that assertion is what proves the
    // derivation works. The rule ALSO path-scopes and test-exempts internally.
    // =========================================================================
    {
        files: ['src/lib/server/api/defs/**/*.ts'],
        ignores: ['**/*.test.ts', '**/*.integration.test.ts'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/no-hardcoded-api-path': 'error',
        },
    },

    // =========================================================================
    // GUARD G (app-wide half) — non-fetch sinks must carry the base path.
    //
    // src/lib/fetch-interceptor.ts patches window.fetch to prefix `base`, which
    // is why a bare fetch('/api/...') in a component is fine and is NOT flagged
    // (flagging those would hit ~400 legitimate call sites). But EventSource,
    // WebSocket, Audio, sendBeacon and <img>.src are not fetch, and the
    // interceptor is browser-gated so fetch() inside a *.server.ts never sees it.
    // Outside defs/** the rule reports ONLY those sinks.
    // =========================================================================
    {
        files: ['src/**/*.ts', 'src/**/*.svelte'],
        ignores: [
            'src/lib/server/api/defs/**',
            '**/*.test.ts',
            '**/*.integration.test.ts',
            'src/lib/fetch-interceptor.ts',
        ],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/no-hardcoded-api-path': 'error',
        },
    },

    // =========================================================================
    // GUARD H — in-app navigation must be base-path aware.
    //
    // `href="/browse"` / `goto('/x')` / `redirect(302, '/')` ignore
    // kit.paths.base and send the user to the HOST root on a subpath install.
    // svelte/no-navigation-without-resolve enforces this upstream but hardcodes
    // `$app/paths` as the only resolve source; this repo imports `resolve` from
    // `$lib/paths` on purpose (calling SvelteKit's generic resolve() directly
    // caused 71k of 88k TS2859 errors — see src/lib/paths.ts). So that rule
    // stays off above and this one enforces the same invariant.
    // =========================================================================
    {
        files: ['src/**/*.ts', 'src/**/*.svelte'],
        ignores: ['**/*.test.ts', '**/*.integration.test.ts', 'src/lib/paths.ts'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/require-base-aware-navigation': 'error',
        },
    },

    // =========================================================================
    // GUARD I — `config.BASE_PATH` (a FILESYSTEM directory) must never seed a URL.
    //
    // `config.BASE_PATH` defaults to `/data`/`/config`/`/tmp` at seven call sites
    // and is what `docker-compose.example.yml` sets to `/config`. Three sites
    // interpolated it directly in front of `/api`/`/v1` anyway
    // (`watch-together.service.ts`, `routes/api/v1/watch-together/parties/+server.ts`
    // x2), which emitted `/config/api/v1/...` hrefs on any install following the
    // example compose file — a live production bug. The fix is `$lib/shared/api-urls.ts`.
    // =========================================================================
    {
        files: ['src/**/*.ts'],
        ignores: ['**/*.test.ts', '**/*.integration.test.ts'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/no-base-path-in-url': 'error',
        },
    },

    // =========================================================================
    // GUARD J — only `src/lib/paths.ts` may import `resolve()` from `$app/paths`.
    //
    // That signature is generic over every route id AND every pathname ×3
    // (`?search`/`#hash`) — a ~9k-member template-literal union at this route
    // count. `src/lib/paths.ts` narrows it once and re-exports the wrapper.
    //
    // Six modules bypassed the wrapper (music/map + the five livetv files), three
    // of them calling `resolve()` with a template literal. That alone blew
    // TypeScript's global type-relation budget: whole-project `svelte-check` gave
    // 29,153 errors — 25,773 of them "Excessive complexity" — plus 24 internal
    // `Debug Failure` asserts and a stack overflow, and never finished. Repointing
    // those six imports took the same run to 122 errors, 0 complexity, 1m49s.
    // One straggler reintroduces it, and the symptom appears in unrelated files,
    // so this has to be enforced rather than documented. `base`/`assets` from
    // `$app/paths` stay allowed — plain strings, no instantiation.
    //
    // Covers `.svelte` too: five of the six offenders were components.
    // =========================================================================
    // Type-aware companion for the dead-guard rule. Keep this separate from
    // the basic parser block so ordinary source linting remains lightweight.
    {
        files: [
            'src/lib/shared/**/*.ts',
            'src/lib/stores/**/*.ts',
            'src/lib/utils/**/*.ts',
            'src/lib/components/**/*.ts',
        ],
        ignores: TEST_FILE_GLOBS,
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                project: './tsconfig.eslint.json',
                tsconfigRootDir: __dirname,
            },
        },
    },
    {
        files: ['src/**/*.ts', 'src/**/*.svelte'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/no-app-paths-resolve': 'error',
        },
    },

    // =========================================================================
    // Portable mock specifiers.
    //
    // `vi.mock()` matches on the resolved module id, so an absolute filesystem
    // path matches on exactly one machine and silently does nothing everywhere
    // else — the mock is skipped and the REAL module loads. On 2026-08-28 that
    // held main's blocking unit suite red for hours: 52 specifiers under
    // /Users/someone/... meant CI loaded the real persistence service, file
    // manager, process runner and DB connection, and reported the damage as
    // "AI database not configured", naming a subsystem nobody had touched.
    //
    // The bug is invisible from both sides — green where it was written, red
    // where it runs, with the error pointing somewhere else — which is why it
    // is a lint rule and not a review convention. Error, not warn: a warning
    // here would be a test suite that lies.
    //
    // Deliberately NOT scoped to *.test.ts: any file that registers a mock is
    // in scope, including setup files and fixtures.
    // =========================================================================
    {
        files: ['src/**/*.{ts,js}', 'tests/**/*.{ts,js}', 'packages/**/*.{ts,js}'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/no-absolute-vi-mock-path': 'error',
        },
    },

    // =========================================================================
    // GUARD K2 — /admin form actions gate themselves (security review 2026-09-12,
    // C4/C5). The /admin layout `load` bounces non-admins, but SvelteKit runs a
    // page's form ACTION before any load, so twelve settings pages let any
    // authenticated user write any config key. The rule requires
    // `denyUnlessAdmin(locals)` (or direct delegation to a gated helper) as the
    // FIRST statement of every action under src/routes/admin. Runtime twin:
    // src/routes/admin/admin-actions-require-admin.test.ts.
    // =========================================================================
    {
        files: ['src/routes/admin/**/+page.server.ts'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/admin-actions-require-gate': 'error',
        },
    },

    // =========================================================================
    // GUARD J2 — ownership on user-level defs addressed by a path id.
    //
    // enforce() has no `resourceOwner` kind and is deliberately DB-free, so
    // ownership lives in handlers. The 2026-09-07 IDOR audit read every
    // user-level [id]-bearing endpoint and found ZERO unscoped handlers, and
    // also found why a declarative AuthSpec would not pay: only ~12 of ~58 have
    // single-column ownership. What it could not do is stay true for the NEXT
    // endpoint someone adds, which is what this rule is for.
    //
    // Scoped to `kind: 'user'` on purpose. Extending it to admin/scope was
    // measured and flags 104 files, nearly all admin surfaces where the scope
    // IS the authorization — the noise that gets a rule switched off.
    // =========================================================================
    {
        files: ['src/lib/server/api/defs/**/*.ts'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/require-defs-ownership-gate': 'error',
        },
    },

    // =========================================================================
    // GUARD K — the media-type case/dead-guard pair.
    //
    // Both halves target the two syntactic traps behind the bug that took three
    // failed production fixes on 2026-07-30 (an audiobook opening a "Watch
    // Movie" modal with a `slug=movie-…` URL).
    //
    // (1) no-comparator-on-narrowed-media-type — the dead-guard half.
    //     `isAudiobook(normalizeType(x))` type-checks (the narrowed union is
    //     still a `string`) and can never be true. It shipped, read correctly in
    //     review, and DEFEATED a fix. Measured across `src/**/*.{ts,svelte}`
    //     (6050 files) on 2026-07-30: ZERO violations, so it goes straight in at
    //     'error' — the class cannot regrow.
    //
    // (2) no-bare-media-type-comparison — the case-convention half.
    //     `mediaType !== 'AUDIOBOOK'` in ModalActions.svelte was correct only
    //     because `openMediaModal` happens to upper-case its input; a lowercase
    //     caller (i.e. anything reading the DB) would have rendered "Mark Movie
    //     as watched" on an audiobook. Only the shared comparators handle all
    //     three conventions (lowercase storage / PascalCase Jellyfin /
    //     UPPERCASE legacy).
    //
    //     Severity is 'error'. Fixed-convention provider boundaries use a
    //     per-occurrence eslint-disable-next-line with an explicit reason.
    // =========================================================================
    {
        files: ['src/**/*.ts', 'src/**/*.svelte'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/no-comparator-on-narrowed-media-type': 'error',
            'callback-safety/no-inline-media-type-default': 'error',
            'callback-safety/no-compat-media-type-conversion-import': 'error',
        },
    },
    {
        files: ['src/**/*.ts', 'src/**/*.svelte'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/no-bare-media-type-comparison': 'error',
        },
    },

    // =========================================================================
    // GUARD M — no bare global fetch() in src/lib/server/**.
    //
    // C22 fix-plan finding: twelve credentialed or admin-configured outbound
    // call sites used bare `fetch()`, which follows an arbitrary redirect by
    // default — a compromised/misbehaving configured host (or an on-path
    // attacker) can 3xx the request anywhere the app's network position can
    // reach. All twelve are migrated to `fetchWithTimeout` (utils/fetch-utils.ts
    // / utils/fetch-timeout.ts — ONE shared same-origin-only redirect loop as
    // of this fix), which refuses a cross-origin hop. This rule is the
    // backstop against a NEW bare-fetch call site reopening the same class —
    // the finding's own "latent" item was an unused THIRD hand-rolled
    // fetchWithTimeout in runtime-optimizations.ts (now deleted) that an
    // editor's auto-import could have picked by name alone.
    //
    // Scope-aware (see the rule's own doc comment for why): a `fetch`
    // PARAMETER/local-variable/import binding is never flagged, and neither is
    // a MemberExpression callee (`ctx.dep('x').fetch()`, `strategy.fetch()`) —
    // neither is a call to the global. Test files are out of scope entirely.
    //
    // Every pre-existing bare-fetch call site NOT among the twelve carries its
    // own `eslint-disable-next-line` + reason — either it is already guarded by
    // the DIFFERENT public-only, DNS-pinned per-hop mechanism in
    // `utils/ssrf-guard.ts` (a separate invariant from this one), or it targets
    // a fixed, non-admin-configurable public host, or it is a tracked C22
    // sibling gap deliberately left open by this task. See
    // docs/dev/eslint-exceptions.md for the indexed list of which is which.
    // =========================================================================
    {
        files: ['src/lib/server/**/*.ts'],
        ignores: ['**/*.test.ts', '**/*.integration.test.ts'],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/no-bare-fetch-in-server': 'error',
        },
    },

    // =========================================================================
    // GUARD N — admin authority in server code is the CREDENTIAL's, not the owner's.
    //
    // `locals.user.isAdmin` is the OWNER's admin status. An admin's OAuth device
    // token, read-only PAT or sandboxed service token has it true while its
    // principal (owner admin AND admin scope) is not admin, so ~20 v1 handlers
    // let such tokens act as admin (spec 2026-10-07-auth-route-policy-design
    // §5.1; tokens.ts fixed in 1d115e8629, the v1 rest 2026-10-07, every other
    // server reader 2026-10-13). Ask `localsIsAdmin(locals)`
    // ($lib/server/auth/locals-admin): the principal when there is one, else the
    // user flag unless the credential says otherwise (/j, Subsonic).
    //
    // `allow` takes `{ file, reason }` for a file that must keep reading the
    // user's flag; a single line uses an eslint-disable comment with a reason.
    // =========================================================================
    {
        files: ['src/**/*.ts'],
        ignores: [
            '**/*.test.ts',
            '**/*.integration.test.ts',
            '**/*.spec.ts',
            '**/*.test-helpers.ts',
        ],
        plugins: {
            'callback-safety': callbackSafety,
        },
        rules: {
            'callback-safety/no-locals-user-is-admin': [
                'error',
                {
                    allow: [
                        {
                            file: 'src/lib/server/auth/locals-admin.ts',
                            reason: 'the one helper that turns locals into the admin verdict',
                        },
                    ],
                },
            ],
        },
    },
];
