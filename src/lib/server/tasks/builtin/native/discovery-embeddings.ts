// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * discovery-embeddings — generates AI vector embeddings for items in the
 * discovery catalog (TMDB + MDBList metadata for items NOT in the user's
 * library). Wraps `EmbeddingOnlyGenerator` from
 * `src/lib/server/ai/embedding-only-generator.ts`.
 *
 * Design choices:
 *  - resourceClass='discovery' (its OWN class, isolated from `embedding`) so the
 *    large, back-to-back catalog backfill can never starve the user's own
 *    library/music embeddings that share the `embedding` budget. (Observed on a
 *    fresh install: this task held the cap=1 `embedding` slot continuously and
 *    `library-embeddings` sat `pending` indefinitely — coverage frozen 0/2.)
 *    Embedding HTTP is still rate-limited via the shared `embeddings` dep, so a
 *    separate class adds fairness without uncapping the OpenAI/Voyage call rate.
 *  - identityFor returns a stable id keyed on `target` so two concurrent
 *    runs against the same target collapse via the registry's SETNX gate.
 *    Per-item runs are not enqueued by lifecycle hooks; the scheduled
 *    sweep + stale predicate (pm.updated_at > emb.updated_at OR
 *    mi.updated_at > emb.updated_at) picks up newly-matched items within
 *    the next ~6h tick.
 *  - inputSchema accepts `target` ('library' | 'discovery') so the same
 *    task can be reused for library embeddings.
 *  - MAX_BATCH_SIZE caps the per-run sweep so a fresh deploy can't OOM or
 *    blow the OpenAI cost budget while back-filling. Admin can override
 *    via `batchSize` for one-off larger runs.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { EMBEDDING_SOURCE, type EmbeddingSource } from '../../../utils/embedding-source.js';
import { upsertCompletedRow } from '../../../database/queries/stage-state.queries.js';
import { findEmbeddingCoverageTableBacklog } from '../../../database/queries/embeddings.queries.js';
import { getAuthoritativeStageIds } from '$lib/server/config.js';
import { runWithEmbeddingFetch } from '../../../ai/embedding-fetch-context.js';
import { EMBEDDINGS_DEP, hasUsableEmbeddingProvider } from './embedding-dep.js';
import { classifyInfraError } from '../../infra-retry.js';

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 500;

const inputSchema = z
    .object({
        /**
         * Which catalog tier to embed:
         *  - 'discovery' (default) — TMDB/MDBList items not in library
         *  - 'library' — items the user owns (library metadata)
         */
        target: z.enum(['discovery', 'library']).optional(),
        /** When true, regenerate even if an embedding already exists. */
        force: z.boolean().optional(),
        /** When true, only embed items where the embedding is currently NULL. */
        missingOnly: z.boolean().optional(),
        /** Per-batch size sent to OpenAI. Capped at MAX_BATCH_SIZE. */
        batchSize: z.number().int().min(1).max(MAX_BATCH_SIZE).optional(),
    })
    .passthrough();

type DiscoveryEmbeddingsInput = z.infer<typeof inputSchema>;

interface DiscoveryEmbeddingsResult {
    generated: number;
    target: EmbeddingSource;
    message?: string;
}

export const discoveryEmbeddingsTask = defineTask<
    DiscoveryEmbeddingsInput,
    DiscoveryEmbeddingsResult
