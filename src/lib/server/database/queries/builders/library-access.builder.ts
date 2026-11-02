// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library Access Filter Builder
 *
 * Produces a SQL fragment that excludes media items from denied library groups.
 * When deniedGroupIds is null or empty, returns an empty fragment (zero overhead).
 *
 * Logic: an item is visible if:
 * (a) it has no files at all (Jellyfin-only items), OR
 * (b) at least one of its files is in a non-denied library group
 *
 * For `tv`/`season`/`artist`/`album` container rows specifically, a THIRD
 * condition also applies: the container's own `media_items.library_group_id`
 * (when set) must not itself name a denied group — see "Own-column declared
 * affiliation" below.
 */

import type postgres from 'postgres';
import type { LibraryScope } from './media-access-boundary.js';

/** Table aliases are interpolated as identifiers; reject anything else. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

/**
 * Build a WHERE clause fragment that filters out media items
 * belonging exclusively to denied library groups.
 *
 * Accepts either a {@link LibraryScope} (preferred) or the legacy
 * `string[] | null | undefined` denied-group list.
 *
 * Scope behaviour:
 * - `all`        -> empty fragment
 * - `denyGroups` -> the container-aware predicate below
 * - `denyAll`    -> `AND false`
 *
 * ## Container rows (C3 — 2026-09-13)
 *
 * `tv`, `season`, `artist` and `album` rows never own `media_file_items` of
 * their own — only their leaf descendants (`episode`, `track`) do. The old
 * predicate's `NOT EXISTS (media_file_items ...)` branch treated "no own
 * files" as "visible to everyone", which made every container row visible
 * regardless of which library group its descendants' files actually lived
 * in — a restricted user could see a series/album's title, overview, dates,
 * genres, artwork and UUID even when every episode/track underneath it was in
 * a group they may not access.
 *
 * The fix dispatches on `mi.media_type`: a container type walks down to its
 * file-owning descendants (mirroring the three-level artist walk in
 * `jellyfin-compat/artists-query.ts`'s `buildArtistLibraryAccessFilter`) and
 * is visible only if at least one descendant file is in a non-denied group.
 * Every other media type keeps the original "own files" predicate verbatim,
 * including the "no files at all" fail-open branch — that branch is correct
 * for Jellyfin-only leaf content (a movie/episode/track with no local file),
 * which is exactly what it was designed for.
 *
 * ### Empty containers (fix round 1 — 2026-09-13)
 *
 * A container branch is not just `EXISTS (a non-denied descendant file)` — it
 * mirrors the leaf rule's two clauses exactly: `NOT EXISTS (any descendant
 * file at all) OR EXISTS (a non-denied descendant file)`. A `tv`/`season`/
 * `artist`/`album` row with ZERO descendant files (a freshly-created request
 * stub, a watchlist/playlist placeholder, an empty season row Jellyfin sync
 * created ahead of its episodes) stays VISIBLE, the same as a file-less leaf
 * item — `EXISTS`-only would have made every such stub disappear for any user
 * under ANY active library-group restriction, even one that has nothing to do
 * with that item, the moment a single `library_group_permissions` row exists
 * anywhere in the system. A container is hidden only when it actually HAS
 * descendant files and every one of them is in a denied group.
 *
 * ### Alias parameter (2026-09-15)
 *
 * The builder used to hardcode the `mi` alias, which forced every query whose
 * `media_items` alias was named something else to hand-inline the predicate —
 * and five of those inlined copies were the OLD, pre-container predicate
 * correlated to a CONTAINER row, making their library axis a no-op in
 * production (see the call sites listed below). `alias` closes that: a caller
 * names the alias instead of copying the predicate. It is validated against
 * `SAFE_IDENTIFIER` and emitted through `sql(...)` as an identifier, exactly
 * as {@link buildLibraryGroupColumnFilter} already does.
 *
 * Callers that previously inlined and now pass an alias:
 * `search.queries.ts` (`ep`), `watch-state.queries.ts` (`series_mi`),
 * `episode-search.queries.ts` (`ep`), `request-status/database.ts`
 * (`season` / `mi`), `utils/media-access-batch.ts` (`mi`).
 *
 * ### Own-column declared affiliation (fix round 2 — deferred item 4 review, 2026-09-15)
 *
 * The two-clause rule above decides visibility purely from descendant FILES —
 * it never looks at the container row's OWN `media_items.library_group_id`,
 * which `tv`/`season`/`artist`/`album` rows can carry (e.g.
 * `findOrCreateMusicArtist` sets it on the artist row it creates). That let two
 * states slip through to a user denied that very group: an empty container
 * (zero descendant files) whose own row names the denied group, and a
 * container whose `media_file_items` rows have all cascaded away (e.g. after
 * its files were deleted — `media_items.files_lost_at` tracks this as a
 * persistent state) while its own row still names the denied group. Both were
 * verified VISIBLE pre-fix, exposing title, overview, artwork paths,
 * `child_count` and UUID to a user denied that group.
 *
 * The added clause below closes this: a container row that explicitly NAMES a
 * denied group is hidden regardless of file state; a row whose
 * `library_group_id IS NULL` has no declared affiliation and keeps the
 * empty-stub visibility the fix above deliberately preserves — hiding a row
 * that names a group cannot reintroduce the empty-stub problem, since that
 * problem was specifically about rows with NO declared affiliation. This is
 * the identical rule `buildLibraryGroupColumnFilter` (below) already
 * implements — including its `IS NULL` handling — but that function's return
 * value is a complete `AND (...)` fragment and cannot be embedded as a bare
 * boolean sub-expression inside a `CASE WHEN ... THEN (expr)` branch, so the
 * same rule is implemented directly here as a second, guarded top-level
 * AND-clause instead of a literal call. The guard
 * (`mi.media_type NOT IN (...)`) scopes it to container types ONLY — it does
 * not touch leaf rows (`movie`/`episode`/`track`/`audiobook`/...), whose ELSE
 * branch above is unchanged and untested by this round.
 *
 * #### Correction — own-column check must not override genuinely accessible
 * #### content (fix round 3 — review response, 2026-09-15)
 *
 * The first cut of this clause hid a container "regardless of file state"
 * whenever its own `library_group_id` named a denied group — which also hid
 * a container whose descendant files are FULLY ACCESSIBLE, desyncing the
 * tree: review verified a `tv` row with `library_group_id` = Group A, one
 * season, one episode whose `media_files.library_group_id` = Group B, for a
 * user denied A only, gave series HIDDEN while its season and episode stayed
 * VISIBLE and playable. This is reachable in a real library because
 * `media_items.library_group_id` is STICKY: `insertScannedMediaItem` sets it
 * at first scan and `backfillLibraryGroupIdIfNull` only ever writes it
 * `WHERE library_group_id IS NULL` — a series first scanned into "Kids" that
 * later gains seasons in "Adults" keeps `library_group_id` = Kids forever, so
 * a user denied Kids but allowed Adults would lose the series row from every
 * browse/search surface while its seasons and episodes remained listable.
 *
 * The own-column check now fires ONLY when the container has NO non-denied
 * descendant file: the guard clause gained a fourth OR-branch,
 * `EXISTS (a non-denied descendant file)`, duplicating the exact positive
 * EXISTS sub-query from the matching `WHEN` branch above per type (CASE'd the
 * same way). A file-less stub that names a denied group is still hidden (no
 * descendant file exists to satisfy the new branch); a container that
 * demonstrably holds accessible content is no longer hidden by its own
 * possibly-stale `library_group_id`.
 *
 * #### Generalised beyond the four container types (Shape B fix, security
 * #### fix-plan-4, 2026-09-18) — supersedes the "container types ONLY" claim above
 *
 * The paragraph at "fix round 2" above states the own-column guard was
 * deliberately scoped to `tv`/`season`/`artist`/`album` and "does not touch
 * leaf rows … whose ELSE branch above is unchanged and untested by this
 * round." That scoping was itself the hole review 4 named Shape B: every
 * OTHER media type's `ELSE` branch (the two-clause rule at the very top of
 * this doc comment) passes a row with zero `media_file_items`
 * UNCONDITIONALLY, and the own-column backstop's first disjunct
 * (`media_type NOT IN (...)`) made sure it never even reached the own-column
 * check for those types. A `movie` row that lost its files but kept a stale
 * `library_group_id`, or an `audiobook` row (which never has files by
 * design — the bytes live on the AudiobookShelf server), stayed visible to a
 * user denied that exact group.
 *
 * The fix: the `media_type NOT IN (...)` disjunct is DELETED, and the
 * `CASE`'s `ELSE FALSE` arm (for every media type outside the four
 * containers) is replaced with a positive `EXISTS` over the row's OWN files —
 * the same "does this row demonstrably hold accessible content" test the
 * four container branches already run, applied to a leaf row's own
 * `media_file_items` instead of a container's descendants. This closes the
 * hole for `movie` (files lost) and `audiobook`/`product` (file-less by
 * design) while leaving population (ii) — a multi-version `movie` whose own
 * `library_group_id` is stale but whose CURRENT file is in an allowed group —
 * correctly visible, exactly as `a07d051b4` established for containers.
 * Deleting the guard alone, without this `EXISTS` replacement, would have
 * reintroduced that container-era regression for leaves.
 *
 * **This is a no-op for `tvchannel` and `radio` rows.** Neither type is ever
 * written with a non-NULL `library_group_id` — no `library_group_id` column
 * exists anywhere in the Live TV data model (`livetv_channels`,
 * `livetv_sources`) — so the first disjunct (`library_group_id IS NULL`)
 * stays true for every one of them and this generalisation changes nothing
 * about their visibility. The only real control over a `tvchannel` row is
 * `hasLiveTvPermission` (`src/lib/server/auth.ts`), enforced at the route
 * layer (see `/j/Items/[itemId]/+server.ts`, `PlaybackInfo/+server.ts`) — do
 * not read this filter as a channel gate.
 *
 * @param sql - postgres.Sql instance for parameterized queries
 * @param scope - library scope, or legacy library_group_ids the user cannot access
 * @param alias - Table alias for media_items in the surrounding query (default: 'mi')
 * @returns SQL fragment to append after existing WHERE conditions (includes leading AND)
 */
