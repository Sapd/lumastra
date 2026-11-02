// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * API Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for all API response types.
 * These schemas define the contract between server and client.
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

import { ImageSetSchema } from './api-image-descriptor.js';
import { z } from 'zod';
import { coerceLegacyTvToSeries } from './common';

// ============================================================================
// External IDs
// ============================================================================

/**
 * External IDs from various providers (TMDB, IMDB, TVDB, etc.)
 * Used to identify media across different services.
 *
 * Uses .catchall(z.string().optional()) to allow custom provider IDs from plugins
 * while maintaining type compatibility with ExternalIds interface.
 */
export const ExternalIdsResponseSchema = z
    .object({
        /** Internal UUID from media_items.id - preferred for URLs */
        internal: z.string().optional().describe('Internal UUID'),
        /** TMDB ID (The Movie Database) */
        tmdb: z.string().optional().describe('TMDB ID'),
        /** IMDB ID (tt prefix, e.g., tt0137523) */
        imdb: z.string().optional().describe('IMDB ID'),
        /** TVDB ID (TheTVDB) */
        tvdb: z.string().optional().describe('TVDB ID'),
        /** Trakt ID */
        trakt: z.string().optional().describe('Trakt ID'),
        /** MyAnimeList ID */
        mal: z.string().optional().describe('MyAnimeList ID'),
        /** AniList ID */
        anilist: z.string().optional().describe('AniList ID'),
        /**
         * AudiobookShelf `libraryItemId`.
         *
         * Books are first-class `media_items` rows identified by
         * `(provider='audiobookshelf', media_type='audiobook')`, so this is the
         * real slot for their upstream id.
         */
        audiobookshelf: z.string().optional().describe('AudiobookShelf library item ID'),
        /** Kavita series id (search rows for books/manga/comics served from Kavita). */
        kavita: z.string().optional().describe('Kavita series ID'),
    })
    .meta({
        id: 'ExternalIds',
        description: 'External IDs from various metadata providers',
    });

export type ExternalIdsResponse = z.infer<typeof ExternalIdsResponseSchema>;

// ============================================================================
// Badge
// ============================================================================

/**
 * Color variants for badges (matches Skeleton UI variants)
 */
export const BadgeColorSchema = z
    .enum(['primary', 'secondary', 'success', 'warning', 'error', 'surface', 'tertiary'])
    .describe('Badge color variant')
    .meta({ id: 'BadgeColor' });

export type BadgeColor = z.infer<typeof BadgeColorSchema>;

/**
 * UI badge for displaying status/metadata on cards
 */
export const BadgeSchema = z
    .object({
        /** Display text for the badge */
        text: z.string().describe('Badge text'),
        /** Color variant matching Skeleton UI badge variants */
        color: BadgeColorSchema,
        /** Optional icon name (maps to svelte-hero-icons via icon-map) */
        icon: z.string().optional().describe('Icon name'),
        /** Optional tooltip text */
        title: z.string().optional().describe('Tooltip text'),
    })
    .meta({ id: 'Badge', description: 'UI badge for cards and lists' });

export type Badge = z.infer<typeof BadgeSchema>;

// ============================================================================
// Title Parts (for structured titles)
// ============================================================================

/**
 * Semantic colors for highlighted title segments
 */
export const TitleHighlightColorSchema = z
    .enum(['cyan', 'primary', 'accent', 'success', 'warning', 'purple', 'orange'])
    .describe('Title highlight color')
    .meta({ id: 'TitleHighlightColor' });

export type TitleHighlightColor = z.infer<typeof TitleHighlightColorSchema>;

/**
 * Structured title segment for non-HTML clients (tvOS, etc.)
 * Allows native styling instead of parsing HTML spans.
 */
export const TitlePartSchema = z
    .object({
        /** Text content of this segment */
        text: z.string().describe('Text content'),
        /** Whether this segment should be highlighted/emphasized */
        highlight: z.boolean().optional().describe('Highlight this segment'),
        /** Semantic color for highlighted segments */
        color: TitleHighlightColorSchema.optional().describe('Highlight color'),
    })
    .meta({
        id: 'TitlePart',
        description: 'Structured title segment for native styling',
    });

export type TitlePart = z.infer<typeof TitlePartSchema>;

// ============================================================================
// Universal Media Item
// ============================================================================

