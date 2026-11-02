// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MDBList Sync Generator
 *
 * Wraps MDBList sync functionality to work with task endpoint factory pattern.
 * Syncs ratings from MDBList using batch API for efficiency.
 */

import type postgres from 'postgres';
import { BaseProgressGenerator, type GenerationProgress } from './embedding-utils';
import { Logger } from '../utils/logger';
import {
    syncMDBListRatings,
    getMDBListSyncStatus,
    type MDBListSyncOptions,
    type MDBListSyncResult,
    type MDBListSyncProgress,
} from './mdblist-sync';

const logger = Logger.for('MDBListSyncGenerator');

export interface MDBListSyncGeneratorOptions {
    /** Task-pool handle forwarded to syncMDBListRatings (`ctx.sql` from the task). */
    sql?: postgres.Sql | null;
    limit?: number;
    mediaType?: 'movie' | 'tv' | 'all';
    fullRefresh?: boolean;
    refreshAfterHours?: number;
    /** Forwarded to syncMDBListRatings → invokeProviderBatchLookup. */
    signal?: AbortSignal;
    /**
     * Optional callback invoked after each item's MDBList data is successfully
     * stored. Used by the task wrapper to write a coverage-table completion
     * row. Forwarded to syncMDBListRatings unchanged.
     */
    onSuccess?: (mediaId: string) => Promise<void>;
    /**
     * Optional callback invoked when upstream returns no MDBList data for
     * an item. Used by the task wrapper to tombstone the coverage row so
     * the same null-result item doesn't cycle through every slice forever.
     */
    onSkip?: (mediaId: string) => Promise<void>;
    /**
     * Optional override for the candidate query. Forwarded to
     * syncMDBListRatings unchanged.
     */
    candidateSource?: (sql: postgres.Sql, limit: number) => Promise<Array<{ id: string }>>;
    /**
     * Stage ID associated with `candidateSource`. Forwarded to
     * syncMDBListRatings so it can reconcile drift via
     * `markSkippedTransientBatch`.
     */
    stageId?: string;
}

export class MDBListSyncGenerator extends BaseProgressGenerator {
    private options: MDBListSyncGeneratorOptions;
    private syncResult: MDBListSyncResult | null = null;
    private progress: GenerationProgress;

    constructor(options: MDBListSyncGeneratorOptions = {}) {
        super();
        this.options = options;
        this.initProgress('Initializing MDBList sync...');
        this.progress = this.currentProgress!;
    }

    override async abort(): Promise<void> {
        logger.info('Aborting MDBList sync');
        await super.abort('Sync aborted by user');
    }

    override getProgress(): GenerationProgress {
        // Update progress percentage
        if (this.progress.totalItems > 0) {
            this.progress.progressPercentage = Math.round(
                (this.progress.processedItems / this.progress.totalItems) * 100,
            );
        }
        this.progress.errorCount = this.progress.errors.length;
        return { ...this.progress };
    }

