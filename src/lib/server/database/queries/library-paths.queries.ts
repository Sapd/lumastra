// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { REMOTE_LIBRARY_PROVIDER_NAMES } from '$lib/schemas/common.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type LibraryPathMediaType =
    | 'movie'
    | 'tv'
    | 'anime'
    | 'music'
    | 'audiobook'
    | 'home_video'
    | 'training'
    | 'educational'
    | 'personal';
export type LibraryPathProvider =
    'tmdb' | 'jellyfin' | 'anidb' | 'tvdb' | 'musicbrainz' | 'audiobookshelf';

/**
 * Providers whose `library_paths.path` is a real directory on the local
 * filesystem — walkable, stat-able, watchable by the native watcher.
 *
 * Kept as an explicit ALLOW-list rather than a deny-list so the classification
 * fails closed: a future remote provider that nobody remembers to classify is
 * simply invisible to the filesystem consumers instead of making them walk,
 * `stat()` and warn on a URI that can never resolve. The compile-time
 * {@link AssertAllProvidersClassified} guard below makes forgetting loud.
 */
export const FILESYSTEM_LIBRARY_PROVIDERS = [
    'tmdb',
    'jellyfin',
    'anidb',
    'tvdb',
    'musicbrainz',
] as const satisfies readonly LibraryPathProvider[];

/**
 * Providers whose `library_paths.path` is a synthetic URI (e.g.
 * `abs://<absLibraryId>`) identifying a library on a remote server. The row
 * still exists because `library_paths` is the sole carrier of `language` and
 * `library_group_id` — and therefore of the whole access-control chain — and
 * because `/j` enumerates libraries from it. It just must never reach anything
 * that touches a disk.
 */
// `satisfies`, not a type annotation: an annotation widens the element type to
// `LibraryPathProvider`, and every consumer that derives a narrow union from
// `(typeof REMOTE_LIBRARY_PROVIDERS)[number]` then silently gets ALL providers.
export const REMOTE_LIBRARY_PROVIDERS =
    REMOTE_LIBRARY_PROVIDER_NAMES satisfies readonly LibraryPathProvider[];

/**
 * Compile-time guard: every `LibraryPathProvider` must be classified as either
 * filesystem-backed or remote. Adding a provider without adding it to one of
 * the two lists resolves this to `never`, and the assignment in
 * `library-paths.queries.test.ts` then fails to typecheck.
 */
export type AssertAllProvidersClassified =
    Exclude<
        LibraryPathProvider,
        (typeof FILESYSTEM_LIBRARY_PROVIDERS)[number] | (typeof REMOTE_LIBRARY_PROVIDERS)[number]
    > extends never
        ? true
        : never;

export interface LibraryPathRow {
    id: string;
    path: string;
    media_type: LibraryPathMediaType;
    language: string;
    provider: LibraryPathProvider;
    enabled: boolean;
    provider_path: string | null;
    library_group_id: string;
    edition_label: string | null;
    scan_chapters: boolean;
    fallback_providers: LibraryPathProvider[];
    source_prefix: string | null;
    created_at: Date;
    updated_at: Date;
}

export interface CreateLibraryPathParams {
    path: string;
    media_type: LibraryPathMediaType;
    language?: string;
    provider?: LibraryPathProvider;
    provider_path?: string | null;
    library_group_id: string; // Required — must reference an existing library_groups row
    edition_label?: string | null;
    scan_chapters?: boolean;
    fallback_providers?: LibraryPathProvider[];
    /** Whether the path starts enabled. Defaults to true (matches the column default). */
    enabled?: boolean;
}

export interface UpdateLibraryPathParams {
    path?: string;
    media_type?: LibraryPathMediaType;
    language?: string;
    provider?: LibraryPathProvider;
    enabled?: boolean;
    provider_path?: string | null;
    library_group_id?: string;
    edition_label?: string | null;
    scan_chapters?: boolean;
    fallback_providers?: LibraryPathProvider[];
    source_prefix?: string | null;
}

/**
 * Matches a leading `<scheme>://` on a remote-provider sentinel path.
 *
 * Anchored and scheme-shaped (RFC 3986 `scheme = ALPHA *( ALPHA / DIGIT / "+" /
 * "-" / "." )`) so it cannot over-match a real path: a POSIX path never starts
 * with `word://`, and a UNC-style `//server/share` has no scheme and so keeps
 * the filesystem rules it has always had.
 */
