// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native maintenance task: embedding-reset.
 *
 * Backs `POST /api/ai/reset-embeddings`. For a given source it DELETEs the
 * embedding artifacts AND re-enrolls the matching embedding stage(s) so the
 * `missingOnly` generators rebuild them — atomically, in one transaction.
 *
 * Why a background task (not inline in the request): a large source
 * (~76k rows) deletes slower than the 60s HTTP client timeout, so the inline
 * DELETE never committed (the request aborted and rolled back). Running here
 * removes the HTTP deadline (45m task budget) and makes the reset restartable.
 *
 * Why re-enroll (the actual bug this fixes): the embedding backlog is driven by
 * `media_item_stage_state.status`, NOT by `media_embeddings` presence —
 * `findEmbeddingCoverageTableBacklog` only returns rows in a runnable status.
 * Deleting embeddings while the stage stays `completed` ⇒ the backlog returns 0
 * candidates ⇒ permanent loss with no auto-recovery. See
 * {@link reEnrollCompletedStageForReset} for the ordering contract.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    deleteEmbeddingsBySource,
    deleteAllMediaEmbeddings,
    deleteLibraryAvailability,
} from '$lib/server/database/queries/ai-admin.queries.js';
import { reEnrollCompletedStageForReset } from '$lib/server/database/queries/stage-state.queries.js';

const RESET_SOURCES = ['library', 'discovery', 'music', 'all'] as const;
type ResetSource = (typeof RESET_SOURCES)[number];

const inputSchema = z.object({
    source: z.enum(RESET_SOURCES),
});
type EmbeddingResetInput = z.infer<typeof inputSchema>;

interface EmbeddingResetResult {
    source: string;
    deletedCount: number;
    reEnrolledCount: number;
}

/**
 * source → (embedding `source` values to delete, stage_ids to re-enroll).
 * `music` maps to the `music-embedding-generation` stage; `all` covers every
 * embedding source (including music, which `deleteAllMediaEmbeddings` removes).
 */
const RESET_PLAN: Record<ResetSource, { sources: string[]; stageIds: string[] }> = {
    library: { sources: ['library'], stageIds: ['library-embeddings'] },
    discovery: { sources: ['discovery'], stageIds: ['discovery-embeddings'] },
    music: { sources: ['music'], stageIds: ['music-embedding-generation'] },
    all: {
        sources: ['library', 'discovery', 'music'],
        stageIds: ['library-embeddings', 'discovery-embeddings', 'music-embedding-generation'],
    },
};

export const embeddingResetTask = defineTask<EmbeddingResetInput, EmbeddingResetResult>({
    id: 'embedding-reset',
    purpose: 'repair',
    name: 'Embedding Reset',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, cache: true },

    // One-shot: enqueued by the admin endpoint, never scheduled. Declaring this makes
    // the boot trigger-coverage audit classify it as 'manual-only' instead of flagging
    // it as an orphan (TASK_TRIGGER_INCONSISTENCY).
    manualOnly: true,
    // Deletes existing embeddings before re-queueing them — the admin UI
    // shows the "Run" action in its red/danger variant and a warning
    // tooltip so an operator can't mistake this for a routine re-sync.
    confirmBeforeRun: true,
    destructive: true,
    identityFor: (input) => `embedding-reset-${input.source}`,
    scope: 'global',
    // Destructive: a double-click (or two operators) must NOT race two deletes
    // for the same source. exclusiveWith SETNX-claims the per-source identity for
    // the in-flight run, so a second enqueue is a no-op duplicate until the
    // current reset finishes. ttl must be >= timeout.hard (SDK-enforced).
    exclusiveWith: { scope: 'global', ttl: '50m' },
    resourceClass: 'maintenance',
    inputSchema,
    timeout: { hard: '45m', soft: '44m' },

    async execute(ctx) {
        const { logger, sql } = ctx;
        const source = ctx.input.source;
        const plan = RESET_PLAN[source];
        if (!plan) {
            throw new TaskError({
                message: `Unknown embedding-reset source: ${source}`,
                kind: 'permanent',
            });
        }

        logger.info('embedding-reset starting', { source, stageIds: plan.stageIds });

        // Atomic: delete the artifact AND re-enroll the stage in one tx. The
        // generator runs in a separate process and only ever sees the committed
        // end state, so it never observes "row pending + artifact still present"
        // (which the stage-sweep would dispose to skipped_permanent).
        const { deletedCount, reEnrolledCount } = await withTx(sql, async (tx) => {
            let deleted = 0;
            if (source === 'all') {
                deleted = (await deleteAllMediaEmbeddings(tx)).deletedCount;
            } else {
                for (const s of plan.sources) {
                    deleted += (await deleteEmbeddingsBySource(tx, s)).deletedCount;
                }
            }

            // Preserve prior endpoint behavior: a library reset also cleared the
            // Jellyfin library_availability rows.
            if (source === 'library' || source === 'all') {
                await deleteLibraryAvailability(tx, 'jellyfin');
            }

            let reEnrolled = 0;
            for (const stageId of plan.stageIds) {
                reEnrolled += await reEnrollCompletedStageForReset(tx, stageId);
            }
            return { deletedCount: deleted, reEnrolledCount: reEnrolled };
        });

        logger.info('embedding-reset committed', { source, deletedCount, reEnrolledCount });

        // Clear the embedding cache after the delete commits (best-effort,
        // non-transactional Valkey). A stale entry is harmless — it expires —
        // but clearing avoids serving vectors we just deleted.
        try {
            const { CacheManager } = await import('$lib/server/cache/unified-cache.js');
            const { CACHE_NAMESPACES } = await import('$lib/server/cache/namespaces.js');
            await CacheManager.getInstance().for(CACHE_NAMESPACES.mediaEmbeddings).clear();
        } catch (cacheErr) {
            logger.warn('embedding-reset: failed to clear embedding cache', {
                error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
            });
        }

        return {
            success: true,
            itemsProcessed: deletedCount,
            result: { source, deletedCount, reEnrolledCount },
        };
    },
});

registry.registerTask(embeddingResetTask);
