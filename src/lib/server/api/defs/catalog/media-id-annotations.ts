// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/catalog/media-id-annotations.ts — `media/{id}/annotations`.
 *
 * Contract:
 *   GET    /media/{id}/annotations          → { items: [Annotation], page }
 *   POST   /media/{id}/annotations          → Annotation (201)
 *   DELETE /media/{id}/annotations/{annotId} → 204 (no body)
 *
 * Feature-flagged: mediaAnnotations / socialReviews must be enabled.
 * Auth: user. Surface: internal.
 */

import { z } from 'zod';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { features, config } from '$lib/server/config.js';
import {
    getAnnotations,
    createAnnotation,
    getUserPinCount,
    upsertReview,
    deleteAnnotation,
} from '$lib/server/database/queries/media-annotations.queries.js';
import { getUsernamesByIds } from '$lib/server/database/queries/users.queries.js';
import { resolveCatalogInternalId } from './resolve-id.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const annotationTypeSchema = z.enum(['chat', 'pin', 'review']);

export const AnnotationItemSchema = z.object({
    id: z.string().guid(),
    media_id: z.string().guid(),
    username: z.string(),
    type: annotationTypeSchema,
    content: z.string(),
    timestamp_seconds: z.number().nullable().optional(),
    created_at: z.string(),
});

export type AnnotationItem = z.infer<typeof AnnotationItemSchema>;

const GetQuerySchema = z.object({
    type: annotationTypeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    offset: z.coerce.number().int().min(0).optional().default(0),
});

const PostBodySchema = z
    .object({
        type: annotationTypeSchema,
        content: z
            .string()
            .min(1, 'Content is required')
            .transform((s) => s.trim()),
        timestamp_seconds: z.number().positive().optional(),
    })
    .refine(
        (data) => {
            if (data.type === 'pin' && data.timestamp_seconds === undefined) return false;
            if (data.type !== 'pin' && data.timestamp_seconds !== undefined) return false;
            return true;
        },
        { message: 'timestamp_seconds is required for pins and forbidden for chat/review' },
    )
    .refine(
        (data) => {
            const maxLen = data.type === 'pin' ? 200 : data.type === 'review' ? 1000 : 500;
            return data.content.length <= maxLen;
        },
        { message: 'Content too long' },
    );

/**
 * Admin authority comes from the PRINCIPAL (an admin's device token or
 * low-scope PAT is not admin); the annotation/review permissions and the
 * moderator flag are the user's own.
 */
function canAccessAnnotationType(
    locals: App.Locals,
    type: 'chat' | 'pin' | 'review' | undefined,
): boolean {
    const user = locals.user;
    if (locals.principal?.isAdmin === true || user?.isModerator) return true;
    if (type === 'review') return user?.hasReviewPermission === true;
    return user?.hasMediaAnnotationPermission === true;
}

