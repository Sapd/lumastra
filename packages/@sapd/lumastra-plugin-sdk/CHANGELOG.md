# @sapd/lumastra-plugin-sdk Changelog

## 0.2.0-alpha.1 (2026-06-13)

> Pre-1.0: expect breaking changes between any two releases.

**Breaking changes**

- `defineTask` now **throws** `PluginDefinitionError` (instead of logging a
  `console.warn`) when `exclusiveWith.ttl` is shorter than `timeout.hard`.
  A TTL shorter than the hard timeout means the SETNX identity key can expire
  while the run is still executing, letting a duplicate concurrent run slip
  through and defeating the exclusivity guarantee.

    **Migration**: raise `exclusiveWith.ttl` to at least the value of
    `timeout.hard` (with margin recommended). The host's derived-floor clamp
    raises the effective SETNX TTL to `max(timeout.hard, schedule.every) + 10s`
    at claim time, but the manifest must not declare an obviously-wrong value.

## Unreleased (pre-1.0 alpha)

### 2026-10-06 (resume after restart)

- `TaskDefinition.resumeAfterRestart` — a manually started run of this task is
  continued in a new run after a worker restart instead of failing. Declare it
  only when re-running the work is safe. Not allowed on a `pipeline.of` stage.
- `TaskContext.checkpoint` (`RunCheckpoint`: `load()` / `save(value)`) — a
  saved position shared by a run and the runs that resume it. Present only on
  resumable runs; absent under `isolation: 'worker'`.
- `TriggerSchema.resume` — `{ rootRunId, previousRunId, count, max }` on a run
  the host started to continue an interrupted one.

### 2026-09-27 (settings field hints)

- `SettingField.dependsOn` — key of a boolean field; the admin UI shows the
  field only while that switch is on.
- `SettingField.groups` — on an `array` field, the value is a list of user
  group names; the admin UI renders a group picker.
- `SettingsConfig.canToggle` removed. It promised an operator on/off switch
  that nothing implemented (the settings endpoint rejects `enabled: false`);
  gate a plugin in `isAvailable(ctx)` instead.
- `array` field values are now stored as a real `string[]` (the admin form
  used to save the comma-separated text as one string). Read them as arrays.

### 2026-05-18 (catalog / media-items convenience APIs)

- Added `ctx.catalog`, `ctx.mediaItems`, `ctx.mediaFiles` convenience APIs on
  both `PluginContext` and `TaskContext`, replacing raw SQL for the most
  common media operations. Direct writes to `external_ids` remain forbidden —
  use `ctx.catalog.upsertExternalId` for composite-key integrity (provider id
  `1429` resolves to a movie AND a series on TMDB; raw INSERTs that drop or
  mistype `media_type` silently corrupt cross-media-type lookups, see
  memory `bug_catalog_withTx_reserved_sql.md`). - `ctx.catalog.upsertExternalId({ provider, externalId, mediaType, mediaItemId })`
  — transactional, wraps `CatalogService.upsertExternalId` (stale-mapping
  cleanup + lifecycle hook fan-out). - `ctx.catalog.findByExternalId({ provider, externalId, mediaType })` — the
  symmetric read; returns `{ mediaItemId } | null`. `mediaType` is mandatory
  (composite key matters). - `ctx.mediaItems.getById(id)` / `ctx.mediaItems.search(query, opts?)` —
  returns a narrow `MediaItemSummary` DTO (`id, title, year, mediaType,
overview, libraryAddedAt`); internal fields stay encapsulated. - `ctx.mediaFiles.findByPath(absolutePath)` — returns `{ mediaFileId,
mediaItemId }` (mediaItemId null when the file is scanned but unlinked). - `mediaType` is normalized at the boundary: `'Movie'`, `'MOVIE'`,
  `'movie'`, `'series'` → `'tv'`, `'song'` → `'track'`. Plugin authors
  passing non-canonical strings get the right behaviour, not a silent miss. - New SDK type exports: `MediaType`, `MediaItemSummary`, `CatalogStore`,
  `MediaItemsStore`, `MediaFilesStore`. - Testing helpers (`@sapd/lumastra-plugin-sdk-testing`): `mockContext()`
  accepts `catalog`, `mediaItems`, `mediaFiles` seeds that match the same
  pattern as `userCredentials`. In-memory implementations honour the same
  `mediaType` normalization as the host so plugin tests behave identically
  to plugin runtime.