/**
 * Media type discriminator
 *
 * `'series'` is the canonical value for TV series; the stored `'tv'` token is
 * never emitted. `universalTypeOf()` in `$lib/shared/media-type-domain` maps
 * `tv → 'series'`, so nothing in this codebase produces `'tv'` here.
 *
 * Legacy `'tv'` / `'show'` is still *accepted* on input — same
 * {@link coerceLegacyTvToSeries} preprocessor as `publicMediaTypeSchema` — so a
 * cached payload or an older client written against the pre-`series` contract
 * still validates, normalized to `'series'`. It is deliberately absent from the
 * enum (and therefore from `UniversalMediaType` and the OpenAPI contract): the
 * schema states the contract instead of hedging it.
 */
export const UniversalMediaTypeSchema = z
    .preprocess(
        coerceLegacyTvToSeries,
        z.enum([
            'movie',
            'series',
            'episode',
            'audiobook',
            'artist',
            'album',
            'track',
            'playlist',
            'music',
            'tvchannel',
        ]),
    )
    .describe('Media type')
    .meta({ id: 'UniversalMediaType' });

export type UniversalMediaType = z.infer<typeof UniversalMediaTypeSchema>;

/**
 * Aspect ratio hint for cards
 */
export const AspectRatioSchema = z
    .enum(['poster', 'video', 'square'])
    .describe('Aspect ratio')
    .meta({ id: 'AspectRatio' });

export type AspectRatio = z.infer<typeof AspectRatioSchema>;

/**
 * Search match source (fulltext search)
 */
export const MatchSourceSchema = z
    .enum([
        'title',
        'original_title',
        'overview',
        'actor',
        'director',
        'keyword',
        // Episode-specific match sources (ref: DL-001).
        // The server returns these values for episode matches. Without them in the enum,
        // Zod silently drops the matchSource field and the UI cannot render episode match context.
        'episode_pattern',
        'episode_fulltext',
        'episode_title',
    ])
    .describe('Where the search matched')
    .meta({ id: 'MatchSource' });

export type MatchSource = z.infer<typeof MatchSourceSchema>;

/**
 * Featured pick criteria (rotates daily)
 */
export const FeaturedPickCriteriaSchema = z
    .enum(['hidden-gem', 'fresh-for-you', 'perfect-match', 'overlooked-classic', 'buzzing-now'])
    .describe('Featured pick criteria')
    .meta({ id: 'FeaturedPickCriteria' });

export type FeaturedPickCriteria = z.infer<typeof FeaturedPickCriteriaSchema>;

/**
 * Universal Media Item - unified structure for all media content
 * Used across browse, recommendations, search, playlists, etc.
 *
 * Fields are grouped logically:
 * - Identity: id, externalIds, mediaType, seriesId
 * - Display: title, subtitle, image, backdrop, logo, overview
 * - Status: progress, isAvailable, canRequest, isPlayed, isNew
 * - Episode: seasonNumber, episodeNumber, seriesName
 * - Ratings: rating, criticRating, audienceRating, etc.
 * - Metadata: rank, trailerUrl, badges, clickData, etc.
 */