>({
    id: 'discovery-embeddings',
    purpose: 'music-ai',
    name: 'Generate Discovery Embeddings',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true, cache: true },

    // runOnStartup disabled so a fresh deploy doesn't immediately try to
    // drain the entire backlog — the lifecycle hooks + scheduler pick it up.
    schedule: { every: '6h', runOnStartup: false },

    identityFor: (input) => `tgt-${input.target ?? 'discovery'}`,
    scope: 'global',
    // Singleton guard: each item embedded spends real OpenAI token quota
    // (ctx.spend('openai_tokens')). Without exclusiveWith, the scheduler's
    // narrow double-fire window (fast-completing run + failed
    // scheduler_state advance) can spawn a second concurrent
    // 'tgt-discovery' drain that doubles OpenAI spend for no extra coverage.
    // identityFor is stable per target — the scheduled fire (`{}` input)
    // always resolves to 'tgt-discovery'; a different `target` gets its own
    // identity and is unaffected. ttl exceeds the 60m hard timeout with margin.
    exclusiveWith: { scope: 'global', ttl: '70m' },
    resourceClass: 'discovery',
    inputSchema,

    // Route embedding HTTP through the shared `embeddings` dep (rate limit +
    // circuit breaker + SSRF guard). Fetch published via runWithEmbeddingFetch().
    externalDeps: [EMBEDDINGS_DEP],

    coversStages: [
        {
            id: 'discovery-embeddings',
            appliesTo: ['movie', 'series'] as const,
            // Eligibility: only items WITHOUT a library file are discovery candidates
            // (items with a file belong to library-embeddings). Expressed as the
            // positive SQL `NOT mi.has_files`. When a file later attaches, the item
            // becomes ineligible here — the sweep dispose pass demotes it to
            // `skipped_permanent/'ineligible'` and library-embeddings takes over; if
            // the file detaches again the heal flips it back. (`has_files` is set at
            // file-attach time, not by probe, so it is correctly evaluable — but it
            // is mutable, so it lives in `sql`, not the immutable `appliesTo`.)
            //
            // 🔴 The embedding provider is part of eligibility, for the same reason
            // it is on `library-embeddings` (see the long note there): with no key
            // `generateTextEmbedding()` returns `null`, the generator counts a
            // per-item error and still reports `success: true` with `generated: 0`,
            // so `onSuccess` never fires and no coverage row is ever written. Rows
            // stay `pending` forever while the sweep re-enqueues global drains on
            // the backoff ladder. Re-read per sweep tick, so adding a key re-enrols
            // within one tick via `recoverWhenAdditionalReasons`.
            eligibility: {
                sql: (sql) => sql`
                    ${hasUsableEmbeddingProvider() ? sql`true` : sql`false`}
                    AND NOT mi.has_files
                `,
                recoverWhenAdditionalReasons: [
                    'ineligible-by-legacy-filter',
                    'no-embedding-provider',
                ],
            },
            healLimit: 500,
            // discovery-embeddings depends on item metadata, file availability
            // AND identity. An item marked skipped_permanent with reason
            // 'ineligible-by-legacy-filter' (no library file yet / mdblist
            // filter mismatch / etc.) must re-evaluate when files arrive or
            // identity changes — not just when metadata is edited.
            // `metadata.changed` is emitted by BOTH the `media_items` trigger
            // (title/overview/runtime/year) and the `provider_metadata`
            // aggregated-row trigger (genres/keywords/mdblist_keywords/cast/…),
            // so TMDB/MDBList/curated enrichment re-embeds here with no direct
            // task edge.
            invalidatedBy: [
                'metadata.changed',
                'file.attached',
                'file.contentChanged',
                'file.detached',
                'identity.changed',
            ] as const,
            retryPolicy: { maxAttempts: 5 },
            enqueueable: true,
            // Was absent despite `enqueueable: true`: registration exempts a
            // stage that declares a native `eligibility.sql` from the
            // terminalDisposition requirement, on the grounds that the bulk
            // dispose pass covers every ineligible row "as long as the eligibility
            // sql fragment is correct" — and this one omitted the provider, so an
            // unconfigured install had no expressible disposition at all.
            // `skipped_permanent`, not a
            // `global-guard`'s `skipped_transient`, because `loadStageProgressByIds`
            // counts transient skips as REMAINING and permanent ones as
            // `not_applicable`; "no AI provider configured" is genuinely not
            // applicable to this install, and the matching clause in
            // `eligibility.sql` above is what keeps "permanent" recoverable. Its own
            // reason so the Ingest Map distinguishes it from the generic
            // 'ineligible' the eligibility negation writes for a file-backed item.
            terminalDisposition: {
                kind: 'predicate' as const,
                ruleId: 'discovery-embeddings-provider-configured',
                disposeAs: 'skipped_permanent' as const,
                reason: 'no-embedding-provider',
                excludes: (sql) => (hasUsableEmbeddingProvider() ? sql`false` : sql`true`),
            },
        },
    ],

    timeout: { hard: '60m', soft: '55m' },
    cost: { kind: 'openai_tokens' },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx) {
        const { target = 'discovery', force, missingOnly, batchSize } = ctx.input;

        // Optional-integration early skip — this task runs on its own 6h schedule
        // which the sweep does not gate, so without it an unconfigured install
        // rescans the discovery catalog and logs one error per item forever.
        // Same predicate as the stage's eligibility so the two cannot disagree.
        if (!hasUsableEmbeddingProvider()) {
            ctx.logger.info('discovery-embeddings skipped — no embedding provider configured');
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    generated: 0,
                    target:
                        target === 'library'
                            ? EMBEDDING_SOURCE.LIBRARY
                            : EMBEDDING_SOURCE.DISCOVERY,
                },
            };
        }

        const useCoverageTable = getAuthoritativeStageIds().has('discovery-embeddings');

        // Lazy import — the generator pulls a fair amount of code; avoid
        // adding it to the orchestrator boot path.
        const { EmbeddingOnlyGenerator } = await import('../../../ai/embedding-only-generator.js');
        const generator = new EmbeddingOnlyGenerator();

        // Wire ctx.signal into the generator so admin cancel propagates.
        if (ctx.signal.aborted) {
            return { success: false, itemsProcessed: 0, stopReason: 'aborted' };
        }
        ctx.signal.addEventListener(
            'abort',
            () => {
                void generator.abort();
            },
            { once: true },
        );

        const effectiveBatchSize = Math.min(batchSize ?? DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
        const embeddingSource: EmbeddingSource =
            target === 'library' ? EMBEDDING_SOURCE.LIBRARY : EMBEDDING_SOURCE.DISCOVERY;

        ctx.logger.info('discovery-embeddings starting', {
            target: embeddingSource,
            batchSize: effectiveBatchSize,
            force: force === true,
            missingOnly: missingOnly !== false,
            useCoverageTable,
        });

        const onEmbeddingSuccess = useCoverageTable
            ? async (mediaItemId: string): Promise<void> => {
                  try {
                      await upsertCompletedRow(ctx.sql as never, {
                          mediaItemId,
                          stageId: 'discovery-embeddings',
                          processingVersion: 1,
                      });
                  } catch {
                      // Non-fatal — coverage write failure must not abort embedding generation
                  }
              }
            : undefined;

        try {
            const result = await runWithEmbeddingFetch(ctx.dep('embeddings').fetch, () =>
                generator.generate({
                    target: embeddingSource,
                    missingOnly: missingOnly !== false && force !== true,
                    force: force === true,
                    batchSize: effectiveBatchSize,
                    shouldAbort: () => ctx.signal.aborted || generator.isAborted(),
                    onProgress: (progress) => {
                        ctx.reportProgress(
                            progress.processedItems ?? 0,
                            progress.totalItems ?? 0,
                            progress.currentItem,
                        );
                    },
                    onSuccess: onEmbeddingSuccess,
                    sql: ctx.sql,
                    ...(useCoverageTable && {
                        candidateSource: (sql, limit) =>
                            findEmbeddingCoverageTableBacklog(sql, 'discovery-embeddings', limit),
                        stageId: 'discovery-embeddings',
                    }),
                }),
            );

            if (result.tokensUsed > 0) {
                ctx.spend('openai_tokens', result.tokensUsed);
            }

            return {
                success: result.success,
                itemsProcessed: result.generated ?? 0,
                result: {
                    generated: result.generated ?? 0,
                    target: embeddingSource,
                    message: result.message,
                },
            };
        } catch (err) {
            // ctx.signal abort surfaces as an AbortError-shaped throw from
            // the generator. Map it to a clean stopReason instead of
            // propagating — the orchestrator's cancel path already marked
            // the run cancelled.
            if (ctx.signal.aborted || generator.isAborted()) {
                return {
                    success: false,
                    itemsProcessed: 0,
                    stopReason: 'aborted',
                };
            }
            throw err;
        }
    },
});

registry.registerTask(discoveryEmbeddingsTask);
