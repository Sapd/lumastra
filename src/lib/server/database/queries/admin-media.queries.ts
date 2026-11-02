// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin Media Query Module
 *
 * Pure SQL queries for the admin media list and detail pages.
 * All functions take `sql: postgres.Sql` as first parameter and have no side effects.
 */

import type postgres from 'postgres';
import { effectivePosterSql, effectivePosterItemsSql } from './image-descriptor.queries.js';
import { currentHealthIssueReviewSql } from './file-health-review.queries.js';
import { buildLibraryGroupFilter } from './builders/library-group.builder.js';
import {
    actionableFileHealthSql,
    boundedHealthDurationSql,
    boundedHealthIssueElementsSql,
} from './file-health-classification.queries.js';
import {
    buildSearchFilter,
    buildTsQueryFromText,
    escapeLikePattern,
    searchNeedsTrigramThreshold,
} from './builders/search-filter.builder.js';
import { runWithTrigramThreshold } from './builders/trigram-threshold.builder.js';
import { buildAdminBrowserBaseScope } from './builders/admin-media-scope.builder.js';
import { buildMusicHygieneFragment } from './music-hygiene.queries.js';
import type { MusicHygieneFinding } from '$lib/shared/music-hygiene.js';
import { isSeries } from '$lib/server/utils/media-types.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { coverageHealthStatus, getSeriesEpisodeCoverage } from './series-health.queries.js';
import { issueMediaTypes, type MediaIssueKind } from '$lib/shared/media-issues.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface AdminMediaListOpts {
    types: string[];
    query?: string;
    searchScope?: 'title' | 'metadata';
    libraryGroupId?: string;
    showUnavailable?: boolean;
    /** When true, show only items with no external_ids (unidentified). */
    unidentified?: boolean;
    /**
     * When true, include dismissed items (`is_dismissed = true`) alongside the
     * rest; when false/omitted they are excluded.
     *
     * Independent of {@link unidentified}. It used to be gated on it, which made
     * dismissed rows reachable ONLY from the unidentified domain — and that
     * domain is itself restricted to `('movie','tv')`. Dismissal is no longer
     * just a "failed TMDB match" state: the AudiobookShelf ingest sweep marks a
     * book dismissed when it disappears upstream (an availability observation
     * may never write `status = 'deleted'`), so dismissed rows accumulate in
     * ordinary browse domains and an operator must be able to list and purge
     * them.
     *
     * Note this INCLUDES dismissed items rather than showing only them.
     */
    showDismissed?: boolean;
    limit: number;
    offset: number;
    sortBy?: 'title' | 'year' | 'created_at' | 'updated_at' | 'artist' | 'hierarchy';
    sortDir?: 'asc' | 'desc';
    // Advanced filters
    missingTmdb?: boolean;
    missingJf?: boolean;
    missingPoster?: boolean;
    missingOverview?: boolean;
    hasEmbedding?: boolean;
    locked?: boolean;
    localOnly?: boolean;
    customPoster?: boolean;
    addedSince?: string; // ISO date string
    updatedSince?: string; // ISO date string
    /**
     * "Has file issues" filter (admin IA redesign — replaces the removed Media
     * browser File Health / Integrity tabs, spec §3.2). Matches items whose
     * linked file(s) carry recorded health issues (truncated video, missing
     * keyframes, duration mismatch, corrupt tags) OR have an open,
     * row-scoped integrity violation. Deep-link target: `?filter=file-issues`.
     */
    fileIssues?: boolean;
    /**
     * One music-hygiene finding (`?filter=music-…`). Its predicate lives in
     * `music-hygiene.queries.ts`, which also owns the badge counts; this module
     * only applies it to the browser's list and total so the three can never be
     * over different populations.
     *
     * Single-valued for the same reason `fileIssues` is: the browser parses one
     * `filter=` value, so a second finding replaces the first rather than
     * intersecting with it.
     */
    musicHygiene?: MusicHygieneFinding;
    /**
     * A saved view's issue (`?view=` in the browser): only rows that have this
     * problem, with the per-media-type guard from `media-issues.ts`. Distinct
     * from the `missingTmdb`/`missingPoster`/… advanced filters, which are
     * literal column checks with no type guard.
     */
    issue?: MediaIssueKind;
    /** The "Needs attention" view: rows with ANY of these issues. */
    attentionKinds?: MediaIssueKind[];
    /**
     * Only rows whose title sorts before this value under the list's own
     * title collation (`natural_sort`). Used to COUNT the rows ahead of a
     * letter for the A–Z jump; never set on a list query.
     */
    titleBefore?: string;
    /**
     * Only descendants of this item, two levels deep (series -> season ->
     * episode, including an episode parented directly to its series). The
     * series drill-down lists a series' seasons and episodes through the SAME
     * list query as the page, so child rows carry the same issue columns.
     */
    ancestorId?: string;
    /** Only these items (the detail page's issues strip reads one row this way). */
    itemIds?: string[];
}

export interface AdminMediaRow {
    id: string;
    title: string | null;
    original_title: string | null;
    english_title: string | null;
    year: number | null;
    media_type: string;
    status: string | null;
    season_number: number | null;
    episode_number: number | null;
    created_at: string;
    updated_at: string;
    jellyfin_id: string | null;
    /** Sync coverage, including episode links for an ID-less series. */
    jellyfin_linked: boolean;
    tmdb_id: string | null;
    child_count: number;
    has_files: boolean;
    metadata_locked: boolean;
    is_local_only: boolean;
    poster_blurhash: string | null;
    has_poster: boolean;
    has_overview: boolean;
    runtime_seconds: number | null;
    overview: string | null;
    file_count: number;
    /**
     * Distinct file-health issue types recorded on this item's own file(s)
     * (e.g. `truncated_video`, `no_keyframes`, `tag_parse_corrupt`). Empty when
     * the item has no file issues. Same source as the `fileIssues` filter.
     */
    health_issue_types: string[];
    /**
     * The same issues with their recorded specifics — the verbatim reason
     * (`detail`), which file it is on, and the durations behind a
     * `video_ends_early`. `health_issue_types` stays as the deduped set the
     * filter/severity logic keys off; this is what the admin actually reads
     * when asking "what is wrong with this file, and where".
     */
    health_issue_details: Array<{
        type: string;
        detail: string | null;
        file_path: string | null;
        detected_at: string | null;
        expected_duration: number | null;
        actual_duration: number | null;
    }>;
    /** Open (unresolved) integrity violations scoped to this item's row. */
    integrity_issues: Array<{ rule: string; severity: string | null; message: string | null }>;
    /**
     * First author, first narrator and derived series of an AudiobookShelf book,
     * for the audiobook domain's Author / Narrator / Series columns. Null on
     * every other media type — nothing else writes `custom_metadata.audiobookshelf`.
     *
     * Only the FIRST of each list: these are list columns, and a book with nine
     * narrators would otherwise wrap the row. The full lists live on the item's
     * Book tab, which is where an operator goes for them.
     */
    book_author: string | null;
    book_narrator: string | null;
    book_series: string | null;
    /** Position within `book_series`. Text, so a decimal sequence survives. */
    book_series_sequence: string | null;
    /**
     * Ancestry titles, resolved by `media_type` rather than by depth.
     *
     * Depth is not reliable: episodes are normally `tv → season → episode`, but
     * this codebase also supports an episode parented DIRECTLY to the series
     * (see `episode-parent-not-season` in the integrity scanner). Keying on the
     * ancestor's own media_type gets both shapes right, and leaves the
     * inapplicable field null rather than putting a series title in a season
     * column.
     */
    artist_title: string | null;
    album_title: string | null;
    series_title: string | null;
    season_title: string | null;
    /**
     * The parent's / grandparent's title when it is not one of the four named
     * hierarchy levels above — a movie or episode that owns an `extra`, or a
     * `home_video`/`training` item that does. Null on every row the named
     * columns already describe, so the client can fall through in order.
     */
    generic_parent_title: string | null;
    generic_root_title: string | null;
    /** File row with no external ids that has a TMDB discovery twin (see buildFilelessTwinExists). */
    is_duplicate: boolean;
    /** The item had files and lost them (files_lost_at set, has_files false). */
    files_lost: boolean;
    /** Series only: episodes with a file problem (buildEpisodeProblemsBySeries). 0 otherwise. */
    episode_problem_count: number;
    parent_id: string | null;
}

export interface AdminMediaCountRow {
    total: number;
}

export interface AdminMediaDetailRow {
    id: string;
    title: string | null;
    title_source: string | null;
    is_dismissed: boolean;
    canonical_id: string | null;
    metadata_locked: boolean;
    metadata_locked_by: string | null;
    lock_version: string | null;
    original_title: string | null;
    english_title: string | null;
    year: number | null;
    media_type: string;
    status: string | null;
    parent_id: string | null;
    season_number: number | null;
    episode_number: number | null;
    runtime_seconds: number | null;
    premiere_date: string | null;
    overview: string | null;
    created_at: string;
    updated_at: string;
    custom_metadata: Record<string, unknown> | null;
    custom_poster_url?: string | null;
    custom_backdrop_url?: string | null;
    custom_logo_url?: string | null;
}

export interface MediaChildCounts {
    seasonCount: number;
    episodeCount: number;
}

export interface AncestorRow {
    id: string;
    title: string | null;
    media_type: string;
    season_number: number | null;
    parent_id: string | null;
    depth: number;
}

export interface DuplicateMediaItem {
    id: string;
    title: string;
    year: number | null;
    created_at: string;
}

export interface DuplicateMediaRow {
    tmdb_id: string;
    media_type: string;
    items: DuplicateMediaItem[];
}

// ---------------------------------------------------------------------------
// Filter fragment builders
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Advanced filter fragment builders
// ---------------------------------------------------------------------------

/**
 * Episodes with a file problem, rolled up to their series: one row per
 * (series_id, episode_id). Built bottom-up from the few problem files (317 of
 * 82k on prod, 2026-09-27) and open integrity violations, then walked up
 * episode -> season -> series. The per-series correlated form (does ANY
 * descendant episode have a problem?) took 55 s over prod's series; this form
 * takes ~19 ms. Handles an episode parented directly to its series too.
 */
