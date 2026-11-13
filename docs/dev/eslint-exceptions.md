# ESLint Rule Exceptions

This document tracks approved exceptions to our ESLint rules, particularly around database access patterns.

## Purpose

While we have ESLint rules to enforce architectural patterns, some legitimate cases require exceptions. This document serves as:

1. **Accountability** - All exceptions are documented and reviewed
2. **Context** - Explains WHY an exception was needed
3. **Audit Trail** - Track technical debt and refactoring opportunities

## Where these rules actually run

Run `npm run lint` before submitting changes. The pre-commit hook also runs
ESLint on staged files. Custom-rule regression tests run through
`npm run lint:callback-safety` and CI. These tests verify the rule implementations;
access-control integration tests verify the application behavior.

## Rule Categories

### 1. Direct SQL in Route Handlers

**Rule:** Routes should use query modules from `src/lib/server/database/queries/` instead of direct SQL.

**Why:** Query modules provide:

- Reusability across routes
- Centralized query logic
- Easier testing and maintenance
- Type safety and consistency

#### Approved Exceptions

##### `/api/for-you/watching/+server.ts`

**Lines:** 134-170, 189-196

**Reason:** Complex multi-CTE query for smart sorting of continue watching, next up, and new episodes. This query:

- Combines data from `media_items` (episode rows), `user_episode_watch_status`, and `user_movie_watch_status`
- Uses CTEs to calculate series-level last watched dates
- Requires LEFT JOINs to handle episodes without watch status
- Highly specific to this endpoint's sorting algorithm (GREATEST of pause_date, previous_watched_date, release_date)

**Refactoring Path:** Could extract to `src/lib/server/database/queries/watch-status.queries.ts` as `getSmartSortDates()` if similar logic is needed elsewhere.