export const UniversalMediaItemSchema = z
    .object({
        // === Identity ===
        /** Unique identifier (UUID preferred, or composite like "tmdb:12345:movie") */
        itemKey: z.string().optional(),
        id: z.string().describe('Unique identifier'),
        /** External IDs from various providers */
        externalIds: ExternalIdsResponseSchema.describe('External provider IDs'),
        /** Media type discriminator */
        mediaType: UniversalMediaTypeSchema,
        /**
         * Internal series UUID (grandparent of an episode) — exposed so
         * client-side actions like "Hide from Continue Watching" can
         * target the series rather than the episode. Optional, populated
         * only on episode-context rows (CW, Next Up, etc.).
         */
        seriesId: z.string().optional().describe('Internal series UUID for episode-context rows'),

        // === Display ===
        /** Primary display title */
        title: z.string().describe('Primary title'),
        /** Secondary text (year, "S1:E4", genre, etc.) */
        subtitle: z.string().optional().describe('Secondary text'),
        /** Poster/thumbnail image URL */
        image: z.string().optional().describe('Poster/thumbnail URL for non-audiobook cards'),
        /** Multiple image URLs for mosaic/collage display (e.g. playlist covers) */
        images: z
            .union([ImageSetSchema, z.array(z.string())])
            .optional()
            .describe('Artwork descriptors; legacy mosaics remain for non-audiobook cards'),
        /** Backdrop/banner image URL (16:9, for hero/next-up) */
        backdrop: z.string().optional().describe('Backdrop URL'),
        /** Logo image URL (for hero sections) */
        logo: z.string().optional().describe('Logo URL'),
        /** Overview/description text */
        overview: z.string().optional().describe('Overview/description'),

        // === Visual Configuration ===
        /** Aspect ratio hint for the card */
        aspectRatio: AspectRatioSchema.optional().describe('Card aspect ratio'),

        // === Status ===
        /** Watch progress percentage (0-100) */
        progress: z.number().min(0).max(100).optional().describe('Watch progress (0-100)'),
        /** Whether the item is available on the local server */
        isAvailable: z.boolean().describe('Available in library'),
        /**
         * Whether the underlying media_items row has a local playable file
         * (media_items.has_files). Discovery-only items (TMDB/MDBList with no
         * local file) are `false` and must not show a Play affordance.
         * Optional for backward compatibility — items that omit it fall back
         * to existing behavior.
         */
        hasFiles: z.boolean().optional().describe('Has a local playable file'),
        /** Whether the item can be requested via Jellyseerr */
        canRequest: z.boolean().describe('Can be requested'),
        /** Whether the item has been fully watched */
        isPlayed: z.boolean().optional().describe('Fully watched'),
        /** Whether this is a new/unwatched item in a series */
        isNew: z.boolean().optional().describe('New/unwatched episode'),
        /** Short contextual label for CW/NU cards ("Paused 3 days ago", "Next episode", "S2:E04") */
        contextLabel: z.string().optional().describe('Contextual label for CW/NU cards'),
        /** True for "next up / next episode" cards — set structurally in transformNextUp.
         * Use this instead of string-matching contextLabel (which is locale-dependent). */
        isNextUp: z.boolean().optional().describe('Card is a "next up" episode'),
        /** True when there is a fresh, actively-playing live session for this item
         * (derived server-side from the live-watching overlay's livePlaybackState).
         * Drives the hero's "Playing now" treatment. Locale-independent — do NOT
         * string-match contextLabel for this. Snapshot at build time. */
        isPlaying: z.boolean().optional().describe('A live session is actively playing this item'),
        /**
         * Whether the underlying watch state came from a suspicious bulk-mark
         * sync event (e.g. a Jellyfin "mark series played" cascade). CW/NU
         * cards render a warning indicator the user can click to confirm or
         * hide — letting them repair noisy sync data without an admin tool.
         */
        isSuspicious: z
            .boolean()
            .optional()
            .describe('Watch state traces to a suspicious bulk-mark window'),

        // === Episode-specific ===
        /** Season number for episodes */
        seasonNumber: z.number().int().optional().describe('Season number'),
        /** Episode number for episodes */
        episodeNumber: z.number().int().optional().describe('Episode number'),
        /** Series name for episodes */
        seriesName: z.string().optional().describe('Series name'),

        // === Ratings ===
        /** Primary rating value (TMDB/IMDB score) */
        rating: z.union([z.number(), z.string()]).optional().describe('Primary rating'),
        /** Critic rating (Rotten Tomatoes) */
        criticRating: z.number().optional().describe('Critic rating'),
        /** Audience rating (RT Audience) */
        audienceRating: z.number().optional().describe('Audience rating'),
        /** Letterboxd rating */
        letterboxdRating: z.number().optional().describe('Letterboxd rating'),
        /** Letterboxd vote count */
        letterboxdVotes: z.number().optional().describe('Letterboxd votes'),
        /** MyAnimeList score */
        malScore: z.number().optional().describe('MyAnimeList score'),
        /** MDBList score */
        mdblistScore: z.number().optional().describe('MDBList score'),
        /** Metacritic score */
        metacriticScore: z.number().optional().describe('Metacritic score'),
        /** Trakt score */
        traktScore: z.number().optional().describe('Trakt score'),
        /** IMDB rating */
        imdbRating: z.number().optional().describe('IMDB rating'),
        /** TMDB vote count; gates whether a vote_average-derived rating is shown */
        voteCount: z
            .number()
            .int()
            .optional()
            .describe('TMDB vote count; gates whether a vote_average-derived rating is shown'),
        /** TMDB ID (for legacy compatibility) */
        /** Year of release */
        year: z.union([z.number(), z.string()]).optional().describe('Release year'),

        // === Metadata ===
        /** Duration in milliseconds */
        durationMs: z.number().int().optional().describe('Duration in milliseconds'),
        /** Release/air date */
        releaseDate: z.string().optional().describe('Release/air date'),
        /** Genre list */
        genres: z.array(z.string()).optional().describe('Genres'),
        /** Age/content rating, e.g. "PG-13", "FSK 16". */
        certification: z.string().optional().describe('Age/content rating (e.g. PG-13)'),
        /**
         * Best-available quality tiers, sourced from the `media_item_quality`
         * projection (NOT computed per request — see media-rail-metadata.queries).
         * Drive the hero's 4K / Dolby Vision badges.
         */
        resolutionTier: z
            .string()
            .optional()
            .describe("Best-available resolution tier: '4K' | '1080p' | '720p' | 'SD'"),
        hdrTier: z
            .string()
            .optional()
            .describe("Best-available HDR tier: 'dolby_vision' | 'hdr' | 'sdr'"),
        /**
         * Accessibility/audio badges, also from the `media_item_quality`
         * projection. For series these are a STRICT MAJORITY across episodes
         * (matching the detail page), except `hasAtmos`, which is
         * best-available like the resolution/HDR tiers.
         */
        hasAtmos: z.boolean().optional().describe('Dolby Atmos audio available'),
        hasCc: z.boolean().optional().describe('Closed captions available'),
        hasSdh: z.boolean().optional().describe('SDH subtitles available'),
        hasAd: z.boolean().optional().describe('Audio description track available'),
        /** Music tracks: structured track artists (tag order), for title/credit linkification */
        artists: z
            .array(
                z.object({
                    id: z.string().optional(),
                    title: z.string(),
                }),
            )
            .optional()
            .describe('Structured track artists (tag order) for title/credit linkification'),
        remixerArtists: z
            .array(z.object({ id: z.string().optional(), title: z.string() }))
            .optional()
            .describe('Resolved remix/version credits, separate from performing artists.'),
        /** Custom metadata for non-entertainment media types (home_video, training, etc.) */
        customMetadata: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('Custom metadata for non-entertainment types'),
        /** Rank position in a list */
        rank: z.number().optional().describe('Rank position'),
        /** Popularity score */
        popularity: z.number().optional().describe('Popularity score'),
        /** Trending source identifier */
        trendingSource: z.string().optional().describe('Trending source'),
        /** YouTube trailer URL */
        trailerUrl: z.string().optional().describe('Trailer URL'),
        /** Direct HLS stream info URL for native streaming (bypasses Jellyfin; used by standalone live TV channels) */
        nativeStreamUrl: z
            .string()
            .optional()
            .describe('Native stream info endpoint URL (for standalone live TV)'),
        /** Number of seasons (for series) */
        seasonCount: z.number().int().optional().describe('Number of seasons'),
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

        // === Badges ===
        /** Array of badges to display on the card */
        badges: z.array(BadgeSchema).optional().describe('UI badges'),

        // === Interactivity ===
        /** Arbitrary data to pass to modals/handlers on click */
        clickData: z.record(z.string(), z.unknown()).optional().describe('Click handler data'),

        // === AI/Recommendation specific ===
        /** AI similarity/match score (0-1) */
        similarityScore: z.number().min(0).max(1).optional().describe('Similarity score (0-1)'),
        /** AI-generated reason for recommendation */
        reason: z.string().optional().describe('Recommendation reason'),
        /** Whether this is an AI suggestion */
        isAISuggestion: z.boolean().optional().describe('AI-generated suggestion'),

        // === Fulltext Search specific ===
        /** Where the search matched */
        matchSource: MatchSourceSchema.optional().describe('Search match location'),
        /** Snippet of text showing the match context */
        matchSnippet: z.string().optional().describe('Match context snippet'),
        /** HTML-formatted snippet with search terms highlighted */
        highlightedMatchSnippet: z.string().optional().describe('Highlighted match snippet'),

        // === BlurHash Placeholders ===
        /** BlurHash string for poster image placeholder */
        posterBlurHash: z.string().optional().describe('Poster image blurhash'),
        /** BlurHash string for backdrop image placeholder */
        backdropBlurHash: z.string().optional().describe('Backdrop image blurhash'),
    })
    .meta({
        id: 'UniversalMediaItem',
        description: 'Universal media item structure for all content types',
    });

