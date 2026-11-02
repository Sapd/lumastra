// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Artist Enrichment Query Module
 *
 * Pure SQL queries for the artist-enrichment sync plugin. The three backlog
 * predicates live together in this module on purpose: the drain's
 * fetchSlice predicate (`getUnenrichedArtists`) and the admin card's count
 * predicate (`countUnenrichedArtists`) MUST stay in lockstep, otherwise the
 * progress bar never converges to zero. Putting them side-by-side makes the
 * invariant checkable at a glance.
 *
 * @module queries/artist-enrichment
 */

import type postgres from 'postgres';

// =============================================================================
// Types
// =============================================================================

export interface UnenrichedArtistRow {
    id: string;
    title: string;
}

export interface ArtistEnrichmentBacklogCounts {
    analyzed: number;
    /** Rows the drain will actually pick up on the next tick. */
    remaining: number;
    /** Rows that will never be touched by this plugin (user-uploaded posters). */
    ineligible: number;
    /** Rows where the enrichment source threw at the current processing version. */
    failed: number;
}

// =============================================================================
// Predicates
// =============================================================================

/**
 * Select the next slice of artists that need enrichment.
 *
 * IMPORTANT: This WHERE clause MUST match `countUnenrichedArtists` exactly,
 * otherwise the progress bar drifts. Both queries consider an artist eligible
 * when it has NO `custom_poster_url` AND either no marker or a marker whose
 * version is older than `processingVersion`, AND `is_various_artists = false`
 * (flagged VA rows have no real upstream and would otherwise pull whatever
 * placeholder TheAudioDB has for VA).
 *
 * Ordering is `created_at DESC` so freshly-imported artists get enriched
 * first — newly-visible content is the most common user complaint.
 * `id ASC` is appended as the tiebreaker so artists sharing a created_at
 * (e.g. a bulk import flushed on one clock tick) return in a stable order;
 * drainBacklog's no-progress detector otherwise misfires when the engine
 * shuffles ties across fetches.
 */
export async function getUnenrichedArtists(
    sql: postgres.Sql<Record<string, never>>,
    processingVersion: number,
    limit: number,
): Promise<UnenrichedArtistRow[]> {
    return sql<UnenrichedArtistRow[]>`
        SELECT id, title FROM media_items
        WHERE media_type = 'artist'
          AND custom_poster_url IS NULL
          AND is_various_artists = false
          AND (
              processing_state->'artist-enrichment' IS NULL
              OR (processing_state->'artist-enrichment'->>'version')::int < ${processingVersion}
          )
        ORDER BY created_at DESC, id ASC
        LIMIT ${limit}
    `;
}

/**
 * Count how many artists the next drain slice will find. Kept 1:1 in sync
 * with `getUnenrichedArtists` — any change to the fetch predicate MUST be
 * reflected here.
 */
