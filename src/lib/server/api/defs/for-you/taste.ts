// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/taste — the "From your ratings" taste rail.
 *
 * Thin adapter over the shared `aiStrategy` via `runRecommender` (Plan 1 gave
 * the strategy cursor paging + explicit `status` + typed `reason`). The
 * feed's legacy `aiSections` composer (`GET /api/ai/suggestions`) stays alive
 * for now — this endpoint is additive; the old one is retired in a later
 * deletion task.
 *
 * `getTasteRailPage` is the composition function, exported for direct
 * integration testing (mirrors `defs/rate/queue.ts`'s `buildRateQueue`); the
 * GET handler below is a thin wrapper (query parsing, auth, error mapping).
 *
 * PATCH /api/for-you/taste — per-user "include my watch
 * history" toggle. Persists into `user_profiles.preferences` (query module,
 * not raw SQL here), synchronously rebuilds the profile, and wipes the
 * suggestions cache so the change is visible on the next taste-rail fetch.
 * `patchIncludeWatchHistory` is exported for the same direct-integration-test
 * reason as `getTasteRailPage`.
 *
 * Auth: user. No bespoke per-endpoint rate limit — mirrors the other
 * for-you/recommendations defs (short-movies, similar, dismiss, the
 * `?type=ai` branch of /api/recommendations, …), none of which rate-limit
 * per endpoint.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import {
    ApiProblem,
    DependencyUnavailableError,
    isDependencyUnavailable,
} from '$lib/server/api/problem.js';
import {
    TasteRailResponseSchema,
    TasteIncludeWatchHistoryPatchBodySchema,
    OkAckResponseSchema,
    type TasteRailResponse,
    type OkAckResponse,
} from '$lib/schemas/api-for-you-responses.js';
import type { UserId } from '$lib/shared/user-id.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getIncludeWatchHistoryPreference,
    setIncludeWatchHistoryPreference,
} from '$lib/server/database/queries/user-profile-prefs.queries.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { cacheInvalidation } from '$lib/server/cache/invalidation.js';
import {
    runRecommender,
    buildAccessContext,
    type AccessContext,
} from '../recommendations/recommender.js';
import { aiStrategy } from '../recommendations/strategies/index.js';
import { type ApiSurface } from '$lib/shared/api-urls.js';

export interface TasteRailOpts {
    /** API surface the caller is serving — selects the prefix for emitted URLs. */
    surface: ApiSurface;
    /** Clamped 1..30 by the query schema; re-validated here for direct callers. */
    limit: number;
    /** Opaque cursor from a previous page's `nextCursor`. */
    cursor?: string;
    /** Explicit refresh — first page only; cursor pages never regenerate (see AiStrategy). */
    refresh?: boolean;
}

/**
 * Run the `ai` strategy through the shared `runRecommender` pipeline and map
 * straight through to the taste-rail response contract. Additionally reads
 * the current `includeWatchHistory` toggle so the client can
 * render the rail overflow menu's checkbox without a second round trip.
 */
export async function getTasteRailPage(
    ctx: AccessContext,
    opts: TasteRailOpts,
): Promise<TasteRailResponse> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit), 1), 30);
    const result = await runRecommender(aiStrategy, ctx, {
        surface: opts.surface,
        limit,
        cursor: opts.cursor,
        refresh: opts.refresh === true,
    });

    // Best-effort: a DB hiccup here must not fail the whole rail response —
    // fall back to the true default rather than surfacing a 503 for an
    // additive field.
    let includeWatchHistory = true;
    const sql = getDb();
    if (sql) {
        try {
            includeWatchHistory = await getIncludeWatchHistoryPreference(sql, ctx.userId);
        } catch {
            includeWatchHistory = true;
        }
    }

    return {
        status: result.status ?? 'ready',
        items: result.items,
        page: {
            limit,
            hasMore: result.hasMore,
            ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        },
        includeWatchHistory,
    };
}