export type UniversalMediaItem = z.infer<typeof UniversalMediaItemSchema>;

// ============================================================================
// Section Metadata
// ============================================================================

/**
 * Section filter option
 */
export const SectionFilterSchema = z
    .object({
        /** Filter value */
        value: z.string().describe('Filter value'),
        /** Display label */
        label: z.string().describe('Display label'),
        /** Optional icon name */
        icon: z.string().optional().describe('Icon name'),
        /** Group for grouped dropdowns */
        group: z.string().optional().describe('Group name'),
    })
    .meta({ id: 'SectionFilter', description: 'Section filter option' });

export type SectionFilter = z.infer<typeof SectionFilterSchema>;

/**
 * Section filter group
 */
export const SectionFilterGroupSchema = z
    .object({
        /** Group label */
        label: z.string().describe('Group label'),
        /** Options in this group */
        options: z.array(SectionFilterSchema).describe('Group options'),
    })
    .meta({ id: 'SectionFilterGroup', description: 'Section filter group' });

export type SectionFilterGroup = z.infer<typeof SectionFilterGroupSchema>;

/**
 * Section metadata - configuration for section headers and behavior
 *
 * Fields are grouped logically:
 * - Display: icon, iconColor, subtitle, accentColor, sourceImage, etc.
 * - Behavior: collapsible, defaultCollapsed, collapseKey, showRefresh, etc.
 * - State: loading, loadingFilters, syncing, error, count
 * - Filters: filters, filterGroups, filterPlaceholder, activeFilter, etc.
 * - Featured: featuredCriteria, featuredReason
 * - Other: cardVariant, data, keywords, streamingIcon, etc.
 */
