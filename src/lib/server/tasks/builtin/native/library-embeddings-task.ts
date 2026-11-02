// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * library-embeddings — generates AI vector embeddings for items the user
 * owns (library content), as opposed to `discovery-embeddings` which
 * handles TMDB / MDBList discoverable items.
 *
 * Runs the same `EmbeddingOnlyGenerator` as the discovery task but with
 * `target: 'library'`, on its own schedule distinct from the discovery
 * cadence so the two embedding sources don't compete for the same OpenAI
 * rate-limit window. For-You, mood-vector, and dismiss services all
 * consume `media_embeddings WHERE source = LIBRARY` so newly ingested
 * content needs a dedicated producer.
 *
 * The tutorial exemplar at `library-embeddings.ts` (id:
 * `library-embeddings-demo`, marked `demo: true`) stays as the SDK
 * reference for the chunked-drain pattern — it never executes real work.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { EMBEDDING_SOURCE } from '../../../utils/embedding-source.js';
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
        /** When true, regenerate even if an embedding already exists. */
        force: z.boolean().optional(),
        /** When true, only embed items where the embedding is currently NULL. */
        missingOnly: z.boolean().optional(),
        /** Per-batch size sent to OpenAI. Capped at MAX_BATCH_SIZE. */
        batchSize: z.number().int().min(1).max(MAX_BATCH_SIZE).optional(),
    })
    .passthrough();

type LibraryEmbeddingsInput = z.infer<typeof inputSchema>;

interface LibraryEmbeddingsResult {
    generated: number;
    message?: string;
}

