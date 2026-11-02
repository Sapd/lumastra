// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/version.ts
 *
 *   POST /watch-together/{code}/version → 204 No Content
 *
 * Host broadcasts a version/file-selection change (e.g. switching from 1080p to 4K).
 * All participants switch to the same file so the session stays in sync.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { broadcastVersionChange } from '$lib/server/services/watch-together.service.js';
import { sessionCodeParamsSchema, versionChangeSchema } from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether');

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: versionChangeSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = (ctx.input?.params as { code?: string })?.code ?? event.params.code!;
            const body = ctx.input?.body as { fileId: string; clientId: string } | undefined;
            const fileId = body?.fileId ?? '';
            const clientId = body?.clientId ?? '';

            try {
                const ok = await broadcastVersionChange(code, userId, fileId, clientId);
                if (!ok) {
                    return ApiProblem.forbidden(
                        'Not a participant, session not found, or invalid file',
                    );
                }
                return new Response(null, { status: 204 });
            } catch (err) {
                logger.error('Version change error', err as Error, { code });
                return ApiProblem.internalError('Failed to broadcast version change');
            }
        },
    },
});
