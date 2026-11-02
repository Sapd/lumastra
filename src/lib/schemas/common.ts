// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Common Zod schemas shared across API routes
 *
 * These schemas provide consistent validation for common patterns
 * like pagination, external IDs, media types, and visibility.
 */

import { z } from 'zod';

// ============================================================================
// Numeric primitives
// ============================================================================

/**
 * Shared integer schema. Use for any whole-number field (pagination bounds,
 * counts, indices, ticks, ports, etc.) so the emitted OpenAPI carries
 * `type: integer` instead of `type: number`. Equivalent to `z.number().int()`
 * — no change to runtime validation semantics, only the declared format.
 *
 * The generator strips the JS-safe-integer min/max bound that `z.int()` would
 * otherwise emit (see scripts/openapi/generate.ts), so callers don't need to
 * worry about a noisy ±9007199254740991 appearing in the spec.
 */
export const intSchema = (): z.ZodNumber => z.number().int();

// ============================================================================
// Pagination
// ============================================================================

/**
 * Standard pagination parameters with coercion from string query params
 */
export const paginationSchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationParams = z.infer<typeof paginationSchema>;

/**
 * Optional pagination (for endpoints that support both paginated and unpaginated)
 */
export const optionalPaginationSchema = z.object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type OptionalPaginationParams = z.infer<typeof optionalPaginationSchema>;

// ============================================================================
// External IDs (Provider-Agnostic)
// ============================================================================

/**
 * External IDs schema supporting multiple providers.
 * At least one provider ID must be present.
 */
export const externalIdsSchema = z
    .object({
        /** Internal DB UUID — primary identifier for DB-backed items (episodes, media) */
        internal: z.string().optional(),
        tmdb: z.union([z.string(), z.number()]).transform(String).pipe(z.string()).optional(),
        imdb: z.string().optional(),
        tvdb: z.union([z.string(), z.number()]).transform(String).pipe(z.string()).optional(),
        trakt: z.union([z.string(), z.number()]).transform(String).pipe(z.string()).optional(),
        mal: z.union([z.string(), z.number()]).transform(String).pipe(z.string()).optional(),
        anilist: z.union([z.string(), z.number()]).transform(String).pipe(z.string()).optional(),
        /** Deprecated: older clients' Jellyfin item id, mapped via the database. */
        jellyfin: z
            .string()
            .optional()
            .describe(
                'Deprecated: a Jellyfin item id from an older client. Mapped to the internal id when Jellyfin sync knows it, otherwise ignored; never returned.',
            ),
    })
    .refine((ids) => Object.values(ids).some((v) => v !== undefined && v !== ''), {
        message: 'At least one external ID must be provided',
    });

export type ExternalIds = z.infer<typeof externalIdsSchema>;

/**
 * Partial external IDs (for optional lookups where missing IDs are acceptable)
 */
export const partialExternalIdsSchema = z.object({
    internal: z.string().optional(),
    tmdb: z.union([z.string(), z.number()]).transform(String).pipe(z.string()).optional(),
    imdb: z.string().optional(),
    tvdb: z.union([z.string(), z.number()]).transform(String).pipe(z.string()).optional(),
    trakt: z.union([z.string(), z.number()]).transform(String).pipe(z.string()).optional(),
    mal: z.union([z.string(), z.number()]).transform(String).pipe(z.string()).optional(),
    anilist: z.union([z.string(), z.number()]).transform(String).pipe(z.string()).optional(),
    /** Deprecated: older clients' Jellyfin item id, mapped via the database. */
    jellyfin: z
        .string()
        .optional()
        .describe(
            'Deprecated: a Jellyfin item id from an older client. Mapped to the internal id when Jellyfin sync knows it, otherwise ignored; never returned.',
        ),
});

export type PartialExternalIds = z.infer<typeof partialExternalIdsSchema>;

// ============================================================================
// Media Types
// ============================================================================

/**
 * Standard media types for TMDB-style APIs (lowercase).
 *
 * INPUT-widened: accepts the canonical public `'series'` in addition to the
 * legacy/internal `'tv'` (and `'movie'`), normalizing `'series' → 'tv'` so the
 * internal/storage token stays lowercase `'tv'` (composite-key resolution
 * queries `media_items.media_type = 'tv'`). Output type is `'movie' | 'tv'`.
 * OUTPUT schemas must use {@link publicMovieSeriesSchema}, not this.
 */