function buildEpisodeProblemsBySeries(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        SELECT DISTINCT
            COALESCE(
                CASE WHEN ep_gp.media_type = 'tv' THEN ep_gp.id END,
                CASE WHEN ep_p.media_type = 'tv' THEN ep_p.id END
            ) AS series_id,
            ep.id AS episode_id
        FROM (
            SELECT mfi_b.media_item_id AS item_id
            FROM media_files mf_b
            JOIN media_file_items mfi_b ON mfi_b.file_id = mf_b.id
            -- The classifier can only accept recorded evidence. Expose that
            -- necessary condition here so the sparse health-issues index can
            -- select candidates before the richer proof/review checks.
            WHERE mf_b.health_issues IS NOT NULL AND mf_b.health_issues <> '[]'::jsonb
              AND ${actionableFileHealthSql(sql, sql`mf_b.id`)}
            UNION
            SELECT iv_b.media_id FROM integrity_violations iv_b WHERE iv_b.resolved_at IS NULL
        ) bad
        JOIN media_items ep ON ep.id = bad.item_id AND ep.media_type = 'episode'
        LEFT JOIN media_items ep_p ON ep_p.id = ep.parent_id
        LEFT JOIN media_items ep_gp ON ep_gp.id = ep_p.parent_id
    `;
}

/** A row that is part of the library: it has files, or it had them and lost them. */
function libraryRowPredicate(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`(mi.has_files = true OR mi.files_lost_at IS NOT NULL)`;
}

/**
 * A movie/series FILE row with no external ids that has a TMDB discovery twin:
 * a file-less row of the same media_type and year whose normalized title
 * matches and that carries a TMDB id. The pairing
 * `findFilelessDuplicatePairsWithTotal` merges (it additionally requires the
 * pair to be unambiguous before offering a merge; listing a candidate here
 * does not). `alias` is the outer row: 'mi' in a WHERE, 'page' in the list's
 * decorate stage.
 */
function buildFilelessTwinExists(
    sql: postgres.Sql,
    alias: 'mi' | 'page',
): postgres.PendingQuery<postgres.Row[]> {
    const o = sql(alias);
    return sql`(
        ${o}.parent_id IS NULL
        AND ${o}.year IS NOT NULL
        AND ${o}.has_files = true
        AND NOT EXISTS (SELECT 1 FROM external_ids ei_f WHERE ei_f.media_id = ${o}.id AND ei_f.source IS DISTINCT FROM 'watch-sync-file')
        AND EXISTS (
            SELECT 1 FROM media_items d
            WHERE d.media_type = ${o}.media_type
              AND d.year = ${o}.year
              AND d.id <> ${o}.id
              AND d.parent_id IS NULL
              AND d.status = 'active'
              AND NOT d.is_dismissed
              AND d.has_files = false
              AND EXISTS (SELECT 1 FROM external_ids ei_t WHERE ei_t.media_id = d.id AND ei_t.provider = 'tmdb')
              AND BTRIM(regexp_replace(regexp_replace(LOWER(TRIM(d.title)), '[^a-z0-9 ]', '', 'g'), ' +', ' ', 'g'))
                = BTRIM(regexp_replace(regexp_replace(LOWER(TRIM(${o}.title)), '[^a-z0-9 ]', '', 'g'), ' +', ' ', 'g'))
        )
    )`;
}

/**
 * Jellyfin watch sync targets movies and episodes. Series marks fan out to
 * episodes and NextUp uses internal UUIDs, so file pairing needs no series ID.
 * Preserve explicit links; otherwise require every active local episode to be
 * linked, with at least one episode (not a vacuous match on an empty series).
 */
function buildJellyfinLinked(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`(
        EXISTS (SELECT 1 FROM external_ids ei_jf WHERE ei_jf.media_id = mi.id AND ei_jf.provider = 'jellyfin')
        OR ${fileSiblingLinked(sql, sql`mi.id`)}
        OR (mi.media_type = 'tv' AND (
            SELECT COUNT(*) > 0 AND BOOL_AND(
                EXISTS (
                    SELECT 1 FROM external_ids ei_ep_jf
                    WHERE ei_ep_jf.media_id = ep_jf.id AND ei_ep_jf.provider = 'jellyfin'
                ) OR ${fileSiblingLinked(sql, sql`ep_jf.id`)}
            )
            FROM media_items season_jf
            JOIN media_items ep_jf ON ep_jf.parent_id = season_jf.id
                AND ep_jf.media_type = 'episode' AND ep_jf.status = 'active' AND ep_jf.has_files = true
            WHERE season_jf.parent_id = mi.id AND season_jf.media_type = 'season'
        ))
    )`;
}

/**
 * An episode of a combined file (`S01E03-E04`) shares its file with episodes that
 * Jellyfin lists as one item spanning the range. That item is paired to the first
 * episode and its watched mark covers the rest, so the rest need no link of their own.
 */
function fileSiblingLinked(
    sql: postgres.Sql,
    episodeId: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    // Earlier episodes only, in the same season: the pull extends a watched mark
    // forward over the file, never backward.
    return sql`EXISTS (
        SELECT 1 FROM media_file_items own_mfi
        JOIN media_items own_ep ON own_ep.id = own_mfi.media_item_id
        JOIN media_file_items sib_mfi ON sib_mfi.file_id = own_mfi.file_id
            AND sib_mfi.media_item_id <> own_mfi.media_item_id AND sib_mfi.is_default
        JOIN media_items sib_ep ON sib_ep.id = sib_mfi.media_item_id
            AND sib_ep.status = 'active'
            AND sib_ep.parent_id = own_ep.parent_id AND sib_ep.episode_number < own_ep.episode_number
        JOIN external_ids sib_jf ON sib_jf.media_id = sib_ep.id AND sib_jf.provider = 'jellyfin'
        WHERE own_mfi.media_item_id = ${episodeId} AND own_mfi.is_default
    )`;
}

/**
 * One saved-view issue as a boolean SQL expression over `mi`. The media-type
 * guards come from `ISSUE_MEDIA_TYPES` (media-issues.ts), the same table the
 * row badges use, so a view's rows and its rows' badges cannot disagree.
 */
function buildIssuePredicate(
    sql: postgres.Sql,
    kind: MediaIssueKind,
    hasPoster = effectivePosterSql(sql, sql`mi.id`),
): postgres.PendingQuery<postgres.Row[]> {
    switch (kind) {
        case 'files_lost':
            return sql`(mi.has_files = false AND mi.files_lost_at IS NOT NULL)`;
        case 'file_problem':
            // Own files (movies, episodes, tracks) OR, for a series, any of its
            // episodes — a series row owns no files, so without the roll-up a
            // broken episode is invisible in every scope that lists series.
            return sql`((
            EXISTS (
                SELECT 1 FROM media_file_items mfi_issues
                JOIN media_files mf_issues ON mf_issues.id = mfi_issues.file_id
                WHERE mfi_issues.media_item_id = mi.id
                  AND ${actionableFileHealthSql(sql, sql`mf_issues.id`)}
            )
            OR EXISTS (
                SELECT 1 FROM integrity_violations iv_issues
                WHERE iv_issues.media_id = mi.id AND iv_issues.resolved_at IS NULL
            )
        )
            OR (mi.media_type = 'tv' AND mi.id IN (
                SELECT series_id FROM (${buildEpisodeProblemsBySeries(sql)}) eps
            )))`;
        case 'no_tmdb':
            return sql`(mi.media_type = ANY(${issueMediaTypes('no_tmdb')})
                AND NOT EXISTS (SELECT 1 FROM external_ids ei_v WHERE ei_v.media_id = mi.id AND ei_v.provider = 'tmdb'))`;
        case 'no_poster':
            return sql`(mi.media_type = ANY(${issueMediaTypes('no_poster')}) AND NOT ${hasPoster})`;
        case 'no_overview':
            return sql`(mi.media_type = ANY(${issueMediaTypes('no_overview')})
                AND (mi.overview IS NULL OR mi.overview = ''))`;
        case 'not_in_jellyfin':
            return sql`(mi.media_type = ANY(${issueMediaTypes('not_in_jellyfin')}) AND mi.has_files = true
                AND NOT ${buildJellyfinLinked(sql)})`;
        case 'duplicate':
            return sql`(mi.media_type = ANY(${issueMediaTypes('duplicate')}) AND ${buildFilelessTwinExists(sql, 'mi')})`;
    }
}

function buildAdvancedFilterFragments(
    sql: postgres.Sql,
    opts: Pick<
        AdminMediaListOpts,
        | 'missingTmdb'
        | 'missingJf'
        | 'missingPoster'
        | 'missingOverview'
        | 'hasEmbedding'
        | 'locked'
        | 'localOnly'
        | 'customPoster'
        | 'addedSince'
        | 'updatedSince'
        | 'fileIssues'
        | 'musicHygiene'
        | 'issue'
        | 'attentionKinds'
        | 'titleBefore'
        | 'ancestorId'
        | 'itemIds'
    >,
): postgres.PendingQuery<postgres.Row[]>[] {
    const fragments: postgres.PendingQuery<postgres.Row[]>[] = [];

    if (opts.missingTmdb)
        fragments.push(
            sql`AND NOT EXISTS (SELECT 1 FROM external_ids ei_tmdb WHERE ei_tmdb.media_id = mi.id AND ei_tmdb.provider = 'tmdb')`,
        );
    if (opts.missingJf) fragments.push(sql`AND NOT ${buildJellyfinLinked(sql)}`);
    if (opts.missingPoster) fragments.push(sql`AND NOT ${effectivePosterSql(sql, sql`mi.id`)}`);
    if (opts.missingOverview) fragments.push(sql`AND (mi.overview IS NULL OR mi.overview = '')`);
    if (opts.hasEmbedding)
        fragments.push(
            sql`AND EXISTS (SELECT 1 FROM media_embeddings me WHERE me.media_id = mi.id)`,
        );
    if (opts.locked) fragments.push(sql`AND mi.metadata_locked = true`);
    if (opts.localOnly) fragments.push(sql`AND mi.is_local_only = true`);
    if (opts.customPoster) fragments.push(sql`AND mi.custom_poster_url IS NOT NULL`);
    if (opts.addedSince) fragments.push(sql`AND mi.created_at >= ${opts.addedSince}`);
    if (opts.updatedSince) fragments.push(sql`AND mi.updated_at >= ${opts.updatedSince}`);
    if (opts.fileIssues) fragments.push(sql`AND ${buildIssuePredicate(sql, 'file_problem')}`);
    if (opts.musicHygiene) fragments.push(buildMusicHygieneFragment(sql, opts.musicHygiene));
    if (opts.issue) fragments.push(sql`AND ${buildIssuePredicate(sql, opts.issue)}`);
    if (opts.itemIds) fragments.push(sql`AND mi.id = ANY(${opts.itemIds}::uuid[])`);
    if (opts.ancestorId) {
        fragments.push(sql`AND (
            mi.parent_id = ${opts.ancestorId}::uuid
            OR mi.parent_id IN (SELECT anc.id FROM media_items anc WHERE anc.parent_id = ${opts.ancestorId}::uuid)
        )`);
    }
    if (opts.titleBefore !== undefined) {
        // NULL titles sort LAST in the list (NULLS LAST), so they are never "before".
        fragments.push(sql`AND mi.title COLLATE natural_sort < ${opts.titleBefore}`);
    }
    if (opts.attentionKinds && opts.attentionKinds.length > 0) {
        const anyOf = opts.attentionKinds
            .map((k) => buildIssuePredicate(sql, k))
            .reduce((acc, p) => sql`${acc} OR ${p}`);
        // The population is library rows: rows with files, plus rows whose
        // files disappeared. A catalog-only TMDB discovery row (has_files
        // false, never had files) with no poster is not a library problem.
        fragments.push(sql`AND ${libraryRowPredicate(sql)} AND (${anyOf})`);
    }

    return fragments;
}

/** Combine an array of SQL fragments into one (empty array → empty fragment). */
function joinFragments(
    sql: postgres.Sql,
    fragments: postgres.PendingQuery<postgres.Row[]>[],
): postgres.PendingQuery<postgres.Row[]> {
    if (fragments.length === 0) return sql``;
    return fragments.reduce((acc, f) => sql`${acc} ${f}`);
}

/**
 * Restrict the search CTE to the active media-type tab when that tab is closed
 * under parent-chain expansion. If a caller searches only episodes or seasons,
 * the CTE must still be allowed to find the parent series title.
 */
function closedSearchTypeScope(types: string[]): string[] | undefined {
    if (types.length === 0) return undefined;

    const set = new Set(types);
    if (set.has('episode') && (!set.has('season') || !set.has('tv'))) return undefined;
    if (set.has('season') && !set.has('tv')) return undefined;
    if (set.has('track') && (!set.has('album') || !set.has('artist'))) return undefined;
    if (set.has('album') && !set.has('artist')) return undefined;

    return types;
}

/**
 * @param ref The table/CTE alias `title`/`original_title`/`english_title`/
 * `search_vector` are qualified with. Defaults to `mi`, the only alias
 * `listAdminMediaItems` uses it with.
 */
function buildAdminSearchOrderFragment(
    sql: postgres.Sql,
    query: string | undefined,
    fallbackOrder: postgres.PendingQuery<postgres.Row[]>,
    ref = 'mi',
): postgres.PendingQuery<postgres.Row[]> {
    const trimmedQuery = query?.trim();
    if (!trimmedQuery) return fallbackOrder;

    const tsQuery = buildTsQueryFromText(trimmedQuery);
    if (!tsQuery) return fallbackOrder;

    const prefixPattern = `${escapeLikePattern(trimmedQuery)}%`;
    const titleRank = sql`ts_rank(
        '{0,0,0,1}',
        ${sql(ref)}.search_vector,
        to_tsquery('simple', immutable_unaccent(${tsQuery}))
    )`;
    const fullRank = sql`ts_rank(
        ${sql(ref)}.search_vector,
        to_tsquery('simple', immutable_unaccent(${tsQuery}))
    )`;
    const trigramRank = sql`GREATEST(
        COALESCE(similarity(immutable_unaccent(${sql(ref)}.title), immutable_unaccent(${trimmedQuery})), 0),
        COALESCE(similarity(german_digraph_fold(${sql(ref)}.title), german_digraph_fold(${trimmedQuery})), 0),
        COALESCE(similarity(immutable_unaccent(${sql(ref)}.original_title), immutable_unaccent(${trimmedQuery})), 0),
        COALESCE(similarity(german_digraph_fold(${sql(ref)}.original_title), german_digraph_fold(${trimmedQuery})), 0),
        COALESCE(similarity(immutable_unaccent(${sql(ref)}.english_title), immutable_unaccent(${trimmedQuery})), 0),
        COALESCE(similarity(german_digraph_fold(${sql(ref)}.english_title), german_digraph_fold(${trimmedQuery})), 0)
    )`;

    return sql`
        CASE
            WHEN immutable_unaccent(${sql(ref)}.title) = immutable_unaccent(${trimmedQuery}) THEN 100.0
            WHEN immutable_unaccent(${sql(ref)}.original_title) = immutable_unaccent(${trimmedQuery}) THEN 95.0
            WHEN immutable_unaccent(${sql(ref)}.english_title) = immutable_unaccent(${trimmedQuery}) THEN 90.0
            WHEN immutable_unaccent(${sql(ref)}.title) ILIKE immutable_unaccent(${prefixPattern}) THEN 80.0
            WHEN immutable_unaccent(${sql(ref)}.original_title) ILIKE immutable_unaccent(${prefixPattern}) THEN 75.0
            WHEN immutable_unaccent(${sql(ref)}.english_title) ILIKE immutable_unaccent(${prefixPattern}) THEN 70.0
            WHEN ${titleRank} > 0 THEN ${titleRank} + 50.0
            WHEN ${trigramRank} > 0 THEN ${trigramRank} + 20.0
            WHEN ${fullRank} > 0 THEN ${fullRank}
            ELSE 0.0
        END DESC,
        ${fallbackOrder}
    `;
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Fetch a paginated list of media items for the admin media list page.
 *
 * Improvements over the inline route version:
 * - child_count uses LEFT JOIN LATERAL instead of correlated subqueries
 * - Filters out unmatched scanner stubs: TV items with no external IDs, no year,
 *   and 0-2 children (artifacts from failed provider matching)
 */
/** Title scope never consults synopsis, people, keywords or ancestor metadata. */
function buildAdminBrowserSearch(
    sql: postgres.Sql,
    query: string | undefined,
    scope: 'title' | 'metadata' | undefined,
    options: Parameters<typeof buildSearchFilter>[2],
): ReturnType<typeof buildSearchFilter> {
    if (scope === 'metadata') return buildSearchFilter(sql, query, options);
    if (!query?.trim()) return { cte: sql``, where: sql``, needsTrigramThreshold: false };
    const pattern = `%${escapeLikePattern(query.trim())}%`;
    return {
        cte: sql``,
        needsTrigramThreshold: false,
        where: sql`AND (immutable_unaccent(mi.title) ILIKE immutable_unaccent(${pattern})
            OR immutable_unaccent(mi.original_title) ILIKE immutable_unaccent(${pattern})
            OR immutable_unaccent(mi.english_title) ILIKE immutable_unaccent(${pattern})
            OR mi.id IN (SELECT title_alias.media_id FROM media_titles title_alias
                WHERE immutable_unaccent(title_alias.title) ILIKE immutable_unaccent(${pattern})))`,
    };
}

export async function listAdminMediaItems(
    sql: postgres.Sql,
    opts: AdminMediaListOpts,
): Promise<AdminMediaRow[]> {
    const {
        types,
        query,
        libraryGroupId,
        showUnavailable,
        unidentified,
        showDismissed,
        limit,
        offset,
    } = opts;

    const needsThreshold = searchNeedsTrigramThreshold(query);

    return runWithTrigramThreshold(sql, needsThreshold, (db) => {
        // Shared with the artist_title/album_title/series_title OUTPUT columns
        // in pageCte below (same CASE, one definition). Needed as RAW
        // expressions rather than bare alias references because namedOrder()'s
        // result is used both as the CTE's own top-level ORDER BY (where an
        // output alias would resolve fine) AND inside a `row_number() OVER
        // (ORDER BY ...)` embedded in that CTE's own SELECT list, where a
        // sibling SELECT-list alias is NOT yet resolvable — Postgres raised
        // `column "artist_title" does not exist` for exactly this reason when
        // the bare alias was tried there. A raw expression works in both
        // places, so there's only one variant to keep in sync with the output
        // columns instead of two.
        const artistTitleExpr = db`CASE
            WHEN gp.media_type = 'artist' THEN gp.title
            WHEN p.media_type  = 'artist' THEN p.title
        END`;
        const albumTitleExpr = db`CASE WHEN p.media_type = 'album' THEN p.title END`;
        const seriesTitleExpr = db`CASE
            WHEN gp.media_type = 'tv' THEN gp.title
            WHEN p.media_type  = 'tv' THEN p.title
        END`;

        const sortColumns = {
            // Numeric-aware: "2 Fast 2 Furious" before "28 Years Later". The
            // collation is created by migration 16.271.0.
            title: db`mi.title COLLATE natural_sort`,
            year: db`mi.year`,
            created_at: db`mi.created_at`,
            updated_at: db`mi.updated_at`,
        } as const;

        const sortKey = opts.sortBy ?? 'title';

        /**
         * Multi-column groupings that a single whitelisted column cannot express.
         *
         * Always ascending: these are a grouping, not a ranking, and a
         * descending "group by artist" is not a thing an operator wants. The UI
         * offers no direction toggle for them.
         *
         * ORDER BY may reference SELECT output aliases in Postgres, so the
         * ancestry columns are addressable here by name.
         *
         * `hierarchy` only takes the TV branch when the requested type set is
         * TV-only, and the music branch when it is music-only. A type set that
         * spans BOTH hierarchies (e.g. the "Everything" domain, whose type set
         * contains both 'episode' and 'track') has no single hierarchy to group
         * by: movies, music and audiobook rows all carry null
         * series_title/season_number/episode_number, so taking the TV branch
         * there would silently collapse them into a title-only tail while this
         * function's own name claims to be grouping by hierarchy. Do not
         * collapse this back to an unconditional `set.has('episode') ||
         * set.has('season')` check — that is the bug this guards against.
         */
        function namedOrder(): postgres.PendingQuery<postgres.Row[]> | null {
            const set = new Set(types);
            if (sortKey === 'artist') {
                return db`${artistTitleExpr} ASC NULLS LAST, mi.title COLLATE natural_sort ASC, mi.id`;
            }
            if (sortKey === 'hierarchy') {
                const isTvOnly =
                    (set.has('episode') || set.has('season')) &&
                    !set.has('track') &&
                    !set.has('album') &&
                    !set.has('artist');
                const isMusicOnly =
                    (set.has('track') || set.has('album') || set.has('artist')) &&
                    !set.has('episode') &&
                    !set.has('season');

                if (isTvOnly) {
                    return db`${seriesTitleExpr} ASC NULLS LAST, mi.season_number ASC NULLS LAST, mi.episode_number ASC NULLS LAST, mi.title COLLATE natural_sort ASC, mi.id`;
                }
                if (isMusicOnly) {
                    // sort_order is the repo's track-position column (music.queries.ts
                    // orders album tracks by COALESCE(t.sort_order, 0)). Without it,
                    // tracks sort alphabetically WITHIN an album, which is not what
                    // "group by hierarchy" means to anyone looking at an album.
                    //
                    // sort_order restarts at 1 on each disc, so it cannot order a
                    // multi-disc album by itself — without the disc term below a
                    // 2-disc album renders D1T1, D2T1, D1T2, D2T2. The disc number
                    // is persisted at `custom_metadata.disc_number` by the music
                    // scanner (`audio-processor.ts`: from the file's `discNumber`
                    // tag, else the `resolveAlbumDir` folder-name fallback), as a
                    // JSON number.
                    //
                    // GUARDED, not a bare `::int`: `api-music-responses.ts` types
                    // `disc_number` as `number | string`, so a string ("1/2" from a
                    // combined tag, say) can reach this column — and one such value
                    // anywhere in the result set fails the whole statement, taking
                    // every row on the page with it. `jsonb_typeof(...) = 'number'`
                    // yields NULL for those instead, exactly as the
                    // book_series_sequence projection below does.
                    //
                    // `::numeric`, not `::int`: `jsonb_typeof` says 'number' for
                    // 1.5 too, and `'1.5'::int` raises just as loudly as the
                    // string case this guard was written for — so the guard was
                    // only ever partial. jsonb stores every number as a numeric,
                    // so `::numeric` is total for everything the type check
                    // admits, and it orders integral values identically.
                    //
                    // NULLS FIRST: an untagged track sorts with disc 1 rather than
                    // being exiled past the last disc — the right answer for a
                    // single-disc album (every row NULL, order unchanged) and for a
                    // partially-tagged one. Album and artist rows in the mixed "All
                    // Music" view are all NULL here and share an album_title, so
                    // they tie and fall through to sort_order as before.
                    return db`${artistTitleExpr} ASC NULLS LAST, ${albumTitleExpr} ASC NULLS LAST,
                              CASE WHEN jsonb_typeof(mi.custom_metadata #> '{disc_number}') = 'number'
                                   THEN (mi.custom_metadata #>> '{disc_number}')::numeric
                              END ASC NULLS FIRST,
                              mi.sort_order ASC NULLS LAST, mi.title COLLATE natural_sort ASC, mi.id`;
                }
                // Mixed type set (both hierarchies) or neither hierarchy applies
                // (e.g. movies/audiobooks alone) — fall through to plain title order.
                return null;
            }
            return null;
        }

        const named = namedOrder();
        const sortCol = sortColumns[sortKey as keyof typeof sortColumns] ?? sortColumns.title;
        const orderFragment =
            named ??
            (opts.sortDir === 'desc'
                ? db`${sortCol} DESC NULLS LAST, mi.id`
                : db`${sortCol} ASC NULLS LAST, mi.id`);
        const searchOrderFragment = buildAdminSearchOrderFragment(db, query, orderFragment);

        // The base population — status, availability, type scope, dismissal and
        // the two stub exclusions — comes from the shared builder so a count
        // taken elsewhere (music-hygiene.queries.ts) is over the same rows this
        // list renders, rather than over a second hand-written copy of them.
        const baseScope = buildAdminBrowserBaseScope(db, {
            types,
            showUnavailable,
            showDismissed,
            unidentified,
        });

        const searchFilter = buildAdminBrowserSearch(db, query, opts.searchScope, {
            searchParent: true,
            searchGrandparent: true,
            mediaTypes: closedSearchTypeScope(types),
        });

        const libraryFragment = buildLibraryGroupFilter(db, libraryGroupId);
        const advancedFragment = joinFragments(db, buildAdvancedFilterFragments(db, opts));

        // Split into a "which 50 rows" stage and a "decorate those 50 rows"
        // stage. cc/fc/iss/shr below are pure per-row LEFT JOINs — nothing in
        // ${baseScope}/${searchFilter.where}/${libraryFragment}/${advancedFragment}
        // or in the ORDER BY references them (buildAdvancedFilterFragments'
        // fileIssues filter has its own separate EXISTS, not these columns) —
        // so evaluating them before the WHERE+ORDER BY+LIMIT ran them for
        // every candidate row (91,912 on prod for the "Everything" domain: the
        // child_count and file_count LATERALs alone cost ~300k and ~340k
        // buffer hits) even though only `limit` rows are ever rendered.
        // Measured on prod: 3.5s -> ~0.5s for the same page with the same
        // ${limit}=50/${offset}=0 params ("Everything" domain, no filters —
        // the worst case, since it touches the widest media_type set),
        // identical rows in identical order (verified via EXPLAIN ANALYZE +
        // a row-by-row diff against the pre-change query). `page` is a
        // MATERIALIZED CTE so Postgres can't inline it back into one plan and
        // undo the split (the same technique search-filter.builder.ts uses
        // for `_search_hits`).
        const pageCte = db`
            ${searchFilter.cte}
            SELECT
                mi.id, mi.title, mi.original_title, mi.english_title, mi.year, mi.media_type, mi.status,
                mi.season_number, mi.episode_number, mi.created_at, mi.updated_at,
                mi.has_files, mi.files_lost_at, mi.parent_id,
                mi.metadata_locked, mi.is_local_only, mi.poster_blurhash,
                mi.runtime_seconds, mi.overview,
                (mi.overview IS NOT NULL AND mi.overview <> '') AS has_overview,
                (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'jellyfin' LIMIT 1) AS jellyfin_id,
                ${buildJellyfinLinked(db)} AS jellyfin_linked,
                (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'tmdb' LIMIT 1) AS tmdb_id,
                -- AudiobookShelf book columns. The path operator returns NULL for
                -- a path that does not resolve (including indexing into a field the
                -- connector wrote as a scalar instead of an array), so one malformed
                -- blob costs that one cell rather than raising for the whole page.
                mi.custom_metadata #>> '{audiobookshelf,authors,0}'   AS book_author,
                mi.custom_metadata #>> '{audiobookshelf,narrators,0}' AS book_narrator,
                NULLIF(mi.custom_metadata #>> '{audiobookshelf,derivedSeries,name}', '')
                                                                      AS book_series,
                -- Guarded the way getAudiobookNodeDetail does it: ABS allows
                -- decimal sequences, which are persisted as STRINGS, and a bare
                -- numeric cast on one would fail the statement for every row on
                -- the page.
                CASE
                    WHEN jsonb_typeof(mi.custom_metadata #> '{audiobookshelf,derivedSeries,sequence}') = 'number'
                    THEN mi.custom_metadata #>> '{audiobookshelf,derivedSeries,sequence}'
                END                                                   AS book_series_sequence,
                ${artistTitleExpr}                                   AS artist_title,
                ${albumTitleExpr}                                    AS album_title,
                ${seriesTitleExpr}                                   AS series_title,
                CASE WHEN p.media_type = 'season' THEN p.title END    AS season_title,
                -- Generic fallbacks for a parent the four closed cases above do
                -- not name. Load-bearing for extras: a trailer's parent is a
                -- MOVIE or an EPISODE, neither of which matches artist/album/tv/
                -- season, so every ancestry column came back NULL and the
                -- Everything view rendered the trailer with an em-dash for both
                -- Parent and Root -- a row an operator cannot attribute to
                -- anything.
                --
                -- Added as NEW aliases rather than by widening the four above:
                -- namedOrder() sorts on series_title / artist_title BY NAME, so
                -- putting a movie title into series_title would silently reorder
                -- the TV grouping.
                CASE
                    WHEN p.media_type IS NOT NULL
                     AND p.media_type NOT IN ('artist', 'album', 'tv', 'season')
                    THEN p.title
                END                                                   AS generic_parent_title,
                CASE
                    WHEN gp.media_type IS NOT NULL
                     AND gp.media_type NOT IN ('artist', 'tv')
                    THEN gp.title
                END                                                   AS generic_root_title,
                -- Anchors the outer query's final ORDER BY to the exact order
                -- this CTE's own ORDER BY/LIMIT/OFFSET already committed to,
                -- without needing to re-derive that order (which would mean
                -- carrying mi.custom_metadata/mi.search_vector -- a jsonb blob
                -- and a tsvector -- through this CTE for every CANDIDATE row
                -- instead of just the page size that survives; tried,
                -- measured ~3x slower) or trusting CTE materialization to
                -- preserve row order through the LATERAL joins added below.
                row_number() OVER (ORDER BY ${searchOrderFragment}) AS page_seq
            FROM media_items mi
            -- Single-valued PK joins on parent_id: at most one row each, so
            -- these cannot multiply the result the way an m:n file join would.
            LEFT JOIN media_items p  ON p.id  = mi.parent_id
            LEFT JOIN media_items gp ON gp.id = p.parent_id
            WHERE ${baseScope}
            ${searchFilter.where}
            ${libraryFragment}
            ${advancedFragment}
            ORDER BY ${searchOrderFragment}
            LIMIT ${limit} OFFSET ${offset}
        `;

        return db<AdminMediaRow[]>`
            WITH page AS MATERIALIZED (${pageCte}),
            episode_problems AS (
                SELECT series_id, COUNT(*)::int AS episode_problem_count
                FROM (${buildEpisodeProblemsBySeries(db)}) eps
                GROUP BY series_id
            )
            SELECT
                page.*,
                ${effectivePosterSql(db, db`page.id`)} AS has_poster,
                COALESCE(epp.episode_problem_count, 0) AS episode_problem_count,
                COALESCE(cc.child_count, 0) AS child_count,
                COALESCE(fc.file_count, 0) AS file_count,
                COALESCE(iss.health_issue_types, ARRAY[]::text[]) AS health_issue_types,
                COALESCE(iss.health_issue_details, '[]'::jsonb) AS health_issue_details,
                COALESCE(iss.integrity_issues, '[]'::jsonb) AS integrity_issues,
                -- Decorate-stage only (the visible rows). The media-type guard
                -- is deriveMediaIssues', from the same ISSUE_MEDIA_TYPES table.
                ${buildFilelessTwinExists(db, 'page')} AS is_duplicate,
                page.files_lost_at IS NOT NULL AND page.has_files = false AS files_lost
            FROM page
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS child_count
                FROM media_items c
                WHERE c.parent_id = page.id
            ) cc ON true
            LEFT JOIN LATERAL (
                SELECT COUNT(*)::int AS file_count
                FROM media_file_items mfi
                WHERE mfi.media_item_id = page.id
            ) fc ON true
            LEFT JOIN LATERAL (
                SELECT
                    (
                        -- TOTAL extraction, for the same reasons spelled out on
                        -- getMediaPreview's health-issues query -- but with a
                        -- blast radius an order of magnitude larger. This runs
                        -- on EVERY media-browser page load, so one malformed
                        -- health_issues blob anywhere in the page's rows used to
                        -- take down the whole page, not one panel.
                        --
                        -- The shared lateral indexes at most 20 entries and
                        -- substitutes an unknown marker for a non-array.
                        --
                        -- The type IS NOT NULL qual drops elements with no type
                        -- key: this column is declared string[] in TS, and such
                        -- an element used to put a literal null into it, which
                        -- the browser then rendered as a nameless issue chip.
                        SELECT array_agg(DISTINCT CASE WHEN jsonb_typeof(he.elem->'type') = 'string' AND length(he.elem->>'type') BETWEEN 1 AND 80
                            THEN he.elem->>'type' ELSE 'unknown_recorded_evidence' END)
                        FROM media_file_items mfi_h
                        JOIN media_files mf_h ON mf_h.id = mfi_h.file_id
                        CROSS JOIN LATERAL (${boundedHealthIssueElementsSql(db, db`mf_h.health_issues`)}) AS he
                        WHERE mfi_h.media_item_id = page.id
                          AND ${actionableFileHealthSql(db, db`mf_h.id`)}
                          AND he.ordinal <= 20
                    ) AS health_issue_types,
                    (
                        -- Same rows, but keeping each issue's own specifics so
                        -- the UI can show the exact ffmpeg reason and which
                        -- file it came from instead of a bare type name.
                        SELECT jsonb_agg(
                            jsonb_build_object(
                                'type', CASE WHEN jsonb_typeof(he.elem->'type') = 'string' AND length(he.elem->>'type') BETWEEN 1 AND 80
                            THEN he.elem->>'type' ELSE 'unknown_recorded_evidence' END,
                                'detail', left(he.elem->>'detail', 2048),
                                'file_path', mf_h.file_path,
                                'detected_at', he.elem->>'detected_at',
                                'expected_duration', ${boundedHealthDurationSql(db, db`he.elem->'expected_duration'`)},
                                'actual_duration', ${boundedHealthDurationSql(db, db`he.elem->'actual_duration'`)}
                            )
                            ORDER BY he.elem->>'detected_at' DESC NULLS LAST
                        )
                        -- Guarded identically to health_issue_types above; the
                        -- two must select the same elements or the chip list and
                        -- its tooltip disagree. Duration metadata uses the
                        -- shared finite-number projection.
                        FROM media_file_items mfi_hd
                        JOIN media_files mf_h ON mf_h.id = mfi_hd.file_id
                        CROSS JOIN LATERAL (${boundedHealthIssueElementsSql(db, db`mf_h.health_issues`)}) AS he
                        WHERE mfi_hd.media_item_id = page.id
                          AND ${actionableFileHealthSql(db, db`mf_h.id`)}
                          AND he.ordinal <= 20
                    ) AS health_issue_details,
                    (
                        SELECT jsonb_agg(
                            jsonb_build_object(
                                'rule', iv.rule,
                                'severity', iv.severity,
                                'message', iv.details->>'message'
                            )
                            ORDER BY iv.detected_at DESC
                        )
                        FROM integrity_violations iv
                        WHERE iv.media_id = page.id AND iv.resolved_at IS NULL
                    ) AS integrity_issues
            ) iss ON true
            LEFT JOIN episode_problems epp ON epp.series_id = page.id AND page.media_type = 'tv'
            ORDER BY page.page_seq
        `;
    });
}

