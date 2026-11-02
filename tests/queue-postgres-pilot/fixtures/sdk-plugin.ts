// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Ordinary plugin source: no BullMQ or PostgreSQL imports and no pilot ABI.
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { z } from 'zod';

export default defineTask({
    id: 'postgres-pilot-sdk',
    name: 'Postgres pilot SDK fixture',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.1.0',
    resourceClass: 'maintenance',
    capabilities: {},
    inputSchema: z.object({
        identity: z.string().min(1),
        failure: z.enum(['none', 'transient', 'permanent', 'fatal']).default('none'),
    }),
    identityFor: (input) => input.identity,
    async execute(ctx) {
        if (ctx.signal !== ctx.abortSignal) throw new Error('SDK signal aliases diverged');
        if (!ctx.catalog || !ctx.mediaItems || !ctx.mediaFiles || !ctx.userCredentials)
            throw new Error('SDK context surface missing');
        ctx.logger.info('SDK fixture running', { runId: ctx.runId });
        ctx.reportProgress(1, 2, ctx.input.identity);
        if (
            ctx.input.failure !== 'none' &&
            (ctx.input.failure !== 'transient' || ctx.attemptNumber === 1)
        ) {
            throw new TaskError({
                kind: ctx.input.failure,
                message: `SDK ${ctx.input.failure} fixture`,
            });
        }
        ctx.reportProgress(2, 2, ctx.input.identity);
        return {
            success: true,
            itemsProcessed: 2,
            result: {
                identity: ctx.input.identity,
                runId: ctx.runId,
                attemptNumber: ctx.attemptNumber,
                mode: ctx.mode,
            },
        };
    },
});