const REMOTE_PATH_SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/**
 * Normalize a library path string for storage/dedup comparison: trims
 * surrounding whitespace, collapses repeated internal slashes, and strips any
 * trailing slash(es) AND trailing whitespace — so `/media/movies`,
 * `/media/movies/`, `/media//movies///`, and `/media/movies /` all normalize to
 * the same string and can't register as distinct `library_paths` rows despite
 * the column's `UNIQUE(path)` constraint (which only catches byte-identical
 * strings). Deliberately does NOT resolve symlinks — this is a pure string
 * operation. The root path `/` is preserved as-is rather than collapsed to empty.
 *
 * **Remote-provider sentinels are exempt from the slash-collapsing rule.** A
 * {@link REMOTE_LIBRARY_PROVIDERS} row's `path` is a synthetic
 * `<scheme>://<opaque-id>` URI, and collapsing `/{2,}` mangles `abs://<uuid>`
 * into `abs:/<uuid>` — a string that matches no existing row, so the dedup
 * lookup misses and the operator gets a duplicate library instead of an
 * idempotent attach. `createLibraryPath`/`updateLibraryPath` normalize on every
 * write, which makes this function the single chokepoint where that has to be
 * handled; a caller-side special case would be one `createLibraryPath` call away
 * from re-introducing the corruption.
 *
 * The scheme is lower-cased so `ABS://x` and `abs://x` cannot both be inserted
 * past `UNIQUE(path)`. The opaque remainder is left byte-for-byte alone apart
 * from trailing slash/whitespace — it is an upstream identifier, not a path, and
 * nothing here may assume its internal structure.
 */