/**
 * Count total media items matching the given filter options.
 * Same filters as `listAdminMediaItems` but returns only a count.
 */
export async function countAdminMediaItems(
    sql: postgres.Sql,
    opts: Omit<AdminMediaListOpts, 'limit' | 'offset'>,
): Promise<number> {
    const { types, query, libraryGroupId, showUnavailable, unidentified, showDismissed } = opts;

    const needsThreshold = searchNeedsTrigramThreshold(query);

    return runWithTrigramThreshold(sql, needsThreshold, async (db) => {
        // Same builder as `listAdminMediaItems` — this total and that page are
        // one population by construction, not by two clauses matching today.
        const baseScope = buildAdminBrowserBaseScope(db, {
            types,
            showUnavailable,
            showDismissed,
            unidentified,
        });

        const searchFilter = buildAdminBrowserSearch(db, query, opts.searchScope, {
            searchParent: true,
            searchGrandparent: true,
            mediaTypes: closedSearchTypeScope(types),
        });

        const libraryFragment = buildLibraryGroupFilter(db, libraryGroupId);
        const advancedFragment = joinFragments(db, buildAdvancedFilterFragments(db, opts));

        const [row] = await db<[AdminMediaCountRow]>`
            ${searchFilter.cte}
            SELECT COUNT(*)::int AS total
            FROM media_items mi
            WHERE ${baseScope}
            ${searchFilter.where}
            ${libraryFragment}
            ${advancedFragment}
        `;
        return row?.total ?? 0;
    });
}