**Approved By:** Database refactoring review (Task #26)

**Date:** 2026-01-29

---

### 2. Direct External IDs Table Access

**Rule:** All writes to `external_ids` table MUST go through `CatalogService`.

**Why:** Enforces:

- Composite key integrity (provider + external_id + media_type)
- Prevents duplicate search results bug
- Single source of truth for business rules
- Consistent `media_type` handling

#### Approved Exceptions

**None.** This rule has NO exceptions. All external ID writes MUST use `CatalogService`:

```typescript
import { CatalogService } from '$lib/server/services/catalog.service';

// Single upsert
await catalogService.upsertExternalId(mediaId, {
    provider: 'tmdb',
    id: tmdbId.toString(),
    mediaType: 'movie',
    source: 'api',
});

// Batch upsert
await catalogService.batchUpsertExternalIds([
    {
        mediaId,
        externalId: {
            provider: 'tmdb',
            id: '123',
            mediaType: 'movie',
            source: 'api',
        },
    },
]);
```

**Allowed in:**

- `src/lib/server/services/catalog.service.ts` (the service itself)
- `src/lib/server/database/migrations/**/*.ts` (one-time schema migrations)
- `**/*.test.ts` and `**/*.integration.test.ts` (test data setup)

---

### 3. Using sql.unsafe()

**Rule:** `sql.unsafe()` should be avoided in favor of parameterized queries.

**Why:**

- SQL injection protection
- Better type safety
- Query planning optimization

#### Approved Exceptions

##### `/api/ai/saved-movies/[user_id]/+server.ts`

**Line:** 121

**Reason:** Complex query with dynamic view-based metadata join string. The query:

- Uses `buildViewBasedMetadataJoin()` which returns a string fragment
- Combines DISTINCT ON with scalar subqueries for multiple external IDs
- Complex JSONB array extraction with CASE expressions
- 50+ line query with multiple joins and transformations

**SQL Injection Risk:** NONE. All user input is parameterized (`[userId]`). The `buildViewBasedMetadataJoin()` result is a fixed string with no user input.

**Refactoring Path:** Extract to `src/lib/server/database/queries/watchlist.queries.ts` as `getUserWatchlistWithMetadata()`. Would require converting view join to use fragment API.

**Approved By:** QR review for database refactoring

**Date:** 2026-02-10

---

### 4. TypeScript Function Overloads and Type Assertions

**Rule:** ESLint enforces various TypeScript best practices including no-redeclare and no-unsafe-return.

**Why:** Prevent accidental variable shadowing and unsafe type assertions.

#### Approved Exceptions

##### `src/lib/server/config.ts`

**Lines:** 49, 56, 63, 70 (no-redeclare), 81 (no-unsafe-return)

**Reason:** TypeScript function overload pattern for type-aware config getter.

The `getConfig()` function uses overloads to provide compile-time type safety:

```typescript
function getConfig(type: 'string', ...): string;
function getConfig(type: 'boolean', ...): boolean;
function getConfig(type: 'number', ...): number;
```

**no-redeclare exceptions** are required for each overload signature.

**no-unsafe-return exception** is required when returning array values from configServiceValues because the ConfigValues type uses index signatures.

**Alternative Considered:** Generic function `getConfig<T>()` but loses type discrimination based on the `type` parameter string literal.

**Approved By:** Config refactoring review

**Date:** 2026-02-11

---

##### `src/lib/server/database/migration-system.ts`

**Line:** 28 (`@typescript-eslint/no-empty-object-type`)

**Reason:** A `declare module 'postgres'` augmentation re-opens `TransactionSql` to restore the call signatures and `Sql`-assignability that postgres.js's published `Omit<Sql, …>`-based declaration spuriously drops (mapped types discard call signatures → TS2349/TS2740 across every `up(tx)` migration handler). Interface declaration merging requires the augmenting declaration's type parameters to be **identical** to the library's (else TS2428), and postgres.js declares `interface TransactionSql<TTypes extends Record<string, unknown> = {}>`. The `= {}` default therefore must be reproduced verbatim — no non-`{}` spelling is admissible.

**Alternative Considered:** `= Record<string, never>` — rejected: differs from the library default, triggers TS2428 and breaks the merge, defeating the shim.

**Approved By:** Type-error burndown (tsgo-verified, no type suppressions)

**Date:** 2026-07-23

---

##### `src/lib/server/ai/embedding-only-generator.ts`

**Lines:** 291 (count query), 347 (batch fetch query)

**Reason:** Two queries require dynamic SQL fragments that cannot be expressed with parameterized postgres.js template literals:

- `availabilityJoin` — conditional LEFT JOIN string (`jellyfin_media` or `jellyseerr` join)
- `embeddingJoin` — conditional LEFT JOIN on `media_embeddings`
- `mdblistCondition` — conditional WHERE clause for MDBList tag presence
- `cursorCondition` — cursor-based pagination condition with UUID value interpolated as a string literal (not a parameter)

The `postgres.js` template literal API does not support injecting SQL fragments as identifiers or raw SQL snippets; only value parameterization is supported. The `sql.unsafe()` form is the only way to compose these dynamic fragments.

**SQL Injection Risk:** NONE. All dynamic fragments are:

- Server-side computed strings based on function arguments (no user input reaches these strings)
- The only interpolated value is `provider` (from `getPrimaryExternalIdProvider()`, a server config value) and `lastProcessedId` (a UUID from a previous DB result)

**Refactoring Path:** Could use `sql.unsafe()` as a fragment builder via `sql.unsafe(fragment)` inside a larger template literal, but that is not supported by postgres.js. Alternative: rewrite as separate queries per condition combination (combinatorial explosion).

**Approved By:** Provider-agnostic refactoring review (2026-02-19)

**Date:** 2026-02-19

---

##### Additional `sql.unsafe()` exceptions

**None currently.** If you need additional `sql.unsafe()`, you must:

1. Document the exception here with clear justification
2. Explain why parameterized queries cannot be used
3. Show SQL injection is impossible in this case
4. Get approval from a senior engineer

---

### 5. Hardcoded `/api/` Paths in API Defs

**Rule:** `callback-safety/no-hardcoded-api-path` (ERROR, scoped to
`src/lib/server/api/defs/**`, non-test files only — GUARD G in `eslint.config.cjs`).

A def must derive every URL it emits from `ctx.surface`, using
`src/lib/shared/api-urls.ts`:

```typescript
import { apiUrl, entityImageUrl, buildImageRefs } from '$lib/shared/api-urls';

const href = apiUrl(ctx.surface, `/series/${id}`); // '/api/series/…' | '/api/v1/series/…'
const poster = entityImageUrl(row.id, 'poster', ctx.surface, { size: 'card' });
const images = buildImageRefs(row.id, ctx.surface); // { poster: {…}, backdrop: {…} }
```

**What it flags:**

| Trigger                                                            | Message ID              |
| ------------------------------------------------------------------ | ----------------------- |
| A string/template chunk starting with an `/api` path prefix        | `hardcodedPath`         |
| Importing `getCatalog*Url` / `getCatalog*SrcSet` (`image-utils`)   | `catalogUrlHelper`      |
| Importing `toEntityImageBase` (`$lib/server/utils/api-transforms`) | `entityImageBaseMapper` |

**Why:** a def is mounted on **both** `/api` and `/api/v1` by separate route files, so a
literal prefix is wrong on one surface by construction:

- `/api/v1/series/${id}` leaked v1 links into internal responses.
- `/api/image/catalog/{id}/{type}` — what `getCatalogPosterUrl()` emits — has **no**
  `/api/v1` route at all (`src/routes/api/v1/image/` does not exist), so v1 clients got a
  404 they had to special-case. This is the tvOS report that started the whole change.
- `toEntityImageBase()` mapped the hand-written `imageBase` string that was passed at
  ~825 mount sites with no invariant tying it to the surface; it drifted to three values
  for the same surface. `imageBase` is being deleted from `SurfaceContext`.

The helpers also prepend SvelteKit's `base` (`kit.paths.base`), so a hardcoded literal
additionally breaks subpath installations (`https://host/lumastra/`).

**Not flagged (by design):** any string that merely _contains_ "api" — `'openapi'`,
`'api_key'`, `'/api-docs'`, `'https://api.themoviedb.org/3'`. The rule anchors on a
leading `/api` followed by `/`, `?`, `#`, or the end of the chunk.

**Test files are exempt.** Both the config block (`ignores: ['**/*.test.ts',
'**/*.integration.test.ts']`, matching GUARD D/E/F) and the rule's own path check skip
them. A def's test legitimately asserts on the concrete emitted path — e.g.
`expect(body.images.poster.href).toBe('/api/v1/media/…/images/poster')` — and that
assertion is precisely what proves the surface derivation works.

#### Approved Exceptions

**Identifier strings rather than emitted URLs** — `SOURCE_ROUTE` in
`defs/integrations/{mal,trakt}/sync.ts` (persisted on a run's `trigger.sourceRoute`
for audit). These must stay stable literals;
making them surface-derived would change a persisted identifier.

The escape hatch for a literal that documents a route path rather
than emitting a link (e.g. inside a Zod `.describe()`) is a per-occurrence disable with a
reason:

```typescript
// Documenting the canonical route shape, not emitting a link.
// eslint-disable-next-line callback-safety/no-hardcoded-api-path
.describe('Served at /api/v1/media/{id}/images/{role}')
```

The reason comment MUST come **above** the `eslint-disable-next-line` directive. If it
sits between the directive and the code, the directive applies to the comment instead —
the violation is still reported, ESLint additionally reports an unused-directive warning
(which fails `--max-warnings=0`), and `eslint --fix` under lint-staged deletes the
directive.

If you find yourself needing more than a doc-string exception, the URL belongs in
`api-urls.ts` — add a helper there instead of disabling the rule.

---

### 6. `config.BASE_PATH` Interpolated Into a URL

**Rule:** `callback-safety/no-base-path-in-url` (ERROR, `src/**/*.ts`, non-test files —
GUARD I in `eslint.config.cjs`).

`config.BASE_PATH` (`src/lib/server/config.ts`) is a **filesystem** directory — seven
call sites default it to `/data`, `/config`, or `/tmp`, and
`docker-compose.example.yml` sets it to `/config` to match the config volume mount. It
is a different env var from `URL_BASE_PATH` (SvelteKit's `paths.base`, resolved by
`scripts/resolve-url-base-path.js`), which is the actual URL prefix for subfolder
installs.

**What it flags:** a template literal where an interpolated expression is
`<local>.BASE_PATH` (`<local>` bound to the `config` export of a module ending in
`/config`), immediately followed by a quasi starting with `/api` or `/v1`.

```typescript
// Wrong — config.BASE_PATH is a filesystem path, not a URL prefix.
const posterUrl = `${config.BASE_PATH}/api/v1/media/${itemId}/images/poster`;

// Right — derive the prefix from $lib/shared/api-urls.ts, which reads SvelteKit's base.
import { entityImageUrl } from '$lib/shared/api-urls';
const posterUrl = entityImageUrl(itemId, 'poster', 'v1');
```

**Why:** three call sites did exactly the wrong thing —
`watch-together.service.ts` and twice in
`routes/api/v1/watch-together/parties/+server.ts` — which emitted
`/config/api/v1/...` hrefs (watch-together poster and host-avatar links broken) on any
install following `docker-compose.example.yml`. This was a live production bug.

**Not flagged (by design):** `config.BASE_PATH` used to build a filesystem path (e.g.
`path.join(config.BASE_PATH || '/data', '.metadata')`) — nothing there starts with
`/api` or `/v1`, so the rule stays quiet on every legitimate filesystem call site. A
local variable merely named `config` that was never imported from a `.../config`
module is not tracked either (provenance-based, like `require-base-aware-navigation`).

#### Approved Exceptions

**None currently.**

---

### 7. Unscoped `media_items` Queries

**Rule:** `callback-safety/no-unscoped-media-items` (ERROR) — a sql template touching
`media_items` must carry an access-gate marker somewhere in the same **file**, as a
**runnable** reference (a call, a callee passed by reference, a parameter/variable
binding, or a property read).

> The check is file-scoped, not function-scoped. One gated function vouches for its
> ungated neighbours in the same module. The rule is a backstop against a whole file
> forgetting the access boundary — it is not a proof that any particular query is
> scoped. Until 2026-07-30 the report text claimed "in the same function"; it never
> was.

#### Approved Exceptions

##### `src/lib/server/database/queries/jellyfin-file-pairing.queries.ts`

**Functions:** `getLocalSyncFiles`, `needsFileInventory`, `queryJellyfinPairingStatus`, `queryJellyfinDeliveryStatus`, `queryJellyfinDeliveryStatus`

**Reason:** File pairing must inspect the complete catalog to reject duplicate
relative paths across libraries. A viewer filter would turn an ambiguous file
into a false unique match. Refresh eligibility likewise returns only an install-wide
boolean, scoped to unresolved provider records or eligible linked users. Pairing
status is an operator count and
example list, used only by the admin Connections page, native watch-sync tasks,
and the health finding. These queries do not serve the viewer catalog. The
status count also exempts `require-has-files-with-active-status`: a watch record
whose file is missing can remain in the provider pending buffer and still needs a
visible pairing problem. Local-event counts require linked push eligibility and
confirmed presence in the remote library.

**Date:** 2026-10-29

##### `src/lib/server/database/queries/album-local-art.queries.ts`

**Reason:** Scan/enrichment background queries operate on the full music catalog. Local cover
recovery must include albums excluded by network stage eligibility, including permanent misses
and tracks with artwork but no linked files. This module is called by scanner/enrichment workers,
not a viewer endpoint, and is exempted alongside `album-art.queries.ts` in the rule's exact-path list.

**Date:** 2026-10-23

##### `src/lib/server/database/queries/music-album-folder.queries.ts`

**Functions:** `findMusicAlbumFolderTracks`, `findAlbumArtistEvidence`

**Reason:** These are internal scanner/maintenance reads, with no viewer response.
The folder lookup is scoped to the scanner's library group and path. Album
classification must see every candidate track to determine tag consistency and
primary-artist distribution; a viewer filter would change album identity based
on who happened to trigger maintenance. Viewer-facing music queries retain their
own access gates.

**Date:** 2026-10-23

##### `src/lib/server/database/queries/audiobooks.queries.ts`

**Functions:** `listAudiobooksForAbsLibrary`, `countAudiobooks`

**Reason:** Neither is a viewer surface.

- `listAudiobooksForAbsLibrary` is the Audiobookshelf reconcile sweep's local-side
  read. It **must** see every row the connector owns — including dismissed and
  soft-deleted ones — because the differ treats "no local row for this ABS id" as
  "insert it". Hiding rows behind a viewer gate would make the sweep insert a
  duplicate for every book the viewer cannot see, on every cycle. The rows it
  returns carry `library_group_id`, which is what the viewer-facing
  `/audiobooks` reads gate on.
- `countAudiobooks` backs the media-source status on the admin Extensions page. It
  is an install-wide count of rows with no titles attached; scoping it to a viewer
  would make the operator's "how much did the sweep ingest?" answer wrong.

**Refactoring Path:** None. Both are ingest/admin-plane by construction.

**Date:** 2026-07-29

##### `src/lib/server/database/queries/unmatched-files.queries.ts`

**Functions:** `keepPersonalMediaItem`, `restoreKeptPersonalMediaItem`,
`isPersonalMediaKept`

**Reason:** These queries implement the admin-only Keep disposition and its
background matching guard. Keep must inspect the complete identity row and its
file-bearing descendants to decide whether the operator's explicit choice is
eligible. Restore locks the same row to serialize the disposition reversal with
scanner rematch claims. `isPersonalMediaKept` checks the complete ancestor chain
before an automated identity write. These are operator/system coordination
queries; they do not return catalog rows to a viewer, so viewer library filters
would make the Keep invariant depend on who can see the item.

**Refactoring Path:** None. The eligibility and coordination checks are
admin/system-plane by construction; viewer-facing unmatched-file list queries
remain scoped through their route access boundary.

**Date:** 2026-10-26

---

#### Exceptions surfaced by the 2026-07-30 prose-marker fix

Until 2026-07-30 the rule proved "this file is gated" by substring-matching its
marker tokens against the **raw source text**, comments included. A doc comment
that merely _named_ `checkMediaAccess` therefore vouched for an entire file. The
rule now walks the AST and counts a marker only where it can actually run (see
`hasAccessMarkerInFile` in the rule, and the regression cases in
`scripts/eslint-plugin-callback-safety/tests/no-unscoped-media-items.test.js`).

The fix landed in two passes on the same day:

1. **Prose → tokens.** Matching moved off `sourceCode.getText()` onto the lexer's
   identifier tokens, so comments, JSDoc, and string bodies stopped counting.
2. **Tokens → runnable references.** A token check still accepted markers that are
   erased before anything executes: a **type-only** mention
   (`interface O { ageRating: string }`, `type G = typeof checkMediaAccess`, a
   return-type reference) and an **unused import binding**
   (`import { requireAdmin }`, never called). Those are prose with a compiler in
   front of them — they gate nothing at runtime. Measured across the applicable
   tree: **0 sites relied on either**, so this pass was adopted with no backlog and
   no new exceptions.
3. **Runnable references → positions that can decide something**
   (`isNonEnforcingPosition` in the rule). Three shapes are real code by pass 2's
   definition yet still cannot make an access decision:
    - a **non-computed object property key** — `const doc = { checkMediaAccess: true }`
      is a string spelled without quotes. This is the plausible accident: a marker
      name used as an options-object key somewhere in the same file.
    - a **declaration name** — `function checkMediaAccess() {}`,
      `class isMediaAccessible {}`, `enum Field { ageRating }`. If the declaration is
      ever called, the call site is a separate identifier and still counts, so only a
      _dead_ declaration is excluded.
    - a **statement label** — `checkMediaAccess: for (…)`, `break checkMediaAccess`.

    A computed key (`{ [checkMediaAccess]: 1 }`) is a genuine value read and still
    counts. Measured across the applicable tree (2655 files): **0 new reports**, so
    again no backlog and no new exceptions.

All three passes are pinned by tests that were each verified to FAIL against the
rule version that lacked the fix — for pass 3, measured per shape with a harness
whose negative control (no marker at all) demonstrably reports and whose two
positive controls (a real call, a computed key) stay silent.

Five files had been passing on prose alone. **All five were audited individually
and none was a live access-control hole** — in every case a real gate exists, it
just lives somewhere the rule cannot see. Each site now carries a line-scoped
disable naming the verified upstream gate. No file-wide disables and no new path
exemptions were added: a path exemption would silently cover future additions to
these files, which is the hole being closed.

| File                                                      | Sites | Where the real gate is (verified)                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/api/ai/embedding-preview/+server.ts`          | 1     | Endpoint declares `auth: { kind: 'admin' }`. The old marker was the word "requireAdmin" inside the justification text of a _different_ rule's disable directive.                                                                                                                                                                                                                                                            |
| `src/lib/server/database/queries/ingest-map.queries.ts`   | 7     | Admin-only module. Consumers: `defs/admin/ingest/{map,diagnostics,stage-activity}` (all `auth: { kind: 'admin' }`), `attention-service` (reached only from `defs/admin/attention/*`, both admin), and page loaders under `/src/routes/admin/`.                                                                                                                                                                              |
| `src/lib/server/database/queries/media-extras.queries.ts` | 3     | Pure data tier; callers gate on the **parent** — `defs/playback/preview-session.ts` calls `isMediaAccessible` before `findLocalTrailerForItem`; `topshelf-render.service.ts` calls `checkMediaAccess`. Gating the extra itself would be _wrong_: extras' files may carry `library_group_id = NULL`. `findLibraryGroupForItemTree` is ingest-side (scanner + 16.159.0 backfill) and computes the value the gate later reads. |
| `src/lib/server/services/audiobook-stream-auth.ts`        | 1     | Decision happens at **mint**: `POST /playback/stream-tokens` calls `checkMediaAccess` and pins the token to one `media_items.id`; this function re-checks that pin via `validate()` and refuses wildcard tokens. It is the enforcement point, not the decision point.                                                                                                                                                       |
| `src/lib/server/services/taste-damper.service.ts`         | 2     | `listActiveDampers` is self-scoped by `user_id` (the caller's own dampers). `getMediaEmbedding` is reached only via `recordDamper`, whose sole caller `defs/for-you/less-like-this.ts` runs `resolveAndGate` and maps `MediaAccessDeniedError` → 404 first.                                                                                                                                                                 |

Two further line-scoped disables were added the same day by the audiobook-social
work. Both read `media_items` for **one column, to narrow a result set** — neither
can widen one, which is the property that makes them non-holes:

| File                                                | Sites | Column read    | Why the disable is honest                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | ----- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/server/database/queries/social.queries.ts` | 1     | `media_type`   | Decides WHICH privacy tier applies to a viewers row (audiobooks get the trust-circle predicate on top of `hide_streams`). Item access is gated by the caller: `defs/catalog/media-id-viewers.ts` runs `resolveCatalogInternalId` then `checkMediaAccess` before this query runs. |
| `queries/builders/social-visibility.builder.ts`     | 1     | `is_dismissed` | Adds "not withdrawn from the catalogue" to the sharing predicate. Same callers, same upstream `checkMediaAccess`; the clause is a `NOT EXISTS` that can only remove rows.                                                                                                        |

**Approved By:** ESLint prose-marker false-negative audit

**Date:** 2026-07-30

---

#### Known-and-tracked residual weaknesses (not holes, but not proofs either)

These are deliberate limits of a syntax-only rule. They are recorded so nobody
mistakes a green lint for a proof of scoping. **None is currently exploited**;
each was measured against the tree on 2026-07-30.

| #   | Weakness                                                                                                                                                                                                   | Why it is not fixed                                                                                                                                                                                                                                                   | Blast radius                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **File scope, not function scope.** One gated function vouches for every other query in the module.                                                                                                        | Function-scoped analysis would need to follow the `sql` fragment into helper functions and across the three-tier boundary, which the rule cannot do.                                                                                                                  | Widest of the four. `music.queries.ts` has 121 `FROM/JOIN media_items` occurrences against 16 `deniedGroupIds` sites; `episode-search.queries.ts` 32 vs 13. Both thread real access plumbing, but the lint proves nothing about the _other_ queries in them.                        |
| 2   | **A same-named local satisfies the rule.** `const ageRating = 1` counts, because it is a genuine value binding. A same-named **property key**, **declaration** or **label** no longer does (pass 3 above). | Distinguishing an access-relevant `ageRating` from an unrelated one needs type/dataflow information this rule does not have. Rejecting all bindings would reject the legitimate `function f(sql, deniedGroupIds)` plumbing shape the marker list exists to recognise. | Narrow — requires a coincidental name in a value-binding position.                                                                                                                                                                                                                  |
| 3   | **The two bare plumbing markers are weak by design.** `deniedGroupIds` and `ageRating` evidence _intent_, not enforcement.                                                                                 | They are what catches locally-named filter helpers (e.g. `buildEpisodeLibraryFilter`) that never call a canonical helper. Dropping them would trade false negatives for a large false-positive backlog.                                                               | 8 files currently pass on these alone: `episode-search`, `library-groups`, `music-recommendations`, `music`, `watch-state` (queries) and `effective-watching`, `request-status/database`, `watch-manager` (services). All were spot-checked as genuinely threading access plumbing. |
| 4   | **`EXEMPT_PATH_FRAGMENTS` is 111 hand-curated substrings matched with `includes()`.** A fragment like `/resolvers/` exempts any directory of that name under any applicable root.                          | Substring matching keeps the list short and readable.                                                                                                                                                                                                                 | Silent widening as the tree grows. The list has already drifted: `ingest-map.queries.ts` is exempt from the has-files rule but not the access rule.                                                                                                                                 |

**A rule that stops reporting cannot be observed by running lint.** The 2026-07-30
hole surfaced only incidentally: `reportUnusedDisableDirectives` is unset (ESLint
9+ flat-config default `warn`) and `lint-staged` runs `--max-warnings=0`, so the
newly-inert disable directives got reported as _unused_. Setting that option to
`'off'`, or dropping `--max-warnings=0`, removes the only detector this bug class
has. Do not do either without replacing the signal.

---

#### API definition coverage

`APPLICABLE_PATH_FRAGMENTS` includes `/src/lib/server/api/defs/`, so the
library-access rule examines dual-mounted API handlers as well as routes,
queries and services. Rule tests cover an unscoped query and a query with a
library-access filter in value position.

The task-run media-title join requires a resolved access boundary and applies
both library-group and series-owned age-rating filters before returning titles.
Its integration tests cover denied groups and unrestricted access. Continue Watching likewise applies library and age
filters before pagination.

Admin-only handlers and aggregate-only queries may require exceptions. Each
exception must explain its enforcement boundary or why it cannot return
per-item data. Syntax-only lint is a review aid; access behavior must also be
verified with tests.

---

### 8. `has_files` Marker Satisfied by a Comment

**Rule:** `callback-safety/require-has-files-with-active-status` (WARN)

The same false-negative class existed here in narrower form: the `has_files`
marker was matched against `sourceCode.getText(node)`, so a JS comment _inside_
the template naming the column satisfied the filter requirement. Audited across
the whole applicable tree on 2026-07-30: **zero sites relied on it**, so the fix
(blanking comments inside the template before matching) was adopted with no
backlog and no new exceptions.

A second pass the same day closed the residual that first fix left behind. A **SQL**
comment (`-- has_files is applied by the caller`, or a `/* … */` block) inside the
template is part of the template _text_, not a JS comment, so `getCommentsInside()`
never saw it and prose still satisfied the marker one layer down. The rule now
blanks SQL comments too (`blankSqlComments`), tracking quoted SQL literals so a
`--` or an apostrophe _inside_ a string cannot swallow real filter text on the same
line. Measured across the applicable tree: **0 new reports and 0 lost reports**, so
again no backlog and no new exceptions.

Both directions are pinned in `scripts/eslint-plugin-callback-safety/tests/require-has-files-with-active-status.test.js`:
the SQL-comment cases were verified to FAIL against the JS-comments-only version,
and three `valid` cases guard the stripper against eating a real `has_files` filter.

**Date:** 2026-07-30

---

### 9. Media-Type Case Conventions and Dead Guards (GUARD K)

**Rules:** `callback-safety/no-bare-media-type-comparison` (**WARN — must become ERROR**)
and `callback-safety/no-comparator-on-narrowed-media-type` (ERROR)

Both guard the two syntactic traps behind the bug that took **three failed
production fixes on 2026-07-30** (an audiobook opening a "Watch Movie" modal with a
`slug=movie-…` URL).

#### `no-comparator-on-narrowed-media-type` — the dead-guard half (ERROR, 0 violations)

`modal-url-sync.ts` shipped:

```ts
const mediaType = normalizeType(String(props.mediaType)); // 'movie'|'tv'|'episode'
const slugKind = isSeries(mediaType)
    ? 'tv'
    : isAudiobook(mediaType) // DEAD — 'audiobook' is not in the range
      ? 'audiobook'
      : 'movie';
```

`isAudiobook()` takes `string | undefined | null` and the narrowed union IS a
string, so it type-checks. `normalizeType` defaults every unknown token to
`'movie'`, so the branch is unreachable — the audiobook slug fix shipped and did
nothing, and the dead guard then made a later fix attempt look already-applied.

The rule intersects the comparator's accepted tokens with the narrowing function's
range and reports only when the intersection is **empty**, so the normal shape
(`isSeries(toMovieOrSeries(x))`) stays silent. It handles the direct form
(`isAudiobook(normalizeType(x))`), the via-a-local form, and Svelte 5
`$derived(…)` / `$derived.by(() => …)` wrappers. A comparator on a RAW value
(`isAudiobook(row.media_type)`) is the correct use and is never flagged.

Measured across `src/**/*.{ts,svelte}` (6050 files): **0 violations** — so it went
straight in at `'error'`, with **no exceptions and no backlog**.

The domain knowledge lives in two exported constants at the top of the rule,
`NARROWING_FUNCTIONS` (name → token range) and `COMPARATOR_TOKENS` (comparator →
accepted tokens), derived from `shared/media-types.ts`, `shared/media-type-domain.ts`,
`server/utils/api-transforms.ts`, `server/utils/media-key-parser.ts` and
`stores/modal-url-sync.ts`. **Keep them in step with the domain.** A callee declared
in the same file overrides the table by reading its return-type annotation, so a
local rename keeps working and a narrower annotated with a type _reference_
(`InternalMediaType`) is treated as unknown-range and never reported — a stale table
under-reports, it does not false-positive.

#### `no-bare-media-type-comparison` — the case-convention half (ERROR)

`ModalActions.svelte` shipped `mediaType !== 'AUDIOBOOK'`, correct only because
`openMediaModal` happens to upper-case its input; a caller passing the canonical
lowercase `'audiobook'` (i.e. anything reading the DB) would have rendered
"Mark Movie as watched" on an audiobook.

**The line the rule draws:** it is syntactic, so it cannot tell
`details.type === 'series'` on a `PublicMediaType` (provably lowercase, provably
safe) from the same text on a Jellyfin-sourced value. It therefore flags only
literals whose case convention is itself the hazard — any known token NOT written in
canonical lowercase (`'AUDIOBOOK'`, `'Movie'`, `'SERIES'`, `'TV'`, `'Episode'`, …)
plus the cross-convention alias `'show'`. Stated plainly: **a lowercase comparison
against a value that can arrive PascalCase from Jellyfin is a real bug this rule does
NOT catch** — closing that needs type information, not a wider literal list (widening
to lowercase tokens would flood a `--max-warnings=0` repo with provably-safe
comparisons and get the rule disabled).

Exempt: the comparator implementation modules (`shared/media-types.ts`,
`server/utils/media-types.ts` — they compare literals for a living), test files, and
values the code already case-normalized itself (`x.toUpperCase() === 'MOVIE'`, or a
local initialized from such a call — the `normalizeType`/`jellyfinToUIType` switch
shape).

The rule is enforced at `'error'`. The 27 pre-existing violations were reviewed
and converted to per-occurrence disables with reasons: 18 are fixed-convention
Jellyfin PascalCase values and 9 are MDBList's external `'show'` alias. There is
no file-level ignore list, so new code in those files is checked normally.

The 27, by cause:

| Files                                                                                                                                                                                                                                                               | Count | Cause                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/utils/browse-transforms.ts` (4), `server/proprietary/jellyfin-compat/serializers/base-item.ts` (4), `tasks/builtin/native/watch-sync/jellyfin.ts` (6), `jellyfin-compat/suggestions-handler.ts` (2), `routes/(proprietary)/j/Items/[itemId]/+server.ts` (2) | 18    | Jellyfin's OWN vocabulary — `item.Type` is PascalCase by contract. Want a per-occurrence `// eslint-disable-next-line` + reason, not a rewrite. |
| `server/services/mdblist-api.ts` (2), `server/ai/list-sync.ts` (2), `tasks/builtin/native/providers/mdblist.ts` (1), `plugins/holidays/sources/mdblist.source.ts` (1), `services/foryou-loader.ts` (2), `utils/image-utils.ts` (1)                                  | 9     | The `'show'` provider alias — the token behind the mdblist quota incident. Review these first.                                                  |

**Promotion completed:** the tree was re-measured, each fixed-convention site was
annotated with a narrow reason, the file-level ignores were removed, and the rule
was promoted from `'warn'` to `'error'`.

**Verification (both rules):** `scripts/eslint-plugin-callback-safety/tests/no-bare-media-type-comparison.test.js` and
`scripts/eslint-plugin-callback-safety/tests/no-comparator-on-narrowed-media-type.test.js` carry the two real shipped code
shapes verbatim as `invalid` fixtures, plus `valid` fixtures pinning every exemption.
Each rule's report path was **temporarily gutted and the suites confirmed to go RED**
before being restored — the guard against the §7/§8 "rule reports success while
checking nothing" failure mode. Both suites run in `npm run lint:callback-safety`
(first step of `npm run lint`, and a step in CI's `typecheck.yml`).

**Date:** 2026-07-30

---

### 10. Bare `fetch()` in `src/lib/server/**`

**Rule:** `callback-safety/no-bare-fetch-in-server` (ERROR)

Credentialed or admin-configured outbound
call sites used a bare `fetch()`, which follows an arbitrary redirect by default —
a compromised or misbehaving configured host (or an on-path attacker) can 3xx the
request anywhere the app's network position can reach. The fix collapsed the
redirect-following loop that used to be duplicated in `utils/fetch-utils.ts` and
`utils/fetch-timeout.ts` into ONE shared loop (`fetch-utils.ts`'s unexported
`followRedirectsWithGuard`, imported by both modules' public `fetchWithTimeout`),
migrated the twelve sites onto it, deleted a THIRD, unused, unguarded
`fetchWithTimeout`/`FetchTimeoutError` pair from `runtime-optimizations.ts` (the
finding's "latent" item), and added this rule so a bare `fetch()` cannot silently
reopen the class at a thirteenth site.

**What it catches:** a `CallExpression` whose callee is the bare identifier `fetch`
and which resolves to the GLOBAL `fetch` — i.e. not shadowed by a local
variable/parameter/import named `fetch` anywhere in the enclosing scope chain, and
never a `MemberExpression` callee (`ctx.dep('x').fetch()`, `strategy.fetch()`). The
scope check exists because this codebase genuinely has both traps: a `fetch`
PARAMETER (`defs/recommendations/feed-watching-section.ts`'s
`fetchExactWatchingCandidates(fetch: (limit) => …, …)`) and a `RecommenderStrategy`
interface method literally named `fetch`, implemented by every strategy file. Test
files (`*.test.ts`, `*.integration.test.ts`) are out of scope for the rule entirely.

**Exempt files (the guard implementations themselves):** `utils/fetch-utils.ts`,
`utils/fetch-timeout.ts`, and `tasks/url-safety.ts` (`safeFetch`'s own
implementation) — each must call the real global `fetch` to build its guard.

**Target policy:**
operator-configured **private** targets (the sonic sidecar, ABS, Kavita, the arr
apps, embedding providers) get the **same-origin-only** guard (`fetchWithTimeout`);
**public**/arbitrary targets get the different, public-only, DNS-pinned per-hop
guard in `utils/ssrf-guard.ts` (`resolveSafePublicUrl` + `pinnedFetch`, or
`safeFetch`). Both are legitimate; this rule cannot distinguish them syntactically,
so every pre-existing bare-fetch call site that is safe under the SECOND guard (or
is a fixed, non-admin-configurable public host, or requires a documented exception) carries a per-occurrence
`// eslint-disable-next-line callback-safety/no-bare-fetch-in-server` with a reason
directly above the call.

**The 11 exceptions, by cause:**

| Cause                                                                                                                       | Files (call count)                                                                                                                                                                                                                             | Count |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Already covered by the public-only, DNS-pinned per-hop guard family (`utils/ssrf-guard.ts`) — a different invariant         | `plugins/external-install/fetch-and-verify.ts` (1, the `allowPrivate` branch), `services/radio-metadata/fetcher.ts` (1)                                                                                                                        | 2     |
| Deliberately raw diagnostic probe of the operator's OWN public edge (not a third-party integration)                         | `services/security-self-check/edge-probes.ts` (1)                                                                                                                                                                                              | 1     |
| Fixed, non-admin-configurable public host (api.themoviedb.org, gravatar.com, the push relay token endpoint on lumastra.org) | `ai/embedding-utils.ts` (1), `api/defs/people/search.ts` (1), `services/person.service.ts` (1), `services/image-proxy/service.ts` (2, TMDB person + gravatar), `providers/implementations/tmdb/client.ts` (2), `push/relay-token-enrol.ts` (1) | 8     |

**2026-10-06: 14 → 11.** The two LiveTV sites (`services/livetv/fetch-source.ts`,
`services/livetv/xtream-client.ts`) did the same IP-in-URL swap, and
`services/livetv/hdhomerun-client.ts` re-validated every hop but never pinned at
all. All three now hand the `validateUrl` result (still gated by
`LIVETV_ALLOW_PRIVATE_URLS`, still per hop) to `pinnedFetch`, which also carries the
upstream-proxy dispatcher where one is configured.

**2026-10-06: 19 → 14.** The five `ssrf-guard.ts` call sites that pinned by
swapping the hostname for the IP (`icy-metadata.service.ts`, both generic sites
in `image-proxy/service.ts`, `idp-avatar-sync.service.ts`, the public branch of
`fetch-and-verify.ts`) now call `pinnedFetch`, which pins in the undici
transport and is not a bare `fetch`, so their disables are gone.

**Formerly 21, now 18** — the three sibling gaps this task's own audit found
(`utils/hls-audio-injection.ts`, `services/push/relay-transport.ts`,
`services/livetv/stream-proxy-client.ts`) were reported rather than fixed in
the original C22 pass, per the task's explicit "twelve sites, report don't
silently absorb" scope boundary. **A subsequent review round ruled them
in-scope** ("this round exists because clusters reopen through the sibling
nobody visited") and they are now fixed: all three route through
`fetchWithTimeout`, their `eslint-disable` comments are removed, and each
carries a real two-origin `http.createServer` test (the
`stream-proxy-client.ts` case had literally no redirect handling at all
before this fix — the highest-severity of the three).

**Verification:** `scripts/eslint-plugin-callback-safety/tests/no-bare-fetch-in-server.test.js`
carries the real false-positive traps (the `fetch` parameter, the `strategy.fetch()`
interface method, a `MemberExpression` callee, an unrelated local `fetch` variable)
as `valid` fixtures, and the real defect shape as `invalid` fixtures. Runs in
`npm run lint:callback-safety`.

**Date:** 2026-09-16 (fix round 1)

---

### 11. Unrestricted Collage Cache Warming

**Rule:** `callback-safety/no-unrestricted-access-outside-allowlist`

**File:** `src/lib/server/tasks/builtin/native/sonic-clustering.ts`

**Function / line:** `sonicClusteringTask.execute`, line 370 (`getClusters`).

**Reason:** After committing cluster assignments, this background task pre-renders
all cluster covers into the shared disk cache. The task has no requesting viewer.
The collage byte route checks each viewer's library and age access before reading
that cache.

**Scope:** One `eslint-disable-next-line` on the unrestricted `getClusters` call.
Other unrestricted reads in this file remain checked by the rule.

**Alternatives considered:** A viewer-specific boundary cannot represent this
installation-wide warm-up. A whole-file allowlist would also exempt unrelated
future reads.

**Refactoring path:** Keep this exception local to the warm-up query; remove it if
warm-up moves to a dedicated cache-warming service.

**Approved By:** Maintainer-requested review follow-up.

**Date:** 2026-10-23

---

## Opt-in rules (registered but OFF)

Some custom rules exist and are unit-tested but are deliberately left OFF in the
enforced config because they would fire on pre-existing sites and the repo runs
`eslint --max-warnings=0` (any hit breaks the build). They are kept ready so the
bug class they guard against cannot silently regrow, and so the enable path is a
config one-liner once the existing sites are cleaned up.

### `callback-safety/no-success-in-catch` — false-success in catch

**Status:** registered in `scripts/eslint-plugin-callback-safety/index.js`, unit-tested
(`scripts/eslint-plugin-callback-safety/tests/no-success-in-catch.test.js`, wired into `npm run lint:callback-safety`), and
set to `'off'` in `eslint.config.cjs`.

**What it catches:** a task/function that returns a `{ success: true }`-shaped result
from _inside a `catch` block_ — a swallowed failure reported to the caller as success.
This is the pattern behind the repeated silent-data-staleness incidents: a stage threw,
the catch returned `{ success: true }`, the orchestrator marked the item done, and the
stale data was never refreshed.

**Precise trigger (low false-positive by design):** a `return` whose nearest enclosing
control construct is a `CatchClause`, whose returned expression is — or, via a
conditional/logical branch, directly contains — an object literal with a `success`
property whose value is the literal `true` (an `as const` on `true` is unwrapped and
still counts). It does **not** flag `success: false`, computed/shorthand `success`,
re-throws, happy-path `success: true` outside a catch, or a `success: true` returned by
a nested function declared inside the catch. The `itemsProcessed`/`result`-shaped
success signals are intentionally out of scope (too noisy on legitimate partial-result
returns) — only the literal `success: true` key is flagged.

**Why it's opt-in for now:** there are pre-existing false-success sites across the
codebase (not just the task system). Turning the rule on today would fail
`npm run lint` (`--max-warnings=0`).

**Escape hatch (per occurrence)** for a genuinely-safe catch that must report success
(e.g. a catch that only handles an already-done/idempotent "not an error" condition):

```ts
// eslint-disable-next-line callback-safety/no-success-in-catch
return { success: true };
```

**Enable path:**

1. Scope first to `src/lib/server/tasks/`: temporarily add a `files: ['src/lib/server/tasks/**/*.ts']`
   config block with `'callback-safety/no-success-in-catch': 'warn'` and run `npm run lint`
   to enumerate the hits.
2. Fix each site (return an honest `{ success: false, error }` and let the caller decide,
   or re-throw) or annotate the rare genuinely-safe ones with the escape-hatch comment
   above (with a reason).
3. Once `src/lib/server/tasks/` is clean, flip that scoped entry from `'warn'` to `'error'`.
4. Repeat the fix/annotate pass for the rest of the codebase, then widen the rule to the
   global config block (replace the `'off'` entry) at `'warn'`, and finally `'error'`.

When you need an exception:

1. **Try alternatives first:**
    - Can you extract to a query module?
    - Can you use an existing query module?
    - Can you refactor to avoid the need?

2. **Document the exception:**
    - Add entry to this file with all required fields
    - File path and line numbers
    - Clear justification
    - Alternative approaches considered
    - Refactoring path (if applicable)

3. **Get approval:**
    - Code review
    - Senior engineer sign-off
    - Add to git commit message

4. **Add inline comment:**

    ```typescript
    // ESLint exception documented in docs/dev/eslint-exceptions.md
    // Reason: Complex multi-CTE query specific to this endpoint
    const rows = await sql`SELECT ...`;
    ```

5. **Review periodically:**
    - Re-evaluate during major refactors
    - Check if exception is still needed
    - Update or remove documentation

---

## Statistics

**Total Exceptions:** 46

**By Category:**

- Unrestricted collage cache warming: 1
- Direct SQL in routes: 2
- External IDs access: 0
- sql.unsafe() usage: 3
- TypeScript overloads/assertions: 1
- Library declaration-merge constraints (no-empty-object-type): 1
- Unscoped `media_items` (ingest/admin plane): 4
- Unscoped `media_items` (personal-media disposition/admin plane): 4
- Unscoped `media_items` (surfaced by the 2026-07-30 prose-marker fix): 14
  across 5 files — all audited, none a live access-control hole
- `has_files` comment-satisfied marker: 0 (audited tree-wide; nothing relied on it)
- Media-type dead guards (`no-comparator-on-narrowed-media-type`): 0 — clean tree,
  rule enforced at `error`
- Media-type bare comparisons (`no-bare-media-type-comparison`): 0 unannotated
  violations; rule is enforced at `error`, with fixed-convention provider sites
  using narrow per-occurrence exceptions (see §9)
- Bare `fetch()` in `src/lib/server/**` (`no-bare-fetch-in-server`, finding): 11 call sites annotated, all already safe under a
  different guard or a fixed public host (see §10) — the 3 sibling gaps found
  during the original audit were fixed in fix round 1, not left as exceptions;
  rule enforced at `error`

**Last Reviewed:** 2026-09-16 (fix round 1)

---

## Related Documentation

- [AGENTS.md](../../AGENTS.md) - Project architectural guidelines

## Music preview shallow navigation

`src/lib/utils/music-preview-navigation.ts` has two local exceptions to
`svelte/no-navigation-without-resolve`. Both history updates start with
SvelteKit's current `page.url`, preserving the deployment base and existing
query parameters. Applying `resolve()` to this already resolved URL is
unnecessary; the helpers only add or remove the preview query parameter.

## Analyzer policy skip predicates

`analyzerPolicySkipSql` in
`src/lib/server/database/queries/media-segment-input.queries.ts` has local
exceptions to `callback-safety/no-unscoped-media-items` and
`callback-safety/require-has-files-with-active-status`. It returns a boolean
predicate for the privileged analyzer and admin timeline, rather than library
cards or user-visible catalog rows. The predicate must recognize current
configuration-based skips even for items without files; applying `has_files`
would incorrectly project those deliberate skips as pending work. The caller
still restricts the subject and validates the effective detector configuration.

## Admin artwork availability projection

`effectivePosterSql` in `src/lib/server/database/queries/image-descriptor.queries.ts`
has a local exception to `callback-safety/no-unscoped-media-items`. It returns
one boolean for an item already selected by the admin browser's outer scope,
including at most three ancestor edges for display-time artwork fallback. It
cannot list media or grant access. Browser routes enforce admin access; list,
count and missing-artwork filters retain their existing outer scope. Query
integration tests compare this projection with the image descriptor and verify
that the list, badge input and counts agree without relying on a blurhash.

## Frozen database hotspot baseline

`src/lib/server/database/queries/hotspot-baselines.test-support.ts` uses one
`callback-safety/require-has-files-with-active-status` suppression for the frozen
Perfect Match SELECT. It intentionally includes both available and requestable
catalog items, matching `featured-pick.queries.ts`. Adding `has_files = true` here
would change the reference results and invalidate the differential tests. Only
integration tests import this support module.

## Admin file language inventory

`getFileLanguageSummaries` in
`src/lib/server/database/queries/admin-language-summary.queries.ts` has a local
exception to `callback-safety/no-unscoped-media-items` for its physical-file query.
Its media join reads only original-language metadata for the supplied file IDs,
including the series ancestor of an episode. Both callers, the admin media files
and episodes EndpointDefs, require `auth: { kind: 'admin' }` before loading this
inventory. The helper cannot list library media or grant access. A future caller
outside those admin endpoints must establish its own media access scope first.

### Internet radio origin lookup

`src/lib/server/database/queries/radio-stream.queries.ts` disables
`callback-safety/no-unscoped-media-items` on its internal origin lookup. The shared
playback-start handler checks `checkMediaAccess` before starting any media kind,
and the radio proxy checks it again before fetching the origin. The lookup returns
only an internal URL; no public response includes it. Keeping the query pure avoids
moving request authorization into the database layer.

## Music edit recovery and conservative hierarchy repair

`src/lib/server/services/music/{edit-recovery,album-artist-edit,orphan-link-repair}.ts`
use local `callback-safety/no-unscoped-media-items` exceptions for exact recovery
participants and internal maintenance. Recovery must retain and validate original
parents and credited identities independently of a viewer's library filter. The
admin metadata endpoint authorizes reads and Undo; snapshots and row locks fence
the writes. Orphan repair uses unanimous file evidence and unique existing owners
in the same library scope, with locked, dismissed, missing and conflicting rows
blocking the repair. These queries cannot supply a user-facing catalog listing.

`previewFolderCompilations` in `folder-compilation-repair.ts` has the same local
exception for the admin-selected album and bounded candidate/evidence reads. It
returns only a proposal containing that album and never applies a merge.
`upgradeReviewedCollaborationFingerprints` in `collaboration-review.queries.ts`
uses an exception to carry forward only dispositions matching their exact legacy
fingerprint during migration; it cannot mark an unreviewed artist as reviewed.
Real database integration tests cover recovery conflicts, hierarchy abstentions,
unchanged catalog rows during previews and legacy fingerprint conversion.
