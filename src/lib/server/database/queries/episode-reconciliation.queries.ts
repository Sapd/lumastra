// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

export interface ReconcileEpisodeRow {
    episodeId: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    currentTitle: string | null;
    tmdbEpisodeId: string | null; // external_ids provider='tmdb' for this episode, if any
    metadataLocked: boolean;
    parentId?: string;
    parentSeasonNumber?: number | null;
    status?: string;
    seasonStatus?: string;
    seriesStatus?: string;
    seasonLocked?: boolean;
    seriesLocked?: boolean;
    seriesTmdbId?: string | null;
    /**
     * How this episode's title was bound: 'identity' = a trusted content-matched
     * binding, 'position' = a fragile positional (S/E) title, null = never bound.
     * The reconciliation backfill (WS4) must NEVER override an 'identity' row — it
     * represents a historical confident match that the matcher already trusts.
     */
    titleBinding: string | null;
}

export interface ReconcileFileGroup {
    fileId: string;
    fileName: string | null; // basename of the default media file, for filename-title fallback
    /** Stored probe evidence; missing values never prove duplicate content. */
    durationSeconds?: number | null;
    fileHashHead?: string | null;
    fileSizeBytes?: number | null;
    absoluteEpisode?: number | null;
    chapterNames: string[]; // content chapters in index order (callers filter generics)
    episodes: ReconcileEpisodeRow[]; // episode rows on this file, ordered by episode_number
}

/**
 * For a series, return each physical file with its ordered chapter names and the
 * episode rows attached to it. Chapters are file-scoped; a file may back multiple
 * episode rows (e.g. a combined S01E03E04 file backs ep 3 and ep 4).
 */
export async function getReconciliationGroups(
    sql: postgres.Sql,
    seriesMediaId: string,
): Promise<ReconcileFileGroup[]> {
    const rows = await sql<
        {
            file_id: string;
            file_name: string | null;
            duration_seconds: number | null;
            file_hash_head: string | null;
            file_size_bytes: number | null;
            absolute_episode: number | null;
            episode_id: string;
            season_number: number | null;
            episode_number: number | null;
            current_title: string | null;
            tmdb_episode_id: string | null;
            metadata_locked: boolean;
            parent_id: string;
            parent_season_number: number | null;
            status: string;
            season_status: string;
            series_status: string;
            season_locked: boolean;
            series_locked: boolean;
            series_tmdb_id: string | null;
            title_binding: string | null;
        }[]
    >`
        SELECT
            mfi.file_id,
            regexp_replace(mf.file_path, '^.*/', '') AS file_name,
            mf.duration_seconds, mf.file_hash_head, mf.file_size_bytes, mf.absolute_episode,
            mi.id            AS episode_id,
            mi.season_number,
            mi.episode_number,
            mi.title         AS current_title,
            ei.external_id   AS tmdb_episode_id,
            mi.metadata_locked,
            season.season_number AS parent_season_number,
            mi.parent_id, mi.status, season.status AS season_status, series.status AS series_status,
            season.metadata_locked AS season_locked, series.metadata_locked AS series_locked,
            (SELECT se.external_id FROM external_ids se WHERE se.media_id = series.id AND se.provider = 'tmdb' AND se.media_type = 'tv') AS series_tmdb_id,
            mi.title_binding
        FROM media_items mi
        JOIN media_items season
            ON season.id = mi.parent_id AND season.media_type = 'season'
        JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
        JOIN media_file_items mfi
            ON mfi.media_item_id = mi.id AND mfi.is_default = true
        JOIN media_files mf
            ON mf.id = mfi.file_id
        LEFT JOIN external_ids ei
            ON ei.media_id = mi.id AND ei.provider = 'tmdb' AND ei.media_type = 'episode'
        WHERE season.parent_id = ${seriesMediaId}
          AND mi.media_type = 'episode'
        ORDER BY mfi.file_id, mi.episode_number
    `;

    const chapterRows = await sql<{ file_id: string; chapter_name: string | null }[]>`
        SELECT ec.file_id, ec.chapter_name
        FROM episode_chapters ec
        WHERE ec.file_id IN (
            SELECT DISTINCT mfi.file_id
            FROM media_items mi
            JOIN media_items season
                ON season.id = mi.parent_id AND season.media_type = 'season'
            JOIN media_file_items mfi ON mfi.media_item_id = mi.id AND mfi.is_default = true
            WHERE season.parent_id = ${seriesMediaId} AND mi.media_type = 'episode'
        )
        ORDER BY ec.file_id, ec.chapter_index
    `;

    const chaptersByFile = new Map<string, string[]>();
    for (const c of chapterRows) {
        const arr = chaptersByFile.get(c.file_id) ?? [];
        if (c.chapter_name) arr.push(c.chapter_name);
        chaptersByFile.set(c.file_id, arr);
    }

    const groups = new Map<string, ReconcileFileGroup>();
    for (const r of rows) {
        let g = groups.get(r.file_id);
        if (!g) {
            g = {
                fileId: r.file_id,
                fileName: r.file_name ?? null,
                durationSeconds: r.duration_seconds,
                fileHashHead: r.file_hash_head,
                fileSizeBytes: r.file_size_bytes,
                absoluteEpisode: r.absolute_episode,
                chapterNames: chaptersByFile.get(r.file_id) ?? [],
                episodes: [],
            };
            groups.set(r.file_id, g);
        }
        g.episodes.push({
            episodeId: r.episode_id,
            seasonNumber: r.season_number,
            episodeNumber: r.episode_number,
            currentTitle: r.current_title,
            tmdbEpisodeId: r.tmdb_episode_id,
            metadataLocked: r.metadata_locked,
            parentId: r.parent_id,
            parentSeasonNumber: r.parent_season_number,
            status: r.status,
            seasonStatus: r.season_status,
            seriesStatus: r.series_status,
            seasonLocked: r.season_locked,
            seriesLocked: r.series_locked,
            seriesTmdbId: r.series_tmdb_id,
            titleBinding: r.title_binding,
        });
    }
    return [...groups.values()];
}