export function normalizeLibraryPath(path: string): string {
    const trimmed = path.trim();

    const scheme = REMOTE_PATH_SCHEME_RE.exec(trimmed);
    if (scheme) {
        const opaque = trimmed.slice(scheme[0].length).replace(/[\s/]+$/, '');
        return `${scheme[1].toLowerCase()}://${opaque}`;
    }

    const collapsed = trimmed.replace(/\/{2,}/g, '/');
    // Strip a trailing run of slashes and/or whitespace (e.g. `/media/movies /`).
    return collapsed.length > 1 ? collapsed.replace(/[\s/]+$/, '') : collapsed;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getAllLibraryPaths(sql: postgres.Sql): Promise<LibraryPathRow[]> {
    return sql<LibraryPathRow[]>`
        SELECT id, path, media_type, language, provider, enabled, provider_path,
               library_group_id, edition_label, scan_chapters, fallback_providers, source_prefix, created_at, updated_at
        FROM library_paths
        ORDER BY library_group_id, created_at ASC
    `;
}

export interface GetEnabledLibraryPathsOptions {
    /**
     * Also return rows whose provider is remote (see
     * {@link REMOTE_LIBRARY_PROVIDERS}) and whose `path` is therefore a
     * synthetic URI rather than a directory.
     *
     * Defaults to `false`. Only opt in from code that treats `path` as an
     * opaque identifier — remote-library sync, or an enumeration that must list
     * every configured library. Anything that walks, stats, watches or
     * sandbox-checks a real directory must keep the default.
     */
    includeRemote?: boolean;
}

/**
 * All enabled library paths, excluding remote-provider rows by default.
 *
 * The default is restrictive because the overwhelming majority of callers treat
 * every returned `path` as a directory: the scanner walk and its native
 * watcher, the per-library scan fan-out, the reconcile rotation (which
 * processes exactly one path per cycle, so a bogus row permanently steals
 * coverage from a real one), the writability health invariant and the preflight
 * dependency check (both of which raise operator-facing warnings when a path
 * cannot be stat-ed), artwork headroom/reaping, image scanning, and the
 * `isPathWithinLibraryRoots` read sandbox.
 *
 * Filtering here rather than at each call site is deliberate: there are ~16 of
 * them, and a missed one degrades from "wasted work" to "permanent health
 * warning" or "widened sandbox root" depending on which one it is.
 */
export async function getEnabledLibraryPaths(
    sql: postgres.Sql,
    options?: GetEnabledLibraryPathsOptions,
): Promise<LibraryPathRow[]> {
    const providerFilter = options?.includeRemote
        ? sql``
        : // Explicit ::text[] instead of an inferred sql.array() parameter: prod
          // logged 'op ANY/ALL (array) requires array on right side' for this
          // statement 4x on 2026-09-23 (cause unconfirmed); the cast removes the
          // parameter-type inference from the equation.
          sql`AND provider = ANY(${[...FILESYSTEM_LIBRARY_PROVIDERS]}::text[])`;

    return sql<LibraryPathRow[]>`
        SELECT id, path, media_type, language, provider, enabled, provider_path,
               library_group_id, edition_label, scan_chapters, fallback_providers, source_prefix, created_at, updated_at
        FROM library_paths
        WHERE enabled = true ${providerFilter}
        ORDER BY library_group_id, created_at ASC
    `;
}

/**
 * All enabled library paths belonging to one provider.
 *
 * The point of entry for a remote-library connector: it wants exactly its own
 * rows and nothing else, so it never has to opt into
 * {@link GetEnabledLibraryPathsOptions.includeRemote} and then re-filter (which
 * would silently start returning a second remote provider's rows the day one is
 * added).
 */
export async function getEnabledLibraryPathsByProvider(
    sql: postgres.Sql,
    provider: LibraryPathProvider,
): Promise<LibraryPathRow[]> {
    return sql<LibraryPathRow[]>`
        SELECT id, path, media_type, language, provider, enabled, provider_path,
               library_group_id, edition_label, scan_chapters, fallback_providers, source_prefix, created_at, updated_at
        FROM library_paths
        WHERE enabled = true
          AND provider = ${provider}
        ORDER BY library_group_id, created_at ASC
    `;
}

export async function getLibraryPathById(
    sql: postgres.Sql,
    id: string,
): Promise<LibraryPathRow | null> {
    // `id` reaches here straight off a URL path param. Comparing a non-UUID
    // string against a uuid column makes Postgres raise 22P02 ("invalid input
    // syntax for type uuid"), which escapes as an unhandled 500 — e.g.
    // POST /api/admin/upload/NOT-A-VALID-UUID/init answered internal_error
    // instead of not_found. A malformed id is by definition not a path we have,
    // and this function already returns null for that, so answer null here too
    // and every caller's existing not-found branch covers it.
    if (!UUID_RE.test(id)) return null;

    const rows = await sql<LibraryPathRow[]>`
        SELECT id, path, media_type, language, provider, enabled, provider_path,
               library_group_id, edition_label, scan_chapters, fallback_providers, source_prefix, created_at, updated_at
        FROM library_paths
        WHERE id = ${id}
    `;
    return rows[0] ?? null;
}

export async function getLibraryPathsByGroup(
    sql: postgres.Sql,
    groupId: string,
): Promise<LibraryPathRow[]> {
    return sql<LibraryPathRow[]>`
        SELECT id, path, media_type, language, provider, enabled, provider_path,
               library_group_id, edition_label, scan_chapters, fallback_providers, source_prefix, created_at, updated_at
        FROM library_paths
        WHERE library_group_id = ${groupId}
        ORDER BY created_at ASC
    `;
}

export async function createLibraryPath(
    sql: postgres.Sql,
    params: CreateLibraryPathParams,
): Promise<LibraryPathRow> {
    const rows = await sql<LibraryPathRow[]>`
        INSERT INTO library_paths (path, media_type, language, provider, provider_path, library_group_id, edition_label, scan_chapters, fallback_providers, enabled)
        VALUES (
            ${normalizeLibraryPath(params.path)},
            ${params.media_type},
            ${params.language ?? (params.provider === 'audiobookshelf' ? '' : 'en')},
            ${params.provider ?? 'tmdb'},
            ${params.provider_path ?? null},
            ${params.library_group_id},
            ${params.edition_label ?? null},
            ${params.scan_chapters ?? false},
            ${sql.array(params.fallback_providers ?? [])},
            ${params.enabled ?? true}
        )
        RETURNING id, path, media_type, language, provider, enabled, provider_path,
                  library_group_id, edition_label, scan_chapters, fallback_providers, source_prefix, created_at, updated_at
    `;
    if (!rows[0]) throw new Error('INSERT library_paths returned no row');
    return rows[0];
}

export async function updateLibraryPath(
    sql: postgres.Sql,
    id: string,
    params: UpdateLibraryPathParams,
): Promise<LibraryPathRow | null> {
    const rows = await sql<LibraryPathRow[]>`
        UPDATE library_paths
        SET
            path             = ${params.path === undefined ? sql`path` : normalizeLibraryPath(params.path)},
            media_type       = ${params.media_type === undefined ? sql`media_type` : params.media_type},
            language         = ${params.language === undefined ? sql`language` : params.language},
            provider         = ${params.provider === undefined ? sql`provider` : params.provider},
            enabled          = ${params.enabled === undefined ? sql`enabled` : params.enabled},
            provider_path    = ${params.provider_path === undefined ? sql`provider_path` : params.provider_path},
            library_group_id = ${params.library_group_id === undefined ? sql`library_group_id` : params.library_group_id},
            edition_label      = ${params.edition_label === undefined ? sql`edition_label` : params.edition_label},
            scan_chapters      = ${params.scan_chapters === undefined ? sql`scan_chapters` : params.scan_chapters},
            fallback_providers = ${params.fallback_providers === undefined ? sql`fallback_providers` : sql.array(params.fallback_providers)},
            source_prefix      = ${params.source_prefix === undefined ? sql`source_prefix` : params.source_prefix},
            updated_at         = now()
        WHERE id = ${id}
        RETURNING id, path, media_type, language, provider, enabled, provider_path,
                  library_group_id, edition_label, scan_chapters, fallback_providers, source_prefix, created_at, updated_at
    `;
    return rows[0] ?? null;
}

/**
 * Re-stamps the files already scanned under a library folder with the folder's
 * new library group. Visibility for restricted users is decided by
 * `media_files.library_group_id` (see library-access.builder.ts), and the
 * scanner only re-stamps a file when it re-upserts it — so without this a
 * folder moved INTO a restricted library stayed visible to everyone (and one
 * moved out stayed hidden) until each file happened to be rescanned.
 *
 * Matches the folder itself and everything below it (`starts_with` on
 * `path || '/'`, so `/media/movies` never matches `/media/movies-4k`).
 * Returns the number of files re-stamped.
 */
export async function restampLibraryPathFileGroups(
    sql: postgres.Sql,
    path: string,
    libraryGroupId: string | null,
): Promise<number> {
    const rows = await sql<{ id: string }[]>`
        UPDATE media_files
        SET library_group_id = ${libraryGroupId}::uuid,
            updated_at       = now()
        WHERE (file_path = ${path} OR starts_with(file_path, ${path} || '/'))
          AND library_group_id IS DISTINCT FROM ${libraryGroupId}::uuid
        RETURNING id
    `;
    return rows.length;
}

/**
 * Validate that a media_type is consistent with existing paths in a library group.
 * Returns an error message string if validation fails, or null if OK.
 *
 * @param excludePathId - Exclude this path from the check (used in PATCH to ignore self)
 */
export async function validateGroupConsistency(
    sql: postgres.Sql,
    groupId: string,
    mediaType: LibraryPathMediaType,
    excludePathId?: string,
): Promise<string | null> {
    const groupPaths = await getLibraryPathsByGroup(sql, groupId);
    const otherPaths = excludePathId
        ? groupPaths.filter((p) => p.id !== excludePathId)
        : groupPaths;

    if (otherPaths.length > 0 && otherPaths[0].media_type !== mediaType) {
        return `Library group already contains ${otherPaths[0].media_type} paths — cannot mix media types`;
    }
    return null;
}

/**
 * Validate that a provider + fallback_providers pair is consistent with the
 * OTHER folders already in a library group — the same rule
 * {@link validateGroupConsistency} enforces for media_type, now extended to
 * provider per the library-sources restructure (library-level fact, folder-
 * level row). Returns an error message string if validation fails, or null if
 * OK.
 *
 * Fallback-provider order does not matter for consistency purposes — two
 * folders configured with the same set in a different order are not "mixed
 * providers" — so both sides are sorted before comparing.
 *
 * @param excludePathId - Exclude this path from the check (used in PATCH to ignore self)
 */
export async function validateGroupProviderConsistency(
    sql: postgres.Sql,
    groupId: string,
    provider: LibraryPathProvider,
    fallbackProviders: LibraryPathProvider[],
    excludePathId?: string,
): Promise<string | null> {
    const groupPaths = await getLibraryPathsByGroup(sql, groupId);
    const otherPaths = excludePathId
        ? groupPaths.filter((p) => p.id !== excludePathId)
        : groupPaths;

    if (otherPaths.length === 0) return null;

    const existing = otherPaths[0];
    if (existing.provider !== provider) {
        return `Library already uses the ${existing.provider} provider — cannot mix providers within a library`;
    }

    const sortedExisting = [...existing.fallback_providers].sort();
    const sortedIncoming = [...fallbackProviders].sort();
    const fallbacksMatch =
        sortedExisting.length === sortedIncoming.length &&
        sortedExisting.every((p, i) => p === sortedIncoming[i]);
    if (!fallbacksMatch) {
        return `Library's fallback providers are already set to [${existing.fallback_providers.join(', ') || 'none'}] — cannot mix fallback providers within a library`;
    }

    return null;
}

export async function deleteLibraryPath(sql: postgres.Sql, id: string): Promise<boolean> {
    const result = await sql`
        DELETE FROM library_paths WHERE id = ${id}
    `;
    return result.count > 0;
}
