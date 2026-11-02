// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Database Cleanup — native defineTask implementation.
 *
 * Periodic maintenance that removes orphaned and stale data in 12 stages:
 *
 * 1a. Merge duplicate series stubs into canonical entries
 * 1b. Reclassify misidentified episode-as-series items
 * 1c. Soft-delete orphan media stubs (tv/artist with no children/IDs/files)
 * 1c.5. Heal dead additional_artist_ids references left behind by pre-fix
 *     credit-only-artist soft-deletes (rewrite to the active canonical artist)
 * 1c.6. Clear additional_artist_ids that match no media_items row (hard-deleted
 *     artists) and re-derive the track's credits from its scalar artist tag
 * 1d. Soft-delete orphan music tracks/albums that lost their media_file_items link
 * 2.  Hard-delete media_items soft-deleted for > 30 days (via MediaDeletionService)
 * 3.  Remove orphan media_files with no media_file_items link
 * 4.  Purge old finished play_sessions (COMPLETED/CRASHED) older than 90 days
 * 5.  Prune old music_listen_events past 90 days
 * 6.  Hard-delete archived LiveTV channels (is_visible=false) older than 90 days
 * 7.  Purge rows with passed expires_at (user_suggestions, user_media_flags, assistant_rate_limits)
 * 8.  Prune audit/operational logs (cluster_node_events, file_scanner_runs,
 *     plugin_failure_events, plugin_secret_access_log)
 * 9.  Prune chat/AI history (assistant_messages, collaborative_chat_messages)
 * 10. Prune task system tables (task_quota_usage, task_webhook_outbox delivered/dead,
 *     task_history_archive — respects retention_policy=forever and retain_until)
 * 11. Prune livetv_channel_watch_history
 * 12. Two-tier user_media_events archival: move source rows older than
 *     DB_CLEANUP_MEDIA_EVENTS_ARCHIVE_DAYS (recorded_at) to user_media_events_archive,
 *     then hard-delete from archive after DB_CLEANUP_MEDIA_EVENTS_PURGE_DAYS
 * 14. Cap watch_sync_activity to the newest 50 rows per (user, provider,
 *     success-class) — unbounded per-event-sync activity feed rows otherwise
 *     grow forever
 *
 * Abort signal is honored between stages so admin cancel / shutdown returns promptly.
 * Per-item try/catch inside the MediaDeletionService.hardDelete loop is intentional
 * best-effort logic — individual item failure should not abort the batch.
 *
 * DB-unavailable handling: relies on the runner's sql-stub-throws-TaskError contract;
 * no in-plugin guard needed.
 *
 * Configuration:
 * - DISABLE_DATABASE_CLEANUP: Set to 'true' to disable this task entirely
 *   (both scheduled and manual triggers). Checked at execute() entry.
 *   Note: schedule.envOverride is for interval override only, not full-disable;
 *   we gate here instead so manual triggers are also blocked.
 */

import { z } from 'zod';
import type postgres from 'postgres';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import { config } from '$lib/server/config.js';
import { registry } from '../../registry.js';
import {
    LUMASTRA_FAILURE_EVENT_RETENTION_DAYS,
    DB_CLEANUP_ASSISTANT_RATE_LIMITS_DAYS,
    DB_CLEANUP_CLUSTER_NODE_EVENTS_DAYS,
    DB_CLEANUP_FILE_SCANNER_RUNS_DAYS,
    DB_CLEANUP_PLUGIN_SECRET_ACCESS_LOG_DAYS,
    DB_CLEANUP_ASSISTANT_MESSAGES_DAYS,
    DB_CLEANUP_CHAT_MESSAGES_DAYS,
    DB_CLEANUP_TASK_QUOTA_USAGE_DAYS,
    DB_CLEANUP_TASK_WEBHOOK_OUTBOX_DAYS,
    DB_CLEANUP_EVENT_OUTBOX_DAYS,
    DB_CLEANUP_TASK_HISTORY_ARCHIVE_DAYS,
    DB_CLEANUP_LIVETV_WATCH_HISTORY_DAYS,
    DB_CLEANUP_MEDIA_EVENTS_ARCHIVE_DAYS,
    DB_CLEANUP_MEDIA_EVENTS_PURGE_DAYS,
    TRANSCODE_FAILURE_RETENTION_DAYS,
    LIVETV_FAILURE_RETENTION_DAYS,
    PLAYBACK_INCIDENT_RETENTION_DAYS,
    SEGMENT_DELIVERY_FAILURE_RETENTION_DAYS,
    PLAYBACK_INCIDENT_MAX_ROWS_PER_USER,
    CLIENT_DIAGNOSTICS_RETENTION_DAYS,
    CLIENT_LOG_BUNDLE_RETENTION_DAYS,
    CLIENT_DIAGNOSTICS_MAX_ROWS_PER_USER,
} from '$lib/server/config.js';
import {
    backfillHasFilesMediaItems,
    clearStaleHasFilesMediaItems,
    findMergeStubCandidates,
    applyStubMerge,
    findMisidentifiedEpisodes,
    applyReclassify,
    softDeleteOrphanMediaStubs,
    healDeadArtistReferences,
    healDanglingArtistIds,
    softDeleteOrphanMusicItems,
    autoMergeDuplicateArtists,
    purgeStageStateForDeletedItems,
    findHardDeletableMediaIds,
    isHardDeletableMediaId,
    cleanupOrphanedMediaFiles,
    pruneOrphanedInteractionsMedia,
    pruneOrphanedInteractionsPlaylist,
    pruneOrphanedInteractionsPerson,
    pruneOrphanedInteractionReactionsMedia,
    pruneOrphanedInteractionReactionsPlaylist,
    pruneOrphanedInteractionReactionsPerson,
    pruneOldPlaySessions,
    purgeExpiredUserSuggestions,
    purgeExpiredUserMediaFlags,
    purgeOldAssistantRateLimits,
    pruneClusterNodeEvents,
    pruneFileScannerRuns,
    prunePluginFailureEvents,
    prunePluginSecretAccessLog,
    pruneAssistantMessages,
    pruneCollaborativeChatMessages,
    pruneTaskQuotaUsage,
    pruneDeliveredWebhookOutbox,
    pruneConsumedEventOutbox,
    pruneSyncChanges,
    pruneTaskHistoryArchive,
    pruneLivetvChannelWatchHistory,
    archiveOldUserMediaEvents,
    purgeOldArchivedMediaEvents,
} from '$lib/server/database/queries/database-cleanup.queries.js';
import { pruneSyncActivity } from '$lib/server/database/queries/watch-sync-activity.queries.js';
import { pruneTranscodeFailureEvents } from '$lib/server/database/queries/transcode-failure-events.queries.js';
import { pruneLiveTvFailureEvents } from '$lib/server/database/queries/livetv-failure-events.queries.js';
import { pruneSegmentDeliveryFailures } from '$lib/server/database/queries/segment-delivery-failures.queries.js';
import {
    prunePlaybackIncidentEvents,
    pruneLegacyPlaybackIncidentEvents,
    enforcePlaybackIncidentRowCap,
} from '$lib/server/database/queries/playback-incident-events.queries.js';
import { AUTOMATIC_KINDS, DIAGNOSTIC_KINDS } from '$lib/schemas/client-diagnostics.js';
import {
    pruneClientDiagnostics,
    enforceClientDiagnosticRowCap,
} from '$lib/server/database/queries/client-diagnostics.queries.js';
import { albumArtistDecision } from './media-sources/_helpers/file-scanner/album-artist-evidence.js';
import { backfillSortTitles } from '$lib/server/database/queries/sort-title.queries.js';
import { pruneExpired } from '$lib/server/database/queries/user-notifications.queries.js';
import { pruneDeadPushRows } from '$lib/server/database/queries/user-push-outbox.queries.js';

