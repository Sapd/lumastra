// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sync Quarantine Query Module
 *
 * The `sync_quarantine` table captures inbound sync payloads that we refused to
 * apply because applying them would violate a series-identity invariant — most
 * commonly an episode whose Jellyfin SeriesId resolves to a Lumastra series whose
 * TMDB id disagrees with the episode's declared parent. The W2.2 Jellyfin sync
 * rework is the first writer; admin UI work consumes the rows via the list and
 * resolve helpers below.
 *
 * Lifecycle:
 *   - `quarantineWrite` — called from sync paths, returns the new entry's UUID.
 *   - `listUnresolvedQuarantine` / `listAllQuarantine` / `getQuarantineById` —
 *     read paths for the admin UI.
 *   - `resolveQuarantine` — admin marks an entry resolved with a verb describing
 *     what they did (`reattached`, `dismissed`, `recreated`).
 *   - `countUnresolvedQuarantine` — badge count for the admin dashboard.
 *   - `listUnresolvedQuarantineBySeries` / `listUnresolvedQuarantineForSeries` /
 *     `bulkResolveQuarantineBySeries` / `countDistinctSeriesWithUnresolvedQuarantine`
 *     — per-series grouping for the `/admin/library/quarantine` bulk triage
 *     surface. Rows concentrate in a small number of series (a single
 *     reconciliation-backfill run over one series can quarantine dozens of
 *     episodes), so an operator triages by series rather than by row.
 */

import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { RECONCILIATION_BLOCK_PROVIDERS } from './episode-reconciliation-moves.queries.js';

/**
 * Composable SQL fragment resolving the "effective" series id for a
 * quarantine row: the `expected_series_id` column when set, falling back to
 * `payload->>'seriesMediaId'` (the reconciliation-backfill writer embeds the
 * series UUID there rather than in the dedicated column — see
 * episode-reconciliation.service.ts). Shared (via safe `sql` fragment
 * composition, never string interpolation) between the grouping,
 * bulk-resolve, and count helpers below so the alerting rule
 * (integrity-scanner.ts) and the triage UI always agree on what counts as
 * "one series".
 */
function effectiveSeriesIdFragment(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`COALESCE(expected_series_id, CASE WHEN payload->>'seriesMediaId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (payload->>'seriesMediaId')::uuid END)`;
}

/**
 * Hard cap on rows returned by list helpers, regardless of caller-supplied
 * `limit`. Protects the admin UI (and any other consumer) from accidentally
 * issuing a `LIMIT 999999` query that scans/serializes the whole table.
 */
const MAX_LIMIT = 1000;

export type QuarantineResolution = 'reattached' | 'dismissed' | 'recreated';

export interface QuarantineEntry {
    id: string;
    provider: string;
    externalId: string;
    mediaType: string;
    parentTmdbId: string | null;
    expectedSeriesId: string | null;
    payload: Record<string, unknown>;
    reason: string;
    source: string;
    createdAt: Date;
    resolvedAt: Date | null;
    resolvedBy: string | null;
    resolution: QuarantineResolution | null;
}

export interface QuarantineWrite {
    provider: string;
    externalId: string;
    mediaType: string;
    parentTmdbId?: string | null;
    expectedSeriesId?: string | null;
    payload: Record<string, unknown>;
    reason: string;
    source: string;
}

interface QuarantineRow {
    id: string;
    provider: string;
    external_id: string;
    media_type: string;
    parent_tmdb_id: string | null;
    expected_series_id: string | null;
    payload: Record<string, unknown>;
    reason: string;
    source: string;
    created_at: Date;
    resolved_at: Date | null;
    resolved_by: string | null;
    resolution: string | null;
}

function rowToEntry(row: QuarantineRow): QuarantineEntry {
    return {
        id: row.id,
        provider: row.provider,
        externalId: row.external_id,
        mediaType: row.media_type,
        parentTmdbId: row.parent_tmdb_id,
        expectedSeriesId: row.expected_series_id,
        payload: row.payload,
        reason: row.reason,
        source: row.source,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at,
        resolvedBy: row.resolved_by,
        resolution: row.resolution as QuarantineResolution | null,
    };
}

/**
 * Upsert a quarantine entry keyed on `(provider, external_id, media_type)`.
 * Returns the row's UUID (new or existing).
 *
 * If the same (provider, external_id, media_type) is re-quarantined, the prior
 * entry is resurrected (`resolved_at = NULL`) and re-stamped with the latest
 * reason/payload. An unresolved incident retains its first-seen timestamp;
 * reopening a resolved incident starts a new clock. This prevents the table
 * from growing linearly when hourly syncs present the same offending payload.
 *
 * Requires the UNIQUE index on (provider, external_id, media_type) created by
 * migration 12.65.0.
 */
export async function quarantineWrite(sql: postgres.Sql, entry: QuarantineWrite): Promise<string> {
    const rows = await sql<[{ id: string }]>`
        INSERT INTO sync_quarantine (
            provider,
            external_id,
            media_type,
            parent_tmdb_id,
            expected_series_id,
            payload,
            reason,
            source
        )
        VALUES (
            ${entry.provider},
            ${entry.externalId},
            ${entry.mediaType},
            ${entry.parentTmdbId ?? null},
            ${entry.expectedSeriesId ?? null},
            ${sql.json(entry.payload as Record<string, never>)},
            ${entry.reason},
            ${entry.source}
        )
        ON CONFLICT (provider, external_id, media_type) DO UPDATE
            SET reason      = EXCLUDED.reason,
                payload     = EXCLUDED.payload,
                expected_series_id = EXCLUDED.expected_series_id,
                parent_tmdb_id = EXCLUDED.parent_tmdb_id,
                source = EXCLUDED.source,
                created_at  = CASE WHEN sync_quarantine.resolved_at IS NULL
                                   THEN sync_quarantine.created_at ELSE NOW() END,
                resolved_at = NULL,
                resolved_by = NULL,
                resolution  = NULL
        WHERE NOT (
            sync_quarantine.resolved_at IS NOT NULL
            AND sync_quarantine.reason = EXCLUDED.reason AND sync_quarantine.payload = EXCLUDED.payload
            AND sync_quarantine.expected_series_id IS NOT DISTINCT FROM EXCLUDED.expected_series_id
            AND sync_quarantine.parent_tmdb_id IS NOT DISTINCT FROM EXCLUDED.parent_tmdb_id
            AND EXISTS (SELECT 1 FROM quarantine_dispositions d WHERE d.warning_id = sync_quarantine.id
                AND d.kind = 'hidden' AND d.restored_at IS NULL
                AND d.warning_version = sync_quarantine.xmin::text
                AND d.warning_hash = md5(to_jsonb(sync_quarantine)::text))
        )
        RETURNING id
    `;
    if (!rows[0]) {
        // DO UPDATE's WHERE kept the exact hidden revision. Return its stable key.
        const existing = await getQuarantineByKey(sql, entry);
        if (existing) return existing.id;
        throw new Error(
            `quarantineWrite: upsert returned no row for provider=${entry.provider} external_id=${entry.externalId}`,
        );
    }
    return rows[0].id;
}

