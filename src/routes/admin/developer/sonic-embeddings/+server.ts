// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin API for Sonic Embeddings panel.
 *
 * GET  — return coverage stats (eligible tracks, done/failed/pending counts)
 *        plus Essentia analysis coverage (tracks with BPM/key/mood metadata).
 * POST — enqueue a manual task: sonic-embedding-backfill (action='start-backfill')
 *        or sonic-map-projection (action='start-map-projection'); or regenerate
 *        music mood vectors synchronously (action='regenerate-mood-vectors').
 *
 * Both endpoints require admin + sonicEmbeddings feature gate.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { features } from '$lib/server/config';
import { Logger } from '$lib/server/utils/logger';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('AdminSonicEmbeddings');

/**
 * GET /admin/developer/sonic-embeddings
 * Returns current Sonic Embeddings coverage statistics.
 */
export const GET: RequestHandler = async ({ locals }) => {
    try {
        if (!localsIsAdmin(locals)) {
            return ApiResponses.unauthorized();
        }

        if (!features.sonicEmbeddings) {
            return json(
                {
                    enabled: false,
                    message: 'Sonic Embeddings feature is not enabled',
                },
                { status: 200 },
            );
        }

        const { getSonicEmbeddingsStats } =
            await import('$lib/server/database/queries/sonic-embeddings-admin.queries.js');
        const { aiDbService } = await import('$lib/server/services/database.service.js');

        const sql = await aiDbService.getSql();
        if (!sql) return ApiResponses.error('Database unavailable');

        const [stats, totalResult, analyzedResult] = await Promise.all([
            getSonicEmbeddingsStats(sql),
            // Admin-only counts — access is gated at the route level, not in SQL.
            sql<{ count: bigint }[]>`
                SELECT COUNT(*) AS count
                FROM media_items
                WHERE media_type = 'track'
            `,
            sql<{ count: bigint }[]>`
                SELECT COUNT(*) AS count
                FROM media_items
                WHERE media_type = 'track'
                  AND custom_metadata->'essentia'->>'bpm' IS NOT NULL
            `,
        ]);

        const analysisCoverage = {
            totalTracks: Number(totalResult[0]?.count ?? 0),
            analyzedTracks: Number(analyzedResult[0]?.count ?? 0),
        };

        return json({
            enabled: true,
            stats,
            analysisCoverage,
        });
    } catch (error) {
        logger.error(
            'Failed to fetch sonic embeddings stats',
            error instanceof Error ? error : undefined,
        );
        return ApiResponses.error('Failed to fetch statistics');
    }
};

/**
 * POST /admin/developer/sonic-embeddings
 * Enqueues the sonic-embedding-backfill task when action='start-backfill'.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
    try {
        if (!localsIsAdmin(locals)) {
            return ApiResponses.unauthorized();
        }

        if (!features.sonicEmbeddings) {
            return json(
                {
                    success: false,
                    error: 'Sonic Embeddings feature is not enabled',
                },
                { status: 400 },
            );
        }

        const body = await readBoundedJson(request).catch(() => ({}));
        const action = (body as Record<string, unknown>).action;

        if (action === 'start-backfill') {
            const result = await orchestrator.startRun(
                'sonic-embedding-backfill',
                {},
                {
                    trigger: {
                        kind: 'manual',
                        by: locals.user.username,
                        sourceRoute: 'admin/sonic-embeddings',
                    },
                    priority: 1,
                },
            );

            return json({
                success: true,
                runId: result.runId,
                message: 'Backfill task enqueued successfully',
            });
        }

        if (action === 'start-map-projection') {
            const result = await orchestrator.startRun(
                'sonic-map-projection',
                {},
                {
                    trigger: {
                        kind: 'manual',
                        by: locals.user.username,
                        sourceRoute: 'admin/sonic-embeddings',
                    },
                    priority: 1,
                },
            );

            return json({
                success: true,
                runId: result.runId,
                message: 'Map projection task enqueued',
            });
        }

        if (action === 'regenerate-mood-vectors') {
            const { generateMusicMoodVectors, generateAudioMoodVectors } =
                await import('$lib/server/services/mood-vector.service.js');
            const { aiDbService } = await import('$lib/server/services/database.service.js');

            const sql = await aiDbService.getSql();
            if (!sql) return ApiResponses.error('Database unavailable');

            // Text-space vectors (power the mood-recommendation rows) AND audio-space
            // vectors (MSCLAP, model_id=msclap-2023 — power the sonic queue GAMMA arm).
            await generateMusicMoodVectors(sql);
            await generateAudioMoodVectors(sql);

            return json({
                success: true,
                message: 'Music mood vectors regenerated (text + audio) successfully',
            });
        }

        return json(
            {
                success: false,
                error: 'Invalid action',
            },
            { status: 400 },
        );
    } catch (error) {
        logger.error(
            'Failed to enqueue sonic embeddings backfill task',
            error instanceof Error ? error : undefined,
        );
        return ApiResponses.error('Failed to enqueue task');
    }
};
