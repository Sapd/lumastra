# Repository Guidelines

This file provides guidelines for agentic coding agents operating in the Lumastra repository.

## Project Overview

**Lumastra** is a full-stack SvelteKit application aggregating media from multiple sources with AI-powered recommendations.

**Stack:** SvelteKit + TypeScript, PostgreSQL + pgvector, Valkey/Redis, TailwindCSS 4, Svelte 5 (runes)

---

## Documentation Index

| File                                           | What                                 | When to read                                  |
| ---------------------------------------------- | ------------------------------------ | --------------------------------------------- |
| `docs/dev/DEVELOPER-GUIDE.md`                  | API reference, utilities, patterns   | Implementing features, using utilities        |
| `docs/dev/QUICK-START.md`                      | Development commands, setup, testing | First-time setup, running tests, deployments  |
| `docs/architecture/database-architecture.md`   | Database architecture, migrations    | Writing database code, schema changes         |
| `docs/dev/INTERACTION-MODEL.md`                | Media card interaction philosophy    | Designing media interactions, modal behaviors |
| https://lumastra.org/guides/authentication/    | OAuth device-flow setup (operator)   | Building OAuth features                       |
| https://lumastra.org/developers/oauth-clients/ | OAuth device-flow client guide       | Building or debugging a third-party client    |

> User-facing documentation (install, configuration, deployment, administration, auth,
> backup, client integration) lives at **https://lumastra.org**, not in `docs/`. See
> `docs/README.md` for what remains in-repo.

---

## Build, Test, and Development Commands

### Development Server

```bash
npm run dev                    # Start local dev server
PORT=3000 npm run dev        # Start with specific port
npm run build                # Build production bundle (increments SW version first)
npm run build:no-sw         # Build without bumping the service worker
```

### Code Quality

```bash
npm run typecheck            # Type-check .ts (tsgo) — does NOT cover .svelte
npm run check:svelte-types  # Type-check .svelte (official svelte-check, ~90s, blocking in CI)
npm run check               # Fast structural pass only — does NOT type-check .svelte
npm run check:watch         # Watch mode for the .svelte type check
npm run lint                # Run ESLint (zero warnings policy)
npm run lint -- --fix       # Auto-fix linting issues
npm run lint:prettier      # Prettier check only
npm run format             # Auto-format with Prettier
npm run format -- src/     # Format specific files
```

### Running Tests

```bash
# Unit tests (excludes integration)
npm run test                # Run all unit tests
npm run test:watch          # Watch mode
npm run test:ui            # UI mode

# Integration tests (requires database)
npm run test:integration    # Run integration tests
npm run test:all          # Run all tests (unit + integration)

# E2E tests (requires dev server)
npm run test:e2e           # Run all Playwright E2E tests
npm run test:e2e:api        # API tests only
npm run test:e2e:ui         # UI tests only

# Running a single test
vitest run src/lib/utils/some-util.test.ts           # Single file
vitest run --testNamePattern='test name'             # By test name pattern
vitest run src/lib/server/services/foo.test.ts -t 'specific test'
```

### Database Commands

```bash
npm run db:test:create     # Create test database
npm run db:test:drop     # Drop test database
npm run db:test:reset    # Reset test database
npm run db:test:migrate  # Run migrations on test database
```

---

## Running the App

### Local development

- `npm run dev` starts the SvelteKit dev server
- Access at `http://localhost:5173` (default Vite port)
- Under `npm run dev`, a request without forward-auth headers is signed in as `DEFAULT_USER`
  (default `admin`) with admin rights; `LUMASTRA_DEV_NO_DEFAULT_USER=true` turns that off.
  Production builds never do this.
- Postgres + Valkey are expected at `localhost:5432` / `localhost:6379` (`docker compose -f docker-compose.dev.yml up -d` starts both)
- Run a single test: `vitest run path/to/file.test.ts -t 'test name'`

### Production deployment

Lumastra ships as a Docker image (`ghcr.io/lumastra/lumastra`). See `README.md`
for the Docker / Docker Compose quick-start, and https://lumastra.org/guides/configuration/
for full configuration, including built-in accounts, OIDC SSO and forward auth behind a
reverse proxy.
Operational guides live at https://lumastra.org/guides/.

---

## Debugging Recipes