export interface AdminMediaViewCountSpec {
    /** Views to count, each with the issue it lists (problem views) or none. */
    views: ReadonlyArray<{ id: string; issue?: MediaIssueKind }>;
    /** The issues "Needs attention" ORs together; omit the view by leaving this empty. */
    attentionKinds: MediaIssueKind[];
    /** ISO timestamp for "Recently added". */
    recentSince: string;
}

/**
 * Live counts for the saved views, in one scan over the scope.
 *
 * Scope = domain types + library + dismissed. Deliberately NOT the search box
 * or the advanced filters: the counts answer "how many problems exist here",
 * and the selected view's own list total already reflects a search. Built from
 * the same scope builder and the same issue predicates as the list, so for an
 * unsearched, unfiltered view `count == countAdminMediaItems(view)` (asserted
 * in the integration tests).
 *
 * Availability mirrors the list: `all`, `recent` and every problem view
 * except `lost` count only rows with files; `lost` counts only rows whose
 * files disappeared; `attention` counts both, the way its list shows both.
 */
export async function countAdminMediaViews(
    sql: postgres.Sql,
    opts: Pick<AdminMediaListOpts, 'types' | 'libraryGroupId' | 'showDismissed' | 'unidentified'>,
    spec: AdminMediaViewCountSpec,
): Promise<Record<string, number>> {
    const baseScope = buildAdminBrowserBaseScope(sql, {
        types: opts.types,
        showUnavailable: true,
        showDismissed: opts.showDismissed,
        unidentified: opts.unidentified,
    });
    const libraryFragment = buildLibraryGroupFilter(sql, opts.libraryGroupId);

    const needsArtwork = spec.views.some(
        ({ id, issue }) =>
            issue === 'no_poster' ||
            (id === 'attention' && spec.attentionKinds.includes('no_poster')),
    );
    const hasPoster = needsArtwork ? sql`poster.id IS NOT NULL` : sql`false`;
    const columns = spec.views.map(({ id, issue }) => {
        let predicate: postgres.PendingQuery<postgres.Row[]>;
        if (id === 'attention') {
            if (spec.attentionKinds.length === 0) predicate = sql`false`;
            else
                predicate = spec.attentionKinds
                    .map((k) => buildIssuePredicate(sql, k, hasPoster))
                    .reduce((acc, p) => sql`${acc} OR ${p}`);
        } else if (id === 'recent') {
            predicate = sql`mi.has_files = true AND mi.created_at >= ${spec.recentSince}`;
        } else if (issue === 'files_lost') {
            predicate = buildIssuePredicate(sql, issue, hasPoster);
        } else if (issue) {
            predicate = sql`mi.has_files = true AND ${buildIssuePredicate(sql, issue, hasPoster)}`;
        } else {
            predicate = sql`mi.has_files = true`;
        }
        return sql`COUNT(*) FILTER (WHERE ${predicate})::int AS ${sql(id)}`;
    });
    if (columns.length === 0) return {};

    const [row] = await sql<[Record<string, number>]>`
        WITH scope AS MATERIALIZED (
            SELECT mi.id, mi.media_type, mi.has_files, mi.files_lost_at, mi.created_at,
                mi.parent_id, mi.year, mi.overview, mi.title
            FROM media_items mi
            WHERE ${baseScope} AND ${libraryRowPredicate(sql)} ${libraryFragment}
        )
        ${
            needsArtwork
                ? sql`, posters AS MATERIALIZED (
            ${effectivePosterItemsSql(sql, sql`SELECT id, media_type FROM scope WHERE media_type = ANY(${issueMediaTypes('no_poster')})`)}
        )`
                : sql``
        }
        SELECT ${columns.reduce((acc, c) => sql`${acc}, ${c}`)}
        FROM scope mi
        ${needsArtwork ? sql`LEFT JOIN posters poster ON poster.id = mi.id` : sql``}
    `;
    return row ?? {};
}

