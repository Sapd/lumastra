// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Album Enrichment Query Module
 *
 * Pure SQL queries for the album-enrichment sync plugin. The three backlog
 * predicates live together in this module on purpose: the drain's
 * fetchSlice predicate (`getUnenrichedAlbums`) and the admin card's count
 * predicate (`countUnenrichedAlbums`) MUST stay in lockstep, otherwise the
 * progress bar never converges to zero. Putting them side-by-side makes the
 * invariant checkable at a glance.
 *
 * Unlike the artist-enrichment module, eligibility is keyed on the absence
 * of a `image_candidates` poster row (not `custom_poster_url IS NULL`) because
 * the plugin writes through `upsertLocalArtwork`, which may leave
 * `custom_poster_url` populated from a prior admin upload even when the
 * plugin has never run. Keying on the artwork row is the correct gate.
 *
 * @module queries/album-enrichment
 */

import type postgres from 'postgres';
import type { PluginBacklogStatus } from '../../tasks/sync-context-types.js';
import { recordFailure } from './plugin-failure-events.queries.js';
import { lockArtworkOwners } from './media-artwork.queries.js';

export { recordFailure };

// =============================================================================
// Types
// =============================================================================

export interface UnenrichedAlbumRow {
    id: string;
    title: string;
    /** Artist UUID — null for orphan albums (no parent_id set). */
    parent_id: string | null;
    /** Joined from media_items where id = parent_id AND media_type = 'artist'. Null for orphans. */
    parent_title: string | null;
}

export type ProcessStatus = 'success' | 'no-match' | 'failed';

// =============================================================================
// Predicates
// =============================================================================

/**
 * Select the next slice of albums that need enrichment.
 *
 * IMPORTANT: This WHERE clause MUST match `countUnenrichedAlbums` exactly,
 * otherwise the progress bar drifts. Both queries consider an album eligible
 * when it has NO poster artwork row in `image_candidates` AND either no
 * album-enrichment marker or a marker whose version is older than
 * `processingVersion`.
 *
 * The parent artist title is joined here so the plugin chain can build
 * source queries without a second roundtrip. Orphan albums (parent_id IS NULL
 * or no matching artist row) are returned with `parent_title = null` — the
 * plugin records `status='failed'` with `reason='no_artist'` for those rows.
 *
 * Ordering is `created_at DESC` so freshly-imported albums get enriched
 * first — newly-visible content is the most common user complaint.
 * `id ASC` is the tiebreaker so albums sharing a created_at timestamp
 * return in a stable order; drainBacklog's no-progress detector otherwise
 * misfires when the engine shuffles ties across fetches.
 */
export async function getUnenrichedAlbums(
    sql: postgres.Sql<Record<string, never>>,
    processingVersion: number,
    limit: number,
): Promise<UnenrichedAlbumRow[]> {
    return sql<UnenrichedAlbumRow[]>`
        SELECT
            mi.id,
            mi.title,
            mi.parent_id,
            parent.title AS parent_title
        FROM media_items mi
        LEFT JOIN media_items parent
            ON parent.id = mi.parent_id
            AND parent.media_type = 'artist'
        WHERE mi.media_type = 'album'
          AND mi.status = 'active' AND NOT mi.is_dismissed AND mi.has_files = true
          AND NOT EXISTS (
              SELECT 1 FROM image_candidates ma
              WHERE ma.media_item_id = mi.id
                AND ma.artwork_type = 'poster'
          )
          AND (
              mi.processing_state -> 'album-enrichment' IS NULL
              OR (mi.processing_state -> 'album-enrichment' ->> 'version')::int < ${processingVersion}
          )
        ORDER BY mi.created_at DESC NULLS LAST, mi.id ASC
        LIMIT ${limit}
    `;
}

/**
 * Count how many albums the next drain slice will find. Kept 1:1 in sync
 * with `getUnenrichedAlbums` — any change to the fetch predicate MUST be
 * reflected here.
 */