For task-system, queue, and pipeline debugging recipes (stuck items, queues not draining,
identity collisions, mirror drift, etc.), see https://lumastra.org/guides/task-troubleshooting/. Always use
generic placeholders for any host / container / credential values — never commit real
infrastructure details or secrets.

A few media / image-sync invariants worth remembering when debugging:

- **Media file linkage**: files link to series OR episodes in `media_file_items` — check both (episodes via `parent_id` -> season; files linked directly to series).
- **Series folder images**: artwork like `backdrop.jpg` lives in the series root folder, not season folders — scan both.
- **Media hierarchy**: Series -> Seasons -> Episodes; queries must traverse all three levels.
- **Media type values**: the database uses `tv` (not `series`) for TV series — check the `media_type` column.
- **Container path mapping**: DB paths may differ from container mount points — verify with `docker exec <container> ls <path>`.

---

## Code Style & Formatting

### Prettier Configuration (.prettierrc)

- **Indentation:** 4 spaces (no tabs)
- **Quotes:** Single quotes (`'`)
- **Trailing commas:** All
- **Print width:** 100 characters
- **Bracket same line:** true

Run `npm run format` to auto-format. Prettier runs automatically on commit via husky.

### TypeScript Guidelines

| Rule                  | Requirement                                              |
| --------------------- | -------------------------------------------------------- |
| No `any`              | Use `unknown` with type guards, or define explicit types |
| Explicit return types | All functions, especially async ones                     |
| Generic collections   | `Map<string, MediaItem>` not `Map<any, any>`             |
| Type imports          | Use `import type { Foo }` for types only                 |

### ESLint Rules

- **Zero warnings policy** (`--max-warnings=0`)
- Server files (services, database, API routes) have stricter type-aware linting
- Test files have relaxed rules (no type-aware checking)

Key enforced rules:

- `@typescript-eslint/no-explicit-any`: ERROR
- `@typescript-eslint/no-unsafe-*`: ERROR (server files only)
- No direct `external_ids` INSERT/UPDATE/DELETE — use `CatalogService`
- No `throw error()` in API routes — use `ApiResponses` methods

---

## Project Structure & Module Organization

```

src/
├── routes/ # SvelteKit routes
│ ├── api/ # Internal API endpoints
│ │ └── v1/ # Versioned public API (typedJson required)
│ └── [slug]/ # Page routes (+page.svelte, +page.server.ts)
├── lib/
│ ├── components/ # Shared Svelte components
│ ├── stores/ # Svelte stores (runes-based)
│ ├── server/
│ │ ├── services/ # Business logic services
│ │ ├── database/
│ │ │ ├── queries/ # Query modules (pure SQL)
│ │ │ └── migrations/ # Versioned migrations, registered in migrate-schema.ts
│ │ └── middleware/ # Server middleware
│ ├── utils/ # Shared utilities
│ ├── types/ # TypeScript types
│ └── schemas/ # Zod schemas (single source of truth)
├── lib/server/ # Server-only code (never exposed to client)
static/ # Public assets
tests/ # Playwright E2E tests
scripts/ # Maintenance utilities

```

### File Naming Conventions

- SvelteKit routes: `+page.svelte`, `+page.server.ts`, `+server.ts`, `+layout.svelte`
- Components: `PascalCase.svelte` (e.g., `MediaCard.svelte`)
- Utilities: `kebab-case.ts` (e.g., `data-extraction.ts`)
- Tests: `*.test.ts`, `*.integration.test.ts`
- Query modules: `<area>.queries.ts` (e.g., `access-groups.queries.ts`)

---

## Server-Driven UI Pattern

Core pattern for displaying media (232+ usages, 37 files).

| Component                   | Purpose                             |
| --------------------------- | ----------------------------------- |
| `UniversalMediaItem`        | Unified media structure (type)      |
| `PageSection`               | Section configuration (type)        |
| `CardVariant`               | Card display mode (type)            |
| `UniversalMediaCard.svelte` | Universal card renderer (component) |
| `SectionRenderer.svelte`    | Section router (component)          |
| `StandardSection.svelte`    | Carousel/grid layouts (component)   |

Types: `src/lib/types/server-driven-ui.ts`

---

## Import Conventions

### Aliases

```typescript
import { foo } from '$lib/utils/foo';      # Shared utilities
import { bar } from '$lib/server/services/bar';  # Server services
import { baz } from '$lib/components/baz';    # Svelte components
```

### Common Imports

