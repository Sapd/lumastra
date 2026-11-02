// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * watch_sync_activity — per-user recent watch-sync activity feed.
 * Pure SQL; `sql` is always the first parameter. Best-effort at the call site.
 */
import type postgres from 'postgres';

export type SyncDirection = 'push' | 'pull';
export type SyncOutcome = 'success' | 'failed' | 'skipped';

export interface SyncActivityInsert {
    userId: string;
    provider: string;
    direction: SyncDirection;
    outcome: SyncOutcome;
    terminal?: boolean;
    mediaId?: string | null;
    title?: string | null;
    /** Parent series title (episodes only) — null/undefined for movies and other providers. */
    seriesTitle?: string | null;
    /** Season number (episodes only) — null/undefined for movies and other providers. */
    seasonNumber?: number | null;
    /** Episode number (episodes only) — null/undefined for movies and other providers. */
    episodeNumber?: number | null;
    mediaType?: string | null;
    eventKind?: string | null;
    externalRef?: string | null;
    error?: string | null;
}

export interface SyncActivityRow {
    direction: SyncDirection;
    outcome: SyncOutcome;
    terminal: boolean;
    title: string | null;
    seriesTitle: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    mediaType: string | null;
    eventKind: string | null;
    externalRef: string | null;
    error: string | null;
    occurredAt: string;
}

const clip = (s: string | null | undefined): string | null => (s == null ? null : s.slice(0, 500));

const ACTIVITY_COLUMNS = [
    'user_id',
    'provider',
    'direction',
    'outcome',
    'terminal',
    'media_id',
    'title',
    'series_title',
    'season_number',
    'episode_number',
    'media_type',
    'event_kind',
    'external_ref',
    'error',
] as const;

interface ActivityValues {
    user_id: string;
    provider: string;
    direction: SyncDirection;
    outcome: SyncOutcome;
    terminal: boolean;
    media_id: string | null;
    title: string | null;
    series_title: string | null;
    season_number: number | null;
    episode_number: number | null;
    media_type: string | null;
    event_kind: string | null;
    external_ref: string | null;
    error: string | null;
}

const toValues = (r: SyncActivityInsert): ActivityValues => ({
    user_id: r.userId,
    provider: r.provider,
    direction: r.direction,
    outcome: r.outcome,
    terminal: r.terminal ?? false,
    media_id: r.mediaId ?? null,
    title: clip(r.title),
    series_title: clip(r.seriesTitle),
    season_number: r.seasonNumber ?? null,
    episode_number: r.episodeNumber ?? null,
    media_type: r.mediaType ?? null,
    event_kind: r.eventKind ?? null,
    external_ref: clip(r.externalRef),
    error: clip(r.error),
});

/**
 * A row is "recurring" — re-emitted every full-resync cycle — iff it is a
 * `skipped` row OR a non-terminal `failed` row. These must dedup (UPSERT
 * against the partial unique index) instead of piling up. Successes and
 * terminal give-ups are discrete events and are plain appends.
 */
const isRecurring = (r: SyncActivityInsert): boolean =>
    r.outcome === 'skipped' || (r.outcome === 'failed' && (r.terminal ?? false) === false);

/** Conflict-target key mirroring COALESCE(media_id::text, external_ref, ''). */
const conflictKey = (r: SyncActivityInsert): string =>
    `${r.userId}|${r.provider}|${r.mediaId ?? r.externalRef ?? ''}`;

/** Batch-insert activity rows. No-op on empty input. Chunked to stay under
 *  Postgres's ~65535 bound-parameter limit on large batches. Non-recurring
 *  rows (successes, terminal give-ups) are plain appends; recurring rows
 *  (skipped / transient-failed) UPSERT so a full re-sync every cycle refreshes
 *  the existing row instead of duplicating it. */
