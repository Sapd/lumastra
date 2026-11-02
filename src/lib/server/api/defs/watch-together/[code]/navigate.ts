// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/navigate.ts
 *
 *   POST /watch-together/{code}/navigate → 204 No Content
 *
 * Host broadcasts navigation to a new media item. Validates that:
 *   1. The resolved itemId is accessible to the caller (age+library gate).
 *   2. If fileId is supplied, it belongs to the resolved item.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { AuthDependencyUnavailableError } from '$lib/server/auth/dependency-unavailable.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { navigateParty } from '$lib/server/services/watch-together.service.js';
import { mediaIdResolver } from '$lib/server/services/media-id-resolver.js';
import { getDb } from '$lib/server/database/connection.js';
import { getFilesForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    sessionCodeParamsSchema,
    navigateSchema,
    type NavigateInput,
} from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether');

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: navigateSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = (ctx.input?.params as { code?: string })?.code ?? event.params.code!;
            const body = ctx.input?.body as NavigateInput | undefined;

            if (!body) return ApiProblem.validationFailed('Request body is required');

            const {
                itemId: rawItemId,
                title,
                mediaType,
                clientId,
                fileId,
                timelineId,
                expectedTimelineId,
            } = body;

            // Canonicalize itemId to internal UUID
            let itemId = rawItemId;
            try {
                const resolved = await mediaIdResolver.resolveAnyMediaId(rawItemId);
                if (resolved.internalId) itemId = resolved.internalId;
            } catch {
                logger.warn(`Could not resolve itemId for navigate [rawItemId=${rawItemId}]`);
            }

            // Age + library access gate
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database unavailable');

            const accessAllowed = await checkMediaAccess(db, itemId, event.locals.user ?? null);
            if (!accessAllowed) return ApiProblem.notFound('Media not found or access denied');

            // Validate fileId belongs to item (defense-in-depth)
            let validatedFileId = fileId;
            if (fileId) {
                const files = await getFilesForMediaItem(db, itemId);
                if (!files.some((f) => f.id === fileId)) {
                    logger.warn('Navigate fileId does not belong to item, dropping', {
                        code,
                        fileId,
                        itemId,
                    });
                    validatedFileId = undefined;
                }
            }

            try {
                // Shared with the /events navigate arm (security review 2026-09-12, C11):
                // enforces the host-only gate and the participantsBlockedBy access check,
                // which this REST route previously skipped, letting any participant
                // redirect the whole party onto an item another participant could not see.
                const result = await navigateParty(code, itemId, title, {
                    userId,
                    clientId,
                    timelineId,
                    expectedTimelineId,
                    mediaType,
                    fileId: validatedFileId,
                });
                if (!result.ok) {
                    return result.status === 'not_found'
                        ? ApiProblem.notFound(result.message)
                        : ApiProblem.forbidden(result.message);
                }
                return new Response(null, { status: 204 });
            } catch (err) {
                if (err instanceof AuthDependencyUnavailableError) throw err;
                logger.error('Navigate error', err as Error, { code });
                return ApiProblem.internalError('Failed to broadcast navigation');
            }
        },
    },
});
