// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * database-cleanup task tests.
 *
 * These tests stub the query module so we can verify the task's
 * orchestration logic without a real database:
 *   - abort signal is honored between iterations
 *   - D5: pending-match stubs (files on disk) are excluded by the
 *     query module itself; the task just loops over whatever the
 *     query returns — so the safety guard is covered by the
 *     findMisidentifiedEpisodes integration test seed.
 *   - stats are summed correctly and placed inside result.stats
 *   - per-item errors in merge/reclassify/hardDelete loops are
 *     collected in result.errors and flip success to false
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import {
    CLIENT_DIAGNOSTICS_RETENTION_DAYS,
    CLIENT_LOG_BUNDLE_RETENTION_DAYS,
    CLIENT_DIAGNOSTICS_MAX_ROWS_PER_USER,
    PLAYBACK_INCIDENT_RETENTION_DAYS,
} from '$lib/server/config.js';

// Hoist mock refs so they can be used inside vi.mock() factories
const {
    backfillHasFilesMediaItems,
    clearStaleHasFilesMediaItems,
    findMergeStubCandidates,
    applyStubMerge,
    findMisidentifiedEpisodes,
    applyReclassify,
    softDeleteOrphanMediaStubs,
    // Heal pass for dead additional_artist_ids references (credit-only-artist follow-up).
    healDeadArtistReferences,
    healDanglingArtistIds,
    softDeleteOrphanMusicItems,
    // Production added autoMergeDuplicateArtists (2026-05-xx legacy duplicate artist merge).
    autoMergeDuplicateArtists,
    // Production added purgeStageStateForDeletedItems (2026-05-xx stage row GC).
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
    // Production added pruneConsumedEventOutbox (event_outbox table growth fix).
    pruneConsumedEventOutbox,
    pruneSyncChanges,
    pruneTaskHistoryArchive,
    pruneLivetvChannelWatchHistory,
    archiveOldUserMediaEvents,
    purgeOldArchivedMediaEvents,
} = vi.hoisted(() => ({
    backfillHasFilesMediaItems: vi.fn().mockResolvedValue(undefined),
    clearStaleHasFilesMediaItems: vi.fn().mockResolvedValue(0),
    findMergeStubCandidates: vi.fn(),
    applyStubMerge: vi.fn().mockResolvedValue(undefined),
    findMisidentifiedEpisodes: vi.fn(),
    applyReclassify: vi.fn().mockResolvedValue(undefined),
    softDeleteOrphanMediaStubs: vi.fn(),
    healDeadArtistReferences: vi.fn().mockResolvedValue(0),
    healDanglingArtistIds: vi.fn().mockResolvedValue({ tracks: 0, idsDropped: 0, failed: 0 }),
    softDeleteOrphanMusicItems: vi.fn(),
    autoMergeDuplicateArtists: vi.fn().mockResolvedValue({ merged: 0, skipped: 0 }),
    purgeStageStateForDeletedItems: vi.fn().mockResolvedValue(0),
    findHardDeletableMediaIds: vi.fn(),
    isHardDeletableMediaId: vi.fn(),
    cleanupOrphanedMediaFiles: vi.fn(),
    pruneOrphanedInteractionsMedia: vi.fn().mockResolvedValue(0),
    pruneOrphanedInteractionsPlaylist: vi.fn().mockResolvedValue(0),
    pruneOrphanedInteractionsPerson: vi.fn().mockResolvedValue(0),
    pruneOrphanedInteractionReactionsMedia: vi.fn().mockResolvedValue(0),
    pruneOrphanedInteractionReactionsPlaylist: vi.fn().mockResolvedValue(0),
    pruneOrphanedInteractionReactionsPerson: vi.fn().mockResolvedValue(0),
    pruneOldPlaySessions: vi.fn(),
    purgeExpiredUserSuggestions: vi.fn().mockResolvedValue(0),
    purgeExpiredUserMediaFlags: vi.fn().mockResolvedValue(0),
    purgeOldAssistantRateLimits: vi.fn().mockResolvedValue(0),
    pruneClusterNodeEvents: vi.fn().mockResolvedValue(0),
    pruneFileScannerRuns: vi.fn().mockResolvedValue(0),
    prunePluginFailureEvents: vi.fn().mockResolvedValue(0),
    prunePluginSecretAccessLog: vi.fn().mockResolvedValue(0),
    pruneAssistantMessages: vi.fn().mockResolvedValue(0),
    pruneCollaborativeChatMessages: vi.fn().mockResolvedValue(0),
    pruneTaskQuotaUsage: vi.fn().mockResolvedValue(0),
    pruneDeliveredWebhookOutbox: vi.fn().mockResolvedValue(0),
    pruneConsumedEventOutbox: vi.fn().mockResolvedValue(0),
    pruneSyncChanges: vi.fn().mockResolvedValue(0),
    pruneTaskHistoryArchive: vi.fn().mockResolvedValue(0),
    pruneLivetvChannelWatchHistory: vi.fn().mockResolvedValue(0),
    archiveOldUserMediaEvents: vi.fn().mockResolvedValue(0),
    purgeOldArchivedMediaEvents: vi.fn().mockResolvedValue(0),
}));