export const mediaTypeSchema = z.preprocess(
    (val) => (val === 'series' ? 'tv' : val),
    z.enum(['movie', 'tv']),
);
export type MediaType = z.infer<typeof mediaTypeSchema>;

/**
 * Extended media types including episodes
 */
export const extendedMediaTypeSchema = z
    .enum(['movie', 'tv', 'episode', 'artist', 'album', 'track', 'music'])
    .meta({ id: 'extendedMediaType' });
export type ExtendedMediaType = z.infer<typeof extendedMediaTypeSchema>;

/**
 * Public counterpart of {@link extendedMediaTypeSchema}.
 *
 * Same wider vocabulary (playlists hold music rows, so `artist`/`album`/`track`
 * must survive), but the series discriminator is `series` — never the internal
 * `tv`. Use this for RESPONSE shapes; `extendedMediaTypeSchema` stays lenient
 * for request bodies that still accept `tv`.
 *
 * `playlistItemInfoSchema` already declared the canonical vocabulary this way;
 * `playlistItem` / `playlistCoverItem` did not, which is how `tv` reached
 * `GET /api/v1/playlists/{id}/items`.
 *
 * Deliberately a STRICT enum, not a `coerceLegacyTvToSeries` preprocess. A
 * preprocess on a RESPONSE schema quietly repairs a `tv` body during validation,
 * which is exactly what let this leak sit unnoticed — the contract gate parsed
 * the drift as valid. Strict means a producer that still emits `tv` fails loudly.
 */
export const publicExtendedMediaTypeSchema = z
    .enum(['movie', 'series', 'episode', 'artist', 'album', 'track', 'music', 'audiobook'])
    .meta({ id: 'publicExtendedMediaType' });
export type PublicExtendedMediaType = z.infer<typeof publicExtendedMediaTypeSchema>;

/**
 * Jellyfin media types (PascalCase)
 */
export const jellyfinMediaTypeSchema = z
    .enum(['Movie', 'Episode', 'Series', 'Season', 'Audio', 'MusicAlbum'])
    .meta({ id: 'jellyfinMediaType' });
export type JellyfinMediaType = z.infer<typeof jellyfinMediaTypeSchema>;

/**
 * Database media types (lowercase — canonical form)
 */
export const dbMediaTypeSchema = z
    .enum([
        'movie',
        'tv',
        'episode',
        'season',
        'audio',
        'audiobook',
        'book',
        'manga',
        'comic',
        'tvchannel',
        'podcast',
        'music',
    ])
    .meta({ id: 'dbMediaType' });
export type DbMediaType = z.infer<typeof dbMediaTypeSchema>;

/**
 * Canonical PUBLIC media-type discriminator emitted in API responses.
 *
 * `'series'` is the canonical public value for TV shows and replaces legacy
 * `'tv'`. Provider-leaked / storage-only values (`tvchannel`, `sonarr`,
 * `radarr`, `home_video`, …) are NOT part of the public contract and must be
 * mapped to `null` (via `toPublicMediaType`) rather than surfaced.
 *
 * `'audiobook'` IS part of the contract: AudiobookShelf books are ingested as
 * real `media_items` rows (`media_type = 'audiobook'`) and are served by the
 * `/audiobooks` destination, so they need a public discriminator. They are
 * still excluded from the recommender — that exclusion lives in the
 * type-scoped embedding generators, not here.
 *
 * This is the OUTPUT boundary type. Storage stays lowercase `'tv'`; the
 * `isSeries()`/`isMovie()` comparators still accept both on INPUT.
 */
/**
 * Coerce the legacy/storage token 'tv' (and 'show') → canonical 'series' at the
 * OUTPUT boundary. This makes the public schemas robust to producers that still
 * emit the raw stored 'tv' token: their output validates and is normalized to
 * 'series', so clients (and the OpenAPI contract) only ever see 'series'.
 * Storage stays 'tv'; this only affects the public response shape.
 */
export const coerceLegacyTvToSeries = (v: unknown): unknown =>
    v === 'tv' || v === 'show' ? 'series' : v;

