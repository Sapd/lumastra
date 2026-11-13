// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tier-2 endpoint: GET /api/v1/recommendations
 *
 * The personalised recommendations multiplexer.
 *
 * ?type= dispatch:
 *   ?type=ai                        — AI-powered suggestions
 *   ?type=ai&genre=                 — genre-filtered AI suggestions
 *   ?type=ai&types=series       — series-only AI suggestions
 *   ?type=mood                      — mood-based recommendations
 *   ?type=for-you                   — personalised for-you shelf
 *   ?type=fulfilled-requests        — previously requested titles now available
 *   ?type=because-you-watched       — video "because you watched" by default
 *   ?type=because-you-watched&domain=music — music "because you listened to"
 *   ?type=editorial&theme=holiday   — curated thematic editorial shelf
 *   ?type=trending                  — trending list (also at Tier-1 /trending)
 *   ?type=popular-shows             — popular TV shows (curated rail)
 *   ?type=fresh-releases            — recently released, library-available
 *   ?type=binge-worthy              — highly-rated binge series
 *   ?type=anime                     — anime (403 for age-restricted profiles)
 *   ?type=short-movies              — movies under 90 minutes
 *   ?type=recently-added            — recently scanned library items
 *   ?type=random-picks              — random discovery (re-randomised per call)
 *
 * The curated rails above fold the former GET /api/for-you/* endpoints into
 * this single multiplexer via the shared getRailItems() dispatch + strategy
 * registry — same fetch/filter/cache path as /feed.
 *
 * Query params:
 *   type         — strategy selector (see ?type= list above)
 *   limit        — page size (1–100, default 20)
 *   offset       — page offset (default 0)
 *   seed         — seed media id (used by 'because-you-watched' for explicit seed)
 *   genre        — genre filter (for 'ai' strategy)
 *   mood         — mood name (for 'mood' strategy)
 *   domain       — content domain ('video' by default; use 'music' explicitly)
 *   types        — CSV allow-list of public media types (e.g. 'movie,series')
 *   hideWatched  — exclude already-watched items
 *   theme        — thematic hint forwarded to 'editorial' strategy (e.g. 'holiday')
 *   availableOnly — per-request availability override: 'true'|'1' returns only
 *                  available items (the tvOS "available only" toggle). Distinct
 *                  from the always-on SHOW_UNAVAILABLE_MEDIA server config gate.
 *                  Honored by for-you and trending-backed strategies; no-op for
 *                  ai/mood/editorial (no isAvailable on candidates).
 *
 * Response: { items: RecommendationItem[], page: PageBlock }
 */

import { json, type RequestEvent } from '@sveltejs/kit';
import type { SurfaceContext } from '$lib/server/api/define.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { recommendationPreviews } from '$lib/server/services/media-preview.service.js';
import { getDb as previewDb } from '$lib/server/database/connection.js';
import { paginate, ApiProblem, isDependencyUnavailable } from '$lib/server/api/problem.js';
import {
    getRailItems,
    buildAccessContext,
    UnknownRailError,
    type RecommenderOptions,
} from './recommender.js';
import { parseWatchedTmdb, parseWatchedUuids } from './strategies/rail-extra.js';
import { RecommendationsResponseSchema } from '$lib/schemas/api-recommender-responses';
import { MOOD_PROFILES } from '$lib/server/services/mood-profiles.js';
import { parseMediaTypeFilter, PUBLIC_MEDIA_TYPE_VALUES } from './continue-watching.js';

