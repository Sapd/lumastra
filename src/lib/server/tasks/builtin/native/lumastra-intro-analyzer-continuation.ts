// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import type postgres from 'postgres';
import { registry } from '../../registry.js';
import { config } from '$lib/server/config.js';

const ANALYZER = 'lumastra-intro-analyzer';

/** Query only the latest global run; cancellation/failure must stop a chain. */
export async function introContinuationDue(sql: postgres.Sql): Promise<string | null> {
    if (!config.PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED) return null;
    const [row] = await sql<{ id: string }[]>`
        WITH latest AS (
            SELECT id,state,result FROM task_history
            WHERE task_id=${ANALYZER}
              AND NOT (COALESCE(input,'{}'::jsonb) ?| ARRAY[
                  'mediaId','seasonId','seriesId','seasonIds','segmentTypes','outroOnly'])
            ORDER BY started_at DESC,id DESC LIMIT 1
        )
        SELECT id FROM latest
        WHERE state IN ('completed','failed') AND result->>'stopReason'='budget'
          AND (COALESCE((result->>'itemsProcessed')::int,0)>0
               OR COALESCE((result #>> '{result,fingerprintsProcessed}')::int,0)>0)
          AND (COALESCE((result #>> '{result,pendingBacklog,seasons}')::int,0)
             + COALESCE((result #>> '{result,pendingBacklog,singleEpisodes}')::int,0)
             + COALESCE((result #>> '{result,pendingBacklog,movies}')::int,0))>0
          AND NOT EXISTS (SELECT 1 FROM scheduler_state WHERE task_id=${ANALYZER} AND paused)
          AND NOT EXISTS (SELECT 1 FROM task_history WHERE task_id=${ANALYZER}
                          AND state IN ('pending','active','cancelling'))
    `;
    return row?.id ?? null;
}

export const introAnalyzerContinuationTask = defineTask({
    id: 'lumastra-intro-analyzer-continuation',
    name: 'Continue segment analysis',
    description: 'Continues unfinished segment analysis after a chunk reaches its time budget.',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true },
    resourceClass: 'io',
    scope: 'global',
    inputSchema: z.object({ previousRunId: z.string() }),
    identityFor: (input) => input.previousRunId,
    quotas: { maxConcurrent: 1 },
    timeout: { hard: '1m', soft: '45s' },
    dynamicSchedule: {
        sweepEvery: '1m',
        async loader(ctx) {
            const previousRunId = await introContinuationDue(ctx.sql);
            return previousRunId
                ? [{ rowId: previousRunId, bucket: previousRunId, input: { previousRunId } }]
                : [];
        },
    },
    async execute(ctx) {
        // Recheck after queue delay. A new original run suppresses repeats even
        // where dynamic-scheduler idempotency receipts have expired.
        if ((await introContinuationDue(ctx.sql)) !== ctx.input.previousRunId)
            return { success: true, itemsProcessed: 0 };
        const { orchestrator } = await import('../../orchestrator.js');
        const started = await orchestrator.startRun(
            ANALYZER,
            { mode: 'catchup' },
            {
                trigger: { kind: 'in-process', by: 'lumastra-intro-analyzer-continuation' },
            },
        );
        return { success: true, itemsProcessed: started.deduped ? 0 : 1 };
    },
});

registry.registerTask(introAnalyzerContinuationTask);