/**
 * Episode media_item ids (within a series) currently holding any of the given
 * tmdb episode ids. Used by reconciliation to release stale bindings before
 * reassigning those ids to their content-matched episodes (avoids the
 * external_ids unique-key collision in upsertExternalId).
 */
export async function getEpisodesHoldingTmdbIds(
    sql: postgres.Sql,
    seriesMediaId: string,
    tmdbEpisodeIds: string[],
): Promise<string[]> {
    if (tmdbEpisodeIds.length === 0) return [];
    const rows = await sql<{ media_id: string }[]>`
        SELECT DISTINCT ei.media_id
        FROM external_ids ei
        JOIN media_items mi ON mi.id = ei.media_id AND mi.media_type = 'episode'
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        WHERE season.parent_id = ${seriesMediaId}
          AND ei.provider = 'tmdb'
          AND ei.media_type = 'episode'
          AND ei.external_id = ANY(${tmdbEpisodeIds}::text[])
          AND NOT mi.metadata_locked AND NOT season.metadata_locked
          AND NOT EXISTS (SELECT 1 FROM media_items series WHERE series.id = season.parent_id AND (series.metadata_locked OR series.status <> 'active'))
          -- Never release a trusted identity-bound holder. An identity binding is
          -- a prior confident content match, not a stale positional guess, so it
          -- must not be freed to make room for a reassignment.
          AND mi.title_binding IS DISTINCT FROM 'identity'
    `;
    return rows.map((r) => r.media_id);
}