export const publicMediaTypeSchema = z
    .preprocess(
        coerceLegacyTvToSeries,
        z.enum(['movie', 'series', 'season', 'episode', 'track', 'album', 'artist', 'audiobook']),
    )
    .meta({
        id: 'PublicMediaType',
        description:
            'Canonical PUBLIC media-type discriminator. `series` is the value for TV shows — the ' +
            'stored `tv`/`show` token is never emitted. `audiobook` items appear on user-state ' +
            'surfaces (e.g. continue-watching) as soon as an AudiobookShelf library is configured, ' +
            'so a client with no audiobook UI must filter by type rather than assume every item is ' +
            'a video.',
    });
export type PublicMediaType = z.infer<typeof publicMediaTypeSchema>;

/**
 * Every value `library_paths.provider` may hold.
 *
 * Exported as a plain tuple rather than a shared `z.enum` instance so each call
 * site builds its own schema and the value stays INLINE in the generated
 * OpenAPI document (a shared instance would be hoisted into a `$ref`, changing
 * the published contract's shape for an unrelated reason).
 *
 * The list is duplicated in three other places by necessity — the DB
 * `library_paths_provider_check` constraint, the `LibraryPathProvider` TS union
 * in `library-paths.queries.ts`, and the storage admin page's local row type.
 * Nothing links them at compile time, and a miss shows up as an opaque 400 or a
 * stripped response field rather than a constraint violation, so
 * `library-paths.queries.test.ts` carries a drift guard that pins the union
 * against this tuple.
 *
 * `'audiobookshelf'` is a REMOTE provider: its `library_paths.path` is the
 * synthetic `abs://<absLibraryId>` sentinel, not a directory. See
 * `FILESYSTEM_LIBRARY_PROVIDERS` / `REMOTE_LIBRARY_PROVIDERS`.
 */
export const LIBRARY_PATH_PROVIDERS = [
    'tmdb',
    'jellyfin',
    'anidb',
    'tvdb',
    'musicbrainz',
    'audiobookshelf',
] as const;

/**
 * Providers whose `library_paths.path` is a synthetic `<scheme>://<id>` URI
 * naming a library on a remote server, not a directory.
 *
 * Lives HERE rather than only in `library-paths.queries.ts` because the
 * classification is needed on both sides of the wire: request schemas
 * (`libraryPathCreateBodyRefined`) and the admin add-library form must decide
 * "does this provider take a path or a remote library id?", and neither may
 * import a server-only query module. `library-paths.queries.ts` re-exports this
 * list under its established name, so it remains the single source of truth and
 * the existing `FILESYSTEM ∪ REMOTE === LIBRARY_PATH_PROVIDERS` drift guard
 * still covers it.
 */
export const REMOTE_LIBRARY_PROVIDER_NAMES = [
    'audiobookshelf',
] as const satisfies readonly (typeof LIBRARY_PATH_PROVIDERS)[number][];

/**
 * Narrowed public discriminator for movie/series-only surfaces (the common
 * case). Same legacy-'tv' coercion as {@link publicMediaTypeSchema}.
 */
export const publicMovieSeriesSchema = z
    .preprocess(coerceLegacyTvToSeries, z.enum(['movie', 'series']))
    .meta({ id: 'PublicMovieSeriesType' });
export type PublicMovieSeriesType = z.infer<typeof publicMovieSeriesSchema>;

// ============================================================================
// Visibility
// ============================================================================

/**
 * Playlist/content visibility
 */
export const visibilitySchema = z.enum(['private', 'public']).meta({ id: 'visibility' });
export type Visibility = z.infer<typeof visibilitySchema>;

// ============================================================================
// Common Patterns
// ============================================================================