export async function countUnenrichedAlbums(
    sql: postgres.Sql<Record<string, never>>,
    processingVersion: number,
): Promise<number> {
    const [row] = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c
        FROM media_items mi
        WHERE mi.media_type = 'album'
          AND mi.status = 'active' AND NOT mi.is_dismissed AND mi.has_files = true
          AND NOT EXISTS (
              SELECT 1 FROM image_candidates ma
              WHERE ma.media_item_id = mi.id
                AND ma.artwork_type = 'poster'
          )
          AND (
              mi.processing_state -> 'album-enrichment' IS NULL
              OR (mi.processing_state -> 'album-enrichment' ->> 'version')::int < ${processingVersion}
          )
    `;
    return row?.c ?? 0;
}

/**
 * Full backlog breakdown for the admin card. Bucket semantics:
 *   - analyzed   → current-version marker, status ≠ 'failed'
 *                  (success or 'no-match')
 *   - failed     → current-version marker, status = 'failed'
 *                  (enrichment source threw — retry on version bump)
 *   - remaining  → no marker / stale version, no poster artwork row
 *                  (drain picks these up)
 *   - ineligible → albums with an existing poster artwork row
 *                  (post-scan, admin upload, or prior plugin run)
 *
 * The pending bucket uses the same eligibility predicate as
 * `getUnenrichedAlbums` / `countUnenrichedAlbums` — a NOT EXISTS on
 * `image_candidates WHERE artwork_type = 'poster'`. Rows that have a poster
 * row are always ineligible, regardless of their processing_state.
 *
 * Single scan over `media_items WHERE media_type='album'`.
 */
export async function getAlbumEnrichmentBacklog(
    sql: postgres.Sql<Record<string, never>>,
    processingVersion: number,
): Promise<PluginBacklogStatus> {
    const [row] = await sql<
        Array<{
            analyzed: number;
            remaining: number;
            ineligible: number;
            failed: number;
        }>
    >`
        WITH classified AS (
            SELECT
                mi.id,
                (mi.processing_state -> 'album-enrichment' ->> 'version')::int AS version,
                mi.processing_state -> 'album-enrichment' ->> 'status'          AS status,
                EXISTS (
                    SELECT 1 FROM image_candidates ma
                    WHERE ma.media_item_id = mi.id
                      AND ma.artwork_type = 'poster'
                ) AS has_poster
            FROM media_items mi
            WHERE mi.media_type = 'album'
          AND mi.status = 'active' AND NOT mi.is_dismissed AND mi.has_files = true
        )
        SELECT
            COUNT(*) FILTER (
                WHERE version >= ${processingVersion}
                  AND (status IS NULL OR status <> 'failed')
            )::int AS analyzed,
            COUNT(*) FILTER (
                WHERE version >= ${processingVersion}
                  AND status = 'failed'
            )::int AS failed,
            COUNT(*) FILTER (
                WHERE (version IS NULL OR version < ${processingVersion})
                  AND NOT has_poster
            )::int AS remaining,
            COUNT(*) FILTER (
                WHERE has_poster
            )::int AS ineligible
        FROM classified
    `;
    return {
        analyzed: row?.analyzed ?? 0,
        remaining: row?.remaining ?? 0,
        ineligible: row?.ineligible ?? 0,
        failed: row?.failed ?? 0,
    };
}

// =============================================================================
// Coverage-table backlog (feature-flag path)
// =============================================================================

/**
 * Return up to `limit` album IDs from `media_item_stage_state` where the row
 * is in a retriable state for `stageId`. Used when
 * `PIPELINE_COVERAGE_AUTHORITATIVE_STAGES` includes `'album-enrichment'` and
 * the coverage table is the authoritative eligibility source instead of the
 * legacy `processing_state` / artwork-absence predicate.
 *
 * Retriable statuses:
 *   pending          — not yet processed
 *   failed_transient — transient failure, backoff window expired
 *   obsolete         — content changed, needs re-enrichment
 *   skipped_transient — transient skip (e.g. upstream outage), retry allowed
 *
 * The JOIN back to `media_items` and the artist parent keeps the result shape
 * identical to `getUnenrichedAlbums` so callers can swap the fetch without
 * touching the process-slice logic.
 */
export async function findCoverageTableBacklog(
    sql: postgres.Sql<Record<string, never>>,
    stageId: string,
    limit: number,
): Promise<UnenrichedAlbumRow[]> {
    return sql<UnenrichedAlbumRow[]>`
        SELECT mi.id, mi.title, mi.parent_id, parent.title AS parent_title
        FROM media_item_stage_state miss
        JOIN media_items mi ON mi.id = miss.media_item_id
        LEFT JOIN media_items parent
            ON parent.id = mi.parent_id
            AND parent.media_type = 'artist'
        WHERE miss.stage_id = ${stageId}
          AND miss.status IN ('pending', 'failed_transient', 'obsolete', 'skipped_transient')
          AND (miss.next_eligible_at IS NULL OR miss.next_eligible_at <= now())
          AND mi.media_type = 'album'
          AND mi.status = 'active' AND NOT mi.is_dismissed AND mi.has_files = true
        ORDER BY mi.created_at DESC NULLS LAST, mi.id ASC
        LIMIT ${limit}
    `;
}

// =============================================================================
// Provider-change re-enroll (non-destructive)
// =============================================================================
//
// Mirror of the artist-enrichment helpers — re-open ONLY albums that still lack
// a poster so a newly-usable provider (e.g. Discogs after an admin adds the
// token) can fill the gap, without the destructive force-wipe. The album "gap"
// is the absence of a `image_candidates` poster row (matching getUnenrichedAlbums),
// not `custom_poster_url`. See the artist module for the full rationale +
// accepted imprecision note.

/**
 * Coverage-table path: flip terminal (`completed` / `skipped_permanent`) stage
 * rows, and rows parked after a source outage, back to `pending` for albums
 * that still lack a poster artwork row.
 * Albums tombstoned for having no parent artist stay put: every source needs
 * an artist name, and linking one re-opens them through identity events.
 *
 * Also drops the re-opened rows' `processing_state` marker. The stage's
 * `legacy-no-match` disposition tombstones any sweepable row whose marker
 * says `no-match`, so without this the re-opened albums went straight back to
 * `skipped_permanent` before the drain could ask a source again; and the
 * admin backlog card, which buckets off the marker, kept counting them as
 * analyzed. Returns rows re-enrolled.
 */
export async function reEnrollGapAlbumsForRepoll(
    sql: postgres.Sql<Record<string, never>>,
    stageId: string,
): Promise<number> {
    const [row] = await sql<{ count: number }[]>`
        WITH reopened AS (
        UPDATE media_item_stage_state miss
           SET status = 'pending',
               attempt = 0,
               declines = 0,
               declines_since = NULL,
               last_error = NULL,
               next_eligible_at = now(),
               started_at = NULL,
               completed_at = NULL,
               updated_at = now()
          FROM media_items mi
         WHERE miss.media_item_id = mi.id
           AND miss.stage_id = ${stageId}
           AND (
               miss.status IN ('completed', 'skipped_permanent')
               -- Parked after a source outage: with backoff up to 90 days,
               -- a fixed key or a re-poll must not wait for the parking to end.
               OR (miss.status = 'skipped_transient' AND miss.skipped_reason = 'source-unavailable')
           )
           AND miss.skipped_reason IS DISTINCT FROM 'no-parent-artist'
           AND mi.media_type = 'album'
          AND mi.status = 'active' AND NOT mi.is_dismissed AND mi.has_files = true
           AND NOT EXISTS (
               SELECT 1 FROM image_candidates ma
               WHERE ma.media_item_id = mi.id
                 AND ma.artwork_type = 'poster'
           )
        RETURNING miss.media_item_id
        ), unmarked AS (
            UPDATE media_items mi
               SET processing_state = mi.processing_state - 'album-enrichment'
              FROM reopened
             WHERE mi.id = reopened.media_item_id
               AND mi.processing_state ? 'album-enrichment'
        )
        SELECT COUNT(*)::int AS count FROM reopened
    `;
    return row?.count ?? 0;
}

/**
 * Legacy `processing_state` path: drop the enrichment marker for albums that
 * still lack a poster artwork row so `getUnenrichedAlbums` re-includes them.
 * Returns rows whose marker was cleared.
 */
export async function clearAlbumMarkerForGapRepoll(
    sql: postgres.Sql<Record<string, never>>,
): Promise<number> {
    const result = await sql`
        UPDATE media_items mi
           SET processing_state = processing_state - 'album-enrichment',
               updated_at = now()
         WHERE mi.media_type = 'album'
          AND mi.status = 'active' AND NOT mi.is_dismissed AND mi.has_files = true
           AND mi.processing_state ? 'album-enrichment'
           AND NOT EXISTS (
               SELECT 1 FROM image_candidates ma
               WHERE ma.media_item_id = mi.id
                 AND ma.artwork_type = 'poster'
           )
    `;
    return result.count ?? 0;
}

// =============================================================================
// Source outage deferral
// =============================================================================

/**
 * Park one album as `skipped_transient`, for when an enrichment source failed
 * instead of answering and nothing produced a poster. `findCoverageTableBacklog`
 * skips the row until `next_eligible_at`, so the drain doesn't hammer a broken
 * provider, and picks it up again afterwards.
 *
 * Backoff: `retryAfterMs` on the first deferral, doubling on each consecutive
 * one (counted in `last_error.deferrals`) up to `maxRetryAfterMs`, plus up to
 * 10 % jitter so a whole outage's worth of albums doesn't come due in the same
 * second. Re-enrolling or completing the row clears the count.
 *
 * Also drops a `no-match` `processing_state` marker: the stage's
 * `legacy-no-match` disposition tombstones any sweepable row with one, which
 * would turn this retry into the very permanent no-match it exists to avoid.
 * A `failed` marker stays, so the admin failures list keeps the reason. It
 * never writes a marker itself.
 *
 * Mirror of `deferArtistAfterSourceOutage`. Only touches rows the drain could
 * have selected. Returns `true` when the row was deferred.
 */
export async function deferAlbumAfterSourceOutage(
    sql: postgres.Sql<Record<string, never>>,
    input: {
        albumId: string;
        stageId: string;
        retryAfterMs: number;
        maxRetryAfterMs: number;
        detail: string;
    },
): Promise<boolean> {
    const [row] = await sql<{ deferred: boolean }[]>`
        WITH parked AS (
            UPDATE media_item_stage_state miss
               SET status = 'skipped_transient',
                   skipped_reason = 'source-unavailable',
                   -- A status change ends the decline streak (see
                   -- tasks/decline-reset-invariant.test.ts).
                   declines = 0,
                   declines_since = NULL,
                   last_error = jsonb_build_object(
                       'message', ${input.detail.slice(0, 500)}::text,
                       'code', 'source_unavailable',
                       'retryable', true,
                       'deferrals', d.n
                   ),
                   next_eligible_at = now() + make_interval(
                       secs => LEAST(
                           ${input.retryAfterMs / 1000}::float8 * power(2, LEAST(d.n - 1, 30)),
                           ${input.maxRetryAfterMs / 1000}::float8
                       ) * (1 + random() * 0.1)
                   ),
                   updated_at = now()
              FROM (
                  SELECT CASE
                             WHEN skipped_reason = 'source-unavailable'
                             THEN COALESCE((last_error->>'deferrals')::int, 0) + 1
                             ELSE 1
                         END AS n
                    FROM media_item_stage_state
                   WHERE stage_id = ${input.stageId}
                     AND media_item_id = ${input.albumId}::uuid
              ) d
             WHERE miss.stage_id = ${input.stageId}
               AND miss.media_item_id = ${input.albumId}::uuid
               AND miss.status IN ('pending', 'failed_transient', 'skipped_transient', 'obsolete')
            RETURNING miss.media_item_id
        ), unmarked AS (
            UPDATE media_items mi
               SET processing_state = mi.processing_state - 'album-enrichment'
              FROM parked
             WHERE mi.id = parked.media_item_id
               AND mi.processing_state->'album-enrichment'->>'status' = 'no-match'
        )
        SELECT EXISTS (SELECT 1 FROM parked) AS deferred
    `;
    return row?.deferred === true;
}

// =============================================================================
// Mutations
// =============================================================================

/**
 * Write the processing_state marker for an album. `status='success'` is
 * persisted as an omitted field — it's the implicit default. 'no-match' and
 * 'failed' are explicit so getAlbumEnrichmentBacklog can surface each in its
 * own bucket and so future debugging can see *why* a row was marked.
 *
 * Returns `true` if the UPDATE landed, `false` on any DB failure (pool
 * exhaustion, constraint violation, connection drop). A failed mark leaves
 * the row eligible for the next slice — exactly what drainBacklog's
 * `advanced: false` path encodes.
 *
 * Transactional callers that want a mark failure to ROLL BACK the
 * surrounding `sql.begin` must treat a `false` return as an error and
 * throw explicitly. Swallowing the failure inside the tx would leave the
 * row half-written.
 */
export async function markAlbumProcessed(
    sql: postgres.Sql<Record<string, never>>,
    albumId: string,
    processingVersion: number,
    status: ProcessStatus,
    reason?: string,
    jobId?: string,
): Promise<boolean> {
    const marker: {
        version: number;
        processedAt: string;
        status?: 'no-match' | 'failed';
        reason?: string;
        audit_run_job_id?: string;
    } = {
        version: processingVersion,
        processedAt: new Date().toISOString(),
    };
    if (status !== 'success') marker.status = status;
    if (reason) marker.reason = reason;
    if (status === 'failed' && jobId !== undefined) marker.audit_run_job_id = jobId;

    try {
        await sql`
            UPDATE media_items
            SET processing_state = COALESCE(processing_state, '{}'::jsonb) || ${sql.json({
                'album-enrichment': marker,
            })}
            WHERE id = ${albumId}
        `;
        return true;
    } catch {
        return false;
    }
}

/**
 * Write custom poster/backdrop URLs on an album. Only touches the two
 * dedicated columns so custom_metadata (NFO / user-curated) stays untouched.
 *
 * `posterUrl` and `backdropUrl` are typed `string | null | undefined`:
 * - `undefined` → field is omitted from SET, preserving the existing value.
 * - `null`      → explicit clear (should only happen in wipe paths; the
 *                 plugin normally does not call this with null).
 */
export async function updateAlbumPosterUrls(
    sql: postgres.Sql<Record<string, never>>,
    albumId: string,
    urls: { posterUrl?: string | null; backdropUrl?: string | null },
): Promise<void> {
    const { posterUrl, backdropUrl } = urls;
    await sql`
        UPDATE media_items
        SET custom_poster_url   = CASE WHEN ${posterUrl !== undefined} THEN ${posterUrl ?? null}   ELSE custom_poster_url   END,
            custom_backdrop_url = CASE WHEN ${backdropUrl !== undefined} THEN ${backdropUrl ?? null} ELSE custom_backdrop_url END
        WHERE id = ${albumId}
    `;
}

// =============================================================================
// Wipe
// =============================================================================

/**
 * Pick up to `batchSize` plugin-owned artwork rows so the wipe loop can
 * unlink the on-disk files before committing the DB deletes.
 *
 * Filters on `source='local'` and `remote_url='album-enrichment'` — the
 * authorship tag `upsertLocalArtwork` stores in `image_candidates.remote_url`
 * when called with `sourceTag='album-enrichment'`. User-uploaded rows
 * (`remote_url='admin:file'`) and post-scan rows are invisible to this
 * filter and are therefore never touched by the wipe.
 */
export async function getAlbumEnrichmentWipeBatch(
    sql: postgres.Sql<Record<string, never>>,
    batchSize: number,
): Promise<
    {
        id: string;
        media_item_id: string;
        file_path: string | null;
        artwork_type: string;
    }[]
> {
    return sql<
        {
            id: string;
            media_item_id: string;
            file_path: string | null;
            artwork_type: string;
        }[]
    >`
        SELECT ma.id, ma.media_item_id, ma.file_path, ma.artwork_type
        FROM image_candidates ma
        JOIN media_items mi ON mi.id = ma.media_item_id
        WHERE ma.source = 'local'
          AND ma.remote_url = 'album-enrichment' AND NOT ma.locked
          AND mi.media_type = 'album'
        UNION ALL
        SELECT mi.id, mi.id AS media_item_id, NULL AS file_path, 'poster' AS artwork_type
        FROM media_items mi
        WHERE mi.media_type = 'album'
          AND mi.custom_metadata ? 'album_enrichment'
          AND NOT EXISTS (SELECT 1 FROM image_candidates ma WHERE ma.media_item_id = mi.id AND ma.remote_url = 'album-enrichment')
        LIMIT ${batchSize}
    `;
}

/**
 * Atomic wipe for the given album IDs. Performs four writes in a single
 * transaction so a cancelled force-mode run cannot leave rows partially
 * rolled back (e.g., artwork row deleted but processing_state marker
 * still present, parking the album in `analyzed` forever):
 *
 *   1. Delete plugin-authored `image_candidates` rows.
 *   2. Null `custom_poster_url` / `custom_backdrop_url` when they point
 *      at the plugin's proxy endpoint (mirrors `deleteLocalArtworkForItem`
 *      invariant so we don't drift from the established pattern).
 *   3. Delete MBIDs this plugin contributed to `external_ids`.
 *   4. Drop the `album-enrichment` key from `processing_state`.
 *
 * The caller (the plugin's wipe loop) handles best-effort `unlink` of
 * on-disk files BEFORE calling this function. A missing file is not
 * fatal — the plugin may have written to a now-detached library mount,
 * or a prior partial wipe already removed the file but not the row.
 */
export async function atomicallyWipeAlbumEnrichment(
    sql: postgres.Sql<Record<string, never>>,
    albumIds: string[],
): Promise<void> {
    await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await lockArtworkOwners(tx, albumIds);

        // 1. Delete plugin-authored artwork rows.
        await tx`
            DELETE FROM image_candidates
            WHERE media_item_id = ANY(${albumIds})
              AND source = 'local'
              AND remote_url = 'album-enrichment' AND NOT locked
        `;

        // 2. Null custom_*_url columns where they still point at the plugin's
        //    proxy endpoint. The LIKE pattern matches /api/image/custom/<id>/...
        //    so URLs from other sources (TMDB, admin upload to a different item)
        //    are never clobbered.
        await tx`
            UPDATE media_items
            SET custom_poster_url   = CASE
                                          WHEN (custom_poster_url LIKE '/api/image/custom/' || id || '/%'
                                            AND NOT EXISTS (SELECT 1 FROM image_candidates ma WHERE ma.media_item_id = media_items.id AND ma.artwork_type = 'poster'))
                                            OR (custom_metadata #>> '{album_enrichment,provenance,poster,provider}' = 'coverartarchive'
                                            AND custom_poster_url = custom_metadata #>> '{album_enrichment,provenance,poster,value}')
                                          THEN NULL
                                          ELSE custom_poster_url
                                      END,
                custom_backdrop_url = CASE
                                          WHEN custom_backdrop_url LIKE '/api/image/custom/' || id || '/%'
                                            AND NOT EXISTS (SELECT 1 FROM image_candidates ma WHERE ma.media_item_id = media_items.id AND ma.artwork_type = 'backdrop')
                                          THEN NULL
                                          ELSE custom_backdrop_url
                                      END
            WHERE id = ANY(${albumIds})
        `;

        // 3. Delete MusicBrainz IDs the plugin contributed.
        await tx`
            DELETE FROM external_ids
            WHERE media_id = ANY(${albumIds})
              AND provider IN ('musicbrainz_release', 'musicbrainz_releasegroup')
              AND source = 'album-enrichment'
        `;

        // 4. Drop the processing-state namespace key so the album re-enters
        //    the eligible backlog on the next drain tick.
        await tx`
            UPDATE media_items
            SET processing_state = processing_state - 'album-enrichment',
                custom_metadata = custom_metadata - 'album_enrichment'
            WHERE id = ANY(${albumIds})
        `;
    });
}

/**
 * Persist a fallback cover-art URL for an album when it has none yet. Idempotent:
 * only writes when `custom_poster_url IS NULL`, so it never clobbers a stored
 * local-artwork path or an admin upload. Returns true if a row was updated.
 *
 * Used by album-enrichment to record the Cover Art Archive redirect URL for albums
 * with a resolved release MBID, so the image proxy can serve cover art even when no
 * local bytes were downloaded. Writing `custom_poster_url` does not affect the
 * `image_candidates`-keyed enrichment eligibility predicate.
 */
export async function setAlbumCoverArtUrlIfNull(
    sql: postgres.Sql,
    albumId: string,
    url: string,
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        UPDATE media_items
        SET custom_poster_url = ${url}
        WHERE id = ${albumId}
          AND media_type = 'album'
          AND custom_poster_url IS NULL
        RETURNING id
    `;
    return rows.length > 0;
}