export const SectionMetaSchema = z
    .object({
        // === Display ===
        /** Icon name for the section header */
        icon: z.string().optional().describe('Section header icon'),
        /** Icon color class (Tailwind) */
        iconColor: z.string().optional().describe('Icon color class'),
        /** Subtitle/description text */
        subtitle: z.string().optional().describe('Section subtitle'),
        /** Custom accent color for hover effects */
        accentColor: z.string().optional().describe('Accent color'),
        /** Source image URL for "Because you watched" sections */
        sourceImage: z.string().optional().describe('Source image URL'),
        /** Source title for "Because you watched" sections */
        sourceTitle: z.string().optional().describe('Source title'),
        /** Source external IDs (for modal) */
        sourceExternalIds: ExternalIdsResponseSchema.optional().describe('Source external IDs'),
        /** Source media type (for modal) */
        sourceMediaType: z.string().optional().describe('Source media type'),
        /** Whether to show "Inspired by [source]" label below header */
        showSourceLabel: z.boolean().optional().describe('Show source label'),
        /** Backdrop image URL with blur/gradient overlay */
        backdropUrl: z.string().optional().describe('Backdrop URL'),
        /** Square cover for the whole section (e.g. a smart mix's collage) */
        coverImage: z
            .string()
            .optional()
            .describe(
                'Square cover image for the section as a whole (e.g. a smart mix rendered as one playable tile). A cover collage URL at `size=card`; swap the `size` query value (thumb | card | full) for other sizes.',
            ),
        /** Structured title parts for non-HTML clients (tvOS, etc.) */
        titleParts: z.array(TitlePartSchema).optional().describe('Structured title parts'),

        // === Behavior ===
        /** Whether the section is collapsible */
        collapsible: z.boolean().optional().describe('Section is collapsible'),
        /** Default collapsed state */
        defaultCollapsed: z.boolean().optional().describe('Default collapsed state'),
        /** LocalStorage key for collapse state persistence */
        collapseKey: z.string().optional().describe('Collapse state storage key'),
        /** Whether to show a refresh button */
        showRefresh: z.boolean().optional().describe('Show refresh button'),
        /** Whether to show remove button on list items */
        showRemoveButton: z.boolean().optional().describe('Show remove button'),
        /** Whether to show more/similar button on list items */
        showMoreButton: z.boolean().optional().describe('Show more button'),

        // === State ===
        /** Whether section is loading */
        loading: z.boolean().optional().describe('Section is loading'),
        /** Whether filters are still loading */
        loadingFilters: z.boolean().optional().describe('Filters are loading'),
        /** Whether data is syncing in background */
        syncing: z.boolean().optional().describe('Background sync in progress'),
        /** Error message if any */
        error: z.string().optional().describe('Error message'),
        /** Count badge value */
        count: z.number().int().optional().describe('Count badge value'),

        // === Filters ===
        /** Filter options for simple dropdowns */
        filters: z.array(SectionFilterSchema).optional().describe('Filter options'),
        /** Grouped filter options for IconDropdown */
        filterGroups: z.array(SectionFilterGroupSchema).optional().describe('Grouped filters'),
        /** Placeholder text for filter dropdown */
        filterPlaceholder: z.string().optional().describe('Filter placeholder'),
        /** Currently selected filter value */
        activeFilter: z.string().optional().describe('Active filter value'),
        /** Whether hover popup is enabled for this section */
        hoverPopupEnabled: z.boolean().optional().describe('Hover popup enabled'),

        // === Featured ===
        /** Featured pick criteria (for featured-pick section type) */
        featuredCriteria: FeaturedPickCriteriaSchema.optional().describe('Featured pick criteria'),
        /** Human-readable reason for the featured pick */
        featuredReason: z.string().optional().describe('Featured pick reason'),

        // === Other ===
        /** Override card variant for carousel/grid sections */
        cardVariant: z.enum(['poster', 'backdrop']).optional().describe('Card variant override'),
        /** Arbitrary data to pass to section components */
        data: z.record(z.string(), z.unknown()).optional().describe('Custom section data'),
        /** Keywords for keyword-chips section type */
        keywords: z
            .array(
                z.object({
                    keyword: z.string(),
                    displayName: z.string(),
                    count: z.number().int(),
                }),
            )
            .optional()
            .describe('Keywords for keyword-chips section'),
        /** Custom streaming icon key (netflix, disney, etc.) */
        streamingIcon: z.string().optional().describe('Streaming service icon'),
        /** Number of rows for multi-row carousel layout (default: 1) */
        rows: z
            .number()
            .int()
            .min(1)
            .max(4)
            .optional()
            .describe('Number of carousel rows for multi-row layout'),
        /** Override card width class for this section */
        cardWidthOverride: z
            .string()
            .optional()
            .describe('Tailwind width class override (e.g. w-28)'),
        /** Empty state config shown when items.length === 0 (instead of hiding the section) */
        emptyState: z
            .object({
                message: z.string().describe('Empty state message'),
                linkHref: z.string().optional().describe('Optional CTA link URL'),
                linkLabel: z.string().optional().describe('Optional CTA link label'),
            })
            .optional()
            .describe('Empty state configuration'),
    })
    .meta({
        id: 'SectionMeta',
        description: 'Section metadata and configuration',
    });