/**
 * Fetch the quarantine entry for one (provider, externalId, mediaType) key,
 * resolved or not. The key is unique, so there is at most one.
 */
export async function getQuarantineByKey(
    sql: postgres.Sql,
    key: { provider: string; externalId: string; mediaType: string },
): Promise<QuarantineEntry | null> {
    const rows = await sql<QuarantineRow[]>`
        SELECT id, provider, external_id, media_type, parent_tmdb_id,
               expected_series_id, payload, reason, source,
               created_at, resolved_at, resolved_by, resolution
        FROM sync_quarantine
        WHERE provider    = ${key.provider}
          AND external_id = ${key.externalId}
          AND media_type  = ${key.mediaType}
        LIMIT 1
    `;
    return rows[0] ? rowToEntry(rows[0]) : null;
}

/**
 * Upsert an entry that is already resolved, keyed like `quarantineWrite`.
 * Used as a block marker: a detector that finds a resolved `dismissed` entry
 * for its pair does not propose or apply that pair again.
 */
export async function quarantineWriteResolved(
    sql: postgres.Sql,
    entry: QuarantineWrite,
    opts: { resolvedBy: string; resolution: QuarantineResolution },
): Promise<string> {
    const rows = await sql<[{ id: string }]>`
        INSERT INTO sync_quarantine (
            provider, external_id, media_type, parent_tmdb_id, expected_series_id,
            payload, reason, source, resolved_at, resolved_by, resolution
        )
        VALUES (
            ${entry.provider},
            ${entry.externalId},
            ${entry.mediaType},
            ${entry.parentTmdbId ?? null},
            ${entry.expectedSeriesId ?? null},
            ${sql.json(entry.payload as Record<string, never>)},
            ${entry.reason},
            ${entry.source},
            NOW(),
            ${opts.resolvedBy},
            ${opts.resolution}
        )
        ON CONFLICT (provider, external_id, media_type) DO UPDATE
            SET reason      = EXCLUDED.reason,
                payload     = EXCLUDED.payload,
                expected_series_id = EXCLUDED.expected_series_id,
                created_at  = NOW(),
                resolved_at = EXCLUDED.resolved_at,
                resolved_by = EXCLUDED.resolved_by,
                resolution  = EXCLUDED.resolution
        RETURNING id
    `;
    if (!rows[0]) {
        throw new Error(
            `quarantineWriteResolved: upsert returned no row for provider=${entry.provider} external_id=${entry.externalId}`,
        );
    }
    return rows[0].id;
}

/**
 * Resolve any unresolved quarantine entry matching the given
 * (provider, externalId, mediaType) triple. Returns the number of rows resolved
 * (0 if no matching unresolved entry exists — benign no-op).
 *
 * Used by sync paths to auto-close a quarantine entry when the condition that
 * caused the quarantine is later corrected (e.g. a Jellyfin episode that
 * previously had no TMDB-derived row is now matchable after TMDB catches up).
 */
export async function resolveByExternalKey(
    sql: postgres.Sql,
    key: { provider: string; externalId: string; mediaType: string },
    resolvedBy: string,
    resolution: 'reattached' | 'dismissed' | 'recreated',
): Promise<number> {
    const rows = await sql<{ id: string }[]>`
        UPDATE sync_quarantine
        SET resolved_at = NOW(),
            resolved_by = ${resolvedBy},
            resolution  = ${resolution}
        WHERE provider    = ${key.provider}
          AND external_id = ${key.externalId}
          AND media_type  = ${key.mediaType}
          AND resolved_at IS NULL
        RETURNING id
    `;
    return rows.length;
}

/**
 * List unresolved quarantine entries, newest first.
 *
 * `limit` is clamped to `[1, MAX_LIMIT]` so a malformed admin call cannot
 * spool the whole table.
 */
export async function listUnresolvedQuarantine(
    sql: postgres.Sql,
    limit = 100,
    offset = 0,
): Promise<QuarantineEntry[]> {
    const safeLimit = Math.max(1, Math.min(MAX_LIMIT, limit ?? 100));
    const safeOffset = Math.max(0, Math.floor(offset ?? 0));
    const rows = await sql<QuarantineRow[]>`
        SELECT id, provider, external_id, media_type, parent_tmdb_id,
               expected_series_id, payload, reason, source,
               created_at, resolved_at, resolved_by, resolution
        FROM sync_quarantine
        WHERE resolved_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}
    `;
    return rows.map(rowToEntry);
}

/**
 * List all quarantine entries (resolved + unresolved), newest first.
 * Used by admin UI for full audit history.
 *
 * `limit` is clamped to `[1, MAX_LIMIT]` so a malformed admin call cannot
 * spool the whole table.
 */
export async function listAllQuarantine(
    sql: postgres.Sql,
    limit = 100,
    offset = 0,
): Promise<QuarantineEntry[]> {
    const safeLimit = Math.max(1, Math.min(MAX_LIMIT, limit ?? 100));
    const rows = await sql<QuarantineRow[]>`
        SELECT id, provider, external_id, media_type, parent_tmdb_id,
               expected_series_id, payload, reason, source,
               created_at, resolved_at, resolved_by, resolution
        FROM sync_quarantine
        ORDER BY created_at DESC
        LIMIT ${safeLimit} OFFSET ${offset}
    `;
    return rows.map(rowToEntry);
}

/**
 * Fetch a single quarantine entry by id, or null if not found.
 */
export async function getQuarantineById(
    sql: postgres.Sql,
    id: string,
): Promise<QuarantineEntry | null> {
    const rows = await sql<QuarantineRow[]>`
        SELECT id, provider, external_id, media_type, parent_tmdb_id,
               expected_series_id, payload, reason, source,
               created_at, resolved_at, resolved_by, resolution
        FROM sync_quarantine
        WHERE id = ${id}
        LIMIT 1
    `;
    if (!rows[0]) return null;
    return rowToEntry(rows[0]);
}