/**
 * UUID parameter (for path params and opaque database keys).
 *
 * Uses `.guid()`, NOT `.uuid()`, and so should every schema that validates an
 * id this application stores in a postgres `uuid` column. Zod 4's `.uuid()`
 * enforces the RFC 9562 version nibble (1-8) and variant nibble (8/9/a/b), so
 * it rejects hand-authored ids — the kind migrations, seeds and fixtures use
 * (`00000000-0000-0000-0000-0000000000a1`) — even though postgres stores them
 * happily and the rows are real and reachable. It special-cases the nil and max
 * UUIDs, so `…-000000000000` passes while `…-0000000000a1` does not, which
 * makes the failure easy to misread: the error says "Invalid UUID" about a
 * perfectly valid UUID.
 *
 * These ids are opaque keys. They are compared against ids already read from
 * the database and reach SQL only as bound parameters, so the version bits
 * carry no meaning and stricter parsing protects nothing — it only rejects
 * valid rows. `.guid()` still enforces the full 8-4-4-4-12 hex shape (so a
 * handler that does anything other than parameterize the value is still safe)
 * and still emits `format: uuid` in the published OpenAPI document; only the
 * `pattern` widens.
 *
 * Use `.uuid()` only where v4-ness or v7 ordering is genuinely load-bearing,
 * and say why in a comment at the call site.
 */
export const uuidSchema = z.string().guid().meta({ id: 'uuid' });

/**
 * Positive integer ID (for database IDs, TMDB IDs, etc.)
 */
export const positiveIntSchema = z.coerce.number().int().positive();

/**
 * Non-empty string (trimmed)
 */
export const nonEmptyStringSchema = z
    .string()
    .min(1)
    .transform((s) => s.trim())
    .pipe(z.string().min(1));

/**
 * Optional string that becomes undefined if empty
 */
export const optionalStringSchema = z
    .string()
    .optional()
    .transform((s) => s?.trim() || undefined);

/**
 * Optional string that also tolerates an explicit JSON `null` and normalizes it
 * to `undefined`. Use for request fields where non-Swift clients may serialize an
 * absent value as `null` rather than omitting the key — the plain
 * `optionalStringSchema` rejects `null` and would 422 such payloads.
 */
export const nullableOptionalStringSchema = z
    .string()
    .nullish()
    .transform((s) => s?.trim() || undefined);

/**
 * Boolean with string coercion (for query params)
 */
export const coerceBooleanSchema = z.union([z.boolean(), z.string()]).transform((val) => {
    if (typeof val === 'boolean') return val;
    return val === 'true' || val === '1';
});

/**
 * Rating value (1-10 scale)
 */
export const ratingSchema = z.coerce.number().int().min(1).max(10);

/**
 * Position in milliseconds (for playback)
 */
export const positionMsSchema = z.coerce.number().int().min(0);

/**
 * Position in seconds (for playback) — fractional, matches HTMLMediaElement.currentTime.
 * Watch-together carries playback positions in seconds (the session stores
 * `currentTime` in seconds), so its request/state position fields must accept
 * floats; validating them as integer milliseconds rejected every real position.
 */
export const positionSecondsSchema = z.coerce.number().min(0);

/**
 * Position in ticks (Jellyfin uses 10,000 ticks per millisecond)
 */
export const positionTicksSchema = z.coerce.number().int().min(0);

/**
 * Timestamp schema (ISO string or Date)
 */
export const timestampSchema = z
    .union([z.string().datetime(), z.date()])
    .transform((val) => (val instanceof Date ? val.toISOString() : val));

// ============================================================================
// Sorting
// ============================================================================

/**
 * Sort direction
 */
export const sortDirectionSchema = z.enum(['asc', 'desc']).meta({ id: 'sortDirection' });
export type SortDirection = z.infer<typeof sortDirectionSchema>;

/**
 * Common sort fields for media
 */
export const mediaSortFieldSchema = z
    .enum(['title', 'year', 'rating', 'added', 'updated', 'popularity'])
    .meta({ id: 'mediaSortField' });
export type MediaSortField = z.infer<typeof mediaSortFieldSchema>;

// ============================================================================
// Search/Filter
// ============================================================================

/**
 * Basic search query params with pagination
 * For more comprehensive search, use searchQuerySchema from browse.ts
 */
export const basicSearchQuerySchema = z.object({
    q: z.string().min(1).max(200).optional(),
    query: z.string().min(1).max(200).optional(),
    ...optionalPaginationSchema.shape,
});

export type BasicSearchQueryParams = z.infer<typeof basicSearchQuerySchema>;

/**
 * Year range filter
 */
export const yearRangeSchema = z.object({
    yearFrom: z.coerce.number().int().min(1900).max(2100).optional(),
    yearTo: z.coerce.number().int().min(1900).max(2100).optional(),
});

export type YearRange = z.infer<typeof yearRangeSchema>;

