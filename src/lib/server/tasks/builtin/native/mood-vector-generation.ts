// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mood Vector Generation Task
 *
 * Runs `generateMusicMoodVectors()` (text/OpenAI space, model_id='text') and
 * then `generateAudioMoodVectors()` (MSCLAP audio space, model_id='msclap-2023')
 * to fully populate the `mood_vectors` table from music track embeddings.
 *
 * Each mood key defined in MUSIC_MOOD_SEEDS is matched against tracks whose
 * `custom_metadata` genres or essentia mood_tags contain the mood's keywords.
 * Their embeddings are averaged into a normalised direction vector and written
 * to `mood_vectors` with the corresponding model_id discriminator.
 *
 * The text-space rows (model_id='text') back mood-recommendations.
 * The audio-space rows (model_id='msclap-2023') back the sonic queue GAMMA arm.
 *
 * Without audio rows the GAMMA arm degrades gracefully to the two-arm blend
 * (ALPHA_NO_MOOD + BETA_NO_MOOD); text rows are unaffected.
 *
 * Gating:
 *   - No-ops immediately when features.sonicQueue is false.
 *   - Runs automatically every 12h so mood vectors stay fresh as the sonic
 *     embedding backfill grows; the manual admin button remains available for
 *     an immediate on-demand run.
 *
 * Resource class:
 *   'embedding' — reads media_embeddings + media_audio_embeddings, writes
 *   mood_vectors; shares the embedding quota to avoid conflicting with backfills.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    generateMusicMoodVectors,
    generateAudioMoodVectors,
} from '../../../services/mood-vector.service.js';
import { registry } from '../../registry.js';
import type postgres from 'postgres';

const logger = Logger.for('MoodVectorGeneration');

// ============================================================================
// Schema / types
// ============================================================================

const inputSchema = z.object({}).passthrough();

type MoodVectorGenerationInput = z.infer<typeof inputSchema>;

interface MoodVectorGenerationResult {
    /** Number of text-space mood vector sets generated (1 = all MUSIC_MOOD_SEEDS). */
    textGenerated: number;
    /** Number of audio-space mood vector sets generated (1 = all MUSIC_MOOD_SEEDS). */
    audioGenerated: number;
}

// ============================================================================
// Task definition
// ============================================================================

export const moodVectorGenerationTask = defineTask<
    MoodVectorGenerationInput,
    MoodVectorGenerationResult
>({
    id: 'mood-vector-generation',
    purpose: 'music-ai',
    name: 'Mood Vector Generation',
    version: '1.1.0',
    processingVersion: 2,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    // Runs every 12h to keep mood vectors fresh as the sonic embedding backfill
    // grows. The manual admin button stays available for an immediate on-demand run.
    schedule: { every: '12h', runOnStartup: false },

    // Text-embedding class: reads media_embeddings, writes mood_vectors.
    // maxConcurrent=1 — no benefit from parallel runs; each mood is processed
    // sequentially inside generateMusicMoodVectors anyway.
    resourceClass: 'embedding',
    quotas: { maxConcurrent: 1 },

    scope: 'global',
    identityFor: () => 'global',

    inputSchema,

    timeout: { hard: '30m', soft: '25m' },

    async execute(ctx): Promise<{
        success: boolean;
        itemsProcessed: number;
        result: MoodVectorGenerationResult;
        message?: string;
    }> {
        const { sql: rawSql, logger: ctxLogger } = ctx;
        const sql = rawSql as unknown as postgres.Sql;

        // Feature gate — mood vectors are only used by the sonic queue path.
        if (!features.sonicQueue) {
            ctxLogger.info('sonicQueue feature is disabled — mood-vector generation is a no-op');
            return {
                success: true,
                itemsProcessed: 0,
                result: { textGenerated: 0, audioGenerated: 0 },
                message: 'sonicQueue feature is disabled',
            };
        }

        ctxLogger.info('Starting mood vector generation for all MUSIC_MOOD_SEEDS (text + audio)');

        // 1. Text-space vectors (model_id='text') — consumed by mood-recommendations.
        try {
            await generateMusicMoodVectors(sql);
        } catch (err) {
            logger.error(
                'generateMusicMoodVectors threw unexpectedly',
                err instanceof Error ? err : undefined,
            );
            // A normal `return {success:false}` here used to be silently
            // recorded 'completed' by the runner. Rethrow as a transient
            // TaskError (DB/embedding-read failure — worth a retry) so the
            // run is marked failed and the circuit breaker can see it.
            throw new TaskError({
                message: `generateMusicMoodVectors failed: ${err instanceof Error ? err.message : String(err)}`,
                kind: 'transient',
                cause: err,
            });
        }

        // Text generation succeeded.
        const textGenerated = 1;
        let audioGenerated = 0;

        // 2. Audio-space vectors (model_id='msclap-2023') — consumed by sonic queue GAMMA arm.
        try {
            await generateAudioMoodVectors(sql);
            audioGenerated = 1;
        } catch (err) {
            // Non-fatal: text vectors succeeded; log and continue.
            logger.error(
                'generateAudioMoodVectors threw unexpectedly',
                err instanceof Error ? err : undefined,
            );
        }

        // Each call iterates over all MUSIC_MOOD_SEEDS internally; we report 2 items processed
        // (text pass + audio pass) to signal both stages completed.
        const message =
            audioGenerated > 0
                ? 'Mood vector generation complete (text + audio)'
                : 'Mood vector generation complete (text only; audio failed — check logs)';
        ctxLogger.info(message);

        return {
            success: true,
            itemsProcessed: textGenerated + audioGenerated,
            result: { textGenerated, audioGenerated },
            message,
        };
    },
});

// Self-register into the singleton registry.
registry.registerTask(moodVectorGenerationTask);