export async function countUnenrichedArtists(
    sql: postgres.Sql<Record<string, never>>,
    processingVersion: number,
): Promise<number> {
    const [row] = await sql<{ c: number }[]>`
        SELECT COUNT(*)::int AS c
        FROM media_items
        WHERE media_type = 'artist'
          AND custom_poster_url IS NULL
          AND is_various_artists = false
          AND (
              processing_state->'artist-enrichment' IS NULL
              OR (processing_state->'artist-enrichment'->>'version')::int < ${processingVersion}
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
 *   - remaining  → no marker / stale version, no poster (drain picks these)
 *   - ineligible → no marker / stale version, but has a poster
 *                  (user upload or pre-v3 plugin data)
 *
 * Single scan over `media_items WHERE media_type='artist'`.
 */
export async function getArtistEnrichmentBacklog(
    sql: postgres.Sql<Record<string, never>>,
    processingVersion: number,
): Promise<ArtistEnrichmentBacklogCounts> {
    const [row] = await sql<
        Array<{
            analyzed: number;
            remaining: number;
            ineligible: number;
            failed: number;
        }>
    >`
        WITH marker AS (
            SELECT
                mi.id,
                mi.custom_poster_url,
                (processing_state->'artist-enrichment'->>'version')::int AS version,
                processing_state->'artist-enrichment'->>'status'         AS status
            FROM media_items mi
            WHERE media_type = 'artist'
              AND mi.is_various_artists = false
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
                  AND custom_poster_url IS NULL
            )::int AS remaining,
            COUNT(*) FILTER (
                WHERE (version IS NULL OR version < ${processingVersion})
                  AND custom_poster_url IS NOT NULL
            )::int AS ineligible
        FROM marker
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
 * Return up to `limit` artist IDs from `media_item_stage_state` where the row
 * is in a retriable state for `stageId`. Used when
 * `PIPELINE_COVERAGE_AUTHORITATIVE_STAGES` includes `'artist-enrichment'` and
 * the coverage table is the authoritative eligibility source instead of the
 * legacy `processing_state` / poster-absence predicate.
 *
 * Retriable statuses:
 *   pending          — not yet processed
 *   failed_transient — transient failure, backoff window expired
 *   obsolete         — content changed, needs re-enrichment
 *   skipped_transient — transient skip (e.g. upstream outage), retry allowed
 *
 * The JOIN back to `media_items` keeps the result shape identical to
 * `getUnenrichedArtists` so callers can swap the fetch without touching
 * the process-slice logic.
 */
export async function findCoverageTableBacklog(
    sql: postgres.Sql<Record<string, never>>,
    stageId: string,
    limit: number,
): Promise<UnenrichedArtistRow[]> {
    return sql<UnenrichedArtistRow[]>`
        SELECT mi.id, mi.title
        FROM media_item_stage_state miss
        JOIN media_items mi ON mi.id = miss.media_item_id
        WHERE miss.stage_id = ${stageId}
          AND miss.status IN ('pending', 'failed_transient', 'obsolete', 'skipped_transient')
          AND (miss.next_eligible_at IS NULL OR miss.next_eligible_at <= now())
          AND mi.media_type = 'artist'
          -- Same exclusion as getUnenrichedArtists. The stage sweep disposes the
          -- VA row as not-applicable, but the boot catch-up can run first.
          AND mi.is_various_artists = false
        ORDER BY mi.created_at DESC NULLS LAST, mi.id ASC
        LIMIT ${limit}
    `;
}

// =============================================================================
// Provider-change re-enroll (non-destructive)
// =============================================================================
//
// When a new provider becomes usable (e.g. an admin adds DISCOGS_TOKEN AFTER
// the catalog was already enriched with only the keyless TheAudioDB), already-
// enriched artists are terminal and would never be re-tried — there is no
// per-item record of which providers ran. These two helpers re-open ONLY the
// artists that still have a coverage gap (no poster), so the newly-available
// provider gets a chance to fill it. Artists that already have a poster are left
// untouched: this is the non-destructive alternative to the force-wipe (which
// blows away ALL enrichment for ALL artists).
//
// Imprecision (accepted, documented): without a per-item provider fingerprint,
// gap artists that the new provider ALSO can't fill get re-polled once per
// provider-config change and re-tombstoned. That is bounded by explicit admin
// settings saves, not by the scheduled cadence. A per-item fingerprint would
// remove even that bounded re-poll — deferred.

/**
 * Coverage-table path (PIPELINE_COVERAGE_AUTHORITATIVE_STAGES includes this
 * stage): flip terminal (`completed` / `skipped_permanent`) stage rows, and
 * rows parked after a source outage, back to `pending` for artists that still
 * lack a poster. VA aliases are excluded to
 * mirror the drain's own eligibility predicate. Returns rows re-enrolled.
 */
export async function reEnrollGapArtistsForRepoll(
    sql: postgres.Sql<Record<string, never>>,
    stageId: string,
): Promise<number> {
    const result = await sql`
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
           AND mi.media_type = 'artist'
           AND mi.custom_poster_url IS NULL
           AND mi.is_various_artists = false
    `;
    return result.count ?? 0;
}

/**
 * Legacy `processing_state` path: drop the enrichment marker for artists that
 * still lack a poster so `getUnenrichedArtists` re-includes them on the next
 * drain. (The VA filter in that predicate already excludes VA aliases, so no
 * extra guard is needed here.) Returns rows whose marker was cleared.
 */
export async function clearArtistMarkerForGapRepoll(
    sql: postgres.Sql<Record<string, never>>,
): Promise<number> {
    const result = await sql`
        UPDATE media_items
           SET processing_state = processing_state - 'artist-enrichment',
               updated_at = now()
         WHERE media_type = 'artist'
           AND custom_poster_url IS NULL
           AND processing_state ? 'artist-enrichment'
    `;
    return result.count ?? 0;
}

// =============================================================================
// Source outage deferral
// =============================================================================

/**
 * Park one artist as `skipped_transient`, for when an enrichment source failed
 * instead of answering and no other source had an image.
 * `findCoverageTableBacklog` skips the row until `next_eligible_at`, so the
 * drain doesn't hammer a broken provider, and picks it up again afterwards.
 *
 * Backoff: `retryAfterMs` on the first deferral, doubling on each consecutive
 * one (counted in `last_error.deferrals`) up to `maxRetryAfterMs`, plus up to
 * 10 % jitter so a whole outage's worth of artists doesn't come due in the
 * same second. A provider that stays broken is re-asked rarely, not forever
 * every few hours. Re-enrolling or completing the row clears the count.
 *
 * Also drops a `processing_state` marker that carries a status: the stage's
 * `legacy-done-skipped` disposition tombstones any sweepable row with one,
 * which would turn this retry into the very permanent no-match it exists to
 * avoid. It never writes a marker itself, for the same reason.
 *
 * Only touches rows the drain could have selected. Returns `true` when the
 * row was deferred.
 */
export async function deferArtistAfterSourceOutage(
    sql: postgres.Sql<Record<string, never>>,
    input: {
        artistId: string;
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
                     AND media_item_id = ${input.artistId}::uuid
              ) d
             WHERE miss.stage_id = ${input.stageId}
               AND miss.media_item_id = ${input.artistId}::uuid
               AND miss.status IN ('pending', 'failed_transient', 'skipped_transient', 'obsolete')
            RETURNING miss.media_item_id
        ), unmarked AS (
            UPDATE media_items mi
               SET processing_state = mi.processing_state - 'artist-enrichment'
              FROM parked
             WHERE mi.id = parked.media_item_id
               AND mi.processing_state->'artist-enrichment'->>'status' IS NOT NULL
        )
        SELECT EXISTS (SELECT 1 FROM parked) AS deferred
    `;
    return row?.deferred === true;
}

/**
 * Read the artist's established identity. Lock the existing mapping BEFORE the
 * parent, matching CatalogService's delete/reinsert correction order. Then lock
 * the parent (also protecting an absent mapping against FK inserts) and re-read
 * the mapping: a replacement/insertion may have committed while we waited.
 * Call with `lock` only inside a transaction, after provider requests finish.
 */
export async function getArtistMusicBrainzId(
    sql: postgres.Sql<Record<string, never>>,
    artistId: string,
    lock = false,
): Promise<string | null> {
    if (lock) {
        await sql`
            SELECT id FROM external_ids
            WHERE media_id = ${artistId}::uuid
              AND provider = 'musicbrainz' AND media_type = 'artist'
            FOR UPDATE
        `;
        const rows = await sql`
            SELECT id FROM media_items
            WHERE id = ${artistId}::uuid AND media_type = 'artist'
            FOR UPDATE
        `;
        if (rows.length === 0) throw new Error('Artist no longer exists');
    }
    const [row] = await sql<{ external_id: string }[]>`
        SELECT external_id FROM external_ids
        WHERE media_id = ${artistId}::uuid
          AND provider = 'musicbrainz' AND media_type = 'artist'
        ${lock ? sql`FOR UPDATE` : sql``}
    `;
    return row?.external_id ?? null;
}

// =============================================================================
// Mutations
// =============================================================================

/**
 * Write custom poster/backdrop URLs on an artist. Only touches the two
 * dedicated columns so custom_metadata (NFO / user-curated) stays untouched.
 *
 * `thumbUrl` is typed as `string | null` to match the upstream shape
 * (`ArtistEnrichmentResult.thumbUrl`) — callers pass it through unchanged.
 * Writing NULL is a deliberate no-op: the UPDATE would clear the poster,
 * which only happens when the upstream merge genuinely had no URL, in
 * which case the plugin shouldn't have called this function.
 */
export async function updateArtistPosterUrls(
    sql: postgres.Sql<Record<string, never>>,
    artistId: string,
    thumbUrl: string | null,
    fanartUrl: string | null,
): Promise<{ poster: boolean; backdrop: boolean }> {
    const [row] = await sql<{ poster: boolean; backdrop: boolean }[]>`
        WITH owned AS (
            SELECT id,
                (${thumbUrl}::text IS NOT NULL AND (custom_poster_url IS NULL OR custom_poster_url = custom_metadata #>> '{artist_enrichment,provenance,poster,value}')) AND NOT EXISTS (SELECT 1 FROM image_candidates WHERE media_item_id = media_items.id AND artwork_type = 'poster' AND (locked OR chosen_by <> 'auto' OR provider IN ('local-folder','embedded'))) AS poster,
                (${fanartUrl}::text IS NOT NULL AND (custom_backdrop_url IS NULL OR custom_backdrop_url = custom_metadata #>> '{artist_enrichment,provenance,backdrop,value}')) AND NOT EXISTS (SELECT 1 FROM image_candidates WHERE media_item_id = media_items.id AND artwork_type = 'backdrop' AND (locked OR chosen_by <> 'auto' OR provider IN ('local-folder','embedded'))) AS backdrop
            FROM media_items WHERE id = ${artistId} FOR UPDATE
        ), written AS (
            UPDATE media_items mi
            SET custom_poster_url = CASE WHEN owned.poster THEN ${thumbUrl} ELSE mi.custom_poster_url END,
                custom_backdrop_url = CASE WHEN owned.backdrop THEN ${fanartUrl} ELSE mi.custom_backdrop_url END
            FROM owned WHERE mi.id = owned.id
        )
        SELECT poster, backdrop FROM owned
    `;
    return { poster: row?.poster === true, backdrop: row?.backdrop === true };
}

/**
 * Merge plugin-written enrichment fields into the namespace key on
 * custom_metadata. `enrichmentPayload` holds keys like `biography`,
 * `genre`, `country_code` — only fields the source actually returned.
 *
 * Uses `jsonb_build_object + ||` so the write is additive: existing
 * namespace fields are preserved when the new payload is smaller (e.g. a
 * partial fallback run).
 */
export async function mergeArtistEnrichmentMetadata(
    sql: postgres.Sql<Record<string, never>>,
    artistId: string,
    namespaceKey: string,
    enrichmentPayload: Record<string, string>,
): Promise<void> {
    // Cast namespaceKey to text on both occurrences: `jsonb_build_object` is
    // VARIADIC any (no type constraint) and `jsonb -> $1` is ambiguous between
    // `-> int` and `-> text`. Without the cast PostgreSQL parses the statement
    // as "could not determine data type of parameter $1" and the merge never
    // lands.
    await sql`
        UPDATE media_items
        SET custom_metadata = COALESCE(custom_metadata, '{}'::jsonb)
            || jsonb_build_object(
                ${namespaceKey}::text,
                COALESCE(custom_metadata->${namespaceKey}::text, '{}'::jsonb)
                    || ${sql.json(enrichmentPayload)}::jsonb
            )
        WHERE id = ${artistId}
    `;
}

export type ProcessStatus = 'success' | 'no-match' | 'failed';

/**
 * Write the processing_state marker. `status='success'` is persisted as an
 * omitted field — it's the implicit default. 'no-match' and 'failed' are
 * explicit so getBacklogStatus can surface each in its own bucket and so
 * future debugging can see *why* a row was marked.
 *
 * Returns `true` if the UPDATE landed, `false` on any DB failure (pool
 * exhaustion, constraint violation, connection drop). A failed mark leaves
 * the row eligible for the next slice — exactly what drainBacklog's
 * `advanced: false` path encodes.
 *
 * Transactional callers that want a mark failure to ROLL BACK the
 * surrounding `sql.begin` must treat a `false` return as an error and
 * throw explicitly — see `artist-enrichment.plugin.ts`. Swallowing the
 * failure inside the tx would leave the row half-written.
 */
export async function markArtistProcessed(
    sql: postgres.Sql<Record<string, never>>,
    artistId: string,
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
                'artist-enrichment': marker,
            })}
            WHERE id = ${artistId}
        `;
        return true;
    } catch {
        return false;
    }
}

// =============================================================================
// Wipe
// =============================================================================

/**
 * Row returned by `getArtistEnrichmentWipeBatch`.
 */
export interface ArtistEnrichmentWipeRow {
    id: string;
}

/**
 * Pick up to `limit` artist IDs that still carry a plugin-written marker —
 * the ones we need to roll back in an atomic wipe batch.
 */
export async function getArtistEnrichmentWipeBatch(
    sql: postgres.Sql<Record<string, never>>,
    limit: number,
): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT id
        FROM media_items
        WHERE media_type = 'artist'
          AND jsonb_typeof(processing_state) = 'object'
          AND processing_state ? 'artist-enrichment'
        LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
}

/**
 * Atomic wipe for the given artist IDs:
 *   - delete MusicBrainz external_ids (re-fetched on next drain)
 *   - clear custom poster/backdrop URLs
 *   - strip the namespace key from custom_metadata
 *   - clear the processing_state marker
 *
 * All four writes happen in a single CTE so a cancelled force-mode run
 * cannot land with (e.g.) the poster URL cleared but the marker still
 * present — which would park the row in `analyzed` forever.
 *
 * Returns the count of artists actually updated (can be < ids.length if a
 * concurrent writer already cleared the marker on some ids).
 */
export async function atomicallyWipeArtistEnrichment(
    sql: postgres.Sql<Record<string, never>>,
    ids: string[],
    namespaceKey: string,
): Promise<number> {
    const [row] = await sql<{ affected: number }[]>`
        WITH del_ext AS (
            DELETE FROM external_ids
            WHERE provider = 'musicbrainz'
              AND media_id = ANY(${ids})
            RETURNING 1
        ),
        updated AS (
            UPDATE media_items mi
            SET
                custom_poster_url = CASE WHEN mi.custom_poster_url = mi.custom_metadata #>> ARRAY[${namespaceKey}, 'provenance', 'poster', 'value']::text[] THEN NULL ELSE mi.custom_poster_url END,
                custom_backdrop_url = CASE WHEN mi.custom_backdrop_url = mi.custom_metadata #>> ARRAY[${namespaceKey}, 'provenance', 'backdrop', 'value']::text[] THEN NULL ELSE mi.custom_backdrop_url END,
                custom_metadata = mi.custom_metadata - ${namespaceKey},
                processing_state = mi.processing_state - 'artist-enrichment',
                updated_at = NOW()
            WHERE mi.id = ANY(${ids})
              AND jsonb_typeof(mi.processing_state) = 'object'
              AND mi.processing_state ? 'artist-enrichment'
            RETURNING mi.id
        )
        SELECT COUNT(*)::int AS affected FROM updated
    `;
    return row?.affected ?? 0;
}