export const RecommendationsQuerySchemaFromDocs = z.strictObject({
    type: z
        .enum([
            'ai',
            'mood',
            'for-you',
            'fulfilled-requests',
            'because-you-watched',
            'editorial',
            'trending',
            'popular-shows',
            'fresh-releases',
            'binge-worthy',
            'anime',
            'short-movies',
            'recently-added',
            'random-picks',
            'from-your-ratings',
        ])
        .optional()
        .meta({
            description:
                'Recommendation strategy (default: for-you). Personalised/rule-based ' +
                'strategies: ai, mood, for-you, fulfilled-requests, because-you-watched, ' +
                'editorial, trending. Curated library rails: popular-shows, fresh-releases, ' +
                'binge-worthy, anime, short-movies, recently-added, random-picks. ' +
                '`from-your-ratings` is an alias of `ai` (the web "From your ratings" taste ' +
                'rail). Note: `anime` returns 403 for age-restricted profiles; `random-picks` ' +
                'is re-randomised per call (offset/refresh are no-ops).',
        }),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .meta({ description: 'Page size (default 20)' }),
    offset: z.number().int().min(0).optional().meta({ description: 'Page offset (default 0)' }),
    mood: z
        .enum([
            'relaxing',
            'exciting',
            'brainfood',
            'thoughtful',
            'emotional',
            'funny',
            'romantic',
            'spooky',
            'quickwatch',
            'hiddengems',
            'cozy',
            'epic',
            'nostalgic',
            'inspiring',
            'darkgritty',
            'familynight',
            'datenight',
            'educational',
            'guiltypleasure',
            'visuallystunning',
            'comfortrewatch',
            'eveningchill',
        ])
        .optional()
        .meta({
            description:
                'Required for `type=mood` (no-op otherwise). Selects a curated keyword/genre ' +
                'profile — an unrecognised value returns an empty result rather than erroring.',
        }),
    genre: z.string().optional().meta({
        description: 'TMDB genre id filter, forwarded to the active strategy.',
    }),
    seed: z
        .string()
        .optional()
        .meta({
            description:
                'Seed media id — used by `type=because-you-watched` for an explicit seed. Also ' +
                'applies to `domain=video`: an internal-UUID seed the caller can access anchors ' +
                'the rail on that title (labeled with its own name) instead of the most-recently ' +
                'watched item; any other value silently falls back to the most-recent item.',
        }),
    domain: z.string().optional().meta({
        description: "Content domain forwarded to `type=because-you-watched` (e.g. 'music').",
    }),
    types: z
        .string()
        .optional()
        .meta({
            description:
                'Comma-separated public media-type allow-list. Filtering happens before pagination; ' +
                'omitted or empty means no filtering.',
        }),
    hideWatched: z.string().optional().meta({
        description: 'Exclude already-watched items. Accepts "true" | "1".',
    }),
    theme: z.string().optional().meta({
        description: "Theme hint forwarded to `type=editorial` (e.g. 'holiday').",
    }),
    watched: z
        .string()
        .optional()
        .meta({
            description:
                'CSV of TMDB ids the client has already seen. Extra watched-exclusion source ' +
                'for the curated rails (fresh-releases, binge-worthy, anime, short-movies).',
        }),
    watchedIds: z
        .string()
        .optional()
        .meta({
            description:
                'CSV of internal media UUIDs the client has already seen. Extra ' +
                'watched-exclusion source for binge-worthy / anime.',
        }),
    availableOnly: z
        .string()
        .optional()
        .meta({
            description:
                'Per-request availability override. Pass "true" or "1" to restrict results to ' +
                'library-available items only (the tvOS "available only" toggle). ' +
                'Distinct from the always-on SHOW_UNAVAILABLE_MEDIA server-config gate. ' +
                'Honored by for-you and trending-backed strategies; no-op for ai/mood/editorial.',
        }),
});

export const RecommendationsQuerySchema = z.strictObject({
    type: z
        .enum([
            'ai',
            'mood',
            'for-you',
            'fulfilled-requests',
            'because-you-watched',
            'editorial',
            'trending',
            // Folded curated for-you rails (formerly GET /api/for-you/*).
            'popular-shows',
            'fresh-releases',
            'binge-worthy',
            'anime',
            'short-movies',
            'recently-added',
            'random-picks',
            // Alias of `ai` — the web "From your ratings" taste rail. Same
            // generator; exposed under an explicit name for client parity.
            'from-your-ratings',
        ])
        .optional()
        .default('for-you'),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    offset: z.coerce.number().int().min(0).optional().default(0),
    seed: z.string().optional(),
    genre: z.string().optional(),
    /**
     * Mood selector for `type=mood`. Enum DERIVED from the canonical
     * `MOOD_PROFILES` taxonomy (single source of truth) so the gate can never
     * drift from the recommender's supported moods. Unknown values are rejected
     * at the gate with a 422 rather than silently yielding an empty rail.
     */
    mood: z.enum(Object.keys(MOOD_PROFILES)).optional(),
    /** Content domain forwarded to 'because-you-watched' strategy (e.g. 'music'). */
    domain: z.string().optional(),
    types: z.string().optional(),
    hideWatched: z
        .string()
        .optional()
        .transform((v) => v === 'true' || v === '1'),
    /** Theme hint forwarded to 'editorial' strategy (e.g. 'holiday'). */
    theme: z.string().optional(),
    /**
     * CSV of TMDB ids the client has already seen — forwarded to the folded
     * curated rails (fresh-releases / binge-worthy / anime / short-movies) as
     * an extra watched-exclusion source. Ignored by strategies that don't read it.
     */
    watched: z.string().optional(),
    /**
     * CSV of internal media UUIDs the client has already seen — forwarded to
     * binge-worthy / anime as an extra watched-exclusion source.
     */
    watchedIds: z.string().optional(),
    /**
     * Per-request availability override — the tvOS "available only" toggle.
     * Accepts: 'true' | '1'.
     * When true, only items with isAvailable === true are returned.
     * Distinct from the always-on SHOW_UNAVAILABLE_MEDIA server-config gate.
     */
    availableOnly: z
        .string()
        .optional()
        .transform((v) => v === 'true' || v === '1'),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Recommendations'],
            summary: 'Get recommendations',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns personalized recommendations based on the selected `?type` strategy. ' +
                'Each item is the MediaPreview with an opaque id handle, catalogId and ImageSet; ' +
                '`reason.kind` reflects the active strategy. ' +
                'The `ai` strategy requires a configured Voyage key. ' +
                'Other strategies are rule-based and work without AI. ' +
                'Pass `?availableOnly=true` to restrict results to ' +
                'library-available items only — the per-request counterpart to the server-wide ' +
                'SHOW_UNAVAILABLE_MEDIA configuration gate.',
            query: RecommendationsQuerySchemaFromDocs,
            responses: {
                200: {
                    schema: RecommendationsResponseSchema,
                    description: 'Recommendations list',
                },
                401: 'Authentication required',
                403: 'Forbidden (e.g. type=anime for an age-restricted profile)',
                503: 'Database unavailable',
                429: 'Forced AI refresh budget exceeded (30 per 60 seconds per user)',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        query: RecommendationsQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            if (event.url.searchParams.has('refresh'))
                return ApiProblem.validationFailed('Use POST /recommendations/refresh');
            return handleRecommendations(event, ctx, Object.fromEntries(event.url.searchParams));
        },
    },
});