/**
 * Budget of the sort_title backfill step per run. A 186k-row catalog needs two
 * runs at most; a settled install pays one bounded SELECT.
 */
const SORT_TITLE_BACKFILL_MAX_ROWS = 100_000;
const SORT_TITLE_BACKFILL_MAX_MS = 120_000;

/** Days before soft-deleted media_items are hard-deleted */
const DELETED_MEDIA_RETENTION_DAYS = 30;

/**
 * Days a dead `user_push_outbox` row is kept as the record of why a push never
 * arrived. Long enough to still be there when someone investigates a weekend
 * incident on Monday; short enough that a misconfigured install — where every
 * row dies — cannot accumulate them forever.
 */
const DEAD_PUSH_ROW_RETENTION_DAYS = 7;

/**
 * Repeatedly invoke a LIMIT-capped prune until a pass deletes fewer than the
 * batch size (drained), the abort signal fires (soft/hard timeout), or a runaway
 * cap is hit. A single per-day LIMIT pass silently caps deletion below the insert
 * rate for high-volume tables (event_outbox hit 1.14M rows / 557 MB in 7 days),
 * so the table grows unbounded despite the cleanup "succeeding". Looping keeps the
 * prune proportional to the backlog, bounded by the task's own timeout.
 */
export async function pruneUntilDrained(
    fn: (sql: postgres.Sql, cutoff: Date, limit: number) => Promise<number>,
    sql: postgres.Sql,
    cutoff: Date,
    signal: AbortSignal,
    batch: number,
): Promise<number> {
    const MAX_PASSES = 1_000; // runaway guard: batch * MAX_PASSES rows/run ceiling
    let total = 0;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        if (signal.aborted) break;
        const deleted = await fn(sql, cutoff, batch);
        total += deleted;
        if (deleted < batch) break; // fewer than a full batch ⇒ drained
    }
    return total;
}

/**
 * Days before finished play_sessions are purged.
 *
 * Exported because the admin surface-mix stats read `play_sessions` directly
 * and must not advertise a window wider than what this task actually keeps —
 * a second hardcoded 90 elsewhere would silently drift from this one.
 */
export const PLAY_SESSION_RETENTION_DAYS = 90;

/** client_diagnostics kinds on CLIENT_DIAGNOSTICS_RETENTION_DAYS — derived, so a new
 *  automatic kind is pruned without touching this task. */
const CLEANUP_AUTOMATIC_KINDS = [...AUTOMATIC_KINDS];
/** Every client_diagnostics kind under CLIENT_DIAGNOSTICS_MAX_ROWS_PER_USER — all but
 *  playback_incident, which has its own cap (PLAYBACK_INCIDENT_MAX_ROWS_PER_USER). */
const CLEANUP_CAPPED_KINDS = DIAGNOSTIC_KINDS.filter((k) => k !== 'playback_incident');

/** Days before music_listen_events are purged */
const MUSIC_EVENT_RETENTION_DAYS = 90;

/**
 * Days without any refresh after which a channel the provider dropped (archived
 * after 3 missed refreshes) is hard-deleted. A refreshing source deletes them
 * itself (PURGE_AFTER_ABSENCES); this catches sources that stopped refreshing.
 * Channels hidden by an admin or Configure Lineup are never touched.
 */
const ARCHIVED_LIVETV_CHANNEL_RETENTION_DAYS = 30;

interface CleanupStats {
    // Stages 1–6 (existing)
    mergedStubs: number;
    mergedDuplicateArtists: number;
    skippedDuplicateArtists: number;
    reclassifiedEpisodes: number;
    orphanStubs: number;
    healedDeadArtistRefs: number;
    healedDanglingArtistTracks: number;
    orphanMusicItems: number;
    purgedDeletedStageState: number;
    hardDeletedMedia: number;
    /**
     * Retention hard-deletes skipped: the row regained a file mid-loop
     * (rename-reclaim race), its in-transaction eligibility recheck failed, or a
     * concurrent writer held a lock (lock wait, deadlock, statement timeout).
     */
    skippedFileBackedHardDeletes: number;
    orphanFiles: number;
    staleSessions: number;
    prunedMusicEvents: number;
    purgedLivetvChannels: number;
    purgedLivetvCategories: number;
    // Stage 7: TTL-expired rows
    expiredSuggestions: number;
    expiredMediaFlags: number;
    expiredRateLimits: number;
    // Stage 8: Audit/operational logs
    pruneClusterEvents: number;
    pruneScannerRuns: number;
    prunePluginFailures: number;
    pruneSecretAccessLog: number;
    pruneTranscodeFailures: number;
    pruneLivetvFailures: number;
    prunePlaybackIncidents: number;
    pruneSegmentDeliveryFailures: number;
    enforcePlaybackIncidentRowCap: number;
    pruneClientDiagnostics: number;
    pruneClientLogBundles: number;
    enforceClientDiagnosticRowCap: number;
    // Stage 9: Chat/AI messages
    pruneAssistantMessages: number;
    pruneChatMessages: number;
    // Stage 10: Task system tables
    pruneTaskQuotaUsage: number;
    pruneOutboxDelivered: number;
    pruneEventOutboxConsumed: number;
    pruneSyncChanges: number;
    pruneTaskHistoryArchive: number;
    // Stage 11: LiveTV watch history
    pruneLivetvWatchHistory: number;
    // Stage 12: user_media_events archival
    archivedMediaEvents: number;
    purgedArchivedEvents: number;
    // Stage 13: Orphaned upload sessions
    purgedUploadSessions: number;
    // Stage 3b: Orphaned interactions / interaction_reactions
    orphanedInteractions: number;
    // Stage 14: watch_sync_activity retention cap
    prunedSyncActivity: number;
    // Stage 15: user notifications past their TTL, and dead push outbox rows
    expiredNotifications: number;
    deadPushRows: number;
    // has_files drift: stale `true` cleared (the other half of the backfill)
    clearedStaleHasFiles: number;
    // media_items.sort_title keys filled by the capped background backfill
    backfilledSortTitles: number;
}

type DatabaseCleanupInput = Record<string, unknown>;

type DatabaseCleanupResult = {
    stats: CleanupStats;
    errors: string[];
    message: string;
};

const inputSchema = z.object({}).passthrough();

