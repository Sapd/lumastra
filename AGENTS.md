# AGENTS.md

Guide for AI coding agents and human contributors working in the Lumastra repository. Claude
Code reads it through `CLAUDE.md`; Codex, Cursor, Copilot, opencode and others read it directly.

Lumastra is a full-stack SvelteKit application that aggregates media from multiple sources with
AI-powered recommendations.

**Stack:** SvelteKit + TypeScript, Svelte 5 (runes), PostgreSQL + pgvector, Valkey/Redis, TailwindCSS 4

## Read the folder's `CLAUDE.md` first (hard rule)

Many folders contain their own `CLAUDE.md` with module-specific rules. **Before you read or
change code in a folder, read the `CLAUDE.md` in that folder and in each parent folder up to the
repository root.** Claude Code loads them by itself; every other tool must open them explicitly.
Skipping this is the most common way to break a module's invariants.

## How changes reach this repository

Changes arrive as pull requests from a fork, following `.github/CONTRIBUTING.md`. AI-assisted
work also follows `.github/CONTRIBUTING-AI.md`, including the disclosure in the PR template.

- Branch from `main` in your fork; one focused change per PR.
- Stage only the files you changed (`git add <path>`, never `-A` or `.`). The working tree
  often holds unrelated scratch files.
- Commit messages: short, imperative, sentence-cased (for example "Fix player back button behavior").
- PRs: include a description, issue links and screenshots for UI changes.
- Commit when a requested change is done, but push or open a PR only when the user asks.
- Features and large changes need an accepted discussion first; see `.github/CONTRIBUTING.md`.

## Before you open a pull request

This section follows `.github/CONTRIBUTING.md` and `.github/CONTRIBUTING-AI.md`; read both. Do
these in order and say in the PR what you did.