/**
 * Fetch a single media item by its internal UUID.
 * Returns the full row or undefined if not found.
 */
export async function getMediaItemById(
    sql: postgres.Sql,
    id: string,
): Promise<AdminMediaDetailRow | undefined> {
    const [row] = await sql<AdminMediaDetailRow[]>`
        SELECT id, title, title_source, is_dismissed, canonical_id, metadata_locked, metadata_locked_by,
               EXTRACT(EPOCH FROM metadata_locked_at)::text AS lock_version,
               original_title, english_title, year, media_type, status,
               parent_id, season_number, episode_number, runtime_seconds,
               premiere_date, overview, created_at, updated_at, custom_metadata,
               custom_poster_url, custom_backdrop_url, custom_logo_url
        FROM media_items
        WHERE id = ${id}
    `;
    return row;
}

/**
 * Return season and episode counts for a TV series item.
 * Episode count includes both direct children and episodes nested under seasons.
 */
export async function getMediaItemChildCounts(
    sql: postgres.Sql,
    id: string,
): Promise<MediaChildCounts> {
    const [row] = await sql<[{ season_count: string; episode_count: string }]>`
        SELECT
            COUNT(*) FILTER (WHERE media_type = 'season') AS season_count,
            (
                SELECT COUNT(*)
                FROM media_items e
                WHERE e.media_type = 'episode'
                  AND (
                      e.parent_id = ${id}
                      OR e.parent_id IN (
                          SELECT s.id FROM media_items s
                          WHERE s.parent_id = ${id} AND s.media_type = 'season'
                      )
                  )
            ) AS episode_count
        FROM media_items
        WHERE parent_id = ${id}
    `;
    return {
        seasonCount: Number(row?.season_count ?? 0),
        episodeCount: Number(row?.episode_count ?? 0),
    };
}

