// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import {
    runMediaRetention,
    type MediaRetentionResult,
} from '$lib/server/services/media-retention.service.js';

export const mediaRetentionInput = z
    .object({
        dryRun: z
            .boolean()
            .default(false)
            .describe('Preview eligible records without writing or deleting anything'),
        batchLimit: z
            .number()
            .int()
            .min(1)
            .max(1000)
            .default(100)
            .describe('Maximum retention units considered in this run'),
    })
    .strict();

export const unavailableMediaRetentionTask = defineTask<
    z.infer<typeof mediaRetentionInput>,
    MediaRetentionResult
>({
    id: 'unavailable-media-retention',
    name: 'Unavailable Media Retention',
    purpose: 'maintenance',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true },
    schedule: { every: '24h', runOnStartup: false },
    identityFor: (input) => (input.dryRun ? 'preview' : 'global'),
    scope: 'global',
    resourceClass: 'maintenance',
    exclusiveWith: { scope: 'global', ttl: '20m' },
    quotas: { maxConcurrent: 1 },
    timeout: { hard: '15m', soft: '12m' },
    inputSchema: mediaRetentionInput,
    async execute(ctx) {
        const result = await runMediaRetention(ctx.sql, ctx.input, ctx.signal);
        const message =
            result.retentionDays === 0
                ? 'Unavailable media retention disabled: 0 rows deleted (UNAVAILABLE_MEDIA_RETENTION_DAYS=0)'
                : `Unavailable media retention: ${result.deletedRows} rows deleted, ${result.deleted} units deleted, ${result.initialized} clocks initialized${result.dryRun ? ' (preview)' : ''}`;
        ctx.logger.info(message, { ...result });
        return {
            success: true,
            itemsProcessed: result.deleted + result.initialized,
            result,
            message,
        };
    },
});
registry.registerTask(unavailableMediaRetentionTask);
