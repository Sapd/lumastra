// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { config } from '$lib/server/config.js';
import {
    runNeverOwnedMediaGc,
    NEVER_OWNED_GC_DEFAULT_TIME_BUDGET_MS,
    NEVER_OWNED_GC_MAX_TIME_BUDGET_MS,
    type NeverOwnedGcResult,
} from '$lib/server/services/never-owned-media-gc.service.js';

export const neverOwnedMediaGcInput = z
    .object({
        dryRun: z
            .boolean()
            .default(false)
            .describe(
                'Report what would be deleted without deleting anything. Runs are always previews while the cleanup is off in Settings.',
            ),
        batchLimit: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .default(500)
            .describe(
                'Maximum movies/series (with their seasons, episodes and extras) deleted per batch',
            ),
        timeBudgetMs: z
            .number()
            .int()
            .min(1)
            .max(NEVER_OWNED_GC_MAX_TIME_BUDGET_MS)
            .default(NEVER_OWNED_GC_DEFAULT_TIME_BUDGET_MS)
            .describe(
                'Time budget in milliseconds for successive cleanup batches (previews evaluate once)',
            ),
    })
    .strict();

export const neverOwnedMediaGcTask = defineTask<
    z.infer<typeof neverOwnedMediaGcInput>,
    NeverOwnedGcResult
>({
    id: 'never-owned-media-gc',
    name: 'Never-Owned Media Cleanup',
    purpose: 'maintenance',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true },
    schedule: { every: '24h', runOnStartup: false },
    identityFor: (input) => (input.dryRun ? 'preview' : 'global'),
    scope: 'global',
    resourceClass: 'maintenance',
    exclusiveWith: { scope: 'global', ttl: '70m' },
    quotas: { maxConcurrent: 1 },
    timeout: { hard: '70m', soft: '65m' },
    inputSchema: neverOwnedMediaGcInput,
    async execute(ctx) {
        const result = await runNeverOwnedMediaGc(
            ctx.sql,
            ctx.input,
            {
                enabled: config.NEVER_OWNED_MEDIA_GC_ENABLED,
                minAgeDays: config.NEVER_OWNED_MEDIA_GC_MIN_AGE_DAYS,
            },
            ctx.signal,
        );
        ctx.logger.info(result.summary, {
            dryRun: result.dryRun,
            forcedDryRun: result.forcedDryRun,
            eligible: result.eligible,
            batches: result.batches,
            timeBudgetMs: result.timeBudgetMs,
            stoppedOnBudget: result.stoppedOnBudget,
            deleted: result.deleted,
            keptByCategory: result.kept.byCategory,
            keptByRule: result.kept.byRule,
            tooYoung: result.tooYoung,
            skipReasons: result.skipReasons,
            sampleIds: result.sampleIds,
        });
        const deletedUnits = result.deleted.movieUnits + result.deleted.seriesUnits;
        return { success: true, itemsProcessed: deletedUnits, result };
    },
});
registry.registerTask(neverOwnedMediaGcTask);