/**
 * When a metadata provider last wrote to this item, for the header's state
 * line. Sourced from `provider_metadata.fetched_at` — the column every sync
 * path (`ai-sync.queries.ts`) sets to `NOW()` on a provider write — rather
 * than `media_items.updated_at`, which also changes on unrelated admin edits
 * (rename, lock, manual field overrides) and would misrepresent those as a
 * provider sync. Returns undefined when the item has no provider_metadata
 * rows at all (e.g. a local-only item that was never synced).
 */
export async function getLastProviderSyncAt(
    sql: postgres.Sql,
    id: string,
): Promise<string | undefined> {
    const [row] = await sql<{ last_fetched_at: string | null }[]>`
        SELECT MAX(fetched_at) AS last_fetched_at
        FROM provider_metadata
        WHERE media_id = ${id}
    `;
    return row?.last_fetched_at ?? undefined;
}

/**
 * Resolve the full ancestor chain for a media item using a single recursive CTE.
 * Replaces the N+1 loop in the detail page that issued up to 3 sequential SELECTs.
 *
 * Returns ancestors ordered from immediate parent to root (depth 1 = direct parent).
 *
 * @param maxDepth - Maximum levels to traverse (default: 10)
 */
export async function resolveAncestorChain(
    sql: postgres.Sql,
    id: string,
    maxDepth = 10,
): Promise<AncestorRow[]> {
    return sql<AncestorRow[]>`
        WITH RECURSIVE ancestors AS (
            -- Base case: direct parent of the given item
            SELECT
                mi.id,
                mi.title,
                mi.media_type,
                mi.season_number,
                mi.parent_id,
                1 AS depth
            FROM media_items mi
            JOIN media_items child ON child.parent_id = mi.id
            WHERE child.id = ${id}

            UNION ALL

            -- Recursive case: walk up the tree
            SELECT
                mi.id,
                mi.title,
                mi.media_type,
                mi.season_number,
                mi.parent_id,
                a.depth + 1
            FROM media_items mi
            JOIN ancestors a ON a.parent_id = mi.id
            WHERE a.depth < ${maxDepth}
        )
        SELECT id, title, media_type, season_number, parent_id, depth
        FROM ancestors
        ORDER BY depth ASC
    `;
}

export interface MediaBrowserStats {
    total: number;
    movies: number;
    series: number;
    episodes: number;
    seasons: number;
    artists: number;
    albums: number;
    tracks: number;
    audiobooks: number;
    with_files: number;
    unavailable: number;
    missing_tmdb: number;
    added_this_week: number;
    locked: number;
    unidentified: number;
}

/**
 * Fetch aggregate counts for the media browser stats bar.
 * Runs a single scan over media_items with conditional aggregation.
 * Results are global (not filtered by the current page filters).
 */
export async function getMediaBrowserStats(sql: postgres.Sql): Promise<MediaBrowserStats> {
    // external_ids is aggregated once and joined, instead of a correlated
    // NOT EXISTS per media_items row (~160k index probes on prod, 1-1.8 s).
    const [row] = await sql<[MediaBrowserStats]>`
        WITH ext AS (
            SELECT
                media_id,
                bool_or(provider = 'tmdb') AS has_tmdb
            FROM external_ids
            WHERE source IS DISTINCT FROM 'watch-sync-file'
            GROUP BY media_id
        )
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE mi.media_type = 'movie' AND mi.has_files)::int AS movies,
            COUNT(*) FILTER (WHERE mi.media_type = 'tv' AND mi.has_files)::int AS series,
            COUNT(*) FILTER (WHERE mi.media_type = 'episode' AND mi.has_files)::int AS episodes,
            COUNT(*) FILTER (WHERE mi.media_type = 'season' AND mi.has_files)::int AS seasons,
            COUNT(*) FILTER (WHERE mi.media_type = 'artist' AND mi.has_files)::int AS artists,
            COUNT(*) FILTER (WHERE mi.media_type = 'album' AND mi.has_files)::int AS albums,
            COUNT(*) FILTER (WHERE mi.media_type = 'track' AND mi.has_files)::int AS tracks,
            -- Audiobooks carry has_files = true when the book is playable on the
            -- upstream AudiobookShelf server (ABS 'isMissing' maps to false), so the
            -- same availability filter as every other counter applies unchanged.
            COUNT(*) FILTER (WHERE mi.media_type = 'audiobook' AND mi.has_files)::int AS audiobooks,
            COUNT(*) FILTER (WHERE mi.has_files = true)::int AS with_files,
            COUNT(*) FILTER (WHERE mi.has_files = false)::int AS unavailable,
            COUNT(*) FILTER (WHERE NOT COALESCE(ext.has_tmdb, false))::int AS missing_tmdb,
            COUNT(*) FILTER (WHERE mi.created_at > NOW() - INTERVAL '7 days')::int AS added_this_week,
            COUNT(*) FILTER (WHERE mi.metadata_locked = true)::int AS locked,
            COUNT(*) FILTER (WHERE NOT mi.is_dismissed AND mi.media_type IN ('movie', 'tv') AND ext.media_id IS NULL)::int AS unidentified
        FROM media_items mi
        LEFT JOIN ext ON ext.media_id = mi.id
        WHERE mi.status = 'active'
    `;
    return row;
}

// ---------------------------------------------------------------------------
// Preview (lightweight detail for inline expansion)
// ---------------------------------------------------------------------------

export interface MediaPreviewData {
    id: string;
    title: string | null;
    overview: string | null;
    year: number | null;
    media_type: string;
    runtime_seconds: number | null;
    premiere_date: string | null;
    externalIds: {
        tmdb?: string;
        imdb?: string;
        jellyfin?: string;
        tvdb?: string;
    };
    fileCount: number;
    totalFileSize: number | null;
    filePaths: string[];
    seasons?: Array<{
        seasonNumber: number;
        episodeCount: number;
        linkedCount: number;
    }>;
    audioFeatures?: {
        bpm: number | null;
        key: string | null;
        energy: number | null;
    };
    parentTitle?: string;
    grandparentTitle?: string;
    // Inspector-only additions (spec: admin media browser inspector panel).
    // All optional — `AdminPreviewResponseSchema.parse()` runs server-side and
    // Zod `.nullable()` rejects `undefined`, so anything not always present on
    // every item type must stay `.optional()`, never bare `.nullable()`.
    metadataLocked?: boolean;
    lockedBy?: string;
    lockedAt?: string;
    isLocalOnly?: boolean;
    filesLostAt?: string;
    /** MAX(media_files.probed_at) across this item's files. */
    lastProbedAt?: string;
    /**
     * No dedicated "last synced" column exists anywhere in the schema — a
     * single-item metadata sync (metadata-sync-single.service.ts) only ever
     * bumps `media_items.updated_at`, the same column any other edit (a lock
     * toggle, a rename, ...) also bumps. Named `lastUpdatedAt` rather than
     * "synced" so the label doesn't claim a sync that never ran; if real sync
     * recency is ever needed that is a schema change, not a rename.
     */
    lastUpdatedAt?: string;
    /**
     * Series-only: episodes held vs. the provider's list, counted live
     * (`coverageHealthStatus`). Absent off-series and for a series with no
     * episode rows.
     */
    healthStatus?: string;
    /** Findings beyond the 20-row preview cap; use the detail page for the full list. */
    healthIssuesOmitted?: number;
    /** Actionable physical-file findings, including descendants. Separate from episode coverage. */
    healthIssues?: Array<{
        type: string;
        detail?: string;
        filePath?: string;
        expectedDuration?: number;
        actualDuration?: number;
        reviewed?: boolean;
        basis?: string;
    }>;
    videoCodec?: string;
    videoWidth?: number;
    videoHeight?: number;
    videoRange?: string;
    audioCodec?: string;
    audioChannels?: number;
}

/**
 * Fetch lightweight preview data for inline row expansion.
 * Runs parallel queries for base item, external IDs, files, seasons, and parent chain.
 */
