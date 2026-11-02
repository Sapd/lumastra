// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { musicInteractionManager } from '$lib/server/services/music-interaction-manager.service.js';
import { MediaAccessDeniedError } from '$lib/server/utils/resolve-and-gate.js';

const FeedbackSchema = z.object({ feedback: z.enum(['liked', 'disliked']) });
export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:write'] },
    request: {
        body: FeedbackSchema.partial(),
        bodyMethods: ['PUT'],
        params: z.object({ id: z.string().uuid() }),
    },
    docs: {
        PUT: {
            tags: ['Music'],
            operationId: 'putUserMusicTracksIdFeedback',
            stability: 'beta',
            summary: 'Set explicit track feedback',
            description:
                'Sets rating 9 (liked) or 2 (disliked), protected from inferred skip/completion changes.',
            body: FeedbackSchema,
            responses: {
                204: 'Feedback set',
                401: 'Authentication required',
                404: 'Track not found',
            },
        },
        DELETE: {
            tags: ['Music'],
            operationId: 'deleteUserMusicTracksIdFeedback',
            stability: 'beta',
            summary: 'Clear track feedback',
            description: 'Idempotently removes the rating row in either direction.',
            responses: {
                204: 'Feedback cleared',
                401: 'Authentication required',
                404: 'Track not found',
            },
        },
    },
    handlers: {
        PUT: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();
            try {
                const parsed = FeedbackSchema.safeParse(
                    ctx.input?.body ?? (await event.request.json().catch(() => null)),
                );
                if (!parsed.success)
                    return problem('validation_failed', {
                        error: 'feedback must be liked or disliked',
                    });
                const feedback = parsed.data.feedback;
                await musicInteractionManager[feedback === 'liked' ? 'like' : 'dislike'](
                    user.userId,
                    ctx.input!.params!.id,
                    user,
                );
                return new Response(null, { status: 204 });
            } catch (err) {
                if (err instanceof MediaAccessDeniedError)
                    return ApiProblem.notFound('Track not found');
                throw err;
            }
        },
        DELETE: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();
            try {
                await musicInteractionManager.clearFeedback(
                    user.userId,
                    ctx.input!.params!.id,
                    user,
                );
                return new Response(null, { status: 204 });
            } catch (err) {
                if (err instanceof MediaAccessDeniedError)
                    return ApiProblem.notFound('Track not found');
                throw err;
            }
        },
    },
});