/**
 * Returns the subset of the given tmdb episode ids that are currently held by a
 * PROTECTED episode in this series — one that is metadata_locked OR already
 * identity-bound (title_binding='identity'). Used by reconciliation to pre-filter
 * toApply proposals whose target id is held in place by a row the matcher will
 * never release: attempting to reassign such a holder causes a unique-constraint
 * collision that rolls back the whole batch; dropping only the protected-id
 * proposals lets the rest proceed safely. Identity-bound holders are protected
 * for the same reason as locked ones — their binding is a trusted prior match.
 */
export async function getLockedHeldTmdbIds(
    sql: postgres.Sql,
    seriesMediaId: string,
    tmdbEpisodeIds: string[],
): Promise<Set<string>> {
    if (tmdbEpisodeIds.length === 0) return new Set();
    const rows = await sql<{ external_id: string }[]>`
        SELECT DISTINCT ei.external_id
        FROM external_ids ei
        JOIN media_items mi ON mi.id = ei.media_id AND mi.media_type = 'episode'
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        WHERE season.parent_id = ${seriesMediaId}
          AND ei.provider = 'tmdb'
          AND ei.media_type = 'episode'
          AND ei.external_id = ANY(${tmdbEpisodeIds}::text[])
          AND (mi.metadata_locked = true OR season.metadata_locked = true
               OR EXISTS (SELECT 1 FROM media_items series WHERE series.id = season.parent_id AND (series.metadata_locked OR series.status <> 'active'))
               OR mi.status <> 'active' OR season.status <> 'active'
               OR mi.title_binding = 'identity')
    `;
    return new Set(rows.map((r) => r.external_id));
}

// ============================================================================
// WS4 — reconciliation backfill candidate enumeration
// ============================================================================

export interface BackfillSeriesCandidate {
    seriesMediaId: string;
    seriesTitle: string | null;
    /** Number of episode rows on this series eligible for re-matching. */
    eligibleEpisodes: number;
}

export interface ListBackfillCandidatesOptions {
    /** Max series to return. */
    limit: number;
    /**
     * When true, only return series whose `reconcile_backfill_at` watermark is
     * NULL or older than `staleBefore`. When false, return every eligible series
     * regardless of its watermark (a full forced sweep).
     */
    staleOnly: boolean;
    /**
     * Series last reconciled at or after this instant are considered fresh and
     * skipped (only consulted when `staleOnly` is true).
     */
    staleBefore: Date;
}

/**
 * Enumerate TV series that have at least one episode the reconciliation backfill
 * (WS4) is allowed to re-match: an episode that is NOT metadata-locked and whose
 * title_binding is NOT 'identity' (i.e. a fragile positional/unbound title that
 * could be a historical mis-mapping). Identity-bound and locked rows are excluded
 * from the eligibility count because the matcher will never touch them.
 *
 * Library-scoped to has_files = true (real library content only). Ordered oldest
 * watermark first so a paged drain makes monotonic forward progress.
 */
export async function listBackfillSeriesCandidates(
    sql: postgres.Sql,
    opts: ListBackfillCandidatesOptions,
): Promise<BackfillSeriesCandidate[]> {
    const safeLimit = Math.max(1, Math.min(1000, opts.limit));
    const rows = await sql<
        { series_media_id: string; series_title: string | null; eligible_episodes: number }[]
    >`
        SELECT
            series.id                       AS series_media_id,
            series.title                    AS series_title,
            COUNT(ep.id)::int               AS eligible_episodes
        FROM media_items series
        JOIN media_items season
            ON season.parent_id = series.id AND season.media_type = 'season'
        JOIN media_items ep
            ON ep.parent_id = season.id AND ep.media_type = 'episode'
        WHERE series.media_type = 'tv'
          AND series.has_files = true
          AND ep.metadata_locked = false
          AND (ep.title_binding IS DISTINCT FROM 'identity')
          AND (
              ${!opts.staleOnly}
              OR series.reconcile_backfill_at IS NULL
              OR series.reconcile_backfill_at < ${opts.staleBefore}
          )
        GROUP BY series.id, series.title, series.reconcile_backfill_at
        ORDER BY series.reconcile_backfill_at ASC NULLS FIRST, series.id
        LIMIT ${safeLimit}
    `;
    return rows.map((r) => ({
        seriesMediaId: r.series_media_id,
        seriesTitle: r.series_title,
        eligibleEpisodes: r.eligible_episodes,
    }));
}

