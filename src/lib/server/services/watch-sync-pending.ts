// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure planning logic for the watch-sync "pending resolution" buffer.
 *
 * The bug this fixes: when a watch-state pull (e.g. from Jellyfin) reports a
 * movie/episode that has NOT been ingested into the catalog yet, the engine
 * could not resolve it to an internal media UUID and **dropped it** — and the
 * per-user pull cursor advanced past its play date, so a later pull would never
 * re-fetch it. Watch history for media imported after the watch event was lost
 * permanently.
 *
 * The fix buffers every unresolved pull item in `watch_state_pending_resolution`
 * instead of dropping it, then re-resolves the buffer each drain cycle (and on
 * ingest). Once the matching media_item exists, the buffered watch state is
 * imported and the buffer row deleted.
 *
 * This module holds only the PURE decisions — mapping an unresolved pull item to
 * a buffer row, and partitioning a loaded buffer into import / delete / bump /
 * drop — so they are unit-testable without a database. The SQL glue lives in
 * `watch-state-pending.queries.ts` and the drain orchestration in
 * `watch-sync-pending-drain.service.ts`.
 */

import type { WatchStatePullItem } from '@sapd/lumastra-plugin-sdk';
import type { EventSource } from '../database/queries/user-media-events.queries.js';

/**
 * Map a watch-sync provider name to the `user_media_events` source it records.
 * Single source of truth shared by the live pull (watch-sync-engine) and the
 * pending-resolution drain so a new provider can't be wired into one path but
 * silently dropped by the other. Returns null for an unmapped provider; callers
 * decide policy (the engine throws, the drain skips with a warning).
 */
export function eventSourceForProvider(provider: string): EventSource | null {
    const p = provider.toLowerCase();
    if (p.includes('jellyfin')) return 'jellyfin-sync';
    if (p.includes('plex')) return 'plex-sync';
    // Before the `mal` arm: these are substring tests, so any future provider
    // whose name contains an earlier token would be silently mis-attributed to
    // it and write events under the wrong source.
    if (p.includes('audiobookshelf')) return 'audiobookshelf-sync';
    if (p.includes('mal')) return 'mal-sync';
    if (p.includes('trakt')) return 'trakt-sync';
    return null;
}

/**
 * One stable event key per imported play, bounded against corrupt provider counts.
 * Keep the first dated key compatible with imports written before count support;
 * subsequent plays use an index. Undated snapshots share a stable fallback key.
 */
export function importedWatchEventIds(watchCount: number, lastWatchedAt: Date | null): string[] {
    const count = Number.isFinite(watchCount)
        ? Math.max(1, Math.min(100, Math.floor(watchCount)))
        : 1;
    const base = `mark_watched:${lastWatchedAt?.toISOString() ?? 'unknown'}`;
    return Array.from({ length: count }, (_, i) => (i === 0 ? base : `${base}:${i}`));
}

/**
 * How long an unresolved row may sit in the buffer before it is given up on and
 * dropped. Bounds table growth from items that will never match this install
 * (watched on a different/again-removed library, a server the user no longer
 * syncs, etc.). Generous so a slow initial library scan never loses real
 * history: 90 days.
 */
export const PENDING_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** A row read back from `watch_state_pending_resolution`. */
export interface PendingResolutionRow {
    id: number;
    user_id: string;
    provider: string;
    media_type: string;
    provider_id: string;
    tmdb_id: string | null;
    imdb_id: string | null;
    internal_media_id: string | null;
    series_tmdb_id: string | null;
    season_number: number | null;
    episode_number: number | null;
    is_watched: boolean;
    resume_position_ms: number;
    runtime_ms: number;
    watch_count: number;
    last_watched_at: Date | null;
    first_watched_at: Date | null;
    attempts: number;
    created_at: Date;
}

