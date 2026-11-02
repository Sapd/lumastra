// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Embedding Projection Fit Task
 *
 * OFFLINE / ONE-TIME. Manually triggered only (no `schedule`) — this is the
 * ONLY code path anywhere in the app allowed to call
 * `fitUncenteredPcaBasis`. Reads every `media_audio_embeddings` row for
 * MSCLAP, fits a 1024x64 uncentered-PCA basis, and persists it to
 * `music_embedding_projection_basis`. See
 * `.superpowers/embedding-quantization-eval.md` and migration 16.224.0 for
 * why the basis must be fit-once and never recomputed.
 *
 * THE OVERWRITE GUARD IS THE POINT of this task, not a side detail:
 * `insertProjectionBasisIfAbsent` is `ON CONFLICT (model_id, version) DO
 * NOTHING`, and this task checks first and no-ops with a clear log message
 * when a basis for the current `EMBEDDING_PROJECTION_VERSION` already
 * exists. The eval doc measured that a silent refit — even from the exact
 * same corpus, even by the exact same fitting code — can flip a component's
 * sign (SVD sign is arbitrary across solver/library builds) and collapse
 * recall@10 from 93.9% to 16.4%, while every self-consistency check on the
 * new basis alone would still pass. Rotating to a new basis is a deliberate
 * act: bump `EMBEDDING_PROJECTION_VERSION` in
 * `music-embedding-projection.queries.ts`, re-run this task, then re-run
 * `music-embedding-projection-backfill` to stamp every embedding under the
 * new version (which the wire schema treats as a full client cache
 * invalidation).
 *
 * Minimum corpus gate: refuses to fit below `MIN_FIT_CORPUS_SIZE`. A basis
 * fit from a handful of tracks does not span a meaningful 64-dim subspace of
 * a 1024-dim embedding space — the eval doc's whole methodology depends on a
 * fit corpus in the thousands. On a fresh install with too few embedded
 * tracks, this simply fails with a permanent TaskError telling the operator
 * to wait for more of the library to be embedded and re-trigger; no basis
 * row is written, so `/candidates` keeps emitting `embeddingProjection:
 * null` and clients keep using the Essentia fallback — never a "basis fit
 * from noise" served as if it were real.
 *
 * Cost note: the dominant cost is the Gram-matrix accumulation over the full
 * corpus (`O(N * 1024^2)`), independent of subspace-iteration cost. This is
 * expected to take minutes on a library in the tens of thousands of tracks —
 * acceptable for a task an operator runs once (or once per basis rotation),
 * not something on any request or write hot path.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import type postgres from 'postgres';
import { registry } from '../../registry.js';
import { MSCLAP_MODEL_ID } from '$lib/server/database/queries/sonic-constants.js';
import {
    EMBEDDING_PROJECTION_VERSION,
    projectionBasisExists,
    insertProjectionBasisIfAbsent,
    countEmbeddingsStampedForVersion,
} from '$lib/server/database/queries/music-embedding-projection.queries.js';
import {
    fitUncenteredPcaBasis,
    matrixToBuffer,
} from '../../../services/music-embedding-projection/fit.js';
import {
    EMBEDDING_INPUT_DIM,
    EMBEDDING_OUTPUT_DIM,
} from '../../../services/music-embedding-projection/types.js';
import { parsePgVectorText } from '$lib/server/database/queries/music-alchemy.queries.js';

/**
 * Below this, a fit is refused (see the module docstring). Chosen well above
 * the eval doc's own smallest fit-corpus experiments (1,500-track corpora,
 * 94.7-95.0% recall) with margin for a much smaller self-hosted library
 * still producing a directionally-useful (if not measured-optimal) basis.
 */
const MIN_FIT_CORPUS_SIZE = 500;

/** Rows per cursor fetch when streaming the corpus (see the load loop below). */
const CURSOR_CHUNK_SIZE = 1000;

const inputSchema = z.object({}).passthrough();
type FitInput = z.infer<typeof inputSchema>;

interface FitResult {
    fitted: boolean;
    corpusSize: number;
    version: number;
}

interface EmbeddingRow {
    embedding: string;
}