/**
 * Stamp a series' reconcile_backfill_at watermark to NOW(). Called after the
 * backfill has processed a series (whether or not anything changed) so a
 * `staleOnly` drain does not re-visit it until the watermark ages out. Idempotent.
 */
export async function markSeriesBackfilled(
    sql: postgres.Sql,
    seriesMediaId: string,
): Promise<void> {
    await sql`
        UPDATE media_items
        SET reconcile_backfill_at = NOW()
        WHERE id = ${seriesMediaId} AND media_type = 'tv'
    `;
}

/** Lock the live hierarchy and evidence before re-reading a reconciliation plan.
 * FOR UPDATE also fences new child/identity/file links through their foreign keys.
 * Provider calls must happen before entering this transaction.
 *
 * Callers take the per-series advisory lock first. This function then takes a
 * per-library advisory lock BEFORE any row lock, so reconciliations of different
 * series in one library queue holding only advisory locks, not the series' rows.
 * The `library_groups ... FOR UPDATE` further down is a row lock that every
 * FK check on the group conflicts with (FOR KEY SHARE); it must stay AFTER the
 * media rows, because restamp/backfill/scanner writers lock media rows first and
 * FK-check the group second. Moving it earlier would deadlock against them.
 * The media rows (series, seasons, episodes) are locked in one `id`-ordered statement,
 * matching the ancestor-chain writers; level-by-level locking formed a cycle with them.
 * Advisory locks are only ever taken here in the order series -> library, so
 * they add no cycle. A stale library read only picks the queue; it is harmless.
 */