/**
 * Mark a quarantine entry resolved. Stamps `resolved_at = NOW()`, the actor's
 * username, and a resolution verb.
 *
 * Idempotency: only updates rows where `resolved_at IS NULL`. Throws when no
 * row was updated — either because `id` does not exist or because the entry
 * was already resolved by another admin. The admin caller is expected to
 * catch + display the message (we don't silently no-op so we don't lose the
 * audit trail of who actually resolved it first).
 *
 * @throws {Error} when the row is missing or already resolved
 */
export async function resolveQuarantine(
    sql: postgres.Sql,
    id: string,
    opts: { resolvedBy: string; resolution: QuarantineResolution },
): Promise<void> {
    const rows = await sql<{ id: string }[]>`
        UPDATE sync_quarantine
        SET resolved_at = NOW(),
            resolved_by = ${opts.resolvedBy},
            resolution  = ${opts.resolution}
        WHERE id = ${id}
          AND resolved_at IS NULL
        RETURNING id
    `;
    if (rows.length === 0) {
        throw new Error('Quarantine entry already resolved or not found');
    }
}

/**
 * Count unresolved quarantine entries. Cheap badge query for admin nav.
 */
export async function countUnresolvedQuarantine(sql: postgres.Sql): Promise<number> {
    const [row] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count
        FROM sync_quarantine
        WHERE resolved_at IS NULL
    `;
    return parseInt(row?.count ?? '0', 10);
}

// ============================================================================
// Per-series grouping (bulk triage — /admin/library/quarantine)
// ============================================================================

/**
 * The series triage (grouping and "Dismiss all") leaves the reconciliation
 * services' rows alone. Their open rows are episode-move proposals with their
 * own Apply/Dismiss on the same page, and a bulk `dismissed` would block each
 * pair for good without anyone having looked at it.
 */
function notReconciliationProposalFragment(
    sql: postgres.Sql,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`provider <> ALL(${RECONCILIATION_BLOCK_PROVIDERS}::text[])`;
}

/**
 * Groups aggregate in PostgreSQL before serialization. No raw-row cap may
 * hide a later series or understate a group total.
 */

export interface QuarantineSeriesGroup {
    /** Effective series UUID (expected_series_id, or payload.seriesMediaId fallback), or null when neither is known. */
    seriesId: string | null;
    /** TMDB id of the series, when the series itself isn't resolvable (seriesId is null). */
    parentTmdbId: string | null;
    /** media_items.title for seriesId, when that row still exists. */
    seriesTitle: string | null;
    /** Total unresolved rows in this group. */
    totalUnresolved: number;
    fingerprint: string;
    /** Unresolved row count per `reason` string (e.g. "reconcile-backfill:below-threshold"). */
    reasonCounts: Record<string, number>;
    oldestCreatedAt: Date;
    newestCreatedAt: Date;
}

/** Groups and their hide authority come from the same complete statement snapshot. */
export async function listUnresolvedQuarantineBySeries(
    sql: postgres.Sql,
): Promise<QuarantineSeriesGroup[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only complete quarantine grouping and revision fence
    const rows = await sql<
        {
            series_id: string | null;
            parent_tmdb_id: string | null;
            series_title: string | null;
            total: number;
            reasons: Record<string, number>;
            oldest: Date;
            newest: Date;
            fingerprint: string;
        }[]
    >`
        WITH warnings AS MATERIALIZED (
            SELECT q.*, q.xmin::text AS version, to_jsonb(q)::text AS image,
                ${effectiveSeriesIdFragment(sql)} AS series_id
            FROM sync_quarantine q
            WHERE q.resolved_at IS NULL AND ${notReconciliationProposalFragment(sql)}
        ), grouped AS (
            SELECT COALESCE(series_id::text, 'tmdb:' || parent_tmdb_id, 'unknown') AS key,
                MAX(series_id::text)::uuid AS series_id, MAX(parent_tmdb_id) AS parent_tmdb_id,
                COUNT(*)::int AS total, MIN(created_at) AS oldest, MAX(created_at) AS newest,
                md5(string_agg(id::text || ':' || version || ':' || image, '|' ORDER BY id)) AS fingerprint
            FROM warnings GROUP BY 1
        ), reasons AS (
            SELECT key, jsonb_object_agg(reason, count) AS counts FROM (
                SELECT COALESCE(series_id::text, 'tmdb:' || parent_tmdb_id, 'unknown') AS key,
                    reason, COUNT(*)::int AS count FROM warnings GROUP BY 1, 2
            ) r GROUP BY key
        )
        SELECT g.*, mi.title AS series_title, reasons.counts AS reasons
        FROM grouped g JOIN reasons USING (key) LEFT JOIN media_items mi ON mi.id = g.series_id
        ORDER BY total DESC, oldest, key
    `;
    return rows.map((r) => ({
        seriesId: r.series_id,
        parentTmdbId: r.parent_tmdb_id,
        seriesTitle: r.series_title,
        totalUnresolved: r.total,
        reasonCounts: r.reasons,
        fingerprint: r.fingerprint,
        oldestCreatedAt: r.oldest,
        newestCreatedAt: r.newest,
    }));
}

/**
 * List unresolved quarantine entries belonging to one series (effective
 * series id — see `effectiveSeriesIdFragment`). Used by the "Accept all as
 * expected" bulk action to enumerate the episodes it should re-match, and by
 * the self-draining re-evaluation pass to check which rows a series re-match
 * actually resolved.
 */
export async function listUnresolvedQuarantineForSeries(
    sql: postgres.Sql,
    seriesId: string,
): Promise<QuarantineEntry[]> {
    const effectiveSeriesId = effectiveSeriesIdFragment(sql);
    const rows = await sql<QuarantineRow[]>`
        SELECT id, provider, external_id, media_type, parent_tmdb_id,
               expected_series_id, payload, reason, source,
               created_at, resolved_at, resolved_by, resolution
        FROM sync_quarantine
        WHERE resolved_at IS NULL
          AND ${effectiveSeriesId} = ${seriesId}
        ORDER BY created_at ASC
    `;
    return rows.map(rowToEntry);
}

/**
 * Bulk-resolve every unresolved quarantine row for one series (by effective
 * series id) or, when the series itself isn't resolvable, every row sharing a
 * `parent_tmdb_id` with no resolvable series (mirrors the grouping fallback in
 * `listUnresolvedQuarantineBySeries`). Returns the number of rows resolved.
 */
export async function bulkResolveQuarantineBySeries(
    sql: postgres.Sql,
    seriesKey: { seriesId: string } | { parentTmdbId: string },
    opts: { resolvedBy: string; resolution: QuarantineResolution },
): Promise<number> {
    if ('seriesId' in seriesKey) {
        const effectiveSeriesId = effectiveSeriesIdFragment(sql);
        const rows = await sql<{ id: string }[]>`
            UPDATE sync_quarantine
            SET resolved_at = NOW(),
                resolved_by = ${opts.resolvedBy},
                resolution  = ${opts.resolution}
            WHERE resolved_at IS NULL
              AND ${effectiveSeriesId} = ${seriesKey.seriesId}
              AND ${notReconciliationProposalFragment(sql)}
            RETURNING id
        `;
        return rows.length;
    }
    const effectiveSeriesId = effectiveSeriesIdFragment(sql);
    const rows = await sql<{ id: string }[]>`
        UPDATE sync_quarantine
        SET resolved_at = NOW(),
            resolved_by = ${opts.resolvedBy},
            resolution  = ${opts.resolution}
        WHERE resolved_at IS NULL
          AND ${effectiveSeriesId} IS NULL
          AND parent_tmdb_id = ${seriesKey.parentTmdbId}
          AND ${notReconciliationProposalFragment(sql)}
        RETURNING id
    `;
    return rows.length;
}

/**
 * Count DISTINCT series (effective series id, falling back to parent_tmdb_id,
 * falling back to a single "unknown" bucket) carrying at least one unresolved
 * actionable quarantine row. Reconciliation results without a proposal have
 * nothing to review; other writers' conflicts remain actionable without these
 * reconciliation-specific fields. Used by integrity-scanner's `quarantine-backlog-large` rule
 * so the alert reads as "N series need review" rather than a raw row count —
 * a single reconciliation-backfill run over one series can quarantine dozens
 * of rows, so raw-row thresholds trip permanently on backlogs that are
 * actually a handful of series.
 */
export async function countDistinctSeriesWithUnresolvedQuarantine(
    sql: postgres.Sql,
    olderThan?: Date,
): Promise<number> {
    const effectiveSeriesId = effectiveSeriesIdFragment(sql);
    const ageFilter = olderThan ? sql`AND created_at < ${olderThan}` : sql``;
    const [row] = await sql<[{ count: string }]>`
        SELECT COUNT(DISTINCT COALESCE(${effectiveSeriesId}::text, 'tmdb:' || parent_tmdb_id, 'unknown'))::text AS count
        FROM sync_quarantine
        WHERE resolved_at IS NULL
          AND (
              provider <> 'lumastra-reconcile'
              OR reason <> 'reconcile-backfill:below-threshold'
              OR NULLIF(BTRIM(payload->>'proposedTitle'), '') IS NOT NULL
              OR NULLIF(BTRIM(payload->>'matchedTmdbEpisodeId'), '') IS NOT NULL
          )
          ${ageFilter}
    `;
    return parseInt(row?.count ?? '0', 10);
}

/**
 * List unresolved quarantine entries written by one `provider` tag, oldest
 * first. Used by the reconciliation-backfill self-draining re-evaluation pass
 * to page through its own quarantine rows (provider = 'lumastra-reconcile')
 * without touching quarantine entries other subsystems (e.g. Jellyfin sync)
 * own.
 */
export async function listUnresolvedQuarantineByProvider(
    sql: postgres.Sql,
    provider: string,
    limit: number,
): Promise<QuarantineEntry[]> {
    const safeLimit = Math.max(1, Math.min(MAX_LIMIT, limit));
    const rows = await sql<QuarantineRow[]>`
        SELECT id, provider, external_id, media_type, parent_tmdb_id,
               expected_series_id, payload, reason, source,
               created_at, resolved_at, resolved_by, resolution
        FROM sync_quarantine
        WHERE resolved_at IS NULL
          AND provider = ${provider}
        ORDER BY created_at ASC
        LIMIT ${safeLimit}
    `;
    return rows.map(rowToEntry);
}

/**
 * Unresolved entries of one `provider` + `reason`, with the title of their
 * effective series, ordered by series title and then the episode's position
 * (`payload.fromSeason` / `fromEpisode` when present). `limit` is clamped to
 * `[1, MAX_LIMIT]`. Used by the per-row triage list of reconciliation proposals.
 */
export async function listUnresolvedQuarantineByReason(
    sql: postgres.Sql,
    opts: { provider: string; reason: string; seriesId?: string; limit: number },
): Promise<(QuarantineEntry & { seriesTitle: string | null })[]> {
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit)));
    const seriesFilter = opts.seriesId
        ? sql`AND ${effectiveSeriesIdFragment(sql)} = ${opts.seriesId}`
        : sql``;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only quarantine triage (library:admin-gated endpoint): the operator sees every series with unresolved sync decisions regardless of library/age visibility
    const rows = await sql<(QuarantineRow & { series_title: string | null })[]>`
        SELECT q.id, q.provider, q.external_id, q.media_type, q.parent_tmdb_id,
               q.expected_series_id, q.payload, q.reason, q.source,
               q.created_at, q.resolved_at, q.resolved_by, q.resolution,
               mi.title AS series_title
        FROM sync_quarantine q
        LEFT JOIN media_items mi ON mi.id = ${effectiveSeriesIdFragment(sql)}
        WHERE q.resolved_at IS NULL
          AND q.provider = ${opts.provider}
          AND q.reason = ${opts.reason}
          ${seriesFilter}
        ORDER BY mi.title NULLS LAST,
                 (q.payload->>'fromSeason')::int NULLS LAST,
                 (q.payload->>'fromEpisode')::int NULLS LAST,
                 q.created_at
        LIMIT ${limit}
    `;
    return rows.map((row) => ({ ...rowToEntry(row), seriesTitle: row.series_title }));
}

/** Exact DB row image, including PostgreSQL timestamp precision and the row's
 * transaction version. Never reconstruct this fence from a JavaScript Date.
 */
export interface QuarantineSnapshot extends QuarantineEntry {
    rowVersion: string;
    rowImage: Record<string, unknown>;
}

export async function listQuarantineSnapshots(
    sql: postgres.Sql,
    opts: {
        seriesId?: string;
        after?: string;
        limit: number;
        episodeIds?: string[];
        warningIds?: string[];
        includeResolved?: boolean;
    },
): Promise<QuarantineSnapshot[]> {
    const series = opts.seriesId
        ? sql`AND ${effectiveSeriesIdFragment(sql)} = ${opts.seriesId}`
        : sql``;
    const after = opts.after ? sql`AND id > ${opts.after}::uuid` : sql``;
    const subjects = opts.episodeIds
        ? sql`AND external_id = ANY(${opts.episodeIds}::text[]) AND media_type = 'episode'`
        : sql``;
    const warningIds = opts.warningIds ? sql`AND id = ANY(${opts.warningIds}::uuid[])` : sql``;
    const unresolved = opts.includeResolved ? sql`` : sql`AND resolved_at IS NULL`;
    const rows = await sql<
        (QuarantineRow & { row_version: string; row_image: Record<string, unknown> })[]
    >`
        SELECT q.*, q.xmin::text AS row_version, to_jsonb(q) AS row_image
        FROM sync_quarantine q
        WHERE provider = 'lumastra-reconcile' ${unresolved}
        ${series} ${after} ${subjects} ${warningIds}
        ORDER BY id
        LIMIT ${Math.max(1, Math.min(1001, Math.floor(opts.limit)))}
    `;
    return rows.map((r) => ({
        ...rowToEntry(r),
        rowVersion: r.row_version,
        rowImage: r.row_image,
    }));
}

/** Resolve only the complete warning that was examined, never a rewrite or
 * same-row revival. Caller holds its media evidence locks in this transaction.
 */
export async function resolveQuarantineSnapshot(
    sql: postgres.Sql,
    entry: QuarantineSnapshot,
    actor: string,
    resolution: QuarantineResolution = 'reattached',
): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        UPDATE sync_quarantine q SET resolved_at = NOW(), resolved_by = ${actor}, resolution = ${resolution}
        WHERE id = ${entry.id} AND resolved_at IS NULL AND xmin::text = ${entry.rowVersion}
          AND to_jsonb(q) = ${sql.json(entry.rowImage as Record<string, never>)}::jsonb
        RETURNING id
    `;
    return rows.length === 1;
}