export const musicEmbeddingProjectionFitTask = defineTask<FitInput, FitResult>({
    id: 'music-embedding-projection-fit',
    purpose: 'music-ai',
    confirmBeforeRun: true,
    name: 'Music Embedding Projection Fit (one-time)',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    // Deliberately no `schedule` — manual trigger only. Fitting a basis is a
    // rare, deliberate operator action (first setup, or an intentional
    // version rotation), never an automatic recurring job. See the module
    // docstring on why an unintended refit is a much worse outcome than "the
    // feature isn't live yet".
    //
    // `manualOnly` is not decoration: it is the LAST branch of
    // classifyTriggers() before `unknown`, and an `unknown` task makes
    // auditTriggerCoverage() throw at orchestrator boot outside production
    // (and log at error level inside it). Omitting a schedule without
    // declaring this leaves the whole task system dead in dev and test.
    manualOnly: true,
    resourceClass: 'analysis',
    quotas: { maxConcurrent: 1 },

    scope: 'global',
    identityFor: () => 'global',

    inputSchema,

    // Generous: the Gram-matrix accumulation over tens of thousands of
    // 1024-dim vectors is the dominant cost (see module docstring).
    timeout: { hard: '6h', soft: '5h' },

    async execute(ctx) {
        const { sql: rawSql, logger: ctxLogger, signal } = ctx;
        const sql = rawSql as unknown as postgres.Sql;

        const alreadyFit = await projectionBasisExists(
            sql,
            MSCLAP_MODEL_ID,
            EMBEDDING_PROJECTION_VERSION,
        );
        if (alreadyFit) {
            ctxLogger.info(
                'A basis for the current EMBEDDING_PROJECTION_VERSION already exists — refusing to refit (see module docstring: a silent refit can flip a component sign and collapse recall from 93.9% to 16.4%). Bump EMBEDDING_PROJECTION_VERSION to fit a new one.',
                { modelId: MSCLAP_MODEL_ID, version: EMBEDDING_PROJECTION_VERSION },
            );
            return {
                success: true,
                itemsProcessed: 0,
                result: { fitted: false, corpusSize: 0, version: EMBEDDING_PROJECTION_VERSION },
                message: 'Basis already exists for this version — no-op',
            };
        }

        // Basis-loss guard: `alreadyFit` above only tells us the basis row
        // for the current version is gone -- it says nothing about whether
        // rows ENCODED under that version are still around. If they are, the
        // basis row was lost (targeted DELETE, partial restore) rather than
        // never having existed, and fitting a fresh matrix now would insert
        // it under the same version number those surviving rows carry --
        // silently mixing two incompatible bases with no way to tell them
        // apart afterwards (see countEmbeddingsStampedForVersion's docstring
        // and migration 16.224.0). An ordinary full restore is unaffected:
        // it brings `projection_version` back to NULL along with everything
        // else, which this check correctly treats as "nothing stamped yet".
        const stampedWithoutBasis = await countEmbeddingsStampedForVersion(
            sql,
            MSCLAP_MODEL_ID,
            EMBEDDING_PROJECTION_VERSION,
        );
        if (stampedWithoutBasis > 0) {
            throw new TaskError({
                kind: 'permanent',
                message:
                    `Music embedding projection fit: no basis row exists for ` +
                    `(model=${MSCLAP_MODEL_ID}, version=${EMBEDDING_PROJECTION_VERSION}), but ` +
                    `${stampedWithoutBasis} embedding rows are already stamped with that version. ` +
                    'The basis that produced those stamps appears to have been lost (e.g. a ' +
                    'targeted DELETE or partial restore of music_embedding_projection_basis) -- ' +
                    'refitting now would insert a new, different matrix under the SAME version ' +
                    'number, permanently and silently mixing two incompatible bases. Bump ' +
                    'EMBEDDING_PROJECTION_VERSION in music-embedding-projection.queries.ts, then ' +
                    're-run this task and music-embedding-projection-backfill.',
            });
        }

        if (signal.aborted) {
            return {
                success: true,
                itemsProcessed: 0,
                stopReason: 'aborted' as const,
                result: { fitted: false, corpusSize: 0, version: EMBEDDING_PROJECTION_VERSION },
                message: 'Aborted before starting',
            };
        }

        ctxLogger.info('Loading MSCLAP embedding corpus for the projection fit', {
            modelId: MSCLAP_MODEL_ID,
        });

        // Streamed via a cursor rather than a plain awaited query: a plain
        // `await sql\`...\`` buffers every row's pgvector TEXT into one array
        // before the parse loop even starts, so the raw text and the parsed
        // `vectors` array are both fully resident at once for the whole
        // corpus (roughly 2x peak memory on a large library). Fetching in
        // `CURSOR_CHUNK_SIZE` chunks means only one chunk of raw text is ever
        // resident alongside the growing `vectors` array.
        const vectors: number[][] = [];
        let parseErrors = 0;
        for await (const chunk of sql<EmbeddingRow[]>`
            SELECT embedding::text AS embedding
            FROM media_audio_embeddings
            WHERE model_id = ${MSCLAP_MODEL_ID}
        `.cursor(CURSOR_CHUNK_SIZE)) {
            for (const row of chunk) {
                const parsed = parsePgVectorText(row.embedding);
                if (!parsed || parsed.length !== EMBEDDING_INPUT_DIM) {
                    parseErrors++;
                    continue;
                }
                vectors.push(parsed);
            }
        }

        if (parseErrors > 0) {
            ctxLogger.warn(
                'Some embedding rows could not be parsed and were excluded from the fit',
                {
                    parseErrors,
                    usable: vectors.length,
                },
            );
        }

        if (vectors.length < MIN_FIT_CORPUS_SIZE) {
            throw new TaskError({
                kind: 'permanent',
                message:
                    `Music embedding projection fit: corpus too small (${vectors.length} usable ` +
                    `embeddings, need at least ${MIN_FIT_CORPUS_SIZE}). A basis fit from too few ` +
                    'tracks is measured useless -- wait for the sonic-embedding-backfill task to ' +
                    'embed more of the library, then re-trigger this task.',
            });
        }

        if (signal.aborted) {
            return {
                success: true,
                itemsProcessed: 0,
                stopReason: 'aborted' as const,
                result: {
                    fitted: false,
                    corpusSize: vectors.length,
                    version: EMBEDDING_PROJECTION_VERSION,
                },
                message: 'Aborted after loading the corpus, before fitting',
            };
        }

        ctxLogger.info('Fitting uncentered-PCA basis', {
            corpusSize: vectors.length,
            inputDim: EMBEDDING_INPUT_DIM,
            outputDim: EMBEDDING_OUTPUT_DIM,
        });

        const { matrix } = fitUncenteredPcaBasis(
            vectors,
            EMBEDDING_INPUT_DIM,
            EMBEDDING_OUTPUT_DIM,
        );

        const inserted = await insertProjectionBasisIfAbsent(sql, {
            modelId: MSCLAP_MODEL_ID,
            version: EMBEDDING_PROJECTION_VERSION,
            inputDim: EMBEDDING_INPUT_DIM,
            outputDim: EMBEDDING_OUTPUT_DIM,
            matrix: matrixToBuffer(matrix),
            corpusSize: vectors.length,
        });

        if (!inserted) {
            // Lost a race against another fit run (e.g. a second manual trigger)
            // between the existence check above and this insert. ON CONFLICT DO
            // NOTHING already made this a safe no-op at the DB layer -- log it,
            // don't treat it as a failure.
            ctxLogger.info(
                'Basis was inserted by a concurrent fit run between the existence check and this write — this run discarded its own fit and made no change.',
            );
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    fitted: false,
                    corpusSize: vectors.length,
                    version: EMBEDDING_PROJECTION_VERSION,
                },
                message: 'Lost race to a concurrent fit — no-op',
            };
        }

        const message = `Fitted and stored embedding projection basis v${EMBEDDING_PROJECTION_VERSION} from ${vectors.length} tracks`;
        ctxLogger.info(message);

        return {
            success: true,
            itemsProcessed: vectors.length,
            result: {
                fitted: true,
                corpusSize: vectors.length,
                version: EMBEDDING_PROJECTION_VERSION,
            },
            message,
        };
    },
});

// Self-register into the singleton registry.
registry.registerTask(musicEmbeddingProjectionFitTask);
