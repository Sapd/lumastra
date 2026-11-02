// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mood-Based Recommendations API - Server-Driven UI
 *
 * Returns PageSection[] directly for the frontend to render.
 * Time-aware, mood-based media recommendations with AI personalization.
 * Cached per user+mood for 10 minutes to reduce DB load.
 *
 * Query Parameters:
 * - mood: Override auto-detected mood (optional)
 * - type: Filter by media type - 'movie' | 'tv' (optional)
 * - limit: Number of results (default: 12)
 * - trending: Include trending boost (default: true)
 * - mode: 'keyword' (default) | 'vector' - recommendation mode
 *   - keyword: SQL-based keyword/genre matching (current implementation)
 *   - vector: Pure vector-based using pre-computed mood vectors
 */
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';
import { refreshRateLimit } from '$lib/server/api/defs/recommendations/_refresh-rate-limit.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { MoodRecommendationsResponseSchema } from './_openapi';
import { Logger } from '$lib/server/utils/logger';
import { aiDbService } from '$lib/server/services/database.service';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import {
    buildSearchAccessContext,
    scopedCacheKey,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import * as m from '$lib/paraglide/messages';
import { createExternalIds } from '$lib/utils/external-ids';
import { getCatalogPosterUrl } from '$lib/utils/image-utils';
import { generateUniversalId } from '$lib/server/utils/universal-id';
import { getMoodVectorService } from '$lib/server/services/mood-vector.service';
import { getTasteDamperService } from '$lib/server/services/taste-damper.service';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import {
    findMoodMediaPersonalized,
    findMoodMedia,
    findTrendingMoodMedia,
} from '$lib/server/database/queries/mood-recommendations.queries.js';
import type { MoodMediaRow } from '$lib/server/database/queries/mood-recommendations.queries.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types.js';
import { toMovieOrSeries } from '$lib/shared/media-type-domain';
import { MOOD_PROFILES } from '$lib/server/services/mood-profiles.js';
import { shouldSuppressContent } from '$lib/server/services/content-affinity.service.js';

const logger = Logger.for('MoodRecommendations');

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const MoodRecommendationsQuerySchema = z.object({
    mood: z.string().optional(),
    type: z.enum(['movie', 'tv']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional().default(12),
    // trending defaults to true; set trending=false to opt out
    trending: z
        .string()
        .optional()
        .transform((v) => v !== 'false'),
    mode: z.enum(['keyword', 'vector']).optional().default('keyword'),
    moodWeight: z.coerce.number().min(0).max(1).optional().default(0.6),
    userWeight: z.coerce.number().min(0).max(1).optional().default(0.4),
});

// Vector mode cache - separate from keyword mode
const vectorMoodCache = cacheManager.for(CACHE_NAMESPACES.vectorMoodRecommendations);

// Cache mood recommendations - type-safe, TTLs from centralized config
// v3: Updated profile descriptions to show genres instead of redundant mood text
const moodCache = cacheManager.for(CACHE_NAMESPACES.moodRecommendations);

// ---------------------------------------------------------------------------
// Mood profiles
// ---------------------------------------------------------------------------

// Keyword/genre rule data lives in the shared MOOD_PROFILES table
// ($lib/server/services/mood-profiles.ts, also used by
// MoodRecommendationsService). Only the i18n name/description lookup is
// route-specific.
type MoodI18n = {
    nameKey: () => string;
    descKey: () => string;
};

const MOOD_I18N: Record<string, MoodI18n> = {
    relaxing: { nameKey: m.mood_profile_relaxing_name, descKey: m.mood_profile_relaxing_desc },
    exciting: { nameKey: m.mood_profile_exciting_name, descKey: m.mood_profile_exciting_desc },
    brainfood: { nameKey: m.mood_profile_brainfood_name, descKey: m.mood_profile_brainfood_desc },
    thoughtful: {
        nameKey: m.mood_profile_thoughtful_name,
        descKey: m.mood_profile_thoughtful_desc,
    },
    emotional: { nameKey: m.mood_profile_emotional_name, descKey: m.mood_profile_emotional_desc },
    funny: { nameKey: m.mood_profile_funny_name, descKey: m.mood_profile_funny_desc },
    romantic: { nameKey: m.mood_profile_romantic_name, descKey: m.mood_profile_romantic_desc },
    spooky: { nameKey: m.mood_profile_spooky_name, descKey: m.mood_profile_spooky_desc },
    quickwatch: {
        nameKey: m.mood_profile_quickwatch_name,
        descKey: m.mood_profile_quickwatch_desc,
    },
    hiddengems: {
        nameKey: m.mood_profile_hiddengems_name,
        descKey: m.mood_profile_hiddengems_desc,
    },
    cozy: { nameKey: m.mood_profile_cozy_name, descKey: m.mood_profile_cozy_desc },
    epic: { nameKey: m.mood_profile_epic_name, descKey: m.mood_profile_epic_desc },
    nostalgic: { nameKey: m.mood_profile_nostalgic_name, descKey: m.mood_profile_nostalgic_desc },
    inspiring: { nameKey: m.mood_profile_inspiring_name, descKey: m.mood_profile_inspiring_desc },
    darkgritty: {
        nameKey: m.mood_profile_darkgritty_name,
        descKey: m.mood_profile_darkgritty_desc,
    },
    familynight: {
        nameKey: m.mood_profile_familynight_name,
        descKey: m.mood_profile_familynight_desc,
    },
    datenight: { nameKey: m.mood_profile_datenight_name, descKey: m.mood_profile_datenight_desc },
    educational: {
        nameKey: m.mood_profile_educational_name,
        descKey: m.mood_profile_educational_desc,
    },
    guiltypleasure: {
        nameKey: m.mood_profile_guiltypleasure_name,
        descKey: m.mood_profile_guiltypleasure_desc,
    },
    visuallystunning: {
        nameKey: m.mood_profile_visuallystunning_name,
        descKey: m.mood_profile_visuallystunning_desc,
    },
    comfortrewatch: {
        nameKey: m.mood_profile_comfortrewatch_name,
        descKey: m.mood_profile_comfortrewatch_desc,
    },
    eveningchill: {
        nameKey: m.mood_profile_eveningchill_name,
        descKey: m.mood_profile_eveningchill_desc,
    },
};

type MoodKey =
    | 'relaxing'
    | 'exciting'
    | 'brainfood'
    | 'thoughtful'
    | 'emotional'
    | 'funny'
    | 'romantic'
    | 'spooky'
    | 'quickwatch'
    | 'hiddengems'
    | 'cozy'
    | 'epic'
    | 'nostalgic'
    | 'inspiring'
    | 'darkgritty'
    | 'familynight'
    | 'datenight'
    | 'educational'
    | 'guiltypleasure'
    | 'visuallystunning'
    | 'comfortrewatch'
    | 'eveningchill';

const isMoodKey = (value: string): value is MoodKey =>
    Object.prototype.hasOwnProperty.call(MOOD_PROFILES, value);

function getMoodProfileTranslated(mood: MoodKey): { name: string; description: string } {
    const i18n = MOOD_I18N[mood];
    return {
        name: i18n.nameKey(),
        description: i18n.descKey(),
    };
}

function getTimeBasedMood(): { primary: MoodKey; secondary: MoodKey; timeOfDay: string } {
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();

    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isFriday = dayOfWeek === 5;

    if (hour >= 6 && hour < 12) {
        if (isWeekend)
            return { primary: 'nostalgic', secondary: 'familynight', timeOfDay: 'morning' };
        if (dayOfWeek === 1)
            return { primary: 'inspiring', secondary: 'funny', timeOfDay: 'morning' };
        return { primary: 'funny', secondary: 'quickwatch', timeOfDay: 'morning' };
    }
    if (hour >= 12 && hour < 17) {
        if (isWeekend)
            return { primary: 'epic', secondary: 'visuallystunning', timeOfDay: 'afternoon' };
        if (dayOfWeek === 1)
            return { primary: 'inspiring', secondary: 'educational', timeOfDay: 'afternoon' };
        return { primary: 'hiddengems', secondary: 'educational', timeOfDay: 'afternoon' };
    }
    if (hour >= 17 && hour < 21) {
        if (isFriday) return { primary: 'datenight', secondary: 'exciting', timeOfDay: 'evening' };
        if (dayOfWeek === 6)
            return { primary: 'brainfood', secondary: 'visuallystunning', timeOfDay: 'evening' };
        if (dayOfWeek === 0)
            return { primary: 'familynight', secondary: 'cozy', timeOfDay: 'evening' };
        return { primary: 'relaxing', secondary: 'comfortrewatch', timeOfDay: 'evening' };
    }
    if (hour >= 21 && hour < 24) {
        if (isFriday)
            return { primary: 'guiltypleasure', secondary: 'spooky', timeOfDay: 'late_evening' };
        if (dayOfWeek === 6)
            return { primary: 'darkgritty', secondary: 'hiddengems', timeOfDay: 'late_evening' };
        if (dayOfWeek === 0)
            return { primary: 'emotional', secondary: 'inspiring', timeOfDay: 'late_evening' };
        return { primary: 'quickwatch', secondary: 'comfortrewatch', timeOfDay: 'late_evening' };
    }
    if (isWeekend)
        return { primary: 'visuallystunning', secondary: 'hiddengems', timeOfDay: 'night' };
    return { primary: 'comfortrewatch', secondary: 'nostalgic', timeOfDay: 'night' };
}

function getDaySpecificTitle(mood: string, timeOfDay: string): string {
    const titleMap: Record<string, Record<string, () => string>> = {
        relaxing: {
            morning: m.mood_relaxing_morning,
            afternoon: m.mood_relaxing_afternoon,
            evening: m.mood_relaxing_evening,
            late_evening: m.mood_relaxing_late_evening,
            night: m.mood_relaxing_night,
        },
        exciting: {
            morning: m.mood_exciting_morning,
            afternoon: m.mood_exciting_afternoon,
            evening: m.mood_exciting_evening,
            late_evening: m.mood_exciting_late_evening,
            night: m.mood_exciting_night,
        },
        brainfood: {
            morning: m.mood_brainfood_morning,
            afternoon: m.mood_brainfood_afternoon,
            evening: m.mood_brainfood_evening,
            late_evening: m.mood_brainfood_late_evening,
            night: m.mood_brainfood_night,
        },
        thoughtful: {
            morning: m.mood_thoughtful_morning,
            afternoon: m.mood_thoughtful_afternoon,
            evening: m.mood_thoughtful_evening,
            late_evening: m.mood_thoughtful_late_evening,
            night: m.mood_thoughtful_night,
        },
        emotional: {
            morning: m.mood_emotional_morning,
            afternoon: m.mood_emotional_afternoon,
            evening: m.mood_emotional_evening,
            late_evening: m.mood_emotional_late_evening,
            night: m.mood_emotional_night,
        },
        funny: {
            morning: m.mood_funny_morning,
            afternoon: m.mood_funny_afternoon,
            evening: m.mood_funny_evening,
            late_evening: m.mood_funny_late_evening,
            night: m.mood_funny_night,
        },
        romantic: {
            morning: m.mood_romantic_morning,
            afternoon: m.mood_romantic_afternoon,
            evening: m.mood_romantic_evening,
            late_evening: m.mood_romantic_late_evening,
            night: m.mood_romantic_night,
        },
        spooky: {
            morning: m.mood_spooky_morning,
            afternoon: m.mood_spooky_afternoon,
            evening: m.mood_spooky_evening,
            late_evening: m.mood_spooky_late_evening,
            night: m.mood_spooky_night,
        },
        quickwatch: {
            morning: m.mood_quickwatch_morning,
            afternoon: m.mood_quickwatch_afternoon,
            evening: m.mood_quickwatch_evening,
            late_evening: m.mood_quickwatch_late_evening,
            night: m.mood_quickwatch_night,
        },
        hiddengems: {
            morning: m.mood_hiddengems_morning,
            afternoon: m.mood_hiddengems_afternoon,
            evening: m.mood_hiddengems_evening,
            late_evening: m.mood_hiddengems_late_evening,
            night: m.mood_hiddengems_night,
        },
        cozy: {
            morning: m.mood_cozy_morning,
            afternoon: m.mood_cozy_afternoon,
            evening: m.mood_cozy_evening,
            late_evening: m.mood_cozy_late_evening,
            night: m.mood_cozy_night,
        },
        epic: {
            morning: m.mood_epic_morning,
            afternoon: m.mood_epic_afternoon,
            evening: m.mood_epic_evening,
            late_evening: m.mood_epic_late_evening,
            night: m.mood_epic_night,
        },
        nostalgic: {
            morning: m.mood_nostalgic_morning,
            afternoon: m.mood_nostalgic_afternoon,
            evening: m.mood_nostalgic_evening,
            late_evening: m.mood_nostalgic_late_evening,
            night: m.mood_nostalgic_night,
        },
        inspiring: {
            morning: m.mood_inspiring_morning,
            afternoon: m.mood_inspiring_afternoon,
            evening: m.mood_inspiring_evening,
            late_evening: m.mood_inspiring_late_evening,
            night: m.mood_inspiring_night,
        },
        darkgritty: {
            morning: m.mood_darkgritty_morning,
            afternoon: m.mood_darkgritty_afternoon,
            evening: m.mood_darkgritty_evening,
            late_evening: m.mood_darkgritty_late_evening,
            night: m.mood_darkgritty_night,
        },
        familynight: {
            morning: m.mood_familynight_morning,
            afternoon: m.mood_familynight_afternoon,
            evening: m.mood_familynight_evening,
            late_evening: m.mood_familynight_late_evening,
            night: m.mood_familynight_night,
        },
        datenight: {
            morning: m.mood_datenight_morning,
            afternoon: m.mood_datenight_afternoon,
            evening: m.mood_datenight_evening,
            late_evening: m.mood_datenight_late_evening,
            night: m.mood_datenight_night,
        },
        educational: {
            morning: m.mood_educational_morning,
            afternoon: m.mood_educational_afternoon,
            evening: m.mood_educational_evening,
            late_evening: m.mood_educational_late_evening,
            night: m.mood_educational_night,
        },
        guiltypleasure: {
            morning: m.mood_guiltypleasure_morning,
            afternoon: m.mood_guiltypleasure_afternoon,
            evening: m.mood_guiltypleasure_evening,
            late_evening: m.mood_guiltypleasure_late_evening,
            night: m.mood_guiltypleasure_night,
        },
        visuallystunning: {
            morning: m.mood_visuallystunning_morning,
            afternoon: m.mood_visuallystunning_afternoon,
            evening: m.mood_visuallystunning_evening,
            late_evening: m.mood_visuallystunning_late_evening,
            night: m.mood_visuallystunning_night,
        },
        comfortrewatch: {
            morning: m.mood_comfortrewatch_morning,
            afternoon: m.mood_comfortrewatch_afternoon,
            evening: m.mood_comfortrewatch_evening,
            late_evening: m.mood_comfortrewatch_late_evening,
            night: m.mood_comfortrewatch_night,
        },
        eveningchill: {
            morning: m.mood_eveningchill_morning,
            afternoon: m.mood_eveningchill_afternoon,
            evening: m.mood_eveningchill_evening,
            late_evening: m.mood_eveningchill_late_evening,
            night: m.mood_eveningchill_night,
        },
    };

    const titleFn = titleMap[mood]?.[timeOfDay];
    return titleFn ? titleFn() : m.mood_recommendations_fallback();
}

// ---------------------------------------------------------------------------
// Transform mood item to UniversalMediaItem
// canonical: type uses 'series' not 'tv'; images{} href map not flat imageUrl
// ---------------------------------------------------------------------------

function transformMoodItem(item: MoodMediaRow): UniversalMediaItem | null {
    // The `mediaType` filter the mood queries take is OPTIONAL — an "all"
    // mood request (`narrowedMediaType` undefined) skips
    // `AND mi.media_type = ${mediaType}` entirely, so a genre/keyword-tagged
    // audiobook or track can legitimately reach this mapper. Drop it rather
    // than mislabel it as a movie.
    const canonicalType = toMovieOrSeries(item.media_type);
    if (!canonicalType) return null;

    // Internal type used for universal-id generation and image URL paths (keep 'tv' for compat).
    const internalType = isSeries(item.media_type) ? 'tv' : 'movie';

    const externalIds = createExternalIds({
        [getPrimaryExternalIdProvider()]: item.primary_ext_id,
        internal: item.internal_id ?? undefined,
    });

    const universalId = generateUniversalId(externalIds, internalType);

    if (!universalId) {
        throw new Error(
            `Cannot generate universal ID for item: ${item.title} (no external IDs available)`,
        );
    }

    // Prefer catalog URL with internal UUID, fall back to composite key
    const image = item.internal_id
        ? getCatalogPosterUrl(item.internal_id, { size: 'thumb' })
        : item.primary_ext_id
          ? `/api/image/${getPrimaryExternalIdProvider()}:${item.primary_ext_id}:${internalType}/poster?size=thumb`
          : '';

    return {
        id: universalId,
        externalIds,
        // Canonical public discriminator: 'series' not 'tv'.
        mediaType: canonicalType,
        title: item.title,
        image,
        overview: item.overview ?? undefined,
        rating: item.imdb_rating ?? undefined,
        letterboxdRating: item.letterboxd_rating ?? undefined,
        mdblistScore: item.mdblist_score ?? undefined,
        isAvailable: item.is_available || false,
        canRequest: item.can_request || false,
        trailerUrl: item.trailer_url ?? undefined,
    };
}

function buildMoodSection(
    results: MoodMediaRow[],
    title: string,
    timeOfDay: string,
    moodProfile: { name: string; description: string },
): PageSection[] {
    if (results.length === 0) return [];

    const items = results
        .map(transformMoodItem)
        .filter((item): item is UniversalMediaItem => item !== null);
    // A row dropped by transformMoodItem (non-movie/series) can empty out an
    // otherwise-nonempty `results` — don't emit a title with nothing under it.
    if (items.length === 0) return [];

    const icon = timeOfDay === 'morning' || timeOfDay === 'afternoon' ? 'sun' : 'moon';

    return [
        {
            id: 'mood-recommendations',
            type: 'carousel',
            title,
            items,
            meta: {
                icon,
                iconColor: 'text-indigo-400',
                subtitle: moodProfile.description,
                accentColor: 'indigo',
            },
        },
    ];
}

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        query: MoodRecommendationsQuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            if (event.request.method === 'GET' && event.url.searchParams.has('refresh'))
                return ApiProblem.validationFailed('Use the POST refresh action');
            const { locals } = event;

            // Age-restricted profiles cannot access mood recommendations
            if (locals.user?.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'This feature is not available for age-restricted profiles',
                );
            }

            try {
                const query = ctx.input!.query;
                const mood = query.mood;
                const mediaType = query.type;
                const limit = query.limit;
                const includeTrending = query.trending;
                const mode = query.mode;
                const moodWeight = query.moodWeight;
                const userWeight = query.userWeight;
                const userId = locals.user.userId;
                const refresh = event.request.method === 'POST';

                const timeBased = getTimeBasedMood();

                if (mood && !isMoodKey(mood)) {
                    return ApiProblem.validationFailed([
                        {
                            field: 'query.mood',
                            message: `Unknown mood '${mood}'. Custom moods are only supported in vector mode.`,
                        },
                    ]);
                }

                const selectedMood: MoodKey = mood && isMoodKey(mood) ? mood : timeBased.primary;

                const CACHE_FETCH_SIZE = 20;

                const sql = await aiDbService.getSql();

                // Bail BEFORE building the access context, not after. Previously
                // `accessCtx` was nullable (populated only when `sql` was truthy)
                // and every downstream use spelled `accessCtx?.x ?? null`, which
                // degraded to a fully permissive boundary — the exact fail-open
                // this migration exists to remove. It also meant the cache key
                // fell back to an UNSCOPED string, so a null-context request
                // could read an entry belonging to any other access scope.
                //
                // Hoisting this guard is behaviour-preserving: both cache writes
                // below already sit after it, so the unscoped key was only ever
                // *read*, never written — a branch that could not hit.
                if (!sql) {
                    return ApiProblem.dependencyUnavailable('AI database unavailable');
                }

                const accessCtx = await buildSearchAccessContext(sql, locals.user);
                // One boundary value for every query in this handler.
                const access = searchAccessBoundary(accessCtx);

                const damper = userId
                    ? await getTasteDamperService(sql).getDamperContext(userId)
                    : null;
                const damperTag = damper?.hash ?? 'nd';

                // Computed once per request (this route only ever builds ONE mood
                // section) — feeds both the cache key and the keyword-mode queries.
                const { kids: suppressKidsContent, anime: suppressAnimeContent } =
                    await shouldSuppressContent(sql, {
                        userId,
                        isAgeRestricted: locals.user.isAgeRestricted,
                        moodKey: selectedMood,
                    });
                const suppressTag = `supK${suppressKidsContent ? 1 : 0}A${suppressAnimeContent ? 1 : 0}`;

                const cacheKey = scopedCacheKey(
                    `${userId || 'anon'}:${selectedMood}:${timeBased.timeOfDay}:${mediaType || 'all'}:v8:${damperTag}:${suppressTag}`,
                    accessCtx,
                );

                // Check cache first (skip if refresh requested)
                if (!refresh) {
                    const cached = await moodCache.get<{
                        sections: PageSection[];
                        mood: string;
                        timeOfDay: string;
                        personalized: boolean;
                    }>(cacheKey);
                    if (cached) {
                        const limitedSections = cached.sections.map((section) => {
                            let items = section.items;
                            if (!accessCtx.showUnavailableMedia) {
                                items = items.filter((item) => item.isAvailable);
                            }
                            return { ...section, items: items.slice(0, limit) };
                        });
                        return json(
                            MoodRecommendationsResponseSchema.parse({
                                ...cached,
                                sections: limitedSections,
                                cached: true,
                            }),
                        );
                    }
                }

                const profile = MOOD_PROFILES[selectedMood];

                if (!profile) {
                    return ApiProblem.validationFailed([
                        { field: 'query.mood', message: 'Invalid mood parameter' },
                    ]);
                }

                const title = getDaySpecificTitle(selectedMood, timeBased.timeOfDay);

                // =================================================================
                // VECTOR MODE
                // =================================================================
                if (mode === 'vector') {
                    const vectorCacheKey = scopedCacheKey(
                        `${userId || 'anon'}:${selectedMood}:${mediaType || 'all'}:w${moodWeight}:u${userWeight}:v3:${damperTag}`,
                        accessCtx,
                    );

                    if (!refresh) {
                        const vectorCached = await vectorMoodCache.get<{
                            sections: PageSection[];
                            mood: string;
                            timeOfDay: string;
                            personalized: boolean;
                            mode: string;
                        }>(vectorCacheKey);
                        if (vectorCached) {
                            const limitedSections = vectorCached.sections.map((section) => {
                                let items = section.items;
                                if (!accessCtx.showUnavailableMedia) {
                                    items = items.filter((item) => item.isAvailable);
                                }
                                return { ...section, items: items.slice(0, limit) };
                            });
                            return json(
                                MoodRecommendationsResponseSchema.parse({
                                    ...vectorCached,
                                    sections: limitedSections,
                                    cached: true,
                                }),
                            );
                        }
                    }

                    const moodVectorService = getMoodVectorService(sql);
                    const moodVectorData = await moodVectorService.getMoodVector(
                        selectedMood,
                        true,
                    );

                    if (moodVectorData) {
                        const vectorResults = await moodVectorService.queryWithMoodVector(
                            selectedMood,
                            userId,
                            {
                                limit: CACHE_FETCH_SIZE,
                                moodWeight,
                                userWeight,
                                excludeWatched: true,
                                mediaType:
                                    isMovie(mediaType) || isSeries(mediaType) ? mediaType : null,
                                access,
                                damper,
                            },
                        );

                        if (vectorResults.length > 0) {
                            const transformedResults: MoodMediaRow[] = vectorResults.map((r) => ({
                                internal_id: r.mediaId,
                                primary_ext_id: r.primaryExtId,
                                title: r.title,
                                media_type: r.mediaType,
                                overview: r.overview ?? null,
                                imdb_rating: r.imdbRating ?? null,
                                rt_rating: null,
                                rt_audience_score: null,
                                letterboxd_rating: null,
                                mdblist_score: r.mdblistScore ?? null,
                                release_date: null,
                                popularity: null,
                                runtime_minutes: null,
                                is_available: r.isAvailable,
                                can_request: r.canRequest,
                                trailer_url: r.trailerUrl ?? null,
                                genres: null,
                                mdblist_keywords: null,
                                ai_similarity: r.similarity,
                            }));

                            const filteredVectorResults = !accessCtx.showUnavailableMedia
                                ? transformedResults.filter((item) => item.is_available)
                                : transformedResults;

                            const vectorSections = buildMoodSection(
                                filteredVectorResults,
                                title,
                                timeBased.timeOfDay,
                                getMoodProfileTranslated(selectedMood),
                            );

                            const vectorCacheData = {
                                sections: vectorSections,
                                mood: selectedMood,
                                timeOfDay: timeBased.timeOfDay,
                                personalized: !!userId,
                                mode: 'vector',
                            };

                            await vectorMoodCache.set(vectorCacheKey, vectorCacheData);

                            logger.info('Vector mood recommendations served', {
                                mood: selectedMood,
                                count: transformedResults.length,
                                personalized: !!userId,
                            });

                            const limitedVectorSections = vectorSections.map((section) => ({
                                ...section,
                                items: section.items.slice(0, limit),
                            }));

                            return json(
                                MoodRecommendationsResponseSchema.parse({
                                    ...vectorCacheData,
                                    sections: limitedVectorSections,
                                }),
                            );
                        }

                        logger.info(
                            'Vector mode returned no results, falling back to keyword mode',
                            {
                                mood: selectedMood,
                            },
                        );
                    } else {
                        logger.info('Mood vector not available, falling back to keyword mode', {
                            mood: selectedMood,
                        });
                    }
                    // Continue to keyword mode as fallback...
                }

                // =================================================================
                // KEYWORD MODE (default)
                // =================================================================

                let userHasProfile = false;
                if (userId) {
                    try {
                        const [userProfile] = await sql<{ catalog_embedding: unknown }[]>`
                        SELECT catalog_embedding
                        FROM user_profiles
                        WHERE user_id = ${userId}
                        AND catalog_embedding IS NOT NULL
                    `;
                        if (userProfile?.catalog_embedding) {
                            userHasProfile = true;
                        }
                    } catch {
                        logger.debug('No user profile found for personalization', { userId });
                    }
                }

                let results: MoodMediaRow[] = [];

                const moodQueryProfile = {
                    keywords: profile.keywords,
                    genres: profile.genres,
                    excludeGenres: profile.excludeGenres,
                    excludeKeywords: profile.excludeKeywords,
                    minRuntime: profile.minRuntime,
                    maxRuntime: profile.maxRuntime,
                    minRating: profile.minRating,
                    maxRating: profile.maxRating,
                    maxPopularity: profile.maxPopularity,
                    minPopularity: profile.minPopularity,
                    minYear: profile.minYear,
                    maxYear: profile.maxYear,
                };

                const narrowedMediaType: 'movie' | 'tv' | undefined =
                    isMovie(mediaType) || isSeries(mediaType)
                        ? isMovie(mediaType)
                            ? 'movie'
                            : 'tv'
                        : undefined;

                if (userHasProfile && userId) {
                    results = await findMoodMediaPersonalized(sql, {
                        profile: moodQueryProfile,
                        mediaType: narrowedMediaType,
                        userId,
                        limit: CACHE_FETCH_SIZE,
                        access,
                        damper,
                        suppressKidsContent,
                        suppressAnimeContent,
                    });
                } else {
                    results = await findMoodMedia(sql, {
                        profile: moodQueryProfile,
                        mediaType: narrowedMediaType,
                        userId,
                        limit: CACHE_FETCH_SIZE,
                        access,
                        suppressKidsContent,
                        suppressAnimeContent,
                    });
                }

                let trendingItems: MoodMediaRow[] = [];
                if (includeTrending && results.length < CACHE_FETCH_SIZE) {
                    const excludeList = results.map((r) => ({
                        primary_ext_id: r.primary_ext_id,
                        media_type: r.media_type,
                    }));
                    trendingItems = await findTrendingMoodMedia(sql, {
                        mediaType: narrowedMediaType,
                        limit: Math.min(4, CACHE_FETCH_SIZE - results.length),
                        excludeList: excludeList.length > 0 ? excludeList : undefined,
                        access,
                    });
                }

                let combinedResults = [...results, ...trendingItems];
                if (!accessCtx.showUnavailableMedia) {
                    combinedResults = combinedResults.filter((item) => item.is_available);
                }

                logger.info('Mood recommendations fetched', {
                    mood: selectedMood,
                    timeOfDay: timeBased.timeOfDay,
                    count: combinedResults.length,
                    trendingAdded: trendingItems.length,
                    personalized: userHasProfile,
                    userId: userId || 'anonymous',
                });

                const allSections = buildMoodSection(
                    combinedResults,
                    title,
                    timeBased.timeOfDay,
                    getMoodProfileTranslated(selectedMood),
                );

                const cacheData = {
                    sections: allSections,
                    mood: selectedMood,
                    timeOfDay: timeBased.timeOfDay,
                    personalized: userHasProfile,
                };

                await moodCache.set(cacheKey, cacheData);

                const limitedSections = allSections.map((section) => ({
                    ...section,
                    items: section.items.slice(0, limit),
                }));

                return json(
                    MoodRecommendationsResponseSchema.parse({
                        ...cacheData,
                        sections: limitedSections,
                    }),
                );
            } catch (error) {
                logger.error('Failed to fetch mood recommendations', error as Error);
                return ApiProblem.internalError('Failed to fetch mood recommendations');
            }
        },
    },
});

export const refreshDef = defineEndpoint({
    auth: def.auth,
    rateLimit: refreshRateLimit,
    visibility: 'internal',
    request: {
        body: MoodRecommendationsQuerySchema.loose().superRefine((body, ctx) => {
            for (const field of ['refresh', 'offset', 'cursor']) {
                if (field in body)
                    ctx.addIssue({
                        code: 'custom',
                        path: [field],
                        message: 'Not accepted by this refresh action',
                    });
            }
        }),
    },
    handlers: {
        POST: (event, ctx) =>
            def.handlers.GET!(event, {
                ...ctx,
                input: { query: ctx.input!.body, body: undefined, params: undefined },
            }),
    },
});