export function buildLibraryAccessFilter(
    sql: postgres.Sql,
    scope: LibraryScope | string[] | null | undefined,
    alias = 'mi',
): postgres.PendingQuery<postgres.Row[]> {
    const deniedGroupIds = resolveDeniedGroupIds(scope);
    if (deniedGroupIds === 'denyAll') return sql`AND false`;
    if (!deniedGroupIds || deniedGroupIds.length === 0) return sql``;

    if (!SAFE_IDENTIFIER.test(alias)) {
        throw new Error(`buildLibraryAccessFilter: invalid alias "${alias}"`);
    }
    const mi = sql(alias);

    return sql`
        AND (
            CASE ${mi}.media_type
                WHEN 'tv' THEN (
                    NOT EXISTS (
                        SELECT 1 FROM media_items _season
                        JOIN media_items _episode ON _episode.parent_id = _season.id
                        JOIN media_file_items _mfi ON _mfi.media_item_id = _episode.id
                        WHERE _season.parent_id = ${mi}.id
                    )
                    OR EXISTS (
                        SELECT 1 FROM media_items _season
                        JOIN media_items _episode ON _episode.parent_id = _season.id
                        JOIN media_file_items _mfi ON _mfi.media_item_id = _episode.id
                        JOIN media_files _mf ON _mf.id = _mfi.file_id
                        WHERE _season.parent_id = ${mi}.id
                          AND (_mf.library_group_id IS NULL
                               OR _mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
                    )
                )
                WHEN 'season' THEN (
                    NOT EXISTS (
                        SELECT 1 FROM media_items _episode
                        JOIN media_file_items _mfi ON _mfi.media_item_id = _episode.id
                        WHERE _episode.parent_id = ${mi}.id
                    )
                    OR EXISTS (
                        SELECT 1 FROM media_items _episode
                        JOIN media_file_items _mfi ON _mfi.media_item_id = _episode.id
                        JOIN media_files _mf ON _mf.id = _mfi.file_id
                        WHERE _episode.parent_id = ${mi}.id
                          AND (_mf.library_group_id IS NULL
                               OR _mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
                    )
                )
                WHEN 'artist' THEN (
                    NOT EXISTS (
                        SELECT 1 FROM media_items _album
                        JOIN media_items _track ON _track.parent_id = _album.id
                        JOIN media_file_items _mfi ON _mfi.media_item_id = _track.id
                        WHERE _album.parent_id = ${mi}.id
                    )
                    OR EXISTS (
                        SELECT 1 FROM media_items _album
                        JOIN media_items _track ON _track.parent_id = _album.id
                        JOIN media_file_items _mfi ON _mfi.media_item_id = _track.id
                        JOIN media_files _mf ON _mf.id = _mfi.file_id
                        WHERE _album.parent_id = ${mi}.id
                          AND (_mf.library_group_id IS NULL
                               OR _mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
                    )
                )
                WHEN 'album' THEN (
                    NOT EXISTS (
                        SELECT 1 FROM media_items _track
                        JOIN media_file_items _mfi ON _mfi.media_item_id = _track.id
                        WHERE _track.parent_id = ${mi}.id
                    )
                    OR EXISTS (
                        SELECT 1 FROM media_items _track
                        JOIN media_file_items _mfi ON _mfi.media_item_id = _track.id
                        JOIN media_files _mf ON _mf.id = _mfi.file_id
                        WHERE _track.parent_id = ${mi}.id
                          AND (_mf.library_group_id IS NULL
                               OR _mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
                    )
                )
                ELSE (
                    NOT EXISTS (SELECT 1 FROM media_file_items WHERE media_item_id = ${mi}.id)
                    OR EXISTS (
                        SELECT 1 FROM media_file_items mfi
                        JOIN media_files mf ON mf.id = mfi.file_id
                        WHERE mfi.media_item_id = ${mi}.id
                        AND (mf.library_group_id IS NULL
                             OR mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
                    )
                )
            END
        )
        AND (
            ${mi}.library_group_id IS NULL
            OR ${mi}.library_group_id != ALL(${deniedGroupIds}::uuid[])
            OR CASE ${mi}.media_type
                WHEN 'tv' THEN EXISTS (
                    SELECT 1 FROM media_items _season
                    JOIN media_items _episode ON _episode.parent_id = _season.id
                    JOIN media_file_items _mfi ON _mfi.media_item_id = _episode.id
                    JOIN media_files _mf ON _mf.id = _mfi.file_id
                    WHERE _season.parent_id = ${mi}.id
                      AND (_mf.library_group_id IS NULL
                           OR _mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
                )
                WHEN 'season' THEN EXISTS (
                    SELECT 1 FROM media_items _episode
                    JOIN media_file_items _mfi ON _mfi.media_item_id = _episode.id
                    JOIN media_files _mf ON _mf.id = _mfi.file_id
                    WHERE _episode.parent_id = ${mi}.id
                      AND (_mf.library_group_id IS NULL
                           OR _mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
                )
                WHEN 'artist' THEN EXISTS (
                    SELECT 1 FROM media_items _album
                    JOIN media_items _track ON _track.parent_id = _album.id
                    JOIN media_file_items _mfi ON _mfi.media_item_id = _track.id
                    JOIN media_files _mf ON _mf.id = _mfi.file_id
                    WHERE _album.parent_id = ${mi}.id
                      AND (_mf.library_group_id IS NULL
                           OR _mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
                )
                WHEN 'album' THEN EXISTS (
                    SELECT 1 FROM media_items _track
                    JOIN media_file_items _mfi ON _mfi.media_item_id = _track.id
                    JOIN media_files _mf ON _mf.id = _mfi.file_id
                    WHERE _track.parent_id = ${mi}.id
                      AND (_mf.library_group_id IS NULL
                           OR _mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
                )
                ELSE EXISTS (
                    SELECT 1 FROM media_file_items _mfi
                    JOIN media_files _mf ON _mf.id = _mfi.file_id
                    WHERE _mfi.media_item_id = ${mi}.id
                      AND (_mf.library_group_id IS NULL
                           OR _mf.library_group_id != ALL(${deniedGroupIds}::uuid[]))
                )
            END
        )
    `;
}

