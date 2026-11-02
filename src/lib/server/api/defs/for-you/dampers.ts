// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET  /api/for-you/dampers  — list the user's active "show less like this" dampers
 * DELETE /api/for-you/dampers — remove one damper (body: { mediaId }) or all ({ all: true })
 *
 * Response shapes (new contract):
 *   GET:    { dampers: TasteDamperItem[] }          (bare object, no success wrapper)
 *   DELETE: { cleared: number }                     (bare object; success implied by 200)
 *
 * Migrated from:
 *   GET:    typedJson(ActiveDampersResponseSchema, { dampers })
 *   DELETE: typedJson(ClearDampersResponseSchema, { success: true, cleared })
 *
 * 503 when DB unavailable (was a generic 500 in the old route).
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';

const DeleteBodySchema = z
    .object({
        mediaId: z.string().guid().optional(),
        all: z.boolean().optional(),
    })
    .refine((b) => b.all === true || typeof b.mediaId === 'string', {
        message: 'Provide either mediaId or all:true',
    });

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        body: DeleteBodySchema.optional(),
    },
    handlers: {
        GET: async (event) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const { getTasteDamperService } =
                await import('$lib/server/services/taste-damper.service.js');
            const dampers = await getTasteDamperService(sql).listActiveDampers(userId);
            return json({ dampers });
        },

        DELETE: async (event) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const rawBody = await event.request.json().catch(() => null);
            const bodyParsed = DeleteBodySchema.safeParse(rawBody);
            if (!bodyParsed.success) {
                return ApiProblem.validationFailed(
                    bodyParsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const { mediaId, all } = bodyParsed.data;

            const { getTasteDamperService } =
                await import('$lib/server/services/taste-damper.service.js');
            const service = getTasteDamperService(sql);

            if (all) {
                const cleared = await service.clearAll(userId);
                return json({ cleared });
            }
            // mediaId guaranteed present by schema refine
            const cleared = await service.removeDamper(userId, mediaId as string);
            return json({ cleared });
        },
    },
});