```typescript
// API responses
import { ApiResponses } from '$lib/server/utils/api-responses';

// Data extraction
import { isRecord, toString, toNumberOr, extractBody } from '$lib/utils/data-extraction';

// Validation
import { assertDefined, requireValue, validateCallback } from '$lib/utils/runtime-validation';

// Toast notifications
import { toasts } from '$lib/stores/toast.store';

// Logging
import { logger } from '$lib/server/logger';

// Media type helpers
import { isEpisode, isMovie, isSeries } from '$lib/server/utils/media-types';

// Composite keys (prefer provider-agnostic names)
import {
    ExternalIdMap,
    ExternalIdSet,
    createExternalIdKey,
} from '$lib/server/utils/tmdb-composite-key';
// Or: import { tmdbKey } from ... (deprecated)

// Image proxy
import { getImageProxyService } from '$lib/server/services/image-proxy';
```

### ImageProxyService

Centralized image handling at `src/lib/server/services/image-proxy/`. Always use instead of direct implementations or internal `fetch()` calls.

```typescript
const service = getImageProxyService();
const result = await service.getJellyfinImage(params.id, 'poster');
if (!result) return new Response(null, { status: 404 });
return new Response(result.buffer, {
    headers: {
        'Content-Type': result.contentType,
        'Cache-Control': result.cacheControl,
    },
});
```

Key methods: `getImageByCatalogId()`, `getImageByCompositeKey()`, `getTmdbImage()`, `getJellyfinImage()`

---

## Svelte 5 Guidelines

This project uses Svelte 5 with runes (`$state`, `$derived`, `$effect`, `$props`, `$bindable`).

### Using the Svelte MCP Server

Use the MCP tools for all Svelte work:

1. **list-sections** → **get-documentation** (fetch ALL relevant sections)
2. Write code
3. **svelte-autofixer** (keep calling until clean)
4. **playground-link** — ask user first, NEVER use if code written to project files

### Component Patterns

```svelte
<script lang="ts">
    let { prop = $bindable() }: { prop: string } = $props();
    let count = $state(0);
    let doubled = $derived(count * 2);
</script>
```

---

## Testing Guidelines

### Unit Tests

- Location: alongside code as `*.test.ts`
- Framework: Vitest
- Run: `npm run test` or `npm run test:watch`

### Integration Tests

- Location: alongside code as `*.integration.test.ts`
- Framework: Vitest with database
- Requires: test database (`npm run db:test:create`)
- Run: `npm run test:integration`

### E2E Tests

- Location: `tests/` directory
- Framework: Playwright
- Run: `npm run test:e2e`

### Best Practices

- Use `describe`/`it` blocks
- Mock external dependencies
- Test one thing per test
- When changing UI behavior, add E2E coverage

---

## Database Architecture

Three-tier architecture — always prefer query modules or services:

| Tier           | Location                           | Use For                          |
| -------------- | ---------------------------------- | -------------------------------- |
| Query Modules  | `src/lib/server/database/queries/` | Pure SQL, no side effects        |
| Services       | `src/lib/server/services/`         | Transactions, multi-table writes |
| Database Class | Legacy only                        | Complex algorithms               |

Avoid direct SQL in routes (lint warning). Use query modules instead.

---

## Error Handling

### API Routes

Use `ApiResponses` methods instead of `throw error()`:

```typescript
import { ApiResponses } from '$lib/server/utils/api-responses';

// Instead of:
if (!user) throw error(401, 'Unauthorized');

// Use:
if (!user) return ApiResponses.unauthorized();
```

### Middleware

Use error handler middleware:

```typescript
import { withErrorHandler } from '$lib/server/middleware/error-handler';
```

---

## Critical Rules

### External IDs

Never write directly to `external_ids` table. Use `CatalogService.upsertExternalId()`:

```typescript
import { CatalogService } from '$lib/server/services/catalog.service';
await CatalogService.upsertExternalId(provider, externalId, mediaType, uuid);
```

### Media Type Consistency

Three case conventions exist — use comparison helpers:

```typescript
import { isEpisode, isMovie, isSeries } from '$lib/server/utils/media-types';
if (isEpisode(session.media_type)) { ... }
```

### Composite Keys

External IDs are NOT unique across media types. Always use composite keys `(provider_id, media_type)`:

```typescript
// Prefer provider-agnostic:
const key = createExternalIdKey(providerId, mediaType);

// Or deprecated TMDB-specific:
const key = tmdbKey(tmdbId, mediaType);
```