/**
 * Library-access filter for media items whose group membership lives on
 * `media_items.library_group_id` rather than on their files.
 *
 * {@link buildLibraryAccessFilter} decides visibility from `media_file_items` and
 * therefore treats a row with NO files as visible to everyone — correct for
 * Jellyfin-only catalog entries (metadata a restricted user may see anyway), but
 * an access-control HOLE for file-less content that is genuinely playable and
 * genuinely group-scoped. Audiobooks are exactly that: the bytes live on the
 * AudiobookShelf server, so no `media_files` row ever exists, yet
 * `library_groups` still carries `max_age_rating`, `is_public` and the
 * per-group permission rows the operator relies on to keep one shelf away from
 * an account. Filtering those rows with the file-based builder would emit a
 * predicate every audiobook passes.
 *
 * Semantics otherwise mirror the sibling builder, including the `IS NULL`
 * branch: a row with no library group cannot be named by a denied-group list,
 * so it stays visible.
 *
 * @param sql - postgres.Sql instance for parameterized queries
 * @param scope - library scope, or legacy library_group_ids the user cannot access
 * @param alias - Table alias for media_items in the surrounding query (default: 'mi')
 * @returns SQL fragment to append after existing WHERE conditions (includes leading AND)
 */
export function buildLibraryGroupColumnFilter(
    sql: postgres.Sql,
    scope: LibraryScope | string[] | null | undefined,
    alias = 'mi',
): postgres.PendingQuery<postgres.Row[]> {
    const deniedGroupIds = resolveDeniedGroupIds(scope);
    if (deniedGroupIds === 'denyAll') return sql`AND false`;
    if (!deniedGroupIds || deniedGroupIds.length === 0) return sql``;

    if (!SAFE_IDENTIFIER.test(alias)) {
        throw new Error(`buildLibraryGroupColumnFilter: invalid alias "${alias}"`);
    }

    return sql`
        AND (
            ${sql(alias)}.library_group_id IS NULL
            OR ${sql(alias)}.library_group_id != ALL(${deniedGroupIds}::uuid[])
        )
    `;
}

/**
 * Collapse either accepted input to the denied-group list the predicate needs,
 * or the sentinel `'denyAll'`.
 */
function resolveDeniedGroupIds(
    scope: LibraryScope | string[] | null | undefined,
): string[] | null | undefined | 'denyAll' {
    if (scope === null || scope === undefined || Array.isArray(scope)) return scope;
    switch (scope.kind) {
        case 'all':
            return null;
        case 'denyGroups':
            return scope.ids;
        case 'denyAll':
            return 'denyAll';
    }
}
