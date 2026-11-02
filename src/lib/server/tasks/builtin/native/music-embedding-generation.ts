// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * music-embedding-generation — generates AI vector embeddings for music
 * tracks. Wraps `generateMusicEmbeddings()`.
 *
 * Defensive UUID filter: if the caller scoped the run via `itemIds` but
 * every id is malformed, throw rather than degrade to a full-library
 * sweep — the caller asked for a targeted embed, refusing to burn OpenAI
 * budget on unrelated tracks.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { upsertCompletedRow } from '../../../database/queries/stage-state.queries.js';
import { findEmbeddingCoverageTableBacklog } from '../../../database/queries/embeddings.queries.js';
import { getAuthoritativeStageIds } from '$lib/server/config.js';
import { runWithEmbeddingFetch } from '../../../ai/embedding-fetch-context.js';
import { EMBEDDINGS_DEP, hasUsableEmbeddingProvider } from './embedding-dep.js';
import { classifyInfraError } from '../../infra-retry.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

const inputSchema = z
    .object({
        force: z.boolean().optional(),
        mode: z.enum(['catchup', 'force', 'manual']).optional(),
        batchSize: z.number().int().min(1).max(500).optional(),
        itemIds: z.array(z.string()).optional(),
    })
    .passthrough();

type MusicEmbeddingInput = z.infer<typeof inputSchema>;