### UUID-Only Query Pattern

For **user data** queries (ratings, watch history, watchlist), use UUID directly — no `external_ids` join needed. Only join `external_ids` for discovery endpoints (TMDB API data), API response conversion, or resolving external input (`batchResolveTmdbToUuid()`).

---

## Commit & Pull Request Guidelines

- Contributions are pull requests from a fork; follow `.github/CONTRIBUTING.md` and, for
  AI-assisted work, `.github/CONTRIBUTING-AI.md` (the PR template asks for an AI-use disclosure)
- Commit messages: short, imperative, sentence-cased (e.g., "Fix player back button behavior")
- PRs: include description, issue links, screenshots for UI changes
- Before requesting review: run `npm run lint` and relevant test suite
- Preserve SPDX headers when rewriting files, and include the path-appropriate header in every new source file, including tests and Svelte components.
- Before committing or pushing source changes, run `node scripts/license-headers.mjs --check` and resolve every failure. Passing lint or the license-boundary check does not replace this header check.

---

## Agent-Specific Notes

- Keep linting unscoped (full repo) and fix unsafe typing rather than suppressing rules
- Prefer small, composable type guards for external data (API, DB rows, localStorage)
- Document exceptions in `docs/dev/eslint-exceptions.md` when disabling rules

### Subdirectory CLAUDE.md Files

Many subdirectories contain `CLAUDE.md` files with module-specific guidance. When working in a directory that has a `CLAUDE.md` file, ALWAYS read it first to understand module-specific conventions and patterns.

---

## Common Mistakes to Avoid

### Barrel Export Oversights

When adding new exports to a source file, ALWAYS re-export from barrel paths:

```typescript
// Source file: src/lib/server/database/some-module.ts
export function newFunction() { ... }

// Barrel file: src/lib/server/database/index.ts
// MUST also export:
export { newFunction } from './some-module.js';
```

**Why:** Code imports from `$lib/server/database` or similar barrel paths, not directly from source files. Forgetting this breaks imports silently.

### Hardcoded Placeholder Values

NEVER use placeholder values like `'abc123'`, `0`, or empty strings as temporary fixes. If unsure, add a `// TODO: fix this` that will cause a lint error or use the proper helper.

```typescript
// BAD - will be forgotten:
checksum: 'abc123',

// GOOD - use the helper:
import { generateMigrationChecksum } from '$lib/server/database/migration-system';
checksum: generateMigrationChecksum(),
```

### Incomplete Refactoring

When renaming or replacing functions/imports, use IDE refactor (rename) rather than manual edits:

```bash
# Use IDE rename feature to update ALL references
# Or at minimum:
# 1. Find all usages: grep -r "oldName" src/
# 2. Replace all: sed -i 's/oldName/newName/g' src/**/*.ts
```

**Check both:**

- Function/class usage (calls, instantiations)
- Field/object property names
- Import statements
- Comments referencing the old name

### Type Alias vs Value Exports

In TypeScript with `verbatimModuleSyntax`, be careful about what you're exporting:

```typescript
// Type alias - cannot be instantiated
export type ExternalIdMap<T> = TmdbMap<T>;
new ExternalIdMap(); // ERROR

// Value export - can be instantiated
export const ExternalIdMap = TmdbMap;
new ExternalIdMap(); // WORKS
```

When creating aliased classes/maps/sets that should be instantiable, export as value, not type.

---

## Agent Tooling

`.mcp.json` configures two MCP servers for agents that read it: the Svelte docs/autofixer
server (`@sveltejs/mcp`) and Playwright (`@playwright/mcp`). Use `gh` for GitHub.

### Quick Reference Commands

For the agent to use these efficiently:

| Task                 | Command                                                           |
| -------------------- | ----------------------------------------------------------------- |
| Run all tests        | `npm run test:all`                                                |
| Run lint + typecheck | `npm run lint && npm run typecheck && npm run check:svelte-types` |
| Create test DB       | `npm run db:test:create && npm run db:test:migrate`               |
| Reset test DB        | `npm run db:test:reset`                                           |
| Build production     | `npm run build`                                                   |

---

## Resource Constraints

- **NEVER run `npm run lint` in parallel** (e.g. via multiple sub-agents). It consumes a lot of RAM and running multiple instances simultaneously will exhaust memory. Always run lint sequentially — one instance at a time.