export const libraryEmbeddingsTask = defineTask<LibraryEmbeddingsInput, LibraryEmbeddingsResult>({
    id: 'library-embeddings',
    purpose: 'music-ai',
    name: 'Generate Library Embeddings',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true, cache: true },

    // Two-tier enrollment for newly-filed library content:
    //
    //  1. Eager (primary): `file.attached` flips this stage back to
    //     `pending` and the pipeline-event dispatcher eager-enqueues a run
    //     (StageStateService.eagerEnqueueForStages) — so a freshly-filed
    //     item is embedded within seconds when no run is in flight.
    //
    //  2. Scheduled (catch-up): because this is a GLOBAL-identity task
    //     (`identityFor: () => 'tgt-library'`), the eager enqueue dedupes
    //     against an already-in-flight run, and that run captured its
    //     candidate set when it started — so items filed *during* a run
    //     are not embedded by it. The scheduled tick is the catch-up that
    //     drains those late arrivals. At the old 4h cadence that meant up
    //     to a 4-hour enrollment latency under import storms (audit M9/F77);
    //     a 15m cadence bounds the worst case to minutes without per-item
    //     run churn or blowing the OpenAI budget (library content is a
    //     smaller set than discovery, which stays at 6h).
    //
    // runOnStartup: false so a fresh deploy doesn't immediately try to
    // drain everything.
    schedule: {
        every: '15m',
        runOnStartup: false,
        envOverride: 'LIBRARY_EMBEDDINGS_HOURS',
    },

    identityFor: () => 'tgt-library',
    scope: 'global',
    resourceClass: 'embedding',
    inputSchema,

    // Route embedding HTTP through the shared `embeddings` dep so Voyage/OpenAI
    // calls honour a cross-replica rate limit, circuit breaker, and SSRF guard
    // instead of the raw SDK clients. The fetch is published via
    // runWithEmbeddingFetch() around generate() below.
    externalDeps: [EMBEDDINGS_DEP],

    coversStages: [
        {
            id: 'library-embeddings',
            // Only movies + series (top-level browseable units). Episodes were
            // previously in this list but produced 49k embeddings that no
            // consumer ever queried — every callsite (genre-recommendations,
            // for-you-helpers, suggestion-search, user-watch-history) filters
            // by `mi.media_type IN ('movie', 'tv')`. Episode embeddings cost
            // OpenAI calls + HNSW index space + DB rows for zero value.
            // Migration 16.23.0 backfills the existing episode/season rows
            // as skipped_permanent and deletes the orphan media_embeddings.
            appliesTo: ['movie', 'series'] as const,
            // library-embeddings is gated by `AVAILABILITY_EXISTS` (item must
            // have a library file). When an item is skipped_permanent with
            // reason 'ineligible-by-legacy-filter' because no file existed
            // yet, the recovery hinges on file.attached firing — NOT just
            // metadata.changed. Also re-evaluate on identity.changed (a
            // freshly-matched item may newly satisfy mdblist-filter eligibility).
            // Re-embed triggers. `metadata.changed` is emitted by TWO DB
            // triggers: `media_items` (title/overview/runtime/year) AND
            // `provider_metadata` (the `aggregated` row — genres, keywords,
            // mdblist_keywords, cast, streaming). So enrichment that lands in
            // provider_metadata (TMDB/MDBList/curated-lists) re-embeds here even
            // though those tasks have no direct edge to this one.
            invalidatedBy: [
                'metadata.changed',
                'file.attached',
                'file.contentChanged',
                'identity.changed',
            ] as const,
            retryPolicy: { maxAttempts: 5 },
            enqueueable: true,
            // Eligibility is PURE STRUCTURAL: a browseable movie/series WITH a
            // library file. The "no library embedding exists yet" clause from the
            // old mirror is deliberately DROPPED — the same fragment now drives the
            // dispose pass, and gating on embedding-existence would tombstone an
            // invalidated row (metadata.changed flips completed→pending to re-embed)
            // as ineligible because an OLD embedding still exists, so it would never
            // re-embed. The `media_type IN ('movie','tv')` clause mirrors appliesTo so
            // the heal never resurrects the 16.23.0-backfilled episode/season rows.
            //
            // 🔴 The embedding provider is part of eligibility. With no key
            // configured this stage could never complete a single item on a stock
            // install: `generateTextEmbedding()` returns `null` (isVoyageAvailable
            // is false), the generator's per-item `catch` counts an error and moves
            // on, and the run still returns `success: true` with `generated: 0` —
            // so `onSuccess` never fires, no coverage row is ever written, and
            // (this being a GLOBAL-identity task) `wrapExecute`'s auto-complete has
            // no mediaItemId to complete either. Every row stayed `pending` while
            // the sweep re-enqueued global drains on the backoff ladder forever:
            // the exact shape recorded on `lumastra-intro-analyzer`'s coversStages
            // comment, plus a stream of logged per-item errors making the board
            // look broken. The aggregate progress bar could not reach 100%.
            //
            // Evaluated per sweep tick (the builder is called by
            // `runStageDisposition` each time) over live config getters, so adding
            // a key re-enrols the library within one tick — see
            // `recoverWhenAdditionalReasons` below.
            eligibility: {
                sql: (sql) => sql`
                    ${hasUsableEmbeddingProvider() ? sql`true` : sql`false`}
                    AND mi.media_type IN ('movie', 'tv')
                    AND mi.has_files
                `,
                // 'no-embedding-provider' is what the author predicate below stamps
                // while no key is configured. Listing it here is what reverses that
                // disposition when a key is added: the sweep's event-independent
                // heal re-evaluates `eligibility.sql` every tick and flips exactly
                // these reasons back to `pending`. No pipeline event exists for a
                // config change, and `skipped_permanent` is never re-swept, so this
                // heal — not `invalidatedBy` — is the recovery path.
                recoverWhenAdditionalReasons: [
                    'ineligible-by-legacy-filter',
                    'no-file-linked',
                    'no-embedding-provider',
                ],
            },
            // One-time bulk recovery when an operator finally adds a key; the
            // default 50/tick would take hours on a large library. Flipping rows to
            // `pending` is cheap — the embedding spend stays bounded by this task's
            // own batching, `exclusiveWith`, and the shared `embeddings` dep's rate
            // limit.
            healLimit: 500,
            terminalDisposition: {
                // This stage previously declared NO `terminalDisposition` at all.
                // Registration allowed that — `validateTerminalDisposition` exempts
                // an `enqueueable` stage from the requirement when it declares a
                // native `eligibility.sql`, on the stated grounds that the bulk
                // dispose pass "structurally covers all ineligible rows ... as long
                // as the eligibility sql fragment is correct". That proviso is
                // exactly what failed here: the fragment was structural-only, so an
                // unconfigured install had no expressible way to dispose a row it
                // could never process, and the fail-closed wedge guard waved it
                // through.
                //
                // `skipped_permanent` rather than a `global-guard`'s
                // `skipped_transient` because `loadStageProgressByIds` counts
                // transient skips as REMAINING and permanent ones as
                // `not_applicable` (excluded from the denominator). "No AI provider
                // configured" is genuinely not-applicable for this install, and the
                // matching clause in `eligibility.sql` above is what keeps
                // "permanent" recoverable.
                //
                // Its own reason, distinct from the generic 'ineligible' the
                // eligibility negation would write, so the Ingest Map can tell
                // "you have no API key" apart from "this item has no library file".
                kind: 'predicate' as const,
                ruleId: 'library-embeddings-provider-configured',
                disposeAs: 'skipped_permanent' as const,
                reason: 'no-embedding-provider',
                excludes: (sql) => (hasUsableEmbeddingProvider() ? sql`false` : sql`true`),
            },
        },
    ],

    timeout: { hard: '60m', soft: '55m' },

    // Singleton guard. identityFor is the constant 'tgt-library', and hard (60m)
    // exceeds the 15m schedule interval, so a drain still running at the next tick
    // would (without this) spawn a second concurrent 'tgt-library' run that
    // re-scans the same candidate set and double-spends embedding budget. The
    // header comment assumes "the eager enqueue dedupes against an already-in-flight
    // run", but the scheduler key family (sched:<id>:<fireAt>) and the coverage key
    // family (coverage:<stage>:global) never collided, so nothing collapsed them.
    // exclusiveWith makes that assumed single-drainer invariant real via SETNX —
    // one drain at a time; eager/sweep/scheduled fires for the same identity no-op
    // while one is in flight (the running drain covers the new items on its next
    // structural scan). ttl >= timeout.hard (SDK-enforced).
    exclusiveWith: { scope: 'global', ttl: '70m' },
    cost: { kind: 'openai_tokens' },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx) {
        const { force, missingOnly, batchSize } = ctx.input;

        // Optional-integration early skip. The stage disposition drains seeded
        // rows, but this task also runs on its OWN 15m schedule, which the sweep
        // does not gate — without this, an install with no key scans the whole
        // library every 15 minutes and logs one `Failed to generate embedding`
        // error per item, all the way down, forever. Mirrors mdblist-sync: the
        // guard stops the work, this stops the noise. Same predicate as the
        // stage's eligibility so the two can never disagree.
        if (!hasUsableEmbeddingProvider()) {
            ctx.logger.info('library-embeddings skipped — no embedding provider configured');
            return { success: true, itemsProcessed: 0, result: { generated: 0 } };
        }

        const useCoverageTable = getAuthoritativeStageIds().has('library-embeddings');

        // Lazy import — the generator carries a fair amount of dependency
        // weight (OpenAI client, embedding-text-formatter, etc). Keep it
        // out of the orchestrator boot path.
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

        ctx.logger.info('library-embeddings starting', {
            target: EMBEDDING_SOURCE.LIBRARY,
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
                          stageId: 'library-embeddings',
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
                    target: EMBEDDING_SOURCE.LIBRARY,
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
                            findEmbeddingCoverageTableBacklog(sql, 'library-embeddings', limit),
                        stageId: 'library-embeddings',
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
                    message: result.message,
                },
            };
        } catch (err) {
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

registry.registerTask(libraryEmbeddingsTask);
