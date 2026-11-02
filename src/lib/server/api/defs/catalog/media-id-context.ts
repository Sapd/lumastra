// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/catalog/media-id-context.ts — `media/{id}/context`.
 *
 * Composite "detail panel" endpoint that fans out to internal defs and
 * returns a sparse object: only sections that succeeded are included.
 *
 * Contract (bare object — heterogeneous, sections are optional):
 *   GET /media/{id}/context?include=details,similar,social,rating,nextEpisode,watched
 *     → {
 *         details?:     MediaDetail,
 *         similar?:     SimilarResponse,
 *         social?:      SocialActivityResponse,
 *         rating?:      { rating?, canRate },
 *         nextEpisode?: { id, title, seasonNumber, episodeNumber, … },
 *         watched?:     { watched: boolean },
 *       }
 *
 * Because sections are optional and caller-driven, the schema uses a
 * discriminated-union-per-field approach (each field has its own typed
 * schema; the whole object uses z.object with all fields optional).
 *
 * Auth: user (auth requirement is applied by the mount that delegates to us;
 *       internally we use event.locals.user directly because individual section
 *       handlers do their own auth checks).
 * Surface: internal.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { watchManager } from '$lib/server/services/watch-manager.service.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { resolveCatalogInternalId } from './resolve-id.js';
import { MediaNodeSchema } from '$lib/schemas/media-detail.js';
import { ContextNextEpisodeSchema } from '$lib/schemas/api-media-context-response.js';
import { SimilarMediaResponseSchema } from '$lib/schemas/api-content-responses.js';
import { SocialWatchActivityResponseSchema } from '$lib/schemas/api-integrations-responses.js';
import { buildMediaDetail } from './media-id.js';
import {
    findEffectiveRuntimeSeconds,
    findPlaybackDurationMs,
} from '$lib/server/database/queries/media-items.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import { buildWatchActivity } from '../integrations/social-watch-activity.js';

const logger = Logger.for('MediaContextDef');

// ---------------------------------------------------------------------------
// Typed sub-schemas for each section
// ---------------------------------------------------------------------------

// "details" section.
//
// MUST be the SAME schema `media/{id}` publishes, because this section IS that
// endpoint's body — `buildMediaDetail()` builds both. A narrower local copy is
// not harmless documentation: declaring any 200 schema switches on mount()'s
// conformance strip, which in dev AND prod re-emits the parse result, so every
// field the schema omits is deleted from the wire — on the internal
// `/api/media/[id]/context` mount the web modal uses as much as on /api/v1.
const DetailsSectionSchema = MediaNodeSchema;

// "similar" section — the body of `media/{id}/similar`, verbatim. That def
// declares SimilarMediaResponseSchema for its own 200, and this section is
// whatever that route returned, so the two must be the same schema.
const SimilarSectionSchema = SimilarMediaResponseSchema;

// "social" section — the body of `buildWatchActivity()`.
//
// `activities` items are SocialActivityItemSchema, the shape that function has
// always emitted (username/description/rating/…). The hand-written
// `{username, action, timestamp}` this replaced described fields that exist
// nowhere in the codebase: harmless while it was dead text, but once published
// with `additionalProperties: false` it made a generated Swift decoder reject
// the first response containing a real activity.
const SocialSectionSchema = SocialWatchActivityResponseSchema;

// "rating" section
const RatingSectionSchema = z.object({
    rating: z.number().int().min(0).max(10).optional(),
    canRate: z.boolean(),
});

// "nextEpisode" section
const NextEpisodeSectionSchema = ContextNextEpisodeSchema;

// "watched" section
const WatchedSectionSchema = z.object({
    watched: z.boolean(),
});

// Full composite response schema — all sections optional
export const MediaContextResponseSchema = z.object({
    details: DetailsSectionSchema.optional(),
    similar: SimilarSectionSchema.optional(),
    social: SocialSectionSchema.optional(),
    rating: RatingSectionSchema.optional(),
    nextEpisode: NextEpisodeSectionSchema.optional(),
    watched: WatchedSectionSchema.optional(),
    /**
     * Keys of the sections that were requested AND succeeded. A section
     * absent from the body can mean two very different things — genuinely
     * empty (present here) or unavailable to this caller/feature-gated/errored
     * (absent here) — and `included` is what tells them apart.
     */
    included: z.array(z.string()),
});

export type MediaContextResponse = z.infer<typeof MediaContextResponseSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_SECTIONS = new Set([
    'details',
    'similar',
    'social',
    'rating',
    'nextEpisode',
    'watched',
]);

