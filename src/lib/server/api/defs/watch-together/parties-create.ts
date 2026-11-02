// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/parties-create.ts
 *
 *   POST /watch-together/parties → 201 bare { party: WatchTogetherParty }
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import {
    isDependencyError,
    AuthDependencyUnavailableError,
} from '$lib/server/auth/dependency-unavailable.js';
import { toPublicParty } from '$lib/server/services/watch-together-public.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { createSession } from '$lib/server/services/watch-together.service.js';
import { isWidgetDisabled } from '$lib/server/utils/widget-guard.js';
import { mediaIdResolver } from '$lib/server/services/media-id-resolver.js';
import { getDb } from '$lib/server/database/connection.js';
import { getFilesForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { createSessionSchema, WatchTogetherPartySchema } from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether');

export const CreatePartyResponseSchema = z
    .object({
        party: WatchTogetherPartySchema,
    })
    .meta({ id: 'WT_CreatePartyResponse' });

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        body: createSessionSchema,
    },
    handlers: {
        /**
         * POST /watch-together/parties
         * Creates a new watch-together party for the authenticated user.
         * visibility: "listed" is the host’s explicit choice and is not blocked by the hide-my-streams privacy switch.
         * Returns 201 { party }.
         */
        POST: async (event, ctx) => {
            if (isWidgetDisabled('watch-parties')) {
                return ApiProblem.notFound('Watch-together is disabled');
            }

            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const body = ctx.input?.body;
            if (!body) {
                return ApiProblem.validationFailed('Request body is required');
            }

            const {
                itemId: rawItemId,
                mediaType,
                title,
                posterUrl,
                currentTime,
                fileId,
                clientId,
                visibility,
            } = body;

            // Canonicalize itemId to internal UUID
            let itemId = rawItemId;
            try {
                const resolved = await mediaIdResolver.resolveAnyMediaId(rawItemId);
                if (resolved.internalId) itemId = resolved.internalId;
            } catch {
                logger.warn(`Could not resolve itemId for watch-together [rawItemId=${rawItemId}]`);
            }

            // Age + library access gate
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database unavailable');

            const accessAllowed = await checkMediaAccess(db, itemId, event.locals.user ?? null);
            if (!accessAllowed) return ApiProblem.notFound('Media not found or access denied');

            // Validate fileId belongs to the resolved item
            let validatedFileId = fileId;
            if (fileId) {
                const files = await getFilesForMediaItem(db, itemId);
                if (!files.some((f) => f.id === fileId)) {
                    logger.warn('Create session fileId does not belong to item, dropping', {
                        fileId,
                        itemId,
                    });
                    validatedFileId = undefined;
                }
            }

            try {
                const session = await createSession(
                    userId,
                    user.username,
                    itemId,
                    mediaType,
                    title,
                    posterUrl,
                    currentTime,
                    validatedFileId,
                    clientId,
                    visibility,
                );

                if (!session) {
                    return ApiProblem.internalError('Failed to create watch-together session');
                }

                return json({ party: await toPublicParty(session, ctx.surface) }, { status: 201 });
            } catch (err) {
                if (isDependencyError(err)) throw new AuthDependencyUnavailableError(err);
                logger.error('Create session error', err as Error);
                return ApiProblem.internalError('Failed to create session');
            }
        },
    },
});