// ============================================================================
// Upcoming Exclusions
// ============================================================================

/**
 * Exclude series body.
 *
 * The mute is keyed by id: `mediaId` (catalog series or movie) wins, then
 * `tmdbId` (with `mediaType`, default series) for a title that is not in the
 * catalog. One of the two ids is required; `seriesName` is only the display
 * label (always required), never a key.
 */
export const excludeSeriesBodySchema = z
    .object({
        seriesName: z.string().min(1).max(512),
        mediaId: z.string().guid().optional(),
        tmdbId: z
            .union([z.number().int().positive(), z.string().regex(/^[1-9][0-9]{0,8}$/)])
            .transform((value) => String(value))
            .optional(),
        mediaType: z.enum(['series', 'movie']).optional(),
    })
    .refine((body) => body.mediaId !== undefined || body.tmdbId !== undefined, {
        message: 'mediaId or tmdbId is required',
    });

export type ExcludeSeriesBody = z.infer<typeof excludeSeriesBodySchema>;

/** Remove series exclusion body: the flag row `id` from the list. */
export const removeExclusionBodySchema = z.object({
    id: z.string().guid(),
});

export type RemoveExclusionBody = z.infer<typeof removeExclusionBodySchema>;

// ============================================================================
// Pinned Genres
// ============================================================================

/**
 * Pin genre body
 */
export const pinGenreBodySchema = z.object({
    genre: z.string().min(1).max(255),
});

export type PinGenreBody = z.infer<typeof pinGenreBodySchema>;

/**
 * Unpin genre body
 */
export const unpinGenreBodySchema = z.object({
    genre: z.string().min(1).max(255),
});

export type UnpinGenreBody = z.infer<typeof unpinGenreBodySchema>;

// ============================================================================
// Admin Nav Pins
// ============================================================================

export const adminNavPinBodySchema = z.object({
    href: z.string().min(1).max(255).startsWith('/admin/'),
    label: z.string().min(1).max(100),
});

export type AdminNavPinBody = z.infer<typeof adminNavPinBodySchema>;

export const adminNavUnpinBodySchema = z.object({
    href: z.string().min(1).max(255).startsWith('/admin/'),
});

export type AdminNavUnpinBody = z.infer<typeof adminNavUnpinBodySchema>;

// ============================================================================
// Continue Watching
// ============================================================================

/**
 * Clear continue watching body
 */
export const clearContinueWatchingBodySchema = z.object({
    type: z.enum(['movies', 'episodes', 'both']),
});

export type ClearContinueWatchingBody = z.infer<typeof clearContinueWatchingBodySchema>;

// ============================================================================
// OAuth / Device Authorization
// ============================================================================

/**
 * User code body for device authorization
 */
export const userCodeBodySchema = z.object({
    user_code: z.string().regex(/^(?:[A-Za-z0-9]{8}|[A-Za-z0-9]{4}-[A-Za-z0-9]{4})$/),
});

export type UserCodeBody = z.infer<typeof userCodeBodySchema>;

// ============================================================================
// Watched Status
// ============================================================================

/**
 * Optional body for marking items as watched.
 * When provided, also updates the user_watch_history table.
 */
export const watchedBodySchema = z.object({
    externalIds: partialExternalIdsSchema.optional(),
    mediaType: mediaTypeSchema.optional(),
    key: z.string().optional(),
});

export type WatchedBody = z.infer<typeof watchedBodySchema>;

// ============================================================================
// Common Response Schemas (for API client validation)
// ============================================================================

/**
 * Schema for 204 No Content responses
 * Used when an API endpoint returns no body
 */
export const NoContentSchema = z.null().meta({ id: 'NoContent' });
export type NoContent = z.infer<typeof NoContentSchema>;

/**
 * Simple success response with optional message
 */
export const SuccessResponseSchema = z
    .object({
        success: z.boolean(),
        message: z.string().optional(),
    })
    .meta({ id: 'SuccessResponse' });
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;

/**
 * Simple success response (success must be true)
 */
export const SuccessTrueResponseSchema = z
    .object({
        success: z.literal(true),
    })
    .meta({ id: 'SuccessTrueResponse' });
export type SuccessTrueResponse = z.infer<typeof SuccessTrueResponseSchema>;