/** A row to upsert into `watch_state_pending_resolution` (no id / timestamps). */
export interface PendingResolutionInsert {
    user_id: string;
    provider: string;
    media_type: string;
    provider_id: string;
    tmdb_id: string | null;
    imdb_id: string | null;
    internal_media_id: string | null;
    series_tmdb_id: string | null;
    season_number: number | null;
    episode_number: number | null;
    is_watched: boolean;
    resume_position_ms: number;
    runtime_ms: number;
    watch_count: number;
    last_watched_at: Date | null;
    first_watched_at: Date | null;
}

/** A buffered item that now resolves and should be imported as watch state. */
export interface PendingDrainImport {
    pendingId: number;
    userId: string;
    mediaId: string;
    /** The buffered item's media type, so the importer can pick the right
     *  completion threshold (episodes differ from movies). */
    mediaType: string;
    isWatched: boolean;
    resumePositionMs: number;
    runtimeMs: number;
    watchCount: number;
    lastWatchedAt: Date | null;
    firstWatchedAt: Date | null;
}

/** The partitioned outcome of a drain pass over a loaded buffer. */
export interface PendingDrainPlan {
    /** Rows that resolved — import their watch state. */
    toImport: PendingDrainImport[];
    /** Ids to delete because they resolved + were imported. */
    toDeleteIds: number[];
    /** Ids to delete because they aged out unresolved (given up on). */
    toDropIds: number[];
    /** Ids still unresolved but within max age — bump attempts, keep. */
    toBumpIds: number[];
}

/**
 * Build a buffer insert row from an unresolved pull item and the already-
 * resolved Lumastra user UUID. All optional episode coordinates are normalised
 * to `null` (never `undefined`) so they serialise cleanly into SQL.
 */
export function pendingRowFromPullItem(
    item: WatchStatePullItem,
    userId: string,
    provider: string,
): PendingResolutionInsert {
    return {
        user_id: userId,
        provider,
        media_type: item.mediaType,
        provider_id: item.providerId,
        tmdb_id: item.tmdbId ?? null,
        imdb_id: item.imdbId ?? null,
        internal_media_id: item.internalMediaId ?? null,
        series_tmdb_id: item.seriesTmdbId ?? null,
        season_number: item.seasonNumber ?? null,
        episode_number: item.episodeNumber ?? null,
        is_watched: item.isWatched,
        resume_position_ms: item.resumePositionMs,
        runtime_ms: item.runtimeMs,
        watch_count: item.watchCount,
        last_watched_at: item.lastWatchedAt ?? null,
        first_watched_at: item.firstWatchedAt ?? item.lastWatchedAt ?? null,
    };
}

/**
 * Partition a loaded buffer into actions, given which provider ids now resolve.
 *
 * - resolved  → import + delete
 * - unresolved, age ≤ max → bump attempts (keep, retry next cycle)
 * - unresolved, age > max → drop (give up; bounds growth)
 */
export function planPendingDrain(
    rows: PendingResolutionRow[],
    resolvedByProviderId: Map<string, string>,
    now: Date,
    maxAgeMs: number,
): PendingDrainPlan {
    const plan: PendingDrainPlan = {
        toImport: [],
        toDeleteIds: [],
        toDropIds: [],
        toBumpIds: [],
    };

    for (const row of rows) {
        const mediaId = resolvedByProviderId.get(row.provider_id);
        if (mediaId) {
            plan.toImport.push({
                pendingId: row.id,
                userId: row.user_id,
                mediaId,
                mediaType: row.media_type,
                isWatched: row.is_watched,
                resumePositionMs: row.resume_position_ms,
                runtimeMs: row.runtime_ms,
                watchCount: row.watch_count,
                lastWatchedAt: row.last_watched_at,
                firstWatchedAt: row.first_watched_at,
            });
            plan.toDeleteIds.push(row.id);
            continue;
        }

        const ageMs = now.getTime() - row.created_at.getTime();
        if (ageMs > maxAgeMs) {
            plan.toDropIds.push(row.id);
        } else {
            plan.toBumpIds.push(row.id);
        }
    }

    return plan;
}