vi.mock('$lib/server/database/queries/database-cleanup.queries.js', () => ({
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
}));

const { hardDelete } = vi.hoisted(() => ({
    hardDelete: vi.fn().mockResolvedValue({ deleted: true }),
}));
vi.mock('$lib/server/services/media-deletion.service.js', () => ({
    MediaDeletionService: { hardDelete },
}));

const { pruneOldListenEvents } = vi.hoisted(() => ({
    pruneOldListenEvents: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/music-tracking.queries.js', () => ({
    pruneOldListenEvents,
}));

const { purgeArchivedChannels, purgeEmptyCategories } = vi.hoisted(() => ({
    purgeArchivedChannels: vi.fn().mockResolvedValue(0),
    purgeEmptyCategories: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/livetv-channels.queries.js', () => ({
    purgeArchivedChannels,
    purgeEmptyCategories,
}));

const { reapRenditions } = vi.hoisted(() => ({
    reapRenditions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/services/download-rendition/service.js', () => ({
    reapToCap: reapRenditions,
}));

const { cleanupExpiredUploadSessions } = vi.hoisted(() => ({
    cleanupExpiredUploadSessions: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/services/upload-session.service.js', () => ({
    cleanupExpiredUploadSessions,
}));

const { pruneSyncActivity } = vi.hoisted(() => ({
    pruneSyncActivity: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/watch-sync-activity.queries.js', () => ({
    pruneSyncActivity,
}));

const { pruneTranscodeFailureEvents } = vi.hoisted(() => ({
    pruneTranscodeFailureEvents: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/transcode-failure-events.queries.js', () => ({
    pruneTranscodeFailureEvents,
}));

const { pruneLiveTvFailureEvents } = vi.hoisted(() => ({
    pruneLiveTvFailureEvents: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/livetv-failure-events.queries.js', () => ({
    pruneLiveTvFailureEvents,
}));

const {
    prunePlaybackIncidentEvents,
    pruneLegacyPlaybackIncidentEvents,
    enforcePlaybackIncidentRowCap,
} = vi.hoisted(() => ({
    prunePlaybackIncidentEvents: vi.fn().mockResolvedValue(0),
    pruneLegacyPlaybackIncidentEvents: vi.fn().mockResolvedValue(0),
    enforcePlaybackIncidentRowCap: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/playback-incident-events.queries.js', () => ({
    prunePlaybackIncidentEvents,
    pruneLegacyPlaybackIncidentEvents,
    enforcePlaybackIncidentRowCap,
}));

const { pruneSegmentDeliveryFailures } = vi.hoisted(() => ({
    pruneSegmentDeliveryFailures: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/segment-delivery-failures.queries.js', () => ({
    pruneSegmentDeliveryFailures,
}));

const { pruneClientDiagnostics, enforceClientDiagnosticRowCap } = vi.hoisted(() => ({
    pruneClientDiagnostics: vi.fn().mockResolvedValue(0),
    enforceClientDiagnosticRowCap: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/client-diagnostics.queries.js', () => ({
    pruneClientDiagnostics,
    enforceClientDiagnosticRowCap,
}));

const { pruneExpired } = vi.hoisted(() => ({
    pruneExpired: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/user-notifications.queries.js', () => ({
    pruneExpired,
}));

const { pruneDeadPushRows } = vi.hoisted(() => ({
    pruneDeadPushRows: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/user-push-outbox.queries.js', () => ({
    pruneDeadPushRows,
}));