    /**
     * Run the MDBList sync with progress tracking
     */
    async sync(): Promise<MDBListSyncResult> {
        logger.info('Starting MDBList sync', this.options);
        this.progress.phase = 'fetching';
        this.progress.recentLogs.push('Starting MDBList batch sync...');

        try {
            // Get sync status first. Only the two counts below are used, so skip the
            // sample-items query (a full provider_metadata scan + sort, ~0.5 s on prod).
            const status = await getMDBListSyncStatus(false);
            this.progress.recentLogs.push(
                `Database status: ${status.total_items} items, ${status.without_mdblist} missing MDBList data`,
            );

            // Prepare sync options
            const syncOptions: MDBListSyncOptions = {
                sql: this.options.sql,
                limit: this.options.limit,
                mediaType: this.options.mediaType || 'all',
                onlyMissing: !this.options.fullRefresh,
                refreshAfterHours: this.options.refreshAfterHours || 168, // 1 week
                delayMs: 500, // 500ms between batches
                signal: this.options.signal,
                onSuccess: this.options.onSuccess,
                onSkip: this.options.onSkip,
                candidateSource: this.options.candidateSource,
                stageId: this.options.stageId,
            };

            this.progress.recentLogs.push(
                `Options: limit=${syncOptions.limit || 'all'}, type=${syncOptions.mediaType}, missing_only=${syncOptions.onlyMissing}`,
            );

            // Run sync with progress callback
            const result = await syncMDBListRatings(
                syncOptions,
                (mdbProgress: MDBListSyncProgress) => {
                    // Abort check
                    if (this.aborted) {
                        throw new Error('Sync aborted by user');
                    }

                    // Update progress
                    this.progress.totalItems = mdbProgress.total;
                    this.progress.processedItems = mdbProgress.processed;
                    this.progress.updated = mdbProgress.updated;
                    this.progress.skipped = mdbProgress.skipped;
                    this.progress.errorCount = mdbProgress.errors;

                    // Update phase (map to GenerationProgress phases)
                    switch (mdbProgress.phase) {
                        case 'querying':
                            this.progress.phase = 'fetching';
                            this.progress.currentItem = 'Querying database for items...';
                            break;
                        case 'fetching':
                            this.progress.phase = 'fetching';
                            this.progress.currentItem = mdbProgress.currentBatch
                                ? `Fetching batch ${mdbProgress.currentBatch}/${mdbProgress.totalBatches} from MDBList...`
                                : 'Fetching from MDBList...';
                            break;
                        case 'updating':
                            this.progress.phase = 'generating';
                            this.progress.currentItem = `Updating database (${mdbProgress.updated} updated)...`;
                            break;
                        case 'completed':
                            this.progress.phase = 'completed';
                            this.progress.currentItem = 'Sync completed';
                            break;
                        case 'error':
                            this.progress.phase = 'error';
                            this.progress.currentItem = 'Sync failed';
                            break;
                    }

                    // Update recent logs
                    if (mdbProgress.eta) {
                        const lastLog =
                            this.progress.recentLogs[this.progress.recentLogs.length - 1];
                        if (!lastLog?.startsWith('ETA:')) {
                            this.progress.recentLogs.push(`ETA: ${mdbProgress.eta}`);
                        } else {
                            this.progress.recentLogs[this.progress.recentLogs.length - 1] =
                                `ETA: ${mdbProgress.eta}`;
                        }
                    }
                },
            );

            this.syncResult = result;

            // Log final results
            this.progress.recentLogs.push(
                `Completed: ${result.updated} updated, ${result.skipped} skipped, ${result.errors.length} errors`,
            );
            this.progress.recentLogs.push(`Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);

            if (result.errors.length > 0) {
                // Add first few errors to logs
                result.errors.slice(0, 5).forEach((err) => {
                    this.progress.errors.push(err);
                });
                if (result.errors.length > 5) {
                    this.progress.recentLogs.push(
                        `... and ${result.errors.length - 5} more errors`,
                    );
                }
            }

            this.progress.phase = result.errors.length > 10 ? 'error' : 'completed';
            logger.info('MDBList sync completed', {
                processed: result.processed,
                updated: result.updated,
                errors: result.errors.length,
            });

            return result;
        } catch (error) {
            const errorMsg = (error as Error).message;
            logger.error('MDBList sync failed', error as Error);
            this.progress.phase = 'error';
            this.progress.errors.push(errorMsg);
            this.progress.recentLogs.push(`Error: ${errorMsg}`);

            return {
                processed: this.progress.processedItems,
                updated: this.progress.updated,
                skipped: this.progress.skipped,
                errors: [errorMsg, ...this.progress.errors],
                duration_ms: Date.now() - this.progress.startTime.getTime(),
                requestCount: 0,
                // sync() itself threw before/inside the batch loop — treat every
                // item counted so far as fallback so the task's outage guard
                // (`processedViaFallback === processed && updated === 0`) fires
                // when nothing was stored. When some items DID update, `updated`
                // stays > 0 and the guard correctly holds off.
                processedViaFallback: this.progress.processedItems,
            };
        }
    }
}