export async function handleRecommendations(
    event: RequestEvent,
    surfaceCtx: SurfaceContext,
    raw: unknown,
    refresh = false,
): Promise<Response> {
    const parsed = RecommendationsQuerySchema.safeParse(raw);
    if (!parsed.success) {
        return ApiProblem.validationFailed(
            parsed.error.issues.map((e) => ({
                field: e.path.join('.'),
                message: e.message,
            })),
        );
    }
    const q = parsed.data;

    const mediaTypeFilter = parseMediaTypeFilter(q.types);
    if (mediaTypeFilter.invalid.length > 0) {
        return ApiProblem.validationFailed([
            {
                field: 'types',
                message:
                    `Unknown media type(s): ${mediaTypeFilter.invalid.join(', ')}. ` +
                    `Allowed: ${PUBLIC_MEDIA_TYPE_VALUES.join(', ')}.`,
            },
        ]);
    }

    // Push a single video token into strategies that support it as an
    // efficiency hint. runRecommender's shared expanding-prefix boundary
    // remains authoritative and applies the public offset afterwards.
    const scalarMediaType =
        mediaTypeFilter.allow?.size === 1
            ? mediaTypeFilter.allow.has('movie')
                ? 'movie'
                : mediaTypeFilter.allow.has('series')
                  ? 'series'
                  : undefined
            : undefined;

    const ctx = await buildAccessContext(event);
    if (!ctx) return ApiProblem.unauthorized();

    // Age gate: the folded `anime` rail is unavailable to age-restricted
    // profiles. Enforce the canonical 403 before dispatch (the strategy
    // also defensively returns empty so /feed can't leak it).
    if (q.type === 'anime' && ctx.isAgeRestricted) {
        return ApiProblem.forbidden('This feature is not available for age-restricted profiles');
    }

    // Build the `extra` bag for strategy-specific params.  Merge domain
    // (because-you-watched), theme (editorial) and the folded-rail
    // watched-exclusion CSVs so each strategy only reads what it cares
    // about from the shared bag.
    const watchedTmdbIds = parseWatchedTmdb(q.watched);
    const watchedUuids = parseWatchedUuids(q.watchedIds);
    const extraEntries: Record<string, unknown> = {
        ...(q.domain ? { domain: q.domain } : {}),
        ...(q.theme ? { theme: q.theme } : {}),
        ...(watchedTmdbIds.length ? { watchedTmdbIds } : {}),
        ...(watchedUuids.length ? { watchedUuids } : {}),
    };
    const extra: Record<string, unknown> | undefined =
        Object.keys(extraEntries).length > 0 ? extraEntries : undefined;

    // Per-request availability override: ?availableOnly=true|1.
    const availableOnly = q.availableOnly;

    // Tier-2 data-plane: a dependency-down signal must surface as
    // 503 dependency_unavailable — NEVER a 200 with an empty array.
    let result;
    try {
        const opts: RecommenderOptions = {
            surface: surfaceCtx.surface,
            limit: q.limit,
            offset: q.offset,
            seed: q.seed,
            genre: q.genre,
            mood: q.mood,
            mediaType: scalarMediaType,
            hideWatched: q.hideWatched,
            refresh,
            availableOnly,
            extra,
        };
        result = await getRailItems(q.type, ctx, {
            ...opts,
            mediaTypes: mediaTypeFilter.allow,
        });
    } catch (err) {
        // Unknown type is bad client input → validation_failed (never 503).
        if (err instanceof UnknownRailError) {
            return ApiProblem.validationFailed([{ field: 'type', message: err.message }]);
        }
        // Dependency DOWN → 503 dependency_unavailable (never an empty 200).
        if (isDependencyUnavailable(err)) {
            return ApiProblem.dependencyUnavailable(err.message);
        }
        throw err;
    }

    return json(
        paginate(await recommendationPreviews(previewDb()!, surfaceCtx.surface, result.items), {
            limit: q.limit,
            offset: q.offset,
            hasMore: result.hasMore,
            total: result.total,
        }),
    );
}