const { backfillSortTitles } = vi.hoisted(() => ({
    backfillSortTitles: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/database/queries/sort-title.queries.js', () => ({ backfillSortTitles }));

vi.mock('../../registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

import { databaseCleanupTask, pruneUntilDrained } from './database-cleanup.js';

type DatabaseCleanupInput = Record<string, unknown>;

function makeContext(input: DatabaseCleanupInput = {}): TaskContext<DatabaseCleanupInput> {
    const ac = new AbortController();
    return {
        sql: {} as never,
        logger: {
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        signal: ac.signal,
        input,
        runId: 'test-run',
        reportProgress: vi.fn(),
    } as unknown as TaskContext<DatabaseCleanupInput>;
}

describe('database-cleanup task', () => {
    it('sweeps abandoned rendition artifacts on scheduled cleanup without needing a new encode', async () => {
        await databaseCleanupTask.execute(makeContext());
        expect(reapRenditions).toHaveBeenCalled();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.DISABLE_DATABASE_CLEANUP;
        findMergeStubCandidates.mockResolvedValue([]);
        findMisidentifiedEpisodes.mockResolvedValue([]);
        softDeleteOrphanMediaStubs.mockResolvedValue(0);
        healDeadArtistReferences.mockResolvedValue(0);
        healDanglingArtistIds.mockResolvedValue({ tracks: 0, idsDropped: 0, failed: 0 });
        softDeleteOrphanMusicItems.mockResolvedValue(0);
        // Production added autoMergeDuplicateArtists and purgeStageStateForDeletedItems.
        autoMergeDuplicateArtists.mockResolvedValue({ merged: 0, skipped: 0 });
        purgeStageStateForDeletedItems.mockResolvedValue(0);
        findHardDeletableMediaIds.mockResolvedValue([]);
        cleanupOrphanedMediaFiles.mockResolvedValue(0);
        pruneOldPlaySessions.mockResolvedValue(0);
        pruneOldListenEvents.mockResolvedValue(0);
        purgeArchivedChannels.mockResolvedValue(0);
        purgeEmptyCategories.mockResolvedValue(0);
        purgeExpiredUserSuggestions.mockResolvedValue(0);
        purgeExpiredUserMediaFlags.mockResolvedValue(0);
        purgeOldAssistantRateLimits.mockResolvedValue(0);
        pruneClusterNodeEvents.mockResolvedValue(0);
        pruneFileScannerRuns.mockResolvedValue(0);
        prunePluginFailureEvents.mockResolvedValue(0);
        prunePluginSecretAccessLog.mockResolvedValue(0);
        pruneTranscodeFailureEvents.mockResolvedValue(0);
        pruneLiveTvFailureEvents.mockResolvedValue(0);
        prunePlaybackIncidentEvents.mockResolvedValue(0);
        pruneLegacyPlaybackIncidentEvents.mockResolvedValue(0);
        pruneSegmentDeliveryFailures.mockResolvedValue(0);
        enforcePlaybackIncidentRowCap.mockResolvedValue(0);
        pruneClientDiagnostics.mockResolvedValue(0);
        enforceClientDiagnosticRowCap.mockResolvedValue(0);
        pruneAssistantMessages.mockResolvedValue(0);
        pruneCollaborativeChatMessages.mockResolvedValue(0);
        pruneTaskQuotaUsage.mockResolvedValue(0);
        pruneDeliveredWebhookOutbox.mockResolvedValue(0);
        // Production added pruneConsumedEventOutbox.
        pruneConsumedEventOutbox.mockResolvedValue(0);
        pruneSyncChanges.mockResolvedValue(0);
        pruneTaskHistoryArchive.mockResolvedValue(0);
        pruneLivetvChannelWatchHistory.mockResolvedValue(0);
        archiveOldUserMediaEvents.mockResolvedValue(0);
        purgeOldArchivedMediaEvents.mockResolvedValue(0);
        pruneExpired.mockResolvedValue(0);
        pruneDeadPushRows.mockResolvedValue(0);
        backfillSortTitles.mockResolvedValue(0);
    });

    it('runs the sort_title backfill with a row and time budget and reports the rows filled', async () => {
        backfillSortTitles.mockResolvedValue(42);
        const ctx = makeContext();
        const result = await databaseCleanupTask.execute(ctx);
        expect(backfillSortTitles).toHaveBeenCalledTimes(1);
        const [sqlArg, budget] = backfillSortTitles.mock.calls[0];
        expect(sqlArg).toBe(ctx.sql);
        expect(budget).toMatchObject({ maxRows: 100_000, maxMs: 120_000, signal: ctx.signal });
        expect(result.result?.stats.backfilledSortTitles).toBe(42);
        expect(result.itemsProcessed).toBe(42);
        expect(result.result?.message).toContain('42 sort titles filled');
    });

    it('treats a failing sort_title backfill as a non-fatal stage error', async () => {
        backfillSortTitles.mockRejectedValue(new Error('boom'));
        // Another stage did work, so the total-failure guard does not throw.
        pruneDeadPushRows.mockResolvedValue(1);
        const result = await databaseCleanupTask.execute(makeContext());
        expect(result.success).toBe(false);
        expect(result.result?.errors).toContain('backfill-sort-titles: boom');
    });

    it('runs the dangling artist id heal with the task signal and reports the tracks cleared', async () => {
        healDanglingArtistIds.mockResolvedValue({ tracks: 5, idsDropped: 6, failed: 0 });
        const ctx = makeContext();
        const result = await databaseCleanupTask.execute(ctx);
        expect(healDanglingArtistIds).toHaveBeenCalledWith(ctx.sql, { signal: ctx.signal });
        expect(result.result?.stats.healedDanglingArtistTracks).toBe(5);
        expect(result.result?.message).toContain('5 tracks cleared of dangling artist ids');
    });

    it('treats a failing dangling artist id heal as a non-fatal stage error', async () => {
        healDanglingArtistIds.mockRejectedValue(new Error('boom'));
        pruneDeadPushRows.mockResolvedValue(1);
        const result = await databaseCleanupTask.execute(makeContext());
        expect(result.result?.errors).toContain('heal-dangling-artist-ids: boom');
    });

    it('runs all cleanup steps and reports empty result', async () => {
        const result = await databaseCleanupTask.execute(makeContext());
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(backfillHasFilesMediaItems).toHaveBeenCalled();
        expect(findMergeStubCandidates).toHaveBeenCalled();
        expect(findMisidentifiedEpisodes).toHaveBeenCalled();
        expect(softDeleteOrphanMediaStubs).toHaveBeenCalled();
        expect(cleanupOrphanedMediaFiles).toHaveBeenCalled();
        expect(pruneOldPlaySessions).toHaveBeenCalled();
        expect(pruneOldListenEvents).toHaveBeenCalled();
        expect(purgeExpiredUserSuggestions).toHaveBeenCalled();
        expect(purgeExpiredUserMediaFlags).toHaveBeenCalled();
        expect(purgeOldAssistantRateLimits).toHaveBeenCalled();
        expect(pruneClusterNodeEvents).toHaveBeenCalled();
        expect(pruneFileScannerRuns).toHaveBeenCalled();
        expect(prunePluginFailureEvents).toHaveBeenCalled();
        expect(pruneTranscodeFailureEvents).toHaveBeenCalled();
        expect(pruneLiveTvFailureEvents).toHaveBeenCalled();
        expect(prunePluginSecretAccessLog).toHaveBeenCalled();
        expect(pruneAssistantMessages).toHaveBeenCalled();
        expect(pruneCollaborativeChatMessages).toHaveBeenCalled();
        expect(pruneTaskQuotaUsage).toHaveBeenCalled();
        expect(pruneDeliveredWebhookOutbox).toHaveBeenCalled();
        expect(pruneTaskHistoryArchive).toHaveBeenCalled();
        expect(pruneLivetvChannelWatchHistory).toHaveBeenCalled();
        expect(archiveOldUserMediaEvents).toHaveBeenCalled();
        expect(purgeOldArchivedMediaEvents).toHaveBeenCalled();
    });

    // `pruneExpired` documented since it was written that "a background task
    // invokes it" and NOTHING in src/ ever did — so expired notifications were
    // never removed, and neither were the push outbox rows that cascade off
    // them. Dead outbox rows had no pruner at all, which matters most on a
    // misconfigured install where every row dies.
    it('prunes expired notifications and dead push outbox rows', async () => {
        pruneExpired.mockResolvedValue(4);
        pruneDeadPushRows.mockResolvedValue(3);

        const result = await databaseCleanupTask.execute(makeContext());

        expect(pruneExpired).toHaveBeenCalledTimes(1);
        expect(pruneDeadPushRows).toHaveBeenCalledTimes(1);
        expect(result.result?.stats.expiredNotifications).toBe(4);
        expect(result.result?.stats.deadPushRows).toBe(3);
        // Counted in the task's own total, so an operator sees the work.
        expect(result.itemsProcessed).toBe(7);
        expect(result.result?.message).toContain('4 expired notifications');
        expect(result.result?.message).toContain('3 dead push rows');
    });

    it('prunes dead push rows against a cutoff in the past, not now', async () => {
        // A `new Date()` cutoff would delete a row the instant it died, taking
        // the diagnosis with it.
        await databaseCleanupTask.execute(makeContext());

        const cutoff = pruneDeadPushRows.mock.calls[0][1] as Date;
        expect(cutoff.getTime()).toBeLessThan(Date.now());
        expect(cutoff.getTime()).toBeGreaterThan(Date.now() - 8 * 86_400_000);
    });

    it('applies stub merges and reclassifies misidentified items', async () => {
        findMergeStubCandidates.mockResolvedValue([
            { stub_id: 'stub-1', canonical_id: 'canon-1' },
            { stub_id: 'stub-2', canonical_id: 'canon-2' },
        ]);
        findMisidentifiedEpisodes.mockResolvedValue([{ stub_id: 'mis-1' }]);

        const result = await databaseCleanupTask.execute(makeContext());

        expect(applyStubMerge).toHaveBeenCalledTimes(2);
        expect(applyReclassify).toHaveBeenCalledTimes(1);
        expect(result.itemsProcessed).toBe(3);
        expect(result.result).toBeDefined();
        expect(result.result!.stats.mergedStubs).toBe(2);
        expect(result.result!.stats.reclassifiedEpisodes).toBe(1);
    });

    it('honors abortSignal inside the merge loop', async () => {
        const ac = new AbortController();
        findMergeStubCandidates.mockResolvedValue([
            { stub_id: 'stub-1', canonical_id: 'canon-1' },
            { stub_id: 'stub-2', canonical_id: 'canon-2' },
            { stub_id: 'stub-3', canonical_id: 'canon-3' },
        ]);
        applyStubMerge.mockImplementation(async () => {
            ac.abort();
        });

        const ctx = {
            sql: {} as never,
            logger: {
                info: vi.fn(),
                debug: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
            },
            signal: ac.signal,
            input: {},
            runId: 'test-run',
            reportProgress: vi.fn(),
        } as unknown as TaskContext<DatabaseCleanupInput>;

        const result = await databaseCleanupTask.execute(ctx);

        // First merge ran, then abort kicked in before the second iteration
        expect(applyStubMerge).toHaveBeenCalledTimes(1);
        // Early return should not trigger downstream work
        expect(softDeleteOrphanMediaStubs).not.toHaveBeenCalled();
        expect(result.stopReason).toBe('aborted');
        expect(result.result).toBeDefined();
        expect(result.result!.message).toContain('Aborted');
    });

    it('continues hard-deletion past an individual failure and reports error', async () => {
        findHardDeletableMediaIds.mockResolvedValue(['a', 'b', 'c']);
        hardDelete
            .mockResolvedValueOnce({ deleted: true })
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce({ deleted: true });

        const result = await databaseCleanupTask.execute(makeContext());
        expect(hardDelete).toHaveBeenCalledTimes(3);
        // Two succeeded, one failed — success is false due to errors array
        expect(result.success).toBe(false);
        expect(result.result).toBeDefined();
        expect(result.result!.stats.hardDeletedMedia).toBe(2);
        expect(result.result!.errors).toHaveLength(1);
        expect(result.result!.errors[0]).toContain('boom');
    });

    it('rechecks legacy purge eligibility in the delete transaction for the same id', async () => {
        findHardDeletableMediaIds.mockResolvedValue(['a']);
        isHardDeletableMediaId.mockResolvedValue(true);
        hardDelete.mockResolvedValueOnce({ deleted: true });

        await databaseCleanupTask.execute(makeContext());

        expect(hardDelete).toHaveBeenCalledWith(
            expect.anything(),
            'a',
            expect.objectContaining({ guardFileBacked: true, eligibility: expect.any(Function) }),
        );
        const opts = hardDelete.mock.calls.at(-1)?.[2] as {
            eligibility: (tx: unknown) => Promise<boolean>;
        };
        const tx = {};
        await expect(opts.eligibility(tx)).resolves.toBe(true);
        expect(isHardDeletableMediaId).toHaveBeenCalledWith(tx, 'a', expect.any(Date));
        const cutoff = isHardDeletableMediaId.mock.calls.at(-1)?.[2] as Date;
        expect(cutoff.getTime()).toBeLessThan(Date.now() - 29 * 86400000);
    });

    it('counts lock contention during a legacy purge as a skip, not an error', async () => {
        findHardDeletableMediaIds.mockResolvedValue(['a', 'b', 'c', 'd']);
        hardDelete
            .mockRejectedValueOnce(Object.assign(new Error('lock'), { code: '55P03' }))
            .mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }))
            .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: '57014' }))
            .mockResolvedValueOnce({ deleted: true });

        const result = await databaseCleanupTask.execute(makeContext());

        expect(result.result!.stats.skippedFileBackedHardDeletes).toBe(3);
        expect(result.result!.stats.hardDeletedMedia).toBe(1);
        expect(result.result!.errors).toEqual([]);
    });

    it('continues merge loop past an individual applyStubMerge failure and reports error', async () => {
        findMergeStubCandidates.mockResolvedValue([
            { stub_id: 'stub-1', canonical_id: 'canon-1' },
            { stub_id: 'stub-2', canonical_id: 'canon-2' },
        ]);
        applyStubMerge
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('constraint violation'));

        const result = await databaseCleanupTask.execute(makeContext());

        expect(applyStubMerge).toHaveBeenCalledTimes(2);
        expect(result.result!.stats.mergedStubs).toBe(1);
        expect(result.result!.errors).toHaveLength(1);
        expect(result.result!.errors[0]).toContain('stub-merge stub-2');
        expect(result.success).toBe(false);
    });

    it('continues reclassify loop past an individual applyReclassify failure and reports error', async () => {
        findMisidentifiedEpisodes.mockResolvedValue([{ stub_id: 'mis-1' }, { stub_id: 'mis-2' }]);
        applyReclassify
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('fk error'));

        const result = await databaseCleanupTask.execute(makeContext());

        expect(applyReclassify).toHaveBeenCalledTimes(2);
        expect(result.result!.stats.reclassifiedEpisodes).toBe(1);
        expect(result.result!.errors).toHaveLength(1);
        expect(result.result!.errors[0]).toContain('reclassify mis-2');
        expect(result.success).toBe(false);
    });

    it('throws when the overall pipeline throws (no outer try/catch)', async () => {
        backfillHasFilesMediaItems.mockRejectedValueOnce(new Error('database down'));
        await expect(databaseCleanupTask.execute(makeContext())).rejects.toThrow('database down');
    });

    it('throws a transient TaskError when the run cleaned zero items but accumulated stage errors (false-success guard)', async () => {
        // Every stub-merge attempt fails and nothing else in the run produces
        // any cleaned items — this is the "total outage" shape (e.g. every
        // stage failing against an unreachable DB replica mid-run) that must
        // NOT be recorded as a completed run, since the runner never reads
        // `result.success` and would otherwise credit the circuit breaker.
        findMergeStubCandidates.mockResolvedValue([
            { stub_id: 'stub-1', canonical_id: 'canon-1' },
            { stub_id: 'stub-2', canonical_id: 'canon-2' },
        ]);
        applyStubMerge.mockRejectedValue(new Error('total outage'));

        await expect(databaseCleanupTask.execute(makeContext())).rejects.toThrow(
            /database-cleanup: total failure — 0 items cleaned/,
        );
    });

    it('does NOT throw when some stages produced work even though others errored (partial success)', async () => {
        // Sanity check for the false-success guard's boundary: partial success
        // (some stats > 0) alongside errors must keep returning normally —
        // this is the existing "per-item best-effort miss" behavior the
        // task's own docstring documents as intentional and non-fatal.
        findHardDeletableMediaIds.mockResolvedValue(['a', 'b']);
        hardDelete
            .mockResolvedValueOnce({ deleted: true })
            .mockRejectedValueOnce(new Error('boom'));

        const result = await databaseCleanupTask.execute(makeContext());
        expect(result.result!.stats.hardDeletedMedia).toBe(1);
        expect(result.result!.errors).toHaveLength(1);
    });

    it('returns early with disabled message when DISABLE_DATABASE_CLEANUP is true', async () => {
        process.env.DISABLE_DATABASE_CLEANUP = 'true';
        const result = await databaseCleanupTask.execute(makeContext());
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(result.result).toBeDefined();
        expect(result.result!.message).toContain('DISABLE_DATABASE_CLEANUP');
        expect(backfillHasFilesMediaItems).not.toHaveBeenCalled();
    });

    it('accepts DISABLE_DATABASE_CLEANUP=TRUE (case-insensitive)', async () => {
        process.env.DISABLE_DATABASE_CLEANUP = 'TRUE';
        const result = await databaseCleanupTask.execute(makeContext());
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(backfillHasFilesMediaItems).not.toHaveBeenCalled();
    });

    it('places stats inside result.stats and message inside result.message', async () => {
        softDeleteOrphanMediaStubs.mockResolvedValue(5);
        pruneOldPlaySessions.mockResolvedValue(3);

        const result = await databaseCleanupTask.execute(makeContext());

        expect(result.result).toBeDefined();
        expect(result.result!.stats.orphanStubs).toBe(5);
        expect(result.result!.stats.staleSessions).toBe(3);
        expect(result.itemsProcessed).toBe(8);
        expect(typeof result.result!.message).toBe('string');
    });

    it('reports expired suggestions and media flags in stats', async () => {
        purgeExpiredUserSuggestions.mockResolvedValue(12);
        purgeExpiredUserMediaFlags.mockResolvedValue(7);

        const result = await databaseCleanupTask.execute(makeContext());

        expect(result.result!.stats.expiredSuggestions).toBe(12);
        expect(result.result!.stats.expiredMediaFlags).toBe(7);
        expect(result.itemsProcessed).toBeGreaterThanOrEqual(19);
        expect(result.result!.message).toContain('12 expired suggestions');
        expect(result.result!.message).toContain('7 expired media flags');
    });

    it('reports audit log cleanup counts', async () => {
        pruneClusterNodeEvents.mockResolvedValue(50);
        pruneFileScannerRuns.mockResolvedValue(20);
        prunePluginFailureEvents.mockResolvedValue(100);
        prunePluginSecretAccessLog.mockResolvedValue(30);
        pruneTranscodeFailureEvents.mockResolvedValue(15);

        const result = await databaseCleanupTask.execute(makeContext());

        expect(result.result!.stats.pruneClusterEvents).toBe(50);
        expect(result.result!.stats.pruneScannerRuns).toBe(20);
        expect(result.result!.stats.prunePluginFailures).toBe(100);
        expect(result.result!.stats.pruneSecretAccessLog).toBe(30);
        expect(result.result!.stats.pruneTranscodeFailures).toBe(15);
        expect(result.itemsProcessed).toBeGreaterThanOrEqual(215);
    });

    it('prunes playback incident events older than retention and enforces the row cap', async () => {
        prunePlaybackIncidentEvents.mockResolvedValue(3);
        enforcePlaybackIncidentRowCap.mockResolvedValue(2);

        const result = await databaseCleanupTask.execute(makeContext());

        expect(prunePlaybackIncidentEvents).toHaveBeenCalled();
        expect(enforcePlaybackIncidentRowCap).toHaveBeenCalled();
        expect(result.result!.stats.prunePlaybackIncidents).toBe(3);
        expect(result.result!.stats.enforcePlaybackIncidentRowCap).toBe(2);
        expect(result.result!.message).toContain('3 playback incident events');
        expect(result.result!.message).toContain('2 playback incident rows over cap');
    });

    it('prunes the frozen legacy playback_incident_events table on the incident retention window', async () => {
        prunePlaybackIncidentEvents.mockResolvedValue(3);
        pruneLegacyPlaybackIncidentEvents.mockResolvedValue(4);

        const before = Date.now();
        const result = await databaseCleanupTask.execute(makeContext());

        expect(pruneLegacyPlaybackIncidentEvents).toHaveBeenCalled();
        const [sqlArg, cutoff, limit] = pruneLegacyPlaybackIncidentEvents.mock.calls[0];
        expect(sqlArg).toBeDefined();
        expect(cutoff).toBeInstanceOf(Date);
        expect((cutoff as Date).getTime()).toBeCloseTo(
            before - PLAYBACK_INCIDENT_RETENTION_DAYS * 86_400_000,
            -3,
        );
        expect(limit).toBe(50_000);
        // Counted into the same stat as the client_diagnostics incident prune.
        expect(result.result!.stats.prunePlaybackIncidents).toBe(7);
    });

    it('prunes client diagnostics and log bundles past retention and enforces the row cap', async () => {
        pruneClientDiagnostics.mockResolvedValueOnce(5).mockResolvedValueOnce(2);
        enforceClientDiagnosticRowCap.mockResolvedValue(1);

        const before = Date.now();
        const result = await databaseCleanupTask.execute(makeContext());

        // First call: the automatic-kind family, with a cutoff derived from
        // CLIENT_DIAGNOSTICS_RETENTION_DAYS.
        expect(pruneClientDiagnostics).toHaveBeenCalledTimes(2);
        const [firstSql, firstKinds, firstCutoff, firstLimit] =
            pruneClientDiagnostics.mock.calls[0];
        expect(firstSql).toBeDefined();
        expect(firstKinds).toEqual([
            'crash',
            'hang',
            'js_error',
            'api_failures',
            'compat_incident',
        ]);
        expect(firstCutoff).toBeInstanceOf(Date);
        expect((firstCutoff as Date).getTime()).toBeCloseTo(
            before - CLIENT_DIAGNOSTICS_RETENTION_DAYS * 86_400_000,
            -3,
        );
        expect(firstLimit).toBe(50_000);

        // Second call: log_bundle rows carry a blob, so a smaller batch (1000).
        const [, secondKinds, secondCutoff, secondLimit] = pruneClientDiagnostics.mock.calls[1];
        expect(secondKinds).toEqual(['log_bundle']);
        expect(secondCutoff).toBeInstanceOf(Date);
        expect((secondCutoff as Date).getTime()).toBeCloseTo(
            before - CLIENT_LOG_BUNDLE_RETENTION_DAYS * 86_400_000,
            -3,
        );
        expect(secondLimit).toBe(1_000);

        expect(enforceClientDiagnosticRowCap).toHaveBeenCalledWith(
            expect.anything(),
            ['crash', 'hang', 'js_error', 'api_failures', 'log_bundle', 'compat_incident'],
            CLIENT_DIAGNOSTICS_MAX_ROWS_PER_USER,
            expect.any(Number),
        );

        expect(result.result!.stats.pruneClientDiagnostics).toBe(5);
        expect(result.result!.stats.pruneClientLogBundles).toBe(2);
        expect(result.result!.stats.enforceClientDiagnosticRowCap).toBe(1);
        expect(result.result!.message).toContain('5 client diagnostics');
        expect(result.result!.message).toContain('2 client log bundles');
        expect(result.result!.message).toContain('1 client diagnostics over cap');
    });

    it('prunes segment delivery failures older than retention', async () => {
        pruneSegmentDeliveryFailures.mockResolvedValue(4);

        const result = await databaseCleanupTask.execute(makeContext());

        expect(pruneSegmentDeliveryFailures).toHaveBeenCalled();
        expect(result.result!.stats.pruneSegmentDeliveryFailures).toBe(4);
        expect(result.result!.message).toContain('4 segment delivery failures');
    });

    it('reports chat and AI message cleanup', async () => {
        pruneAssistantMessages.mockResolvedValue(300);
        pruneCollaborativeChatMessages.mockResolvedValue(150);

        const result = await databaseCleanupTask.execute(makeContext());

        expect(result.result!.stats.pruneAssistantMessages).toBe(300);
        expect(result.result!.stats.pruneChatMessages).toBe(150);
        expect(result.result!.message).toContain('300 assistant messages');
        expect(result.result!.message).toContain('150 chat messages');
    });

    it('reports task system cleanup counts', async () => {
        pruneTaskQuotaUsage.mockResolvedValue(60);
        pruneDeliveredWebhookOutbox.mockResolvedValue(25);
        pruneTaskHistoryArchive.mockResolvedValue(10);

        const result = await databaseCleanupTask.execute(makeContext());

        expect(result.result!.stats.pruneTaskQuotaUsage).toBe(60);
        expect(result.result!.stats.pruneOutboxDelivered).toBe(25);
        expect(result.result!.stats.pruneTaskHistoryArchive).toBe(10);
    });

    it('reports livetv watch history cleanup', async () => {
        pruneLivetvChannelWatchHistory.mockResolvedValue(1000);

        const result = await databaseCleanupTask.execute(makeContext());

        expect(result.result!.stats.pruneLivetvWatchHistory).toBe(1000);
        expect(result.result!.message).toContain('1000 livetv watch history rows');
    });

    it('archives and purges user_media_events', async () => {
        archiveOldUserMediaEvents.mockResolvedValue(500);
        purgeOldArchivedMediaEvents.mockResolvedValue(200);

        const result = await databaseCleanupTask.execute(makeContext());

        expect(result.result!.stats.archivedMediaEvents).toBe(500);
        expect(result.result!.stats.purgedArchivedEvents).toBe(200);
        expect(result.result!.message).toContain('500 media events archived');
        expect(result.result!.message).toContain('200 archived media events purged');
    });

    it('passes cutoff Dates (not numbers) to new query functions', async () => {
        await databaseCleanupTask.execute(makeContext());

        const [, clusterCutoff] = pruneClusterNodeEvents.mock.calls[0];
        expect(clusterCutoff).toBeInstanceOf(Date);

        const [, archiveCutoff] = archiveOldUserMediaEvents.mock.calls[0];
        expect(archiveCutoff).toBeInstanceOf(Date);
    });
});

describe('pruneUntilDrained (unbounded-growth fix)', () => {
    const cutoff = new Date();

    it('loops until a pass deletes fewer than the batch size (drained)', async () => {
        const fn = vi
            .fn()
            .mockResolvedValueOnce(10_000)
            .mockResolvedValueOnce(10_000)
            .mockResolvedValueOnce(42); // partial batch ⇒ drained
        const signal = new AbortController().signal;

        const total = await pruneUntilDrained(fn as never, {} as never, cutoff, signal, 10_000);

        expect(fn).toHaveBeenCalledTimes(3);
        expect(total).toBe(20_042);
    });

    it('stops at the abort signal (task timeout) without draining', async () => {
        const ac = new AbortController();
        const fn = vi.fn(async () => {
            ac.abort();
            return 10_000; // full batch — would otherwise loop forever
        });

        const total = await pruneUntilDrained(fn as never, {} as never, cutoff, ac.signal, 10_000);

        expect(fn).toHaveBeenCalledTimes(1); // next pass sees aborted signal and breaks
        expect(total).toBe(10_000);
    });
});
