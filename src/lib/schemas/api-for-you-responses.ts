// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { MediaPreviewSchema } from './api-media-preview.js';
import { boundedListEnvelope } from './pagination.js';

/**
 * For-You API Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for for-you/personalized API response types.
 * These schemas define the contract for /api/for-you/*, /api/continue-watching/*,
 * /api/mood-recommendations/*, /api/recommendations/* endpoints.
 *
 * Usage:
 * - Server: Validate responses before sending
 * - Client: Runtime type validation
 * - OpenAPI: Auto-generate documentation
 * - TypeScript: Infer types for type safety
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

import { z } from 'zod';
import { PlaybackProgressSchema } from './playback-progress.js';
import { publicMediaTypeSchema, publicMovieSeriesSchema } from './common';
import { BadgeSchema, ExternalIdsResponseSchema, PageSectionSchema } from './api-responses';
import { DismissalTargetTypeSchema } from './api-dismissals-responses';
import { FEED_SECTION_KINDS } from '../shared/feed-section-kinds';
import { PageBlockSchema, paginatedEnvelope } from './pagination';

// ---------------------------------------------------------------------------
// Canonical RecommendationItem shape (mirrors the server-side def)
// ---------------------------------------------------------------------------

/**
 * Self-describing image href map.  Keys are roles (poster | backdrop | logo |
 * thumb | banner | still); values carry a size-template href.
 */
