// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Artist listing query for the Jellyfin compat surface (`GET /j/Artists`).
 *
 * Extracted out of the route so the access boundary is a REQUIRED parameter of a
 * function that tests can call directly. While the boundary was constructed
 * inline in the handler, "forgot to apply it" produced no call-site diff and no
 * type error — the failure mode this module exists to make impossible.
 *
 * ## Why this does NOT use `buildLibraryAccessFilter`
 *
 * Historically, artists own no `media_file_items` rows of their own, so that
 * builder's `NOT EXISTS (SELECT 1 FROM media_file_items WHERE media_item_id =
 * mi.id)` branch always passed for an artist row — a fail-open for
 * container-type rows. `buildLibraryAccessFilter` was made container-aware
 * (C3, 2026-09-13) and now handles `artist` rows correctly via its own
 * `mi.media_type = 'artist'` branch, so functionally the canonical builder
 * would no longer unrestrict this endpoint. This bespoke predicate stays
 * separate anyway, for one reason unrelated to that fix:
 *
 * `buildArtistLibraryAccessFilter` has exactly one call site (`listArtists`
 * below) and its own differential-access test suite
 * (`artists-query.integration.test.ts`) pins its exact behaviour, so a
 * consolidation can be verified independently of this file's callers.
 * (`buildArtistLibraryAccessFilter` also accepts the `media_items` alias as an
 * explicit parameter, unlike `buildLibraryAccessFilter`, which hardcodes
 * `mi` — but that parameter is currently unexercised: the one call site below
 * passes no alias and both queries alias `media_items` as `mi` anyway. It is
 * kept because `listArtists`' query shape could need a different alias in the
 * future, not because one is in use today — do not cite it as a blocker to
 * consolidation.)
 *
 * Consolidating the two is a pure refactor left for a later pass.
 *
 * ## Empty containers (deferred item 4 — 2026-09-15)
 *
 * The three-level descendant walk (artist -> album -> track -> file item ->
 * file) mirrors `buildLibraryAccessFilter`'s `artist` branch, INCLUDING its
 * two-clause empty-container rule: `NOT EXISTS (any descendant file at all)
 * OR EXISTS (a non-denied descendant file)`. An artist with zero albums (or
 * an album with zero tracks, or a track with no file rows) has no descendant
 * files at all, so it stays visible — the same as a file-less leaf item —
 * rather than disappearing for every restricted user the moment a single
 * `library_group_permissions` row exists anywhere in the system. An artist is
 * hidden only when it actually HAS descendant files and every one of them is
 * in a denied group. This predicate previously used an `EXISTS`-only form
 * that never got that fix when the canonical builder did; both now agree.
 *
 * ## Own-column declared affiliation (fix round 2 — deferred item 4 review, 2026-09-15)
 *
 * The descendant walk alone ignores the artist row's OWN
 * `media_items.library_group_id` (set at creation by `findOrCreateMusicArtist`),
 * so an artist that explicitly NAMES a denied group on its own row — with zero
 * albums, or whose `media_file_items` rows have all cascaded away (see
 * `media_items.files_lost_at`) — stayed visible to a user denied that very
 * group. The artist is visible only if BOTH its own column check AND the
 * descendant walk pass. A `library_group_id IS NULL` artist has no declared
 * affiliation and falls through to the descendant walk unaffected — hiding a
 * row that DOES name a group cannot reintroduce the empty-stub problem the
 * section above protects, since that problem was specifically about rows with
 * no declared affiliation at all.
 *
 * ## Correction — own-column check must not override accessible content
 * ## (fix round 3 — review response, 2026-09-15)
 *
 * "Regardless of file state" was too broad: it also hid an artist whose
 * descendant files are FULLY ACCESSIBLE, desyncing the tree — review verified
 * this is reachable in a real library because `media_items.library_group_id`
 * is STICKY (`insertScannedMediaItem` sets it at first scan;
 * `backfillLibraryGroupIdIfNull` only ever writes it `WHERE library_group_id
 * IS NULL`), so an artist first scanned into a group it later loses tracks
 * from keeps that stale `library_group_id` forever. The own-column check now
 * fires ONLY when the artist has NO non-denied descendant track file: an
 * `EXISTS (a non-denied descendant file)` branch — the same positive EXISTS
 * sub-query the descendant walk already uses — was added alongside the
 * `library_group_id` checks. Because that branch requires embedding inside an
 * OR alongside `library_group_id IS NULL`/`!= ALL(...)`, the own-column check
 * is now implemented directly here rather than via
 * `buildLibraryGroupColumnFilter` (whose `AND (...)`-prefixed return value
 * cannot be embedded as a bare OR operand either — the same constraint noted
 * in `buildLibraryAccessFilter`'s docstring). A file-less stub naming a
 * denied group is still hidden (no descendant file exists to satisfy the new
 * branch); an artist that demonstrably holds accessible tracks is no longer
 * hidden by a stale own-row group.
 *
 * Unlike the canonical builder's guard, this one has no `media_type` branch —
 * every row this function's WHERE clause reaches is already `media_type =
 * 'artist'` (enforced by `listArtists`), so a type guard would be inert.
 * Deliberately left unguarded; not a gap to close.
 */

import type postgres from 'postgres';
import { buildAgeRatingFilter } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { artistHasPlayableTrackSql } from '$lib/server/database/queries/music.queries.js';
import { buildMetadataLateralJoinFragment } from '$lib/server/database/queries/builders/provider-metadata.builder.js';
import { deniesEverything } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type {
    LibraryScope,
    MediaAccessBoundary,
} from '$lib/server/database/queries/builders/media-access-boundary.js';

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

/**
 * Library-axis predicate for artist (container) rows.
 *
 * Unlike `buildLibraryAccessFilter`, the alias is an explicit parameter. The
 * hand-rolled version this replaces hardcoded `mi.id`, which made it
 * structurally impossible to reuse and is exactly the trap that lets a fragment
 * built for one alias get interpolated into a query using another.
 *
 * Scope behaviour mirrors the canonical builders:
 * - `all`        -> empty fragment
 * - `denyGroups` -> the own-column check composed with the container
 *                   two-clause descendant-walk predicate below
 * - `denyAll`    -> `AND false`
 *
 * `denyAll` must NOT be expressed as "deny every known group": the predicate
 * treats `library_group_id IS NULL` as accessible, so ungrouped files would
 * still leak through an all-inclusive denied array.
 */
export function buildArtistLibraryAccessFilter(
    sql: postgres.Sql,
    scope: LibraryScope,
    alias = 'mi',
): postgres.PendingQuery<postgres.Row[]> {
    if (scope.kind === 'denyAll') return sql`AND false`;
    if (scope.kind === 'all' || scope.ids.length === 0) return sql``;

    if (!SAFE_IDENTIFIER.test(alias)) {
        throw new Error(`buildArtistLibraryAccessFilter: invalid alias "${alias}"`);
    }

    const denied = scope.ids;
    const descendantFilter = sql`AND (
        NOT EXISTS (
            SELECT 1 FROM media_items _album
            JOIN media_items _track ON _track.parent_id = _album.id
            JOIN media_file_items _mfi ON _mfi.media_item_id = _track.id
            WHERE _album.parent_id = ${sql(alias)}.id
        )
        OR EXISTS (
            SELECT 1 FROM media_items _album
            JOIN media_items _track ON _track.parent_id = _album.id
            JOIN media_file_items _mfi ON _mfi.media_item_id = _track.id
            JOIN media_files _mf ON _mf.id = _mfi.file_id
            WHERE _album.parent_id = ${sql(alias)}.id
              AND (_mf.library_group_id IS NULL
                   OR _mf.library_group_id != ALL(${denied}::uuid[]))
        )
    )`;
    // Own-column check (fix round 2, corrected in fix round 3 — 2026-09-15):
    // an artist row that NAMES a denied group on its own `library_group_id`
    // is hidden ONLY when it has no non-denied descendant file — see the
    // module docstring for the desync this guards against.
    const ownGroupGuard = sql`AND (
        ${sql(alias)}.library_group_id IS NULL
        OR ${sql(alias)}.library_group_id != ALL(${denied}::uuid[])
        OR EXISTS (
            SELECT 1 FROM media_items _album
            JOIN media_items _track ON _track.parent_id = _album.id
            JOIN media_file_items _mfi ON _mfi.media_item_id = _track.id
            JOIN media_files _mf ON _mf.id = _mfi.file_id
            WHERE _album.parent_id = ${sql(alias)}.id
              AND (_mf.library_group_id IS NULL
                   OR _mf.library_group_id != ALL(${denied}::uuid[]))
        )
    )`;
    return sql`${descendantFilter} ${ownGroupGuard}`;
}

/**
 * `ParentId` (library-group) narrowing.
 *
 * ⚠️ KNOWN PRE-EXISTING GAP — deliberately preserved, do not "fix" here.
 * This EXISTS is independent of the access boundary: it tests
 * `_mf.library_group_id = ${parentId}` with no reference to the denied set, and
 * `parentId` is attacker-supplied straight off the query string. An artist with
 * one track in an accessible group A and one in a DENIED group B satisfies the
 * boundary predicate (via A) and this predicate (via B) simultaneously, so it is
 * returned when browsing a library group the caller may not read — an
 * existence/membership leak of denied-library contents.
 *
 * Closing it changes which rows a restricted user sees, which the access-boundary
 * migration explicitly must not do. Filed separately; see the migration notes.
 *
 * Factored into one helper because it was previously copy-pasted verbatim into
 * both the count and the rows query — the drift pattern that produced the
 * TotalRecordCount leak in the sibling Episodes route.
 */
function buildParentIdFilter(
    sql: postgres.Sql,
    parentId: string | null | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    if (!parentId) return sql``;
    return sql`AND EXISTS (
        SELECT 1 FROM media_items _album
        JOIN media_items _track ON _track.parent_id = _album.id
        JOIN media_file_items _mfi ON _mfi.media_item_id = _track.id
        JOIN media_files _mf ON _mf.id = _mfi.file_id
        WHERE _album.parent_id = mi.id AND _mf.library_group_id = ${parentId}::uuid
    )`;
}

export interface ArtistListParams {
    limit: number;
    startIndex: number;
    parentId?: string | null;
    sortBy?: string | null;
    sortOrder?: string | null;
    searchTerm?: string | null;
    nameStartsWith?: string | null;
}

export interface ArtistListResult {
    rows: Record<string, unknown>[];
    totalCount: number;
}

/**
 * List artists visible under `access`.
 *
 * `access` is REQUIRED and has no permissive default. A caller that genuinely
 * wants every artist must pass `unrestrictedAccess()` so the decision is
 * greppable.
 *
 * Both the count and the rows query interpolate the SAME two fragment variables,
 * so `TotalRecordCount` and `rows.length` cannot disagree about the boundary.
 */
export async function listArtists(
    sql: postgres.Sql,
    params: ArtistListParams,
    access: MediaAccessBoundary,
): Promise<ArtistListResult> {
    // Short-circuit rather than issuing two queries whose predicate is `AND false`.
    // The builders below still emit `AND false` for denyAll, so removing this
    // fast path would cost a round trip but could not open the endpoint.
    if (deniesEverything(access)) {
        return { rows: [], totalCount: 0 };
    }

    const accessFilter = buildArtistLibraryAccessFilter(sql, access.library);
    const ageFilter = buildAgeRatingFilter(sql, access.age, 'mi');
    const parentFilter = buildParentIdFilter(sql, params.parentId);

    const searchFilter = params.searchTerm
        ? sql`AND mi.title ILIKE ${'%' + params.searchTerm + '%'}`
        : sql``;
    const startsWithFilter = params.nameStartsWith
        ? sql`AND UPPER(LEFT(mi.title, 1)) = ${params.nameStartsWith.toUpperCase()}`
        : sql``;

    const dir = params.sortOrder === 'Descending' ? sql`DESC` : sql`ASC`;
    const orderColumn = params.sortBy === 'DateCreated' ? sql`mi.created_at` : sql`LOWER(mi.title)`;

    const countResult = await sql<[{ count: string }]>`
        SELECT COUNT(*) as count
        FROM media_items mi
        WHERE mi.media_type = 'artist'
          AND mi.status = 'active'
          AND mi.is_dismissed = false
          AND ${artistHasPlayableTrackSql(sql, sql`mi.id`, access)}
          ${parentFilter}
          ${searchFilter}
          ${startsWithFilter}
          ${accessFilter}
          ${ageFilter}
    `;
    const totalCount = parseInt(countResult[0]?.count ?? '0', 10);

    const rows = await sql<Record<string, unknown>[]>`
        SELECT
            mi.id,
            mi.title,
            mi.media_type,
            mi.overview,
            (pm.metadata->>'poster_path')::text as poster_path,
            (pm.metadata->>'backdrop_path')::text as backdrop_path,
            (pm.metadata->>'logo_path')::text as logo_path,
            (SELECT COUNT(*)::int FROM media_items WHERE parent_id = mi.id AND status = 'active') as child_count
        FROM media_items mi
        ${buildMetadataLateralJoinFragment(sql)}
        WHERE mi.media_type = 'artist'
          AND mi.status = 'active'
          AND mi.is_dismissed = false
          AND ${artistHasPlayableTrackSql(sql, sql`mi.id`, access)}
          ${parentFilter}
          ${searchFilter}
          ${startsWithFilter}
          ${accessFilter}
          ${ageFilter}
        ORDER BY ${orderColumn} ${dir}
        LIMIT ${params.limit}
        OFFSET ${params.startIndex}
    `;

    return { rows: [...rows], totalCount };
}
