# providers/

Domain-specific provider clients, normalization helpers, and provider-invocation
plumbing for the new SDK metadata providers. Phase 3 of the plugin migration
(2026-05-17) made this the canonical home for everything provider-related that
isn't a `defineProvider` declaration; the declarations live in
`src/lib/server/tasks/builtin/native/providers/`.

## Files

| File                        | What                                                                    | When to read                                                          |
| --------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `provider-types.ts`         | Core shared types: `MediaType`, `ExternalId`, `ExternalIdWrite`         | Importing shared provider type definitions                            |
| `provider-config-loader.ts` | Loads provider config from DB into runtime caches                       | Reloading config after admin PATCH/PUT                                |
| `episode-group-provider.ts` | Episode group provider for alternative series ordering                  | Implementing alternative episode orderings                            |
| `normalize.ts`              | Provider-id dispatched `normalizeSearchResult` / `normalizeDetail`      | Turning raw provider items into `MetadataCandidate` / `MediaMetadata` |
| `encode-id.ts`              | `encodeDetailId(providerId, mediaType, rawId)` per-provider id encoding | Building the `id` parameter for `invokeProviderDetail()`              |

## Subdirectories

All concrete provider clients live under `implementations/` (one subdir per
provider). Import from these paths directly.

| Directory                      | What                                                                                                                                                                                                    | When to read                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `implementations/tmdb/`        | TMDB domain client (`client.ts` = `TMDBApiService`), `types.ts`, normalize, series-children, resolve-external, trending + cross-ref helpers, episode-group-adapter. Barrel: `index.ts`                  | Importing `tmdbApi`, TMDB type definitions, or any TMDB-specific helper — `$lib/server/providers/implementations/tmdb`               |
| `implementations/jellyfin/`    | Jellyfin metadata normalize + series-children helpers                                                                                                                                                   | Adding Jellyfin-specific helpers; the Jellyfin server clients still live in `src/lib/server/jellyfin/`                               |
| `implementations/anidb/`       | AniDB config loader + normalize + series-children                                                                                                                                                       | AniDB credential resolution; the native provider at `tasks/builtin/native/providers/anidb.ts` dynamically imports `config-loader.js` |
| `implementations/mdblist/`     | MDBList normalize (search throws — no title-search API)                                                                                                                                                 | Detail normalization for MDBList batch path                                                                                          |
| `implementations/musicbrainz/` | MusicBrainz: `api-client.ts`, `acoustid.ts` (fpcalc + batched AcoustID lookup + match selection, used only by the `acoustid-fingerprint` task), `enrichment.ts`, `lrclib.ts`, `cover-art.ts`, normalize | Music enrichment, fingerprinting, lyric/album-art lookups                                                                            |

## Invoking providers from non-task code

Services, route handlers, and other non-task callers DO NOT construct a
`PluginContext` directly. Use the invocation helpers in
`src/lib/server/tasks/plugin-context.ts`:

```ts
import {
    invokeProviderSearch,
    invokeProviderDetail,
    invokeProviderChildList,
    isProviderConfigured,
    getProvidersByPriority,
} from '$lib/server/tasks/plugin-context.js';

import { normalizeSearchResult, normalizeDetail } from '$lib/server/providers/normalize.js';
import { encodeDetailId } from '$lib/server/providers/encode-id.js';

const providers = getProvidersByPriority();
for (const provider of providers) {
    if (!(await isProviderConfigured(provider.id))) continue;
    const raw = await invokeProviderSearch(provider.id, {
        type: 'movie',
        query: title,
        year,
    });
    const candidates = raw
        .map((r) => normalizeSearchResult(provider.id, r, 'movie', year))
        .filter((c) => c !== null);
    // ...
}
```

For TMDB-specific typed methods (`getMovieCredits`, `getEpisodeGroups`, etc.),
import `tmdbApi` from `'$lib/server/providers/implementations/tmdb'` directly —
those don't fit the generic `search/detail/childList` contract.

## What was removed

The legacy plugin directories at `src/lib/server/plugins/builtin/metadata-providers/`
(5 directories: mdblist, anidb, musicbrainz, jellyfin, tmdb) were deleted on
2026-05-17. Every metadata provider now lives only in the new task registry as a
`defineProvider` declaration at `src/lib/server/tasks/builtin/native/providers/`.

The compat shim `LegacyMetadataProvider` (`legacy-adapter.ts`) was also removed —
all consumers (file-scanner, video-processor, metadata-sync-single, metadata-matching)
now take `providerId: string` and dispatch through the invocation helpers above.

Wave 6.5-B Phase 3 (2026-06-05) collapsed the five flat per-provider subdirs
(`providers/{tmdb,jellyfin,anidb,mdblist,musicbrainz}/`) into `implementations/`.
The TMDB tree was reconciled against the pre-existing `implementations/tmdb/`:
`client.ts` is the single canonical `TMDBApiService`; the redundant
`tmdb/api-service.ts` and `tmdb/types.ts` re-export shims were deleted.

To add a new metadata provider, create a `defineProvider({...})` declaration in
`src/lib/server/tasks/builtin/native/providers/` (use one of the existing 5 as a
template) and add a normalize module under
`src/lib/server/providers/implementations/<id>/normalize.ts` plus a `NORMALIZERS`
entry in `providers/normalize.ts`.