export async function getMediaPreview(
    sql: postgres.Sql,
    id: string,
): Promise<MediaPreviewData | undefined> {
    // Base item
    const [item] = await sql<
        {
            id: string;
            title: string | null;
            overview: string | null;
            year: number | null;
            media_type: string;
            runtime_seconds: number | null;
            premiere_date: string | null;
            custom_metadata: Record<string, unknown> | null;
            metadata_locked: boolean;
            metadata_locked_by: string | null;
            metadata_locked_at: string | null;
            is_local_only: boolean | null;
            files_lost_at: string | null;
            updated_at: string;
        }[]
    >`
        SELECT mi.id, mi.title, mi.overview, mi.year, mi.media_type, mi.runtime_seconds, mi.custom_metadata,
               -- ::text for the same reason as the timestamps below: premiere_date is a
               -- date column (oid 1082), which postgres.js parses to a native Date via the
               -- same default handler, and AdminPreviewResponseSchema declares it a string.
               -- This one predates the inspector work -- the field has been in the def
               -- since 2026-06-27 -- and is live on stable: on the production catalogue
               -- 83,782 of 87,898 episodes and 4,454 seasons carry a premiere_date, so
               -- preview 500s for every one of them. It went unnoticed because the
               -- browser's default type filter is main (movie/tv), where only 28 of 12,696
               -- movies and zero tv rows are populated.
               mi.premiere_date::text AS premiere_date,
               mi.metadata_locked, mi.metadata_locked_by, mi.metadata_locked_at::text AS metadata_locked_at,
               mi.is_local_only, mi.files_lost_at::text AS files_lost_at, mi.updated_at::text AS updated_at
        FROM media_items mi WHERE mi.id = ${id}
    `;
    if (!item) return undefined;

    // Run remaining queries in parallel
    const [
        extIds,
        fileInfo,
        seasons,
        parents,
        healthIssueRows,
        coverage,
        videoStream,
        audioStream,
    ] = await Promise.all([
        // External IDs (pivot)
        sql<
            {
                tmdb_id: string | null;
                imdb_id: string | null;
                jellyfin_id: string | null;
                tvdb_id: string | null;
            }[]
        >`
            SELECT
                MAX(CASE WHEN provider = 'tmdb' THEN external_id END) AS tmdb_id,
                MAX(CASE WHEN provider = 'imdb' THEN external_id END) AS imdb_id,
                MAX(CASE WHEN provider = 'jellyfin' THEN external_id END) AS jellyfin_id,
                MAX(CASE WHEN provider = 'tvdb' THEN external_id END) AS tvdb_id
            FROM external_ids WHERE media_id = ${id}
        `,

        // File info
        sql<
            {
                file_count: number;
                total_file_size: string | null;
                file_paths: string[] | null;
                last_probed_at: string | null;
            }[]
        >`
            SELECT
                COUNT(*)::int AS file_count,
                SUM(mf.file_size_bytes)::text AS total_file_size,
                (ARRAY_AGG(mf.file_path ORDER BY mf.file_path))[1:3] AS file_paths,
                MAX(mf.probed_at)::text AS last_probed_at
            FROM media_file_items mfi
            JOIN media_files mf ON mf.id = mfi.file_id
            -- The item AND its descendants (two levels: series -> season ->
            -- episode, artist -> album -> track). Container rows own zero files
            -- themselves, so counting only the item's own links made the
            -- inspector report "Files: 0" for every series and album while the
            -- detail page's Files tab listed dozens.
            WHERE mfi.media_item_id IN (
                SELECT ${id}::uuid
                UNION ALL
                SELECT c.id FROM media_items c WHERE c.parent_id = ${id}
                UNION ALL
                SELECT gc.id
                FROM media_items c
                JOIN media_items gc ON gc.parent_id = c.id
                WHERE c.parent_id = ${id}
            )
        `,

        // Seasons summary (only meaningful for series — query is cheap/empty for others)
        isSeries(item.media_type)
            ? sql<
                  {
                      season_number: number;
                      episode_count: number;
                      linked_count: number;
                  }[]
              >`
                SELECT mi.season_number,
                       COUNT(*)::int AS episode_count,
                       COUNT(*) FILTER (WHERE mi.has_files = true)::int AS linked_count
                FROM media_items mi
                WHERE mi.parent_id IN (SELECT s.id FROM media_items s WHERE s.parent_id = ${id})
                  AND mi.media_type = 'episode'
                GROUP BY mi.season_number
                ORDER BY mi.season_number
            `
            : Promise.resolve([]),

        // Parent chain (for episodes/tracks)
        sql<{ parent_title: string | null; grandparent_title: string | null }[]>`
            SELECT p.title AS parent_title, gp.title AS grandparent_title
            FROM media_items mi
            LEFT JOIN media_items p ON p.id = mi.parent_id
            LEFT JOIN media_items gp ON gp.id = p.parent_id
            WHERE mi.id = ${id}
        `,

        // Actionable findings, once per physical file, including descendants.
        // This matches the inspector's container file summary and the detail page.
        //
        // TOTAL extraction, deliberately. `health_issues` is an unvalidated
        // jsonb column with TWO independent producers (media-probe.ts and
        // audio-processor.ts), so a shape divergence between them is a live
        // possibility, not a hypothetical — and every unguarded read here
        // fails the WHOLE query, which 500s the inspector for that item
        // permanently rather than degrading one issue:
        //   - a bare `(… ->> 'expected_duration')::float` RAISES on malformed
        //     text or overflowing numeric text. The shared projection only
        //     returns bounded numbers before this cast.
        //   - an element with no `type` key yields SQL NULL for a field
        //     `AdminPreviewResponseSchema` requires, so the response would
        //     fail `.parse()`. Such elements are dropped here instead.
        //   - the shared lateral indexes at most 20 array entries and degrades
        //     a non-array to an unknown marker.
        // Losing one malformed issue is correct; losing the panel is not.
        sql<
            {
                total_findings: number;
                type: string | null;
                detail: string | null;
                file_path: string | null;
                expected_duration: number | null;
                actual_duration: number | null;
                reviewed: boolean;
                basis: string | null;
            }[]
        >`
            SELECT
                COUNT(*) OVER ()::int AS total_findings,
                CASE WHEN jsonb_typeof(he.elem->'type') = 'string' AND length(he.elem->>'type') BETWEEN 1 AND 80
                     THEN he.elem->>'type' ELSE 'unknown_recorded_evidence' END AS type,
                left(he.elem ->> 'detail', 2048) AS detail,
                left(he.elem ->> 'basis',80) AS basis,
                ${currentHealthIssueReviewSql(sql, sql`mf.id`, sql`he.elem`)} AS reviewed,
                mf.file_path,
                (${boundedHealthDurationSql(sql, sql`he.elem->'expected_duration'`)})::text::float AS expected_duration,
                (${boundedHealthDurationSql(sql, sql`he.elem->'actual_duration'`)})::text::float AS actual_duration
            FROM media_files mf
            CROSS JOIN LATERAL (${boundedHealthIssueElementsSql(sql, sql`mf.health_issues`)}) AS he
            WHERE mf.id IN (SELECT DISTINCT mfi.file_id FROM media_file_items mfi WHERE mfi.media_item_id IN (
                SELECT ${id}::uuid
                UNION ALL SELECT c.id FROM media_items c WHERE c.parent_id = ${id}
                UNION ALL SELECT gc.id FROM media_items c JOIN media_items gc ON gc.parent_id = c.id WHERE c.parent_id = ${id}
            ))
              AND ${actionableFileHealthSql(sql, sql`mf.id`)}
              AND he.ordinal <= 20
            ORDER BY mf.file_path, mf.id, he.ordinal
            LIMIT 20
        `,

        // Health status — series-only, one series' live episode coverage.
        isSeries(item.media_type)
            ? getSeriesEpisodeCoverage(sql, getPrimaryExternalIdProvider(), id)
            : Promise.resolve(null),

        // Best video stream (highest resolution) across this item's own files.
        sql<
            {
                codec: string | null;
                width: number | null;
                height: number | null;
                video_range: string | null;
            }[]
        >`
            SELECT ms.codec, ms.width, ms.height, ms.video_range
            FROM media_streams ms
            JOIN media_file_items mfi ON mfi.file_id = ms.file_id
            WHERE mfi.media_item_id = ${id} AND ms.stream_type = 'video'
            ORDER BY ms.width DESC NULLS LAST
            LIMIT 1
        `,

        // Best audio stream (most channels) across this item's own files.
        sql<{ codec: string | null; channels: number | null }[]>`
            SELECT ms.codec, ms.channels
            FROM media_streams ms
            JOIN media_file_items mfi ON mfi.file_id = ms.file_id
            WHERE mfi.media_item_id = ${id} AND ms.stream_type = 'audio'
            ORDER BY ms.channels DESC NULLS LAST
            LIMIT 1
        `,
    ]);

    const ext = extIds[0];
    const file = fileInfo[0];
    const parent = parents[0];
    const meta = item.custom_metadata;
    const video = videoStream[0];
    const audio = audioStream[0];

    // Second half of the total extraction described on the health-issues query
    // above. The SQL guards keep Postgres from raising; these keep whatever DID
    // come back from failing `AdminPreviewResponseSchema.parse()` in the def,
    // which 500s the endpoint just as thoroughly:
    //   - a row whose `type` is NULL (a driver, a view, or a future edit to
    //     that WHERE clause) would serialize `type: null` against a required
    //     `z.string()`.
    //   - `Number.isFinite` protects the response if a future SQL edit or
    //     driver behavior changes the finite-number projection.
    const wellFormedHealthIssues = healthIssueRows
        .filter(
            (h): h is typeof h & { type: string } => typeof h.type === 'string' && h.type !== '',
        )
        .map((h) => ({
            type: h.type,
            ...(h.detail ? { detail: h.detail } : {}),
            ...(h.reviewed === true ? { reviewed: true } : {}),
            ...(h.basis === 'premature_eof' || h.basis === 'duration_comparison'
                ? { basis: h.basis }
                : {}),
            ...(h.file_path ? { filePath: h.file_path } : {}),
            ...(Number.isFinite(h.expected_duration)
                ? { expectedDuration: h.expected_duration as number }
                : {}),
            ...(Number.isFinite(h.actual_duration)
                ? { actualDuration: h.actual_duration as number }
                : {}),
        }));

    return {
        id: item.id,
        title: item.title,
        overview: item.overview,
        year: item.year,
        media_type: item.media_type,
        runtime_seconds: item.runtime_seconds,
        premiere_date: item.premiere_date,
        externalIds: {
            ...(ext?.tmdb_id ? { tmdb: ext.tmdb_id } : {}),
            ...(ext?.imdb_id ? { imdb: ext.imdb_id } : {}),
            ...(ext?.jellyfin_id ? { jellyfin: ext.jellyfin_id } : {}),
            ...(ext?.tvdb_id ? { tvdb: ext.tvdb_id } : {}),
        },
        fileCount: file?.file_count ?? 0,
        totalFileSize: file?.total_file_size ? parseInt(file.total_file_size, 10) : null,
        filePaths: file?.file_paths?.filter(Boolean) ?? [],
        ...(seasons.length > 0
            ? {
                  seasons: seasons.map((s) => ({
                      seasonNumber: s.season_number,
                      episodeCount: s.episode_count,
                      linkedCount: s.linked_count,
                  })),
              }
            : {}),
        ...((): {
            audioFeatures?: {
                bpm: number | null;
                key: string | null;
                energy: number | null;
            };
        } => {
            const essentia =
                meta && typeof meta.essentia === 'object' && meta.essentia !== null
                    ? (meta.essentia as Record<string, unknown>)
                    : null;
            if (!essentia || !(essentia.bpm || essentia.key || essentia.energy)) {
                return {};
            }
            return {
                audioFeatures: {
                    bpm: (essentia.bpm as number) ?? null,
                    key: (essentia.key as string) ?? null,
                    energy: (essentia.energy as number) ?? null,
                },
            };
        })(),
        ...(parent?.parent_title ? { parentTitle: parent.parent_title } : {}),
        ...(parent?.grandparent_title ? { grandparentTitle: parent.grandparent_title } : {}),
        metadataLocked: item.metadata_locked,
        ...(item.metadata_locked_by ? { lockedBy: item.metadata_locked_by } : {}),
        ...(item.metadata_locked_at ? { lockedAt: item.metadata_locked_at } : {}),
        ...(item.is_local_only !== null ? { isLocalOnly: item.is_local_only } : {}),
        ...(item.files_lost_at ? { filesLostAt: item.files_lost_at } : {}),
        ...(file?.last_probed_at ? { lastProbedAt: file.last_probed_at } : {}),
        // See MediaPreviewData.lastUpdatedAt — no dedicated sync timestamp exists,
        // updated_at is the best available proxy.
        ...(item.updated_at ? { lastUpdatedAt: item.updated_at } : {}),
        ...(coverage ? { healthStatus: coverageHealthStatus(coverage) } : {}),
        ...(wellFormedHealthIssues.length > 0 ? { healthIssues: wellFormedHealthIssues } : {}),
        ...(healthIssueRows[0]?.total_findings > healthIssueRows.length
            ? { healthIssuesOmitted: healthIssueRows[0].total_findings - healthIssueRows.length }
            : {}),
        ...(video?.codec ? { videoCodec: video.codec } : {}),
        ...(video?.width != null ? { videoWidth: video.width } : {}),
        ...(video?.height != null ? { videoHeight: video.height } : {}),
        ...(video?.video_range ? { videoRange: video.video_range } : {}),
        ...(audio?.codec ? { audioCodec: audio.codec } : {}),
        ...(audio?.channels != null ? { audioChannels: audio.channels } : {}),
    };
}