/** Read the live subject and canonical ancestors for an exact current-match
 * acknowledgement. The caller validates every value against the historical
 * warning; this query deliberately does not infer identity from a file name. */
export interface QuarantineCurrentMatch {
    episodeId: string;
    title: string;
    titleBinding: string | null;
    episodeStatus: string;
    episodeLocked: boolean;
    episodeSeasonNumber: number | null;
    episodeNumber: number | null;
    seasonId: string | null;
    seasonStatus: string | null;
    seasonLocked: boolean | null;
    seasonNumber: number | null;
    seriesId: string | null;
    seriesStatus: string | null;
    seriesLocked: boolean | null;
    seriesTmdbId: string | null;
    episodeTmdbId: string | null;
    defaultFileCount: number;
}

export async function getQuarantineCurrentMatch(
    sql: postgres.Sql,
    episodeId: string,
): Promise<QuarantineCurrentMatch | null> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only exact UUID lookup for quarantine review
    const [row] = await sql<
        {
            episode_id: string;
            title: string;
            title_binding: string | null;
            episode_status: string;
            episode_locked: boolean;
            episode_season_number: number | null;
            episode_number: number | null;
            season_id: string | null;
            season_status: string | null;
            season_locked: boolean | null;
            season_number: number | null;
            series_id: string | null;
            series_status: string | null;
            series_locked: boolean | null;
            series_tmdb_id: string | null;
            episode_tmdb_id: string | null;
            default_file_count: number;
        }[]
    >`
        SELECT ep.id AS episode_id, ep.title, ep.title_binding,
               ep.status AS episode_status, ep.metadata_locked AS episode_locked,
               ep.season_number AS episode_season_number, ep.episode_number,
               season.id AS season_id, season.status AS season_status,
               season.metadata_locked AS season_locked, season.season_number,
               series.id AS series_id, series.status AS series_status,
               series.metadata_locked AS series_locked,
               (SELECT external_id FROM external_ids WHERE media_id = series.id
                 AND provider = 'tmdb' AND media_type = 'tv' LIMIT 1) AS series_tmdb_id,
               (SELECT external_id FROM external_ids WHERE media_id = ep.id
                 AND provider = 'tmdb' AND media_type = 'episode' LIMIT 1) AS episode_tmdb_id,
               (SELECT COUNT(*)::int FROM media_file_items mfi
                 JOIN media_files mf ON mf.id = mfi.file_id
                 WHERE mfi.media_item_id = ep.id AND mfi.is_default AND NOT mf.is_missing) AS default_file_count
        FROM media_items ep
        LEFT JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        LEFT JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
        WHERE ep.id = ${episodeId}::uuid AND ep.media_type = 'episode'
        LIMIT 1
    `;
    return row
        ? {
              episodeId: row.episode_id,
              title: row.title,
              titleBinding: row.title_binding,
              episodeStatus: row.episode_status,
              episodeLocked: row.episode_locked,
              episodeSeasonNumber: row.episode_season_number,
              episodeNumber: row.episode_number,
              seasonId: row.season_id,
              seasonStatus: row.season_status,
              seasonLocked: row.season_locked,
              seasonNumber: row.season_number,
              seriesId: row.series_id,
              seriesStatus: row.series_status,
              seriesLocked: row.series_locked,
              seriesTmdbId: row.series_tmdb_id,
              episodeTmdbId: row.episode_tmdb_id,
              defaultFileCount: row.default_file_count,
          }
        : null;
}