// ---------------------------------------------------------------------------
// Collection def (GET + POST on /media/{id}/annotations)
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    request: {
        query: GetQuerySchema,
        body: PostBodySchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Media not found');

            if (!(await checkMediaAccess(sql, internalId, event.locals.user))) {
                return ApiProblem.notFound('Media not found');
            }

            const query = ctx.input?.query as z.infer<typeof GetQuerySchema> | undefined;
            const typeFilter =
                query?.type ??
                (event.url.searchParams.get('type') as
                    z.infer<typeof annotationTypeSchema> | undefined);
            const reviewsOnly = typeFilter === 'review';
            const allowed = features.mediaAnnotations || (reviewsOnly && features.socialReviews);
            if (!allowed) {
                return ApiProblem.notFound('Feature not enabled');
            }
            if (!canAccessAnnotationType(event.locals, typeFilter)) {
                return ApiProblem.forbidden('Insufficient community permissions');
            }

            const limit = query?.limit ?? 50;
            const offset = query?.offset ?? 0;

            const rows = await getAnnotations(sql, {
                mediaId: internalId,
                type: typeFilter,
                limit: limit + 1,
                currentUser: event.locals.user?.userId,
            });

            const hasMore = rows.length > limit;
            const pageRows = rows.slice(0, limit);
            const usernames = await getUsernamesByIds(sql, [
                ...new Set(pageRows.map((a) => a.user_id)),
            ]);
            const items: AnnotationItem[] = pageRows.map((a) => ({
                id: a.id,
                media_id: a.media_id,
                username: usernames.get(a.user_id.toLowerCase()) ?? a.user_id,
                type: a.type,
                content: a.content,
                timestamp_seconds: a.timestamp_seconds ? Number(a.timestamp_seconds) : null,
                created_at: a.created_at.toISOString(),
            }));

            return json(
                paginate(items, {
                    limit,
                    offset,
                    hasMore,
                    total: undefined,
                }),
            );
        },

        POST: async (event, ctx) => {
            const bodyType = ctx.input?.body?.type;
            if (bodyType === 'review') {
                if (!features.socialReviews) return ApiProblem.notFound('Feature not enabled');
            } else {
                if (!features.mediaAnnotations) return ApiProblem.notFound('Feature not enabled');
                if (bodyType === 'chat' && !features.mediaChat) {
                    return ApiProblem.notFound('Chat feature not enabled');
                }
            }
            if (!canAccessAnnotationType(event.locals, bodyType)) {
                return ApiProblem.forbidden('Insufficient community permissions');
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Media not found');

            if (!(await checkMediaAccess(sql, internalId, event.locals.user))) {
                return ApiProblem.notFound('Media not found');
            }

            const username = event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();

            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries.js');
            const userId = await getUserIdByUsername(sql, username);
            if (!userId) return ApiProblem.notFound('User not found');

            const body = ctx.input!.body;

            // Enforce pin limit
            if (body.type === 'pin') {
                const count = await getUserPinCount(sql, { mediaId: internalId, userId });
                if (count >= config.ANNOTATIONS_MAX_PINS) {
                    return ApiProblem.validationFailed([
                        {
                            field: 'body.type',
                            message: `Maximum ${config.ANNOTATIONS_MAX_PINS} pins per media item`,
                        },
                    ]);
                }
            }

            const annotation =
                body.type === 'review'
                    ? await upsertReview(sql, {
                          mediaId: internalId,
                          userId,
                          content: body.content,
                      })
                    : await createAnnotation(sql, {
                          mediaId: internalId,
                          userId,
                          type: body.type,
                          content: body.content,
                          timestampSeconds: body.timestamp_seconds,
                      });

            const item: AnnotationItem = {
                id: annotation.id,
                media_id: annotation.media_id,
                username,
                type: annotation.type,
                content: annotation.content,
                timestamp_seconds: annotation.timestamp_seconds
                    ? Number(annotation.timestamp_seconds)
                    : null,
                created_at: annotation.created_at.toISOString(),
            };

            return json(item, { status: 201 });
        },
    },
});

// ---------------------------------------------------------------------------
// Single-annotation def (DELETE /media/{id}/annotations/{annotationId})
// ---------------------------------------------------------------------------

export const annotationByIdDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    handlers: {
        DELETE: async (event, _ctx) => {
            if (!features.mediaAnnotations && !features.socialReviews) {
                return ApiProblem.notFound('Feature not enabled');
            }

            const annotationId = event.params.annotationId;
            if (!annotationId) {
                return ApiProblem.validationFailed([
                    { field: 'params.annotationId', message: 'annotationId is required' },
                ]);
            }

            if (!UUID_RE.test(annotationId)) return ApiProblem.notFound('Annotation not found');

            const username = event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();

            const isAdmin = event.locals.principal?.isAdmin === true;

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            const { getUserIdByUsername } =
                await import('$lib/server/database/queries/users.queries.js');
            const userId = await getUserIdByUsername(sql, username);
            if (!userId) return ApiProblem.unauthorized();

            await deleteAnnotation(sql, { annotationId, userId, isAdmin });

            return new Response(null, { status: 204 });
        },
    },
});
