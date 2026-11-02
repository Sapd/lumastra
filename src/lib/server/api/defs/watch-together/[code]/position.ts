// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/position.ts
 *
 *   POST /watch-together/{code}/position → bare { resyncing: boolean }
 *
 * Reports the caller's current position for drift detection.
 * Returns { resyncing: true } when the server detects significant drift and
 * triggers a resync event.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { reportPosition } from '$lib/server/services/watch-together.service.js';
import { sessionCodeParamsSchema, positionUpdateSchema } from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether');

export const PositionResponseSchema = z
    .object({
        resyncing: z.boolean().describe('True if server triggered a resync due to drift'),
    })
    .meta({ id: 'WT_PositionResponse' });

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: positionUpdateSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = (ctx.input?.params as { code?: string })?.code ?? event.params.code!;
            const body = ctx.input?.body as { position: number; clientId: string } | undefined;
            const position = body?.position ?? 0;
            const clientId = body?.clientId ?? '';

            try {
                const result = await reportPosition(code, clientId, userId, position);
                if (!result.success)
                    return ApiProblem.forbidden('Not a participant in this session');
                return json({ resyncing: result.resyncing ?? false });
            } catch (err) {
                logger.error('Position report error', err as Error, { code });
                return ApiProblem.internalError('Failed to report position');
            }
        },
    },
});