1. **Run the checks.** `npm run lint && npm run typecheck && npm run check:svelte-types && npm test`
   and `node scripts/license-headers.mjs --check`. Also run the integration or Playwright tests
   for the area you changed (see [Testing](#testing)).
2. **Test the change end to end on a running Lumastra instance.** Start the app, use the real
   feature or fix in the browser or the client app, and watch it work. Unit tests and type
   checks do not replace this, and there are no exceptions for "trivial" changes. In the PR,
   say how you tested it.
3. **Run an AI code reviewer over your diff**, with whatever your tool offers (for example
   `/code-review` in Claude Code). Fix or answer every finding.
4. **Recommended in addition: `bmad-review`**, the multi-lens review skill from the
   [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD). Install it in your own
   checkout with `npx bmad-method install` (it ships in the core module and installs the skills
   for your tool, for example into `.claude/skills/`), then run `/bmad-review` on your diff.
   `_bmad/`, `_bmad-output/` and your tool's skill folders (such as `.claude/`) are local
   tooling: never commit them. `.gitignore` already ignores `_bmad/`, `_bmad-output/` and
   `.claude/`.
5. **Expect another review.** A maintainer also runs an AI review on every PR, as
   `.github/CONTRIBUTING-AI.md` describes. You must answer each finding: fix it, or explain why
   it does not apply.

You are the author of what you submit: you must understand every line and be able to explain it
in review.

## Documentation index

> **User-facing docs live on the website**, not in `docs/`. Install, configuration,
> deployment, administration, auth/SSO, backup, and client/player integration are
> documented at **https://lumastra.org**. If a change affects how someone _uses_
> Lumastra, the website needs the matching update. `docs/` keeps only contributor and
> code-coupled references; see `docs/README.md`.

| File                                                  | What                                                                                                                                                      | When to read                                                                                           |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `docs/dev/DEVELOPER-GUIDE.md`                         | API reference, utilities, patterns                                                                                                                        | Implementing features, using utilities                                                                 |
| https://lumastra.org/developers/plugins/              | Plugin authoring guide (third-party authors) — SDK install, the eight contracts, multi-contract bundles, events/webhooks, signing, ABI                    | Writing or reviewing a plugin; answering an author's question                                          |
| https://lumastra.org/guides/plugins/                  | Plugin operations (operators) — drop-in vs signed install, trusted keys, webhook secrets, restart semantics, env vars                                     | Installing or trusting plugins; anything an operator sees                                              |
| `docs/dev/QUICK-START.md`                             | Development commands, setup, testing                                                                                                                      | First-time setup, running tests, deployments                                                           |
| `docs/dev/testing-traps.md`                           | Ways a test passes or fails for the wrong reason: mocks, env differences, real PostgreSQL, Playwright                                                     | Writing a `vi.mock`, an integration test or a Playwright spec                                          |
| `docs/dev/ci-change-detection.md`                     | Which public CI jobs a pull request runs, by changed path; the ESLint PR cache                                                                            | Adding a CI job, a new top-level directory, or a file a test reads at run time                         |
| `docs/dev/livetv-e2e.md`                              | Real Live TV E2E: synthetic one-slot provider, stream proxy, sessions, Chromium and runner reuse                                                          | Running or extending Live TV end-to-end tests                                                          |
| `docs/architecture/database-architecture.md`          | Database architecture, migrations                                                                                                                         | Writing database code, schema changes                                                                  |
| https://lumastra.org/architecture/task-system/        | Task system architecture (orchestrator, runner, pipeline coverage, reliability)                                                                           | Debugging or modifying the task subsystem; understanding stage_state, orphan classification, watchdogs |
| `docs/architecture/task-system-schema.md`             | Raw DDL + Valkey key reference for the task system                                                                                                        | Hand-querying task tables / Valkey keys                                                                |
| `docs/dev/INTERACTION-MODEL.md`                       | Media card interaction philosophy                                                                                                                         | Designing media interactions, modal behaviors                                                          |
| `docs/dev/media-type-vocabulary.md`                   | Why the DB stores `tv` and the API emits `series`; which converter to call; when an inline conversion is correct                                          | Converting a media type between storage / API / TMDB vocabularies; adding a media type                 |
| https://lumastra.org/guides/authentication/           | OAuth device-flow setup and configuration (operator side)                                                                                                 | Building OAuth features                                                                                |
| https://lumastra.org/developers/oauth-clients/        | OAuth device-flow client implementation guide                                                                                                             | Building or debugging a third-party/TV client                                                          |
| `docs/architecture/hls-timeline-invariants.md`        | HLS timeline invariants: what must stay aligned per delivery mode (EXTINF, tfdt, media sequence, renditions), pitfalls, change checklist                  | Before touching HLS segmenting, seeks, handover, audio or subtitle renditions                          |
| `docs/architecture/jellyfin-compat-security.md`       | Security posture of the `/j` + `/subsonic` compat surfaces — why they bypass the central gate, residual risk, compensating controls, operator guidance    | Touching `/j` or `/subsonic` auth; reviewing the public attack surface; deciding compat trade-offs     |
| `docs/architecture/auth-provider-plugins-security.md` | Why auth-provider plugins get a pre-auth carve-out — the three env gates, fail-closed rationale, and the residual risk of handing a plugin a raw password | Touching `/api/auth/plugin/**`, the forward-auth carve-out, or the auth-provider contract              |
| `docs/api/API.md`                                     | Long-form API notes — **served at runtime** by `/api-docs?format=md` and `/llms.txt`                                                                      | Changing the public API surface (keep it in sync; do not delete the file)                              |

Task-system operator screens and debugging recipes are documented at
https://lumastra.org/guides/task-monitoring/ and https://lumastra.org/guides/task-troubleshooting/.

---

## Commands

### Development

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres + Valkey for local development
npm run dev                  # Dev server, http://localhost:5173
PORT=3000 npm run dev        # Specific port
npm run build                # Production bundle (bumps the service worker version first)
npm run build:no-sw          # Build without bumping the service worker
```

Under `npm run dev`, a request without forward-auth headers is signed in as `DEFAULT_USER`
(default `admin`) with admin rights; `LUMASTRA_DEV_NO_DEFAULT_USER=true` turns that off.
Production builds never do this. Setup details: `docs/dev/QUICK-START.md`.

Lumastra ships as a Docker image (`ghcr.io/lumastra/lumastra`). See `README.md` for the Docker
Compose quick-start and https://lumastra.org/guides/ for configuration and operations.

### Code quality

```bash
npm run typecheck            # Type-check .ts (tsgo); does NOT cover .svelte
npm run check:svelte-types   # Type-check .svelte (svelte-check on tsgo, ~1 min, blocking in CI)
npm run check                # Same as check:svelte-types
npm run check:native         # Old fast structural pass; reports no .svelte type errors
npm run check:watch          # Watch mode for the .svelte type check
npm run lint                 # ESLint, zero warnings
npm run lint -- --fix        # Auto-fix
npm run lint:prettier        # Prettier check only
npm run format               # Prettier write
node scripts/license-headers.mjs --check    # SPDX headers
node scripts/check-license-boundary.mjs     # core vs protected-tier imports
```

**Run `npm run lint` one instance at a time**, never in parallel (for example from several
sub-agents). It uses a lot of RAM and parallel runs exhaust memory.

### Tests

```bash
npm run test                 # Unit + component tests (excludes integration)
npm run test:watch           # Watch mode
npm run test:ui              # Vitest UI
npm run test:integration     # Integration tests (need the test database)
npm run test:all             # Everything vitest runs
npm run test:e2e             # Playwright E2E (starts a dev server)
npm run test:e2e:api         # API project only
npm run test:e2e:ui          # UI project only
npm run test:jellyfin-contract   # Jellyfin contract suite (needs PG + Valkey)

npx vitest run src/lib/utils/some-util.test.ts              # One file
npx vitest run path/to/file.test.ts -t 'specific test'      # One test by name

npm run db:test:create && npm run db:test:migrate   # Create + migrate the test database
npm run db:test:reset                               # Drop and recreate it
```

## Project structure

```
src/
├── routes/              # SvelteKit routes
│   ├── api/             # Internal API endpoints
│   │   └── v1/          # Versioned public API (typedJson required)
│   └── [slug]/          # Page routes (+page.svelte, +page.server.ts)
├── lib/
│   ├── components/      # Shared Svelte components
│   ├── stores/          # Svelte stores (runes-based)
│   ├── server/          # Server-only code, never exposed to the client
│   │   ├── services/    # Business logic services
│   │   ├── database/
│   │   │   ├── queries/     # Query modules (pure SQL)
│   │   │   └── migrations/  # Versioned migrations, registered in migrate-schema.ts
│   │   └── middleware/  # Server middleware
│   ├── utils/           # Shared utilities
│   ├── types/           # TypeScript types
│   └── schemas/         # Zod schemas (single source of truth)
static/                  # Public assets
tests/                   # Playwright E2E tests
scripts/                 # Maintenance utilities
```

File naming: SvelteKit routes `+page.svelte`, `+page.server.ts`, `+server.ts`, `+layout.svelte`;
components `PascalCase.svelte`; utilities `kebab-case.ts`; tests `*.test.ts` and
`*.integration.test.ts`; query modules `<area>.queries.ts`.

## Code style

- **Prettier** (`.prettierrc`): 4 spaces, single quotes, trailing commas everywhere, print width
  100, `bracketSameLine`. Prettier also runs on commit through husky.
- **TypeScript:** no `any` (use `unknown` with type guards); explicit return types on all
  functions, especially async ones; typed collections (`Map<string, MediaItem>`, not
  `Map<any, any>`); `import type { Foo }` for type-only imports; define interfaces for all data
  structures (API responses, parameters, return values). Prefer small type guards for external
  data (API, DB rows, localStorage). Fix unsafe typing instead of suppressing rules.
- **SPDX headers:** keep them when rewriting a file, and put the path-appropriate header in every
  new source file, including tests and Svelte components. Passing lint does not replace
  `node scripts/license-headers.mjs --check`.
- **Lint scope:** lint the whole repo, not just your files, so shared-rule breakage shows up.
- Document any ESLint rule exception in `docs/dev/eslint-exceptions.md`.

### ESLint enforcement

Zero warnings (`--max-warnings=0`). Server files (services, database, API routes) get stricter
type-aware linting (`@typescript-eslint/no-unsafe-*`); test files have relaxed rules.

| Rule                                      | Severity | Summary                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No direct `external_ids` writes           | ERROR    | Use `CatalogService.upsertExternalId()` — enforces composite key integrity                                                                                                                                                                                                                                       |
| No `throw error()` in API routes          | ERROR    | Use `ApiResponses.unauthorized()`, `.notFound()`, `.badRequest()`, `.error()`                                                                                                                                                                                                                                    |
| Avoid direct SQL in routes                | WARNING  | Use query modules from `src/lib/server/database/queries/`                                                                                                                                                                                                                                                        |
| No `sql.unsafe()`                         | WARNING  | Use parameterized queries: `` sql`...${value}` ``                                                                                                                                                                                                                                                                |
| Callback safety (3 sub-rules)             | WARNING  | Custom plugin at `scripts/eslint-plugin-callback-safety/`                                                                                                                                                                                                                                                        |
| No direct write queries in routes         | WARNING  | Routes must use service managers for writes (e.g., `watchManager`, `sessionManager`)                                                                                                                                                                                                                             |
| No unscoped `media_items` queries         | WARNING  | `FROM media_items` / `JOIN media_items` in SQL must apply library/age filter or be admin-scoped                                                                                                                                                                                                                  |
| Library-scope requires `has_files = true` | WARNING  | sql templates selecting `'movie'` rows from `media_items` must filter `has_files = true` or catalog ghosts leak as cards (rule: `require-has-files-with-active-status`)                                                                                                                                          |
| No hardcoded `/api/` paths in API defs    | ERROR    | In `src/lib/server/api/defs/**` (tests exempt): no `'/api/…'` literals, no `getCatalog*Url` / `toEntityImageBase` imports. A def is mounted on BOTH surfaces — derive URLs from `ctx.surface` via `apiUrl()` / `entityImageUrl()` / `buildImageRefs()` in `$lib/shared/api-urls` (rule: `no-hardcoded-api-path`) |

## Svelte

This project uses Svelte 5 with runes (`$state`, `$derived`, `$effect`, `$props`, `$bindable`).
`.mcp.json` configures the Svelte docs/autofixer MCP server (`@sveltejs/mcp`) and Playwright
(`@playwright/mcp`) for agents that read it. If the Svelte MCP server is available, use
`list-sections` and `get-documentation` before writing code, and run `svelte-autofixer` on the
result until it is clean.

```svelte
<script lang="ts">
    let { prop = $bindable() }: { prop: string } = $props();
    let count = $state(0);
    let doubled = $derived(count * 2);
</script>
```

> ⚠️ **SvelteKit route files only export reserved names.** A `+server.ts` may export
> only `GET/POST/PATCH/PUT/DELETE/OPTIONS/HEAD` (+ `prerender`/`config`/etc. or `_`-prefixed
> names); a colocated test must NOT be named `+server.test.ts` (the `+` is reserved). Put
> helper functions a route's tests import in a sibling non-`+` module (e.g. `headers-util.ts`)
> and name route tests `server.test.ts`. **`vite build` enforces this but `svelte-check`,
> `eslint`, and `vitest` do NOT** — so a green local check can still break the production build.

### Server-driven UI

Core pattern for displaying media. Types: `src/lib/types/server-driven-ui.ts`.

| Component                   | Purpose                             |
| --------------------------- | ----------------------------------- |
| `UniversalMediaItem`        | Unified media structure (type)      |
| `PageSection`               | Section configuration (type)        |
| `CardVariant`               | Card display mode (type)            |
| `UniversalMediaCard.svelte` | Universal card renderer (component) |
| `SectionRenderer.svelte`    | Section router (component)          |
| `StandardSection.svelte`    | Carousel/grid layouts (component)   |

## Testing

- **Unit tests:** next to the code as `*.test.ts` (Vitest). Mock external dependencies, one
  thing per test, `describe`/`it` blocks.
- **Integration tests:** next to the code as `*.integration.test.ts`, against a real database
  (`npm run db:test:create`, then `npm run test:integration`). Never point `TEST_DATABASE_URL`
  at a database with real data.
- **E2E tests:** `tests/` (Playwright). When you change UI behaviour, add E2E coverage.
- Read `docs/dev/testing-traps.md` before writing a `vi.mock`, an integration test or a
  Playwright spec.

## Database architecture

Three tiers. New code uses query modules or services; do NOT add methods to the Database class.

| Tier                 | Location                                | Use For                                                                  |
| -------------------- | --------------------------------------- | ------------------------------------------------------------------------ |
| **Query Modules**    | `src/lib/server/database/queries/`      | Pure SQL, `sql: postgres.Sql` as first param, no side effects            |
| **Services**         | `src/lib/server/services/`              | Transactions, race conditions, multi-table writes, external coordination |
| **Service Managers** | `src/lib/server/services/*-manager.ts`  | Business logic, write orchestration                                      |
| **Database Class**   | `src/lib/server/database/connection.ts` | Legacy only — complex recommendation algorithms, advisory locks          |

Avoid direct SQL in routes (lint warning); use query modules.

**Migrations are a 2-step process.** Creating a file in `migrations/` is NOT enough: you must
also import and register it in the `MIGRATIONS` array in `migrate-schema.ts`, or it will not run
on deploy. Never edit a migration that has shipped; add a new one. Never use placeholder
checksums such as `'abc123'`; use `generateMigrationChecksum()` from
`$lib/server/database/migration-system`.

## Architecture essentials

| Subsystem         | Key Details                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth**          | Three sign-in methods, all first-class: built-in accounts (`auth/account-sign-in.ts`), OIDC SSO (`AUTH_OIDC_*`, `/auth/oidc/*`), and forward auth from a trusted reverse proxy (`USERHEADER`/`GROUPHEADER`, opt-in via `FORWARD_AUTH_ENABLED`, honoured only from `TRUSTED_PROXY_IPS`, `middleware/forward-auth.ts`). Apps and API clients use bearer tokens (OAuth device flow, PATs). Auth-provider plugins can add methods |
| **AI**            | OpenAI `text-embedding-3-small`, per-item recommendation embeddings (library- OR discovery-sourced, mutually exclusive by `has_files` — NOT a metadata/cast-crew split), pgvector similarity, RAG chat at `/api/chat`                                                                                                                                                                                                         |
| **Config**        | Always use `src/lib/server/config.ts`. Client: `$page.data?.branding`. `SHOW_UNAVAILABLE_MEDIA` affects only discovery surfaces; `/browse` always shows library items (`has_files = true`). Metadata language negotiation for `/api/v1`: `docs/api/API.md` §9                                                                                                                                                                 |
| **Cluster**       | Replica heartbeat service at `src/lib/server/services/cluster-heartbeat.service.ts`. Live state in Valkey (TTL keys), transitions in `cluster_node_events` DB table. Admin UI at `/admin/cluster`.                                                                                                                                                                                                                            |
| **Cache keys**    | Always version (`v1:feature:${id}`). Increment on schema/logic changes                                                                                                                                                                                                                                                                                                                                                        |
| **Episode watch** | `user_watch_state` is the sole source of truth. Jellyfin sync is background-only via `JellyfinSyncManager`                                                                                                                                                                                                                                                                                                                    |
| **Jellyfin**      | Optional background integration — not required for any feature. Gated by `FEATURE_JELLYFIN_SYNC`. `/j/` compat for TV clients                                                                                                                                                                                                                                                                                                 |

### Access control

**Route policy table.** `src/lib/server/auth/route-policy/rules.ts` maps every route id × method
to one policy: `public`, `user`, `admin`, `admin-scoped` (admin, or a token the route's scope
check decides) or `token-surface:<x>` (the route authenticates itself). `route-policy.test.ts`
fails for a route without a rule, a `public`/token-surface rule without a reason, a token-surface
route that references none of its rule's authenticators, or a looser policy without a `loosens:`
reason. After adding a route, run `npx vitest run src/lib/server/auth/route-policy -u` and review
the snapshot diff. For now the table runs in shadow mode (`ROUTE_POLICY_MODE=shadow` logs
`route_policy_shadow_mismatch`); the gates in `hooks.server.ts` still decide. Never use a
`+layout.server.ts` load as an access gate: `__data.json` requests and form actions skip it.
Object-level checks (this title, this playlist) stay in the handler and use the helpers below.

| Util                       | Where                                     | Use For                                                                               |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `getUserRole(sql, pid, u)` | `$lib/server/utils/playlist-utils`        | Gate ANY playlist route (returns owner/editor/contributor/readonly or null)           |
| `buildSearchAccessContext` | `$lib/server/utils/search-access-context` | Build once per search request; pass `SearchAccessContext` to every helper             |
| `scopedCacheKey(p, ctx)`   | same file                                 | Cache keys for access-filtered results — appends library/age suffix                   |
| `resolveAndGate`           | `$lib/server/utils/resolve-and-gate`      | Mutation routes (rating/watchlist/music) — resolves externalIds → UUID + access check |
| `parsePagination(url)`     | `$lib/server/utils/pagination`            | Clamped `{limit, offset}` — never `Number.parseInt` query params directly             |

**Throws/errors:** `resolveAndGate` throws `MediaAccessDeniedError` (route → 404, not 403, to avoid existence leak) or `MediaNotResolvableError` (route → 400). All three "AccessDenied" aliases (Rating/Watchlist/MusicInteraction) are the same class object.

### API response types (Zod schemas)

All types are Zod schemas in `src/lib/schemas/` (single source of truth). Type files in
`src/lib/types/` re-export via `z.infer<>`.

**Adding a field:** add it to the Zod schema, use `.describe('...')` for OpenAPI, run
`npm run openapi:generate`; types update from there.

**Nullability:** prefer `.optional()` (Swift compatibility). Use `.nullable()` only when the
database or API genuinely returns `null`. At service boundaries: `row.field ?? undefined`.

### Error handling in routes

Use `ApiResponses` methods instead of `throw error()`, and `withErrorHandler` from
`$lib/server/middleware/error-handler` for the handler wrapper:

```typescript
import { ApiResponses } from '$lib/server/utils/api-responses';

if (!user) return ApiResponses.unauthorized();
```

### ImageProxyService

Centralized image handling at `src/lib/server/services/image-proxy/`. Always use it instead of
your own implementation or an internal `fetch()` call.

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

### Common utilities

`ApiResponses` (`$lib/server/utils/api-responses`), type guards in `$lib/utils/data-extraction`
(`isRecord`, `toString`, `toNumberOr`, `extractBody`), assertions in
`$lib/utils/runtime-validation` (`assertDefined`, `requireValue`, `validateCallback`),
`Logger.for('Name')` (`$lib/server/utils/logger`), `toasts` (`$lib/stores/toast.store`), media
type helpers (`$lib/server/utils/media-types`). Full list in `docs/dev/DEVELOPER-GUIDE.md`.

## Critical rules for media identity

### Provider IDs are not unique across media types

External provider IDs (TMDB, IMDB) are NOT unique across media types: the same numeric ID can
identify an unrelated movie and series. **Always use composite keys** `(provider_id, media_type)`:

```typescript
import { ExternalIdMap, createExternalIdKey } from '$lib/server/utils/tmdb-composite-key';
const map = new ExternalIdMap<string>();
map.set(tmdbId, mediaType, jellyfinId);

// Database queries MUST include media_type
WHERE ei.provider = 'tmdb' AND ei.external_id = ${tmdbId} AND mi.media_type = ${mediaType}
```

All `CatalogService` methods and embedding functions require a `mediaType` parameter. Prefer the
provider-agnostic `createExternalIdKey`; `tmdbKey` is the deprecated TMDB-specific form.

### Writing external IDs

Never write to the `external_ids` table directly. Use
`CatalogService.upsertExternalId(provider, externalId, mediaType, uuid)` from
`$lib/server/services/catalog.service`.

### Media type case and vocabulary

- **Storage:** `media_items.media_type` stores lowercase `'movie'`, `'tv'`, `'episode'`, `'season'`.
  Jellyfin uses `'Movie'`/`'Series'`; older external clients send `'MOVIE'`/`'SERIES'`.
  Compare with `isMovie` / `isSeries` / `isEpisode` / `isSeason` from
  `$lib/server/utils/media-types`, which accept any case.
- **Vocabulary:** the DB stores `'tv'` (TMDB's namespace, part of the `external_ids` composite
  key) while every public surface emits `'series'`. Both are correct; don't unify them. Never
  convert by hand: use `toPublicMediaType()` / `toInternalMediaType()` / `toUniversalMediaType()`
  from `$lib/shared/media-type-domain` and handle the `null`. See `docs/dev/media-type-vocabulary.md`.

### UUID-first IDs

The internal UUID (`media_items.id`) is the primary identifier end to end:

- **DB responses** include `externalIds.internal` (the UUID) alongside TMDB/Jellyfin IDs.
- **`buildMediaKey(externalIds, mediaType)`** prefers `externalIds.internal` and produces a bare
  UUID URL (e.g. `/api/media/{uuid}/rating`).
- **`withIdResolution` middleware** on every `[id]` route resolves any incoming format (UUID,
  composite `tmdb:550:movie`, Jellyfin UUID) into `locals.resolvedIds.internalId`.
- **User-data queries** (ratings, watch history, watchlist) use `internalId` directly, with no
  `external_ids` join.

Only join `external_ids` for discovery endpoints (TMDB API data), API response conversion, or
resolving external input (`batchResolveTmdbToUuid()`). Media cards have no separate `mediaId`
prop: the UUID travels inside `externalIds.internal`.

## Client diagnostics (device logs, incidents, crashes)

Everything clients report lands in `client_diagnostics`.

- `kind` is one of `log_bundle`, `playback_incident`, `crash`, `hang`, `js_error`, `api_failures`,
  `compat_incident` (a Jellyfin app asked for PlaybackInfo and never streamed, twice in a row on the
  same device, or once when Lumastra's response broke the app's data contract; one row per device + app version per day). `/j` ClientLog uploads
  are stored as `log_bundle` rows with `source: jellyfin`.
- Bundle gzip is stored in `client_diagnostic_blobs.content`.
- The web client reports uncaught errors, failed `apiFetch` calls and every error toast
  (`toasts.error(msg, { diagnosticKey })`) through `src/lib/client-diagnostics/web-reporter.ts`.
  Paths go through `diagnosticPathTemplate` (only literal route names survive, from
  `vite.diagnostic-route-words.ts`); never send a raw URL or toast text.
- Unmatched `/j/*` requests are logged under `JellyfinCompat:UnknownRoute` (warn = a Jellyfin spec route we
  do not implement, debug = unknown shape; once per route + client per hour) and counted per day in Valkey
  (`jfunk:<date>`); `GET /api/admin/jellyfin-compat/unknown-routes?days=7` (admin) lists them by count.
- `JELLYFIN_CONTRACT_VALIDATE=log` validates `/j` JSON responses against the Jellyfin SDK contract
  and logs violations (dev debugging; off by default).
- Contract suite: `npm run test:jellyfin-contract` (needs PG + Valkey like the integration tests).
  Regenerate the digest with `npx tsx tests/jellyfin-contract/extract.ts` when a new
  jellyfin-sdk-kotlin line ships.

Endpoints:

- **Ingest:** `POST /api/v1/diagnostics/bundles` (user "Send Diagnostics", ≤ 2 MiB gzip, needs
  nginx `client_max_body_size` ≥ 3 MiB) and `POST /api/v1/diagnostics/events`.
- **Admin:** page `/admin/users/client-diagnostics`. The search box matches the "Reference
  XXXX-XXXX" short id (first 8 hex chars of `event_id`) or the note.
- **Admin API:** `GET /api/admin/diagnostics`, and `GET /api/admin/diagnostics/{id}/blob?format=text`
  for the bundle text.

When debugging a user report, look for their bundle before reading code. Code lives in
`src/lib/server/{services,database/queries}/client-diagnostics*` and
`src/lib/server/api/defs/{diagnostics,admin/diagnostics}/`.

## Debugging notes

Task-system, queue and pipeline recipes (stuck items, queues not draining, identity collisions,
mirror drift) are at https://lumastra.org/guides/task-troubleshooting/. Use generic
placeholders for hosts, containers and credentials in anything you commit; never commit real
infrastructure details or secrets.

Media and image-sync invariants worth remembering:

- **Media file linkage:** files link to series OR episodes in `media_file_items`. Check both
  (episodes via `parent_id` -> season; files linked directly to series).
- **Series folder images:** artwork like `backdrop.jpg` lives in the series root folder, not in
  season folders. Scan both.
- **Media hierarchy:** Series -> Seasons -> Episodes. Queries must traverse all three levels.
- **Media type values:** the database uses `tv` (not `series`) for TV series; check the
  `media_type` column.
- **Container path mapping:** DB paths may differ from container mount points. Verify with
  `docker exec <container> ls <path>`.

## Traps

### Check pipeline

- **`lint:fast` skips whole trees.** It ignores `src/lib/stores`, `src/lib/utils/**/*.ts`,
  `src/lib/components/**/*.ts`, `src/lib/shared/**/*.ts`, `src/lib/server/services`,
  `src/lib/server/database`, `src/routes/api` and `src/routes/public-api`. The full `npm run lint`
  covers them through `lint:typed` (non-test source, type-aware, `tsconfig.eslint.json`) and
  `lint:tests` (their `*.test.ts` files, no type information); when you lint only your files, pass
  them to `eslint` directly.
- **`npm run typecheck` (tsgo) does not read `.svelte` files.** Use `npm run check:svelte-types`
  (same as `npm run check`) for those: svelte-check on tsgo over the components and every file
  that imports one, ~1 min and ~6 GB. `npm run check:native` is the old fast pass that reports
  no `.svelte` type errors at all.
- **A missing message key is a runtime crash, not a build error.** Paraglide omits the export, so
  `m.some_key()` throws inside a render. `src/lib/paraglide-message-keys.test.ts` catches it; run it
  after every edit of `messages/*.json`, and check the keys are still in the file after you commit.
- **Regenerate the OpenAPI spec after any dependency bump that touches zod or zod-openapi, and read
  the diff of `docs/api`.** The Swift client generator keeps only the first member of a
  `type: [a, b]` array, so a changed encoding of a union breaks the generated client. Compare
  generator output with generator output, not with the committed file, which may be stale.
  `openapi:generate` reads the working tree, not `HEAD`.
- **A request field must not give `null` a different meaning from "absent".** The Swift client
  collapses both into one optional and never sends `null`. Give "clear this value" its own
  endpoint (for example `DELETE .../rating`) or a non-null sentinel.
- **Core (AGPL) code must not import protected-tier code in any form.** That includes `import()`
  and `import.meta.glob`. Core calls it through a registry: a core module exposes
  `registerXProvider()` plus a getter and the licensing init registers the implementation. Run
  `node scripts/check-license-boundary.mjs` and `node scripts/license-headers.mjs --check` before
  you commit; the image build runs both and stops when either fails. Tests under `src/` ship with
  the tree, so a test of protected code lives next to that code, never in a core folder.

### Common mistakes

- **Barrel exports.** When you add an export to a source file, re-export it from the barrel it
  belongs to (for example `src/lib/server/database/index.ts`). Code imports from barrel paths,
  and a missing re-export breaks imports.
- **Placeholder values.** Never use `'abc123'`, `0` or an empty string as a temporary fix. Use the
  proper helper, or leave a `// TODO` that fails lint.
- **Incomplete renames.** When you rename or replace a function, use your editor's rename, or
  grep for every old name: calls, instantiations, field and property names, imports and comments.
- **Type alias vs value export.** With `verbatimModuleSyntax`, `export type Foo = Bar` cannot be
  instantiated with `new Foo()`. If an aliased class, map or set must be instantiable, export it
  as a value: `export const Foo = Bar`.