export const RecommendedMediaImagesSchema = z.record(
    z.string(),
    z.object({
        href: z.string(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
    }),
);

export type RecommendedMediaImages = z.infer<typeof RecommendedMediaImagesSchema>;

/**
 * Canonical media preview embedded in every recommendation.
 *
 * `type` is the canonical PUBLIC discriminator ({@link publicMediaTypeSchema}),
 * never the stored `'tv'`/`'show'` token. It was declared as a bare `z.string()`
 * with a prose description claiming `'movie' | 'series' | 'episode'` — so the
 * published spec gave generated clients an open `String`, and a tvOS client with
 * no audiobook UI silently accepted the `'audiobook'` items that appear on
 * Continue Watching once an AudiobookShelf library is configured (rendering a
 * book as a movie poster into the movie playback path). Reusing the shared enum
 * publishes the real domain as `#/components/schemas/PublicMediaType`, so a
 * strict decoder fails loudly on a type it does not know instead of guessing —
 * and stays correct when a new media type lands, because there is exactly one
 * place the domain is declared.
 */
// Legacy internal rails and /watchlist retain this private compatibility shape
// until their assigned client/producer migration. v1 discovery uses MediaPreviewSchema.
export const RecommendedMediaRefSchema = z.object({
    id: z.string().describe('Opaque resolvable media handle'),
    type: publicMediaTypeSchema,
    title: z.string(),
    year: z.number().int().nullable().optional(),
    // `internal` (the catalogue UUID) is the identifier clients resolve, play
    // and track watched-state with — it mirrors `id` and is always present.
    // Jellyfin item ids are sync-only and never part of this map.
    ids: z
        .record(z.string(), z.string())
        .describe(
            'Provider ID map. Always carries `internal` (the catalogue UUID) — resolve ' +
                'playback and watched-state with it.',
        ),
    images: RecommendedMediaImagesSchema.optional().describe('Self-describing image hrefs'),
    // Episode context (present only when `type` === 'episode'). Without these
    // the client can't resolve the parent series and renders a bare episode as
    // a one-off movie. MUST be listed here: response validation runs `.parse()`
    // which strips any key not on the schema (same reason as isAvailable below).
    // Mirrors the search endpoint's flat episode fields and `?include=details`.
    seriesId: z.string().optional().describe('Internal UUID of the owning series (episodes only)'),
    seriesName: z.string().optional().describe('Parent series name (episodes only)'),
    seasonNumber: z.number().int().optional().describe('Season number (episodes only)'),
    episodeNumber: z.number().int().optional().describe('Episode number (episodes only)'),
    // Rail/hero display metadata, hydrated via getMediaRailMetadataBatch. This
    // schema is defined TWICE — here and in
    // src/lib/server/api/defs/recommendations/recommender.ts (Zod schema +
    // TS interface) — and BOTH must stay in sync.
    overview: z.string().optional().describe('Synopsis/overview text'),
    seasonCount: z.number().int().nonnegative().optional().describe('Known season count'),
    episodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Known total episodes, including provider metadata'),
    availableEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Active playable episodes in permitted libraries'),
    watchedEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Watched playable episodes for the current user'),
    unwatchedEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Unwatched playable episodes for the current user'),

    rating: z.number().optional().describe('IMDb rating, 0-10'),
    criticRating: z.number().optional().describe('Rotten Tomatoes critic score, 0-100'),
    durationMs: z.number().int().optional().describe('Duration in milliseconds'),
    genres: z.array(z.string()).optional().describe('Genre names'),
    certification: z.string().optional().describe('Age/content rating, e.g. "PG-13"'),
    resolutionTier: z.string().optional().describe("Quality tier: '4K' | '1080p' | '720p' | 'SD'"),
    hdrTier: z.string().optional().describe("HDR tier: 'dolby_vision' | 'hdr' | 'sdr'"),
    hasAtmos: z.boolean().optional().describe('Dolby Atmos audio available'),
    hasCc: z.boolean().optional().describe('Closed captions available'),
    hasSdh: z.boolean().optional().describe('SDH subtitles available'),
    hasAd: z.boolean().optional().describe('Audio description track available'),
});

export type RecommendedMediaRef = z.infer<typeof RecommendedMediaRefSchema>;

/**
 * Reason block on a recommendation item.
 */
export const RecommendationReasonSchema = z.object({
    kind: z.string(),
    seed: z.string().optional(),
    label: z.string().optional(),
    airDate: z.string().optional().describe('ISO air-date string (for `upcoming`)'),
    episodeTitle: z.string().optional().describe('Episode title (for `upcoming`)'),
    overview: z.string().optional().describe('Episode overview/description (for `upcoming`)'),
});

/**
 * One item in a for-you recommendation response.
 * This is the CANONICAL shape for every Tier-2 for-you rail.
 *
 * NOTE: named `ForYouRecommendationItem` to avoid collision with the legacy
 * `RecommendationItem` in `api-media-responses.ts` (that schema has a
 * completely different shape based on MediaRatings).
 */
export const ForYouRecommendationItemSchema = z.object({
    media: RecommendedMediaRefSchema,
    score: z.number().min(0).max(1).optional().describe('Normalised relevance score [0, 1]'),
    progress: PlaybackProgressSchema.optional().describe('Caller playback progress when known'),
    reason: RecommendationReasonSchema.optional(),
    // Availability MUST be carried through: without these, `.parse()` strips the
    // server's values and the client defaults every item to watchable — a
    // request-only (discovery, has_files=false) title then shows a "Watch"
    // button and a /watch/<uuid> link that 404s.
    isAvailable: z
        .boolean()
        .optional()
        .describe('Item is available to watch now (present in the library).'),
    canRequest: z
        .boolean()
        .optional()
        .describe('Item is not available and is eligible to be requested.'),
    // Plugin-contributed badges, merged server-side in `runRecommender`. Lives
    // at the ITEM level for the same reason isAvailable does: the response
    // conformance strip drops any key not on the schema, so a field declared
    // in the wrong place is silently deleted in production.
    //
    // `.optional()`, never `.nullable()` — strict Swift decoders treat a
    // required field as a one-way door, and an additive optional is the only
    // shape that is safe for already-shipped mobile and TV clients.
    badges: z
        .array(BadgeSchema)
        .optional()
        .describe('Badges contributed by plugins (quality flags, ratings, status).'),
});

export type ForYouRecommendationItem = z.infer<typeof ForYouRecommendationItemSchema>;

/**
 * Canonical page block returned alongside every paginated collection.
 *
 * Re-exported from `./pagination` (the single source of truth — see M6 in
 * the contract-cleanup backlog) so existing `import { PageBlockSchema } from
 * './api-for-you-responses'` call sites keep working unchanged.
 */
export { PageBlockSchema };
export type { PageBlock } from './pagination';

/**
 * Standard paginated response envelope: { items, page }.
 * Used by all Tier-2 for-you section endpoints.
 */
export const PagedRecommendationResponseSchema = paginatedEnvelope(ForYouRecommendationItemSchema);

export type PagedRecommendationResponse = z.infer<typeof PagedRecommendationResponseSchema>;

/**
 * Taste rail response (`GET /api/for-you/taste`) — the strategy-backed
 * "From your ratings" rail. Distinct from `PagedRecommendationResponseSchema`
 * (which uses the offset/hasMore `{ items, page }` envelope): the taste rail
 * is cursor-only and carries an explicit `status` so the client can tell a
 * genuinely-empty page apart from one still being generated or one that ran
 * past the end of the result set (mirrors `RecommenderResult.status` on the
 * server's `runRecommender` — see recommender.ts).
 */
export const TasteRailResponseSchema = z
    .object({
        status: z.enum(['ready', 'generating', 'exhausted']),
        items: z.array(ForYouRecommendationItemSchema),
        page: PageBlockSchema,
        /**
         * Whether the taste profile currently folds watch-history signals into
         * its positive centroid (toggle, `PATCH
         * /api/for-you/taste`). Additive field on the existing GET response —
         * defaults to `true` server-side when the user has never set it.
         */
        includeWatchHistory: z.boolean().optional(),
    })
    .meta({
        id: 'TasteRailResponse',
        description: 'Taste rail (strategy-backed AI recommendations) response',
    });

export type TasteRailResponse = z.infer<typeof TasteRailResponseSchema>;

/**
 * `PATCH /api/for-you/taste` request body — toggles whether the taste
 * profile folds watch-history signals into its positive centroid. The
 * response reuses `OkAckResponseSchema` (defined further below) — a bare
 * `{ ok: true }` acknowledgement, same as the dismiss/feedback beacons.
 */
export const TasteIncludeWatchHistoryPatchBodySchema = z.object({
    includeWatchHistory: z.boolean(),
});

export type TasteIncludeWatchHistoryPatchBody = z.infer<
    typeof TasteIncludeWatchHistoryPatchBodySchema
>;

// ============================================================================
// Watching / Continue Watching Responses (/api/for-you/watching)
// ============================================================================

/**
 * Continue watching item (canonical images{} shape from watching.ts def)
 */
export const ContinueWatchingItemSchema = z
    .object({
        id: z.string(),
        type: z.string(),
        title: z.string(),
        images: z
            .object({
                poster: z.object({ href: z.string() }).optional(),
                thumb: z.object({ href: z.string() }).optional(),
                backdrop: z.object({ href: z.string() }).optional(),
            })
            .optional(),
        ids: z.record(z.string(), z.string()),
        progress: PlaybackProgressSchema.optional().describe('Caller playback progress when known'),
        episode: z
            .object({
                seasonNumber: z.number().int().optional(),
                episodeNumber: z.number().int().optional(),
                title: z.string().optional(),
            })
            .optional(),
    })
    .meta({ id: 'ContinueWatchingItem', description: 'Continue watching item' });

export type ContinueWatchingItem = z.infer<typeof ContinueWatchingItemSchema>;

/**
 * Watching response
 * Server returns full PageSection objects via buildWatchingSections()
 */
export const WatchingResponseSchema = z
    .object({
        /** Watching sections (Continue Watching, Next Up, etc.) */
        sections: z.array(PageSectionSchema).describe('Watching sections'),
    })
    .meta({ id: 'WatchingResponse', description: 'Watching response' });

export type WatchingResponse = z.infer<typeof WatchingResponseSchema>;

/**
 * A single "Because you watched" seed source.
 * New contract: canonical type ('movie'|'series'), images{} hrefs, ids{} map.
 */
export const WatchingSourceSchema = z
    .object({
        /** Internal UUID (null when only Sonarr/TMDB data is available). */
        id: z.string().nullable(),
        title: z.string().describe('Title'),
        /** Canonical type: 'movie' | 'series'. */
        type: z.enum(['movie', 'series']).describe('Canonical media type'),
        /** Self-describing image hrefs. */
        images: z
            .object({
                poster: z.object({ href: z.string() }),
                thumb: z.object({ href: z.string() }),
            })
            .optional()
            .describe('Self-describing image hrefs'),
        /** Provider ID map (provider → id string). */
        ids: z.record(z.string(), z.string()).describe('Provider ID map'),
        lastWatched: z.string().optional().describe('Last watched ISO timestamp'),
        /**
         * Why this seed was selected. 'watched' = the user actually watched
         * this title. 'popular' = a fallback substitute (a popular library
         * title the user did NOT watch), used only when no genuine watched
         * seed of the needed media type is available. Absent is treated as
         * 'watched' for backward compatibility.
         */
        reason: z.enum(['watched', 'popular']).optional().describe('Seed selection reason'),
    })
    .meta({ id: 'WatchingSource', description: 'Because-you-watched seed source' });

export type WatchingSource = z.infer<typeof WatchingSourceSchema>;

/**
 * Watching sources response
 * New contract: { sources: WatchingSource[], secondBecauseSource: WatchingSource | null }
 */
export const WatchingSourcesResponseSchema = z
    .object({
        /** Source items (shows/movies used for "Because you watched") */
        sources: z.array(WatchingSourceSchema).describe('Sources'),
        /** Second because-you-watched source */
        secondBecauseSource: WatchingSourceSchema.nullable().describe(
            'Second because-you-watched source',
        ),
    })
    .meta({
        id: 'WatchingSourcesResponse',
        description: 'Watching sources response',
    });

export type WatchingSourcesResponse = z.infer<typeof WatchingSourcesResponseSchema>;

// ============================================================================
// New Episodes Response (/api/for-you/new-episodes)
// ============================================================================

/**
 * One "New episodes available" card: the first new episode of a followed
 * series (an episode MediaPreview, `reason.kind` = `new_release`) plus the
 * series-level counts. The rule is documented in
 * `src/lib/server/services/new-release-rule.ts` and docs/api/API.md.
 */
export const NewEpisodeAlertSchema = MediaPreviewSchema.extend({
    newEpisodes: z
        .object({
            count: z
                .number()
                .int()
                .min(1)
                .describe('New episodes of this series, including the one shown'),
            watchedEpisodeCount: z
                .number()
                .int()
                .min(0)
                .describe('Episodes of this series the user has watched'),
            followReason: z
                .enum(['watched', 'followed', 'watchlist'])
                .describe(
                    'Why the series counts as followed: enough episodes watched, the series episode notifications are on, or it is on the watchlist and started',
                ),
        })
        .meta({ id: 'NewEpisodesSummary' }),
}).meta({ id: 'NewEpisodeAlert' });

export type NewEpisodeAlert = z.infer<typeof NewEpisodeAlertSchema>;

/**
 * New episodes response — bounded episode previews
 * Contract: { items: MediaPreview[], truncated: boolean }
 */
export const NewEpisodesResponseSchema = boundedListEnvelope(NewEpisodeAlertSchema).meta({
    id: 'NewEpisodesResponse',
    description: 'Bounded new episode previews',
});

export type NewEpisodesResponse = z.infer<typeof NewEpisodesResponseSchema>;

// ============================================================================
// Clear Continue Watching Response (/api/continue-watching/clear)
// ============================================================================

/**
 * Clear continue watching response
 */
export const ClearContinueWatchingResponseSchema = z
    .object({
        /** Items cleared count */
        cleared: z.number().describe('Items cleared count'),
        /** Message */
        message: z.string().optional().describe('Message'),
        /** Total items attempted */
        total: z.number().int().optional().describe('Total items attempted'),
        /** Error messages for partial failures */
        errors: z.array(z.string()).optional().describe('Error messages for partial failures'),
    })
    .meta({
        id: 'ClearContinueWatchingResponse',
        description: 'Clear continue watching response',
    });

export type ClearContinueWatchingResponse = z.infer<typeof ClearContinueWatchingResponseSchema>;

// ============================================================================
// Section Responses (/api/for-you/*)
// ============================================================================

/**
 * Generic paginated section response (trending, popular-shows, short-movies, etc.)
 *
 * New contract: paginate(RecommendationItem[], page) → { items, page }
 */
export const SectionResponseSchema = PagedRecommendationResponseSchema.meta({
    id: 'SectionResponse',
    description: 'Paginated recommendation section response',
});

export type SectionResponse = z.infer<typeof SectionResponseSchema>;

/**
 * Fulfilled requests response — same paginated envelope as other section endpoints.
 */
export const FulfilledRequestsResponseSchema = PagedRecommendationResponseSchema.meta({
    id: 'FulfilledRequestsResponse',
    description: 'Fulfilled requests paginated response',
});

export type FulfilledRequestsResponse = z.infer<typeof FulfilledRequestsResponseSchema>;

// ============================================================================
// Featured Pick Response (/api/for-you/featured-pick)
// ============================================================================

/**
 * Featured pick item — canonical media preview with images{} hrefs.
 * Returned by the new contract (candidateToPickItem() in the server def).
 */
export const FeaturedPickItemSchema = z
    .object({
        id: z.string().describe('Internal UUID (canonical)'),
        type: z.string().describe("'movie' | 'series'"),
        title: z.string(),
        seasonCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('seasonCount in the current catalog/user scope'),
        episodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('episodeCount in the current catalog/user scope'),
        availableEpisodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('availableEpisodeCount in the current catalog/user scope'),
        watchedEpisodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('watchedEpisodeCount in the current catalog/user scope'),
        unwatchedEpisodeCount: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('unwatchedEpisodeCount in the current catalog/user scope'),

        year: z.number().int().optional(),
        overview: z.string().optional(),
        rating: z.number().optional(),
        images: RecommendedMediaImagesSchema.describe('Self-describing image hrefs'),
        ids: z.record(z.string(), z.string()).describe('Provider ID map'),
        isAvailable: z
            .boolean()
            .optional()
            .describe('Item is in the library (has_files). Gates the Watch button.'),
        canRequest: z
            .boolean()
            .optional()
            .describe('Item is not available and is eligible to be requested.'),
    })
    .meta({ id: 'FeaturedPickItem', description: 'Featured pick item' });

export type FeaturedPickItem = z.infer<typeof FeaturedPickItemSchema>;

/**
 * Featured pick response — bare object { pick, criteria }.
 * New contract: no success wrapper, no PageSection envelope.
 *   pick: FeaturedPickItem | null
 *   criteria: string | null
 */
export const FeaturedPickResponseSchema = z
    .object({
        pick: FeaturedPickItemSchema.nullable().describe(
            'Featured pick item, or null when none available',
        ),
        criteria: z.string().nullable().describe('Criteria used to select this pick'),
    })
    .meta({
        id: 'FeaturedPickResponse',
        description: 'Featured pick response',
    });

export type FeaturedPickResponse = z.infer<typeof FeaturedPickResponseSchema>;

// ============================================================================
// Music Section Response (music-because / music-quick-picks)
// These endpoints still use the { section } envelope (not paginate()).
// ============================================================================

/**
 * Response shape for music-because and music-quick-picks.
 * Server builds a PageSection inline and returns { section } or { section: null }.
 */
export const MusicSectionResponseSchema = z
    .object({
        section: PageSectionSchema.nullable().describe(
            'Pre-built music section or null when unavailable',
        ),
    })
    .meta({ id: 'MusicSectionResponse', description: 'Music section response' });

export type MusicSectionResponse = z.infer<typeof MusicSectionResponseSchema>;

// ============================================================================
// Explore Keywords Response (/api/for-you/explore-keywords)
// ============================================================================

/**
 * Explore keyword
 */
export const ExploreKeywordSchema = z
    .object({
        /** Keyword text */
        keyword: z.string().describe('Keyword'),
        /** Display name */
        displayName: z.string().describe('Display name'),
        /** Item count */
        count: z.number().int().describe('Count'),
    })
    .meta({ id: 'ExploreKeyword', description: 'Explore keyword' });

export type ExploreKeyword = z.infer<typeof ExploreKeywordSchema>;

/**
 * Explore keywords response
 */
export const ExploreKeywordsResponseSchema = z
    .object({
        /** Explore section */
        section: PageSectionSchema.describe('Explore section'),
        /** Keywords */
        keywords: z.array(ExploreKeywordSchema).describe('Keywords'),
    })
    .meta({
        id: 'ExploreKeywordsResponse',
        description: 'Explore keywords response',
    });

export type ExploreKeywordsResponse = z.infer<typeof ExploreKeywordsResponseSchema>;

// ============================================================================
// AI Suggestions Response (/api/ai/suggestions - in for-you context)
// ============================================================================

// Re-export from api-ai-responses.ts to avoid duplication
// Import these from api-ai-responses.ts or from the schemas index

// ============================================================================
// Mood Recommendations Responses (/api/mood-recommendations/*)
// ============================================================================

/**
 * Mood option (matches server mood config shape)
 */
export const MoodOptionSchema = z
    .object({
        /** Mood key identifier */
        key: z.string().describe('Mood key'),
        /** Display name */
        displayName: z.string().describe('Display name'),
        /** Description */
        description: z.string().describe('Description'),
    })
    .meta({ id: 'MoodOption', description: 'Mood option' });

export type MoodOption = z.infer<typeof MoodOptionSchema>;

/**
 * Mood suggestions response
 */
export const MoodSuggestionsResponseSchema = z
    .object({
        /** Primary time-based mood suggestion */
        primary: z.string().nullable().describe('Primary mood'),
        /** Secondary time-based mood suggestion */
        secondary: z.string().nullable().describe('Secondary mood'),
        /** Available moods */
        moods: z.array(MoodOptionSchema).describe('Moods'),
    })
    .meta({
        id: 'MoodSuggestionsResponse',
        description: 'Mood suggestions response',
    });

export type MoodSuggestionsResponse = z.infer<typeof MoodSuggestionsResponseSchema>;

/**
 * Mood recommendations response
 */
export const MoodRecommendationsResponseSchema = z
    .object({
        /** Mood recommendation sections */
        sections: z.array(PageSectionSchema).describe('Mood recommendation sections'),
        /** Selected mood */
        mood: z.string().describe('Selected mood'),
        /** Time of day used for recommendations */
        timeOfDay: z.string().describe('Time of day used for recommendations'),
        /** Whether results are personalized */
        personalized: z.boolean().describe('Whether results are personalized'),
        /** Whether served from cache */
        cached: z.boolean().optional().describe('Whether served from cache'),
        /** Recommendation mode */
        mode: z.string().optional().describe('Recommendation mode'),
    })
    .meta({
        id: 'MoodRecommendationsResponse',
        description: 'Mood recommendations response',
    });

export type MoodRecommendationsResponse = z.infer<typeof MoodRecommendationsResponseSchema>;

// ============================================================================
// Similar Response (/api/for-you/similar)
// ============================================================================

/**
 * Similar items response.
 * New contract: { source, ...paginate(RecommendationItem[], page) }
 *   - source: seed item metadata (id, title, type, ids)
 *   - items: RecommendationItem[] (paginated)
 *   - page: PageBlock
 */
export const SimilarSourceSchema = z
    .object({
        id: z.string().nullable().describe('Internal UUID of the source item'),
        title: z.string().nullable().describe('Source item title'),
        type: z.string().describe("'movie' | 'series'"),
        ids: z.record(z.string(), z.string()).describe('Provider ID map'),
    })
    .meta({ id: 'SimilarSource', description: 'Seed source metadata for similar response' });

export type SimilarSource = z.infer<typeof SimilarSourceSchema>;

export const SimilarResponseSchema = z
    .object({
        source: SimilarSourceSchema.optional().describe('Seed source metadata'),
        items: z.array(ForYouRecommendationItemSchema).describe('Similar recommendation items'),
        page: PageBlockSchema,
    })
    .meta({ id: 'SimilarResponse', description: 'Similar items paginated response' });

export type SimilarResponse = z.infer<typeof SimilarResponseSchema>;

// ============================================================================
// Keywords Response (/api/for-you/keywords)
// ============================================================================

/**
 * A single canonical keyword section item (from keywords.ts def).
 * Items have images{} hrefs, canonical type, ids{} map.
 */
export const ForYouKeywordSectionItemSchema = z
    .object({
        id: z.string(),
        type: z.string().describe("'movie' | 'series'"),
        title: z.string(),
        year: z.number().int().optional(),
        ids: z.record(z.string(), z.string()),
        images: RecommendedMediaImagesSchema.optional(),
        isAvailable: z
            .boolean()
            .optional()
            .describe('Item is in the library (has_files). Gates the Watch button.'),
        canRequest: z
            .boolean()
            .optional()
            .describe('Item is not available and is eligible to be requested.'),
    })
    .meta({ id: 'KeywordSectionItem', description: 'Canonical item in a keyword section' });

export type ForYouKeywordSectionItem = z.infer<typeof ForYouKeywordSectionItemSchema>;

/**
 * A single keyword-based "You like X" carousel section.
 */
export const ForYouKeywordSectionSchema = z
    .object({
        id: z.string(),
        type: z.literal('carousel'),
        title: z.string(),
        keyword: z.string().optional(),
        items: z.array(ForYouKeywordSectionItemSchema),
    })
    .meta({ id: 'ForYouKeywordSection', description: 'A keyword-based recommendation section' });

export type ForYouKeywordSection = z.infer<typeof ForYouKeywordSectionSchema>;

/**
 * Keywords response — bare object { sections: KeywordSection[] }.
 * New contract: no success wrapper, items have canonical images{}/type.
 */
export const KeywordsResponseSchema = z
    .object({
        sections: z.array(ForYouKeywordSectionSchema).describe('Keyword recommendation sections'),
    })
    .meta({ id: 'KeywordsResponse', description: 'Keywords response' });

export type KeywordsResponse = z.infer<typeof KeywordsResponseSchema>;

// ============================================================================
// Dismiss Recommendation Response (/api/recommendations/dismiss)
// ============================================================================

/**
 * Dismiss recommendation response
 */
export const DismissRecommendationResponseSchema = z
    .object({
        /** Whether the item was dismissed */
        dismissed: z.boolean().describe('Dismissed'),
        /** Total dismiss count for this source */
        dismissCount: z.number().describe('Dismiss count'),
    })
    .meta({
        id: 'DismissRecommendationResponse',
        description: 'Dismiss recommendation response',
    });

export type DismissRecommendationResponse = z.infer<typeof DismissRecommendationResponseSchema>;

/**
 * Get dismiss state response (GET /api/recommendations/dismiss)
 */
export const GetDismissStateResponseSchema = z
    .object({
        /** The source media key queried */
        sourceMediaKey: z.string().describe('Source media key'),
        /** Total dismiss count for this source */
        dismissCount: z.number().describe('Dismiss count'),
        /** All dismissed media keys for this source */
        dismissedMediaKeys: z.array(z.string()).describe('Dismissed media keys'),
    })
    .meta({
        id: 'GetDismissStateResponse',
        description: 'Dismiss state response',
    });

export type GetDismissStateResponse = z.infer<typeof GetDismissStateResponseSchema>;

/**
 * Clear dismiss state response (DELETE /api/recommendations/dismiss)
 */
export const ClearDismissStateResponseSchema = z
    .object({
        /** Whether the state was cleared */
        cleared: z.boolean().describe('Whether state was cleared'),
        /** The source media key that was cleared */
        sourceMediaKey: z.string().describe('Source media key'),
    })
    .meta({
        id: 'ClearDismissStateResponse',
        description: 'Clear dismiss state response',
    });

export type ClearDismissStateResponse = z.infer<typeof ClearDismissStateResponseSchema>;

// ============================================================================
// Continue Watching Delete Response (/api/continue-watching/[itemId] DELETE)
// ============================================================================

/**
 * Continue watching item delete response
 * Server returns: { cleared, itemId }
 */
export const ContinueWatchingDeleteResponseSchema = z
    .object({
        /** Whether item was cleared */
        cleared: z.boolean().describe('Whether item was cleared'),
        /** Cleared item ID */
        itemId: z.string().describe('Cleared item ID'),
    })
    .meta({
        id: 'ContinueWatchingDeleteResponse',
        description: 'Continue watching item delete response',
    });

export type ContinueWatchingDeleteResponse = z.infer<typeof ContinueWatchingDeleteResponseSchema>;

// ============================================================================
// Upcoming Episodes Responses (/api/upcoming)
// ============================================================================

export const UpcomingEpisodeSchema = z
    .object({
        seriesName: z.string(),
        title: z.string(),
        seasonNumber: z.number().int().optional(),
        episodeNumber: z.number().int().optional(),
        sonarrAirDate: z.string().optional(),
        sonarrHasFile: z.boolean().optional(),
        overview: z.string().optional(),
        sonarrSeriesId: z.number().int().optional(),
    })
    .meta({ id: 'UpcomingEpisode', description: 'Upcoming episode item' });

export type UpcomingEpisodeItem = z.infer<typeof UpcomingEpisodeSchema>;

export const UpcomingEpisodesResponseSchema = z
    .object({
        upcomingEpisodes: z.array(UpcomingEpisodeSchema),
        totalCount: z.number().int(),
        watchedSeriesCount: z.number().int().optional(),
    })
    .meta({
        id: 'UpcomingEpisodesResponse',
        description: 'Upcoming episodes response',
    });

export type UpcomingEpisodesResponse = z.infer<typeof UpcomingEpisodesResponseSchema>;

// ============================================================================
// "Show less like this" — taste dampers (/api/for-you/less-like-this)
// ============================================================================

/**
 * Result of recording a "show less like this" damper.
 * New contract: { ok: true } (not { success: boolean }).
 */
export const LessLikeThisResponseSchema = z
    .object({
        ok: z.literal(true),
    })
    .meta({ id: 'LessLikeThisResponse', description: 'Show-less-like-this damper write result' });

export type LessLikeThisResponse = z.infer<typeof LessLikeThisResponseSchema>;

/** One active "show less like this" damper, for the settings management UI. */
export const TasteDamperItemSchema = z
    .object({
        mediaId: z.string().describe('Internal media_items UUID'),
        mediaType: publicMovieSeriesSchema,
        title: z.string(),
        createdAt: z.string().describe('ISO timestamp when the damper was set'),
        expiresAt: z.string().describe('ISO timestamp when the damper auto-expires'),
    })
    .meta({ id: 'TasteDamperItem', description: 'A single active show-less-like-this damper' });

export type TasteDamperItem = z.infer<typeof TasteDamperItemSchema>;

/** List of the user's active dampers. */
export const ActiveDampersResponseSchema = z
    .object({
        dampers: z.array(TasteDamperItemSchema),
    })
    .meta({ id: 'ActiveDampersResponse', description: 'Active show-less-like-this dampers' });

export type ActiveDampersResponse = z.infer<typeof ActiveDampersResponseSchema>;

/** Result of clearing one or all dampers. New contract: { cleared } (no success wrapper). */
export const ClearDampersResponseSchema = z
    .object({
        cleared: z.number().int().describe('How many dampers were removed'),
    })
    .meta({ id: 'ClearDampersResponse', description: 'Show-less-like-this clear result' });

export type ClearDampersResponse = z.infer<typeof ClearDampersResponseSchema>;

// ============================================================================
// For-You write acknowledgements + request bodies
//
// Lifted from the colocated endpoint defs (defs/for-you/*) so the def's mount()
// validation and the OpenAPI `_openapi.ts` share a single source of truth.
// ============================================================================

/**
 * Generic fire-and-forget write acknowledgement — `{ ok: true }`.
 * Used by the for-you dismiss and section-feedback beacons.
 */
export const OkAckResponseSchema = z
    .object({
        ok: z.literal(true),
    })
    .meta({ id: 'OkAckResponse', description: 'Generic write acknowledgement' });

export type OkAckResponse = z.infer<typeof OkAckResponseSchema>;

/**
 * Body for POST /api/v1/for-you/dismiss (DELETE takes the same fields as query
 * parameters) — set/clear a for-you dismissal flag on a media item. `flagType` is limited to the for-you flags (the
 * Continue-Watching `dismissed_cw` flag is handled by a separate endpoint).
 */
export const ForYouDismissFlagTypeSchema = z.enum([
    'request_dismissed',
    'new_episode_alert_dismissed',
]);
export type ForYouDismissFlagType = z.infer<typeof ForYouDismissFlagTypeSchema>;

export const ForYouDismissBodySchema = z
    .object({
        targetId: z.string().guid().describe('Internal media_items UUID to dismiss / un-dismiss'),
        targetType: DismissalTargetTypeSchema,
        flagType: ForYouDismissFlagTypeSchema,
    })
    .meta({ id: 'ForYouDismissBody', description: 'Set / clear a for-you dismissal flag' });

export type ForYouDismissBody = z.infer<typeof ForYouDismissBodySchema>;

/**
 * Body for POST /api/v1/for-you/feedback — section-level interaction beacon
 * feeding the page-level section ranker.
 */
export const ForYouFeedbackEventSchema = z.enum(['impression', 'play', 'abandon', 'dismiss']);
export type ForYouFeedbackEvent = z.infer<typeof ForYouFeedbackEventSchema>;

export const ForYouFeedbackBodySchema = z
    .object({
        sectionType: z.enum([...FEED_SECTION_KINDS, 'next-up'] as [string, ...string[]]),
        event: ForYouFeedbackEventSchema,
    })
    .meta({ id: 'ForYouFeedbackBody', description: 'For-You section interaction beacon' });

export type ForYouFeedbackBody = z.infer<typeof ForYouFeedbackBodySchema>;

/**
 * Response for GET /api/v1/for-you/section-order — the current per-user
 * ranked render order for the long-tail For-You carousel sections (see
 * `FORYOU_LONG_TAIL_ORDER` in `feed-section-kinds.ts` and
 * `computeSectionOrder()` in `section-ranker.ts`). Returns the unchanged
 * canonical order when `FEATURE_FORYOU_SECTION_RANKER` is off.
 */
export const SectionOrderResponseSchema = z
    .object({
        order: z.array(z.enum([...FEED_SECTION_KINDS] as [string, ...string[]])),
    })
    .meta({ id: 'SectionOrderResponse', description: 'Ranked long-tail For-You section order' });

export type SectionOrderResponse = z.infer<typeof SectionOrderResponseSchema>;

/**
 * Body for POST /api/v1/for-you/less-like-this — record a soft taste damper.
 * `mediaType` accepts the canonical `series` plus the legacy `tv` alias.
 */
export const LessLikeThisRequestSchema = z
    .object({
        externalIds: ExternalIdsResponseSchema,
        mediaType: z.enum(['movie', 'series', 'tv']),
        title: z.string().optional(),
    })
    .meta({ id: 'LessLikeThisRequest', description: 'Record a show-less-like-this damper' });

export type LessLikeThisRequest = z.infer<typeof LessLikeThisRequestSchema>;