### 2026-05-18

- Added `ctx.userCredentials` API for per-user secret storage on both
  `PluginContext` and `TaskContext`. Wraps `plugin_user_credentials`,
  encrypts via the same AES-GCM master key as `ctx.secrets`, and scopes
  every call to the calling plugin's id. Methods: `get(userId, key)`,
  `set(userId, key, value, opts?)`, `delete(userId, key)`, `listKeys(userId)`,
  `listLinkedUsers()`, `listUsersWithKey(key)`. Replaces raw SQL access to
  `plugin_user_credentials` from plugin code. `get()` returns the stored
  value even when `expires_at` has passed so plugins can inspect and refresh
  expired tokens; use `ctx.secrets.getUser` if you need fail-on-expiry +
  audit logging. New SDK type export: `UserCredentialStore`.
- Package published under the `@sapd/lumastra-plugin-sdk` name (the `@sapd`
  npm scope, matching the project's established `@sapd` / `ghcr.io/sapd`
  identity).
- Testing helpers (`mockContext`, `runTask`, `expectRun`, `mockHttpClient`,
  `mockCache`, `mockFfmpegRunner`, `mockLogger`) split out into sibling
  workspace package `@sapd/lumastra-plugin-sdk-testing`; the SDK no longer
  exposes a `./testing` subpath.
- `peerDependencies` pinned to real ranges: `postgres: "^3.4.0"`,
  `zod: "^4.0.0"` (were both `"*"`).

### Wave 6.5-C (2026-05-17)

**Breaking changes**

- `defineWatchSync` — `WatchSyncDefinition` interface rewritten:
    - `push` and `pull` handlers now receive a `PluginContext` as first argument
    - New auxiliary types ported verbatim from legacy `WatchSyncPlugin`:
      `WatchSyncPushResult`, `WatchSyncPushSession`, `WatchSyncPullResult`,
      `WatchSyncPullCursor`, `WatchSyncItem`, `WatchSyncItemStatus`
    - `isAvailable(ctx)` — new optional hook; return `false` to mark this
      provider as unavailable for the current cycle (surfaces as
      `skippedUnavailable` in admin UI, not as a failure)
    - `pushResumePosition(ctx, userId, item)` — new optional hook for writing
      back a play position from the remote source
    - `resolveUserId(ctx, internalUsername)` — new optional hook to translate
      an internal Lumastra username to the provider's user ID

**New exports**

- `WatchSyncPushResult`, `WatchSyncPushSession`, `WatchSyncPullResult`,
  `WatchSyncPullCursor`, `WatchSyncItem`, `WatchSyncItemStatus`

### Wave 6.5-D (2026-05-16)

**New features**

- `PluginContext.signal` — `AbortSignal` wired to the job's abort channel;
  pass to all HTTP calls and long-running loops
- `ProviderDefinition.search` is now optional — providers that only support
  detail (e.g. ID-based lookup only) no longer need a stub `search` method
- `ProviderDefinition.batchLookup(ctx, ids)` — new optional hook for batch
  ID resolution (used by MDBList and similar providers)
- `SettingField.validation` — optional `{ min?, max?, pattern? }` object for
  admin-UI field validation
- `FailedItem.taskRunId` — optional string for linking a failure to a specific
  run in the admin UI
- `ProviderDefinition.metadata.priority` — operator-overridable sort weight
  for the metadata chain (lower = higher priority)

### Wave 6.5-A / 6.5-B (2026-05)

- All 38 builtin plugins migrated from legacy `createSyncPlugin` /
  `createMetadataProviderPlugin` contracts to `defineTask` / `defineProvider` /
  `defineWatchSync` / `defineFeature` / `defineIntegration`
- `defineProvider` gains `metadata?: { priority, fieldAuthorities, cacheTtlHours }`

### Initial release (Wave 1 – 5, 2026-05)

- `defineTask`, `defineProvider`, `defineTrickplayProvider`, `defineWatchSync`,
  `defineFeature`, `defineIntegration`
- `TaskError`, `PluginDefinitionError`
- `COST_KINDS`, `RESOURCE_CLASSES`
- Testing helpers: `mockContext`, `expectRun`, `runTask`, `mockHttpClient`,
  `mockCache`, `mockLogger` (under `./testing` subpath — moved to
  `@sapd/lumastra-plugin-sdk-testing` on 2026-05-18)