export const databaseCleanupTask = defineTask<DatabaseCleanupInput, DatabaseCleanupResult>({
    id: 'database-cleanup',
    purpose: 'maintenance',
    name: 'Database Cleanup',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    schedule: {
        every: '24h',
        runOnStartup: false,
    },

    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',
    resourceClass: 'maintenance',

    // Singleton guard: stages 1a/1b/2 hard-delete and merge media_items rows
    // (via MediaDeletionService.hardDelete + duplicate-series merge), not
    // just idempotent housekeeping. Without exclusiveWith, the scheduler's
    // narrow double-fire window (fast-completing run + failed
    // scheduler_state advance) can spawn a second concurrent
    // 'global-catchup' pass that races the first on the same merge/delete
    // candidates. identityFor is mode-suffixed but stable for the scheduled
    // entry point. ttl exceeds the 45m hard timeout with margin.
    exclusiveWith: { scope: 'global', ttl: '55m' },

    inputSchema,

    // 2026-05-29: bumped 5m → 45m. The old budget killed 4 of the last 5
    // scheduled runs with `watchdog-timeout-hard`. Daily maintenance is a
    // long-tail operation (per-item MediaDeletionService.hardDelete loop,
    // bounded 10k-row archive UPDATE/DELETE for user_media_events, etc.)
    // and the per-stage abort-signal guards mean we can afford a generous
    // wall-clock. Soft timeout one minute under hard so the runner has a
    // window to flush progress writes before hard-kill.
    timeout: { hard: '45m', soft: '44m' },

    async execute(ctx: TaskContext<DatabaseCleanupInput>) {
        const { logger, sql, signal } = ctx;

        // envOverride is for interval override only; for full-disable semantics
        // (blocks both scheduled and manual triggers) we gate at execute() entry.
        if (config.DISABLE_DATABASE_CLEANUP) {
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    stats: {
                        mergedStubs: 0,
                        mergedDuplicateArtists: 0,
                        skippedDuplicateArtists: 0,
                        reclassifiedEpisodes: 0,
                        orphanStubs: 0,
                        healedDeadArtistRefs: 0,
                        healedDanglingArtistTracks: 0,
                        orphanMusicItems: 0,
                        purgedDeletedStageState: 0,
                        hardDeletedMedia: 0,
                        skippedFileBackedHardDeletes: 0,
                        orphanFiles: 0,
                        staleSessions: 0,
                        prunedMusicEvents: 0,
                        purgedLivetvChannels: 0,
                        purgedLivetvCategories: 0,
                        expiredSuggestions: 0,
                        expiredMediaFlags: 0,
                        expiredRateLimits: 0,
                        pruneClusterEvents: 0,
                        pruneScannerRuns: 0,
                        prunePluginFailures: 0,
                        pruneSecretAccessLog: 0,
                        pruneTranscodeFailures: 0,
                        pruneLivetvFailures: 0,
                        prunePlaybackIncidents: 0,
                        pruneSegmentDeliveryFailures: 0,
                        enforcePlaybackIncidentRowCap: 0,
                        pruneClientDiagnostics: 0,
                        pruneClientLogBundles: 0,
                        enforceClientDiagnosticRowCap: 0,
                        pruneAssistantMessages: 0,
                        pruneChatMessages: 0,
                        pruneTaskQuotaUsage: 0,
                        pruneOutboxDelivered: 0,
                        pruneEventOutboxConsumed: 0,
                        pruneSyncChanges: 0,
                        pruneTaskHistoryArchive: 0,
                        pruneLivetvWatchHistory: 0,
                        archivedMediaEvents: 0,
                        purgedArchivedEvents: 0,
                        purgedUploadSessions: 0,
                        orphanedInteractions: 0,
                        prunedSyncActivity: 0,
                        expiredNotifications: 0,
                        deadPushRows: 0,
                        clearedStaleHasFiles: 0,
                        backfilledSortTitles: 0,
                    },
                    errors: [],
                    message: 'database-cleanup disabled via DISABLE_DATABASE_CLEANUP',
                },
            };
        }

        const stats: CleanupStats = {
            mergedStubs: 0,
            mergedDuplicateArtists: 0,
            skippedDuplicateArtists: 0,
            reclassifiedEpisodes: 0,
            orphanStubs: 0,
            healedDeadArtistRefs: 0,
            healedDanglingArtistTracks: 0,
            orphanMusicItems: 0,
            purgedDeletedStageState: 0,
            hardDeletedMedia: 0,
            skippedFileBackedHardDeletes: 0,
            orphanFiles: 0,
            staleSessions: 0,
            prunedMusicEvents: 0,
            purgedLivetvChannels: 0,
            purgedLivetvCategories: 0,
            expiredSuggestions: 0,
            expiredMediaFlags: 0,
            expiredRateLimits: 0,
            pruneClusterEvents: 0,
            pruneScannerRuns: 0,
            prunePluginFailures: 0,
            pruneSecretAccessLog: 0,
            pruneTranscodeFailures: 0,
            pruneLivetvFailures: 0,
            prunePlaybackIncidents: 0,
            pruneSegmentDeliveryFailures: 0,
            enforcePlaybackIncidentRowCap: 0,
            pruneClientDiagnostics: 0,
            pruneClientLogBundles: 0,
            enforceClientDiagnosticRowCap: 0,
            pruneAssistantMessages: 0,
            pruneChatMessages: 0,
            pruneTaskQuotaUsage: 0,
            pruneOutboxDelivered: 0,
            pruneEventOutboxConsumed: 0,
            pruneSyncChanges: 0,
            pruneTaskHistoryArchive: 0,
            pruneLivetvWatchHistory: 0,
            archivedMediaEvents: 0,
            purgedArchivedEvents: 0,
            purgedUploadSessions: 0,
            orphanedInteractions: 0,
            prunedSyncActivity: 0,
            expiredNotifications: 0,
            deadPushRows: 0,
            clearedStaleHasFiles: 0,
            backfilledSortTitles: 0,
        };

        const errors: string[] = [];

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // Ensure has_files is populated — idempotent, cheap when already backfilled
        // (WHERE has_files = false means 0 rows updated = fast)
        await backfillHasFilesMediaItems(sql);

        // …and clear the STALE `true`s the backfill above can never fix (it only ever
        // sets true). Both directions belong in the same tick: this is the only
        // periodic rail that heals has_files drift for items whose files were removed
        // outside the sanctioned delete helpers.
        stats.clearedStaleHasFiles = await clearStaleHasFilesMediaItems(sql);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 1a. Merge duplicate series stubs into canonical entries.
        //     When a TV series exists without external IDs but has children,
        //     and there's exactly one same-titled series WITH external IDs,
        //     re-parent the children and delete the stub.
        const mergeCandidates = await findMergeStubCandidates(sql);

        for (const { stub_id, canonical_id } of mergeCandidates) {
            if (signal.aborted) break;
            try {
                await applyStubMerge(sql, stub_id, canonical_id);
                stats.mergedStubs++;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn('applyStubMerge failed', {
                    stub_id,
                    canonical_id,
                    reason: msg,
                });
                errors.push(`stub-merge ${stub_id}: ${msg}`);
            }
        }

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 1b. Reclassify misidentified episode-as-series items.
        //     These are 'tv' items with no external IDs, created when the scanner
        //     used an episode filename as the series title. D5 safety guard in
        //     findMisidentifiedEpisodes() excludes stubs whose linked files still
        //     live on disk — those survive the cleanup and get re-processed by
        //     the scanner on its next run.
        const misidentified = await findMisidentifiedEpisodes(sql);

        for (const { stub_id } of misidentified) {
            if (signal.aborted) break;
            try {
                await applyReclassify(sql, stub_id);
                stats.reclassifiedEpisodes++;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn('applyReclassify failed', { stub_id, reason: msg });
                errors.push(`reclassify ${stub_id}: ${msg}`);
            }
        }

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 1b.5. Auto-merge legacy duplicate artist rows.
        //     A library_group_id-scoped lookup in findOrCreateMusicArtist
        //     used to create a second "Arlen" / "Eloren" / … any time a scan
        //     supplied a library_group_id where the existing row had NULL.
        //     The lookup was fixed (see media-items.queries.ts), but legacy
        //     duplicate pairs still exist in long-running deployments. This
        //     stage merges any pair where at most one side has external_ids
        //     (so we never collapse two genuinely-different artists who
        //     happen to share a name); the winner is the oldest row by
        //     created_at, all children/user-data/library-availability move
        //     to it, and the loser is deleted.
        try {
            const result = await autoMergeDuplicateArtists(sql, logger, {
                albumArtistDecision: (tx, albumId) => albumArtistDecision(tx, albumId, { logger }),
            });
            stats.mergedDuplicateArtists = result.merged;
            stats.skippedDuplicateArtists = result.skipped;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('autoMergeDuplicateArtists failed (non-fatal)', {
                reason: msg,
            });
            errors.push(`auto-merge-artists: ${msg}`);
        }

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 1c. Soft-delete orphan media stubs
        //    These are parent-level items (tv/artist) with no children,
        //    no external IDs, and no linked files — useless ghost rows.
        //    tvchannel items are excluded: they're linked via livetv_channels
        //    (not external_ids or media_file_items), so the orphan check doesn't apply.
        stats.orphanStubs = await softDeleteOrphanMediaStubs(sql);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 1c.5. Heal dead additional_artist_ids references.
        //    ~210 artists were soft-deleted before the credit-only-artist
        //    exclusion guard above existed and can't simply be un-deleted —
        //    their normalized title now collides with an active row created
        //    since (uq_music_artist_norm_title). Rewrite the dead UUID inside
        //    every referencing track's additional_artist_ids to the active
        //    canonical artist instead, deduping any resulting repeat entry.
        try {
            const healed = await healDeadArtistReferences(sql);
            stats.healedDeadArtistRefs = healed;
            if (healed > 0) {
                logger.info('healDeadArtistReferences: healed dead artist references', {
                    healed,
                });
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('healDeadArtistReferences failed (non-fatal)', { reason: msg });
            errors.push(`heal-dead-artist-refs: ${msg}`);
        }

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 1c.6. Clear additional_artist_ids that point at hard-deleted
        //    artists (no media_items row at all) and re-derive the track's
        //    credits from its intact scalar artist tag. Batched per tick.
        try {
            const dangling = await healDanglingArtistIds(sql, { signal });
            stats.healedDanglingArtistTracks = dangling.tracks;
            if (dangling.tracks > 0 || dangling.failed > 0) {
                logger.info('healDanglingArtistIds: cleared dangling artist ids', {
                    tracks: dangling.tracks,
                    idsDropped: dangling.idsDropped,
                    failed: dangling.failed,
                    ...(dangling.firstError ? { firstError: dangling.firstError } : {}),
                });
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('healDanglingArtistIds failed (non-fatal)', { reason: msg });
            errors.push(`heal-dangling-artist-ids: ${msg}`);
        }

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 1d. Soft-delete orphan music tracks/albums.
        //    Track and album rows that lost their media_file_items link
        //    (e.g. dropped during a bulk re-scan race) but kept their
        //    media_items row. They surface 404s in autoplay/Quick Picks
        //    until cleaned up. 30-min grace window guards in-progress
        //    scans (insert-track-then-attach-file is not transactional).
        stats.orphanMusicItems = await softDeleteOrphanMusicItems(sql);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 1e. Purge stage_state rows for soft-deleted items.
        //    Soft-delete sites flip media_items.status to 'deleted' but
        //    leave stage_state rows behind, inflating admin backlog
        //    counters and causing stage-sweep to keep enqueueing tasks
        //    with no real work. Hard-delete (below) cascades via FK,
        //    but the 30d retention window means orphans linger.
        try {
            // LIMIT-batched + drained via pruneUntilDrained (see helper docstring):
            // an unbounded single-pass DELETE could touch millions of rows after a
            // bulk library removal, holding a long write lock for the whole task
            // timeout. This prune has no time-based cutoff (status-only predicate),
            // so the `cutoff` param pruneUntilDrained expects is unused — passed a
            // throwaway Date and ignored by the wrapped call.
            stats.purgedDeletedStageState = await pruneUntilDrained(
                (s, _cutoff, limit) => purgeStageStateForDeletedItems(s, limit),
                sql,
                new Date(),
                signal,
                10_000,
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('purgeStageStateForDeletedItems failed', {
                reason: msg,
            });
            errors.push(`purgeStageStateForDeletedItems: ${msg}`);
        }

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 2. Hard-delete media_items that have been soft-deleted for > retention period.
        //    First remove dependent rows, then the media_items themselves.
        const deleteCutoff = new Date(Date.now() - DELETED_MEDIA_RETENTION_DAYS * 86_400_000);

        // Use MediaDeletionService for proper lifecycle cleanup (cache, embeddings).
        // Process in batches to stay within the task timeout.
        const { MediaDeletionService } =
            await import('$lib/server/services/media-deletion.service.js');

        if (typeof MediaDeletionService?.hardDelete !== 'function') {
            throw new Error('database-cleanup: MediaDeletionService.hardDelete is not a function');
        }

        const idsToDelete = await findHardDeletableMediaIds(sql, deleteCutoff);

        for (const id of idsToDelete) {
            if (signal.aborted) break;
            try {
                // guardFileBacked: a rename-reclaim can re-attach a file to a
                // status='deleted' row between findHardDeletableMediaIds (the
                // pre-loop snapshot) and this delete. The guard re-checks in-tx
                // under the same advisory lock attachFileToItem uses and skips
                // (does not delete) any row that regained a file — preserving
                // the reclaim's link instead of destroying it (data loss).
                const res = await MediaDeletionService.hardDelete(sql, id, {
                    guardFileBacked: true,
                    eligibility: (tx) => isHardDeletableMediaId(tx, id, deleteCutoff),
                });
                if (res.deleted) {
                    stats.hardDeletedMedia++;
                } else {
                    stats.skippedFileBackedHardDeletes++;
                }
            } catch (err) {
                const code =
                    typeof err === 'object' && err !== null && 'code' in err ? err.code : null;
                if (code === '55P03' || code === '40P01' || code === '57014') {
                    // A concurrent writer or slow statement won; retry next run.
                    stats.skippedFileBackedHardDeletes++;
                    continue;
                }
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn('Failed to hard-delete media item', {
                    id,
                    reason: msg,
                });
                errors.push(`hard-delete ${id}: ${msg}`);
            }
        }

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 3. Remove orphan media_files with no media_file_items link (bounded)
        stats.orphanFiles = await cleanupOrphanedMediaFiles(sql);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 3b. Delete interactions / interaction_reactions whose target no longer exists.
        //     The polymorphic (target_type, target_id) columns carry no FK so rows
        //     leak forever after their target (media item, playlist, person) is deleted.
        //     Split into 6 independently LIMIT-batched + drained prunes (one per
        //     table x target_type) rather than a single unbounded transaction — see
        //     pruneOrphanedInteractions* docstrings. Each is idempotent, so batching
        //     outside a shared transaction is safe: a failure in one doesn't block
        //     the others, and abort mid-loop just leaves the remainder for next run.
        const orphanedInteractionPruners: Array<{
            label: string;
            fn: (s: postgres.Sql, limit: number) => Promise<number>;
        }> = [
            { label: 'interactions/media', fn: pruneOrphanedInteractionsMedia },
            { label: 'interactions/playlist', fn: pruneOrphanedInteractionsPlaylist },
            { label: 'interactions/person', fn: pruneOrphanedInteractionsPerson },
            { label: 'interaction_reactions/media', fn: pruneOrphanedInteractionReactionsMedia },
            {
                label: 'interaction_reactions/playlist',
                fn: pruneOrphanedInteractionReactionsPlaylist,
            },
            { label: 'interaction_reactions/person', fn: pruneOrphanedInteractionReactionsPerson },
        ];

        for (const { label, fn } of orphanedInteractionPruners) {
            if (signal.aborted) break;
            try {
                stats.orphanedInteractions += await pruneUntilDrained(
                    (s, _cutoff, limit) => fn(s, limit),
                    sql,
                    new Date(), // no time-based cutoff for this prune; unused
                    signal,
                    10_000,
                );
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.warn(`cleanupOrphanedInteractions (${label}) failed (non-fatal)`, {
                    reason: msg,
                });
                errors.push(`cleanupOrphanedInteractions (${label}): ${msg}`);
            }
        }

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 4. Purge old finished play_sessions (COMPLETED/CRASHED)
        const sessionCutoff = new Date(Date.now() - PLAY_SESSION_RETENTION_DAYS * 86_400_000);
        stats.staleSessions = await pruneOldPlaySessions(sql, sessionCutoff);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 5. Prune old music_listen_events past retention (90 days)
        const musicTrackingModule =
            await import('$lib/server/database/queries/music-tracking.queries.js').catch((err) => {
                throw new Error(
                    `database-cleanup: failed to load music-tracking queries: ${err instanceof Error ? err.message : String(err)}`,
                );
            });
        const { pruneOldListenEvents } = musicTrackingModule;
        if (typeof pruneOldListenEvents !== 'function') {
            throw new Error('database-cleanup: pruneOldListenEvents is not a function');
        }
        stats.prunedMusicEvents = await pruneOldListenEvents(sql, MUSIC_EVENT_RETENTION_DAYS);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 6. Hard-delete Live TV channels the provider dropped (3+ missed refreshes,
        //    untouched for the retention period), the backup groups and the
        //    categories they leave empty.
        const { purgeArchivedChannels, purgeEmptyCategories } =
            await import('$lib/server/database/queries/livetv-channels.queries.js');
        const livetvCutoff = new Date(
            Date.now() - ARCHIVED_LIVETV_CHANNEL_RETENTION_DAYS * 86_400_000,
        );
        stats.purgedLivetvChannels = await purgeArchivedChannels(sql, livetvCutoff);
        stats.purgedLivetvCategories = await purgeEmptyCategories(sql);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 7. Sweep rows with passed expires_at / old date keys.
        stats.expiredSuggestions = await purgeExpiredUserSuggestions(sql);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        stats.expiredMediaFlags = await purgeExpiredUserMediaFlags(sql);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        const rateLimitCutoff = new Date(
            Date.now() - DB_CLEANUP_ASSISTANT_RATE_LIMITS_DAYS * 86_400_000,
        );
        stats.expiredRateLimits = await purgeOldAssistantRateLimits(sql, rateLimitCutoff);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 8. Audit / operational event logs.
        const clusterEventCutoff = new Date(
            Date.now() - DB_CLEANUP_CLUSTER_NODE_EVENTS_DAYS * 86_400_000,
        );
        stats.pruneClusterEvents = await pruneClusterNodeEvents(sql, clusterEventCutoff);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        const scannerRunCutoff = new Date(
            Date.now() - DB_CLEANUP_FILE_SCANNER_RUNS_DAYS * 86_400_000,
        );
        stats.pruneScannerRuns = await pruneFileScannerRuns(sql, scannerRunCutoff);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        const failureEventCutoff = new Date(
            Date.now() - LUMASTRA_FAILURE_EVENT_RETENTION_DAYS * 86_400_000,
        );
        stats.prunePluginFailures = await prunePluginFailureEvents(sql, failureEventCutoff);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        const transcodeFailureCutoff = new Date(
            Date.now() - TRANSCODE_FAILURE_RETENTION_DAYS * 86_400_000,
        );
        // Batched + drained: rows carry argv, stderr and env jsonb (~10-25KB each),
        // so an unbounded single-pass DELETE could hold a long write lock.
        stats.pruneTranscodeFailures = await pruneUntilDrained(
            pruneTranscodeFailureEvents,
            sql,
            transcodeFailureCutoff,
            signal,
            50_000,
        );

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        const playbackIncidentCutoff = new Date(
            Date.now() - PLAYBACK_INCIDENT_RETENTION_DAYS * 86_400_000,
        );
        stats.prunePlaybackIncidents = await pruneUntilDrained(
            prunePlaybackIncidentEvents,
            sql,
            playbackIncidentCutoff,
            signal,
            50_000,
        );

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // The frozen legacy playback_incident_events table (kept by migration 16.268.0
        // until its drop migration) still holds personal data — prune it on the same
        // window, counted into the same stat. Remove together with the drop migration.
        stats.prunePlaybackIncidents += await pruneUntilDrained(
            pruneLegacyPlaybackIncidentEvents,
            sql,
            playbackIncidentCutoff,
            signal,
            50_000,
        );

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // client_diagnostics — automatic kinds (crash/hang/js_error/api_failures) get
        // their own retention window and their own row cap, separate from
        // playback_incident_events above, so an error flood on one kind family cannot
        // evict the other's history.
        const clientDiagnosticsCutoff = new Date(
            Date.now() - CLIENT_DIAGNOSTICS_RETENTION_DAYS * 86_400_000,
        );
        stats.pruneClientDiagnostics = await pruneUntilDrained(
            (s, cutoff, limit) => pruneClientDiagnostics(s, CLEANUP_AUTOMATIC_KINDS, cutoff, limit),
            sql,
            clientDiagnosticsCutoff,
            signal,
            50_000,
        );

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // log_bundle rows carry a blob (up to the inflate cap), so prune in smaller
        // batches than the plain event kinds above.
        const clientBundleCutoff = new Date(
            Date.now() - CLIENT_LOG_BUNDLE_RETENTION_DAYS * 86_400_000,
        );
        stats.pruneClientLogBundles = await pruneUntilDrained(
            (s, cutoff, limit) => pruneClientDiagnostics(s, ['log_bundle'], cutoff, limit),
            sql,
            clientBundleCutoff,
            signal,
            1_000,
        );

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        const segmentDeliveryFailureCutoff = new Date(
            Date.now() - SEGMENT_DELIVERY_FAILURE_RETENTION_DAYS * 86_400_000,
        );
        stats.pruneSegmentDeliveryFailures = await pruneUntilDrained(
            pruneSegmentDeliveryFailures,
            sql,
            segmentDeliveryFailureCutoff,
            signal,
            50_000,
        );

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // Backstop, independent of retention, that survives a cleanup task
        // that never runs — but still drained via pruneUntilDrained like the
        // other batched prunes above: a single LIMIT-capped pass silently
        // under-cleans when a burst of over-cap rows (across many users)
        // exceeds the batch size in one run, same reasoning as the
        // unbounded-growth fix documented on pruneUntilDrained itself.
        // enforcePlaybackIncidentRowCap takes (sql, capPerUser, limit), not
        // (sql, cutoff, limit) — no time-based cutoff applies to a row-count
        // cap — so cutoff is a throwaway unused param, same adapter pattern
        // as purgeStageStateForDeletedItems above.
        stats.enforcePlaybackIncidentRowCap = await pruneUntilDrained(
            (s, _cutoff, limit) =>
                enforcePlaybackIncidentRowCap(s, PLAYBACK_INCIDENT_MAX_ROWS_PER_USER, limit),
            sql,
            new Date(),
            signal,
            5_000,
        );

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // Same backstop as enforcePlaybackIncidentRowCap above, for the client
        // diagnostics kinds — including log_bundle, so a burst of bundles cannot
        // by itself push a user over cap without also being capped back down.
        stats.enforceClientDiagnosticRowCap = await pruneUntilDrained(
            (s, _cutoff, limit) =>
                enforceClientDiagnosticRowCap(
                    s,
                    CLEANUP_CAPPED_KINDS,
                    CLIENT_DIAGNOSTICS_MAX_ROWS_PER_USER,
                    limit,
                ),
            sql,
            new Date(),
            signal,
            5_000,
        );

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        const livetvFailureCutoff = new Date(
            Date.now() - LIVETV_FAILURE_RETENTION_DAYS * 86_400_000,
        );
        // Batched + drained for the same reason as the transcode table above: each row
        // carries an ~8KB stderr tail plus probe/decision jsonb.
        stats.pruneLivetvFailures = await pruneUntilDrained(
            pruneLiveTvFailureEvents,
            sql,
            livetvFailureCutoff,
            signal,
            50_000,
        );

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        const secretLogCutoff = new Date(
            Date.now() - DB_CLEANUP_PLUGIN_SECRET_ACCESS_LOG_DAYS * 86_400_000,
        );
        stats.pruneSecretAccessLog = await prunePluginSecretAccessLog(sql, secretLogCutoff);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 9. Chat / AI message history.
        const assistantMsgCutoff = new Date(
            Date.now() - DB_CLEANUP_ASSISTANT_MESSAGES_DAYS * 86_400_000,
        );
        stats.pruneAssistantMessages = await pruneAssistantMessages(sql, assistantMsgCutoff);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        const chatMsgCutoff = new Date(Date.now() - DB_CLEANUP_CHAT_MESSAGES_DAYS * 86_400_000);
        stats.pruneChatMessages = await pruneCollaborativeChatMessages(sql, chatMsgCutoff);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 10. Task system maintenance tables.
        const quotaCutoff = new Date(Date.now() - DB_CLEANUP_TASK_QUOTA_USAGE_DAYS * 86_400_000);
        stats.pruneTaskQuotaUsage = await pruneTaskQuotaUsage(sql, quotaCutoff);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        const outboxCutoff = new Date(
            Date.now() - DB_CLEANUP_TASK_WEBHOOK_OUTBOX_DAYS * 86_400_000,
        );
        stats.pruneOutboxDelivered = await pruneUntilDrained(
            pruneDeliveredWebhookOutbox,
            sql,
            outboxCutoff,
            signal,
            50_000,
        );

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // Pipeline event_outbox — consumed (non-dead-letter) rows older than
        // the retention threshold. Dispatcher leaves consumed rows in place,
        // so without this prune the table grows ~one row per pipeline event
        // forever (557 MB / 1.14M rows on preprod after 7 days before this
        // landed).
        const eventOutboxCutoff = new Date(Date.now() - DB_CLEANUP_EVENT_OUTBOX_DAYS * 86_400_000);
        stats.pruneEventOutboxConsumed = await pruneUntilDrained(
            pruneConsumedEventOutbox,
            sql,
            eventOutboxCutoff,
            signal,
            10_000,
        );

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        stats.pruneSyncChanges = await pruneUntilDrained(
            pruneSyncChanges,
            sql,
            new Date(Date.now() - 30 * 86_400_000),
            signal,
            10_000,
        );

        if (signal.aborted) return earlyReturn(stats, errors, true);

        const historyArchiveCutoff = new Date(
            Date.now() - DB_CLEANUP_TASK_HISTORY_ARCHIVE_DAYS * 86_400_000,
        );
        stats.pruneTaskHistoryArchive = await pruneUntilDrained(
            pruneTaskHistoryArchive,
            sql,
            historyArchiveCutoff,
            signal,
            10_000,
        );

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 11. LiveTV channel watch history.
        const livetvWatchCutoff = new Date(
            Date.now() - DB_CLEANUP_LIVETV_WATCH_HISTORY_DAYS * 86_400_000,
        );
        stats.pruneLivetvWatchHistory = await pruneLivetvChannelWatchHistory(
            sql,
            livetvWatchCutoff,
        );

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 12. Two-tier user_media_events archival.
        //     Phase A: move events whose recorded_at is older than the archive
        //     threshold into the cold archive table. recorded_at (not occurred_at)
        //     is the boundary because provider sync can write backdated events
        //     with old occurred_at but fresh recorded_at.
        //     Phase B: hard-delete rows in the archive older than the purge threshold.
        //     Guard: skip phase B if misconfigured (purge_days <= archive_days).
        const mediaEventsArchiveCutoff = new Date(
            Date.now() - DB_CLEANUP_MEDIA_EVENTS_ARCHIVE_DAYS * 86_400_000,
        );
        stats.archivedMediaEvents = await archiveOldUserMediaEvents(sql, mediaEventsArchiveCutoff);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        if (DB_CLEANUP_MEDIA_EVENTS_PURGE_DAYS > DB_CLEANUP_MEDIA_EVENTS_ARCHIVE_DAYS) {
            const mediaEventsPurgeCutoff = new Date(
                Date.now() - DB_CLEANUP_MEDIA_EVENTS_PURGE_DAYS * 86_400_000,
            );
            stats.purgedArchivedEvents = await purgeOldArchivedMediaEvents(
                sql,
                mediaEventsPurgeCutoff,
            );
        } else {
            logger.warn(
                'DB_CLEANUP_MEDIA_EVENTS_PURGE_DAYS <= DB_CLEANUP_MEDIA_EVENTS_ARCHIVE_DAYS — archive purge skipped',
                {
                    purgeDays: DB_CLEANUP_MEDIA_EVENTS_PURGE_DAYS,
                    archiveDays: DB_CLEANUP_MEDIA_EVENTS_ARCHIVE_DAYS,
                },
            );
        }

        // 13. Orphaned upload sessions (expired staging directories + DB rows).
        //     Sessions past expires_at that still have a staging_dir on disk are
        //     safe to clean up — the upload was never finalized (aborted / timed out).
        try {
            const { cleanupExpiredUploadSessions } =
                await import('$lib/server/services/upload-session.service.js');
            stats.purgedUploadSessions = await cleanupExpiredUploadSessions(sql, new Date());
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('cleanupExpiredUploadSessions failed (non-fatal)', { reason: msg });
            errors.push(`upload-session-cleanup: ${msg}`);
        }

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // Reclaim crashed download attempts even if no subsequent encode finishes.
        try {
            const { reapToCap } =
                await import('$lib/server/services/download-rendition/service.js');
            await reapToCap(sql);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('Rendition cache cleanup failed (non-fatal)', { reason: msg });
            errors.push(`rendition-cache-cleanup: ${msg}`);
        }

        // 14. Cap watch_sync_activity to the newest 50 rows per (user, provider,
        //     success-class). The per-connection sync activity feed writes one
        //     row per push/pull event; without a cap it grows unbounded.
        stats.prunedSyncActivity = await pruneSyncActivity(sql, 50);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // 15. Notification inbox TTL, and dead push outbox rows.
        //
        // `pruneExpired` has documented since it was written that "a background
        // task invokes it" — none did, in any file under src/. So expired
        // notifications were never removed, and neither were the push outbox
        // rows that hang off them: `user_push_outbox.notification_id` cascades
        // on delete, which is the ONLY thing that ever removed an outbox row
        // other than a successful delivery. That cascade never fired, and dead
        // rows do not depend on it anyway. Both are wired here.
        stats.expiredNotifications = await pruneExpired(sql);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        const deadPushCutoff = new Date(Date.now() - DEAD_PUSH_ROW_RETENTION_DAYS * 86_400_000);
        stats.deadPushRows = await pruneDeadPushRows(sql, deadPushCutoff);

        if (signal.aborted) {
            return earlyReturn(stats, errors, true);
        }

        // Fill media_items.sort_title for rows written without a key (the
        // 16.409.0 migration used to do this at boot). Capped per run, in short
        // batches with sync capture off; resumes on the next run.
        try {
            stats.backfilledSortTitles = await backfillSortTitles(sql, {
                maxRows: SORT_TITLE_BACKFILL_MAX_ROWS,
                maxMs: SORT_TITLE_BACKFILL_MAX_MS,
                signal,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('backfillSortTitles failed (non-fatal)', { reason: msg });
            errors.push(`backfill-sort-titles: ${msg}`);
        }

        const totalCleaned = sumStats(stats);
        const wasAborted = signal.aborted;

        if (totalCleaned > 0) {
            logger.info('Database cleanup completed', {
                ...stats,
                wasAborted,
                errorCount: errors.length,
            });
        }

        // False-success guard: `success` below is never read by the runner (it
        // only inspects thrown errors / stopReason to decide run outcome), so a
        // run that accumulated stage errors but never threw was always recorded
        // 'completed' and credited to the circuit breaker — silently hiding a
        // total outage (e.g. every stage failing against an unreachable DB
        // replica mid-run). Mirrors the total-outage gate already used by
        // curated-lists-sync / mdblist-sync / mal-anime-id-enrichment /
        // fribb-anime-sync / release-calendar-sync: only throw when NOTHING
        // useful got done (zero items cleaned) while errors piled up — a
        // genuine per-item best-effort miss (one bad stub, one bad hard-delete)
        // among otherwise-successful stages is expected noise, not a run
        // failure, and per this task's own docstring is intentionally
        // non-fatal. Aborts are excluded — they already return normally above.
        if (!wasAborted && errors.length > 0 && totalCleaned === 0) {
            throw new TaskError({
                message:
                    `database-cleanup: total failure — 0 items cleaned across ` +
                    `${errors.length} stage error(s): ${errors.slice(0, 3).join('; ')}` +
                    (errors.length > 3 ? ` (+${errors.length - 3} more)` : ''),
                kind: 'transient',
                cause: errors,
            });
        }

        return {
            success: errors.length === 0,
            itemsProcessed: totalCleaned,
            stopReason: wasAborted ? 'aborted' : undefined,
            result: {
                stats,
                errors,
                message: buildMessage(stats, wasAborted),
            },
        };
    },
});

registry.registerTask(databaseCleanupTask);

// =============================================================================
// Helpers
// =============================================================================

function sumStats(stats: CleanupStats): number {
    return (
        stats.mergedStubs +
        stats.mergedDuplicateArtists +
        stats.reclassifiedEpisodes +
        stats.orphanStubs +
        stats.healedDeadArtistRefs +
        stats.healedDanglingArtistTracks +
        stats.orphanMusicItems +
        stats.hardDeletedMedia +
        stats.orphanFiles +
        stats.staleSessions +
        stats.prunedMusicEvents +
        stats.purgedLivetvChannels +
        stats.purgedLivetvCategories +
        stats.expiredSuggestions +
        stats.expiredMediaFlags +
        stats.expiredRateLimits +
        stats.pruneClusterEvents +
        stats.pruneScannerRuns +
        stats.prunePluginFailures +
        stats.pruneSecretAccessLog +
        stats.pruneTranscodeFailures +
        stats.pruneLivetvFailures +
        stats.prunePlaybackIncidents +
        stats.pruneSegmentDeliveryFailures +
        stats.enforcePlaybackIncidentRowCap +
        stats.pruneClientDiagnostics +
        stats.pruneClientLogBundles +
        stats.enforceClientDiagnosticRowCap +
        stats.pruneAssistantMessages +
        stats.pruneChatMessages +
        stats.pruneTaskQuotaUsage +
        stats.pruneOutboxDelivered +
        stats.pruneEventOutboxConsumed +
        stats.pruneSyncChanges +
        stats.pruneTaskHistoryArchive +
        stats.pruneLivetvWatchHistory +
        stats.archivedMediaEvents +
        stats.purgedArchivedEvents +
        stats.purgedUploadSessions +
        stats.orphanedInteractions +
        stats.prunedSyncActivity +
        stats.expiredNotifications +
        stats.deadPushRows +
        stats.clearedStaleHasFiles +
        stats.backfilledSortTitles
    );
}

function buildMessage(stats: CleanupStats, wasAborted: boolean): string {
    const parts: string[] = [];
    if (stats.mergedStubs > 0) parts.push(`${stats.mergedStubs} merged stubs`);
    if (stats.mergedDuplicateArtists > 0)
        parts.push(`${stats.mergedDuplicateArtists} merged duplicate artists`);
    if (stats.skippedDuplicateArtists > 0)
        parts.push(`${stats.skippedDuplicateArtists} skipped artist merges`);
    if (stats.reclassifiedEpisodes > 0)
        parts.push(`${stats.reclassifiedEpisodes} misidentified episodes`);
    if (stats.orphanStubs > 0) parts.push(`${stats.orphanStubs} orphan stubs`);
    if (stats.healedDeadArtistRefs > 0)
        parts.push(`${stats.healedDeadArtistRefs} healed dead artist references`);
    if (stats.healedDanglingArtistTracks > 0)
        parts.push(`${stats.healedDanglingArtistTracks} tracks cleared of dangling artist ids`);
    if (stats.orphanMusicItems > 0) parts.push(`${stats.orphanMusicItems} orphan music items`);
    if (stats.hardDeletedMedia > 0) parts.push(`${stats.hardDeletedMedia} hard-deleted media`);
    if (stats.orphanFiles > 0) parts.push(`${stats.orphanFiles} orphan files`);
    if (stats.staleSessions > 0) parts.push(`${stats.staleSessions} stale sessions`);
    if (stats.prunedMusicEvents > 0) parts.push(`${stats.prunedMusicEvents} old music events`);
    if (stats.purgedLivetvChannels > 0)
        parts.push(`${stats.purgedLivetvChannels} archived livetv channels`);
    if (stats.purgedLivetvCategories > 0)
        parts.push(`${stats.purgedLivetvCategories} empty livetv categories`);
    if (stats.expiredSuggestions > 0) parts.push(`${stats.expiredSuggestions} expired suggestions`);
    if (stats.expiredMediaFlags > 0) parts.push(`${stats.expiredMediaFlags} expired media flags`);
    if (stats.expiredRateLimits > 0) parts.push(`${stats.expiredRateLimits} old rate limit rows`);
    if (stats.pruneClusterEvents > 0) parts.push(`${stats.pruneClusterEvents} cluster events`);
    if (stats.pruneScannerRuns > 0) parts.push(`${stats.pruneScannerRuns} scanner runs`);
    if (stats.prunePluginFailures > 0)
        parts.push(`${stats.prunePluginFailures} plugin failure events`);
    if (stats.pruneSecretAccessLog > 0)
        parts.push(`${stats.pruneSecretAccessLog} secret access log rows`);
    if (stats.pruneTranscodeFailures > 0)
        parts.push(`${stats.pruneTranscodeFailures} transcode failure events`);
    if (stats.pruneLivetvFailures > 0)
        parts.push(`${stats.pruneLivetvFailures} livetv failure events`);
    if (stats.prunePlaybackIncidents > 0)
        parts.push(`${stats.prunePlaybackIncidents} playback incident events`);
    if (stats.pruneSegmentDeliveryFailures > 0)
        parts.push(`${stats.pruneSegmentDeliveryFailures} segment delivery failures`);
    if (stats.enforcePlaybackIncidentRowCap > 0)
        parts.push(`${stats.enforcePlaybackIncidentRowCap} playback incident rows over cap`);
    if (stats.pruneClientDiagnostics > 0)
        parts.push(`${stats.pruneClientDiagnostics} client diagnostics`);
    if (stats.pruneClientLogBundles > 0)
        parts.push(`${stats.pruneClientLogBundles} client log bundles`);
    if (stats.enforceClientDiagnosticRowCap > 0)
        parts.push(`${stats.enforceClientDiagnosticRowCap} client diagnostics over cap`);
    if (stats.pruneAssistantMessages > 0)
        parts.push(`${stats.pruneAssistantMessages} assistant messages`);
    if (stats.pruneChatMessages > 0) parts.push(`${stats.pruneChatMessages} chat messages`);
    if (stats.pruneTaskQuotaUsage > 0) parts.push(`${stats.pruneTaskQuotaUsage} quota usage rows`);
    if (stats.pruneOutboxDelivered > 0)
        parts.push(`${stats.pruneOutboxDelivered} delivered webhook rows`);
    if (stats.pruneSyncChanges > 0) parts.push(`${stats.pruneSyncChanges} library sync changes`);
    if (stats.pruneEventOutboxConsumed > 0)
        parts.push(`${stats.pruneEventOutboxConsumed} consumed pipeline events`);
    if (stats.pruneTaskHistoryArchive > 0)
        parts.push(`${stats.pruneTaskHistoryArchive} task history archive rows`);
    if (stats.pruneLivetvWatchHistory > 0)
        parts.push(`${stats.pruneLivetvWatchHistory} livetv watch history rows`);
    if (stats.archivedMediaEvents > 0)
        parts.push(`${stats.archivedMediaEvents} media events archived`);
    if (stats.purgedArchivedEvents > 0)
        parts.push(`${stats.purgedArchivedEvents} archived media events purged`);
    if (stats.purgedUploadSessions > 0)
        parts.push(`${stats.purgedUploadSessions} expired upload sessions`);
    if (stats.orphanedInteractions > 0)
        parts.push(`${stats.orphanedInteractions} orphaned interactions`);
    if (stats.prunedSyncActivity > 0) parts.push(`${stats.prunedSyncActivity} sync activity rows`);
    if (stats.expiredNotifications > 0)
        parts.push(`${stats.expiredNotifications} expired notifications`);
    if (stats.deadPushRows > 0) parts.push(`${stats.deadPushRows} dead push rows`);
    if (stats.clearedStaleHasFiles > 0)
        parts.push(`${stats.clearedStaleHasFiles} stale has_files flags cleared`);
    if (stats.backfilledSortTitles > 0)
        parts.push(`${stats.backfilledSortTitles} sort titles filled`);

    if (parts.length === 0) {
        return wasAborted ? 'Cleanup aborted before any work' : 'No stale data found';
    }
    const prefix = wasAborted ? 'Aborted after cleaning' : 'Cleaned';
    return `${prefix}: ${parts.join(', ')}`;
}

function earlyReturn(
    stats: CleanupStats,
    errors: string[],
    wasAborted: boolean,
): {
    success: boolean;
    itemsProcessed: number;
    stopReason: 'aborted' | undefined;
    result: DatabaseCleanupResult;
} {
    return {
        success: errors.length === 0,
        itemsProcessed: sumStats(stats),
        stopReason: wasAborted ? 'aborted' : undefined,
        result: {
            stats,
            errors,
            message: buildMessage(stats, wasAborted),
        },
    };
}