/** Compare-and-write a captured warning, including absence. A concurrent writer
 * wins: neither a rewrite nor a resolved/revived row may be overwritten.
 */
export async function writeQuarantineSnapshot(
    sql: postgres.Sql,
    entry: QuarantineWrite,
    previous?: QuarantineSnapshot,
): Promise<boolean | 'hidden'> {
    if (previous) {
        // An unchanged explicitly hidden warning is a durable disposition, not a
        // new incident. Changed evidence/payload may reopen it as usual.
        const [hidden] = await sql<{ kept: boolean }[]>`
            SELECT true AS kept FROM sync_quarantine q JOIN quarantine_dispositions d ON d.warning_id = q.id
            WHERE q.id = ${previous.id} AND q.resolved_at IS NOT NULL AND d.kind = 'hidden'
                AND d.restored_at IS NULL AND d.warning_version = q.xmin::text AND d.warning_hash = md5(to_jsonb(q)::text)
                AND q.xmin::text = ${previous.rowVersion} AND to_jsonb(q) = ${sql.json(previous.rowImage as Record<string, never>)}::jsonb
                AND q.reason = ${entry.reason} AND q.payload = ${sql.json(entry.payload as Record<string, never>)}::jsonb
                AND q.expected_series_id IS NOT DISTINCT FROM ${entry.expectedSeriesId ?? null}::uuid
                AND q.parent_tmdb_id IS NOT DISTINCT FROM ${entry.parentTmdbId ?? null}::text LIMIT 1
        `;
        if (hidden) return 'hidden';
        const rows = await sql<{ id: string }[]>`
            UPDATE sync_quarantine q SET reason = ${entry.reason}, payload = ${sql.json(entry.payload as Record<string, never>)},
                expected_series_id = ${entry.expectedSeriesId ?? null}, parent_tmdb_id = ${entry.parentTmdbId ?? null},
                source = ${entry.source},
                created_at = CASE WHEN q.resolved_at IS NULL THEN q.created_at ELSE NOW() END,
                resolved_at = NULL, resolved_by = NULL, resolution = NULL
            WHERE q.id = ${previous.id} AND q.xmin::text = ${previous.rowVersion}
              AND to_jsonb(q) = ${sql.json(previous.rowImage as Record<string, never>)}::jsonb
            RETURNING id
        `;
        return rows.length === 1;
    }
    const rows = await sql<{ id: string }[]>`
        INSERT INTO sync_quarantine (provider, external_id, media_type, parent_tmdb_id, expected_series_id, payload, reason, source)
        VALUES (${entry.provider}, ${entry.externalId}, ${entry.mediaType}, ${entry.parentTmdbId ?? null},
            ${entry.expectedSeriesId ?? null}, ${sql.json(entry.payload as Record<string, never>)}, ${entry.reason}, ${entry.source})
        ON CONFLICT (provider, external_id, media_type) DO NOTHING RETURNING id
    `;
    return rows.length === 1;
}