export async function lockReconciliationEvidence(
    sql: postgres.Sql,
    seriesId: string,
): Promise<void> {
    // Only the library queue gets a longer budget; subsequent evidence row locks
    // retain the caller's timeout. A failed lock aborts the transaction, rolling
    // back these transaction-local settings along with it.
    const [{ timeout }] = await sql<{ timeout: string }[]>`
        SELECT current_setting('lock_timeout') AS timeout
    `;
    await sql`SELECT set_config('lock_timeout', '30s', true)`;
    // Library-less series never shared a library_groups row lock; take no queue key for them.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('recon-lib:' || s.lg, 0))
        FROM (SELECT library_group_id::text AS lg FROM media_items WHERE id = ${seriesId}) s
        WHERE s.lg IS NOT NULL`;
    await sql`SELECT set_config('lock_timeout', ${timeout}, true)`;
    // series, seasons and episodes in ONE statement in global `id` order, the order
    // every ancestor-chain writer (propagateHasFiles, touchLibraryAddedAt,
    // lockAncestorChain) uses. Locking series -> seasons -> episodes level by level
    // deadlocked against them: a chain writer holding an episode with a low id waits
    // for the season/series that this function holds while it waits for that episode.
    await sql`SELECT id FROM media_items
        WHERE id = ${seriesId} OR parent_id = ${seriesId}
            OR parent_id IN (SELECT id FROM media_items WHERE parent_id = ${seriesId})
        ORDER BY id FOR UPDATE`;
    await sql`SELECT ei.media_id FROM external_ids ei JOIN media_items ep ON ep.id = ei.media_id
        LEFT JOIN media_items season ON season.id = ep.parent_id
        WHERE season.parent_id = ${seriesId} OR ep.parent_id = ${seriesId} OR ep.id = ${seriesId}
        ORDER BY ei.media_id, ei.provider FOR UPDATE OF ei`;
    await sql`SELECT mf.id FROM media_files mf WHERE mf.id IN (
        SELECT mfi.file_id FROM media_file_items mfi JOIN media_items ep ON ep.id = mfi.media_item_id
        JOIN media_items season ON season.id = ep.parent_id WHERE season.parent_id = ${seriesId}
    ) ORDER BY mf.id FOR UPDATE`;
    await sql`SELECT mfi.file_id FROM media_file_items mfi JOIN media_items ep ON ep.id = mfi.media_item_id
        JOIN media_items season ON season.id = ep.parent_id WHERE season.parent_id = ${seriesId}
        ORDER BY mfi.file_id, mfi.media_item_id FOR UPDATE OF mfi`;
    await sql`SELECT ec.file_id FROM episode_chapters ec WHERE ec.file_id IN (
        SELECT mfi.file_id FROM media_file_items mfi JOIN media_items ep ON ep.id = mfi.media_item_id
        JOIN media_items season ON season.id = ep.parent_id WHERE season.parent_id = ${seriesId}
    ) ORDER BY ec.file_id, ec.chapter_index FOR UPDATE`;
    // Only the consumed series library and linked audio streams participate.
    // Parent locks fence insertions through their established foreign keys.
    await sql`SELECT id FROM library_groups WHERE id = (SELECT library_group_id FROM media_items WHERE id = ${seriesId}) ORDER BY id FOR UPDATE`;
    await sql`SELECT lp.id FROM library_paths lp WHERE lp.library_group_id = (SELECT library_group_id FROM media_items WHERE id = ${seriesId}) ORDER BY lp.id FOR UPDATE`;
    await sql`SELECT ms.file_id FROM media_streams ms WHERE ms.file_id IN (
        SELECT mfi.file_id FROM media_file_items mfi JOIN media_items ep ON ep.id = mfi.media_item_id
        JOIN media_items season ON season.id = ep.parent_id WHERE season.parent_id = ${seriesId}
    ) AND ms.stream_type = 'audio' ORDER BY ms.file_id, ms.stream_index FOR UPDATE`;
}

/** One PostgreSQL statement captures the complete matching and holder graph.
 * Include fileless holders, all ancestors, file/link/chapter images and xmin;
 * neither a sibling edit nor a superficially equivalent replacement is reusable.
 * With subjects, the graph contains only those UUIDs and their actual ancestors.
 */
export interface ReconciliationEvidence {
    image: string;
    mediaIds: string[];
    fileIds: string[];
    libraryGroupIds: string[];
    libraryLanguage: string | null;
    audioLanguages: (string | null)[];
}

export async function getReconciliationEvidence(
    sql: postgres.Sql,
    seriesId: string,
    subjects?: string[],
): Promise<ReconciliationEvidence> {
    // Pick the subject set in JS instead of `(${bool} AND ...) OR (${bool} AND ...)`:
    // the OR over bind parameters made the planner scan every media_items row
    // (176k on prod) and estimate the subjects at 88k, which in turn chose
    // seq scans over media_file_items and media_streams. A season JOIN (season ids
    // are unique) returns the same rows as the former `parent_id IN (SELECT id ...)`.
    const subjectsQuery =
        subjects !== undefined
            ? sql`SELECT ep.id, ep.parent_id FROM media_items ep WHERE ep.id = ANY(${subjects}::uuid[])`
            : sql`SELECT ep.id, ep.parent_id FROM media_items ep
                JOIN media_items season ON ep.parent_id = season.id
                WHERE season.parent_id = ${seriesId}`;
    const [row] = await sql<
        {
            image: string;
            media_ids: string[];
            file_ids: string[];
            library_group_ids: string[];
            library_language: string | null;
            audio_languages: (string | null)[];
        }[]
    >`
        WITH subjects AS (
            ${subjectsQuery}
        ), nodes AS (
            SELECT id FROM subjects UNION SELECT parent_id FROM subjects WHERE parent_id IS NOT NULL
            UNION SELECT p.parent_id FROM media_items p JOIN subjects e ON p.id = e.parent_id WHERE p.parent_id IS NOT NULL
            UNION SELECT id FROM media_items WHERE id = ${seriesId}
        ), files AS (
            SELECT DISTINCT file_id FROM media_file_items WHERE media_item_id IN (SELECT id FROM subjects)
        ), library_inputs AS (
            SELECT lp.* FROM library_paths lp JOIN media_items series ON series.library_group_id = lp.library_group_id
            WHERE series.id = ${seriesId} AND ${subjects === undefined}
        ), audio_inputs AS (
            SELECT ms.* FROM media_streams ms WHERE ms.file_id IN (SELECT file_id FROM files)
                AND ms.stream_type = 'audio' AND ${subjects === undefined}
        )
        SELECT ARRAY(SELECT DISTINCT library_group_id FROM library_inputs WHERE library_group_id IS NOT NULL ORDER BY library_group_id) AS library_group_ids,
            (SELECT language FROM library_inputs WHERE language IS NOT NULL AND language <> '' LIMIT 1) AS library_language,
            ARRAY(SELECT DISTINCT language FROM audio_inputs WHERE language IS NOT NULL AND language <> '' ORDER BY language) AS audio_languages,
            ARRAY(SELECT id FROM nodes ORDER BY id) AS media_ids,
            ARRAY(SELECT file_id FROM files ORDER BY file_id) AS file_ids,
            jsonb_build_array(
                (SELECT jsonb_agg(jsonb_build_array(to_jsonb(m), m.xmin::text) ORDER BY m.id) FROM media_items m WHERE m.id IN (SELECT id FROM nodes)),
                (SELECT jsonb_agg(jsonb_build_array(to_jsonb(e), e.xmin::text) ORDER BY e.media_id, e.provider, e.media_type, e.external_id) FROM external_ids e WHERE e.media_id IN (SELECT id FROM nodes)),
                (SELECT jsonb_agg(jsonb_build_array(to_jsonb(l), l.xmin::text) ORDER BY l.media_item_id, l.file_id) FROM media_file_items l WHERE l.media_item_id IN (SELECT id FROM subjects)),
                (SELECT jsonb_agg(jsonb_build_array(to_jsonb(f), f.xmin::text) ORDER BY f.id) FROM media_files f WHERE f.id IN (SELECT file_id FROM files)),
                (SELECT jsonb_agg(jsonb_build_array(to_jsonb(c), c.xmin::text) ORDER BY c.file_id, c.chapter_index) FROM episode_chapters c WHERE c.file_id IN (SELECT file_id FROM files)),
                (SELECT jsonb_agg(jsonb_build_array(to_jsonb(lp), lp.xmin::text) ORDER BY lp.id) FROM library_paths lp WHERE ${subjects === undefined} AND lp.library_group_id = (SELECT library_group_id FROM media_items WHERE id = ${seriesId})),
                (SELECT jsonb_agg(jsonb_build_array(to_jsonb(ms), ms.xmin::text) ORDER BY ms.file_id, ms.stream_index) FROM media_streams ms WHERE ${subjects === undefined} AND ms.file_id IN (SELECT file_id FROM files) AND ms.stream_type = 'audio')
            )::text AS image
    `;
    return {
        image: row.image,
        mediaIds: row.media_ids,
        fileIds: row.file_ids,
        libraryGroupIds: row.library_group_ids,
        libraryLanguage: row.library_language,
        audioLanguages: row.audio_languages,
    };
}

/** Bounded Recheck locking: only examined UUIDs and their captured ancestors and
 * files. Parent FOR UPDATE locks fence FK insertions; compare the graph again
 * after acquiring every lock before using any evidence.
 */
export async function lockQuarantineEvidence(
    sql: postgres.Sql,
    evidence: ReconciliationEvidence,
): Promise<void> {
    await sql`SELECT id FROM media_items WHERE id = ANY(${evidence.mediaIds}::uuid[]) ORDER BY id FOR UPDATE`;
    await sql`SELECT media_id FROM external_ids WHERE media_id = ANY(${evidence.mediaIds}::uuid[]) ORDER BY media_id, provider, media_type, external_id FOR UPDATE`;
    await sql`SELECT id FROM media_files WHERE id = ANY(${evidence.fileIds}::uuid[]) ORDER BY id FOR UPDATE`;
    await sql`SELECT file_id FROM media_file_items WHERE media_item_id = ANY(${evidence.mediaIds}::uuid[]) ORDER BY media_item_id, file_id FOR UPDATE`;
    await sql`SELECT file_id FROM episode_chapters WHERE file_id = ANY(${evidence.fileIds}::uuid[]) ORDER BY file_id, chapter_index FOR UPDATE`;
}

/** The dependency graph must not release another candidate whose own proposal
 * was excluded (including confidence, selection, ancestor protection or a
 * protected target). Iterate this graph to a fixed point before any deletion.
 */
export async function getReconciliationTargetHolders(
    sql: postgres.Sql,
    seriesId: string,
    targets: string[],
): Promise<{ mediaId: string; targetId: string; hasFiles: boolean }[]> {
    const rows = await sql<{ media_id: string; target_id: string; has_files: boolean }[]>`
        SELECT e.media_id, e.external_id AS target_id,
            EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = ep.id) AS has_files
        FROM external_ids e
        JOIN media_items ep ON ep.id = e.media_id AND ep.media_type = 'episode'
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        WHERE season.parent_id = ${seriesId} AND e.provider = 'tmdb' AND e.media_type = 'episode'
            AND e.external_id = ANY(${targets}::text[])
    `;
    return rows.map((r) => ({ mediaId: r.media_id, targetId: r.target_id, hasFiles: r.has_files }));
}

/** Provider identity/language provenance survives the producer's own child writes.
 * Match graph evidence is captured separately after those writes complete. */
export async function getReconciliationCatalogInputs(
    sql: postgres.Sql,
    seriesId: string,
): Promise<string> {
    const [row] = await sql<{ image: string }[]>`
        SELECT jsonb_build_array(
            (SELECT jsonb_build_array(id, library_group_id) FROM media_items WHERE id = ${seriesId}),
            (SELECT jsonb_agg(jsonb_build_array(to_jsonb(e), e.xmin::text) ORDER BY provider, media_type, external_id)
                FROM external_ids e WHERE media_id = ${seriesId}),
            (SELECT jsonb_agg(jsonb_build_array(to_jsonb(lp), lp.xmin::text) ORDER BY lp.id)
                FROM library_paths lp WHERE lp.library_group_id = (SELECT library_group_id FROM media_items WHERE id = ${seriesId}))
        )::text AS image
    `;
    return row.image;
}

/** Metadata and identity before a guarded filename apply releases any swap owner. */
export interface ReconciliationUndoSnapshot {
    episode_id: string;
    parent_id: string;
    season_number: number;
    episode_number: number;
    title: string | null;
    overview: string | null;
    title_binding: string | null;
    still_path: string | null;
    tmdb_id: string | null;
}

export async function getReconciliationUndoSnapshots(
    sql: postgres.Sql,
    episodeIds: string[],
): Promise<ReconciliationUndoSnapshot[]> {
    if (episodeIds.length === 0) return [];
    return sql<ReconciliationUndoSnapshot[]>`
        SELECT ep.id AS episode_id, ep.parent_id, ep.season_number, ep.episode_number,
            ep.title, ep.overview, ep.title_binding,
            (SELECT metadata->>'still_path' FROM provider_metadata
                WHERE media_id = ep.id AND provider = 'tmdb') AS still_path,
            (SELECT external_id FROM external_ids
                WHERE media_id = ep.id AND provider = 'tmdb' AND media_type = 'episode') AS tmdb_id
        FROM media_items ep WHERE ep.id = ANY(${episodeIds}::uuid[])
    `;
}