export interface FilelessDuplicatePair {
    /** The real library file row (has_files=true, no external_ids) — recommended keep. */
    fileId: string;
    fileTitle: string;
    /** The TMDB discovery row (has_files=false, has tmdb id) — recommended merge source. */
    discoveryId: string;
    discoveryTitle: string;
    tmdbId: string;
    mediaType: string;
    year: number | null;
}

/**
 * Find unambiguous file-less duplicate pairs that the normal duplicate detector
 * (findDuplicateMediaItems, which GROUPs BY external_id) structurally CANNOT see:
 * a real library file row that was ingested with NO external_ids, sitting
 * alongside a separate TMDB discovery row for the same title. These are the
 * pairs behind "request ready → 404" — the file exists but is unreachable by the
 * tmdb id that requests/cards key on.
 *
 * Matched by whitespace-collapsed normalized title + year + media_type. Only
 * UNAMBIGUOUS 1:1 pairs are returned (exactly one file-less file row and exactly
 * one tmdb discovery row in the title/year/type bucket) — ambiguous buckets are
 * omitted so an operator never bulk-merges the wrong rows. The recommended merge
 * keeps the file row (preserving its probe/streams and playback) and folds the
 * discovery row's tmdb id onto it.
 *
 * @deprecated Prefer {@link findFilelessDuplicatePairsWithTotal} which returns
 * both the capped list and the uncapped total in a single round-trip, enabling
 * the caller to show "showing first N of total" in the UI.
 */
export async function findFilelessDuplicatePairs(
    sql: postgres.Sql,
    limit = 100,
): Promise<FilelessDuplicatePair[]> {
    const { pairs } = await findFilelessDuplicatePairsWithTotal(sql, limit);
    return pairs;
}

/**
 * One aggregate per normalized title/year/type bucket replaces the correlated
 * scans of the full normalized catalogue. Only buckets with one eligible file
 * and one eligible discovery survive; unrelated rows in the bucket do not
 * affect that 1:1 test. Both list and count use this exact population.
 */
function filelessDuplicateBucketsSql(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        WITH norm AS MATERIALIZED (
            SELECT mi.id, mi.year, mi.media_type, mi.has_files,
                BTRIM(regexp_replace(
                    regexp_replace(LOWER(TRIM(mi.title)), '[^a-z0-9 ]', '', 'g'),
                    ' +', ' ', 'g'
                )) AS n,
                EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file') AS has_ext,
                (SELECT ei.external_id FROM external_ids ei
                 WHERE ei.media_id = mi.id AND ei.provider = 'tmdb' LIMIT 1) AS tmdb_id
            FROM media_items mi
            WHERE mi.parent_id IS NULL
              AND mi.status = 'active'
              AND NOT mi.is_dismissed
              AND mi.media_type IN ('movie', 'tv')
              AND mi.year IS NOT NULL
        )
        SELECT
            MIN(id::text) FILTER (WHERE has_files = true AND has_ext = false)::uuid AS file_id,
            MIN(id::text) FILTER (WHERE has_files = false AND tmdb_id IS NOT NULL)::uuid AS discovery_id,
            MAX(tmdb_id) FILTER (WHERE has_files = false AND tmdb_id IS NOT NULL) AS tmdb_id
        FROM norm
        GROUP BY n, year, media_type
        HAVING COUNT(*) FILTER (WHERE has_files = true AND has_ext = false) = 1
           AND COUNT(*) FILTER (WHERE has_files = false AND tmdb_id IS NOT NULL) = 1
    `;
}

/** Count the same unambiguous pairs as the capped list, without loading it. */
export async function countFilelessDuplicatePairs(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<[{ total: number }]>`
        SELECT COUNT(*)::int AS total FROM (${filelessDuplicateBucketsSql(sql)}) buckets
    `;
    return row?.total ?? 0;
}

export interface FilelessDuplicatePairsResult {
    pairs: FilelessDuplicatePair[];
    /** Total matching pairs before the LIMIT cap — use to show "showing N of total" in UI. */
    total: number;
}

/**
 * Combined query: returns the capped list of fileless duplicate pairs AND the
 * uncapped total count in a single round-trip using a window function.
 *
 * Prefer this over calling findFilelessDuplicatePairs + countFilelessDuplicatePairs
 * separately. Use the returned `total` to render "showing first N of total" in the UI
 * when `pairs.length === limit`.
 *
 * @param limit Maximum number of pairs to return (default 100).
 */
export async function findFilelessDuplicatePairsWithTotal(
    sql: postgres.Sql,
    limit = 100,
): Promise<FilelessDuplicatePairsResult> {
    const rows = await sql<Array<FilelessDuplicatePair & { _total: number }>>`
        SELECT f.id AS "fileId", f.title AS "fileTitle",
            d.id AS "discoveryId", d.title AS "discoveryTitle",
            buckets.tmdb_id AS "tmdbId", f.media_type AS "mediaType", f.year,
            COUNT(*) OVER()::int AS "_total"
        FROM (${filelessDuplicateBucketsSql(sql)}) buckets
        JOIN media_items f ON f.id = buckets.file_id
        JOIN media_items d ON d.id = buckets.discovery_id
        ORDER BY f.title
        LIMIT ${limit}
    `;
    const total = rows[0]?._total ?? 0;
    const pairs = rows.map(({ _total: _, ...pair }) => pair);
    return { pairs, total };
}

export interface MergeGuardRow {
    id: string;
    title: string;
    media_type: string;
    has_files: boolean;
}

/**
 * Fetch the minimal fields needed to validate a merge (existence, media_type
 * agreement, both-have-files guard). Returns only active rows.
 */
export async function getMergeGuardRows(
    sql: postgres.Sql,
    ids: string[],
): Promise<MergeGuardRow[]> {
    return sql<MergeGuardRow[]>`
        SELECT id, title, media_type, has_files
        FROM media_items
        WHERE id = ANY(${ids}::uuid[]) AND status = 'active' AND NOT is_dismissed
    `;
}

/**
 * True if any library-scan run is currently active. Used to refuse a merge while
 * a scan is in flight — a concurrent scan resolving the same title could
 * re-create a row we just deleted (and the merge deletes a row).
 */
export async function hasActiveLibraryScan(sql: postgres.Sql): Promise<boolean> {
    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one
        FROM task_history
        WHERE task_id IN ('file-library-scan', 'integrity-scanner')
          AND state = 'active'
          -- Ignore wedged/crashed runs left 'active' so a dead scan can't
          -- permanently refuse merges.
          AND started_at > now() - interval '2 hours'
        LIMIT 1
    `;
    return rows.length > 0;
}

/**
 * Find media items that share the same TMDB external ID and media type.
 * Returns up to 50 duplicate groups ordered by duplicate count descending.
 *
 * Only considers active, non-dismissed rows so that a pair where one side
 * was soft-dismissed (e.g. after a prior merge or deleteStaleMediaFile) does
 * not continue to appear as a live duplicate — matching the semantics of
 * findFilelessDuplicatePairs and getMergeGuardRows.
 */
export async function findDuplicateMediaItems(sql: postgres.Sql): Promise<DuplicateMediaRow[]> {
    return sql<DuplicateMediaRow[]>`
        SELECT
            ei.external_id AS tmdb_id,
            mi.media_type,
            json_agg(json_build_object(
                'id', mi.id,
                'title', mi.title,
                'year', mi.year,
                'created_at', mi.created_at
            ) ORDER BY mi.created_at) AS items
        FROM external_ids ei
        JOIN media_items mi ON mi.id = ei.media_id
        WHERE ei.provider = 'tmdb'
          AND mi.status = 'active'
          AND NOT mi.is_dismissed
        GROUP BY ei.external_id, mi.media_type
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 50
    `;
}