export type SectionMeta = z.infer<typeof SectionMetaSchema>;

// ============================================================================
// Page Section
// ============================================================================

/**
 * Section layout type
 */
export const SectionTypeSchema = z
    .enum([
        'carousel',
        'grid',
        'hero',
        'list',
        'watchlist',
        'ai-dashboard',
        'calendar',
        'continue-watching',
        'next-up',
        'live-sessions',
        'keyword-chips',
        'featured-pick',
    ])
    .describe('Section layout type')
    .meta({ id: 'SectionType' });

export type SectionType = z.infer<typeof SectionTypeSchema>;

/**
 * Page section - container for a group of media items with layout configuration
 */
export const PageSectionSchema = z
    .object({
        /** Unique section identifier */
        id: z.string().describe('Unique section ID'),
        /** Section layout type */
        type: SectionTypeSchema,
        /** Section header title */
        title: z.string().optional().describe('Section title'),
        /** Secondary text (subtitle) */
        subtitle: z.string().optional().describe('Section subtitle'),
        /** Media items in this section */
        items: z.array(UniversalMediaItemSchema).describe('Media items'),
        /** Card variant override */
        cardVariant: z.enum(['poster', 'backdrop', 'list']).optional().describe('Card variant'),
        /** Whether section is loading */
        loading: z.boolean().optional().describe('Section is loading'),
        /** Error message if any */
        error: z.string().optional().describe('Error message'),
        /** Section-specific configuration */
        meta: SectionMetaSchema.optional().describe('Section metadata'),
    })
    .meta({
        id: 'PageSection',
        description: 'Page section with media items and configuration',
    });

export type PageSection = z.infer<typeof PageSectionSchema>;

// ============================================================================
// Card Variant
// ============================================================================

/**
 * Card display variant
 */
export const CardVariantSchema = z
    .enum(['poster', 'backdrop', 'list'])
    .describe('Card display variant')
    .meta({ id: 'CardVariant' });

export type CardVariant = z.infer<typeof CardVariantSchema>;