export async function recordSyncActivity(
    sql: postgres.Sql,
    rows: SyncActivityInsert[],
): Promise<void> {
    if (rows.length === 0) return;
    const CHUNK = 500;

    const appendRows: SyncActivityInsert[] = [];
    const recurringRows: SyncActivityInsert[] = [];
    for (const r of rows) {
        if (isRecurring(r)) recurringRows.push(r);
        else appendRows.push(r);
    }

    // Plain chunked INSERT for discrete events.
    for (let start = 0; start < appendRows.length; start += CHUNK) {
        const values = appendRows.slice(start, start + CHUNK).map(toValues);
        await sql`
            INSERT INTO watch_sync_activity ${sql(values, ...ACTIVITY_COLUMNS)}
        `;
    }

    // Recurring rows UPSERT. A single INSERT statement cannot touch the same
    // conflict row twice, so dedup within this batch first — keep the LAST
    // occurrence per conflict key.
    if (recurringRows.length > 0) {
        const dedup = new Map<string, SyncActivityInsert>();
        for (const r of recurringRows) dedup.set(conflictKey(r), r);
        const deduped = [...dedup.values()];
        for (let start = 0; start < deduped.length; start += CHUNK) {
            const values = deduped.slice(start, start + CHUNK).map(toValues);
            await sql`
                INSERT INTO watch_sync_activity ${sql(values, ...ACTIVITY_COLUMNS)}
                ON CONFLICT (user_id, provider, (COALESCE(media_id::text, external_ref, '')))
                WHERE outcome = 'skipped' OR (outcome = 'failed' AND terminal = false)
                DO UPDATE SET
                    occurred_at = now(),
                    error = EXCLUDED.error,
                    title = EXCLUDED.title,
                    series_title = EXCLUDED.series_title,
                    season_number = EXCLUDED.season_number,
                    episode_number = EXCLUDED.episode_number,
                    media_type = EXCLUDED.media_type,
                    event_kind = EXCLUDED.event_kind,
                    direction = EXCLUDED.direction
            `;
        }
    }
}

/** Newest-first (by id) activity for a user+provider. */
export async function getSyncActivity(
    sql: postgres.Sql,
    opts: { userId: string; provider: string; limit: number },
): Promise<SyncActivityRow[]> {
    const safeLimit = Math.min(Math.max(1, Math.trunc(Number(opts.limit) || 0)), 200);
    const rows = await sql<
        {
            direction: SyncDirection;
            outcome: SyncOutcome;
            terminal: boolean;
            title: string | null;
            series_title: string | null;
            season_number: number | null;
            episode_number: number | null;
            media_type: string | null;
            event_kind: string | null;
            external_ref: string | null;
            error: string | null;
            occurred_at: Date;
        }[]
    >`
        SELECT direction, outcome, terminal, title, series_title, season_number, episode_number, media_type, event_kind, external_ref, error, occurred_at
        FROM watch_sync_activity
        WHERE user_id = ${opts.userId}::uuid AND provider = ${opts.provider}
          -- Hide "not applicable to this provider" rows from the user feed. Both
          -- are un-actionable and just crowd out real activity:
          --  • pull "no library match": the provider reported a play for an item
          --    not in the user's Lumastra library (e.g. a raw file in Jellyfin only).
          --  • push "no provider id (gave up)": the item couldn't map to the provider
          --    — for MAL this is every NON-anime item the user watched (the anime
          --    filter correctly drops it before any API call), plus anime not on MAL.
          -- Still recorded (diagnostic), just not surfaced here.
          AND NOT (
              (outcome = 'skipped' AND error = 'no library match')
              OR (outcome = 'failed' AND error = 'no provider id (gave up)')
          )
        ORDER BY id DESC
        LIMIT ${safeLimit}
    `;
    return rows.map((r) => ({
        direction: r.direction,
        outcome: r.outcome,
        terminal: r.terminal,
        title: r.title,
        seriesTitle: r.series_title,
        seasonNumber: r.season_number,
        episodeNumber: r.episode_number,
        mediaType: r.media_type,
        eventKind: r.event_kind,
        externalRef: r.external_ref,
        error: r.error,
        occurredAt: r.occurred_at.toISOString(),
    }));
}

/**
 * Keep the newest `keepPerClass` rows per (user_id, provider, outcome), so
 * success/failed/skipped each retain their own newest slice — a skip burst
 * from a full re-sync can never evict diagnostic failed rows (and vice versa).
 * Returns the number of rows deleted.
 */
export async function pruneSyncActivity(sql: postgres.Sql, keepPerClass = 50): Promise<number> {
    const rows = await sql<{ n: string }[]>`
        WITH ranked AS (
            SELECT id, row_number() OVER (
                PARTITION BY user_id, provider, outcome
                ORDER BY id DESC
            ) AS rn
            FROM watch_sync_activity
        ), deleted AS (
            DELETE FROM watch_sync_activity a
            USING ranked
            WHERE a.id = ranked.id AND ranked.rn > ${keepPerClass}
            RETURNING a.id
        )
        SELECT count(*)::text AS n FROM deleted
    `;
    return Number(rows[0]?.n ?? 0);
}