// buildInternalHeaders intentionally does NOT set `authorization` — SvelteKit's
// event.fetch forwards the original request's Authorization header automatically
// for SAME-ORIGIN dispatch when the outgoing request has not already set one
// (create_fetch, @sveltejs/kit/src/runtime/server/fetch.js:129-139, gated on
// credentials !== 'omit'). Verified against Kit 2.55.0. This only holds because
// apiUrl() emits a same-origin relative path — if `similar` ever targets an
// absolute/cross-origin URL, or sets credentials:'omit', bearer forwarding
// silently breaks and must be added here explicitly.
//
// Forward-auth identity headers are copied only when THIS request was signed in
// by them (authMethod 'forward_auth', i.e. it already passed the
// FORWARD_AUTH_ENABLED + TRUSTED_PROXY_IPS gate). Otherwise a client's own copies
// would be re-emitted onto the sub-request, which is then only safe as long as the
// sub-request is gated again with the same peer.
function buildInternalHeaders(
    request: Request,
    authMethod: string | undefined,
): Record<string, string> {
    const headers: Record<string, string> = {};
    if (authMethod === 'forward_auth') {
        const userHeader = request.headers.get(config.USERHEADER);
        const groupHeader = request.headers.get(config.GROUPHEADER);
        if (userHeader) headers[config.USERHEADER] = userHeader;
        if (groupHeader) headers[config.GROUPHEADER] = groupHeader;
    }
    const cookie = request.headers.get('cookie');
    if (cookie) headers['cookie'] = cookie;
    return headers;
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    docs: {
        GET: {
            tags: ['Media'],
            summary: "Get everything for a title's detail page",
            description:
                'Composite detail payload. `include` selects sections; the response echoes the ' +
                'honored set in `included[]`. A section absent from `included` was unavailable ' +
                '(feature disabled, age-restricted, or its lookup failed), NOT empty. An ' +
                '`include` naming no recognized section is rejected rather than answered with ' +
                'an empty result.',
            stability: 'stable',
            auth: 'bearer',
            query: z.object({
                include: z
                    .string()
                    .optional()
                    .meta({
                        description:
                            'Comma-separated section names to fetch: `details`, `similar`, ' +
                            '`social`, `rating`, `nextEpisode`, `watched`. Omit (or leave empty/' +
                            'whitespace) to fetch every section. An unrecognized-only value is ' +
                            'rejected with 422; a value with at least one recognized section is ' +
                            'honored for that subset.',
                    }),
            }),
            responses: {
                200: { schema: MediaContextResponseSchema, description: 'Composite media context' },
                401: 'Authentication required',
                404: 'Media not found',
                422: 'No recognized section in `include`',
            },
        },
    },

    handlers: {
        GET: async (event, ctx) => {
            const { url, params, locals } = event;
            const userId = locals.user?.userId;
            const isAgeRestricted = locals.user?.isAgeRestricted ?? false;
            // The access boundary needs the whole `locals.user`, not just its id.
            const detailUser = locals.user;

            const rawId = params.id;
            if (!rawId) {
                return ApiProblem.validationFailed([
                    { field: 'params.id', message: 'id is required' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            const internalId = await resolveCatalogInternalId(event);
            if (!internalId) return ApiProblem.notFound('Media not found');

            if (!(await checkMediaAccess(sql, internalId, event.locals.user))) {
                return ApiProblem.notFound('Media not found');
            }

            // `?include=` ABSENT, empty, or all-whitespace means "everything".
            // Whitespace is grouped with the other two on purpose: `?include=%20`
            // carries no section token, so answering it with 422 "Unknown
            // section(s): (none)" contradicted this endpoint's own contract and
            // named nothing the client could act on. A non-empty `include`
            // naming ONLY unknown sections is still a client error, not an empty
            // selection: silently filtering it to nothing produced a 200 with
            // `included: []`, which is exactly what "every section you asked for
            // was unavailable" looks like. Partial nonsense stays tolerated —
            // one recognized token is enough to serve the request.
            const includeParam = url.searchParams.get('include');
            let sections: Set<string>;
            const requested = (includeParam ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
            if (requested.length > 0) {
                const known = requested.filter((s) => VALID_SECTIONS.has(s));
                if (known.length === 0) {
                    return ApiProblem.validationFailed([
                        {
                            field: 'include',
                            message:
                                `Unknown section(s): ${requested.join(', ')}. ` +
                                `Valid sections: ${[...VALID_SECTIONS].join(', ')}`,
                        },
                    ]);
                }
                sections = new Set(known);
            } else {
                sections = new Set(VALID_SECTIONS);
            }

            const headers = buildInternalHeaders(event.request, event.locals.authMethod);

            type SectionEntry = {
                key: Exclude<keyof MediaContextResponse, 'included'>;
                value: unknown;
            };
            const promises: Promise<SectionEntry | null>[] = [];

            // -----------------------------------------------------------------
            // Complex sections — delegate to existing route handlers
            // -----------------------------------------------------------------

            if (sections.has('details')) {
                promises.push(
                    buildMediaDetail(
                        sql,
                        internalId,
                        ctx.surface,
                        '',
                        userId,
                        // The modal reads its audiobook block from HERE, not from
                        // GET /media/{id} — so omitting this thunk silently drops
                        // the series rail on the one surface that renders it.
                        detailUser
                            ? async () =>
                                  searchAccessBoundary(
                                      await buildSearchAccessContext(sql, detailUser),
                                  )
                            : undefined,
                    )
                        .then((body): SectionEntry | null => {
                            if (!body) return null;
                            return { key: 'details', value: body };
                        })
                        .catch(() => null),
                );
            }

            if (sections.has('similar') && !isAgeRestricted) {
                promises.push(
                    event
                        .fetch(apiUrl(ctx.surface, `/media/${rawId}/similar`), { headers })
                        .then(async (r): Promise<SectionEntry | null> => {
                            if (!r.ok) return null;
                            return { key: 'similar', value: await r.json() };
                        })
                        .catch(() => null),
                );
            }

            if (sections.has('social') && !isAgeRestricted) {
                promises.push(
                    // rawId, NOT internalId: the season→series roll-up and the
                    // scope wording live inside buildWatchActivity and need the
                    // raw form. It runs its own access check against whatever
                    // that resolves to, which is required here — `internalId`
                    // above can come from `?externalId=` and name a DIFFERENT
                    // item than the path id we hand over.
                    buildWatchActivity(sql, rawId, locals.user, ctx.surface)
                        .then((out): SectionEntry | null =>
                            out.ok ? { key: 'social', value: out.body } : null,
                        )
                        .catch(() => null),
                );
            }

            // -----------------------------------------------------------------
            // Simple sections — direct service calls
            // -----------------------------------------------------------------

            if (sections.has('rating') && userId && internalId) {
                promises.push(
                    (async (): Promise<SectionEntry | null> => {
                        try {
                            const dbSql = await aiDbService.getSql();
                            if (!dbSql) return null;
                            const rows = await dbSql<{ rating: number }[]>`
                                SELECT rating
                                FROM user_ratings
                                WHERE user_id = ${userId}
                                  AND media_id = ${internalId}
                                LIMIT 1
                            `;
                            return {
                                key: 'rating',
                                value: {
                                    rating: rows.length > 0 ? rows[0].rating : undefined,
                                    canRate: true,
                                },
                            };
                        } catch (err) {
                            logger.debug('Rating section failed', {
                                error: err instanceof Error ? err.message : 'unknown',
                            });
                            return null;
                        }
                    })(),
                );
            }

            if (sections.has('nextEpisode') && userId && internalId) {
                promises.push(
                    (async (): Promise<SectionEntry | null> => {
                        try {
                            const episode = await watchManager.getNextUpForSeries(
                                internalId,
                                userId,
                            );
                            if (!episode) return null;
                            const id = episode.media_id;
                            if (!id) return null;
                            const runtimeSeconds =
                                episode.runtime_seconds ||
                                (episode.media_id
                                    ? await findEffectiveRuntimeSeconds(sql, episode.media_id)
                                    : null);
                            const durationMs =
                                (await findPlaybackDurationMs(sql, id)) ??
                                (runtimeSeconds ? Math.round(runtimeSeconds * 1000) : null);
                            return {
                                key: 'nextEpisode',
                                value: {
                                    id,
                                    title: episode.title ?? null,
                                    seasonNumber: episode.season_number ?? null,
                                    episodeNumber: episode.episode_number ?? null,
                                    overview: episode.overview ?? undefined,
                                    durationMs,
                                    premiereDate: episode.premiere_date
                                        ? String(episode.premiere_date)
                                        : undefined,
                                },
                            };
                        } catch (err) {
                            logger.debug('NextEpisode section failed', {
                                error: err instanceof Error ? err.message : 'unknown',
                            });
                            return null;
                        }
                    })(),
                );
            }

            if (sections.has('watched') && userId && internalId) {
                promises.push(
                    (async (): Promise<SectionEntry | null> => {
                        try {
                            const state = await watchManager.getWatchState(userId, internalId);
                            return {
                                key: 'watched',
                                value: { watched: state?.is_watched ?? false },
                            };
                        } catch (err) {
                            logger.debug('Watched section failed', {
                                error: err instanceof Error ? err.message : 'unknown',
                            });
                            return null;
                        }
                    })(),
                );
            }

            const settled = await Promise.allSettled(promises);
            const result: MediaContextResponse = { included: [] };

            for (const s of settled) {
                if (s.status === 'fulfilled' && s.value) {
                    result[s.value.key] = s.value.value as never;
                    result.included.push(s.value.key);
                }
            }

            return json(result);
        },
    },
});
