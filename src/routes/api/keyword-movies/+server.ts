// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keyword Media API - Fetch movies and TV series by keyword
 * Returns both movies and TV shows matching the given keyword
 * Supports AI personalization when user has a taste profile
 */
import { json } from '@sveltejs/kit';
import { toMovieOrSeries } from '$lib/shared/media-type-domain';
import { z } from 'zod';
import { PageBlockSchema } from '$lib/schemas/pagination';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { mount } from '$lib/server/api/mount.js';
import { Logger } from '$lib/server/utils/logger';
import { aiDbService } from '$lib/server/services/database.service';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import {
    findKeywordMediaPersonalized,
    findKeywordMedia,
    userHasCatalogProfile,
} from '$lib/server/database/queries/keyword-media.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';

const logger = Logger.for('KeywordMedia');

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const KeywordMoviesQuerySchema = z.object({
    keyword: z.string().min(1),
    limit: z.coerce.number().int().min(1).max(500).optional().default(20),
    offset: z.coerce.number().int().min(0).optional().default(0),
});

// ---------------------------------------------------------------------------
// Response schema (typed — no z.unknown() / passthrough / z.any())
// Wire shape: { keyword, personalized, items: [...], page }
// Canonical: field is 'type', enum is 'movie' | 'series' (never 'tv').
// Consumer maps 'series' -> 'tv' for imageFromIds / mediaCompositeKey.
// ---------------------------------------------------------------------------

const KeywordMovieItemSchema = z.object({
    externalIds: z.record(z.string(), z.string()),
    type: z.enum(['movie', 'series']),
    title: z.string(),
    overview: z.string().nullable().optional(),
    year: z.number().int().nullable().optional(),
    imdbRating: z.number().nullable().optional(),
    rtRating: z.number().nullable().optional(),
    rtAudienceRating: z.number().nullable().optional(),
    letterboxdRating: z.number().nullable().optional(),
    mdblistScore: z.number().nullable().optional(),
    qualityScore: z.number().int(),
    aiSimilarity: z.number().int().nullable(),
    popularity: z.number().nullable().optional(),
    isAvailable: z.boolean(),
    canRequest: z.boolean(),
});

const KeywordMoviesResponseSchema = z.object({
    keyword: z.string(),
    personalized: z.boolean(),
    page: PageBlockSchema,
    items: z.array(KeywordMovieItemSchema),
});

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        query: KeywordMoviesQuerySchema,
    },
    handlers: {
        /**
         * GET /api/keyword-movies?keyword=<keyword>[&limit=<n>][&offset=<n>]
         *
         * Returns keyword-matched media items with pagination.
         * Wire shape: { keyword, personalized, items: [...], page }
         * Canonical field: 'type' ∈ 'movie' | 'series' (DB 'tv' → 'series').
         * Error shape: application/problem+json (incl. 503 dependency_unavailable)
         */
        GET: async (event, ctx) => {
            const { locals } = event;

            const query = ctx.input!.query;
            const { keyword, limit, offset } = query;

            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('AI database unavailable');
            }

            const keywordLower = keyword.toLowerCase().trim();
            const userId = locals.user.userId;

            // Check if user has an AI profile for personalization
            let userHasProfile = false;
            try {
                userHasProfile = await userHasCatalogProfile(sql, userId);
            } catch {
                logger.debug('No user profile found for personalization', { userId });
            }

            // One boundary object, built from this user's real permissions and
            // passed whole — never unpacked into loose locals and re-assembled
            // per call site, which is the drop-an-argument footgun the
            // MediaAccessBoundary shape exists to eliminate.
            const accessCtx = await buildSearchAccessContext(sql, locals.user);
            const access = searchAccessBoundary(accessCtx);

            let movies;
            if (userHasProfile && userId) {
                movies = await findKeywordMediaPersonalized(sql, {
                    keyword: keywordLower,
                    limit: limit + 1,
                    offset,
                    userId,
                    access,
                    availableOnly: !accessCtx.showUnavailableMedia,
                });
            } else {
                movies = await findKeywordMedia(sql, {
                    keyword: keywordLower,
                    limit: limit + 1,
                    offset,
                    access,
                    availableOnly: !accessCtx.showUnavailableMedia,
                });
            }

            logger.info('Keyword media fetched', {
                keyword,
                count: movies.length,
                personalized: userHasProfile,
            });

            const primaryProvider = getPrimaryExternalIdProvider();

            return json(
                KeywordMoviesResponseSchema.parse({
                    keyword,
                    personalized: userHasProfile,
                    page: { limit, offset, hasMore: movies.length > limit },
                    // findKeywordMedia / findKeywordMediaPersonalized query
                    // `media_items` with NO media_type restriction — they match
                    // on keyword/mdblist_keywords alone, so a genre/keyword-
                    // tagged audiobook or track can legitimately come back.
                    // This response's `type` is movie/series only, so drop
                    // anything else rather than mislabel it. `hasMore` is
                    // still computed from the raw (pre-filter) lookahead above,
                    // matching the DB page size.
                    items: movies
                        .slice(0, limit)
                        .map((m) => {
                            const type = toMovieOrSeries(m.media_type);
                            if (!type) return null;
                            return {
                                externalIds: {
                                    ...(m.internal_id ? { internal: m.internal_id } : {}),
                                    [primaryProvider]: String(m.primary_ext_id),
                                },
                                type,
                                title: m.title,
                                overview: m.overview,
                                year: m.release_date
                                    ? new Date(m.release_date).getFullYear()
                                    : null,
                                imdbRating: m.imdb_rating,
                                rtRating: m.rt_rating,
                                rtAudienceRating: m.rt_audience_score,
                                letterboxdRating: m.letterboxd_rating,
                                mdblistScore: m.mdblist_score,
                                qualityScore: Math.round(m.quality_score || 0),
                                aiSimilarity: m.ai_similarity
                                    ? Math.round(m.ai_similarity * 100)
                                    : null,
                                popularity: m.popularity,
                                isAvailable: m.is_available || false,
                                canRequest: m.can_request || false,
                            };
                        })
                        .filter((m): m is NonNullable<typeof m> => m !== null),
                }),
            );
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