/**
 * Persist the includeWatchHistory toggle and synchronously rebuild the
 * user's taste profile so it takes effect on the very next taste-rail fetch.
 * Awaited (not fire-and-forget) — a settings toggle can afford the extra
 * latency, and a silent background rebuild would leave the rail stale with
 * no way for the client to know when it's safe to refetch.
 */
export async function patchIncludeWatchHistory(
    userId: UserId,
    includeWatchHistory: boolean,
): Promise<OkAckResponse> {
    const sql = getDb();
    if (!sql) throw new DependencyUnavailableError('Database not available');

    await setIncludeWatchHistoryPreference(sql, userId, includeWatchHistory);

    const profileService = await aiDbService.getUserProfileService();
    if (profileService) {
        await profileService.rebuildUserProfile(userId);
    }

    // Suggestions cache wipe — reuses the shared invalidation path (same one
    // `ratingManager`/`clearRating` use) so the rebuilt profile's output
    // isn't masked by a stale cached page.
    await cacheInvalidation.invalidateUserRecommendations(userId, 'manual');

    return { ok: true };
}

export const TasteQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(30).optional().default(15),
    cursor: z.string().optional(),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['For You'],
            summary: 'Get the taste rail — strategy-backed AI recommendations',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns a cursor-paged page of the "From your ratings" taste rail. ' +
                '`status` distinguishes a genuinely-empty page (`exhausted`) from one ' +
                'whose AI profile is still being generated (`generating`) from a normal ' +
                'page (`ready`). Cursor pages never trigger regeneration — only an ' +
                'explicit POST to /for-you/taste/refresh does. `includeWatchHistory` ' +
                'reflects the current per-user toggle (see `PATCH`).',
            query: TasteQuerySchema,
            responses: {
                200: { schema: TasteRailResponseSchema, description: 'Taste rail page' },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        PATCH: {
            tags: ['For You'],
            summary: 'Toggle whether the taste profile includes watch history',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Persists the `includeWatchHistory` preference and synchronously ' +
                'rebuilds the taste profile + wipes the suggestions cache, so the ' +
                'change is visible on the very next `GET`.',
            body: TasteIncludeWatchHistoryPatchBodySchema,
            responses: {
                200: { schema: OkAckResponseSchema, description: 'Preference saved' },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        query: TasteQuerySchema,
        queryMethods: ['GET'],
        body: TasteIncludeWatchHistoryPatchBodySchema,
        bodyMethods: ['PATCH'],
    },
    handlers: {
        GET: async (event, surfaceCtx) => {
            if (event.url.searchParams.has('refresh'))
                return ApiProblem.validationFailed('Use POST /for-you/taste/refresh');
            const raw = {
                limit: event.url.searchParams.get('limit') ?? undefined,
                cursor: event.url.searchParams.get('cursor') ?? undefined,
            };
            const parsed = TasteQuerySchema.safeParse(raw);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }
            const { limit, cursor } = parsed.data;

            const ctx = await buildAccessContext(event);
            if (!ctx) return ApiProblem.unauthorized();

            try {
                const page = await getTasteRailPage(ctx, {
                    surface: surfaceCtx.surface,
                    limit,
                    cursor,
                    refresh: false,
                });
                return json(TasteRailResponseSchema.parse(page));
            } catch (err) {
                if (isDependencyUnavailable(err)) {
                    return ApiProblem.dependencyUnavailable(err.message);
                }
                throw err;
            }
        },

        PATCH: async (event, ctx) => {
            const accessCtx = await buildAccessContext(event);
            if (!accessCtx) return ApiProblem.unauthorized();

            const body = ctx.input?.body;
            if (!body) {
                return ApiProblem.validationFailed([
                    { field: 'includeWatchHistory', message: 'Required' },
                ]);
            }

            try {
                const result = await patchIncludeWatchHistory(
                    accessCtx.userId,
                    body.includeWatchHistory,
                );
                return json(OkAckResponseSchema.parse(result));
            } catch (err) {
                if (isDependencyUnavailable(err)) {
                    return ApiProblem.dependencyUnavailable(err.message);
                }
                throw err;
            }
        },
    },
});