/** Lock and validate the exact page, including retained seeds and dependencies.
 * Call after media locks and before any mutation in the same transaction.
 */
export async function lockQuarantineSnapshots(
    sql: postgres.Sql,
    entries: QuarantineSnapshot[],
): Promise<boolean> {
    const unique = [...new Map(entries.map((entry) => [entry.id, entry])).values()];
    if (unique.length === 0) return true;
    await sql`SELECT id FROM sync_quarantine WHERE id = ANY(${unique.map((entry) => entry.id)}::uuid[]) ORDER BY id FOR UPDATE`;
    const expected = unique.map((entry) => ({
        id: entry.id,
        version: entry.rowVersion,
        image: entry.rowImage,
    }));
    const [row] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM sync_quarantine q
        JOIN jsonb_to_recordset(${sql.json(expected as never)}::jsonb)
            AS expected(id uuid, version text, image jsonb) ON expected.id = q.id
        WHERE q.resolved_at IS NULL AND q.xmin::text = expected.version AND to_jsonb(q) = expected.image
    `;
    return row.count === unique.length;
}

function quarantineGroupFilter(
    sql: postgres.Sql,
    group: string,
): postgres.PendingQuery<postgres.Row[]> {
    return UUID_RE.test(group)
        ? sql`${effectiveSeriesIdFragment(sql)} = ${group}::uuid`
        : group.startsWith('tmdb:')
          ? sql`${effectiveSeriesIdFragment(sql)} IS NULL AND parent_tmdb_id = ${group.slice(5)}`
          : sql`${effectiveSeriesIdFragment(sql)} IS NULL AND parent_tmdb_id IS NULL`;
}

/** Same group identity and proposal exclusion as the group table. UUID keyset
 * traversal stays reachable when earlier warnings are resolved between pages.
 * Count and bounded rows share one PostgreSQL statement snapshot. */
export async function listQuarantineInspectionSnapshots(
    sql: postgres.Sql,
    group: string,
    opts: { after?: string; limit: number },
): Promise<{ entries: QuarantineSnapshot[]; total: number }> {
    const filter = quarantineGroupFilter(sql, group);
    const after = opts.after ? sql`AND id > ${opts.after}::uuid` : sql``;
    const rows = await sql<
        (QuarantineRow & {
            row_version: string;
            row_image: Record<string, unknown>;
            total: number;
        })[]
    >`
        WITH grouped AS MATERIALIZED (
            SELECT q.*, q.xmin::text AS row_version, to_jsonb(q) AS row_image
            FROM sync_quarantine q
            WHERE resolved_at IS NULL AND ${filter} AND ${notReconciliationProposalFragment(sql)}
        ), bounded AS (
            SELECT * FROM grouped WHERE true ${after} ORDER BY id LIMIT ${opts.limit}
        )
        SELECT bounded.*, totals.total FROM (SELECT COUNT(*)::int AS total FROM grouped) totals
        LEFT JOIN bounded ON true ORDER BY bounded.id
    `;
    return {
        total: rows[0]?.total ?? 0,
        entries: rows
            .filter((r) => r.id)
            .map((r) => ({ ...rowToEntry(r), rowVersion: r.row_version, rowImage: r.row_image })),
    };
}

export async function getQuarantineSnapshot(
    sql: postgres.Sql,
    id: string,
): Promise<QuarantineSnapshot | null> {
    const [row] = await sql<
        (QuarantineRow & { row_version: string; row_image: Record<string, unknown> })[]
    >`
        SELECT q.*, q.xmin::text AS row_version, to_jsonb(q) AS row_image FROM sync_quarantine q WHERE id = ${id}
    `;
    return row
        ? { ...rowToEntry(row), rowVersion: row.row_version, rowImage: row.row_image }
        : null;
}

export interface QuarantineCurrentSubject {
    id: string;
    title: string;
    mediaType: string;
    status: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    seriesId: string | null;
    seriesTitle: string | null;
    fileCount: number;
    detailAvailable: boolean;
}

/** Interpret the writer's key contract, never a proposed/payload identity.
 * Jellyfin synthetic missing-child keys cannot identify a current subject. */
export async function getQuarantineCurrentSubject(
    sql: postgres.Sql,
    entry: QuarantineEntry,
): Promise<{ current: QuarantineCurrentSubject | null; evidence: unknown }> {
    const internal =
        entry.provider === 'lumastra-reconcile' &&
        entry.mediaType === 'episode' &&
        UUID_RE.test(entry.externalId);
    const external =
        entry.provider === 'jellyfin' &&
        !entry.externalId.includes('#') &&
        ['tv', 'season', 'episode'].includes(entry.mediaType);
    if (!internal && !external) return { current: null, evidence: null };
    const key = internal
        ? sql`mi.id = ${entry.externalId}::uuid AND mi.media_type = 'episode'`
        : sql`mi.media_type = ${entry.mediaType} AND EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.provider = ${entry.provider} AND ei.media_type = ${entry.mediaType} AND ei.external_id = ${entry.externalId})`;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only current quarantine subject inspection, resolved by the writer's typed key
    const [row] = await sql<
        {
            id: string;
            title: string;
            media_type: string;
            status: string;
            season_number: number | null;
            episode_number: number | null;
            series_id: string | null;
            series_title: string | null;
            file_count: number;
            evidence: unknown;
        }[]
    >`
        SELECT mi.id, mi.title, mi.media_type, mi.status, mi.season_number, mi.episode_number,
               series.id AS series_id, series.title AS series_title,
               (SELECT COUNT(*)::int FROM media_file_items mfi JOIN media_files mf ON mf.id = mfi.file_id WHERE mfi.media_item_id = mi.id) AS file_count,
               jsonb_build_array(to_jsonb(mi), mi.xmin::text, to_jsonb(parent), parent.xmin::text, to_jsonb(series), series.xmin::text,
                   (SELECT jsonb_agg(to_jsonb(mfi) || jsonb_build_object('file', to_jsonb(mf), 'linkVersion', mfi.xmin::text, 'fileVersion', mf.xmin::text) ORDER BY mfi.file_id)
                    FROM media_file_items mfi JOIN media_files mf ON mf.id = mfi.file_id WHERE mfi.media_item_id = mi.id),
                   (SELECT jsonb_agg(jsonb_build_array(to_jsonb(ei), ei.xmin::text) ORDER BY ei.provider, ei.media_type, ei.external_id) FROM external_ids ei WHERE ei.media_id = mi.id)) AS evidence
        FROM media_items mi
        LEFT JOIN media_items parent ON parent.id = mi.parent_id
        LEFT JOIN media_items series ON series.id = CASE WHEN mi.media_type = 'tv' THEN mi.id WHEN mi.media_type = 'season' THEN parent.id WHEN parent.media_type = 'season' THEN parent.parent_id END AND series.media_type = 'tv'
        WHERE ${key}
    `;
    return row
        ? {
              current: {
                  id: row.id,
                  title: row.title,
                  mediaType: row.media_type,
                  status: row.status,
                  seasonNumber: row.season_number,
                  episodeNumber: row.episode_number,
                  seriesId: row.series_id,
                  seriesTitle: row.series_title,
                  fileCount: row.file_count,
                  detailAvailable: row.media_type === 'tv' || row.series_id !== null,
              },
              evidence: row.evidence,
          }
        : { current: null, evidence: null };
}

/** Keep the inspected current rows stable until deliberate rejection commits.
 * This does not authorize any media write. Lock media before the warning. NOWAIT refuses contention instead of introducing a lock-order cycle; parent UPDATE locks also fence new FK-linked rows. */
export async function lockQuarantineCurrentSubject(sql: postgres.Sql, id: string): Promise<void> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- explicit admin-inspected subject and ancestors, locked only to guard warning rejection
    await sql`SELECT id FROM media_items WHERE id IN (
        SELECT id FROM media_items WHERE id = ${id}::uuid
        UNION SELECT parent_id FROM media_items WHERE id = ${id}::uuid
        UNION SELECT parent.parent_id FROM media_items subject JOIN media_items parent ON parent.id = subject.parent_id WHERE subject.id = ${id}::uuid
    ) ORDER BY id FOR UPDATE NOWAIT`;
    await sql`SELECT media_id FROM external_ids WHERE media_id=${id}::uuid ORDER BY provider,media_type FOR UPDATE NOWAIT`;
    await sql`SELECT id FROM media_files WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id=${id}::uuid) ORDER BY id FOR UPDATE NOWAIT`;
    await sql`SELECT file_id FROM media_file_items WHERE media_item_id=${id}::uuid ORDER BY file_id FOR UPDATE NOWAIT`;
}

/** Preview links are independent of warning eligibility: emit only current,
 * active episode rows with a navigable season/series hierarchy. Malformed,
 * deleted and fileless-but-broken subjects never gain a guessed detail link. */
export async function listNavigableQuarantineEpisodes(
    sql: postgres.Sql,
    ids: string[],
): Promise<string[]> {
    const validIds = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
    if (validIds.length === 0) return [];
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only bounded current-subject existence/navigability projection for quarantine preview links
    const rows = await sql<{ id: string }[]>`
        SELECT ep.id FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season' AND season.status = 'active'
        JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv' AND series.status = 'active'
        WHERE ep.id = ANY(${validIds}::uuid[]) AND ep.media_type = 'episode' AND ep.status = 'active'
        ORDER BY ep.id
    `;
    return rows.map((row) => row.id);
}

export type QuarantineDispositionKind =
    'hidden' | 'no-proposal' | 'completed' | 'superseded' | 'gone';

/** One statement: a stale snapshot can neither close a warning nor mint a receipt.
 * The hash retains PostgreSQL precision; xmin also refuses same-value rewrites/revivals.
 * Callers retain their existing media-evidence locks. Hiding never changes media or blocks an identity.
 */
export async function archiveQuarantineSnapshot(
    sql: postgres.Sql,
    entry: QuarantineSnapshot,
    actor: string,
    kind: QuarantineDispositionKind,
    resolution: QuarantineResolution = 'dismissed',
    batchId: string = randomUUID(),
): Promise<boolean> {
    const rows = await sql<{ warning_id: string }[]>`
        WITH changed AS (
            UPDATE sync_quarantine q SET resolved_at = NOW(), resolved_by = ${actor}, resolution = ${resolution}
            WHERE id = ${entry.id} AND resolved_at IS NULL AND xmin::text = ${entry.rowVersion}
              AND to_jsonb(q) = ${sql.json(entry.rowImage as Record<string, never>)}::jsonb
              AND (${kind} = 'hidden' OR NOT EXISTS (SELECT 1 FROM quarantine_dispositions d
                  WHERE d.warning_id = q.id AND d.restored_version = q.xmin::text
                    AND d.restored_hash = md5(to_jsonb(q)::text)))
            RETURNING q.id, q.xmin::text AS version, md5(to_jsonb(q)::text) AS hash
        )
        INSERT INTO quarantine_dispositions (batch_id, warning_id, previous_version, previous_warning, warning_version, warning_hash, kind, actor)
        SELECT ${batchId}::uuid, id, ${entry.rowVersion}, ${sql.json(entry.rowImage as Record<string, never>)}::jsonb, version, hash, ${kind}, ${actor} FROM changed RETURNING warning_id
    `;
    return rows.length === 1;
}

/** Hide exactly the complete group revision shown in the list. The materialized
 * snapshot and version join prevent a concurrent rewrite from being hidden.
 * The service verifies the returned count and rolls the entire batch back on contention.
 */
export async function hideQuarantineGroupSnapshot(
    sql: postgres.Sql,
    group: string,
    fingerprint: string,
    actor: string,
    batchId: string,
): Promise<{ expected: number; resolved: number }> {
    const [row] = await sql<{ expected: number; resolved: number }[]>`
        WITH snapshot AS MATERIALIZED (
            SELECT q.id, q.xmin::text AS version, to_jsonb(q)::text AS image FROM sync_quarantine q
            WHERE resolved_at IS NULL AND ${quarantineGroupFilter(sql, group)} AND ${notReconciliationProposalFragment(sql)}
        ), authority AS (
            SELECT COUNT(*)::int AS expected,
                md5(string_agg(id::text || ':' || version || ':' || image, '|' ORDER BY id)) AS fingerprint
            FROM snapshot
        ), changed AS (
            UPDATE sync_quarantine q SET resolved_at = NOW(), resolved_by = ${actor}, resolution = 'dismissed'
            FROM snapshot, authority
            WHERE q.id = snapshot.id AND q.xmin::text = snapshot.version AND q.resolved_at IS NULL
                AND authority.fingerprint = ${fingerprint}
            RETURNING q.id, q.xmin::text AS version, md5(to_jsonb(q)::text) AS hash, snapshot.version AS previous_version, snapshot.image::jsonb AS previous_warning
        ), receipts AS (
            INSERT INTO quarantine_dispositions (batch_id, warning_id, previous_version, previous_warning, warning_version, warning_hash, kind, actor)
            SELECT ${batchId}::uuid, id, previous_version, previous_warning, version, hash, 'hidden', ${actor} FROM changed RETURNING warning_id
        )
        SELECT authority.expected, (SELECT COUNT(*)::int FROM receipts) AS resolved FROM authority
    `;
    return row;
}

/** Only receipts from this original batch authorize restoration. Keyset pagination
 * caps large restores; a stale row is reported and cannot alter a newer warning.
 */
export async function restoreQuarantineDispositionBatch(
    sql: postgres.Sql,
    batchId: string,
    after?: string,
): Promise<{ restored: number; changed: number; continuation?: string }> {
    const cursor = after ? sql`AND warning_id > ${after}::uuid` : sql``;
    const rows = await sql<
        {
            warning_id: string;
            warning_version: string;
            warning_hash: string;
            previous_warning: Record<string, unknown>;
        }[]
    >`
        SELECT warning_id, warning_version, warning_hash, previous_warning FROM quarantine_dispositions
        WHERE batch_id = ${batchId}::uuid AND restored_at IS NULL ${cursor}
        ORDER BY warning_id LIMIT 1001 FOR UPDATE
    `;
    const page = rows.slice(0, 1000);
    if (page.length === 0) return { restored: 0, changed: 0 };
    const restored = await sql<{ id: string; version: string; hash: string }[]>`
        UPDATE sync_quarantine q SET resolved_at = (receipt.previous_warning->>'resolved_at')::timestamptz,
            resolved_by = receipt.previous_warning->>'resolved_by', resolution = receipt.previous_warning->>'resolution'
        FROM jsonb_to_recordset(${sql.json(page as never)}::jsonb)
            AS receipt(warning_id uuid, warning_version text, warning_hash text, previous_warning jsonb)
        WHERE q.id = receipt.warning_id AND q.resolved_at IS NOT NULL
            AND q.xmin::text = receipt.warning_version AND md5(to_jsonb(q)::text) = receipt.warning_hash
        RETURNING q.id, q.xmin::text AS version, md5(to_jsonb(q)::text) AS hash
    `;
    await sql`UPDATE quarantine_dispositions d SET restored_at = NOW(), restored_version = r.version, restored_hash = r.hash
        FROM jsonb_to_recordset(${sql.json(restored as never)}::jsonb) AS r(id uuid, version text, hash text)
        WHERE d.batch_id = ${batchId}::uuid AND d.warning_id = r.id`;
    return {
        restored: restored.length,
        changed: page.length - restored.length,
        ...(rows.length > 1000 ? { continuation: page[page.length - 1].warning_id } : {}),
    };
}

export interface QuarantineDispositionHistory {
    batchId: string;
    kind: QuarantineDispositionKind;
    actor: string;
    createdAt: string;
    count: number;
    restorable: number;
    seriesTitle: string | null;
}

/** Stable history pagination includes exhausted/stale receipts. A changed warning
 * never inherits restoration authority from an older history entry. */
export async function listQuarantineDispositionHistory(
    sql: postgres.Sql,
    after?: string,
): Promise<{ items: QuarantineDispositionHistory[]; continuation?: string }> {
    const cursor = after
        ? sql`WHERE (created_at, batch_id) < (
        SELECT MIN(created_at), batch_id FROM quarantine_dispositions WHERE batch_id = ${after}::uuid GROUP BY batch_id
    )`
        : sql``;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only warning history label, never a catalog discovery query
    const rows = await sql<
        {
            batch_id: string;
            kind: QuarantineDispositionKind;
            actor: string;
            created_at: Date;
            count: number;
            restorable: number;
            series_title: string | null;
        }[]
    >`
        WITH batches AS (
            SELECT batch_id, MIN(kind) AS kind, MIN(actor) AS actor, MIN(created_at) AS created_at,
                COUNT(*)::int AS count FROM quarantine_dispositions GROUP BY batch_id
        ), page AS (SELECT * FROM batches ${cursor} ORDER BY created_at DESC, batch_id DESC LIMIT 26)
        SELECT page.*, COUNT(*) FILTER (WHERE d.restored_at IS NULL AND q.resolved_at IS NOT NULL
            AND q.xmin::text = d.warning_version AND md5(to_jsonb(q)::text) = d.warning_hash)::int AS restorable,
            MAX(mi.title) AS series_title
        FROM page JOIN quarantine_dispositions d USING (batch_id) JOIN sync_quarantine q ON q.id = d.warning_id
        LEFT JOIN media_items mi ON mi.id = COALESCE((d.previous_warning->>'expected_series_id')::uuid,
            CASE WHEN d.previous_warning #>> '{payload,seriesMediaId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (d.previous_warning #>> '{payload,seriesMediaId}')::uuid END)
        GROUP BY page.batch_id, page.kind, page.actor, page.created_at, page.count
        ORDER BY page.created_at DESC, page.batch_id DESC
    `;
    return {
        items: rows.slice(0, 25).map((r) => ({
            batchId: r.batch_id,
            kind: r.kind,
            actor: r.actor,
            createdAt: r.created_at.toISOString(),
            count: r.count,
            restorable: r.restorable,
            seriesTitle: r.series_title,
        })),
        ...(rows.length > 25 ? { continuation: rows[24].batch_id } : {}),
    };
}