export const musicEmbeddingGenerationTask = defineTask<MusicEmbeddingInput, unknown>({
    id: 'music-embedding-generation',
    purpose: 'music-ai',
    name: 'Generate Music Embeddings',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, http: true },

    schedule: { every: '6h', runOnStartup: false },

    identityFor: (input) => {
        const ids = input.itemIds ?? [];
        if (ids.length === 0) return 'global';
        const head = [...ids].sort()[0] ?? 'none';
        return `item-${head}`;
    },
    scope: 'global',
    // Singleton guard: each track embedded spends real OpenAI token quota
    // (ctx.spend('openai_tokens')). Without exclusiveWith, the scheduler's
    // narrow double-fire window (fast-completing run + failed
    // scheduler_state advance) can spawn a second concurrent 'global' drain
    // that doubles OpenAI spend for no extra coverage. identityFor resolves
    // to the constant 'global' for the scheduled fire (empty itemIds); a
    // targeted itemIds trigger gets its own item-keyed identity and is
    // unaffected. ttl exceeds the 60m hard timeout with margin.
    exclusiveWith: { scope: 'global', ttl: '70m' },
    resourceClass: 'embedding',
    inputSchema,

    // Route embedding HTTP through the shared `embeddings` dep (rate limit +
    // circuit breaker + SSRF guard). Fetch published via runWithEmbeddingFetch().
    externalDeps: [EMBEDDINGS_DEP],

    coversStages: [
        {
            id: 'music-embedding-generation',
            appliesTo: ['track'] as const,
            // Eligibility is PURE STRUCTURAL: a non-missing file WITH a probed audio
            // stream. The "embedding already up-to-date" condition is deliberately
            // NOT here — it is an OBSERVED outcome handled by the transient
            // disposition below. (The old `sqlEligibilityMirror` folded freshness in
            // because it only drove the heal; the SAME fragment now also drives the
            // dispose pass, so including freshness would wrongly tombstone an
            // up-to-date track as permanently ineligible instead of transiently
            // skipping it.) Tracks seeded before media-probe writes the audio stream
            // are disposed `skipped_permanent/'ineligible'`, then healed when the
            // stream lands — event-independently ('metadata' invalidation never fires
            // for tracks, so the old seed skip was unrecoverable).
            eligibility: {
                sql: (sql) => sql`
                    -- Same feature-gate hole the trickplay and library-embedding
                    -- stages had: without this, every track is seeded eligible while
                    -- generateTextEmbedding() returns null for want of a provider, so
                    -- the row churns pending forever and music can never reach 100%.
                    -- This task uses the TEXT embedding path (openai.ts), not the
                    -- sonic sidecar, so the text-provider predicate is the right one.
                    ${hasUsableEmbeddingProvider() ? sql`true` : sql`false`}
                    AND EXISTS (
                        SELECT 1 FROM media_file_items mfi
                          JOIN media_files mf ON mf.id = mfi.file_id
                         WHERE mfi.media_item_id = mi.id AND NOT mf.is_missing
                    )
                    AND EXISTS (
                        SELECT 1 FROM media_file_items mfi
                          JOIN media_files mf ON mf.id = mfi.file_id
                          JOIN media_streams ms ON ms.file_id = mf.id
                         WHERE mfi.media_item_id = mi.id
                           AND NOT mf.is_missing
                           AND ms.stream_type = 'audio'
                    )
                `,
                // 'no-embedding-provider' MUST stay listed: it is what reverses the
                // disposition below when a key is later added. Drop it and turning the
                // feature on leaves the library tombstoned permanently — worse than the
                // churn this fixes.
                recoverWhenAdditionalReasons: ['no-file-linked', 'no-embedding-provider'],
            },
            invalidatedBy: [
                'file.attached',
                'file.detached',
                'file.contentChanged',
                'file.defaultChanged',
                'metadata.changed',
                'file.probed',
            ] as const,
            // A re-attached/alternate file must not re-embed an up-to-date track.
            preserveCompletedOn: ['file.attached'] as const,
            retryPolicy: { maxAttempts: 5 },
            enqueueable: true,
            // OBSERVED transient skip: an up-to-date music embedding already exists
            // (EXISTS source='music' AND NOT stale). disposeAs skipped_transient with
            // a 6h backoff (LEGACY_FILTER_SKIP_RETRY_MS) so the track is re-checked
            // for staleness later — NOT a permanent eligibility skip.
            terminalDisposition: [
                {
                    kind: 'predicate' as const,
                    ruleId: 'music-embedding-no-provider',
                    disposeAs: 'skipped_permanent' as const,
                    reason: 'no-embedding-provider',
                    excludes: (sql) => (hasUsableEmbeddingProvider() ? sql`false` : sql`true`),
                },
                {
                    kind: 'predicate',
                    ruleId: 'embedding-up-to-date',
                    disposeAs: 'skipped_transient',
                    reason: 'ineligible-by-legacy-filter',
                    retryAfterMs: 6 * 60 * 60 * 1000,
                    excludes: (sql) => sql`
                EXISTS (
                    SELECT 1 FROM media_embeddings me
                    WHERE me.media_id = mi.id
                      AND me.source = 'music'
                      AND me.updated_at >= mi.updated_at
                )
            `,
                },
            ],
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
        const useCoverageTable = getAuthoritativeStageIds().has('music-embedding-generation');

        const { generateMusicEmbeddings } =
            await import('../../../ai/music-embedding-generator.js');

        const force = ctx.input.force === true || ctx.input.mode === 'force';
        const batchSize = ctx.input.batchSize ?? 20;

        const rawItemIds = ctx.input.itemIds;
        const callerScoped = Array.isArray(rawItemIds);
        const itemIds = callerScoped
            ? rawItemIds.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id))
            : undefined;

        ctx.logger.info('Music embedding generation started', {
            force,
            batchSize,
            scopedItems: itemIds?.length,
        });

        if (callerScoped && (!itemIds || itemIds.length === 0)) {
            const rawLen = Array.isArray(rawItemIds) ? rawItemIds.length : 0;
            throw new Error(
                `music-embedding-generation received itemIds but none were valid UUIDs (received=${rawLen}). Refusing to degrade to a full sweep.`,
            );
        }

        if (ctx.signal.aborted) {
            return { success: false, itemsProcessed: 0, stopReason: 'aborted' };
        }

        const onMusicSuccess = useCoverageTable
            ? async (trackId: string): Promise<void> => {
                  try {
                      await upsertCompletedRow(ctx.sql as never, {
                          mediaItemId: trackId,
                          stageId: 'music-embedding-generation',
                          processingVersion: 1,
                      });
                  } catch {
                      // Non-fatal — coverage write failure must not abort embedding generation
                  }
              }
            : undefined;

        const result = await runWithEmbeddingFetch(ctx.dep('embeddings').fetch, () =>
            generateMusicEmbeddings({
                force,
                batchSize,
                ...(itemIds ? { itemIds } : {}),
                // Polled between batches and between tracks (before each OpenAI
                // call). Stops the token burn cleanly on admin Cancel.
                shouldAbort: () => ctx.signal.aborted,
                onProgress: (processed, total) => {
                    ctx.reportProgress(processed, total, `${processed}/${total} tracks`);
                },
                onSuccess: onMusicSuccess,
                ...(useCoverageTable &&
                    !itemIds && {
                        candidateSource: (sql, limit) =>
                            findEmbeddingCoverageTableBacklog(
                                sql,
                                'music-embedding-generation',
                                limit,
                            ),
                        stageId: 'music-embedding-generation',
                    }),
            }),
        );

        if (result.tokensUsed > 0) {
            ctx.spend('openai_tokens', result.tokensUsed);
        }

        // If we aborted, surface stopReason so the orchestrator marks the run
        // cancelled rather than completed. Partial work is preserved in the DB.
        if (ctx.signal.aborted) {
            ctx.logger.info('Music embedding generation cancelled', {
                generated: result.generated,
            });
            return {
                success: false,
                itemsProcessed: result.generated,
                stopReason: 'aborted',
                result,
            };
        }

        ctx.logger.info('Music embedding generation finished', {
            generated: result.generated,
            success: result.success,
        });

        return {
            success: result.success,
            itemsProcessed: result.generated,
            result,
        };
    },
});

registry.registerTask(musicEmbeddingGenerationTask);
